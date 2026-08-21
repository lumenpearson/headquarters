import type { BridgeEvent } from '@gremuchaya/config';

type Wake = () => void;

export class BridgeEventHub {
  readonly #subscribers = new Set<(event: BridgeEvent) => void>();

  publish(event: BridgeEvent): void {
    for (const subscriber of this.#subscribers) subscriber(event);
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
