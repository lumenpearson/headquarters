import { invoke, isTauri } from '@tauri-apps/api/core';

/**
 * A display as the native shell reports it, in physical pixels on the virtual
 * desktop. Mirrors `NativeMonitor` in `src-tauri/src/managed_windows.rs`, whose
 * `serde(rename_all = "camelCase")` puts these exact keys on the IPC boundary.
 */
export interface NativeMonitor {
  readonly name: string | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
  readonly primary: boolean;
}

/**
 * What a window request did.
 *
 * `unavailable` is not a failure: the web build has no native windows, and a
 * caller that treated "there is no desktop shell here" as an error would report
 * a fault on every browser session. It is a distinct value rather than a thrown
 * error so the operator-facing panel can say which of the two happened.
 */
export type NativeWindowResult =
  | { readonly status: 'unavailable' }
  | { readonly status: 'opened'; readonly screenId: string }
  | { readonly status: 'closed' }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * The TypeScript side of `managed_windows.rs`.
 *
 * The three commands it wraps -- `list_monitors`, `open_screen_window` and
 * `close_managed_windows` -- were registered in `generate_handler!` and called
 * from nowhere, which is the concrete form of the R18 defect: Rust that exists
 * but cannot be reached. Every method is guarded by `isTauri()` and returns a
 * typed no-op on the web build, so a caller needs no branch of its own.
 */
export class TauriDisplayGateway {
  isAvailable(): boolean {
    return isTauri();
  }

  /** The connected displays, or an empty list when there is no native shell. */
  async listMonitors(): Promise<readonly NativeMonitor[]> {
    if (!isTauri()) return [];
    return parseNativeMonitors(await invoke<unknown>('list_monitors'));
  }

  async openScreenWindow(
    screenId: string,
    monitorIndex: number,
    fullscreen: boolean,
  ): Promise<NativeWindowResult> {
    if (!isTauri()) return { status: 'unavailable' };
    try {
      await invoke<null>('open_screen_window', { screenId, monitorIndex, fullscreen });
      return { status: 'opened', screenId };
    } catch (error: unknown) {
      // The command rejects with a plain string ("unknown screen id",
      // "monitor index is unavailable"), which is the operator's answer.
      return { status: 'failed', reason: describe(error) };
    }
  }

  async closeManagedWindows(): Promise<NativeWindowResult> {
    if (!isTauri()) return { status: 'unavailable' };
    try {
      await invoke<null>('close_managed_windows');
      return { status: 'closed' };
    } catch (error: unknown) {
      return { status: 'failed', reason: describe(error) };
    }
  }
}

/**
 * Reads the monitor list the native side returned.
 *
 * The IPC boundary is inside the same process and the producer is our own Rust,
 * so this is a shape check rather than a security check: a build where the two
 * sides disagree should fail loudly here instead of placing a window at
 * `undefined`.
 */
export function parseNativeMonitors(value: unknown): readonly NativeMonitor[] {
  if (!Array.isArray(value)) throw new Error('Native shell returned an invalid monitor list.');
  return value.map((entry): NativeMonitor => {
    if (!isRecord(entry)) throw new Error('Native shell returned an invalid monitor list.');
    const { name, x, y, width, height, scaleFactor, primary } = entry;
    if (
      !(typeof name === 'string' || name === null || name === undefined) ||
      !isFinite(x) ||
      !isFinite(y) ||
      !isFinite(width) ||
      !isFinite(height) ||
      !isFinite(scaleFactor) ||
      typeof primary !== 'boolean'
    ) {
      throw new Error('Native shell returned an invalid monitor list.');
    }
    return {
      name: typeof name === 'string' ? name : null,
      x,
      y,
      width,
      height,
      scaleFactor,
      primary,
    };
  });
}

function isFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : 'NATIVE_WINDOW_ERROR';
}
