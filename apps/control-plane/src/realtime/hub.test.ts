import { syncV1 } from '@gremuchaya/protocol';
import type { realtimeV1 } from '@gremuchaya/protocol';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryRealtimeEventStore, type RealtimeEventStore } from './eventStore.js';
import { InProcessFanoutBus, type GroupEventNotification, type RealtimeFanout } from './fanout.js';
import { RealtimeHub } from './hub.js';

describe('realtime subscription hub', () => {
  it('replays missed events after reconnect and continues with live events', async () => {
    const hub = new RealtimeHub();
    await hub.publish(publication());
    await hub.publish(publication());

    const received: realtimeV1.RealtimeServerFrame[] = [];
    const unsubscribe = await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 1n,
      connectionId: 'connection-01',
      send: (frame) => received.push(frame),
    });
    await hub.publish(publication());
    unsubscribe();
    await hub.publish(publication());

    expect(received.map((frame) => frame.payload.case)).toEqual([
      'ready',
      'groupEvent',
      'groupEvent',
    ]);
    expect(sequenceOf(received[1])).toBe(2n);
    expect(sequenceOf(received[2])).toBe(3n);
  });

  it('requires a snapshot when the bounded replay history has expired', async () => {
    const hub = new RealtimeHub({ store: new InMemoryRealtimeEventStore(2) });
    await hub.publish(publication());
    await hub.publish(publication());
    await hub.publish(publication());

    const received: realtimeV1.RealtimeServerFrame[] = [];
    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: (frame) => received.push(frame),
    });

    expect(received.map((frame) => frame.payload.case)).toEqual(['ready', 'resyncRequired']);
    expect(received[1]?.payload).toMatchObject({
      case: 'resyncRequired',
      value: { requestedAfterSequence: 0n, earliestAvailableSequence: 2n },
    });
  });

  it('allocates the sequence itself so no caller can reuse or skip one', async () => {
    const hub = new RealtimeHub();

    const first = await hub.publish(publication());
    const second = await hub.publish(publication());
    const otherGroup = await hub.publish({ ...publication(), groupId: 'group-02' });

    expect([first.sequence, second.sequence]).toEqual([1n, 2n]);
    expect(otherGroup.sequence).toBe(1n);
  });

  it('delivers a live event to every subscriber of the same group and to no other group', async () => {
    const hub = new RealtimeHub();
    const subscribed: realtimeV1.RealtimeServerFrame[] = [];
    const otherGroup: realtimeV1.RealtimeServerFrame[] = [];
    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: (frame) => subscribed.push(frame),
    });
    await hub.subscribe({
      groupId: 'group-02',
      afterSequence: 0n,
      connectionId: 'connection-02',
      send: (frame) => otherGroup.push(frame),
    });

    await hub.publish(publication());

    expect(subscribed.map((frame) => frame.payload.case)).toEqual(['ready', 'groupEvent']);
    expect(otherGroup.map((frame) => frame.payload.case)).toEqual(['ready']);
  });
});

describe('realtime subscription handoff', () => {
  it('loses no event published while the replay is still in flight', async () => {
    // The store is held open mid-replay so a publish lands squarely inside the
    // window a subscriber that registered after its replay would have missed.
    let releaseReplay = () => {};
    const held = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const backing = new InMemoryRealtimeEventStore();
    const store: RealtimeEventStore = {
      append: (draft) => backing.append(draft),
      replay: async (input) => {
        await held;
        return backing.replay(input);
      },
    };
    const hub = new RealtimeHub({ store });
    await hub.publish(publication());

    const received: bigint[] = [];
    const subscribing = hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: (frame) => {
        if (frame.payload.case === 'groupEvent' && frame.payload.value.event !== undefined) {
          received.push(frame.payload.value.event.sequence);
        }
      },
    });

    await hub.publish(publication());
    releaseReplay();
    await subscribing;

    expect(received).toEqual([1n, 2n]);
  });

  it('delivers an event carried by both the replay and the buffer exactly once', async () => {
    let releaseReplay = () => {};
    const held = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const backing = new InMemoryRealtimeEventStore();
    const store: RealtimeEventStore = {
      append: (draft) => backing.append(draft),
      // Reading only after the publish is what puts the same event in both
      // places: the store has it, and the live listener buffered it too.
      replay: async (input) => {
        await held;
        return backing.replay(input);
      },
    };
    const hub = new RealtimeHub({ store });

    const received: bigint[] = [];
    const subscribing = hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: (frame) => {
        if (frame.payload.case === 'groupEvent' && frame.payload.value.event !== undefined) {
          received.push(frame.payload.value.event.sequence);
        }
      },
    });

    await hub.publish(publication());
    releaseReplay();
    await subscribing;

    expect(received).toEqual([1n]);
  });
});

/**
 * The behaviour `docs/release/known-limitations.md` recorded as missing: two
 * processes sharing a log, neither pushing the other's events to its own
 * sockets. Two hubs over one store and one bus are exactly two processes over
 * one database and one Redis channel, so everything about *who is told what*
 * is decided here; a live Redis proves only the transport underneath.
 */
describe('cross-process realtime fan-out', () => {
  it('delivers an event another process published to this process’s sockets', async () => {
    const { first, second } = twoProcesses();
    const received: bigint[] = [];
    await first.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: collectSequences(received),
    });

    await second.publish(publication());
    await first.whenFanoutIdle();

    expect(received).toEqual([1n]);
  });

  it('announces what an RPC handler delivered, not only what it published itself', async () => {
    // `SyncService.publishDocumentDelta` owns its own append and then calls
    // `deliver`, so this — not `publish` — is the path every client publication
    // takes. A carrier wired only into `publish` would leave the RPC surface
    // exactly as single-process as it was.
    const store = new InMemoryRealtimeEventStore();
    const bus = new InProcessFanoutBus();
    const writer = new RealtimeHub({ store, fanout: bus.join('process-a') });
    const reader = new RealtimeHub({ store, fanout: bus.join('process-b') });
    const received: bigint[] = [];
    await reader.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: collectSequences(received),
    });

    const event = await store.append(publication());
    writer.deliver('group-01', event);
    await reader.whenFanoutIdle();

    expect(received).toEqual([1n]);
  });

  it('reads nothing back for its own publication', async () => {
    const { replay, hubs } = twoCountedProcesses();
    const received: bigint[] = [];
    await hubs.first.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: collectSequences(received),
    });
    replay.mockClear();

    await hubs.first.publish(publication());
    await hubs.first.whenFanoutIdle();

    // `PUBLISH` reaches the publisher's own subscription too. The socket had
    // the event before the announcement went out, so answering the echo would
    // be a query with nothing to deliver — and it must not deliver twice.
    expect(received).toEqual([1n]);
    expect(replay).not.toHaveBeenCalled();
  });

  it('reads nothing back for its own publication while a subscription is still replaying', async () => {
    // The one moment the echo is not already harmless: a connection whose own
    // replay is in flight has not moved its cursor yet, so an unfiltered echo
    // would put a second read on the database for an event this process had
    // already handed to that connection's buffer.
    let releaseReplay = () => {};
    const held = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let replayEntered = () => {};
    const entered = new Promise<void>((resolve) => {
      replayEntered = resolve;
    });
    const backing = new InMemoryRealtimeEventStore();
    const replay = vi.fn(async (input: Parameters<RealtimeEventStore['replay']>[0]) => {
      replayEntered();
      await held;
      return backing.replay(input);
    });
    const store: RealtimeEventStore = { append: (draft) => backing.append(draft), replay };
    const bus = new InProcessFanoutBus();
    const hub = new RealtimeHub({ store, fanout: bus.join('process-a') });

    const received: bigint[] = [];
    const subscribing = hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: collectSequences(received),
    });
    // The connection is registered and its replay is in flight: exactly the
    // window in which its cursor has not caught up with what it has been given.
    await entered;
    await hub.publish(publication());
    await hub.whenFanoutIdle();
    releaseReplay();
    await subscribing;

    expect(replay).toHaveBeenCalledTimes(1);
    expect(received).toEqual([1n]);
  });

  it('reads nothing for a group this process holds no socket for', async () => {
    const { replay, hubs } = twoCountedProcesses();
    await hubs.first.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: () => {},
    });
    replay.mockClear();

    await hubs.second.publish({ ...publication(), groupId: 'group-02' });
    await hubs.first.whenFanoutIdle();

    // A single deployment-wide channel is only affordable because the filter is
    // free: an announcement for a group with no local audience costs no query.
    expect(replay).not.toHaveBeenCalled();
  });

  it('replays from the furthest-behind socket and gives neither a duplicate', async () => {
    const store = new InMemoryRealtimeEventStore();
    const { hub, notify } = hubWithScriptedCarrier(store);
    const behind: bigint[] = [];
    const current: bigint[] = [];
    // Subscribed against an empty log and never told about what follows, so its
    // cursor stays at zero while the sibling writes.
    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-behind',
      send: collectSequences(behind),
    });
    await store.append(publication());
    await store.append(publication());
    // Subscribed after those two, so its own replay carries it to 2.
    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-current',
      send: collectSequences(current),
    });
    await store.append(publication());

    notify({ groupId: 'group-01', sequence: 3n, originId: 'process-b' });
    await hub.whenFanoutIdle();

    // One read served both, and it started at the lower of the two cursors:
    // reading from the higher would have stranded the connection at zero.
    // The connection already at 2 drops what that read repeats.
    expect(behind).toEqual([1n, 2n, 3n]);
    expect(current).toEqual([1n, 2n, 3n]);
  });

  it('keeps one read per group in flight however many announcements arrive', async () => {
    const backing = new InMemoryRealtimeEventStore();
    let inFlight = 0;
    let concurrent = 0;
    const store: RealtimeEventStore = {
      append: (draft) => backing.append(draft),
      replay: async (input) => {
        inFlight += 1;
        concurrent = Math.max(concurrent, inFlight);
        await Promise.resolve();
        const replay = await backing.replay(input);
        inFlight -= 1;
        return replay;
      },
    };
    const { hub, notify } = hubWithScriptedCarrier(store);
    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: () => {},
    });
    for (let index = 0; index < 3; index += 1) await store.append(publication());

    notify({ groupId: 'group-01', sequence: 1n, originId: 'process-b' });
    notify({ groupId: 'group-01', sequence: 2n, originId: 'process-b' });
    notify({ groupId: 'group-01', sequence: 3n, originId: 'process-b' });
    await hub.whenFanoutIdle();

    // Announcements arrive as fast as a sibling publishes. Unchained, a busy
    // group would put one read on the database per publication per process,
    // and their results would land in whatever order they finished.
    expect(concurrent).toBe(1);
  });

  it('collapses simultaneous announcements into one ascending, duplicate-free stream', async () => {
    const { first, second } = twoProcesses();
    const received: bigint[] = [];
    await first.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: collectSequences(received),
    });

    await Promise.all([
      second.publish(publication()),
      second.publish(publication()),
      second.publish(publication()),
    ]);
    await first.whenFanoutIdle();

    // Three announcements, each answered by a read that overlaps the last.
    // Without the per-group chain and the per-connection cursor the socket
    // would see 1, 1, 2, 1, 2, 3.
    expect(received).toEqual([1n, 2n, 3n]);
  });

  it('delivers an announcement that lands during a subscription’s own replay exactly once', async () => {
    let releaseReplay = () => {};
    const held = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const backing = new InMemoryRealtimeEventStore();
    let holding = true;
    const store: RealtimeEventStore = {
      append: (draft) => backing.append(draft),
      replay: async (input) => {
        if (holding) await held;
        return backing.replay(input);
      },
    };
    const bus = new InProcessFanoutBus();
    const first = new RealtimeHub({ store, fanout: bus.join('process-a') });
    const second = new RealtimeHub({ store, fanout: bus.join('process-b') });

    const received: bigint[] = [];
    const subscribing = first.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: collectSequences(received),
    });
    // Published by the sibling while this connection's own replay is still in
    // flight: the event reaches the buffer through the fan-out and the store
    // through the replay, and the flush has to pick one of them.
    await second.publish(publication());
    holding = false;
    releaseReplay();
    await subscribing;
    await first.whenFanoutIdle();

    expect(received).toEqual([1n]);
  });

  it('tells a socket to resync when a sibling outran the retention window, and tells it once', async () => {
    const store = new InMemoryRealtimeEventStore(2);
    const { hub, notify } = hubWithScriptedCarrier(store);
    const frames: realtimeV1.RealtimeServerFrame[] = [];
    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: (frame) => frames.push(frame),
    });
    // Written by the sibling process directly: this hub learns of them only
    // through the announcement, by which time the first is already pruned.
    for (let index = 0; index < 3; index += 1) await store.append(publication());

    notify({ groupId: 'group-01', sequence: 3n, originId: 'process-b' });
    await hub.whenFanoutIdle();
    notify({ groupId: 'group-01', sequence: 3n, originId: 'process-b' });
    await hub.whenFanoutIdle();

    expect(frames.map((frame) => frame.payload.case)).toEqual(['ready', 'resyncRequired']);
    expect(frames[1]?.payload).toMatchObject({
      case: 'resyncRequired',
      value: { requestedAfterSequence: 0n, earliestAvailableSequence: 2n },
    });
  });

  it('does not let one socket falling off the retention edge cost the others the event', async () => {
    const store = new InMemoryRealtimeEventStore(2);
    const { hub, notify } = hubWithScriptedCarrier(store);
    const stranded: realtimeV1.RealtimeServerFrame[] = [];
    const current: bigint[] = [];
    // Subscribed against an empty log and never told about what follows.
    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-stranded',
      send: (frame) => stranded.push(frame),
    });
    for (let index = 0; index < 3; index += 1) await store.append(publication());
    // A client reconnecting with the cursor it already holds.
    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 3n,
      connectionId: 'connection-current',
      send: collectSequences(current),
    });
    await store.append(publication());

    notify({ groupId: 'group-01', sequence: 4n, originId: 'process-b' });
    await hub.whenFanoutIdle();

    // The retention verdict is reached from the lowest cursor in the group, so
    // treating it as the group's verdict would silence a connection that had
    // lost nothing.
    expect(stranded.map((frame) => frame.payload.case)).toEqual(['ready', 'resyncRequired']);
    expect(current).toEqual([4n]);
  });

  it('publishes even when the carrier refuses, and reports the failure once', async () => {
    const failures: unknown[] = [];
    const hub = new RealtimeHub({
      fanout: {
        originId: 'process-a',
        announce: () => Promise.reject(new Error('carrier unreachable')),
        listen: () => Promise.resolve(() => Promise.resolve()),
      },
      onFanoutError: (error) => failures.push(error),
    });
    const received: bigint[] = [];
    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: collectSequences(received),
    });

    const event = await hub.publish(publication());

    // The append already happened, so an unreachable carrier costs the other
    // process's clients their live delivery and nothing else.
    expect(event.sequence).toBe(1n);
    expect(received).toEqual([1n]);
    expect(failures).toHaveLength(1);
  });

  it('retries a carrier that failed to connect on the next subscription', async () => {
    let attempts = 0;
    const failures: unknown[] = [];
    const store = new InMemoryRealtimeEventStore();
    let notify: ((notification: GroupEventNotification) => void) | undefined;
    const hub = new RealtimeHub({
      store,
      fanout: {
        originId: 'process-a',
        announce: () => Promise.resolve(),
        listen: (handler) => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error('subscribe refused'));
          notify = handler;
          return Promise.resolve(() => Promise.resolve());
        },
      },
      onFanoutError: (error) => failures.push(error),
    });

    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: () => {},
    });
    const received: bigint[] = [];
    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-02',
      send: collectSequences(received),
    });
    await store.append(publication());
    notify?.({ groupId: 'group-01', sequence: 1n, originId: 'process-b' });
    await hub.whenFanoutIdle();

    // A control plane that started while Redis was down must not stay
    // single-process for the rest of its life.
    expect(attempts).toBe(2);
    expect(failures).toHaveLength(1);
    expect(received).toEqual([1n]);
  });

  it('releases the carrier only after the replays it started have finished', async () => {
    let released = false;
    const store = new InMemoryRealtimeEventStore();
    const { hub, notify } = hubWithScriptedCarrier(store, () => {
      released = true;
    });
    const received: bigint[] = [];
    await hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: collectSequences(received),
    });
    await store.append(publication());

    notify({ groupId: 'group-01', sequence: 1n, originId: 'process-b' });
    await hub.close();

    expect(received).toEqual([1n]);
    expect(released).toBe(true);
  });
});

function twoProcesses(): { first: RealtimeHub; second: RealtimeHub } {
  const store = new InMemoryRealtimeEventStore();
  const bus = new InProcessFanoutBus();
  return {
    first: new RealtimeHub({ store, fanout: bus.join('process-a') }),
    second: new RealtimeHub({ store, fanout: bus.join('process-b') }),
  };
}

/** Two hubs over one store whose reads are counted, for the cases about cost. */
function twoCountedProcesses(): {
  store: RealtimeEventStore;
  replay: ReturnType<typeof vi.fn>;
  hubs: { first: RealtimeHub; second: RealtimeHub };
} {
  const backing = new InMemoryRealtimeEventStore();
  const replay = vi.fn(backing.replay.bind(backing));
  const store: RealtimeEventStore = { append: (draft) => backing.append(draft), replay };
  const bus = new InProcessFanoutBus();
  return {
    store,
    replay,
    hubs: {
      first: new RealtimeHub({ store, fanout: bus.join('process-a') }),
      second: new RealtimeHub({ store, fanout: bus.join('process-b') }),
    },
  };
}

/**
 * A hub whose carrier is driven by the test rather than by a sibling hub, for
 * the cases where the announcement has to arrive at a chosen moment.
 */
function hubWithScriptedCarrier(
  store: RealtimeEventStore,
  onRelease: () => void = () => {},
): { hub: RealtimeHub; notify: (notification: GroupEventNotification) => void } {
  let handler: ((notification: GroupEventNotification) => void) | undefined;
  const fanout: RealtimeFanout = {
    originId: 'process-a',
    announce: () => Promise.resolve(),
    listen: (incoming) => {
      handler = incoming;
      return Promise.resolve(() => {
        onRelease();
        return Promise.resolve();
      });
    },
  };
  const hub = new RealtimeHub({ store, fanout });
  return {
    hub,
    notify: (notification) => {
      if (handler === undefined) throw new Error('the hub never connected its carrier');
      handler(notification);
    },
  };
}

function collectSequences(into: bigint[]): (frame: realtimeV1.RealtimeServerFrame) => void {
  return (frame) => {
    if (frame.payload.case === 'groupEvent' && frame.payload.value.event !== undefined) {
      into.push(frame.payload.value.event.sequence);
    }
  };
}

function publication() {
  return { groupId: 'group-01', kind: syncV1.GroupEventKind.DOCUMENT_DELTA } as const;
}

function sequenceOf(frame: realtimeV1.RealtimeServerFrame | undefined): bigint | undefined {
  return frame?.payload.case === 'groupEvent' ? frame.payload.value.event?.sequence : undefined;
}
