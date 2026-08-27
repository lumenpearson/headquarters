import { create } from '@bufbuild/protobuf';
import { Code, type HandlerContext } from '@connectrpc/connect';
import { syncV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import { InMemoryRealtimeEventStore } from '../realtime/eventStore.js';
import { RealtimeHub } from '../realtime/hub.js';

import {
  InMemoryPresenceStore,
  type PresenceSnapshot,
  type PresenceStore,
  type RecordPresenceInput,
  type RenewPresenceInput,
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

async function authenticatedService() {
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
    presence,
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
  readonly renewals: RenewPresenceInput[] = [];
  readonly #delegate = new InMemoryPresenceStore();

  record(input: RecordPresenceInput): Promise<PresenceSnapshot> {
    return this.#delegate.record(input);
  }

  renew(input: RenewPresenceInput): Promise<void> {
    this.renewals.push(input);
    return Promise.resolve();
  }

  list(groupId: string): Promise<readonly PresenceSnapshot[]> {
    return this.#delegate.list(groupId);
  }
}

/** How many events the group's log holds, counted through the replay a client would read. */
async function logLength(events: InMemoryRealtimeEventStore, groupId: string): Promise<number> {
  const replayed = await events.replay({ groupId, afterSequence: 0n, limit: 512 });
  return replayed.events.length;
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
