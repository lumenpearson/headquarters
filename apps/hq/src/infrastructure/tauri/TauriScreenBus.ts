import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ScreenBusListener, ScreenBusPayload, ScreenBusPort } from '@gremuchaya/domain';

import { createScreenBusMessage, isScreenBusMessage, SeenScreenBusIds } from './screenBusEnvelope';

/**
 * One event name for the whole bus, versioned by the envelope rather than by
 * the name: `screenBusProtocolVersion` already gates what a listener accepts,
 * and a second name would let two protocol versions coexist unnoticed.
 */
export const tauriScreenBusEventName = 'hq:screen-bus';

/**
 * The screen bus over Tauri events -- the transport ADR 0001 designed the port
 * for, and the one the desktop build had no implementation of: `BrowserScreenBus`
 * was the only adapter in the repository, so managed screen windows talked to
 * the control window over `BroadcastChannel` inside a native shell that already
 * had a process-wide event bus.
 *
 * `core:event:default` in `src-tauri/capabilities/default.json` already grants
 * listen/unlisten/emit to the `control`, `screen-*`, `wall-*` and `scene-*`
 * windows, so this adapter needs no capability change.
 */
export class TauriScreenBus implements ScreenBusPort {
  readonly #senderId = crypto.randomUUID();
  readonly #listeners = new Set<ScreenBusListener>();
  readonly #seen = new SeenScreenBusIds();
  readonly #ready: Promise<void>;
  #unlisten: UnlistenFn | null = null;
  #closed = false;

  constructor() {
    this.#ready = listen<unknown>(tauriScreenBusEventName, (event) => {
      this.#dispatch(event.payload);
    })
      .then((unlisten) => {
        // `close()` can win the race against the native registration; without
        // this the window would keep receiving cues after the runtime tore the
        // controller down.
        if (this.#closed) unlisten();
        else this.#unlisten = unlisten;
      })
      .catch(() => {
        // A window without the event permission gets a bus that publishes and
        // never receives, rather than a boot failure. The publish half still
        // reaches the other windows.
      });
  }

  /**
   * Resolves once the native subscription is registered (or has failed).
   *
   * Not part of `ScreenBusPort`: the runtime never needs to wait, because a
   * message that arrives before the listener is live would have been missed by
   * a not-yet-mounted window anyway. Tests need it to know when an emit can be
   * expected to land.
   */
  get ready(): Promise<void> {
    return this.#ready;
  }

  publish(payload: ScreenBusPayload): void {
    if (this.#closed) return;
    const message = createScreenBusMessage(this.#senderId, payload);
    // Tauri delivers an emit to every webview including the emitting one, so
    // this adapter always sees its own message come back. The sender-id check
    // in `#dispatch` drops it; claiming the id here as well means a message
    // that somehow arrives with a foreign sender id is still dispatched once.
    this.#seen.accept(message.id);
    void emit(tauriScreenBusEventName, message).catch(() => {
      // A failed emit is a dropped cue, not a crashed operator station. The
      // operator store stays authoritative and the next cue re-sends state.
    });
  }

  subscribe(listener: ScreenBusListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    this.#unlisten?.();
    this.#unlisten = null;
    this.#listeners.clear();
    this.#seen.clear();
  }

  #dispatch(value: unknown): void {
    if (this.#closed) return;
    if (!isScreenBusMessage(value) || value.senderId === this.#senderId) return;
    if (!this.#seen.accept(value.id)) return;
    for (const listener of this.#listeners) listener(value);
  }
}
