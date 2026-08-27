import { create } from '@bufbuild/protobuf';
import {
  createVirtualPath,
  type Disposable,
  type ExplorerNode,
  type FileSourceEvent,
  type FileSourcePort,
  type FileStat,
  type ReadableFile,
} from '@gremuchaya/domain';
import { FileEventKind, WatchResponseSchema, type WatchResponse } from '@gremuchaya/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  BridgeFileSource,
  type BridgeWatchClient,
} from '@/infrastructure/explorer/BridgeFileSource';

import { ExplorerService } from './ExplorerService';

/**
 * A `Watch` stream stated the way the wire states it, reduced to what this
 * file needs: one event at a time, on demand. `BridgeFileSource.watch.test.ts`
 * carries the fuller version this is adapted from.
 */
function fakeBridgeWatchClient(): {
  readonly client: BridgeWatchClient;
  emit(response: WatchResponse): void;
} {
  const queue: WatchResponse[] = [];
  let wake: (() => void) | undefined;

  async function* stream(): AsyncGenerator<WatchResponse, void> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    client: { watch: () => stream() },
    emit: (response) => {
      queue.push(response);
      wake?.();
      wake = undefined;
    },
  };
}

function watchResponse(kind: FileEventKind, path: string, mountId = 'incoming'): WatchResponse {
  return create(WatchResponseSchema, { kind, mountId, path, issuedAtMs: 1n });
}

/** A source with nothing behind `list`/`stat`/`read` -- this file only exercises `watch`. */
function fakePort(id: string): FileSourcePort {
  return {
    id,
    label: id,
    list: async (): Promise<readonly ExplorerNode[]> => [],
    stat: async (): Promise<FileStat | null> => null,
    read: async (): Promise<ReadableFile> => {
      throw new Error(`${id}: read is not exercised in this file`);
    },
  };
}

/** Stands in for `TauriFileSource` on a build with no Tauri runtime: `watch` always rejects. */
function fakeRejectingWatchPort(id: string): FileSourcePort {
  return {
    ...fakePort(id),
    watch: async (): Promise<Disposable> => {
      throw new Error('Tauri runtime is unavailable.');
    },
  };
}

/**
 * A source whose `watch` throws synchronously instead of returning a
 * rejecting promise. `FileSourcePort.watch` is typed to return one, but
 * nothing enforces that a plain (non-`async`) implementation actually does --
 * this is the shape a throw-before-the-first-`await` implementation takes.
 */
function fakeSyncThrowingWatchPort(id: string): FileSourcePort {
  return {
    ...fakePort(id),
    watch: (): Promise<Disposable> => {
      throw new Error(`${id}: watch threw synchronously`);
    },
  };
}

interface DeferredWatchPort {
  readonly port: FileSourcePort;
  resolve(disposable: Disposable): void;
}

/**
 * A source whose `watch` call does not settle until the test says so, so a
 * `dispose()` reached while it is still pending can be tested.
 */
function deferredWatchPort(id: string): DeferredWatchPort {
  let resolveFn: ((disposable: Disposable) => void) | undefined;
  return {
    port: {
      ...fakePort(id),
      watch: () =>
        new Promise<Disposable>((resolve) => {
          resolveFn = resolve;
        }),
    },
    resolve: (disposable) => resolveFn?.(disposable),
  };
}

describe('ExplorerService.watch', () => {
  it('carries a bridge event through the merge with sourceId intact', async () => {
    const fake = fakeBridgeWatchClient();
    const bridge = new BridgeFileSource('http://127.0.0.1:7788', 'incoming', fake.client);
    const service = new ExplorerService([bridge]);
    const seen: FileSourceEvent[] = [];

    await service.watch(createVirtualPath('/cases'), (event) => seen.push(event));
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt'));

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen).toEqual([
      { type: 'FILE_ADDED', sourceId: 'file-bridge', path: '/cases/K-01/report.txt' },
    ]);
  });

  it('skips a source without watch, a rejecting source and a synchronously-throwing one without stopping the others', async () => {
    const fake = fakeBridgeWatchClient();
    const bridge = new BridgeFileSource('http://127.0.0.1:7788', 'incoming', fake.client);
    const service = new ExplorerService([
      fakePort('no-watch'),
      fakeRejectingWatchPort('web-tauri'),
      // Placed before `bridge`: if a synchronous throw escaped the fan-out
      // loop instead of being caught, the bridge after it would never have
      // been subscribed either.
      fakeSyncThrowingWatchPort('sync-throw'),
      bridge,
    ]);
    const seen: FileSourceEvent[] = [];

    await service.watch(createVirtualPath('/cases'), (event) => seen.push(event));
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt'));

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen).toEqual([
      { type: 'FILE_ADDED', sourceId: 'file-bridge', path: '/cases/K-01/report.txt' },
    ]);
  });

  it('never rejects, even when every source throws -- synchronously or not', async () => {
    const service = new ExplorerService([
      fakeRejectingWatchPort('web-tauri'),
      fakeRejectingWatchPort('unreachable-bridge'),
      fakeSyncThrowingWatchPort('sync-throw'),
      fakePort('no-watch'),
    ]);

    const disposable = await service.watch(createVirtualPath('/cases'), () => {});

    // Every source was skipped or failed: nothing was subscribed, so nothing
    // is disposed, but disposing the resulting no-op must not throw either.
    expect(() => disposable.dispose()).not.toThrow();
  });

  it('disposes every child, is idempotent, and disposes a child that resolves after disposal', async () => {
    const immediateDispose = vi.fn();
    const immediatePort: FileSourcePort = {
      ...fakePort('immediate'),
      watch: async (): Promise<Disposable> => ({ dispose: immediateDispose }),
    };
    const deferred = deferredWatchPort('deferred');
    const deferredDispose = vi.fn();
    const service = new ExplorerService([immediatePort, deferred.port]);

    // Resolves without waiting for `deferred`'s watch to settle: that is the
    // point of not blocking the merge on the slowest source.
    const disposable = await service.watch(createVirtualPath('/cases'), () => {});

    disposable.dispose();
    disposable.dispose(); // idempotent: a second call must not double-dispose anything.

    // The deferred source only resolves now, after the merge was disposed.
    deferred.resolve({ dispose: deferredDispose });

    await vi.waitFor(() => expect(deferredDispose).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(immediateDispose).toHaveBeenCalledTimes(1));
  });
});
