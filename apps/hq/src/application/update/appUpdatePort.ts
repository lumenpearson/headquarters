/**
 * The application-layer boundary for in-app updates and launch-on-login, implemented by
 * `TauriAppUpdateAdapter` on the desktop shell and by nothing on the web build -- there is
 * no browser equivalent of either capability, so a web session gets no adapter at all
 * rather than one that lies about being able to check, download or autostart. Callers read
 * that absence through `AppUpdateService`, which treats a `null` port as its own
 * `'unavailable'` state (the honest-absence pattern `nativeMediaGatewayStatus.ts` already
 * uses for the native media gateway).
 *
 * The update half is a check/download/install pipeline with pause and resume, backed by
 * `apps/hq/src-tauri/src/app_updater.rs`'s custom Range-request downloader rather than the
 * `@tauri-apps/plugin-updater` JS API's own `download()` (which has no way to pause --
 * see that module's doc for why). `startDownload`'s `onProgress` callback is registered
 * once and kept alive across a pause/resume cycle: `resume()` does not take a new one,
 * because the same continuous stream of progress events keeps arriving from the native
 * side regardless of which command last touched the download.
 */
export interface CheckedUpdate {
  readonly version: string;
  readonly notes?: string;
}

export interface AppUpdatePort {
  /** Whether this build has an adapter at all -- `false` on the web target. */
  available(): boolean;

  /** Resolves to the checked update, or `null` when the running version is current. */
  checkForUpdate(): Promise<CheckedUpdate | null>;

  /**
   * Begins (or, after a pause, continues) streaming the checked update's package.
   * `onProgress` is called with the bytes received so far and the total, when the server
   * declared one (`null` otherwise -- an indeterminate transfer, not a zero-length one).
   * Resolves once the transfer reaches a terminal point for this call: finished, paused,
   * or cancelled. Rejects on a download failure, including a signature mismatch surfaced
   * later at `install()`.
   */
  startDownload(onProgress: (received: number, total: number | null) => void): Promise<void>;

  /** Continues a paused download from where it left off; keeps the same bytes already on disk. */
  resume(): Promise<void>;

  /** Pauses the current download, keeping the bytes already received on disk. */
  pause(): Promise<void>;

  /** Cancels the current download and discards the partial package. */
  cancel(): Promise<void>;

  /** Verifies and installs the completed download. Rejects if the download never finished. */
  install(): Promise<void>;

  /** Whether the shell is currently registered to launch on login. */
  isAutostartEnabled(): Promise<boolean>;

  /** Registers or unregisters the shell to launch on login. */
  setAutostart(enabled: boolean): Promise<void>;
}
