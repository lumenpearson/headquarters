import type { ControlPlanePort } from '@/application/sync/controlPlanePort';
import type {
  DocumentDeltaPublication,
  DocumentDeltaReceipt,
  GroupChannel,
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
 * `deliver` is the seam the socket writes into. The channel is built first and
 * the client is given `channel.deliver` as its `onEvent`, so a subscriber that
 * registers before the socket is open still hears everything after it.
 */
export class ControlPlaneGroupChannel implements GroupChannel {
  readonly groupId: string;
  readonly deviceId: string;
  readonly #port: ControlPlanePort;
  readonly #listeners = new Set<(event: GroupEventEnvelope) => void>();

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
   * Fans one event out to every subscriber.
   *
   * The listener set is copied first, in the idiom `ControlPlaneRuntime` uses
   * for its own: a subscriber that unsubscribes while being notified -- an
   * effect cleanup running inside a React update -- must not shorten the list
   * the loop is walking.
   */
  readonly deliver = (event: GroupEventEnvelope): void => {
    for (const listener of [...this.#listeners]) listener(event);
  };

  close(): void {
    this.#listeners.clear();
  }
}
