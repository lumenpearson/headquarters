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

  constructor(
    private readonly config: BridgeConfig,
    private readonly listener: BridgeEventListener,
  ) {}

  async start(): Promise<void> {
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
      // announced. Startup deliberately does not wait for the scan — a large
      // media mount would hold the port shut behind it — so the promise is kept
      // here instead, for a caller that must not miss the first event.
      this.#armed.push(
        new Promise<void>((resolve) => {
          watcher.once('ready', () => resolve());
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

  async close(): Promise<void> {
    await Promise.all(this.#watchers.map((watcher) => watcher.close()));
    this.#watchers.length = 0;
    this.#armed.length = 0;
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
