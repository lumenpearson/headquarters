import { create } from '@bufbuild/protobuf';
import { Code, type HandlerContext } from '@connectrpc/connect';
import { syncV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import { InMemoryRealtimeEventStore } from '../realtime/eventStore.js';
import { RealtimeHub } from '../realtime/hub.js';

import { InMemoryPresenceStore } from './presence-store.js';
import { PairedDeviceRuntime } from './runtime.js';
import { createPairedDeviceSyncService } from './service.js';

/**
 * Offline proofs for the parts of the service layer the wire suite cannot
 * isolate: what a method does when its collaborator was never supplied, and
 * whether the streaming bridge drops an event that arrives between two yields.
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

describe('SyncService group event stream', () => {
  it('delivers an event published while the consumer was between yields', async () => {
    const { service, hub, token, groupId } = await authenticatedService();
    const stream = service.watchGroup?.(
      create(syncV1.WatchGroupRequestSchema, { groupId: { value: groupId }, afterSequence: 0n }),
      handlerContext(`Bearer ${token}`),
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
    const { service, hub, token, groupId } = await authenticatedService();
    const abort = new AbortController();
    const stream = service.watchGroup?.(
      create(syncV1.WatchGroupRequestSchema, { groupId: { value: groupId }, afterSequence: 0n }),
      handlerContext(`Bearer ${token}`, abort.signal),
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
  const hub = new RealtimeHub({ store: new InMemoryRealtimeEventStore() });
  const service = createPairedDeviceSyncService({
    runtime,
    verifyBootstrapSecret: () => true,
    presence: new InMemoryPresenceStore(),
    hub,
  });
  return {
    service,
    hub,
    token: created.session.accessToken,
    groupId: created.group.id,
  };
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
