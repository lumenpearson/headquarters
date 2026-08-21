import { create } from '@bufbuild/protobuf';
import { syncV1 } from '@gremuchaya/protocol';
import type { realtimeV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import { RealtimeHub } from './hub.js';

describe('realtime subscription hub', () => {
  it('replays missed events after reconnect and continues with live events', () => {
    const hub = new RealtimeHub();
    hub.publish({ groupId: 'group-01', event: event(1n) });
    hub.publish({ groupId: 'group-01', event: event(2n) });

    const received: realtimeV1.RealtimeServerFrame[] = [];
    const unsubscribe = hub.subscribe({
      groupId: 'group-01',
      afterSequence: 1n,
      connectionId: 'connection-01',
      send: (frame) => received.push(frame),
    });
    hub.publish({ groupId: 'group-01', event: event(3n) });
    unsubscribe();
    hub.publish({ groupId: 'group-01', event: event(4n) });

    expect(received.map((frame) => frame.payload.case)).toEqual([
      'ready',
      'groupEvent',
      'groupEvent',
    ]);
    expect(received[1].payload.value.event?.sequence).toBe(2n);
    expect(received[2].payload.value.event?.sequence).toBe(3n);
  });

  it('requires a snapshot when the bounded replay history has expired', () => {
    const hub = new RealtimeHub(2);
    hub.publish({ groupId: 'group-01', event: event(1n) });
    hub.publish({ groupId: 'group-01', event: event(2n) });
    hub.publish({ groupId: 'group-01', event: event(3n) });

    const received: realtimeV1.RealtimeServerFrame[] = [];
    hub.subscribe({
      groupId: 'group-01',
      afterSequence: 0n,
      connectionId: 'connection-01',
      send: (frame) => received.push(frame),
    });

    expect(received.map((frame) => frame.payload.case)).toEqual(['ready', 'resyncRequired']);
    expect(received[1].payload).toMatchObject({
      case: 'resyncRequired',
      value: { requestedAfterSequence: 0n, earliestAvailableSequence: 2n },
    });
  });

  it('rejects a duplicate or out-of-order group sequence', () => {
    const hub = new RealtimeHub();
    hub.publish({ groupId: 'group-01', event: event(2n) });

    expect(() => hub.publish({ groupId: 'group-01', event: event(2n) })).toThrow(
      'Realtime sequence must advance',
    );
  });
});

function event(sequence: bigint): syncV1.GroupEvent {
  return create(syncV1.GroupEventSchema, {
    sequence,
    kind: syncV1.GroupEventKind.DOCUMENT_DELTA,
  });
}
