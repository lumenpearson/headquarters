import { randomUUID } from 'node:crypto';

/**
 * The cross-process carrier for realtime fan-out.
 *
 * Two control-plane processes already agree about *what* happened: every group
 * event is appended to `sync_events` in one statement that allocates its
 * sequence, so the log is the same for both. What was missing is that neither
 * learned the other had written to it, so a socket admitted by process A never
 * saw a publication made through process B until the client reconnected and
 * replayed. This port is that missing announcement and nothing more.
 *
 * ## Why a notification and not the event
 *
 * A carrier could ship the encoded `GroupEvent` itself and save the second
 * process a read. It does not, for four reasons, in order of weight:
 *
 * 1. **The store is already the ordering authority.** The hub's resume path
 *    reads `RealtimeEventStore.replay`, and the retention edge is decided in
 *    `replayDecision.ts` for every transport at once. A carried payload would
 *    be a second source of events with its own ordering and its own retention,
 *    and a deployment serving both would have two answers to "what comes after
 *    N". Replaying through the store keeps exactly one.
 * 2. **Nothing durable is on the wire.** A notification is a group id, a
 *    sequence and the id of the process that wrote it. No document delta, no
 *    presence record, no session command and no credential leaves PostgreSQL,
 *    so the carrier cannot become a second place group content is stored, and a
 *    Redis with no encryption at rest holds nothing worth reading.
 * 3. **An announcement cannot arrive before the write it announces.** It is
 *    sent after the append has returned, and the receiver reads the log rather
 *    than trusting the message, so a duplicate, a reorder or a replayed
 *    announcement can only cause a redundant read — never a delivery of an
 *    event that is not durable.
 * 4. **Size.** `PUBLISH` over an HTTP REST endpoint is a poor place for a
 *    multi-megabyte CRDT delta, and the delta ceiling is enforced on the RPC,
 *    not here.
 *
 * The cost is one extra `replay` per notification per process holding an
 * audience for the group, which is the same query a reconnect already runs.
 */
export interface GroupEventNotification {
  readonly groupId: string;
  /** The highest sequence the announcing process had appended for the group. */
  readonly sequence: bigint;
  /**
   * Identifies the announcing process. A hub ignores its own announcements: it
   * dispatched those events to its sockets before it announced them, and
   * reading them back would be work with no subscriber to show for it.
   */
  readonly originId: string;
}

export interface RealtimeFanout {
  /** This process's identity, as it appears in `originId`. */
  readonly originId: string;
  /**
   * Announces that the group log advanced. Implementations may reject; the hub
   * treats a rejection as a loss of liveness only, because the event is durable
   * before this is called.
   */
  announce(notification: GroupEventNotification): Promise<void>;
  /**
   * Starts delivering other processes' announcements and resolves with a
   * release. Called once per hub, before the first socket is registered.
   */
  listen(handler: (notification: GroupEventNotification) => void): Promise<() => Promise<void>>;
}

/**
 * The wire form.
 *
 * `sequence` travels as a decimal string because JSON has no bigint and a
 * group's sequence is a PostgreSQL `bigint`: rounding one through a double at
 * 2^53 would make a notification announce a sequence that never existed. The
 * keys are short because every publication carries them.
 */
export interface EncodedGroupEventNotification {
  readonly g: string;
  readonly s: string;
  readonly o: string;
}

export function encodeGroupEventNotification(
  notification: GroupEventNotification,
): EncodedGroupEventNotification {
  return {
    g: notification.groupId,
    s: notification.sequence.toString(),
    o: notification.originId,
  };
}

/**
 * Reads a notification off the carrier, or answers `undefined`.
 *
 * Anything on a shared channel is untrusted input: a message from a different
 * product sharing the Redis database, a half-written value, or a future version
 * of this envelope. Every failure is the same silent `undefined` rather than a
 * throw, because a malformed announcement must not be able to tear down a hub's
 * subscription for every well-formed one behind it.
 *
 * A string is parsed once. The Upstash client serializes a published object to
 * JSON and deserializes it again by default, so a message normally arrives as
 * an object; a client configured without automatic deserialization hands over
 * the JSON text instead, and both spellings mean the same announcement.
 */
export function decodeGroupEventNotification(value: unknown): GroupEventNotification | undefined {
  const decoded = typeof value === 'string' ? parseJson(value) : value;
  if (typeof decoded !== 'object' || decoded === null) return undefined;
  const { g, s, o } = decoded as Partial<EncodedGroupEventNotification>;
  if (typeof g !== 'string' || g.length === 0) return undefined;
  if (typeof o !== 'string' || o.length === 0) return undefined;
  if (typeof s !== 'string' || !/^\d+$/u.test(s)) return undefined;
  return { groupId: g, sequence: BigInt(s), originId: o };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * A process-local carrier, for the same reason `InMemoryRealtimeEventStore`
 * exists next to the durable one: the semantics of cross-process fan-out — who
 * ignores their own echo, what a second hub does with a notification, what
 * happens when the announcement outruns the log — have to be provable without a
 * Redis in the room. Two hubs joined to one bus behave exactly as two processes
 * sharing a channel do, and a live Redis then proves only the transport.
 *
 * It is never the production carrier: `createConfiguredPairedDeviceLifecycle`
 * builds the Redis one or none at all.
 */
export class InProcessFanoutBus {
  readonly #handlers = new Map<string, (notification: GroupEventNotification) => void>();

  join(originId: string = randomUUID()): RealtimeFanout {
    const handlers = this.#handlers;
    return {
      originId,
      announce: (notification) => {
        // Delivered to every handler including the announcer's own, because
        // that is what `PUBLISH` does: a Redis channel has no idea which
        // subscriber sent the message. Dropping the echo is the hub's job, and
        // a bus that quietly did it here would leave that filter unproven.
        //
        // Synchronously, before the promise settles: a test that awaits the
        // publication has then already reached every hub's handler, and only
        // the store read behind it remains to be awaited.
        for (const handler of [...handlers.values()]) handler(notification);
        return Promise.resolve();
      },
      listen: (handler) => {
        handlers.set(originId, handler);
        return Promise.resolve(() => {
          handlers.delete(originId);
          return Promise.resolve();
        });
      },
    };
  }
}
