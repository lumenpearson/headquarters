import { relative } from 'node:path';
import { realpath } from 'node:fs/promises';

import type { BridgeConfig, BridgeEvent } from '@gremuchaya/config';
import { createVirtualPath } from '@gremuchaya/domain';
import { watch, type FSWatcher } from 'chokidar';

import { waitForStableFile } from './stableFile.js';

export type BridgeEventListener = (event: BridgeEvent) => void;

export class BridgeWatcher {
  readonly #watchers: FSWatcher[] = [];

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
      });
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

  async close(): Promise<void> {
    await Promise.all(this.#watchers.map((watcher) => watcher.close()));
    this.#watchers.length = 0;
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
