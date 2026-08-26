import {
  screenBusProtocolVersion,
  type ScreenBusMessage,
  type ScreenBusPayload,
} from '@gremuchaya/domain';

/**
 * The envelope every screen-bus adapter puts on the wire.
 *
 * It was written inline in `BrowserScreenBus` and is now shared, because a
 * second adapter (`TauriScreenBus`) has to produce and accept byte-identical
 * envelopes: in the desktop build a control window can reach a screen window
 * over Tauri events while a browser tab opened against the same dev server
 * reaches it over `BroadcastChannel`, and a message that only one of them can
 * parse is a message the other silently drops.
 */
export function createScreenBusMessage(
  senderId: string,
  payload: ScreenBusPayload,
): ScreenBusMessage {
  return {
    protocol: screenBusProtocolVersion,
    id: crypto.randomUUID(),
    issuedAt: Date.now(),
    senderId,
    payload,
  };
}

/**
 * Accepts only what this protocol version defines.
 *
 * The bus is a trust boundary in both transports: `BroadcastChannel` and the
 * `storage` event carry anything another script on the origin posts, and a
 * Tauri event carries anything any webview in the process emits under the same
 * name. Nothing downstream re-validates, so a message that fails here is
 * dropped rather than narrowed.
 */
export function isScreenBusMessage(value: unknown): value is ScreenBusMessage {
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

/**
 * Remembers the message ids already dispatched, so the same message delivered
 * twice is acted on once.
 *
 * ADR 0001 records the defect this closes: `BrowserScreenBus.publish` sends
 * over `BroadcastChannel` *and* `localStorage`, so a peer window with both
 * transports live used to run every cue twice, because no adapter kept a
 * seen-id set. `TauriScreenBus` has the same exposure from a different
 * direction -- Tauri delivers an emit to every webview in the process,
 * including the one that emitted it -- so both adapters now hold one of these.
 *
 * Bounded on purpose. A shoot runs for hours and a cue-heavy scene publishes
 * continuously; an unbounded set would be a leak that only shows up on the
 * longest run of the day. The bound is far above any plausible in-flight
 * duplicate window, which is one delivery of one message.
 */
export class SeenScreenBusIds {
  readonly #limit: number;
  readonly #ids = new Set<string>();

  constructor(limit = 256) {
    this.#limit = Math.max(1, limit);
  }

  /** True the first time an id is offered, false for every repeat of it. */
  accept(id: string): boolean {
    if (this.#ids.has(id)) return false;
    this.#ids.add(id);
    if (this.#ids.size > this.#limit) {
      // `Set` iterates in insertion order, so the first entry is the oldest.
      for (const oldest of this.#ids) {
        this.#ids.delete(oldest);
        break;
      }
    }
    return true;
  }

  clear(): void {
    this.#ids.clear();
  }
}
