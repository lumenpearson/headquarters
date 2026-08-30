import { timingSafeEqual } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import { timestampFromDate, timestampNow } from '@bufbuild/protobuf/wkt';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ControlPlaneFailure, syncV1 } from '@gremuchaya/protocol';
import type { SyncService } from '@gremuchaya/protocol';

import { controlPlaneFailure, withRuntimeErrors } from '../errors.js';

import {
  defaultRealtimeReplayLimit,
  type DurableRealtimeEventStore,
} from '../realtime/eventStore.js';
import type { GroupEventPublication, RealtimeHub } from '../realtime/hub.js';
import { decideReplay } from '../realtime/replayDecision.js';

import type { UpstashCoordination } from '../redis/coordination.js';

import type {
  GroupAdministration,
  MutatedGroup,
  MutatedGroupDevice,
} from './group-administration.js';
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
import type { Awaitable, MutationOutcome, PairedDeviceLifecycle } from './lifecycle.js';
import { normalizePageSize } from './paging.js';
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
  /**
   * Present only when Upstash is configured. It bounds the two RPCs that append
   * to an unbounded log; every other mutation is bounded by the row it changes.
   */
  readonly coordination?: UpstashCoordination;
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

    /**
     * Takes a device out of the group, and tells the group so.
     *
     * The revocation is durable before anything else happens: the statement
     * below revokes the membership, the device's pairing codes, its sessions
     * and its access tokens, and bumps the group revision, all in one. Only
     * then is the withdrawal announced. An announcement made first would be a
     * promise the mutation might not keep — the statement still refuses a
     * revoke that would empty the group of administrators or unseat its
     * leader — and a neighbour cannot un-drop a device.
     */
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
        // Liveness goes before the announcement, so that the state an event
        // sends a neighbour to read is already settled. The revoked device
        // renews nothing itself — its sessions and tokens were revoked by the
        // statement above, so it can no longer authenticate the read that
        // renews — but a key it left behind outlives it, and the Redis
        // membership set outlives the key. Optional like the hub: a startup
        // with no presence store revokes exactly as it did before.
        await options.presence?.forget({
          groupId: revoked.group.id,
          deviceId: revoked.device.id,
        });
        // `DEVICE_UPDATED`, and not `GROUP_UPDATED`, because a neighbour has to
        // learn *which* device left; the group snapshot rides along because the
        // same statement bumped the revision, and that revision is what orders
        // this event against the answer to whatever call a session makes next.
        // The device snapshot says `REVOKED` rather than being omitted: a
        // subscriber holding a device it must now distrust is better served by
        // the fact than by an absence it cannot tell from an event about a
        // device it never knew. `ListDevices` stays the path that drops the
        // row, so the two agree on the device and differ only on whether a
        // departed member is still worth showing.
        await publishDeviceUpdate(options, revoked);
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
        await publishGroupUpdate(options, updated);
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
        await publishGroupUpdate(options, updated);
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
        await publishGroupUpdate(options, updated);
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
        await publishDeviceUpdate(options, changed);
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

    /**
     * Reads the group's presence and, in the same call, keeps the reader alive.
     *
     * This is deliberately not a pure read, and the trade is worth naming. A
     * device announces itself once, at `JoinGroup`, and its liveness key lasts
     * forty-five seconds; a client that only ever asked who was present
     * therefore reported itself `OFFLINE` three quarters of a minute after
     * joining, while sitting on the connection. Renewing through `JoinGroup`
     * would fix the reading and wreck the log: that call publishes
     * `PRESENCE_UPDATED` through the hub, which appends a durable `sync_events`
     * row and spends a sequence number, so a fifteen-second heartbeat per
     * device would add thousands of rows a day to the history every polling
     * client reads back in pages.
     *
     * A separate heartbeat RPC would keep the read pure at the cost of a change
     * to the versioned contract and a second timer on every client, carrying
     * the same single fact this call already carries. Asking who is present is
     * itself evidence of being present, so the two travel together: any client
     * that shows presence keeps itself alive by showing it, and none can forget
     * to.
     *
     * The device renewed is the one the bearer token authenticated, never one
     * named by the request — `GetPresenceRequest` carries no device field at
     * all — and `assertAuthenticatedGroup` has already refused a session
     * reaching into another group. A revoked device, session or token fails
     * authentication above and renews nothing.
     */
    async getPresence(request, context) {
      return withRuntimeErrors(async () => {
        const presence = requirePresence(options.presence);
        const authenticated = await authenticateRequest(options.runtime, context);
        const groupId = requireResourceId(request.groupId?.value, 'group_id');
        assertAuthenticatedGroup(authenticated, groupId);
        // Before the read, so the answer already accounts for the renewal the
        // caller just earned. No event is published: liveness that lasts until
        // it lapses is not a change worth a row in the group's history.
        await presence.renew({ groupId, deviceId: authenticated.device.id });
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
        await assertPublicationAllowed(options, groupId, authenticated.device.id, 'document');
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
        await assertPublicationAllowed(options, groupId, authenticated.device.id, 'session');
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

    async getDocumentSnapshot(request, context) {
      return withRuntimeErrors(async () => {
        const events = requireEventStore(options.eventStore);
        const authenticated = await authenticateRequest(options.runtime, context);
        const groupId = requireResourceId(request.groupId?.value, 'group_id');
        assertAuthenticatedGroup(authenticated, groupId);
        const snapshot = await events.readDocumentSnapshot(
          groupId,
          requireResourceId(request.documentId?.value, 'document_id'),
        );
        if (snapshot === undefined) {
          throw new PairedDeviceRuntimeError(
            'NOT_FOUND',
            'No snapshot has been recorded for this document.',
          );
        }
        return {
          snapshot: snapshot.snapshot,
          stateVector: snapshot.stateVector,
          sequence: snapshot.sequence,
          documentType: snapshot.documentType,
        };
      });
    },

    /**
     * Reads a page of the group log.
     *
     * This is `WatchGroup` answered by pull instead of push, and the difference
     * is not stylistic. `WatchGroup` needs the hub, whose listener set is a
     * property of one process: a deployment that answers one request on one
     * instance and the next on another would admit a socket that reports itself
     * live and then follows nothing. This method touches no hub at all — it
     * reads the durable log and returns — so it is the surface a serverless
     * deployment can actually serve, and it stays authorized exactly as
     * `WatchGroup` is: an authenticated device, and only its own group.
     */
    async readGroupEvents(request, context) {
      return withRuntimeErrors(async () => {
        const events = requireEventStore(options.eventStore);
        const authenticated = await authenticateRequest(options.runtime, context);
        const groupId = requireResourceId(request.groupId?.value, 'group_id');
        assertAuthenticatedGroup(authenticated, groupId);
        // The ceiling is the one `replay` already enforces, not a second one:
        // asking for more than the store will return is refused here rather
        // than clamped there, because a silently shortened page looks to a
        // caller exactly like the end of the log.
        const limit = normalizePageSize(request.limit, {
          defaultPageSize: defaultRealtimeReplayLimit,
          maxPageSize: defaultRealtimeReplayLimit,
          field: 'limit',
        });
        const page = await events.replay({
          groupId,
          afterSequence: request.afterSequence,
          limit,
        });
        const decision = decideReplay({
          afterSequence: request.afterSequence,
          earliestSequence: page.earliestSequence,
        });
        if (decision.outcome === 'resync') {
          // The same verdict the hub sends as `ResyncRequired`, from the same
          // function. The page is withheld rather than truncated: a caller
          // handed the oldest retained events would read them as a complete
          // history and never ask for the snapshot it needs.
          return {
            events: [],
            earliestAvailableSequence: decision.earliestAvailableSequence,
            hasMore: false,
            resyncRequired: true,
          };
        }
        const last = page.events.at(-1);
        // `has_more` is a fact about the log, not about how full this page came
        // back: a page of exactly `limit` events can still be the last one. The
        // probe runs only for a full page and asks the same `replay`, so there
        // is no second retention rule to keep in step with the first.
        const hasMore =
          last !== undefined &&
          page.events.length >= limit &&
          (await events.replay({ groupId, afterSequence: last.sequence, limit: 1 })).events.length >
            0;
        return {
          events: [...page.events],
          earliestAvailableSequence: page.earliestSequence ?? 0n,
          hasMore,
          resyncRequired: false,
        };
      });
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
            queue.fail(controlPlaneFailure(ControlPlaneFailure.REPLAY_WINDOW_EXCEEDED));
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
    throw controlPlaneFailure(ControlPlaneFailure.BOOTSTRAP_AUTHORIZATION_REQUIRED);
  }
}

function readBearerToken(context: HandlerContext): string {
  const header = context.requestHeader.get('authorization');
  const match = header === null ? undefined : /^Bearer ([^\s]+)$/u.exec(header.trim());
  if (match?.[1] === undefined) {
    throw controlPlaneFailure(ControlPlaneFailure.BEARER_TOKEN_REQUIRED);
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

function requireAdministration(
  administration: GroupAdministration | undefined,
): GroupAdministration {
  if (administration === undefined) {
    throw controlPlaneFailure(ControlPlaneFailure.GROUP_ADMINISTRATION_UNAVAILABLE);
  }
  return administration;
}

function requirePresence(presence: PresenceStore | undefined): PresenceStore {
  if (presence === undefined) {
    throw controlPlaneFailure(ControlPlaneFailure.PRESENCE_UNAVAILABLE);
  }
  return presence;
}

function requireEventStore(
  eventStore: DurableRealtimeEventStore | undefined,
): DurableRealtimeEventStore {
  if (eventStore === undefined) {
    throw controlPlaneFailure(ControlPlaneFailure.EVENT_LOG_UNAVAILABLE);
  }
  return eventStore;
}

function requireHub(hub: RealtimeHub | undefined): RealtimeHub {
  if (hub === undefined) {
    throw controlPlaneFailure(ControlPlaneFailure.REALTIME_HUB_UNAVAILABLE);
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

/**
 * Bounds the only two RPCs that append to a log with no natural ceiling.
 *
 * Every other mutation writes a row that already exists and is bounded by it; a
 * publication adds one. Without a limiter an editor can fill `sync_events`
 * faster than retention prunes it and push every other device's resume point
 * off the end. When Redis is absent no limit is applied — which is stated in the
 * health response rather than assumed.
 */
async function assertPublicationAllowed(
  options: PairedDeviceServiceOptions,
  groupId: string,
  deviceId: string,
  category: string,
): Promise<void> {
  const coordination = options.coordination;
  if (coordination === undefined || !coordination.configured) return;
  const decision = await coordination.limitMutation(groupId, deviceId, category);
  if (decision.allowed) return;
  throw controlPlaneFailure(ControlPlaneFailure.RATE_LIMITED);
}

/**
 * Announces a group mutation, unless the mutation did not run.
 *
 * A retry carrying an already-completed `request_id` is answered from its
 * receipt: the statement never executed, the group was revised once, and the
 * snapshot handed back is the one the original call produced. Publishing it
 * again appended a second copy of that snapshot to `sync_events`, spent a
 * sequence number, and lengthened the log every polling client reads back in
 * pages — for an event carrying a revision each subscriber has already seen and
 * therefore drops. All five publishing mutations funnel through here, so the
 * decision is made once rather than five times.
 *
 * The publication is built lazily so a replay pays for no protobuf it will not
 * send.
 */
async function announceGroupMutation(
  options: PairedDeviceServiceOptions,
  mutated: MutationOutcome,
  publication: () => GroupEventPublication,
): Promise<void> {
  if (mutated.replayed) return;
  await options.hub?.publish(publication());
}

async function publishGroupUpdate(
  options: PairedDeviceServiceOptions,
  mutated: MutatedGroup,
): Promise<void> {
  await announceGroupMutation(options, mutated, () => ({
    groupId: mutated.group.id,
    kind: syncV1.GroupEventKind.GROUP_UPDATED,
    group: create(syncV1.GroupSchema, toGroup(mutated.group)),
  }));
}

/**
 * The one event that says a device is not what it was.
 *
 * Both callers — a role change and a revocation — change a device and bump the
 * group's revision in the same statement, so both send both snapshots. Written
 * once rather than at each call site because a second copy would be free to
 * carry only half of that, and a subscriber deciding by revision cannot use an
 * event that omits it.
 */
async function publishDeviceUpdate(
  options: PairedDeviceServiceOptions,
  mutated: MutatedGroupDevice,
): Promise<void> {
  await announceGroupMutation(options, mutated, () => ({
    groupId: mutated.group.id,
    kind: syncV1.GroupEventKind.DEVICE_UPDATED,
    group: create(syncV1.GroupSchema, toGroup(mutated.group)),
    device: create(syncV1.DeviceSchema, toDevice(mutated.device)),
  }));
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
