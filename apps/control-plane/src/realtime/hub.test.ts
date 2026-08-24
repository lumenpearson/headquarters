import { syncV1 } from '@gremuchaya/protocol';
import type { realtimeV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import { InMemoryRealtimeEventStore, type RealtimeEventStore } from './eventStore.js';
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

function publication() {
  return { groupId: 'group-01', kind: syncV1.GroupEventKind.DOCUMENT_DELTA } as const;
}

function sequenceOf(frame: realtimeV1.RealtimeServerFrame | undefined): bigint | undefined {
  return frame?.payload.case === 'groupEvent' ? frame.payload.value.event?.sequence : undefined;
}
