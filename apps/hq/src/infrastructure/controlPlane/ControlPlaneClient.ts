import { Code, ConnectError, createClient, type Transport } from '@connectrpc/connect';
import {
  ControlPlaneFailure,
  ControlPlaneFailureDetailSchema,
  ControlPlaneService,
  SyncService,
  syncV1,
} from '@gremuchaya/protocol';

import {
  emptyPresenceDetail,
  type AuthorityMode,
  type ConnectionSession,
  type ControlPlaneCapabilities,
  type DeviceRole,
  type GroupDevice,
  type GroupSummary,
  type PairingRole,
  type PresenceDetail,
  type PresenceEntry,
} from '@/application/sync/connection';
import {
  ControlPlaneError,
  controlPlaneErrorKinds,
  isControlPlaneError,
  type ClockSample,
  type ControlPlaneErrorCode,
  type ControlPlanePort,
  type CreateGroupRequest,
  type PairingCodeGrant,
  type PairingResult,
} from '@/application/sync/controlPlanePort';
import type {
  RealtimeIdentity,
  DocumentDeltaPublication,
  DocumentDeltaReceipt,
  DocumentSnapshot,
  GroupSessionCommand,
  SessionCommandPublication,
} from '@/application/sync/groupChannel';
import type { GroupEventPage } from '@/application/sync/groupEventFeed';

import { createBearerInterceptor } from './authInterceptor';
import { BrowserDeviceIdentity, type DeviceIdentity } from './DeviceIdentity';
import { DeviceSessionStore, type StoredDeviceSession } from './DeviceSessionStore';
import {
  fromDeviceRole,
  fromGroupSessionAction,
  fromPresenceDetail,
  fromSynchronizedDocumentType,
  toDeviceRole,
  toEpochMs,
  toGroupDevice,
  toGroupEventEnvelope,
  toGroupSessionCommand,
  toGroupSummary,
  toPresenceEntry,
  toSynchronizedDocumentType,
  toWireTimestamp,
  type WireDevice,
  type WireGroup,
  type WirePresence,
  type WirePresenceDetail,
  type WireResourceId,
  type WireTimestamp,
} from './groupEventCodec';
import { createControlPlaneTransport } from './transport';

/*
 * The wire shapes this facade reads live in `groupEventCodec`, beside the
 * conversions, because the very same group, device and presence messages arrive
 * both as answers to these calls and as events on the log. What is declared
 * here is only what the log never carries: the session and the mutation
 * context.
 */
interface WireSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt?: WireTimestamp | undefined;
  readonly refreshTokenExpiresAt?: WireTimestamp | undefined;
  readonly deviceId?: WireResourceId | undefined;
  readonly groupId?: WireResourceId | undefined;
  readonly role: number;
}

/**
 * The session command as it crosses the wire in both directions.
 *
 * `epoch` and `sequence` are sent as zero and read back from the response: the
 * server overwrites both (`sync/service.ts`, `publishSessionCommand`), and a
 * client that filled them in would be stating an order it does not own.
 */
interface WireSessionCommand {
  readonly epoch: bigint;
  readonly sequence: bigint;
  readonly action: syncV1.SessionCommandAction;
  readonly target: string;
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly executeAt?: WireTimestamp | undefined;
  readonly issuedByDeviceId?: WireResourceId | undefined;
}

interface WireMutationContext {
  readonly requestId: string;
  readonly actorDeviceId?: WireResourceId;
}

/**
 * The issued pairing code, which only `CreatePairingCode` answers.
 *
 * Declared here beside the session rather than in the codec because the group
 * log never carries one: a code is a credential, and the contract keeps
 * credentials out of the event stream entirely.
 */
interface WirePairingCode {
  readonly code: string;
  readonly groupId?: WireResourceId | undefined;
  readonly role: number;
  readonly expiresAt?: WireTimestamp | undefined;
}

interface CallOptions {
  readonly signal?: AbortSignal;
  /**
   * Per-call headers, which exactly one call uses: `CreateGroup` presents the
   * bootstrap secret. It is set here rather than in an interceptor because an
   * interceptor would have to hold the secret for the life of the transport,
   * and this way it exists for the duration of one request.
   */
  readonly headers?: HeadersInit;
}

export interface ControlRpcClient {
  getCapabilities(
    request: Record<string, never>,
    options?: CallOptions,
  ): Promise<{
    readonly capabilities: readonly { readonly name: string; readonly enabled: boolean }[];
    /** Empty when this control plane reached no database, or an older one. */
    readonly installationId: string;
  }>;
}

export interface SyncRpcClient {
  createGroup(
    request: {
      readonly context: WireMutationContext;
      readonly name: string;
      readonly initialDevice: {
        readonly name: string;
        readonly publicKey: string;
        readonly platform: string;
        readonly applicationVersion: string;
      };
    },
    options?: CallOptions,
  ): Promise<{
    readonly group?: WireGroup | undefined;
    readonly device?: WireDevice | undefined;
    readonly session?: WireSession | undefined;
  }>;
  createPairingCode(
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly role: syncV1.DeviceRole;
    },
    options?: CallOptions,
  ): Promise<{ readonly pairingCode?: WirePairingCode | undefined }>;
  updateGroup(
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly name: string;
    },
    options?: CallOptions,
  ): Promise<{ readonly group?: WireGroup | undefined }>;
  setDeviceRole(
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly deviceId: WireResourceId;
      readonly role: syncV1.DeviceRole;
    },
    options?: CallOptions,
  ): Promise<{ readonly device?: WireDevice | undefined }>;
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
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly detail: WirePresenceDetail;
    },
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
  updatePresence(
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly detail: WirePresenceDetail;
    },
    options?: CallOptions,
  ): Promise<{ readonly devices: readonly WirePresence[] }>;
  publishDocumentDelta(
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly documentId: WireResourceId;
      readonly documentType: syncV1.SynchronizedDocumentType;
      readonly stateVector: Uint8Array;
      readonly delta: Uint8Array;
      readonly hybridLogicalClock: bigint;
    },
    options?: CallOptions,
  ): Promise<{ readonly sequence: bigint; readonly stateVector: Uint8Array }>;
  publishSessionCommand(
    request: {
      readonly context: WireMutationContext;
      readonly groupId: WireResourceId;
      readonly command: WireSessionCommand;
    },
    options?: CallOptions,
  ): Promise<{ readonly command?: WireSessionCommand | undefined }>;
  getDocumentSnapshot(
    request: { readonly groupId: WireResourceId; readonly documentId: WireResourceId },
    options?: CallOptions,
  ): Promise<{
    readonly snapshot: Uint8Array;
    readonly stateVector: Uint8Array;
    readonly sequence: bigint;
    readonly documentType: syncV1.SynchronizedDocumentType;
  }>;
  readGroupEvents(
    request: {
      readonly groupId: WireResourceId;
      readonly afterSequence: bigint;
      readonly limit: number;
    },
    options?: CallOptions,
  ): Promise<{
    readonly events: readonly syncV1.GroupEvent[];
    readonly earliestAvailableSequence: bigint;
    readonly hasMore: boolean;
    readonly resyncRequired: boolean;
  }>;
}

/**
 * What a client may do with the shared session store.
 *
 * `owner` is the whole of today's behaviour and stays the default, so a single
 * link -- the only shape that existed before F14 stage 7 -- is unchanged.
 * `reader` presents the stored credentials and never writes them: it makes no
 * `PairDevice` and, above all, no `RefreshDeviceSession` call.
 *
 * That one rule is what keeps two planes safe. Rotation is single-writer by
 * construction on the server: `refresh_token_hash` is unique, the retired hash
 * has a partial unique index of its own, and presenting a rotated token with a
 * *different* `request_id` is classified as a stolen-token replay and revokes
 * the whole session family (`durable-runtime.ts`, `refreshDeviceSession`). Two
 * clients sharing one session store would each mint an id of their own and do
 * exactly that to themselves, in the middle of a shoot. A retry from one client
 * is safe across both planes because the id is persisted before the call and
 * answered by the receipt in the shared database; a second *minter* is not.
 */
export type ControlPlaneCredentialRole = 'owner' | 'reader';

export interface ControlPlaneClientOptions {
  readonly baseUrl: string;
  readonly sessionStore?: DeviceSessionStore;
  /** Defaults to `owner`; see {@link ControlPlaneCredentialRole}. */
  readonly credentials?: ControlPlaneCredentialRole;
  /** Injected by tests; built from the transport when absent. */
  readonly clients?: {
    readonly control: ControlRpcClient;
    readonly sync: SyncRpcClient;
  };
  readonly device?: { readonly platform: string; readonly applicationVersion: string };
  /**
   * What pairing presents as `public_key`; the browser-persisted keypair when
   * absent. The control plane refuses an empty key, so a test that stubs the
   * sync client but not this still pairs.
   */
  readonly identity?: DeviceIdentity;
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
  /** Whether this client may write the session store. */
  readonly credentials: ControlPlaneCredentialRole;
  readonly #store: DeviceSessionStore;
  readonly #control: ControlRpcClient;
  readonly #sync: SyncRpcClient;
  readonly #device: { readonly platform: string; readonly applicationVersion: string };
  readonly #identity: DeviceIdentity;
  readonly #mintRequestId: () => string;
  readonly #now: () => number;
  readonly #transport: Transport | undefined;
  /**
   * What the last `GetCapabilities` said this control plane's database is.
   *
   * `''` until a probe answers, and `''` afterwards if the control plane
   * reported none. A session paired without a probe is stored with an unknown
   * installation rather than an invented one.
   */
  #probedInstallationId = '';

  constructor(options: ControlPlaneClientOptions) {
    this.baseUrl = options.baseUrl;
    this.credentials = options.credentials ?? 'owner';
    this.#store = options.sessionStore ?? new DeviceSessionStore();
    this.#device = options.device ?? { platform: 'web', applicationVersion: '' };
    this.#identity = options.identity ?? new BrowserDeviceIdentity();
    this.#mintRequestId = options.mintRequestId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => Date.now());
    if (options.clients !== undefined) {
      this.#control = options.clients.control;
      this.#sync = options.clients.sync;
      this.#transport = undefined;
    } else {
      const transport = createControlPlaneTransport(options.baseUrl, [
        createBearerInterceptor(() => this.accessToken()),
      ]);
      this.#transport = transport;
      this.#control = createClient(ControlPlaneService, transport);
      this.#sync = createClient(SyncService, transport);
    }
  }

  /**
   * The authenticated transport, so a second service client can share it.
   *
   * `SettingsService` needs the same bearer interceptor and the same base
   * address, and building a second transport would mean a second place for the
   * token-reading rule to drift. `undefined` when a test injected clients, in
   * which case there is no transport to share and the test supplies its own.
   */
  get transport(): Transport | undefined {
    return this.#transport;
  }

  /**
   * What a realtime `ClientHello` carries, or `null` without a session.
   *
   * Assembled here rather than in the socket client because this is where the
   * credential lives: the token is read out of the session store at the moment
   * a socket opens, exactly as the bearer interceptor reads it at the moment of
   * a call, so a reconnect after a refresh greets the server with the rotated
   * token rather than the one this client was built with.
   */
  realtimeIdentity(): RealtimeIdentity | null {
    const stored = this.#stored();
    if (stored === null) return null;
    return {
      groupId: stored.groupId,
      deviceId: stored.deviceId,
      accessToken: stored.accessToken,
    };
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

  /**
   * Drops the session for good. The next connection needs a pairing code.
   *
   * A reader does nothing: the credentials belong to the owner link, and a
   * follower clearing them would end the session for every link at once from a
   * failure that concerned only its own plane.
   */
  forgetSession(): void {
    if (this.credentials === 'reader') return;
    this.#store.clear();
  }

  /**
   * The installation the stored session was minted against, or `null` with no
   * session. `''` is a session that predates the field, which is unknown and
   * deliberately not a match.
   */
  storedInstallationId(): string | null {
    return this.#stored()?.controlPlaneInstallationId ?? null;
  }

  /**
   * Records the installation on a session that holds none; never replaces one.
   *
   * A reader records nothing. The identity a session is scoped to is the one
   * the owner link probed, and letting a second plane fill in the blank would
   * decide the question this field exists to ask.
   */
  adoptInstallationId(installationId: string): void {
    if (this.credentials === 'reader') return;
    this.#store.adoptInstallationId(installationId);
  }

  async probeCapabilities(signal?: AbortSignal): Promise<ControlPlaneCapabilities> {
    const response = await call(() => this.#control.getCapabilities({}, options(signal)));
    const enabled = (name: string) =>
      response.capabilities.some((capability) => capability.name === name && capability.enabled);
    /*
     * The identity is remembered here as well as returned, so that a `pair`
     * that follows this probe can write it onto the session it is about to
     * store. Pairing itself asks the control plane nothing about its database,
     * and adding a second round trip to learn what the probe already reported
     * would be a call made to answer a question that was already answered.
     */
    this.#probedInstallationId = response.installationId;
    return {
      installationId: response.installationId,
      sync: enabled('sync'),
      deviceLifecycle: enabled('sync.device-lifecycle'),
      realtimeAdmission: enabled('sync.realtime-admission'),
      settings: enabled('settings'),
      materials: enabled('materials'),
    };
  }

  /**
   * Brings a group into existence and pairs this device in as its first
   * administrator.
   *
   * The bootstrap secret rides on this one request and on nothing else: it is
   * set as a per-call header, so it is never held by the transport, never
   * written to the session store and never read back out of anything. What
   * comes back is what pairing brings back, and it is stored the same way,
   * because a device that just created a group is a paired device.
   *
   * `initial_device.role` is not sent. The server does not read it -- it writes
   * `'ADMIN'` into the first membership itself (`durable-runtime.ts`,
   * `createGroup`) -- and a client that sent a role would be stating a decision
   * it does not own.
   */
  async createGroup(request: CreateGroupRequest, signal?: AbortSignal): Promise<PairingResult> {
    this.#requireCredentialOwner('create a group');
    const publicKey = await this.#identity.publicKey();
    const response = await call(() =>
      this.#sync.createGroup(
        {
          context: { requestId: this.#mintRequestId() },
          name: request.name.trim(),
          initialDevice: {
            name: request.deviceName.trim(),
            publicKey,
            platform: this.#device.platform,
            applicationVersion: this.#device.applicationVersion,
          },
        },
        {
          ...options(signal),
          headers: { 'x-hq-bootstrap-secret': request.bootstrapSecret },
        },
      ),
    );
    return this.#adoptSession(response);
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
    this.#requireCredentialOwner('pair');
    const publicKey = await this.#identity.publicKey();
    const response = await call(() =>
      this.#sync.pairDevice(
        {
          pairingCode: pairingCode.trim(),
          deviceName: deviceName.trim(),
          publicKey,
          platform: this.#device.platform,
          applicationVersion: this.#device.applicationVersion,
          context: { requestId: this.#mintRequestId() },
        },
        options(signal),
      ),
    );
    return this.#adoptSession(response);
  }

  /**
   * Issues a pairing code for the group this session belongs to.
   *
   * The code is returned and nowhere else. It is a credential in exactly the
   * sense the tokens are -- presenting it earns a session -- so it never
   * reaches the session store, which holds this device's own credentials, and
   * never reaches the `connection` slice, which is persisted and broadcast.
   * The surface that shows it holds it for as long as it is on screen.
   */
  async createPairingCode(role: PairingRole, signal?: AbortSignal): Promise<PairingCodeGrant> {
    const stored = this.#requireSession();
    const response = await call(() =>
      this.#sync.createPairingCode(
        {
          context: this.#mutation(stored),
          groupId: { value: stored.groupId },
          role: fromDeviceRole(role),
        },
        options(signal),
      ),
    );
    const grant = required(response.pairingCode, 'Control plane returned no pairing code.');
    return {
      code: grant.code,
      role: toDeviceRole(grant.role),
      expiresAtMs: toEpochMs(grant.expiresAt),
    };
  }

  /** Renames the group. The server requires an active administrator. */
  async updateGroup(name: string, signal?: AbortSignal): Promise<GroupSummary> {
    const stored = this.#requireSession();
    const response = await call(() =>
      this.#sync.updateGroup(
        {
          context: this.#mutation(stored),
          groupId: { value: stored.groupId },
          name: name.trim(),
        },
        options(signal),
      ),
    );
    return toGroupSummary(required(response.group, 'Control plane returned no group.'));
  }

  /**
   * Changes what a member of the group may do.
   *
   * The answer is the device alone: `SetDeviceRoleResponse` carries no group,
   * so the revision the mutation bumped does not come back here. It arrives on
   * the `DEVICE_UPDATED` event the same mutation publishes, and that is what
   * the group's own fields are ordered by.
   */
  async setDeviceRole(
    deviceId: string,
    role: DeviceRole,
    signal?: AbortSignal,
  ): Promise<GroupDevice> {
    const stored = this.#requireSession();
    const response = await call(() =>
      this.#sync.setDeviceRole(
        {
          context: this.#mutation(stored),
          groupId: { value: stored.groupId },
          deviceId: { value: deviceId },
          role: fromDeviceRole(role),
        },
        options(signal),
      ),
    );
    return toGroupDevice(required(response.device, 'Control plane returned no device.'));
  }

  /**
   * Writes what a group entry earned, whichever call earned it.
   *
   * `CreateGroup` and `PairDevice` are the only two calls that mint a session,
   * they answer the same three messages, and what has to happen to that answer
   * is identical. Two copies of it would be two places for the installation
   * identity or the deprecated scalar fields to be handled differently.
   */
  #adoptSession(response: {
    readonly group?: WireGroup | undefined;
    readonly device?: WireDevice | undefined;
    readonly session?: WireSession | undefined;
  }): PairingResult {
    const session = required(response.session, 'Control plane returned no session.');
    const group = required(response.group, 'Control plane returned no group.');
    const device = required(response.device, 'Control plane returned no device.');
    const stored: StoredDeviceSession = {
      version: 3,
      pairedAtUrl: this.baseUrl,
      // Which database this pairing belongs to, from the probe that preceded
      // it. Recorded at the one moment it is certainly true: the group and the
      // tokens being written here exist in that database and nowhere else.
      controlPlaneInstallationId: this.#probedInstallationId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessTokenExpiresAt: toEpochMs(session.accessTokenExpiresAt),
      refreshTokenExpiresAt: toEpochMs(session.refreshTokenExpiresAt),
      deviceId: session.deviceId?.value ?? '',
      groupId: session.groupId?.value ?? '',
      role: toDeviceRole(session.role),
    };
    this.#store.write(stored);
    return {
      session: { deviceId: stored.deviceId, groupId: stored.groupId, role: stored.role },
      group: toGroupSummary(group),
      device: toGroupDevice(device),
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
    // Before anything is read, and above all before anything is sent: a reader
    // that reached the wire here would mint a second `request_id` against a
    // token the owner is rotating, which the server reads as a stolen-token
    // replay and answers by revoking the whole session family.
    this.#requireCredentialOwner('refresh');
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
      role: toDeviceRole(session.role),
    });
    return { deviceId: next.deviceId, groupId: next.groupId, role: next.role };
  }

  /**
   * Enters the group's session, and reports what this device is showing on
   * the same call (F10 presence publish): participation, not membership.
   *
   * `detail` defaults to nothing to report, so a caller that supplies none --
   * a test, or a client from before this existed -- still joins exactly as it
   * always did; the wire message carries the proto3 defaults either way.
   */
  async join(detail?: PresenceDetail, signal?: AbortSignal): Promise<GroupSummary> {
    const stored = this.#requireSession();
    const response = await call(() =>
      this.#sync.joinGroup(
        {
          context: this.#mutation(stored),
          groupId: { value: stored.groupId },
          detail: fromPresenceDetail(detail ?? emptyPresenceDetail),
        },
        options(signal),
      ),
    );
    return toGroupSummary(required(response.group, 'Control plane returned no group on join.'));
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
      devices.push(...response.devices.map(toGroupDevice));
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
    return toGroupSummary(required(response.group, 'Control plane returned no group.'));
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
    return toGroupSummary(required(response.group, 'Control plane returned no group.'));
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
          clientWallTime: toWireTimestamp(clientSendMs),
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
    return response.devices.map(toPresenceEntry);
  }

  /**
   * Reports what this device is currently showing, and renews its liveness
   * with the same call (F10 presence publish).
   *
   * The answer is the group's presence after the report, exactly as
   * `getPresence` would answer it, so `ControlPlaneSession.refreshPresence`
   * learns both a neighbour's change and the effect of its own report from
   * one round trip.
   */
  async updatePresence(
    detail: PresenceDetail,
    signal?: AbortSignal,
  ): Promise<readonly PresenceEntry[]> {
    const stored = this.#requireSession();
    const response = await call(() =>
      this.#sync.updatePresence(
        {
          context: this.#mutation(stored),
          groupId: { value: stored.groupId },
          detail: fromPresenceDetail(detail),
        },
        options(signal),
      ),
    );
    return response.devices.map(toPresenceEntry);
  }

  /**
   * Appends one document delta to the group log.
   *
   * The sequence comes back from the append; nothing about ordering is decided
   * here. `state_vector` is sent empty by the only caller in this application
   * -- live edit carries settings patches, not a CRDT document -- and the field
   * is kept on the publication so a later CRDT caller has somewhere to put it.
   */
  async publishDocumentDelta(
    publication: DocumentDeltaPublication,
    signal?: AbortSignal,
  ): Promise<DocumentDeltaReceipt> {
    const stored = this.#requireSession();
    const response = await call(() =>
      this.#sync.publishDocumentDelta(
        {
          context: this.#mutation(stored),
          groupId: { value: stored.groupId },
          documentId: { value: publication.documentId },
          documentType: fromSynchronizedDocumentType(publication.documentType),
          stateVector: publication.stateVector ?? new Uint8Array(0),
          delta: publication.delta,
          hybridLogicalClock: publication.hybridLogicalClock ?? 0n,
        },
        options(signal),
      ),
    );
    return { sequence: response.sequence, stateVector: response.stateVector };
  }

  /**
   * Appends one session command and answers with the one the server recorded.
   *
   * `epoch`, `sequence` and `issued_by_device_id` are sent empty on purpose:
   * the server sets all three, and the returned command -- not the requested
   * one -- is what the caller must order by.
   */
  async publishSessionCommand(
    publication: SessionCommandPublication,
    signal?: AbortSignal,
  ): Promise<GroupSessionCommand> {
    const stored = this.#requireSession();
    const executeAtMs = publication.executeAtMs;
    const response = await call(() =>
      this.#sync.publishSessionCommand(
        {
          context: this.#mutation(stored),
          groupId: { value: stored.groupId },
          command: {
            epoch: 0n,
            sequence: 0n,
            action: fromGroupSessionAction(publication.action),
            target: publication.target,
            positionSeconds: publication.positionSeconds ?? 0,
            playbackRate: publication.playbackRate ?? 0,
            ...(executeAtMs === undefined ? {} : { executeAt: toWireTimestamp(executeAtMs) }),
          },
        },
        options(signal),
      ),
    );
    const command = required(response.command, 'Control plane returned no session command.');
    return toWireSessionCommand(command);
  }

  /**
   * The snapshot a resume falls back to, or `null` when none was recorded.
   *
   * `NOT_FOUND` becomes `null` because a group whose log still covers every
   * resume point has no snapshot at all, and that is not a failure to show.
   */
  async getDocumentSnapshot(
    documentId: string,
    signal?: AbortSignal,
  ): Promise<DocumentSnapshot | null> {
    const stored = this.#requireSession();
    try {
      const response = await call(() =>
        this.#sync.getDocumentSnapshot(
          { groupId: { value: stored.groupId }, documentId: { value: documentId } },
          options(signal),
        ),
      );
      return {
        snapshot: response.snapshot,
        stateVector: response.stateVector,
        sequence: response.sequence,
        documentType: toSynchronizedDocumentType(response.documentType),
      };
    } catch (error: unknown) {
      if (isControlPlaneError(error, 'not-found')) return null;
      throw error;
    }
  }

  /**
   * One page of the group log, for the feed that has no socket to follow.
   *
   * `limit` is sent as zero, which the contract defines as the server's own
   * default. The retained-window ceiling is the control plane's
   * (`defaultRealtimeReplayLimit`), and naming a number here would be a second
   * copy of it -- one that a client built against an older deployment could
   * exceed, at which point the request is refused rather than clamped.
   *
   * A refusal is not swallowed. Unlike `getDocumentSnapshot`, which turns
   * `NOT_FOUND` into `null` because a group with no snapshot is ordinary, every
   * failure here is one the feed has to see: it must not advance its cursor
   * past a page it never read.
   */
  async readGroupEvents(afterSequence: bigint, signal?: AbortSignal): Promise<GroupEventPage> {
    const stored = this.#requireSession();
    const response = await call(() =>
      this.#sync.readGroupEvents(
        { groupId: { value: stored.groupId }, afterSequence, limit: 0 },
        options(signal),
      ),
    );
    return {
      events: response.events.map(toGroupEventEnvelope),
      earliestAvailableSequence: response.earliestAvailableSequence,
      hasMore: response.hasMore,
      resyncRequired: response.resyncRequired,
    };
  }

  /**
   * The stored session, whatever address earned it.
   *
   * Up to `v2` this hid a session paired against another address, on the
   * reasoning that the token would be refused there. That reasoning does not
   * survive a group reachable two ways at once: an access token is verified by
   * `token_hash` and `hash_version` against `device_access_tokens`, with no
   * process, origin or issuer recorded anywhere in the row
   * (`durable-runtime.ts`, `authenticate`), so a token minted by the plane on
   * the set's LAN is accepted by the plane on the internet in front of the same
   * database. What still has to agree is the database itself, and
   * `ControlPlaneSession` checks that by installation identity rather than by
   * address -- a check an address filter would have hidden rather than made.
   *
   * Two preconditions of the deployment ride on this and are stated where they
   * can be read: both planes must carry the same token pepper and the same
   * `HQ_CONTROL_PLANE_AUTH_TOKEN_HASH_VERSION`, because the verifying query
   * filters by the verifier's own version.
   */
  #stored(): StoredDeviceSession | null {
    return this.#store.read();
  }

  /**
   * A sibling client for the same address, store and RPC clients, with
   * `owner` credentials (F14 stage 7, plane failover).
   *
   * A no-op when this client already owns the credentials. Otherwise a new
   * instance, because `credentials` is declared `readonly` and stays that way
   * -- the refusal it gates protects the one property a stolen-token replay
   * depends on: exactly one client minting refresh request ids against the
   * stored token at a time. Promoting a link is therefore building the client
   * failover needs and retiring the old one, never mutating one in place.
   */
  asOwner(): ControlPlaneClient {
    return this.#withCredentials('owner');
  }

  /** The same sibling, demoted to `reader` -- the plane failover retired. */
  asReader(): ControlPlaneClient {
    return this.#withCredentials('reader');
  }

  #withCredentials(role: ControlPlaneCredentialRole): ControlPlaneClient {
    if (this.credentials === role) return this;
    return new ControlPlaneClient({
      baseUrl: this.baseUrl,
      sessionStore: this.#store,
      credentials: role,
      device: this.#device,
      identity: this.#identity,
      mintRequestId: this.#mintRequestId,
      now: this.#now,
      // A test injects RPC clients rather than a transport; the sibling reuses
      // the very same fakes, so it answers exactly as the client it replaces
      // would have. A real deployment rebuilds the transport instead, which is
      // cheap next to the round trip every call on it will make anyway.
      ...(this.#transport === undefined
        ? { clients: { control: this.#control, sync: this.#sync } }
        : {}),
    });
  }

  /**
   * Refuses an act that writes credentials on a client that may only read them.
   *
   * `failed-precondition` rather than `permission-denied`: nothing was refused
   * by the control plane and no call was made. It is this client's role that
   * makes the act wrong, and the kind says so.
   */
  #requireCredentialOwner(operation: string): void {
    if (this.credentials === 'owner') return;
    throw new ControlPlaneError(
      'failed-precondition',
      `This control plane link reads credentials and does not ${operation}.`,
    );
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

/**
 * What each wire code is called on this side.
 *
 * Total over `ControlPlaneFailure` except its zero value, so a code added to
 * `control.proto` and regenerated fails to compile here until this build knows
 * what to call it. That is one half of the guarantee; the other half is that a
 * code this build has *not* been rebuilt for still arrives safely, which is
 * what `toFailureCode` is for.
 */
const wireFailureCodes: Readonly<
  Record<Exclude<ControlPlaneFailure, ControlPlaneFailure.UNSPECIFIED>, ControlPlaneErrorCode>
> = {
  [ControlPlaneFailure.INTERNAL]: 'internal',
  [ControlPlaneFailure.BEARER_TOKEN_REQUIRED]: 'bearer-token-required',
  [ControlPlaneFailure.BOOTSTRAP_AUTHORIZATION_REQUIRED]: 'bootstrap-authorization-required',
  [ControlPlaneFailure.SESSION_UNAUTHENTICATED]: 'session-unauthenticated',
  [ControlPlaneFailure.PERMISSION_DENIED]: 'permission-denied',
  [ControlPlaneFailure.NOT_FOUND]: 'not-found',
  [ControlPlaneFailure.ALREADY_EXISTS]: 'already-exists',
  [ControlPlaneFailure.INVALID_ARGUMENT]: 'invalid-argument',
  [ControlPlaneFailure.FAILED_PRECONDITION]: 'failed-precondition',
  [ControlPlaneFailure.CONCURRENT_MODIFICATION]: 'concurrent-modification',
  [ControlPlaneFailure.RATE_LIMITED]: 'rate-limited',
  [ControlPlaneFailure.REPLAY_WINDOW_EXCEEDED]: 'replay-window-exceeded',
  [ControlPlaneFailure.GROUP_ADMINISTRATION_UNAVAILABLE]: 'group-administration-unavailable',
  [ControlPlaneFailure.PRESENCE_UNAVAILABLE]: 'presence-unavailable',
  [ControlPlaneFailure.EVENT_LOG_UNAVAILABLE]: 'event-log-unavailable',
  [ControlPlaneFailure.REALTIME_HUB_UNAVAILABLE]: 'realtime-hub-unavailable',
  [ControlPlaneFailure.SETTINGS_SCHEMA_UNAVAILABLE]: 'settings-schema-unavailable',
  [ControlPlaneFailure.SETTINGS_STORAGE_UNAVAILABLE]: 'settings-storage-unavailable',
  [ControlPlaneFailure.INTEGRATION_STORAGE_UNAVAILABLE]: 'integration-storage-unavailable',
  [ControlPlaneFailure.INTEGRATION_GITHUB_UNAVAILABLE]: 'integration-github-unavailable',
  [ControlPlaneFailure.INTEGRATION_GITHUB_UNREACHABLE]: 'integration-github-unreachable',
};

/**
 * A `Map` rather than an index into the record above, because a lookup by a
 * number this build has never seen must answer `undefined` and not throw. The
 * record stays the source of truth and stays exhaustive; this is only how it is
 * read.
 */
const wireFailureCodesByValue = new Map<number, ControlPlaneErrorCode>(
  Object.entries(wireFailureCodes).map(([value, code]) => [Number(value), code]),
);

/** What a transport status means when the control plane attached no code. */
const transportFailureCodes: Readonly<Record<Code, ControlPlaneErrorCode>> = {
  [Code.Canceled]: 'canceled',
  [Code.Unknown]: 'unknown',
  [Code.InvalidArgument]: 'invalid-argument',
  [Code.DeadlineExceeded]: 'deadline-exceeded',
  [Code.NotFound]: 'not-found',
  [Code.AlreadyExists]: 'already-exists',
  [Code.PermissionDenied]: 'permission-denied',
  [Code.ResourceExhausted]: 'rate-limited',
  [Code.FailedPrecondition]: 'failed-precondition',
  [Code.Aborted]: 'concurrent-modification',
  [Code.OutOfRange]: 'invalid-argument',
  [Code.Unimplemented]: 'unimplemented',
  [Code.Internal]: 'internal',
  [Code.Unavailable]: 'unavailable',
  [Code.DataLoss]: 'internal',
  [Code.Unauthenticated]: 'session-unauthenticated',
};

export function toControlPlaneError(error: unknown): ControlPlaneError {
  if (error instanceof ControlPlaneError) return error;
  if (error instanceof ConnectError) {
    const code = toFailureCode(error);
    /*
     * `rawMessage` stays as the message, and stays developer-facing. It is what
     * the diagnostics copy needs in order to name the exact refusal, and it is
     * deliberately no longer the only thing this error carries: `code` is what a
     * surface keys a Russian caption off, and rewording the server's English
     * must not change what the operator reads.
     */
    return new ControlPlaneError(controlPlaneErrorKinds[code], error.rawMessage, {
      cause: error,
      code,
    });
  }
  // A fetch that never reached the host arrives as a plain error; to the
  // session that is the same fact as an `Unavailable` code.
  return new ControlPlaneError(
    'unavailable',
    error instanceof Error ? error.message : 'Control plane unreachable.',
    { cause: error, code: 'unavailable' },
  );
}

/**
 * The code a refusal carries, from its detail when it has one and from its
 * transport status when it does not.
 *
 * Nothing in here may throw. This runs while an error is already being handled,
 * on a path that ends at a screen an operator is watching during a take, and an
 * exception raised here would replace a refused request with a blank surface.
 * Three things are therefore true by construction: `findDetails` drops a detail
 * it cannot decode rather than raising, an unrecognised code number misses the
 * map and falls through, and the transport table is total over `Code` with a
 * final `?? 'unknown'` for a status outside it -- which the gRPC-Web decoder can
 * produce, since it parses `grpc-status` as an integer.
 */
function toFailureCode(error: ConnectError): ControlPlaneErrorCode {
  const [detail] = error.findDetails(ControlPlaneFailureDetailSchema);
  const declared = detail === undefined ? undefined : wireFailureCodesByValue.get(detail.code);
  return declared ?? transportFailureCodes[error.code] ?? 'unknown';
}

function options(signal: AbortSignal | undefined): CallOptions {
  return signal === undefined ? {} : { signal };
}

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new ControlPlaneError('unknown', message);
  return value;
}

/**
 * The structural wire command, read through the shared codec.
 *
 * `toGroupSessionCommand` takes the generated message; this facade declares
 * its wire shapes structurally so a fake satisfies them, and the two agree
 * field for field. The cast is where those two descriptions meet.
 */
function toWireSessionCommand(command: WireSessionCommand): GroupSessionCommand {
  return toGroupSessionCommand(command as unknown as Parameters<typeof toGroupSessionCommand>[0]);
}
