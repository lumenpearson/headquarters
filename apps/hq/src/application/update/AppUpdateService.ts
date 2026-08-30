import type { AppUpdatePort } from './appUpdatePort';

/**
 * `idle → checking → available{version} → downloading{percent|null} → paused → ready →
 * installing`, with `error{message}` reachable from every in-flight step and `cancel`
 * folding `downloading`/`paused` back to `available`. `upToDate` is the fourth branch out
 * of `checking` the port's `null` result names -- `checkForUpdate` resolving to nothing to
 * install is not the same fact as never having checked, and collapsing the two would lose
 * that. `unavailable` is a fifth: a build with no adapter (`AppUpdatePort` is `null`) never
 * reaches `checking` at all.
 *
 * Every status after `available` carries the version (and notes, when the check reported
 * any) it started from, so a caller rendering `paused`/`ready`/`installing` never has to
 * remember what was being installed.
 */
export type AppUpdateState =
  | { readonly status: 'unavailable' }
  | { readonly status: 'idle' }
  | { readonly status: 'checking' }
  | { readonly status: 'upToDate' }
  | { readonly status: 'available'; readonly version: string; readonly notes?: string }
  | {
      readonly status: 'downloading';
      readonly version: string;
      readonly notes?: string;
      readonly percent: number | null;
    }
  | {
      readonly status: 'paused';
      readonly version: string;
      readonly notes?: string;
      readonly percent: number | null;
    }
  | { readonly status: 'ready'; readonly version: string; readonly notes?: string }
  | { readonly status: 'installing'; readonly version: string; readonly notes?: string }
  | { readonly status: 'error'; readonly message: string };

type Listener = (state: AppUpdateState) => void;

const idle: AppUpdateState = { status: 'idle' };
const unavailable: AppUpdateState = { status: 'unavailable' };

/**
 * Drives `AppUpdateState` against an `AppUpdatePort`. A `null` port (the web build) pins
 * the state to `'unavailable'` forever: every method below becomes a no-op rather than a
 * caller having to check `available()` itself before every call.
 *
 * `download()`/`resume()` do not block their caller on the underlying transfer finishing.
 * They `await` the port call to catch a rejection (a download failure lands in `error`),
 * but resolve their own promise once that `await` settles -- by which point `pause()` or
 * `cancel()`, called from a separate, concurrent invocation while the transfer was still
 * running, may already have moved the state machine on. The guard before each of those two
 * completion transitions (`if (this.#state.status === 'downloading')`) is what keeps a
 * `startDownload` call that resolves *after* an explicit pause/cancel from clobbering the
 * state those calls already set -- see the fake port's paused/cancelled resolution timing
 * in the test file for the scenario this protects.
 */
export class AppUpdateService {
  readonly #port: AppUpdatePort | null;
  readonly #listeners = new Set<Listener>();
  #state: AppUpdateState;

  constructor(port: AppUpdatePort | null) {
    this.#port = port;
    this.#state = port?.available() ? idle : unavailable;
  }

  getState(): AppUpdateState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async checkForUpdate(): Promise<void> {
    const port = this.#port;
    if (!port) return;
    this.#setState({ status: 'checking' });
    try {
      const result = await port.checkForUpdate();
      this.#setState(
        result
          ? withNotes({ status: 'available', version: result.version }, result.notes)
          : { status: 'upToDate' },
      );
    } catch (error) {
      this.#setState({ status: 'error', message: messageOf(error) });
    }
  }

  async download(): Promise<void> {
    const port = this.#port;
    if (!port || this.#state.status !== 'available') return;
    const { version, notes } = this.#state;
    this.#setState(withNotes({ status: 'downloading', version, percent: null }, notes));
    try {
      await port.startDownload((received, total) => {
        // `getState()`, not `this.#state` directly: TypeScript keeps this method's
        // earlier `this.#state.status !== 'available'` guard narrowed across the
        // `#setState` calls below, which would make this comparison (correctly, at
        // runtime, after a concurrent `pause`/`cancel`) look like it can never be
        // true. Going through the method call is what resets that.
        if (this.getState().status !== 'downloading') return; // a pause/cancel already moved on
        this.#setState(
          withNotes({ status: 'downloading', version, percent: percentOf(received, total) }, notes),
        );
      });
      if (this.getState().status === 'downloading') {
        this.#setState(withNotes({ status: 'ready', version }, notes));
      }
    } catch (error) {
      this.#setState({ status: 'error', message: messageOf(error) });
    }
  }

  async pause(): Promise<void> {
    const port = this.#port;
    if (!port || this.#state.status !== 'downloading') return;
    const { version, notes, percent } = this.#state;
    try {
      await port.pause();
    } catch (error) {
      this.#setState({ status: 'error', message: messageOf(error) });
      return;
    }
    this.#setState(withNotes({ status: 'paused', version, percent }, notes));
  }

  async resume(): Promise<void> {
    const port = this.#port;
    if (!port || this.#state.status !== 'paused') return;
    const { version, notes, percent } = this.#state;
    this.#setState(withNotes({ status: 'downloading', version, percent }, notes));
    try {
      await port.resume();
      if (this.getState().status === 'downloading') {
        this.#setState(withNotes({ status: 'ready', version }, notes));
      }
    } catch (error) {
      this.#setState({ status: 'error', message: messageOf(error) });
    }
  }

  async cancel(): Promise<void> {
    const port = this.#port;
    if (!port) return;
    if (this.#state.status !== 'downloading' && this.#state.status !== 'paused') return;
    try {
      await port.cancel();
    } catch (error) {
      this.#setState({ status: 'error', message: messageOf(error) });
      return;
    }
    // Not back to `available`: `TauriAppUpdateAdapter.startDownload` already nulled its
    // `rid` the moment the download started (`ResourceTable::take` on the Rust side spends
    // it once), and `update_download_cancel` deletes the native session outright, so a
    // `download()` call from here would fail with "startDownload was called before
    // checkForUpdate found an update." `idle` makes that explicit: a cancelled download
    // requires a fresh `checkForUpdate` before it can be downloaded again.
    this.#setState(idle);
  }

  async install(): Promise<void> {
    const port = this.#port;
    if (!port || this.#state.status !== 'ready') return;
    const { version, notes } = this.#state;
    this.#setState(withNotes({ status: 'installing', version }, notes));
    try {
      await port.install();
      // A successful native install typically replaces or exits this process (the
      // Windows installer path never returns at all); there is deliberately no further
      // transition here for the run that does return.
    } catch (error) {
      this.#setState({ status: 'error', message: messageOf(error) });
    }
  }

  async isAutostartEnabled(): Promise<boolean> {
    if (!this.#port) return false;
    return this.#port.isAutostartEnabled();
  }

  async setAutostart(enabled: boolean): Promise<void> {
    if (!this.#port) return;
    await this.#port.setAutostart(enabled);
  }

  #setState(next: AppUpdateState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener(next);
  }
}

function percentOf(received: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((received / total) * 100)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Conditional spread: `exactOptionalPropertyTypes` refuses `{ notes: undefined }`. */
function withNotes<T extends object>(state: T, notes: string | undefined): T & { notes?: string } {
  return notes === undefined ? state : { ...state, notes };
}
