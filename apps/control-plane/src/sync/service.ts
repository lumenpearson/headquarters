import { timingSafeEqual } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import { timestampFromDate, timestampNow } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { syncV1 } from '@gremuchaya/protocol';
import type { SyncService } from '@gremuchaya/protocol';

import type { DurableRealtimeEventStore } from '../realtime/eventStore.js';
import type { RealtimeHub } from '../realtime/hub.js';

import type { GroupAdministration } from './group-administration.js';
import type { PresenceSnapshot, PresenceStore } from './presence-store.js';

import {
  PairedDeviceRuntimeError,
  type AuthenticatedDevice,
  type AuthorityMode,
  type DeviceRole,
  type PairedDevice,
  type PairedDeviceSession,
  type PairedGroup,
} from './runtime.js';
import type { Awaitable, PairedDeviceLifecycle } from './lifecycle.js';
import {
  MutationRequestIdError,
  normalizeRequestId,
  type MutationReceiptContext,
} from './receipts.js';

export interface PairedDeviceServiceOptions {
  readonly runtime: PairedDeviceLifecycle;
  /**
   * A configuration-owned verifier for the operator bootstrap secret. The raw
   * deployment value remains in a configuration closure and is never added to
   * the service object, responses, telemetry, or error text.
   */
  readonly verifyBootstrapSecret: (candidate: string) => boolean;
  /**
   * The remaining collaborators are optional so a startup that injects only the
   * deterministic pairing runtime keeps working. What is absent stays
   * `unimplemented` on the wire, which is what the client already knows how to
   * read; it is never faked with an empty success.
   */
  readonly administration?: GroupAdministration;
  readonly presence?: PresenceStore;
  readonly eventStore?: DurableRealtimeEventStore;
  readonly hub?: RealtimeHub;
}

/**
 * ConnectRPC adapter for `SyncService`.
 *
 * Every method the contract declares is implemented here, but which ones are
 * *reachable* still depends on what the composition root supplied: pairing
 * needs only the lifecycle, while administration, presence and event
 * publication each need their own collaborator. A method whose collaborator is
 * absent answers `unimplemented` rather than an empty success, so a client can
 * tell a reduced deployment from a working one.
 */
export function createPairedDeviceSyncService(
  options: PairedDeviceServiceOptions,
): Partial<ServiceImpl<typeof SyncService>> {
  const verifyBootstrapSecret = requireBootstrapVerifier(options.verifyBootstrapSecret);

  return {
    async createGroup(request, context) {
      return withRuntimeErrors(async () => {
        requireBootstrapAuthorization(context, verifyBootstrapSecret);
        const created = await options.runtime.createGroup({
          name: request.name,
          initialDevice: {
            name: request.initialDevice?.name ?? '',
            publicKey: request.initialDevice?.publicKey ?? '',
            platform: request.initialDevice?.platform ?? '',
            applicationVersion: request.initialDevice?.applicationVersion ?? '',
          },
          ...toMutationReceiptInput(request.context?.requestId),
        });
        return {
          group: toGroup(created.group),
          device: toDevice(created.device),
          session: toSession(created.session),
        };
      });
    },

    async createPairingCode(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const mutation = toMutationReceiptContext(request.context?.requestId);
        const grant = await callWithMutation(mutation, (context) =>
          options.runtime.createPairingCode(
            authenticated,
            requireResourceId(request.groupId?.value, 'group_id'),
            toPairingRole(request.role),
            ...context,
          ),
        );
        return {
          pairingCode: {
            code: grant.code,
            groupId: { value: grant.groupId },
            role: toProtocolRole(grant.role),
            expiresAt: timestampFromDate(grant.expiresAt),
          },
        };
      });
    },

    async pairDevice(request) {
      return withRuntimeErrors(async () => {
        const paired = await options.runtime.pairDevice({
          pairingCode: request.pairingCode,
          name: request.deviceName,
          publicKey: request.publicKey,
          platform: request.platform,
          applicationVersion: request.applicationVersion,
          ...toMutationReceiptInput(request.context?.requestId),
        });
        return {
          group: toGroup(paired.group),
          device: toDevice(paired.device),
          // Deprecated scalar credential fields are deliberately left empty.
          // `session` is the only canonical credential envelope.
          session: toSession(paired.session),
        };
      });
    },

    async refreshDeviceSession(request) {
      return withRuntimeErrors(async () => {
        const mutation = toMutationReceiptContext(request.context?.requestId);
        const session =
          mutation === undefined
            ? await options.runtime.refreshDeviceSession(request.refreshToken)
            : await options.runtime.refreshDeviceSession(request.refreshToken, mutation);
        return { session: toSession(session) };
      });
    },

    async listDevices(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticateRequest(options.runtime, context);
        const page = await options.runtime.listDevices(
          authenticated,
          requireResourceId(request.groupId?.value, 'group_id'),
          request.page?.pageSize ?? 0,
          request.page?.cursor ?? '',
        );
        return {
          devices: page.items.map(toDevice),
          page: {
            nextCursor: page.nextCursor,
            previousCursor: page.previousCursor,
            hasMore: page.hasMore,
            approximateTotal: page.approximateTotal,
          },
        };
      });
    },

    async revokeDevice(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const mutation = toMutationReceiptContext(request.context?.requestId);
        const revoked = await callWithMutation(mutation, (context) =>
          options.runtime.revokeDevice(
            authenticated,
            requireResourceId(request.groupId?.value, 'group_id'),
            requireResourceId(request.deviceId?.value, 'device_id'),
            ...context,
          ),
        );
        return {
          result: {
            resourceId: { value: revoked.device.id },
            revision: toRevision(revoked.group),
            correlationId: request.context?.correlationId ?? '',
          },
        };
      });
    },
    async updateGroup(request, context) {
      return withRuntimeErrors(async () => {
        const administration = requireAdministration(options.administration);
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const mutation = toMutationReceiptContext(request.context?.requestId);
        const updated = await callWithMutation(mutation, (receiptContext) =>
          administration.updateGroup(
            authenticated,
            requireResourceId(request.groupId?.value, 'group_id'),
            request.name,
            ...receiptContext,
          ),
        );
        await publishGroupUpdate(options, updated.group);
        return { group: toGroup(updated.group) };
      });
    },

    async setAuthorityMode(request, context) {
      return withRuntimeErrors(async () => {
        const administration = requireAdministration(options.administration);
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const mutation = toMutationReceiptContext(request.context?.requestId);
        const updated = await callWithMutation(mutation, (receiptContext) =>
          administration.setAuthorityMode(
            authenticated,
            requireResourceId(request.groupId?.value, 'group_id'),
            toAuthorityMode(request.mode),
            ...receiptContext,
          ),
        );
        await publishGroupUpdate(options, updated.group);
        return { group: toGroup(updated.group) };
      });
    },

    async setLeader(request, context) {
      return withRuntimeErrors(async () => {
        const administration = requireAdministration(options.administration);
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const mutation = toMutationReceiptContext(request.context?.requestId);
        const updated = await callWithMutation(mutation, (receiptContext) =>
          administration.setLeader(
            authenticated,
            requireResourceId(request.groupId?.value, 'group_id'),
            requireResourceId(request.deviceId?.value, 'device_id'),
            ...receiptContext,
          ),
        );
        await publishGroupUpdate(options, updated.group);
        return { group: toGroup(updated.group) };
      });
    },

    async setDeviceRole(request, context) {
      return withRuntimeErrors(async () => {
        const administration = requireAdministration(options.administration);
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const mutation = toMutationReceiptContext(request.context?.requestId);
        const changed = await callWithMutation(mutation, (receiptContext) =>
          administration.setDeviceRole(
            authenticated,
            requireResourceId(request.groupId?.value, 'group_id'),
            requireResourceId(request.deviceId?.value, 'device_id'),
            toDeviceRole(request.role),
            ...receiptContext,
          ),
        );
        await options.hub?.publish({
          groupId: changed.group.id,
          kind: syncV1.GroupEventKind.DEVICE_UPDATED,
          group: create(syncV1.GroupSchema, toGroup(changed.group)),
          device: create(syncV1.DeviceSchema, toDevice(changed.device)),
        });
        return { device: toDevice(changed.device) };
      });
    },

    /**
     * Enters the group's synchronized session.
     *
     * Joining is participation, not membership: `PairDevice` is what puts a
     * device in a group, and `RevokeDevice` is what takes it out. R27 asks for
     * sessions that enter and leave synchronization groups, and this is that —
     * which is why leaving keeps the session alive and rejoining needs no
     * pairing code.
     */
    async joinGroup(request, context) {
      return withRuntimeErrors(async () => {
        const presence = requirePresence(options.presence);
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const groupId = requireResourceId(request.groupId?.value, 'group_id');
        assertAuthenticatedGroup(authenticated, groupId);
        const recorded = await presence.record({
          groupId,
          deviceId: authenticated.device.id,
          status: 'ONLINE',
        });
        await publishPresence(options, groupId, recorded);
        return { group: toGroup(authenticated.group) };
      });
    },

    async leaveGroup(request, context) {
      return withRuntimeErrors(async () => {
        const presence = requirePresence(options.presence);
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const groupId = requireResourceId(request.groupId?.value, 'group_id');
        assertAuthenticatedGroup(authenticated, groupId);
        const recorded = await presence.record({
          groupId,
          deviceId: authenticated.device.id,
          status: 'OFFLINE',
        });
        await publishPresence(options, groupId, recorded);
        return {
          result: {
            resourceId: { value: authenticated.device.id },
            revision: toRevision(authenticated.group),
            correlationId: request.context?.correlationId ?? '',
          },
        };
      });
    },

    async getPresence(request, context) {
      return withRuntimeErrors(async () => {
        const presence = requirePresence(options.presence);
        const authenticated = await authenticateRequest(options.runtime, context);
        const groupId = requireResourceId(request.groupId?.value, 'group_id');
        assertAuthenticatedGroup(authenticated, groupId);
        const devices = await presence.list(groupId);
        return { devices: devices.map(toPresence) };
      });
    },

    async publishDocumentDelta(request, context) {
      return withRuntimeErrors(async () => {
        const events = requireEventStore(options.eventStore);
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const groupId = requireResourceId(request.groupId?.value, 'group_id');
        assertAuthenticatedGroup(authenticated, groupId);
        assertEditor(authenticated);
        const mutation = toMutationReceiptContext(request.context?.requestId);
        const appended = await events.appendAuthorized(
          {
            groupId,
            actorDeviceId: authenticated.device.id,
            kind: syncV1.GroupEventKind.DOCUMENT_DELTA,
            documentId: requireResourceId(request.documentId?.value, 'document_id'),
            documentType: request.documentType,
            documentDelta: request.delta,
            stateVector: request.stateVector,
            hybridLogicalClock: request.hybridLogicalClock,
          },
          ...(mutation === undefined ? [] : [mutation]),
        );
        options.hub?.deliver(groupId, appended.event);
        return { sequence: appended.event.sequence, stateVector: appended.stateVector };
      });
    },

    async publishSessionCommand(request, context) {
      return withRuntimeErrors(async () => {
        const events = requireEventStore(options.eventStore);
        const authenticated = await authenticateRequest(options.runtime, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const groupId = requireResourceId(request.groupId?.value, 'group_id');
        assertAuthenticatedGroup(authenticated, groupId);
        assertEditor(authenticated);
        assertSessionAuthority(authenticated);
        const mutation = toMutationReceiptContext(request.context?.requestId);
        // `epoch` and `sequence` are server facts: the epoch is the group
        // revision the command was issued against, and the sequence is the one
        // the append allocates. A client-chosen pair would let two sessions
        // disagree about which command is newer.
        const requested = request.command;
        const command = create(syncV1.SessionCommandSchema, {
          epoch: authenticated.group.revision,
          sequence: 0n,
          action: requested?.action ?? syncV1.SessionCommandAction.UNSPECIFIED,
          target: requested?.target ?? '',
          positionSeconds: requested?.positionSeconds ?? 0,
          playbackRate: requested?.playbackRate ?? 0,
          ...(requested?.executeAt === undefined ? {} : { executeAt: requested.executeAt }),
          issuedByDeviceId: { value: authenticated.device.id },
        });
        const appended = await events.appendAuthorized(
          {
            groupId,
            actorDeviceId: authenticated.device.id,
            kind: syncV1.GroupEventKind.SESSION_COMMAND,
            sessionCommand: command,
          },
          ...(mutation === undefined ? [] : [mutation]),
        );
        options.hub?.deliver(groupId, appended.event);
        return {
          command: { ...command, sequence: appended.event.sequence },
        };
      });
    },

    /**
     * Answers a clock probe.
     *
     * The receive instant is taken before anything else and the send instant
     * last, because the client subtracts them to remove server processing from
     * its round-trip estimate. Reading both at the end would make the estimate
     * silently wrong by however long authentication took, which is exactly the
     * millisecond-scale error R27 cannot tolerate.
     */
    timeSync(request) {
      const serverReceiveTime = timestampNow();
      return {
        clientSendMonotonicMs: request.clientSendMonotonicMs,
        serverReceiveTime,
        serverSendTime: timestampNow(),
      };
    },

    async *watchGroup(request, context) {
      const hub = requireHub(options.hub);
      const authenticated = await authenticateRequest(options.runtime, context);
      const groupId = requireResourceId(request.groupId?.value, 'group_id');
      assertAuthenticatedGroup(authenticated, groupId);

      const queue = new GroupEventQueue();
      const unsubscribe = await hub.subscribe({
        groupId,
        afterSequence: request.afterSequence,
        send: (frame) => {
          if (frame.payload.case === 'groupEvent' && frame.payload.value.event !== undefined) {
            queue.push(frame.payload.value.event);
          }
          if (frame.payload.case === 'resyncRequired') {
            // A resume the log can no longer answer is reported in-band rather
            // than by silently starting from the oldest retained event, which
            // would look to the client like a complete history.
            queue.fail(
              new ConnectError(
                'The requested resume point is no longer retained; request a snapshot.',
                Code.OutOfRange,
              ),
            );
          }
        },
      });
      context.signal.addEventListener('abort', () => queue.close(), { once: true });
      try {
        for await (const event of queue) yield { event };
      } finally {
        unsubscribe();
      }
    },
  };
}

function authenticateRequest(
  runtime: PairedDeviceLifecycle,
  context: HandlerContext,
): Awaitable<AuthenticatedDevice> {
  return runtime.authenticateAccessToken(readBearerToken(context));
}

/**
 * `request_id` is the only part of `MutationContext` that carries idempotency
 * meaning. `correlation_id` is response metadata and `issued_at` is a client
 * clock reading, so neither may take part in retry identity.
 *
 * An oversized identifier is rejected as an argument error rather than
 * silently truncated: truncation would let two different retries share one
 * receipt.
 */
function toMutationReceiptContext(
  requestId: string | undefined,
): MutationReceiptContext | undefined {
  try {
    const normalized = normalizeRequestId(requestId);
    return normalized === undefined ? undefined : { requestId: normalized };
  } catch (error: unknown) {
    if (error instanceof MutationRequestIdError) {
      throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', error.message);
    }
    throw error;
  }
}

/**
 * Applies an optional trailing `mutation` argument without ever passing an
 * explicit `undefined`, which `exactOptionalPropertyTypes` rejects against an
 * optional parameter.
 */
function callWithMutation<T>(
  mutation: MutationReceiptContext | undefined,
  call: (context: [MutationReceiptContext] | []) => T,
): T {
  return call(mutation === undefined ? [] : [mutation]);
}

/** Spread form, because `exactOptionalPropertyTypes` rejects an explicit `undefined`. */
function toMutationReceiptInput(requestId: string | undefined): {
  readonly mutation?: MutationReceiptContext;
} {
  const mutation = toMutationReceiptContext(requestId);
  return mutation === undefined ? {} : { mutation };
}

function assertContextActor(
  authenticated: AuthenticatedDevice,
  actorDeviceId: string | undefined,
): void {
  if (actorDeviceId === undefined || actorDeviceId.length === 0) return;
  if (actorDeviceId !== authenticated.device.id) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'The mutation context actor does not match the authenticated device.',
    );
  }
}
function requireBootstrapAuthorization(
  context: HandlerContext,
  verifyBootstrapSecret: (candidate: string) => boolean,
): void {
  const supplied = context.requestHeader.get('x-hq-bootstrap-secret');
  if (supplied === null || !verifyBootstrapSecret(supplied)) {
    throw new ConnectError('Bootstrap authorization is required.', Code.Unauthenticated);
  }
}

function readBearerToken(context: HandlerContext): string {
  const header = context.requestHeader.get('authorization');
  const match = header === null ? undefined : /^Bearer ([^\s]+)$/u.exec(header.trim());
  if (match?.[1] === undefined) {
    throw new ConnectError('A bearer access token is required.', Code.Unauthenticated);
  }
  return match[1];
}

export function createBootstrapSecretVerifier(value: string): (candidate: string) => boolean {
  const normalized = value.trim();
  if (normalized.length < 32) {
    throw new Error('bootstrapSecret must contain at least 32 non-whitespace characters');
  }
  return (candidate) => constantTimeEqual(candidate, normalized);
}

function requireBootstrapVerifier(
  value: ((candidate: string) => boolean) | undefined,
): (candidate: string) => boolean {
  if (value === undefined) throw new Error('verifyBootstrapSecret is required');
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function toGroup(group: PairedGroup) {
  return {
    id: { value: group.id },
    name: group.name,
    authorityMode:
      group.authorityMode === 'LEADER'
        ? syncV1.AuthorityMode.LEADER
        : syncV1.AuthorityMode.MULTI_AUTHORITY,
    leaderDeviceId: { value: group.leaderDeviceId },
    revision: toRevision(group),
    createdAt: timestampFromDate(group.createdAt),
    updatedAt: timestampFromDate(group.updatedAt),
  };
}

function toRevision(group: PairedGroup) {
  return {
    number: group.revision,
    etag: `group-${group.id}-revision-${group.revision.toString()}`,
  };
}

function toDevice(device: PairedDevice) {
  return {
    id: { value: device.id },
    name: device.name,
    publicKey: device.publicKey,
    role: toProtocolRole(device.role),
    status: toProtocolDeviceStatus(device.status),
    platform: device.platform,
    applicationVersion: device.applicationVersion,
    lastSeenAt: timestampFromDate(device.lastSeenAt),
  };
}

function toSession(session: PairedDeviceSession) {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessTokenExpiresAt: timestampFromDate(session.accessTokenExpiresAt),
    refreshTokenExpiresAt: timestampFromDate(session.refreshTokenExpiresAt),
    deviceId: { value: session.deviceId },
    groupId: { value: session.groupId },
    role: toProtocolRole(session.role),
  };
}

function toProtocolDeviceStatus(status: PairedDevice['status']): syncV1.DeviceStatus {
  if (status === 'OFFLINE') return syncV1.DeviceStatus.OFFLINE;
  if (status === 'ONLINE') return syncV1.DeviceStatus.ONLINE;
  return syncV1.DeviceStatus.REVOKED;
}

function toPairingRole(role: syncV1.DeviceRole): Exclude<DeviceRole, 'ADMIN'> {
  if (role === syncV1.DeviceRole.VIEWER) return 'VIEWER';
  if (role === syncV1.DeviceRole.EDITOR) return 'EDITOR';
  throw new PairedDeviceRuntimeError(
    'INVALID_ARGUMENT',
    'Pairing codes can grant only VIEWER or EDITOR access.',
  );
}

function toProtocolRole(role: DeviceRole): syncV1.DeviceRole {
  if (role === 'VIEWER') return syncV1.DeviceRole.VIEWER;
  if (role === 'EDITOR') return syncV1.DeviceRole.EDITOR;
  return syncV1.DeviceRole.ADMIN;
}

function requireResourceId(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  return value.trim();
}

async function withRuntimeErrors<T>(operation: () => Awaitable<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof ConnectError) throw error;
    if (error instanceof PairedDeviceRuntimeError) {
      throw new ConnectError(error.message, toConnectCode(error.code));
    }
    throw error;
  }
}

function toConnectCode(code: PairedDeviceRuntimeError['code']): Code {
  if (code === 'ABORTED') return Code.Aborted;
  if (code === 'ALREADY_EXISTS') return Code.AlreadyExists;
  if (code === 'FAILED_PRECONDITION') return Code.FailedPrecondition;
  if (code === 'INVALID_ARGUMENT') return Code.InvalidArgument;
  if (code === 'NOT_FOUND') return Code.NotFound;
  if (code === 'PERMISSION_DENIED') return Code.PermissionDenied;
  return Code.Unauthenticated;
}

function requireAdministration(
  administration: GroupAdministration | undefined,
): GroupAdministration {
  if (administration === undefined) {
    throw new ConnectError(
      'This control plane was started without group administration.',
      Code.Unimplemented,
    );
  }
  return administration;
}

function requirePresence(presence: PresenceStore | undefined): PresenceStore {
  if (presence === undefined) {
    throw new ConnectError(
      'This control plane was started without presence storage.',
      Code.Unimplemented,
    );
  }
  return presence;
}

function requireEventStore(
  eventStore: DurableRealtimeEventStore | undefined,
): DurableRealtimeEventStore {
  if (eventStore === undefined) {
    throw new ConnectError(
      'This control plane was started without a durable event log.',
      Code.Unimplemented,
    );
  }
  return eventStore;
}

function requireHub(hub: RealtimeHub | undefined): RealtimeHub {
  if (hub === undefined) {
    throw new ConnectError(
      'This control plane was started without a realtime hub.',
      Code.Unimplemented,
    );
  }
  return hub;
}

/**
 * A device's session names exactly one group, so a request for any other group
 * is refused before it can reach a statement. This is what keeps a valid token
 * from reading or writing a group it was never paired into.
 */
function assertAuthenticatedGroup(authenticated: AuthenticatedDevice, groupId: string): void {
  if (authenticated.group.id !== groupId) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'The authenticated device does not belong to the requested group.',
    );
  }
}

function assertEditor(authenticated: AuthenticatedDevice): void {
  if (authenticated.role === 'VIEWER') {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'A viewer cannot publish to the group.',
    );
  }
}

/**
 * Under leader authority exactly one device drives the group, so a session
 * command from anyone else is refused. Under multi-authority every editor may
 * drive it, which is the mode R27 describes as making every session main.
 */
function assertSessionAuthority(authenticated: AuthenticatedDevice): void {
  if (authenticated.group.authorityMode !== 'LEADER') return;
  if (authenticated.group.leaderDeviceId !== authenticated.device.id) {
    throw new PairedDeviceRuntimeError(
      'FAILED_PRECONDITION',
      'Only the group leader can issue session commands while the group is under leader authority.',
    );
  }
}

async function publishGroupUpdate(
  options: PairedDeviceServiceOptions,
  group: PairedGroup,
): Promise<void> {
  await options.hub?.publish({
    groupId: group.id,
    kind: syncV1.GroupEventKind.GROUP_UPDATED,
    group: create(syncV1.GroupSchema, toGroup(group)),
  });
}

async function publishPresence(
  options: PairedDeviceServiceOptions,
  groupId: string,
  snapshot: PresenceSnapshot,
): Promise<void> {
  await options.hub?.publish({
    groupId,
    kind: syncV1.GroupEventKind.PRESENCE_UPDATED,
    presence: toPresence(snapshot),
  });
}

function toPresence(snapshot: PresenceSnapshot) {
  return create(syncV1.PresenceSchema, {
    deviceId: { value: snapshot.deviceId },
    status: toProtocolDeviceStatus(snapshot.status),
    activeScreen: snapshot.activeScreen,
    selectedElement: snapshot.selectedElement,
    clockOffsetMs: snapshot.clockOffsetMs,
    latencyMs: snapshot.latencyMs,
    observedAt: timestampFromDate(snapshot.observedAt),
  });
}

function toAuthorityMode(mode: syncV1.AuthorityMode): AuthorityMode {
  if (mode === syncV1.AuthorityMode.LEADER) return 'LEADER';
  if (mode === syncV1.AuthorityMode.MULTI_AUTHORITY) return 'MULTI_AUTHORITY';
  throw new PairedDeviceRuntimeError(
    'INVALID_ARGUMENT',
    'An authority mode must be named explicitly.',
  );
}

function toDeviceRole(role: syncV1.DeviceRole): DeviceRole {
  if (role === syncV1.DeviceRole.VIEWER) return 'VIEWER';
  if (role === syncV1.DeviceRole.EDITOR) return 'EDITOR';
  if (role === syncV1.DeviceRole.ADMIN) return 'ADMIN';
  throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'A device role must be named explicitly.');
}

/**
 * Bridges the hub's push delivery to the pull shape a server-streaming RPC
 * needs.
 *
 * The hub calls a listener; a Connect stream awaits a value. Without a queue in
 * between, an event published while the generator is between yields would be
 * dropped — the same loss the durable log exists to prevent, reintroduced one
 * layer up.
 */
class GroupEventQueue implements AsyncIterable<syncV1.GroupEvent> {
  readonly #pending: syncV1.GroupEvent[] = [];
  #wake: (() => void) | undefined;
  #closed = false;
  #failure: unknown;

  push(event: syncV1.GroupEvent): void {
    if (this.#closed) return;
    this.#pending.push(event);
    this.#wake?.();
  }

  fail(error: unknown): void {
    this.#failure = error;
    this.close();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<syncV1.GroupEvent> {
    for (;;) {
      while (this.#pending.length > 0) {
        const next = this.#pending.shift();
        if (next !== undefined) yield next;
      }
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = () => {
          this.#wake = undefined;
          resolve();
        };
      });
    }
  }
}
