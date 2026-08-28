import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Shows the window this document runs in, once its content is ready.
 *
 * The control window is declared `visible: false` in `tauri.conf.json`, so a
 * cold start never paints a blank or half-loaded page: the frontend calls this
 * after the document's `load` event, with the startup overlay already drawn.
 * The nine `screen-*` windows are created visible, and `show` on a visible
 * window is a no-op, so no label check is needed here.
 *
 * `capabilities/default.json` grants `allow-show` and `allow-set-focus` for
 * exactly this call. On the web build there is no window to reveal and the
 * function does nothing, same as the rest of this adapter family. The Rust
 * side keeps a ten-second fallback in `lib.rs` so a frontend that dies before
 * reaching this call still gets a window rather than an invisible process.
 */
export async function revealWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const window = getCurrentWindow();
    await window.show();
    await window.setFocus();
  } catch {
    // Called fire-and-forget during boot, so a refusal here must not surface
    // as an unhandled rejection; the ten-second fallback in `lib.rs` is what
    // shows the window when this call cannot.
  }
}
