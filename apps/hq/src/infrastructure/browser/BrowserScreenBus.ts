import {
  screenBusProtocolVersion,
  type ScreenBusListener,
  type ScreenBusMessage,
  type ScreenBusPayload,
  type ScreenBusPort,
} from '@gremuchaya/domain';

const channelName = 'gremuchaya-hq-screen-bus-v1';
const storageKey = '__gremuchaya_screen_bus_v1__';

export class BrowserScreenBus implements ScreenBusPort {
  readonly #senderId = crypto.randomUUID();
  readonly #listeners = new Set<ScreenBusListener>();
  readonly #channel: BroadcastChannel | null;

  constructor() {
    this.#channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(channelName);
    this.#channel?.addEventListener('message', this.#handleChannelMessage);
    window.addEventListener('storage', this.#handleStorageMessage);
  }

  publish(payload: ScreenBusPayload): void {
    const message: ScreenBusMessage = {
      protocol: screenBusProtocolVersion,
      id: crypto.randomUUID(),
      issuedAt: Date.now(),
      senderId: this.#senderId,
      payload,
    };
    this.#channel?.postMessage(message);
    try {
      localStorage.setItem(storageKey, JSON.stringify(message));
      localStorage.removeItem(storageKey);
    } catch {
      // BroadcastChannel remains the primary transport when storage is unavailable.
    }
  }

  subscribe(listener: ScreenBusListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#channel?.removeEventListener('message', this.#handleChannelMessage);
    this.#channel?.close();
    window.removeEventListener('storage', this.#handleStorageMessage);
    this.#listeners.clear();
  }

  readonly #handleChannelMessage = (event: MessageEvent<unknown>): void => {
    this.#dispatch(event.data);
  };

  readonly #handleStorageMessage = (event: StorageEvent): void => {
    if (event.key !== storageKey || event.newValue === null) return;
    try {
      this.#dispatch(JSON.parse(event.newValue));
    } catch {
      // Malformed messages from unrelated scripts are ignored.
    }
  };

  #dispatch(value: unknown): void {
    if (!isScreenBusMessage(value) || value.senderId === this.#senderId) return;
    for (const listener of this.#listeners) listener(value);
  }
}

function isScreenBusMessage(value: unknown): value is ScreenBusMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    protocol?: unknown;
    id?: unknown;
    senderId?: unknown;
    payload?: unknown;
  };
  return (
    candidate.protocol === screenBusProtocolVersion &&
    typeof candidate.id === 'string' &&
    typeof candidate.senderId === 'string' &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null
  );
}
