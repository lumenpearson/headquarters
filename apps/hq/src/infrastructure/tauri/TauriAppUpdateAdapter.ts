import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { AppUpdatePort, CheckedUpdate } from '@/application/update/appUpdatePort';

/**
 * Matches the event `apps/hq/src-tauri/src/app_updater.rs::run_download` emits after
 * every chunk it writes (and once before the first one, at whatever offset a resume
 * started from).
 */
const progressEventName = 'hq:update-download-progress';

interface ProgressPayload {
  readonly received: number;
  readonly total: number | null;
}

function isProgressPayload(value: unknown): value is ProgressPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.received === 'number' &&
    (record.total === null || typeof record.total === 'number')
  );
}

/**
 * The desktop `AppUpdatePort`: `@tauri-apps/plugin-updater`'s own `check()` for finding an
 * update, and the five custom commands in `app_updater.rs` for everything after -- that
 * module's doc explains why the plugin's own `download()`/`install()` are not used here.
 *
 * `check()` hands back an `Update` resource with a `rid`; this adapter passes that `rid`
 * to `update_download_start`, which takes ownership of the resource on the Rust side
 * (`ResourceTable::take`), so it is spent exactly once. `pause`/`resume`/`cancel`/`install`
 * afterwards need no `rid` at all -- the Rust side already knows which download is active.
 *
 * Progress arrives as a Tauri event, not a return value, because the same stream keeps
 * flowing across a pause/resume cycle regardless of which command last touched the
 * download (see the port's doc comment on `startDownload`). One listener is registered
 * the first time it is needed and kept until `close()` -- mirroring `TauriScreenBus`'s
 * own constructor/`close()` pattern for the same reason: without an explicit teardown,
 * the native `listen()` subscription (and the closure it holds) outlives whatever created
 * this adapter for as long as the process runs.
 *
 * `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-autostart` are imported dynamically,
 * inside the methods that need them, rather than at module scope: `createTauriAppUpdateAdapter`
 * is reachable from every route (`RuntimeProvider` -> `appUpdateRuntime` -> here), including
 * the web build, and a static import bundles a package into a route's chunk whether or not
 * `isTauri()` ever turns out true. The core `@tauri-apps/api` imports above stay static --
 * `createScreenBus.ts` makes the same choice for `TauriScreenBus`, and unlike the two plugins
 * they are small enough, and used widely enough, that splitting them buys nothing.
 */
export class TauriAppUpdateAdapter implements AppUpdatePort {
  #rid: number | null = null;
  #onProgress: ((received: number, total: number | null) => void) | null = null;
  #unlistenProgress: Promise<UnlistenFn> | null = null;
  #unlisten: UnlistenFn | null = null;
  #closed = false;

  available(): boolean {
    return true;
  }

  async checkForUpdate(): Promise<CheckedUpdate | null> {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) {
      this.#rid = null;
      return null;
    }
    this.#rid = update.rid;
    return update.body === undefined
      ? { version: update.version }
      : { version: update.version, notes: update.body };
  }

  async startDownload(onProgress: (received: number, total: number | null) => void): Promise<void> {
    if (this.#rid === null) {
      throw new Error('startDownload was called before checkForUpdate found an update.');
    }
    this.#onProgress = onProgress;
    await this.#ensureProgressListener();
    const rid = this.#rid;
    // Consumed on the Rust side the moment this call lands (`ResourceTable::take`), so
    // this adapter must never try to start a second download from the same checked
    // `Update`; `resume` is the only continuation path after this point.
    this.#rid = null;
    await invoke('update_download_start', { rid });
  }

  async resume(): Promise<void> {
    await this.#ensureProgressListener();
    await invoke('update_download_resume');
  }

  async pause(): Promise<void> {
    await invoke('update_download_pause');
  }

  async cancel(): Promise<void> {
    await invoke('update_download_cancel');
  }

  async install(): Promise<void> {
    await invoke('update_install');
  }

  async isAutostartEnabled(): Promise<boolean> {
    const { isEnabled } = await import('@tauri-apps/plugin-autostart');
    return isEnabled();
  }

  async setAutostart(enabled: boolean): Promise<void> {
    const { disable, enable } = await import('@tauri-apps/plugin-autostart');
    if (enabled) {
      await enable();
    } else {
      await disable();
    }
  }

  /**
   * Detaches the native progress listener, best-effort. Idempotent and safe to call
   * whether or not `#ensureProgressListener` ever ran: `#unlisten` (and, if the
   * registration was still in flight, the `#closed` check inside `#ensureProgressListener`'s
   * `.then()`) is what actually calls the resolved `UnlistenFn` -- there is no other path
   * in this class that does. Not part of `AppUpdatePort`: `createTauriAppUpdateAdapter`
   * already returns the concrete class, so a caller with a lifecycle to tear down (a
   * composition root, a test) can call this directly without the port needing to know
   * this adapter has one.
   */
  close(): void {
    this.#closed = true;
    this.#unlisten?.();
    this.#unlisten = null;
    this.#unlistenProgress = null;
    this.#onProgress = null;
  }

  async #ensureProgressListener(): Promise<void> {
    this.#unlistenProgress ??= listen<unknown>(progressEventName, (event) => {
      if (!isProgressPayload(event.payload)) return;
      this.#onProgress?.(event.payload.received, event.payload.total);
    }).then((unlisten) => {
      // `close()` can win the race against the native registration; without this the
      // listener would keep delivering progress events to a caller that already tore
      // this adapter down, for as long as the process runs.
      if (this.#closed) unlisten();
      else this.#unlisten = unlisten;
      return unlisten;
    });
    await this.#unlistenProgress;
  }
}

/**
 * `null` on the web build -- there is no browser equivalent of a native updater or an
 * autostart registry entry, so `AppUpdateService` gets an honest absence to fold into its
 * own `'unavailable'` state rather than an adapter that would fail every call.
 */
export function createTauriAppUpdateAdapter(): TauriAppUpdateAdapter | null {
  return isTauri() ? new TauriAppUpdateAdapter() : null;
}
