import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { ControlPlaneService, SyncService, syncV1 } from '@gremuchaya/protocol';

import type {
  AuthorityMode,
  ConnectionSession,
  ControlPlaneCapabilities,
  DeviceRole,
  GroupDevice,
  PresenceEntry,
  PresenceStatus,
} from '@/application/sync/connection';
import {
  ControlPlaneError,
  type ClockSample,
  type ControlPlaneErrorKind,
  type ControlPlanePort,
  type GroupSummary,
  type PairingResult,
} from '@/application/sync/controlPlanePort';

import { createBearerInterceptor } from './authInterceptor';
import { DeviceSessionStore, type StoredDeviceSession } from './DeviceSessionStore';
import { createControlPlaneTransport } from './transport';

/*
 * Wire shapes, declared structurally rather than imported from the generated
 * bindings, in the idiom `BridgeMaterialClient` set: the generated client is
 * assignable to these, and so is a hand-written fake in a test. Only the
 * fields this facade reads are named. `Timestamp` is spelled out because
 * `@bufbuild/protobuf` is a dependency of `@gremuchaya/protocol`, not of this
 * application, and the two fields are all a conversion needs.
 */
interface WireTimestamp {
  readonly seconds: bigint;
  readonly nanos: number;
}

interface WireResourceId {
  readonly value: string;
}

interface WireGroup {
  readonly id?: WireResourceId | undefined;
  readonly name: string;
  readonly authorityMode: number;
  readonly leaderDeviceId?: WireResourceId | undefined;
}

interface WireDevice {
  readonly id?: WireResourceId | undefined;
  readonly name: string;
  readonly role: number;
  readonly status: number;
}

interface WireSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt?: WireTimestamp | undefined;
  readonly refreshTokenExpiresAt?: WireTimestamp | undefined;
  readonly deviceId?: WireResourceId | undefined;
  readonly groupId?: WireResourceId | undefined;
  readonly role: number;
}

interface WirePresence {
  readonly deviceId?: WireResourceId | undefined;
  readonly status: number;
  readonly activeScreen: string;
  readonly clockOffsetMs: bigint;
  readonly latencyMs: number;
  readonly observedAt?: WireTimestamp | undefined;
}

interface WireMutationContext {
  readonly requestId: string;
  readonly actorDeviceId?: WireResourceId;
}

interface CallOptions {
  readonly signal?: AbortSignal;
}

export interface ControlRpcClient {
  getCapabilities(
    request: Record<string, never>,
    options?: CallOptions,
  ): Promise<{
    readonly capabilities: readonly { readonly name: string; readonly enabled: boolean }[];
  }>;
}

export interface SyncRpcClient {
  pairDevice(
    request: {
      readonly pairingCode: string;
      readonly deviceName: string;
      readonly publicKey: string;
      readonly platform: string;
      readonly applicationVersion: string;
      readonly context: WireMutationContext;
    },
    options?: CallOptions,
  ): Promise<{
    readonly group?: WireGroup | undefined;
    readonly device?: WireDevice | undefined;
    readonly session?: WireSession | undefined;
  }>;
  refreshDeviceSession(
    request: { readonly refreshToken: string; readonly context: WireMutationContext },
    options?: CallOptions,
  ): Promise<{ readonly session?: WireSession | undefined }>;
  listDevices(
    request: {
      readonly groupId: WireResourceId;
      readonly page: { readonly pageSize: number; readonly cursor: string };
    },
    options?: CallOptions,
  ): Promise<{
    readonly devices: readonly WireDevice[];
    readonly page?: { readonly nextCursor: string; readonly hasMore: boolean } | undefined;
  }>;
  revokeDevice(
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly deviceId: WireResourceId;
    },
    options?: CallOptions,
  ): Promise<unknown>;
  joinGroup(
    request: { readonly context: WireMutationContext; readonly groupId: WireResourceId },
    options?: CallOptions,
  ): Promise<{ readonly group?: WireGroup | undefined }>;
  leaveGroup(
    request: { readonly context: WireMutationContext; readonly groupId: WireResourceId },
    options?: CallOptions,
  ): Promise<unknown>;
  setAuthorityMode(
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly mode: syncV1.AuthorityMode;
    },
    options?: CallOptions,
  ): Promise<{ readonly group?: WireGroup | undefined }>;
  setLeader(
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly deviceId: WireResourceId;
    },
    options?: CallOptions,
  ): Promise<{ readonly group?: WireGroup | undefined }>;
  timeSync(
    request: {
      readonly groupId: WireResourceId;
      readonly clientSendMonotonicMs: bigint;
      readonly clientWallTime: WireTimestamp;
    },
    options?: CallOptions,
  ): Promise<{
    readonly serverReceiveTime?: WireTimestamp | undefined;
    readonly serverSendTime?: WireTimestamp | undefined;
  }>;
  getPresence(
    request: { readonly groupId: WireResourceId },
    options?: CallOptions,
  ): Promise<{ readonly devices: readonly WirePresence[] }>;
}

export interface ControlPlaneClientOptions {
  readonly baseUrl: string;
  readonly sessionStore?: DeviceSessionStore;
  /** Injected by tests; built from the transport when absent. */
  readonly clients?: {
    readonly control: ControlRpcClient;
    readonly sync: SyncRpcClient;
  };
  readonly device?: { readonly platform: string; readonly applicationVersion: string };
  readonly mintRequestId?: () => string;
  /** Wall clock, epoch milliseconds. */
  readonly now?: () => number;
}

/**
 * Browser-facing adapter for the control plane's `ControlPlaneService` and
 * `SyncService` (R27).
 *
 * It owns the credentials' movement and nothing else: pairing and refresh
 * write the session store, every other call reads it through the bearer
 * interceptor, and the idempotency rule of refresh -- the same `request_id`
 * on a retry, a fresh one after success -- is kept here where the token is.
 * Which call to make when, and what the store shows meanwhile, belongs to
 * `ControlPlaneSession` in the application layer.
 */
export class ControlPlaneClient implements ControlPlanePort {
  readonly baseUrl: string;
  readonly #store: DeviceSessionStore;
  readonly #control: ControlRpcClient;
  readonly #sync: SyncRpcClient;
  readonly #device: { readonly platform: string; readonly applicationVersion: string };
  readonly #mintRequestId: () => string;
  readonly #now: () => number;

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = options.baseUrl;
    this.#store = options.sessionStore ?? new DeviceSessionStore();
    this.#device = options.device ?? { platform: 'web', applicationVersion: '' };
    this.#mintRequestId = options.mintRequestId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => Date.now());
    if (options.clients !== undefined) {
      this.#control = options.clients.control;
      this.#sync = options.clients.sync;
    } else {
      const transport = createControlPlaneTransport(options.baseUrl, [
        createBearerInterceptor(() => this.accessToken()),
      ]);
      this.#control = createClient(ControlPlaneService, transport);
      this.#sync = createClient(SyncService, transport);
    }
  }

  /** The stored identity, or `null` when this client has not been paired. */
  session(): ConnectionSession | null {
    const stored = this.#stored();
    return stored === null
      ? null
      : { deviceId: stored.deviceId, groupId: stored.groupId, role: stored.role };
  }

  /** Epoch milliseconds, or `null` without a session. */
  accessTokenExpiresAt(): number | null {
    return this.#stored()?.accessTokenExpiresAt ?? null;
  }

  /** Read at call time by the bearer interceptor; never handed to the store. */
  accessToken(): string | undefined {
    return this.#stored()?.accessToken;
  }

  /** Drops the session for good. The next connection needs a pairing code. */
  forgetSession(): void {
    this.#store.clear();
  }

  async probeCapabilities(signal?: AbortSignal): Promise<ControlPlaneCapabilities> {
    const response = await call(() => this.#control.getCapabilities({}, options(signal)));
    const enabled = (name: string) =>
      response.capabilities.some((capability) => capability.name === name && capability.enabled);
    return {
      sync: enabled('sync'),
      deviceLifecycle: enabled('sync.device-lifecycle'),
      realtimeAdmission: enabled('sync.realtime-admission'),
      settings: enabled('settings'),
      materials: enabled('materials'),
    };
  }

  /**
   * Pairs this device into a group with a code an administrator issued.
   *
   * The code is the credential, so the call carries no bearer token; what it
   * earns is written to the store before the result is returned, and the
   * deprecated scalar token fields of the response are never read.
   */
  async pair(
    pairingCode: string,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<PairingResult> {
    const response = await call(() =>
      this.#sync.pairDevice(
        {
          pairingCode: pairingCode.trim(),
          deviceName: deviceName.trim(),
          publicKey: '',
          platform: this.#device.platform,
          applicationVersion: this.#device.applicationVersion,
          context: { requestId: this.#mintRequestId() },
        },
        options(signal),
      ),
    );
    const session = required(response.session, 'Control plane returned no session.');
    const group = required(response.group, 'Control plane returned no group.');
    const device = required(response.device, 'Control plane returned no device.');
    const stored: StoredDeviceSession = {
      version: 1,
      controlPlaneUrl: this.baseUrl,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessTokenExpiresAt: toEpochMs(session.accessTokenExpiresAt),
      refreshTokenExpiresAt: toEpochMs(session.refreshTokenExpiresAt),
      deviceId: session.deviceId?.value ?? '',
      groupId: session.groupId?.value ?? '',
      role: toRole(session.role),
    };
    this.#store.write(stored);
    return {
      session: { deviceId: stored.deviceId, groupId: stored.groupId, role: stored.role },
      group: toGroup(group),
      device: toDevice(device),
    };
  }

  /**
   * Rotates both tokens.
   *
   * The request id is taken from the store, which either still holds the id
   * of an unanswered attempt or mints one and persists it first. A retry
   * therefore replays the same id and is answered by the receipt; a *new* id
   * against the same refresh token would be read as a replay attack and end
   * the session family (`service.ts`, `refreshDeviceSession`). Only a success
   * clears the id: a network failure keeps it for the next attempt, and a
   * refusal clears the whole session because nothing in it is usable any more.
   */
  async refresh(signal?: AbortSignal): Promise<ConnectionSession> {
    const stored = this.#stored();
    if (stored === null) throw new ControlPlaneError('unauthenticated', 'No paired session.');
    const requestId = this.#store.beginRefresh(this.#mintRequestId);
    let response: Awaited<ReturnType<SyncRpcClient['refreshDeviceSession']>>;
    try {
      response = await call(() =>
        this.#sync.refreshDeviceSession(
          { refreshToken: stored.refreshToken, context: { requestId } },
          options(signal),
        ),
      );
    } catch (error: unknown) {
      if (error instanceof ControlPlaneError && error.kind === 'unauthenticated') {
        this.#store.clear();
      }
      throw error;
    }
    const session = required(response.session, 'Control plane returned no refreshed session.');
    const next = this.#store.completeRefresh({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessTokenExpiresAt: toEpochMs(session.accessTokenExpiresAt),
      refreshTokenExpiresAt: toEpochMs(session.refreshTokenExpiresAt),
      role: toRole(session.role),
    });
    return { deviceId: next.deviceId, groupId: next.groupId, role: next.role };
  }

  /** Enters the group's session: participation, not membership. */
  async join(signal?: AbortSignal): Promise<GroupSummary> {
    const stored = this.#requireSession();
    const response = await call(() =>
      this.#sync.joinGroup(
        { context: this.#mutation(stored), groupId: { value: stored.groupId } },
        options(signal),
      ),
    );
    return toGroup(required(response.group, 'Control plane returned no group on join.'));
  }

  async leave(signal?: AbortSignal): Promise<void> {
    const stored = this.#requireSession();
    await call(() =>
      this.#sync.leaveGroup(
        { context: this.#mutation(stored), groupId: { value: stored.groupId } },
        options(signal),
      ),
    );
  }

  async listDevices(signal?: AbortSignal): Promise<readonly GroupDevice[]> {
    const stored = this.#requireSession();
    const devices: GroupDevice[] = [];
    let cursor = '';
    // Bounded: a group has nine screens, not nine thousand, and a page loop
    // that never ended would be a way for a wrong cursor to hang the runtime.
    for (let page = 0; page < 10; page += 1) {
      const response = await call(() =>
        this.#sync.listDevices(
          { groupId: { value: stored.groupId }, page: { pageSize: 50, cursor } },
          options(signal),
        ),
      );
      devices.push(...response.devices.map(toDevice));
      if (response.page === undefined || !response.page.hasMore) break;
      cursor = response.page.nextCursor;
    }
    return devices;
  }

  async revoke(deviceId: string, signal?: AbortSignal): Promise<void> {
    const stored = this.#requireSession();
    await call(() =>
      this.#sync.revokeDevice(
        {
          context: this.#mutation(stored),
          groupId: { value: stored.groupId },
          deviceId: { value: deviceId },
        },
        options(signal),
      ),
    );
  }

  async setAuthorityMode(mode: AuthorityMode, signal?: AbortSignal): Promise<GroupSummary> {
    const stored = this.#requireSession();
    const response = await call(() =>
      this.#sync.setAuthorityMode(
        {
          context: this.#mutation(stored),
          groupId: { value: stored.groupId },
          mode:
            mode === 'leader' ? syncV1.AuthorityMode.LEADER : syncV1.AuthorityMode.MULTI_AUTHORITY,
        },
        options(signal),
      ),
    );
    return toGroup(required(response.group, 'Control plane returned no group.'));
  }

  async setLeader(deviceId: string, signal?: AbortSignal): Promise<GroupSummary> {
    const stored = this.#requireSession();
    const response = await call(() =>
      this.#sync.setLeader(
        {
          context: this.#mutation(stored),
          groupId: { value: stored.groupId },
          deviceId: { value: deviceId },
        },
        options(signal),
      ),
    );
    return toGroup(required(response.group, 'Control plane returned no group.'));
  }

  /**
   * One clock probe. The two client instants bracket the call; the two server
   * instants come back in the response. The arithmetic is in `clock.ts`.
   */
  async timeSync(signal?: AbortSignal): Promise<ClockSample> {
    const stored = this.#requireSession();
    const clientSendMs = this.#now();
    const response = await call(() =>
      this.#sync.timeSync(
        {
          groupId: { value: stored.groupId },
          clientSendMonotonicMs: BigInt(Math.max(0, Math.floor(clientSendMs))),
          clientWallTime: toTimestamp(clientSendMs),
        },
        options(signal),
      ),
    );
    const clientReceiveMs = this.#now();
    return {
      clientSendMs,
      serverReceiveMs: toEpochMs(response.serverReceiveTime),
      serverSendMs: toEpochMs(response.serverSendTime),
      clientReceiveMs,
    };
  }

  async getPresence(signal?: AbortSignal): Promise<readonly PresenceEntry[]> {
    const stored = this.#requireSession();
    const response = await call(() =>
      this.#sync.getPresence({ groupId: { value: stored.groupId } }, options(signal)),
    );
    return response.devices.map(toPresence);
  }

  #stored(): StoredDeviceSession | null {
    const stored = this.#store.read();
    // A session earned from another control plane is not presented to this
    // one: the token would be refused, and the refusal would read as a
    // revoked session rather than a changed address.
    return stored === null || stored.controlPlaneUrl !== this.baseUrl ? null : stored;
  }

  #requireSession(): StoredDeviceSession {
    const stored = this.#stored();
    if (stored === null) throw new ControlPlaneError('unauthenticated', 'No paired session.');
    return stored;
  }

  /**
   * `actor_device_id` is set to the authenticated device, which the server
   * requires it to equal when present; a fresh `request_id` gives every
   * mutation its own receipt.
   */
  #mutation(stored: StoredDeviceSession): WireMutationContext {
    return { requestId: this.#mintRequestId(), actorDeviceId: { value: stored.deviceId } };
  }
}

async function call<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw toControlPlaneError(error);
  }
}

export function toControlPlaneError(error: unknown): ControlPlaneError {
  if (error instanceof ControlPlaneError) return error;
  if (error instanceof ConnectError) {
    return new ControlPlaneError(toKind(error.code), error.rawMessage, { cause: error });
  }
  // A fetch that never reached the host arrives as a plain error; to the
  // session that is the same fact as an `Unavailable` code.
  return new ControlPlaneError(
    'unavailable',
    error instanceof Error ? error.message : 'Control plane unreachable.',
    { cause: error },
  );
}

function toKind(code: Code): ControlPlaneErrorKind {
  switch (code) {
    case Code.Unauthenticated:
      return 'unauthenticated';
    case Code.PermissionDenied:
      return 'permission-denied';
    case Code.Unimplemented:
      return 'unimplemented';
    case Code.Unavailable:
    case Code.DeadlineExceeded:
      return 'unavailable';
    case Code.InvalidArgument:
      return 'invalid-argument';
    case Code.NotFound:
      return 'not-found';
    case Code.FailedPrecondition:
      return 'failed-precondition';
    default:
      return 'unknown';
  }
}

function options(signal: AbortSignal | undefined): CallOptions {
  return signal === undefined ? {} : { signal };
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new ControlPlaneError('unknown', message);
  return value;
}

function toEpochMs(timestamp: WireTimestamp | undefined): number {
  if (timestamp === undefined) return 0;
  return Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000);
}

function toTimestamp(epochMs: number): WireTimestamp {
  const seconds = Math.floor(epochMs / 1000);
  return { seconds: BigInt(seconds), nanos: Math.round((epochMs - seconds * 1000) * 1_000_000) };
}

function toRole(role: number): DeviceRole {
  if (role === syncV1.DeviceRole.ADMIN) return 'ADMIN';
  if (role === syncV1.DeviceRole.EDITOR) return 'EDITOR';
  return 'VIEWER';
}

function toStatus(status: number): PresenceStatus {
  if (status === syncV1.DeviceStatus.ONLINE) return 'ONLINE';
  if (status === syncV1.DeviceStatus.REVOKED) return 'REVOKED';
  return 'OFFLINE';
}

function toGroup(group: WireGroup): GroupSummary {
  return {
    groupId: group.id?.value ?? '',
    name: group.name,
    authority:
      group.authorityMode === syncV1.AuthorityMode.MULTI_AUTHORITY ? 'multi-authority' : 'leader',
    leaderDeviceId: group.leaderDeviceId?.value ?? '',
  };
}

function toDevice(device: WireDevice): GroupDevice {
  return {
    deviceId: device.id?.value ?? '',
    name: device.name,
    role: toRole(device.role),
    status: toStatus(device.status),
  };
}

function toPresence(presence: WirePresence): PresenceEntry {
  const observed = toEpochMs(presence.observedAt);
  return {
    deviceId: presence.deviceId?.value ?? '',
    status: toStatus(presence.status),
    activeScreen: presence.activeScreen,
    clockOffsetMs: Number(presence.clockOffsetMs),
    latencyMs: presence.latencyMs,
    observedAt: observed === 0 ? '' : new Date(observed).toISOString(),
  };
}
