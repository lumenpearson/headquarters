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
import type { GroupEventNotification, RealtimeFanout } from './fanout.js';
import { decideReplay, resyncRequiredReason } from './replayDecision.js';

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
  /**
   * The cross-process carrier. Absent, the hub serves only what this process
   * published, which is the single-replica behaviour every deployment had
   * before one existed.
   */
  readonly fanout?: RealtimeFanout;
  /**
   * Where a carrier failure is reported. It is a liveness fault, never a
   * correctness one, so the default says so once and stays quiet.
   */
  readonly onFanoutError?: (error: unknown) => void;
}

/**
 * One subscribed socket, as the hub sees it.
 *
 * The cursor is the reason this is a record rather than a bare callback. A
 * cross-process notification is answered by reading the log, and the log holds
 * events this connection has already been sent — by its own resume, by a local
 * publication, or by an earlier notification. Every send goes through `offer`,
 * which drops anything at or below what this connection has already received,
 * so the same event reaching the socket by two routes is delivered once.
 */
interface GroupListener {
  /** Delivers an event unless this connection has already been sent one at least that far. */
  readonly offer: (event: syncV1.GroupEvent) => void;
  /** Sends a frame that is not a group event. Only `ResyncRequired` uses it. */
  readonly send: (frame: realtimeV1.RealtimeServerFrame) => void;
  /** The highest sequence this connection has been sent. */
  readonly sentThrough: () => bigint;
  /**
   * Moves the cursor forward without sending anything. Used only after a
   * `ResyncRequired`: below the new cursor the log is gone and the snapshot
   * owns the history, so continuing to offer a partial one would be worse than
   * offering none.
   */
  readonly skipTo: (sequence: bigint) => void;
}

/**
 * Fans group events out to subscribed sockets and answers a resume from the
 * event store.
 *
 * The listener set is a property of this process and nothing else. Everything a
 * reconnecting client can ask for comes from the store, so a restarted control
 * plane answers a resume with the same events the one before it did — and, when
 * a {@link RealtimeFanout} is configured, so does a *second* process: an
 * announcement from a sibling is answered by reading the same store, so a
 * replica no longer serves only what it wrote itself.
 */
export class RealtimeHub {
  readonly #store: RealtimeEventStore;
  readonly #replayLimit: number;
  readonly #listenersByGroup = new Map<string, Map<string, GroupListener>>();
  readonly #fanout: RealtimeFanout | undefined;
  readonly #onFanoutError: (error: unknown) => void;
  /** One chain per group, so two notifications cannot run two interleaving replays. */
  readonly #remoteDrains = new Map<string, Promise<void>>();
  #fanoutConnection: Promise<void> | undefined;
  #releaseFanout: (() => Promise<void>) | undefined;

  constructor(options: RealtimeHubOptions = {}) {
    this.#store = options.store ?? new InMemoryRealtimeEventStore();
    this.#replayLimit = options.replayLimit ?? defaultRealtimeReplayLimit;
    this.#fanout = options.fanout;
    this.#onFanoutError = options.onFanoutError ?? createDefaultFanoutReporter();
  }

  async publish(publication: GroupEventPublication): Promise<syncV1.GroupEvent> {
    const event = await this.#store.append(publication);
    this.dispatch(publication.groupId, event);
    // Awaited, unlike in `deliver`: this method already owns the append, so the
    // caller is waiting on durability anyway, and announcing inside that wait
    // keeps the order "durable, then local sockets, then siblings" observable.
    await this.announce(publication.groupId, event.sequence);
    return event;
  }

  /**
   * Fans out an event that is already durable.
   *
   * A publication that went through the store's authorized path has been
   * written and numbered already; re-publishing it here would append a second
   * copy. This is the seam that lets an RPC own the write and still reach the
   * sockets.
   *
   * The announcement is not awaited: this signature is synchronous because an
   * RPC handler calls it after its own transaction has committed, and a
   * carrier round trip must not be added to that handler's latency. Nothing is
   * lost if it fails — see {@link announce}.
   */
  deliver(groupId: string, event: syncV1.GroupEvent): void {
    this.dispatch(groupId, event);
    void this.announce(groupId, event.sequence);
  }

  /**
   * Releases the carrier subscription after the replays it started have run.
   *
   * Called by the realtime transport's own `close`, so a shutdown does not
   * leave an SSE stream open or a drain half-delivered.
   */
  async close(): Promise<void> {
    await this.whenFanoutIdle();
    const release = this.#releaseFanout;
    this.#releaseFanout = undefined;
    this.#fanoutConnection = undefined;
    if (release !== undefined) await release();
  }

  /**
   * Resolves once every cross-process replay this hub has started has finished.
   *
   * A notification arrives on a socket callback, so the read it triggers cannot
   * be awaited by whoever published it. Shutdown needs to wait for it, and so
   * does any test that wants to observe fan-out without polling.
   */
  async whenFanoutIdle(): Promise<void> {
    let pending = [...this.#remoteDrains.values()];
    while (pending.length > 0) {
      await Promise.all(pending);
      pending = [...this.#remoteDrains.values()];
    }
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
    let sentThrough = input.afterSequence;
    const listener: GroupListener = {
      offer: (event) => {
        // Ascending and once. While the replay is in flight the cursor is not
        // moved: what actually reaches the socket is decided by the flush
        // below, and advancing here would make it drop its own buffer.
        if (event.sequence <= sentThrough) return;
        if (replaying) {
          buffered.push(event);
          return;
        }
        sentThrough = event.sequence;
        input.send(groupEventFrame(event));
      },
      send: (frame) => input.send(frame),
      sentThrough: () => sentThrough,
      skipTo: (sequence) => {
        if (sequence > sentThrough) sentThrough = sequence;
      },
    };
    // Connected once per hub, and the first subscription is the moment: a
    // process with no sockets needs no stream open. It happens before the
    // registration rather than after so a carrier that refuses to connect
    // cannot leave a listener registered behind it — the announcements it
    // would have answered are covered by this connection's own replay either
    // way, because both run after this line.
    await this.connectFanout();
    const unsubscribe = this.register(input.groupId, connectionId, listener);

    input.send(readyFrame(connectionId, input.afterSequence));
    try {
      const replay = await this.#store.replay({
        groupId: input.groupId,
        afterSequence: input.afterSequence,
        limit: this.#replayLimit,
      });
      // The retention edge is decided in `replayDecision.ts`, not here: the
      // polling reader answers the same resume and has to reach the same
      // verdict, and one deployment serving both must not disagree with itself.
      const decision = decideReplay({
        afterSequence: input.afterSequence,
        earliestSequence: replay.earliestSequence,
      });
      if (decision.outcome === 'resync') {
        input.send(
          resyncFrame(input.groupId, input.afterSequence, decision.earliestAvailableSequence),
        );
      } else {
        for (const event of replay.events) {
          input.send(groupEventFrame(event));
          sentThrough = event.sequence;
        }
        // The buffer can hold the same event more than once now: a sibling's
        // announcement replayed into it while this replay was still in flight.
        // The strictly ascending cursor is what makes the flush idempotent.
        for (const event of buffered) {
          if (event.sequence > sentThrough) {
            sentThrough = event.sequence;
            input.send(groupEventFrame(event));
          }
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

  private register(groupId: string, connectionId: string, listener: GroupListener): () => void {
    const listeners = this.#listenersByGroup.get(groupId) ?? new Map<string, GroupListener>();
    listeners.set(connectionId, listener);
    this.#listenersByGroup.set(groupId, listeners);
    return () => {
      const current = this.#listenersByGroup.get(groupId);
      current?.delete(connectionId);
      if (current?.size === 0) this.#listenersByGroup.delete(groupId);
    };
  }

  private dispatch(groupId: string, event: syncV1.GroupEvent): void {
    for (const listener of this.#listenersByGroup.get(groupId)?.values() ?? []) {
      listener.offer(event);
    }
  }

  /**
   * Tells the other processes the group log advanced.
   *
   * It never rejects. The event is durable before this runs, so a carrier that
   * is unreachable, unconfigured or unsupported costs liveness only: the other
   * process's clients still receive the event on their next reconnect, through
   * the replay that answered them before any carrier existed.
   */
  private async announce(groupId: string, sequence: bigint): Promise<void> {
    const fanout = this.#fanout;
    if (fanout === undefined) return;
    try {
      await fanout.announce({ groupId, sequence, originId: fanout.originId });
    } catch (error: unknown) {
      this.#onFanoutError(error);
    }
  }

  /**
   * Connects the carrier once per hub, and lets a failed attempt be retried.
   *
   * The memo is cleared on failure rather than latching a dead carrier: a
   * control plane that started while Redis was down would otherwise stay
   * single-process for its whole life, and the next socket is the natural
   * moment to try again.
   */
  private connectFanout(): Promise<void> {
    const fanout = this.#fanout;
    if (fanout === undefined) return Promise.resolve();
    this.#fanoutConnection ??= fanout
      .listen((notification) => this.acceptRemote(notification))
      .then((release) => {
        this.#releaseFanout = release;
      })
      .catch((error: unknown) => {
        this.#fanoutConnection = undefined;
        this.#onFanoutError(error);
      });
    return this.#fanoutConnection;
  }

  /**
   * Queues the read a sibling's announcement asks for.
   *
   * `PUBLISH` reaches every subscriber of the channel including the publisher,
   * so this hub sees its own announcements too; those events went to the local
   * sockets before the announcement was sent, and reading them back would be a
   * query with nothing to deliver.
   */
  private acceptRemote(notification: GroupEventNotification): void {
    if (notification.originId === this.#fanout?.originId) return;
    const groupId = notification.groupId;
    const previous = this.#remoteDrains.get(groupId) ?? Promise.resolve();
    const next = previous
      .then(() => this.drainRemote(groupId, notification.sequence))
      .catch((error: unknown) => {
        this.#onFanoutError(error);
      });
    this.#remoteDrains.set(groupId, next);
    void next.then(() => {
      if (this.#remoteDrains.get(groupId) === next) this.#remoteDrains.delete(groupId);
    });
  }

  /**
   * Answers a sibling's announcement out of the shared log.
   *
   * The replay starts at the *lowest* cursor among this group's local sockets,
   * because that is the only point from which one read serves all of them; each
   * socket then drops what it has already been sent. Reading from the highest
   * would silently strand a connection that resumed further back.
   */
  private async drainRemote(groupId: string, announcedSequence: bigint): Promise<void> {
    // No audience in this process for that group: the log already holds the
    // event, and whoever subscribes later will replay it. `register` discards
    // the map when its last connection leaves rather than leaving an empty one,
    // so absence is the only shape "nobody is listening" takes.
    const listeners = this.#listenersByGroup.get(groupId);
    if (listeners === undefined) return;
    let cursor: bigint | undefined;
    for (const listener of listeners.values()) {
      const sent = listener.sentThrough();
      if (cursor === undefined || sent < cursor) cursor = sent;
    }
    if (cursor === undefined || announcedSequence <= cursor) return;

    const replay = await this.#store.replay({
      groupId,
      afterSequence: cursor,
      limit: this.#replayLimit,
    });
    // The same shared verdict the resume path uses: one deployment must not
    // tell a reconnecting client to take a snapshot and hand a connected one a
    // partial history it would mistake for a complete one.
    const decision = decideReplay({
      afterSequence: cursor,
      earliestSequence: replay.earliestSequence,
    });
    // Re-read: a socket may have closed while the store was being read, and the
    // map it belonged to is discarded rather than emptied.
    const current = this.#listenersByGroup.get(groupId);
    if (current === undefined) return;
    if (decision.outcome === 'resync') {
      for (const listener of current.values()) {
        if (listener.sentThrough() >= decision.earliestAvailableSequence - 1n) continue;
        listener.send(
          resyncFrame(groupId, listener.sentThrough(), decision.earliestAvailableSequence),
        );
        // Told once, not on every announcement that follows. The client's
        // answer to a resync is a snapshot and a fresh subscription, and until
        // it arrives this hub has nothing complete to send that connection.
        listener.skipTo(announcedSequence);
      }
    }
    // Not an `else`. The verdict was reached from the *lowest* cursor in the
    // group, so one connection falling off the retention edge must not cost the
    // others this announcement's events. A connection that was just told to
    // resync is now past all of them and drops them on its own.
    for (const event of replay.events) {
      for (const listener of current.values()) listener.offer(event);
    }
  }
}

/**
 * The default carrier-failure report: one line, once, with no detail.
 *
 * No detail, because a transport error from a coordination client can quote the
 * endpoint it was configured against, and deployment configuration does not
 * belong in this process's output. Once, because the failure mode that matters
 * is "the carrier stopped", and a per-publication line would bury it.
 */
function createDefaultFanoutReporter(): (error: unknown) => void {
  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    process.stderr.write(
      'realtime cross-process fan-out is degraded; clients resume through replay\n',
    );
  };
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
        reason: resyncRequiredReason,
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
