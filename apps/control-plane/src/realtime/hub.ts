import { randomUUID } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import { realtimeV1 } from '@gremuchaya/protocol';
import type { syncV1 } from '@gremuchaya/protocol';
import { timestampNow } from '@bufbuild/protobuf/wkt';

const protocolVersion = 'gremuchaya.realtime.v1';
const defaultHistoryLimit = 512;

export interface RealtimeSubscriptionInput {
  readonly groupId: string;
  readonly afterSequence: bigint;
  readonly send: (frame: realtimeV1.RealtimeServerFrame) => void;
  readonly connectionId?: string;
}

export interface GroupEventPublication {
  readonly groupId: string;
  readonly event: syncV1.GroupEvent;
}

export class RealtimeHub {
  #historyByGroup = new Map<string, syncV1.GroupEvent[]>();
  #listenersByGroup = new Map<
    string,
    Map<string, (frame: realtimeV1.RealtimeServerFrame) => void>
  >();

  constructor(private readonly historyLimit = defaultHistoryLimit) {
    if (!Number.isInteger(historyLimit) || historyLimit < 1) {
      throw new Error('Realtime history limit must be a positive integer');
    }
  }

  publish({ groupId, event }: GroupEventPublication): void {
    const history = this.#historyByGroup.get(groupId) ?? [];
    const previous = history.at(-1);
    if (previous !== undefined && event.sequence <= previous.sequence) {
      throw new Error(`Realtime sequence must advance for group ${groupId}`);
    }
    history.push(event);
    if (history.length > this.historyLimit) history.splice(0, history.length - this.historyLimit);
    this.#historyByGroup.set(groupId, history);

    const frame = groupEventFrame(event);
    for (const send of this.#listenersByGroup.get(groupId)?.values() ?? []) send(frame);
  }

  subscribe(input: RealtimeSubscriptionInput): () => void {
    const connectionId = input.connectionId ?? randomUUID();
    const history = this.#historyByGroup.get(input.groupId) ?? [];
    const earliest = history[0]?.sequence;
    input.send(readyFrame(connectionId, input.afterSequence));

    if (earliest !== undefined && input.afterSequence < earliest - 1n) {
      input.send(
        create(realtimeV1.RealtimeServerFrameSchema, {
          payload: {
            case: 'resyncRequired',
            value: {
              groupId: { value: input.groupId },
              requestedAfterSequence: input.afterSequence,
              earliestAvailableSequence: earliest,
              reason: 'retained event history no longer covers the requested sequence',
            },
          },
        }),
      );
    } else {
      for (const event of history) {
        if (event.sequence > input.afterSequence) input.send(groupEventFrame(event));
      }
    }

    const listeners = this.#listenersByGroup.get(input.groupId) ?? new Map();
    listeners.set(connectionId, input.send);
    this.#listenersByGroup.set(input.groupId, listeners);

    return () => {
      const current = this.#listenersByGroup.get(input.groupId);
      current?.delete(connectionId);
      if (current?.size === 0) this.#listenersByGroup.delete(input.groupId);
    };
  }
}

function readyFrame(
  connectionId: string,
  resumedFromSequence: bigint,
): realtimeV1.RealtimeServerFrame {
  return create(realtimeV1.RealtimeServerFrameSchema, {
    payload: {
      case: 'ready',
      value: {
        connectionId,
        resumedFromSequence,
        serverTime: timestampNow(),
        protocolVersion,
      },
    },
  });
}

function groupEventFrame(event: syncV1.GroupEvent): realtimeV1.RealtimeServerFrame {
  return create(realtimeV1.RealtimeServerFrameSchema, {
    payload: { case: 'groupEvent', value: { event } },
  });
}
