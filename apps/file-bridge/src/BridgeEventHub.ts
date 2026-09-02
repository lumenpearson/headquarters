import type { BridgeEvent } from '@gremuchaya/config';

type Wake = () => void;

interface Subscription {
  readonly deliver: (event: BridgeEvent) => void;
  readonly wake: Wake;
}

export class BridgeEventHub {
  readonly #subscribers = new Set<Subscription>();
  #closed = false;

  publish(event: BridgeEvent): void {
    for (const subscriber of this.#subscribers) subscriber.deliver(event);
  }

  /**
   * Ends every open Watch stream and refuses new ones.
   *
   * A `Watch` response is unfinished by construction: the generator parks on the
   * next event until the client goes away. `http.Server.close()` waits for every
   * unfinished response, so without this the bridge could only shut down once
   * its clients happened to disconnect first — a screen left open would hold the
   * process. Waking each subscription with the closed flag set makes the
   * handler's `for await` unwind, which ends the response normally with the
   * events already delivered, rather than cutting the socket underneath it.
   */
  close(): void {
    this.#closed = true;
    for (const subscriber of [...this.#subscribers]) subscriber.wake();
  }

  /**
   * How many Watch streams are currently attached.
   *
   * The hub keeps no history, so a caller has no other way to tell an admitted
   * subscription from one that has not been registered yet, and an abandoned
   * stream that failed to unregister looks exactly like a live one from the
   * outside. Exposing the count is what lets a test wait for the subscription
   * to exist before it triggers an event — and prove the generator's `finally`
   * released it after the client went away, rather than assuming it did.
   */
  subscriberCount(): number {
    return this.#subscribers.size;
  }

  async *subscribe(
    mountIds: readonly string[],
    signal: AbortSignal,
  ): AsyncGenerator<BridgeEvent, void> {
    const filter = new Set(mountIds);
    const queue: BridgeEvent[] = [];
    let wake: Wake | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const subscriber = (event: BridgeEvent) => {
      if (filter.size === 0 || filter.has(event.mountId)) {
        queue.push(event);
        notify();
      }
    };
    const abort = () => notify();
    const subscription: Subscription = { deliver: subscriber, wake: notify };
    this.#subscribers.add(subscription);
    signal.addEventListener('abort', abort, { once: true });
    try {
      // The closed flag is checked with the abort signal, so a shutdown that
      // lands while the generator is parked ends the stream on the same wake-up
      // an event would have used. Queued events are dropped on purpose: the
      // bridge is going away, and a client that reconnects lists the mount
      // rather than resuming a stream that no longer has a publisher.
      while (!signal.aborted && !this.#closed) {
        const event = queue.shift();
        if (event !== undefined) {
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          // Re-checked after parking: both an abort and a shutdown can land in
          // the window between the loop condition and the assignment above, and
          // neither would have anything left to wake.
          if (signal.aborted || this.#closed) notify();
        });
      }
    } finally {
      signal.removeEventListener('abort', abort);
      this.#subscribers.delete(subscription);
    }
  }
}
