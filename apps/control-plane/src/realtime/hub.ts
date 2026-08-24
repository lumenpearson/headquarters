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
  readonly #listenersByGroup = new Map<string, Map<string, (event: syncV1.GroupEvent) => void>>();

  constructor(options: RealtimeHubOptions = {}) {
    this.#store = options.store ?? new InMemoryRealtimeEventStore();
    this.#replayLimit = options.replayLimit ?? defaultRealtimeReplayLimit;
  }

  async publish(publication: GroupEventPublication): Promise<syncV1.GroupEvent> {
    const event = await this.#store.append(publication);
    for (const deliver of this.#listenersByGroup.get(publication.groupId)?.values() ?? []) {
      deliver(event);
    }
    return event;
  }

  /**
   * Fans out an event that is already durable.
   *
   * A publication that went through the store's authorized path has been
   * written and numbered already; re-publishing it here would append a second
   * copy. This is the seam that lets an RPC own the write and still reach the
   * sockets.
   */
  deliver(groupId: string, event: syncV1.GroupEvent): void {
    for (const send of this.#listenersByGroup.get(groupId)?.values() ?? []) send(event);
  }

  /**
   * Subscribes and replays, in that order.
   *
   * The listener is registered *before* the store is read, because reading it
   * is now I/O: a subscriber registered afterwards would silently miss every
   * event published while the replay was in flight, and the loss would look
   * exactly like a client that reconnected a moment too late. While the replay
   * runs, live events are buffered rather than sent, so the client still sees
   * one ascending order; the cursor then drops anything the replay had already
   * covered, so an event that lands in both is delivered once.
   */
  async subscribe(input: RealtimeSubscriptionInput): Promise<() => void> {
    const connectionId = input.connectionId ?? randomUUID();
    const buffered: syncV1.GroupEvent[] = [];
    let replaying = true;
    const unsubscribe = this.register(input.groupId, connectionId, (event) => {
      if (replaying) buffered.push(event);
      else input.send(groupEventFrame(event));
    });

    input.send(readyFrame(connectionId, input.afterSequence));
    try {
      const replay = await this.#store.replay({
        groupId: input.groupId,
        afterSequence: input.afterSequence,
        limit: this.#replayLimit,
      });
      const earliest = replay.earliestSequence;
      if (earliest !== undefined && input.afterSequence < earliest - 1n) {
        input.send(resyncFrame(input.groupId, input.afterSequence, earliest));
      } else {
        let cursor = input.afterSequence;
        for (const event of replay.events) {
          input.send(groupEventFrame(event));
          cursor = event.sequence;
        }
        for (const event of buffered) {
          if (event.sequence > cursor) input.send(groupEventFrame(event));
        }
      }
    } catch (error: unknown) {
      unsubscribe();
      throw error;
    } finally {
      replaying = false;
      buffered.length = 0;
    }

    return unsubscribe;
  }

  private register(
    groupId: string,
    connectionId: string,
    deliver: (event: syncV1.GroupEvent) => void,
  ): () => void {
    const listeners = this.#listenersByGroup.get(groupId) ?? new Map();
    listeners.set(connectionId, deliver);
    this.#listenersByGroup.set(groupId, listeners);
    return () => {
      const current = this.#listenersByGroup.get(groupId);
      current?.delete(connectionId);
      if (current?.size === 0) this.#listenersByGroup.delete(groupId);
    };
  }
}

function resyncFrame(
  groupId: string,
  requestedAfterSequence: bigint,
  earliestAvailableSequence: bigint,
): realtimeV1.RealtimeServerFrame {
  return create(realtimeV1.RealtimeServerFrameSchema, {
    payload: {
      case: 'resyncRequired',
      value: {
        groupId: { value: groupId },
        requestedAfterSequence,
        earliestAvailableSequence,
        reason: 'retained event history no longer covers the requested sequence',
      },
    },
  });
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
