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
  readonly port: ControlPlanePort;
  readonly groupId: string;
  readonly deviceId: string;
}

/**
 * The group channel, assembled from the two transports that serve it.
 *
 * Publication is a unary RPC over binary gRPC-Web; delivery is the realtime
 * socket. Nothing here decides which of them a caller wanted, because a caller
 * wants both and always has: `PublishDocumentDelta` returns a sequence and the
 * event carrying it arrives on the socket, including to the publisher itself.
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
  readonly #port: ControlPlanePort;
  readonly #listeners = new Set<(event: GroupEventEnvelope) => void>();
  #appliedSequence = 0n;

  constructor(options: ControlPlaneGroupChannelOptions) {
    this.#port = options.port;
    this.groupId = options.groupId;
    this.deviceId = options.deviceId;
  }

  publishDocumentDelta(publication: DocumentDeltaPublication): Promise<DocumentDeltaReceipt> {
    return this.#port.publishDocumentDelta(publication);
  }

  publishSessionCommand(publication: SessionCommandPublication): Promise<GroupSessionCommand> {
    return this.#port.publishSessionCommand(publication);
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
