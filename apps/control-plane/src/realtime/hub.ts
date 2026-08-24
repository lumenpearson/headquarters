import { randomUUID } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import { realtimeV1 } from '@gremuchaya/protocol';
import type { syncV1 } from '@gremuchaya/protocol';
import { timestampNow } from '@bufbuild/protobuf/wkt';

import {
  InMemoryRealtimeEventStore,
  defaultRealtimeReplayLimit,
  type GroupEventDraft,
  type RealtimeEventStore,
} from './eventStore.js';

const protocolVersion = 'gremuchaya.realtime.v1';

export interface RealtimeSubscriptionInput {
  readonly groupId: string;
  readonly afterSequence: bigint;
  readonly send: (frame: realtimeV1.RealtimeServerFrame) => void;
  readonly connectionId?: string;
}

/**
 * What a caller asks the hub to publish. It carries no sequence: ordering is a
 * server-side fact allocated by the event store, and letting a caller choose it
 * is what made the previous in-process history impossible to restore after a
 * restart.
 */
export type GroupEventPublication = GroupEventDraft;

export interface RealtimeHubOptions {
  readonly store?: RealtimeEventStore;
  readonly replayLimit?: number;
}

/**
 * Fans group events out to subscribed sockets and answers a resume from the
 * event store.
 *
 * The hub holds exactly one piece of state — the live listener set — because a
 * listener is a property of this process and nothing else. Everything a
 * reconnecting client can ask for comes from the store, so a restarted control
 * plane answers a resume with the same events the one before it did.
 */
export class RealtimeHub {
  readonly #store: RealtimeEventStore;
  readonly #replayLimit: number;
  readonly #listenersByGroup = new Map<
    string,
    Map<string, (frame: realtimeV1.RealtimeServerFrame) => void>
  >();

  constructor(options: RealtimeHubOptions = {}) {
    this.#store = options.store ?? new InMemoryRealtimeEventStore();
    this.#replayLimit = options.replayLimit ?? defaultRealtimeReplayLimit;
  }

  async publish(publication: GroupEventPublication): Promise<syncV1.GroupEvent> {
    const event = await this.#store.append(publication);
    const frame = groupEventFrame(event);
    for (const send of this.#listenersByGroup.get(publication.groupId)?.values() ?? []) send(frame);
    return event;
  }

  async subscribe(input: RealtimeSubscriptionInput): Promise<() => void> {
    const connectionId = input.connectionId ?? randomUUID();
    const replay = await this.#store.replay({
      groupId: input.groupId,
      afterSequence: input.afterSequence,
      limit: this.#replayLimit,
    });
    input.send(readyFrame(connectionId, input.afterSequence));

    const earliest = replay.earliestSequence;
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
      for (const event of replay.events) input.send(groupEventFrame(event));
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
