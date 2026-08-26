import type { ControlPlanePort } from '@/application/sync/controlPlanePort';
import type {
  DocumentDeltaPublication,
  DocumentDeltaReceipt,
  GroupChannel,
  GroupEventCursor,
  GroupEventEnvelope,
  GroupSessionCommand,
  SessionCommandPublication,
} from '@/application/sync/groupChannel';

export interface ControlPlaneGroupChannelOptions {
  /**
   * Which link a publication goes out on, asked at the moment of publishing.
   *
   * A function and not a port, because a device may hold more than one link to
   * one group and the answer changes while the channel lives: the near plane on
   * the set's LAN while it is carrying, the cloud plane while it is not, and the
   * near plane again when it returns. Asking at publication time is what makes
   * that switch cost nothing -- no rebuild, no reconnect, no second channel.
   */
  readonly selectPort: () => ControlPlanePort;
  readonly groupId: string;
  readonly deviceId: string;
}

/**
 * The group channel, assembled from the two transports that serve it.
 *
 * Publication is a unary RPC over binary gRPC-Web; delivery is the realtime
 * socket, the polling feed, or both at once. Nothing here decides which of them
 * a caller wanted, because a caller wants both and always has:
 * `PublishDocumentDelta` returns a sequence and the event carrying it arrives
 * on every feed, including to the publisher itself.
 *
 * Publication goes to exactly one link, chosen by `selectPort` at the moment of
 * the call. Sending the same mutation to both planes would be safe -- the
 * receipt in the shared database answers the repeat instead of appending a
 * second event -- but it would spend a metered invocation to learn nothing.
 *
 * `deliver` is the seam a transport writes into. The channel is built first and
 * the client is given `channel.deliver` as its `onEvent`, so a subscriber that
 * registers before the socket is open still hears everything after it.
 *
 * The channel, not the transport, owns the applied-sequence cursor. A group has
 * one order -- the database allocates every sequence under a row lock, so the
 * numbers are the commit order and no two transports can disagree about it --
 * and one order deserves one cursor. Holding it here rather than in the socket
 * is what lets a second transport feed the same group: a poller reading the
 * durable log and a socket pushing from the hub both hand their events to
 * `deliver`, and whichever arrives second is dropped.
 *
 * That matters beyond tidiness, because the subscribers are not uniformly
 * idempotent. `GroupPlaybackSyncTransport` keeps a per-device sequence and
 * would survive a duplicate; `GroupLiveEditTransport` would apply the patch
 * twice and write a second history entry for one change.
 */
export class ControlPlaneGroupChannel implements GroupChannel, GroupEventCursor {
  readonly groupId: string;
  readonly deviceId: string;
  readonly #selectPort: () => ControlPlanePort;
  readonly #listeners = new Set<(event: GroupEventEnvelope) => void>();
  #appliedSequence = 0n;

  constructor(options: ControlPlaneGroupChannelOptions) {
    this.#selectPort = options.selectPort;
    this.groupId = options.groupId;
    this.deviceId = options.deviceId;
  }

  publishDocumentDelta(publication: DocumentDeltaPublication): Promise<DocumentDeltaReceipt> {
    return this.#selectPort().publishDocumentDelta(publication);
  }

  publishSessionCommand(publication: SessionCommandPublication): Promise<GroupSessionCommand> {
    return this.#selectPort().publishSessionCommand(publication);
  }

  subscribe(listener: (event: GroupEventEnvelope) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Fans one event out to every subscriber, newest-sequence-wins.
   *
   * An event at or below the last applied sequence is dropped rather than
   * delivered. A resume replays from `after_sequence` while the hub flushes
   * whatever was published during the replay, and a second transport reading
   * the same durable log carries the same events again -- both paths end here,
   * and both are answered the same way.
   *
   * The listener set is copied first, in the idiom `ControlPlaneRuntime` uses
   * for its own: a subscriber that unsubscribes while being notified -- an
   * effect cleanup running inside a React update -- must not shorten the list
   * the loop is walking.
   */
  readonly deliver = (event: GroupEventEnvelope): void => {
    if (!this.accept(event.sequence)) return;
    for (const listener of [...this.#listeners]) listener(event);
  };

  accept(sequence: bigint): boolean {
    if (sequence <= this.#appliedSequence) return false;
    this.#appliedSequence = sequence;
    return true;
  }

  appliedSequence(): bigint {
    return this.#appliedSequence;
  }

  rewindTo(sequence: bigint): void {
    this.#appliedSequence = sequence < 0n ? 0n : sequence;
  }

  close(): void {
    this.#listeners.clear();
  }
}
