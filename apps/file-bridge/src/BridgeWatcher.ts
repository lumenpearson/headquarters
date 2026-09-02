import { relative } from 'node:path';
import { realpath } from 'node:fs/promises';

import type { BridgeConfig, BridgeEvent } from '@gremuchaya/config';
import { createVirtualPath } from '@gremuchaya/domain';
import { watch, type FSWatcher } from 'chokidar';

import { waitForStableFile } from './stableFile.js';

export type BridgeEventListener = (event: BridgeEvent) => void;

export class BridgeWatcher {
  readonly #watchers: FSWatcher[] = [];
  readonly #armed: Promise<void>[] = [];
  // Mirrors `#armed` as plain state. A promise can only be observed by awaiting
  // it, which cannot tell "already armed" from "arms on the next tick", so the
  // counter is what lets a caller — and a test — assert that the bridge was
  // already reporting changes at the moment it opened its port.
  #pendingArm = 0;
  #isArmed = false;

  constructor(
    private readonly config: BridgeConfig,
    private readonly listener: BridgeEventListener,
  ) {}

  async start(): Promise<void> {
    // Counted up front, before the first `realpath` is awaited, so a mount whose
    // scan finishes while a later mount is still being set up cannot arm the
    // watcher on its own.
    this.#pendingArm = this.config.mounts.length;
    this.#isArmed = this.#pendingArm === 0;
    for (const mount of this.config.mounts) {
      const canonicalRoot = await realpath(mount.root);
      const watcher = watch(canonicalRoot, {
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: false,
        ignored: (path) => relative(canonicalRoot, path).split(/[\\/]/u).includes('.hq'),
      });
      // `ignoreInitial` suppresses everything the initial scan meets, so a file
      // created before `ready` fires is folded into that scan and never
      // announced. That window is invisible from the outside — a deaf watcher
      // and a quiet mount look identical over `Watch` — so the readiness of
      // every mount is kept here, and `startBridge` waits for it before it opens
      // the port (see the comment at that call site for who owns the wait).
      this.#armed.push(
        new Promise<void>((resolve) => {
          watcher.once('ready', () => {
            this.#pendingArm -= 1;
            if (this.#pendingArm === 0) this.#isArmed = true;
            resolve();
          });
        }),
      );
      const emit = (
        type: 'FILE_ADDED' | 'FILE_CHANGED' | 'FILE_REMOVED' | 'DIRECTORY_CHANGED',
        physicalPath: string,
      ) => {
        const path = toVirtualPath(canonicalRoot, physicalPath);
        this.listener({ type, mountId: mount.id, path });
      };
      watcher.on('add', (path) => {
        emit('FILE_ADDED', path);
        void this.#emitWhenReady(mount.id, canonicalRoot, path);
      });
      watcher.on('change', (path) => {
        emit('FILE_CHANGED', path);
        void this.#emitWhenReady(mount.id, canonicalRoot, path);
      });
      watcher.on('unlink', (path) => emit('FILE_REMOVED', path));
      watcher.on('addDir', (path) => emit('DIRECTORY_CHANGED', path));
      watcher.on('unlinkDir', (path) => emit('DIRECTORY_CHANGED', path));
      this.#watchers.push(watcher);
    }
  }

  /** Resolves once every mount's initial scan is over and new files are reported. */
  async whenArmed(): Promise<void> {
    await Promise.all(this.#armed);
  }

  /** Whether every mount's initial scan has finished, without awaiting anything. */
  isArmed(): boolean {
    return this.#isArmed;
  }

  async close(): Promise<void> {
    await Promise.all(this.#watchers.map((watcher) => watcher.close()));
    this.#watchers.length = 0;
    this.#armed.length = 0;
    this.#pendingArm = 0;
    this.#isArmed = false;
  }

  async #emitWhenReady(mountId: string, root: string, physicalPath: string): Promise<void> {
    const stable = await waitForStableFile(
      physicalPath,
      this.config.stableFile.probeIntervalMs,
      this.config.stableFile.timeoutMs,
    );
    if (stable)
      this.listener({ type: 'FILE_READY', mountId, path: toVirtualPath(root, physicalPath) });
  }
}

function toVirtualPath(root: string, physicalPath: string) {
  return createVirtualPath(`/${relative(root, physicalPath).replaceAll('\\', '/')}`);
}
