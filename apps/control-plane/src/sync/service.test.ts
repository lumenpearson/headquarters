import { create } from '@bufbuild/protobuf';
import { Code, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { syncV1, type SyncService } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import { InMemoryRealtimeEventStore } from '../realtime/eventStore.js';
import { RealtimeHub } from '../realtime/hub.js';

import {
  InMemoryPresenceStore,
  type PresenceDeviceInput,
  type PresenceSnapshot,
  type PresenceStore,
  type RecordPresenceInput,
} from './presence-store.js';
import { PairedDeviceRuntime } from './runtime.js';
import { createPairedDeviceSyncService } from './service.js';

/**
 * Offline proofs for the parts of the service layer the wire suite cannot
 * isolate: what a method does when its collaborator was never supplied, which
 * device a read keeps alive and what it writes while doing so, and whether the
 * streaming bridge drops an event that arrives between two yields.
 *
 * Everything about storage, locking and receipts is proved against a live
 * engine elsewhere; a scripted collaborator here would only restate the code.
 */
const tokenPepper = 'service-test-token-pepper-with-at-least-thirty-two-characters';

describe('SyncService without its optional collaborators', () => {
  it('answers unimplemented rather than an empty success', async () => {
    const service = createPairedDeviceSyncService({
      runtime: new PairedDeviceRuntime({ tokenPepper }),
      verifyBootstrapSecret: () => true,
    });
    const context = handlerContext('Bearer irrelevant');

    // A client can tell a reduced deployment from a working one only if the
    // absent surface says so. An empty success would look like a group with no
    // presence, no history and no documents.
    for (const call of [
      () => service.updateGroup?.(create(syncV1.UpdateGroupRequestSchema, {}), context),
      () => service.setLeader?.(create(syncV1.SetLeaderRequestSchema, {}), context),
      () => service.getPresence?.(create(syncV1.GetPresenceRequestSchema, {}), context),
      () =>
        service.publishDocumentDelta?.(
          create(syncV1.PublishDocumentDeltaRequestSchema, {}),
          context,
        ),
      // The polling reader needs the durable log and nothing else, so a startup
      // without one has to say `unimplemented` rather than answer an empty page:
      // an empty page is what a caller that is already current also receives.
      () => service.readGroupEvents?.(create(syncV1.ReadGroupEventsRequestSchema, {}), context),
    ]) {
      await expect(Promise.resolve(call())).rejects.toMatchObject({
        code: Code.Unimplemented,
      });
    }
  });

  it('answers a clock probe without any collaborator at all', () => {
    const service = createPairedDeviceSyncService({
      runtime: new PairedDeviceRuntime({ tokenPepper }),
      verifyBootstrapSecret: () => true,
    });

    const response = service.timeSync?.(
      create(syncV1.TimeSyncRequestSchema, { clientSendMonotonicMs: 99n }),
      handlerContext(''),
    );

    expect(response).toMatchObject({ clientSendMonotonicMs: 99n });
  });
});

describe('SyncService presence renewal', () => {
  it('keeps the reading device alive without writing a line of the group log', async () => {
    const { service, events, presence, groupId, editorToken } = await authenticatedService();
    const editorContext = handlerContext(`Bearer ${editorToken}`);
    await service.joinGroup?.(
      create(syncV1.JoinGroupRequestSchema, { groupId: { value: groupId } }),
      editorContext,
    );
    const afterJoin = await logLength(events, groupId);

    for (let poll = 0; poll < 8; poll += 1) {
      await service.getPresence?.(
        create(syncV1.GetPresenceRequestSchema, { groupId: { value: groupId } }),
        editorContext,
      );
    }

    // Eight polls, eight renewals, and not one new row. This is the whole
    // reason renewal is not a second `JoinGroup`: that call publishes
    // `PRESENCE_UPDATED` through the hub, so a fifteen-second heartbeat per
    // device would grow the log by thousands of rows a day — a log every
    // polling client reads back in pages.
    expect(presence.renewals).toHaveLength(8);
    expect(await logLength(events, groupId)).toBe(afterJoin);
  });

  it('renews the device the bearer token names and no other', async () => {
    const { service, presence, groupId, ownerToken, ownerDeviceId, editorToken, editorDeviceId } =
      await authenticatedService();

    await service.getPresence?.(
      create(syncV1.GetPresenceRequestSchema, { groupId: { value: groupId } }),
      handlerContext(`Bearer ${editorToken}`),
    );
    await service.getPresence?.(
      create(syncV1.GetPresenceRequestSchema, { groupId: { value: groupId } }),
      handlerContext(`Bearer ${ownerToken}`),
    );

    // `GetPresenceRequest` carries a group and nothing else, so there is no
    // field on the wire a caller could use to name a device; the identifier can
    // only come from the session the bearer token authenticated. A reader
    // therefore cannot keep another operator's laptop looking present.
    expect(presence.renewals).toEqual([
      { groupId, deviceId: editorDeviceId },
      { groupId, deviceId: ownerDeviceId },
    ]);
  });

  it('renews nothing for a caller who cannot be authenticated', async () => {
    const { service, presence, groupId } = await authenticatedService();

    await expect(
      Promise.resolve(
        service.getPresence?.(
          create(syncV1.GetPresenceRequestSchema, { groupId: { value: groupId } }),
          handlerContext('Bearer not-a-token'),
        ),
      ),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });

    expect(presence.renewals).toEqual([]);
  });
});

describe('SyncService device revocation', () => {
  it('appends one event naming the device, with the revision the revoke produced', async () => {
    const { service, events, groupId, ownerToken, editorToken, editorDeviceId } =
      await authenticatedService();
    await service.joinGroup?.(
      create(syncV1.JoinGroupRequestSchema, { groupId: { value: groupId } }),
      handlerContext(`Bearer ${editorToken}`),
    );
    const before = await logEvents(events, groupId);
    const revisionBefore = before.at(-1)?.group?.revision?.number ?? 0n;

    const revoked = await service.revokeDevice?.(
      create(syncV1.RevokeDeviceRequestSchema, {
        groupId: { value: groupId },
        deviceId: { value: editorDeviceId },
      }),
      handlerContext(`Bearer ${ownerToken}`),
    );

    // One event, not none and not two: a neighbour that already learned of the
    // revocation learns of it once, and the log a polling client reads back in
    // pages grows by the single fact that happened.
    const appended = (await logEvents(events, groupId)).slice(before.length);
    expect(appended).toHaveLength(1);
    const event = appended[0];
    expect(event?.kind).toBe(syncV1.GroupEventKind.DEVICE_UPDATED);
    expect(event?.device?.id?.value).toBe(editorDeviceId);
    // The status is the point of the event. A subscriber that received only a
    // group revision would have to call `ListDevices` to find out what changed,
    // which is the call this event exists to stop it from needing.
    expect(event?.device?.status).toBe(syncV1.DeviceStatus.REVOKED);
    // Published from the mutation's own result, so the snapshot is the state
    // after the revoke rather than the state that was read to perform it. A
    // subscriber ignores an event whose revision it already holds, so a
    // snapshot taken a moment early would be dropped by every neighbour.
    expect(event?.group?.revision?.number).toBe(revoked?.result?.revision?.number);
    expect(event?.group?.revision?.number ?? 0n).toBeGreaterThan(revisionBefore);
  });

  it('withdraws the revoked device from presence, and only that device', async () => {
    const { service, presence, groupId, ownerToken, ownerDeviceId, editorToken, editorDeviceId } =
      await authenticatedService();
    for (const token of [ownerToken, editorToken]) {
      await service.joinGroup?.(
        create(syncV1.JoinGroupRequestSchema, { groupId: { value: groupId } }),
        handlerContext(`Bearer ${token}`),
      );
    }

    await service.revokeDevice?.(
      create(syncV1.RevokeDeviceRequestSchema, {
        groupId: { value: groupId },
        deviceId: { value: editorDeviceId },
      }),
      handlerContext(`Bearer ${ownerToken}`),
    );

    // Announcing presence is what creates a liveness key, and a revoked device
    // can no longer announce anything — its sessions went with its membership.
    // Nothing else would ever withdraw the key it already holds.
    expect(presence.forgets).toEqual([{ groupId, deviceId: editorDeviceId }]);
    const listed = await service.getPresence?.(
      create(syncV1.GetPresenceRequestSchema, { groupId: { value: groupId } }),
      handlerContext(`Bearer ${ownerToken}`),
    );
    expect(listed?.devices.map((entry) => entry.deviceId?.value)).toEqual([ownerDeviceId]);
  });

  it('publishes nothing and withdraws nothing when the revoke is refused', async () => {
    const { service, events, presence, groupId, ownerToken, ownerDeviceId } =
      await authenticatedService();
    const before = await logLength(events, groupId);

    // An administrator revoking its own session is refused by the mutation
    // itself. Every guard it enforces — this one, the last administrator, the
    // sitting leader — happens inside the statement, so the only way an event
    // can be certain of what it reports is to be published after that
    // statement returned.
    await expect(
      Promise.resolve(
        service.revokeDevice?.(
          create(syncV1.RevokeDeviceRequestSchema, {
            groupId: { value: groupId },
            deviceId: { value: ownerDeviceId },
          }),
          handlerContext(`Bearer ${ownerToken}`),
        ),
      ),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });

    expect(await logLength(events, groupId)).toBe(before);
    expect(presence.forgets).toEqual([]);
  });

  it('appends one event for a retried revoke, and one for every distinct one', async () => {
    const { service, events, groupId, ownerToken, editorDeviceId } = await authenticatedService();
    const ownerContext = handlerContext(`Bearer ${ownerToken}`);
    const secondDeviceId = await pairAnalyst(service, groupId, ownerContext, 'ed25519:second');
    const before = await logLength(events, groupId);
    const requestId = 'revoke-editor-once';

    const first = await service.revokeDevice?.(
      revokeRequest(groupId, editorDeviceId, requestId),
      ownerContext,
    );
    const retry = await service.revokeDevice?.(
      revokeRequest(groupId, editorDeviceId, requestId),
      ownerContext,
    );

    // The retry is answered from the receipt, so no mutation ran and there is
    // nothing new to announce. Before the epilogue asked, the log took a second
    // copy of the same snapshot at the same revision — a row every polling
    // client reads back and every subscriber drops.
    expect(retry?.result?.revision?.number).toBe(first?.result?.revision?.number);
    expect(await logLength(events, groupId)).toBe(before + 1);

    // The other direction, so this cannot pass by publishing nothing: a
    // different request identifier is a different mutation and earns its own
    // row.
    const second = await service.revokeDevice?.(
      revokeRequest(groupId, secondDeviceId, 'revoke-second-once'),
      ownerContext,
    );

    expect(await logLength(events, groupId)).toBe(before + 2);
    const appended = (await logEvents(events, groupId)).slice(before);
    expect(
      appended.map((event) => [event.kind, event.device?.id?.value, event.group?.revision?.number]),
    ).toEqual([
      [syncV1.GroupEventKind.DEVICE_UPDATED, editorDeviceId, first?.result?.revision?.number],
      [syncV1.GroupEventKind.DEVICE_UPDATED, secondDeviceId, second?.result?.revision?.number],
    ]);
  });

  it('revokes without a presence store at all', async () => {
    const { service, events, groupId, ownerToken, editorDeviceId } = await authenticatedService({
      presence: false,
    });

    const revoked = await service.revokeDevice?.(
      create(syncV1.RevokeDeviceRequestSchema, {
        groupId: { value: groupId },
        deviceId: { value: editorDeviceId },
      }),
      handlerContext(`Bearer ${ownerToken}`),
    );

    // Presence is one of the collaborators a reduced startup may omit, and
    // revocation never needed it. Requiring it here would turn a working
    // deployment's revoke into `unimplemented`.
    expect(revoked?.result?.resourceId?.value).toBe(editorDeviceId);
    expect(await logLength(events, groupId)).toBe(1);
  });
});

describe('SyncService group event stream', () => {
  it('delivers an event published while the consumer was between yields', async () => {
    const { service, hub, ownerToken, groupId } = await authenticatedService();
    const stream = service.watchGroup?.(
      create(syncV1.WatchGroupRequestSchema, { groupId: { value: groupId }, afterSequence: 0n }),
      handlerContext(`Bearer ${ownerToken}`),
    );
    if (stream === undefined) throw new Error('watchGroup must be implemented');
    const iterator = stream[Symbol.asyncIterator]();

    await hub.publish({ groupId, kind: syncV1.GroupEventKind.GROUP_UPDATED });
    const first = await iterator.next();
    // Published while nobody is awaiting: without the queue this one is lost,
    // because the hub calls a listener and a stream awaits a value.
    await hub.publish({ groupId, kind: syncV1.GroupEventKind.DEVICE_UPDATED });
    await hub.publish({ groupId, kind: syncV1.GroupEventKind.PRESENCE_UPDATED });
    const second = await iterator.next();
    const third = await iterator.next();
    await iterator.return?.(undefined);

    expect([
      first.value?.event?.sequence,
      second.value?.event?.sequence,
      third.value?.event?.sequence,
    ]).toEqual([1n, 2n, 3n]);
  });

  it('stops when the caller aborts, so the subscription cannot outlive it', async () => {
    const { service, hub, ownerToken, groupId } = await authenticatedService();
    const abort = new AbortController();
    const stream = service.watchGroup?.(
      create(syncV1.WatchGroupRequestSchema, { groupId: { value: groupId }, afterSequence: 0n }),
      handlerContext(`Bearer ${ownerToken}`, abort.signal),
    );
    if (stream === undefined) throw new Error('watchGroup must be implemented');
    const iterator = stream[Symbol.asyncIterator]();
    await hub.publish({ groupId, kind: syncV1.GroupEventKind.GROUP_UPDATED });
    await iterator.next();

    abort.abort();
    const ended = await iterator.next();

    expect(ended.done).toBe(true);
    // A listener left behind would keep receiving frames for the life of the
    // process, which is the leak the generator's `finally` exists to prevent.
    await hub.publish({ groupId, kind: syncV1.GroupEventKind.DEVICE_UPDATED });
  });
});

async function authenticatedService(options: { readonly presence?: boolean } = {}) {
  const runtime = new PairedDeviceRuntime({ tokenPepper });
  const created = runtime.createGroup({
    name: 'Stream group',
    initialDevice: {
      name: 'Primary',
      publicKey: 'ed25519:stream',
      platform: 'windows',
      applicationVersion: '0.1.0',
    },
  });
  const owner = runtime.authenticateAccessToken(created.session.accessToken);
  const grant = runtime.createPairingCode(owner, created.group.id, 'EDITOR');
  const paired = runtime.pairDevice({
    pairingCode: grant.code,
    name: 'Analyst',
    publicKey: 'ed25519:analyst',
    platform: 'windows',
    applicationVersion: '0.1.0',
  });
  const events = new InMemoryRealtimeEventStore();
  const hub = new RealtimeHub({ store: events });
  const presence = new RecordingPresenceStore();
  const service = createPairedDeviceSyncService({
    runtime,
    verifyBootstrapSecret: () => true,
    ...(options.presence === false ? {} : { presence }),
    hub,
  });
  return {
    service,
    hub,
    events,
    presence,
    groupId: created.group.id,
    ownerToken: created.session.accessToken,
    ownerDeviceId: created.device.id,
    editorToken: paired.session.accessToken,
    editorDeviceId: paired.device.id,
  };
}

/**
 * Records renewals and delegates the rest. Whether a lease actually outlives
 * its clock is a property of Redis and is proved against a deadline-keeping
 * double in `coordinated-presence-store.test.ts`; what only this layer can show
 * is which device the handler renews, how often, and what it publishes while
 * doing it.
 */
class RecordingPresenceStore implements PresenceStore {
  readonly renewals: PresenceDeviceInput[] = [];
  readonly forgets: PresenceDeviceInput[] = [];
  readonly #delegate = new InMemoryPresenceStore();

  record(input: RecordPresenceInput): Promise<PresenceSnapshot> {
    return this.#delegate.record(input);
  }

  renew(input: PresenceDeviceInput): Promise<void> {
    this.renewals.push(input);
    return Promise.resolve();
  }

  /**
   * Records the withdrawal and performs it. Which device Redis would drop is a
   * property of `CoordinatedPresenceStore` and is proved against a deadline
   * keeping double in its own suite; what only this layer can show is that the
   * handler asks for the withdrawal at all, and for the right device.
   */
  forget(input: PresenceDeviceInput): Promise<void> {
    this.forgets.push(input);
    return this.#delegate.forget(input);
  }

  list(groupId: string): Promise<readonly PresenceSnapshot[]> {
    return this.#delegate.list(groupId);
  }
}

function revokeRequest(
  groupId: string,
  deviceId: string,
  requestId: string,
): syncV1.RevokeDeviceRequest {
  return create(syncV1.RevokeDeviceRequestSchema, {
    context: { requestId },
    groupId: { value: groupId },
    deviceId: { value: deviceId },
  });
}

/** A second revocable member, so a suite can revoke twice without repeating itself. */
async function pairAnalyst(
  service: Partial<ServiceImpl<typeof SyncService>>,
  groupId: string,
  ownerContext: HandlerContext,
  publicKey: string,
): Promise<string> {
  const grant = await service.createPairingCode?.(
    create(syncV1.CreatePairingCodeRequestSchema, {
      groupId: { value: groupId },
      role: syncV1.DeviceRole.EDITOR,
    }),
    ownerContext,
  );
  const paired = await service.pairDevice?.(
    create(syncV1.PairDeviceRequestSchema, {
      pairingCode: grant?.pairingCode?.code ?? '',
      deviceName: 'Second analyst',
      publicKey,
      platform: 'windows',
      applicationVersion: '0.1.0',
    }),
    handlerContext(''),
  );
  const deviceId = paired?.device?.id?.value;
  if (deviceId === undefined) throw new Error('Expected the paired device to have an id.');
  return deviceId;
}

/** The group's log, as a client replaying it from the beginning would read it. */
async function logEvents(
  events: InMemoryRealtimeEventStore,
  groupId: string,
): Promise<readonly syncV1.GroupEvent[]> {
  const replayed = await events.replay({ groupId, afterSequence: 0n, limit: 512 });
  return replayed.events;
}

/** How many events the group's log holds, counted through the replay a client would read. */
async function logLength(events: InMemoryRealtimeEventStore, groupId: string): Promise<number> {
  return (await logEvents(events, groupId)).length;
}

/**
 * The handler surface these methods actually touch: one request header and an
 * abort signal. Building a full `HandlerContext` would assert nothing more.
 */
function handlerContext(authorization: string, signal?: AbortSignal): HandlerContext {
  const headers = new Headers();
  if (authorization.length > 0) headers.set('authorization', authorization);
  return {
    requestHeader: headers,
    signal: signal ?? new AbortController().signal,
  } as unknown as HandlerContext;
}
