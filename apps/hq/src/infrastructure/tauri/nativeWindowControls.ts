import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * The three window commands a custom title bar has to own once the native frame
 * is switched off (R24).
 *
 * `decorations: false` removes the system's minimize, maximize and close along
 * with the frame, so a shell that drew its own bar and stopped there would leave
 * an operator with a window they could only close from the taskbar.
 * `core:window:default` covers the readers -- `isMaximized` among them -- and no
 * mutator at all, which is why `capabilities/default.json` names
 * `allow-minimize`, `allow-toggle-maximize` and `allow-close` explicitly. It
 * also names `allow-start-dragging`, which is what the injected handler behind
 * `data-tauri-drag-region` calls. It named `allow-set-decorations` as well until
 * the display windows got a bar of their own: the frame is decided at creation,
 * in `tauri.conf.json` for `control` and in `managed_windows.rs` for the nine,
 * and a grant no caller spends is privilege the shell does not need.
 *
 * The capability covers `control` and the `screen-*` labels alike, so these are
 * the same four commands whether the bar drawn over them is the shell's or a
 * display window's.
 *
 * Every function is guarded by `isTauri()` and is a no-op on the web build, so
 * the same bar renders in a browser with controls that answer a click by doing
 * nothing rather than by throwing. `isWindowMaximized` answers `false` there:
 * a browser tab is not a maximized window, and the restore glyph would be a
 * promise the button cannot keep.
 */
export async function minimizeWindow(): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().close();
}

export async function isWindowMaximized(): Promise<boolean> {
  if (!isTauri()) return false;
  return getCurrentWindow().isMaximized();
}
