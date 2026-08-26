import type { ScreenBusListener, ScreenBusPayload, ScreenBusPort } from '@gremuchaya/domain';

import {
  createScreenBusMessage,
  isScreenBusMessage,
  SeenScreenBusIds,
} from '@/infrastructure/tauri/screenBusEnvelope';

const channelName = 'gremuchaya-hq-screen-bus-v1';
const storageKey = '__gremuchaya_screen_bus_v1__';

export class BrowserScreenBus implements ScreenBusPort {
  readonly #senderId = crypto.randomUUID();
  readonly #listeners = new Set<ScreenBusListener>();
  readonly #seen = new SeenScreenBusIds();
  readonly #channel: BroadcastChannel | null;

  constructor() {
    this.#channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(channelName);
    this.#channel?.addEventListener('message', this.#handleChannelMessage);
    window.addEventListener('storage', this.#handleStorageMessage);
  }

  publish(payload: ScreenBusPayload): void {
    const message = createScreenBusMessage(this.#senderId, payload);
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
    this.#seen.clear();
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

  /*
   * The seen-id set is the defect ADR 0001 recorded against this adapter, and
   * it is fixed here rather than only in the new Tauri adapter: `publish` sends
   * over both `BroadcastChannel` and `localStorage`, so a peer window with both
   * transports live dispatched every message twice and ran every cue twice.
   * Adding the set to `TauriScreenBus` alone would have left the transport the
   * web build actually runs on with the duplicate.
   */
  #dispatch(value: unknown): void {
    if (!isScreenBusMessage(value) || value.senderId === this.#senderId) return;
    if (!this.#seen.accept(value.id)) return;
    for (const listener of this.#listeners) listener(value);
  }
}
