import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  createVirtualPath,
  getVirtualPathSegments,
  joinVirtualPath,
  type Disposable,
  type ExplorerNode,
  type FileSourceEvent,
  type FileSourceListener,
  type FileSourcePort,
  type FileStat,
  type ReadableFile,
  type RealFileNode,
  type VirtualPath,
} from '@gremuchaya/domain';

/** The event `native_fs::watch_directory` emits for every change it sees. */
const nativeFileEventName = 'hq:file-event';

interface NativeRoot {
  readonly index: number;
  readonly label: string;
}
interface NativeEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
  readonly byteSize: number | null;
  readonly modifiedAtMs: number | null;
}

/**
 * The payload of `hq:file-event`, as `NativeWatchEvent` serialises it.
 *
 * `kind` is the stable tag `watch_event_kind` collapses notify's
 * platform-flavoured kinds into; `relativePaths` are root-relative and
 * forward-slashed on every host.
 */
interface NativeWatchEvent {
  readonly watcherId: string;
  readonly kind: 'created' | 'modified' | 'removed' | 'renamed' | 'other';
  readonly relativePaths: readonly string[];
}

interface ActiveWatch {
  readonly watcherId: string;
  /** The virtual segment naming the root, so a payload path can be re-branded. */
  readonly rootSegment: string;
  /** The directory being watched, reported for changes with no single subject. */
  readonly path: VirtualPath;
  readonly listener: FileSourceListener;
}

export class TauriFileSource implements FileSourcePort {
  readonly id = 'tauri';
  readonly label = 'TAURI / NATIVE';
  readonly #roots = new Map<string, NativeRoot>();
  readonly #files = new Map<
    VirtualPath,
    { readonly node: RealFileNode; readonly rootIndex: number; readonly relativePath: string }
  >();
  /**
   * The live watches, keyed by the virtual path each one was opened for, so a
   * second `watch` of the same directory replaces the first instead of leaking
   * a native watcher the explorer can no longer name.
   */
  readonly #watches = new Map<VirtualPath, ActiveWatch>();
  /** One `hq:file-event` subscription for every watcher, routed by watcher id. */
  #eventSubscription: Promise<UnlistenFn> | null = null;

  /** Whether this source has a native shell to talk to at all. */
  isAvailable(): boolean {
    return isTauri();
  }

  async list(path: VirtualPath): Promise<readonly ExplorerNode[]> {
    if (!isTauri()) throw new Error('Tauri runtime is unavailable.');
    if (path === '/') {
      const roots = await invoke<readonly NativeRoot[]>('list_native_roots');
      return roots.map((root) => {
        const segment = `LOCAL-${root.index}`;
        this.#roots.set(segment, root);
        return {
          id: `${this.id}:${segment}`,
          kind: 'mount' as const,
          sourceId: this.id,
          name: root.label,
          path: createVirtualPath(`/${segment}`),
          status: 'online' as const,
          iconHint: 'folder' as const,
        };
      });
    }
    const segments = getVirtualPathSegments(path);
    const rootSegment = segments[0];
    if (rootSegment === undefined) return [];
    const root = this.#roots.get(rootSegment);
    if (root === undefined) throw new Error('Native root is not registered in this session.');
    const relativePath = segments.slice(1).join('/');
    const entries = await invoke<readonly NativeEntry[]>('list_directory', {
      rootIndex: root.index,
      relativePath,
    });
    return entries.map((entry): ExplorerNode => {
      const childPath = joinVirtualPath(path, entry.name);
      if (entry.kind === 'directory')
        return {
          id: `${this.id}:${childPath}`,
          kind: 'real-directory',
          sourceId: this.id,
          name: entry.name,
          path: childPath,
          iconHint: 'folder',
        };
      const node: RealFileNode = {
        id: `${this.id}:${childPath}`,
        kind: 'real-file',
        sourceId: this.id,
        name: entry.name,
        path: childPath,
        mimeType: mimeFromName(entry.name),
        byteSize: entry.byteSize ?? 0,
        displaySize: entry.byteSize ?? 0,
        ...(entry.modifiedAtMs === null
          ? {}
          : { modifiedAt: new Date(entry.modifiedAtMs).toISOString() }),
      };
      this.#files.set(childPath, { node, rootIndex: root.index, relativePath: entry.relativePath });
      return node;
    });
  }

  async stat(path: VirtualPath): Promise<FileStat | null> {
    const entry = this.#files.get(path);
    if (entry === undefined) return null;
    return {
      path,
      mimeType: entry.node.mimeType,
      byteSize: entry.node.byteSize,
      modifiedAt: entry.node.modifiedAt ?? new Date(0).toISOString(),
    };
  }

  async read(path: VirtualPath): Promise<ReadableFile> {
    const entry = this.#files.get(path);
    if (entry === undefined) throw new Error(`Native file was not listed: ${path}`);
    const bytes = await invoke<number[]>('read_file', {
      rootIndex: entry.rootIndex,
      relativePath: entry.relativePath,
    });
    return { node: entry.node, content: { kind: 'bytes', bytes: Uint8Array.from(bytes) } };
  }

  /**
   * Subscribes to the native watcher for one directory.
   *
   * This implements `FileSourcePort.watch`, which the domain has declared as an
   * optional member since the port was written and which no adapter had
   * implemented: `watch_directory` and `unwatch_directory` were registered in
   * `generate_handler!` and called from nowhere, so the explorer re-read a
   * directory only when the operator navigated to it again. The port is the
   * right home rather than a Tauri-only method, because `BridgeFileSource`
   * already has a server-streaming watcher on the wire (`FileBridgeService`)
   * and can implement the same member without changing it.
   */
  async watch(path: VirtualPath, listener: FileSourceListener): Promise<Disposable> {
    if (!isTauri()) throw new Error('Tauri runtime is unavailable.');
    const segments = getVirtualPathSegments(path);
    const rootSegment = segments[0];
    if (rootSegment === undefined) {
      // The virtual root is the list of registered native roots, which is fixed
      // for the life of the process (`NativeFsState::from_environment` reads
      // `HQ_NATIVE_ROOTS` once). There is nothing on disk to watch, and a
      // rejection here would put an error on the screen for the default view.
      return { dispose: () => {} };
    }
    const root = this.#roots.get(rootSegment);
    if (root === undefined) throw new Error('Native root is not registered in this session.');
    await this.#releaseWatch(path);
    const watcherId = await invoke<string>('watch_directory', {
      rootIndex: root.index,
      relativePath: segments.slice(1).join('/'),
    });
    this.#watches.set(path, { watcherId, rootSegment, path, listener });
    await this.#ensureEventSubscription();
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        void this.#releaseWatch(path, watcherId);
      },
    };
  }

  /** Drops the watch registered for `path`, if it is still the one named. */
  async #releaseWatch(path: VirtualPath, watcherId?: string): Promise<void> {
    const active = this.#watches.get(path);
    if (active === undefined) return;
    if (watcherId !== undefined && active.watcherId !== watcherId) return;
    this.#watches.delete(path);
    try {
      await invoke<boolean>('unwatch_directory', { watcherId: active.watcherId });
    } catch {
      // A watcher the native side already dropped is the state we wanted.
    }
    if (this.#watches.size === 0) {
      const subscription = this.#eventSubscription;
      this.#eventSubscription = null;
      try {
        (await subscription)?.();
      } catch {
        // Nothing left to unlisten.
      }
    }
  }

  #ensureEventSubscription(): Promise<UnlistenFn> {
    // Stored as the promise rather than the resolved handle so two watches
    // opened in the same tick share one subscription instead of racing to
    // register two and leaking whichever loses.
    this.#eventSubscription ??= listen<NativeWatchEvent>(nativeFileEventName, (event) => {
      this.#dispatchWatchEvent(event.payload);
    });
    return this.#eventSubscription;
  }

  #dispatchWatchEvent(payload: NativeWatchEvent): void {
    for (const watch of this.#watches.values()) {
      if (watch.watcherId !== payload.watcherId) continue;
      for (const event of this.#toFileSourceEvents(watch, payload)) watch.listener(event);
      return;
    }
  }

  /**
   * Maps one native watch event onto the domain's file-source events.
   *
   * `renamed` reports the watched directory rather than the paths in the
   * payload: the Windows watcher reports a move as a `Modify(Name)` pair, so
   * one of the two paths named no longer exists and the other did not exist a
   * moment ago. Re-listing the directory is the only answer that is true for
   * both halves.
   *
   * `other` is dropped. It covers notify's `Access` and `Any` kinds, and
   * `Access` fires on every read -- including the reads this application makes
   * through `read_file` -- so honouring it would have the explorer re-list
   * itself in a loop.
   */
  #toFileSourceEvents(watch: ActiveWatch, payload: NativeWatchEvent): readonly FileSourceEvent[] {
    if (payload.kind === 'other') return [];
    if (payload.kind === 'renamed') {
      return [{ type: 'DIRECTORY_CHANGED', sourceId: this.id, path: watch.path }];
    }
    const type =
      payload.kind === 'created'
        ? ('FILE_ADDED' as const)
        : payload.kind === 'removed'
          ? ('FILE_REMOVED' as const)
          : ('FILE_CHANGED' as const);
    return payload.relativePaths.flatMap((relativePath) => {
      const path = toVirtualPath(watch.rootSegment, relativePath);
      // A name the virtual-path brand refuses (a NUL byte, an over-long path)
      // is dropped rather than thrown: this runs inside an event callback, and
      // one unrepresentable name must not silence the rest of the batch.
      return path === null ? [] : [{ type, sourceId: this.id, path }];
    });
  }
}

/**
 * Re-brands a root-relative native path as the virtual path the UI knows.
 *
 * Physical filesystem paths must never leak into the UI (ADR 0002), and the
 * watcher payload is the one place a native path arrives unasked: the root
 * prefix was already stripped in Rust, so this only has to put the virtual root
 * segment back in front of it.
 */
function toVirtualPath(rootSegment: string, relativePath: string): VirtualPath | null {
  const trimmed = relativePath.replace(/^\/+/u, '');
  try {
    return createVirtualPath(trimmed === '' ? `/${rootSegment}` : `/${rootSegment}/${trimmed}`);
  } catch {
    return null;
  }
}

function mimeFromName(name: string): string {
  const extension = name.split('.').pop()?.toLocaleLowerCase('en-US');
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'mp4') return 'video/mp4';
  if (extension === 'txt') return 'text/plain';
  return 'application/octet-stream';
}
