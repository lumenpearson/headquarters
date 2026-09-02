import { describe, expect, it } from 'vitest';

import {
  InProcessFanoutBus,
  decodeGroupEventNotification,
  encodeGroupEventNotification,
  type GroupEventNotification,
} from './fanout.js';

const notification: GroupEventNotification = {
  groupId: 'group-01',
  sequence: 9_007_199_254_740_995n,
  originId: 'process-a',
};

describe('group event notification codec', () => {
  it('carries the sequence as text so a bigint survives the round trip', () => {
    const encoded = encodeGroupEventNotification(notification);

    // 2^53 + 3: a double would round it, and the hub would then replay from a
    // sequence the log never allocated.
    expect(encoded.s).toBe('9007199254740995');
    expect(decodeGroupEventNotification(encoded)).toEqual(notification);
  });

  it('reads the same announcement whether the client deserialized it or not', () => {
    const encoded = encodeGroupEventNotification(notification);

    expect(decodeGroupEventNotification(JSON.stringify(encoded))).toEqual(notification);
  });

  it('carries a group, a sequence and an origin, and nothing else', () => {
    // The property that keeps document deltas, presence records and session
    // commands out of Redis: whatever the hub announces, this is all of it.
    expect(Object.keys(encodeGroupEventNotification(notification)).sort()).toEqual(['g', 'o', 's']);
  });

  it.each([
    ['a message from another product on the channel', { hello: 'world' }],
    ['a truncated envelope', { g: 'group-01', o: 'process-a' }],
    ['a sequence that is not a number', { g: 'group-01', s: '12x', o: 'process-a' }],
    ['a negative sequence', { g: 'group-01', s: '-1', o: 'process-a' }],
    ['an empty group', { g: '', s: '1', o: 'process-a' }],
    ['an unattributed announcement', { g: 'group-01', s: '1', o: '' }],
    ['text that is not JSON', 'not json at all'],
    ['nothing', null],
  ])('drops %s rather than throwing', (_case, value) => {
    expect(decodeGroupEventNotification(value)).toBeUndefined();
  });
});

describe('in-process fanout bus', () => {
  it('delivers an announcement to the announcer too, as PUBLISH does', async () => {
    const bus = new InProcessFanoutBus();
    const first = bus.join('process-a');
    const second = bus.join('process-b');
    const seenByFirst: GroupEventNotification[] = [];
    const seenBySecond: GroupEventNotification[] = [];
    await first.listen((value) => seenByFirst.push(value));
    await second.listen((value) => seenBySecond.push(value));

    await first.announce({ groupId: 'group-01', sequence: 4n, originId: first.originId });

    // Redis has no idea which subscriber published; dropping the echo is the
    // hub's job, and a bus that hid it here would leave that filter unproven.
    expect(seenByFirst).toHaveLength(1);
    expect(seenBySecond).toHaveLength(1);
  });

  it('stops delivering to a released participant', async () => {
    const bus = new InProcessFanoutBus();
    const first = bus.join('process-a');
    const second = bus.join('process-b');
    const seenBySecond: GroupEventNotification[] = [];
    const release = await second.listen((value) => seenBySecond.push(value));

    await release();
    await first.announce({ groupId: 'group-01', sequence: 1n, originId: first.originId });

    expect(seenBySecond).toEqual([]);
  });
});
