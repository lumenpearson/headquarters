import type { BridgeEvent } from '@gremuchaya/config';

type Wake = () => void;

export class BridgeEventHub {
  readonly #subscribers = new Set<(event: BridgeEvent) => void>();

  publish(event: BridgeEvent): void {
    for (const subscriber of this.#subscribers) subscriber(event);
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
    this.#subscribers.add(subscriber);
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (!signal.aborted) {
        const event = queue.shift();
        if (event !== undefined) {
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (signal.aborted) notify();
        });
      }
    } finally {
      signal.removeEventListener('abort', abort);
      this.#subscribers.delete(subscriber);
    }
  }
}
