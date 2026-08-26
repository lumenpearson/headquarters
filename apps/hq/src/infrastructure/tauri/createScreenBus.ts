import { isTauri } from '@tauri-apps/api/core';
import type { ScreenBusPort } from '@gremuchaya/domain';

import { BrowserScreenBus } from '@/infrastructure/browser/BrowserScreenBus';

import { TauriScreenBus } from './TauriScreenBus';

/**
 * Picks the screen-bus transport for the shell this build is running in.
 *
 * Selection is by runtime, not by build target: `pnpm dev:hq` serves the same
 * bundle to a browser that has no Tauri IPC at all, and `isTauri()` is the only
 * thing that separates them. `BrowserScreenBus` stays the web transport
 * (ADR 0001 chose `BroadcastChannel` precisely so cue execution needs no
 * server), and the desktop shell now uses the process-wide event bus it always
 * had.
 */
export function createScreenBus(): ScreenBusPort {
  return isTauri() ? new TauriScreenBus() : new BrowserScreenBus();
}
