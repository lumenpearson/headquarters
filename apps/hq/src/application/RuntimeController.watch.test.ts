// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { createVirtualPath } from '@gremuchaya/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appStore } from '@/state/appStore';

import { RuntimeController } from './RuntimeController';

interface RecordedCall {
  readonly command: string;
  readonly args: unknown;
}

let calls: RecordedCall[] = [];
let nextWatcher = 1;

/** Mirrors `explorerRefreshDebounceMs` in `RuntimeController.ts`. */
const explorerRefreshDebounceMs = 180;

const requiredRuntimeFiles = new Map([
  ['/runtime/project.default.json', 'project.default.json'],
  ['/runtime/assets_manifest.json', 'assets_manifest.json'],
  ['/runtime/filesystem.emulated.json', 'filesystem.emulated.json'],
]);

/*
 * Stands in for `native_fs.rs`, the same way `TauriFileSource.watch.test.ts`
 * does: it answers `list_native_roots` so the source learns the `LOCAL-0`
 * segment, `list_directory` with an empty listing (this file never reads real
 * entries), and hands out watcher ids the way `watch_directory` does.
 */
function mockNativeFs(): void {
  Object.assign(globalThis, { isTauri: true });
  nextWatcher = 1;
  calls = [];
  mockIPC(
    (command, args) => {
      if (command.startsWith('plugin:event|')) return undefined;
      calls.push({ command, args });
      if (command === 'list_native_roots') return [{ index: 0, label: 'МАТЕРИАЛЫ' }];
      if (command === 'list_directory') return [];
      if (command === 'watch_directory') return `watch-${String(nextWatcher++)}`;
      if (command === 'unwatch_directory') return true;
      return undefined;
    },
    { shouldMockEvents: true },
  );
}

function commandsNamed(name: string): readonly RecordedCall[] {
  return calls.filter((call) => call.command === name);
}

/**
 * Stubs every runtime document `RuntimeController.create` reads, from the
 * real files under `public/runtime` -- the pattern `RuntimeConfigLoader.test.ts`
 * uses. Everything else (the optional project override, every static asset
 * URL, the file bridge's gRPC-Web endpoint) falls through to a 404: an absent
 * override and an unreachable bridge both look like one to their own caller,
 * and `ExplorerService`/`StaticAssetResolver` are already built to degrade on
 * exactly that.
 */
function stubRuntimeFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = getRequestUrl(input);
      const filename = requiredRuntimeFiles.get(url);
      if (filename === undefined) return new Response(null, { status: 404 });
      return new Response(await readRuntimeFile(filename), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * `new URL(relative, import.meta.url)` is what `RuntimeConfigLoader.test.ts`
 * uses, but jsdom's own `URL` -- installed as `globalThis.URL` for the
 * duration of this file's `@vitest-environment jsdom` -- resolves a `file:`
 * base with a Windows drive letter differently from Node's, so `..` walks
 * past the drive instead of up the tree. `process.cwd()` is Vitest's package
 * root (`apps/hq`) regardless of environment, and is not affected either way.
 */
async function readRuntimeFile(name: string): Promise<string> {
  return readFile(join(process.cwd(), 'public', 'runtime', name), 'utf8');
}

beforeEach(() => {
  mockNativeFs();
  stubRuntimeFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearMocks();
  Reflect.deleteProperty(globalThis, 'isTauri');
});

describe('RuntimeController file-watch read path', () => {
  it('re-lists on a debounced native event, coalesces a burst, and disposes on navigate and close', async () => {
    const controller = await RuntimeController.create();

    await controller.navigate(createVirtualPath('/LOCAL-0/cases'));
    // The merged watch does not block navigation on the slowest source
    // subscribing (ExplorerService.watch's own invariant), so the native
    // `watch_directory` call is still in flight when `navigate` returns.
    await vi.waitFor(() => expect(commandsNamed('watch_directory')).toHaveLength(1));

    vi.useFakeTimers();
    try {
      const nodesBeforeRefresh = appStore.getState().explorer.nodes;
      const listCallsBeforeRefresh = commandsNamed('list_directory').length;

      await emit('hq:file-event', {
        watcherId: 'watch-1',
        kind: 'created',
        relativePaths: ['cases/K-01/report.txt'],
      });
      await vi.advanceTimersByTimeAsync(explorerRefreshDebounceMs);

      expect(commandsNamed('list_directory')).toHaveLength(listCallsBeforeRefresh + 1);
      // A new array from the re-list, not the one `navigate` already stored --
      // proof the store actually observed the refresh, not just that a native
      // call happened.
      expect(appStore.getState().explorer.nodes).not.toBe(nodesBeforeRefresh);

      const listCallsAfterFirstRefresh = commandsNamed('list_directory').length;
      await emit('hq:file-event', {
        watcherId: 'watch-1',
        kind: 'created',
        relativePaths: ['cases/K-02/a.txt'],
      });
      await vi.advanceTimersByTimeAsync(explorerRefreshDebounceMs - 90);
      await emit('hq:file-event', {
        watcherId: 'watch-1',
        kind: 'created',
        relativePaths: ['cases/K-02/b.txt'],
      });
      await vi.advanceTimersByTimeAsync(explorerRefreshDebounceMs);

      // Two events inside one debounce window collapse into one re-list, not
      // two: the second event resets the timer instead of adding to it.
      expect(commandsNamed('list_directory')).toHaveLength(listCallsAfterFirstRefresh + 1);
    } finally {
      vi.useRealTimers();
    }

    await controller.navigate(createVirtualPath('/LOCAL-0'));
    await vi.waitFor(() => {
      expect(commandsNamed('unwatch_directory')).toEqual(
        expect.arrayContaining([{ command: 'unwatch_directory', args: { watcherId: 'watch-1' } }]),
      );
    });
    await vi.waitFor(() => expect(commandsNamed('watch_directory')).toHaveLength(2));

    await controller.navigate(createVirtualPath('/LOCAL-0/cases'));
    await vi.waitFor(() => expect(commandsNamed('watch_directory')).toHaveLength(3));

    vi.useFakeTimers();
    try {
      const listCallsBeforeClose = commandsNamed('list_directory').length;
      await emit('hq:file-event', {
        watcherId: 'watch-3',
        kind: 'created',
        relativePaths: ['cases/K-03/c.txt'],
      });
      controller.close();
      await vi.advanceTimersByTimeAsync(explorerRefreshDebounceMs * 3);

      // The pending refresh was cancelled along with the watch: no re-list
      // fires after `close`, however long the clock runs.
      expect(commandsNamed('list_directory')).toHaveLength(listCallsBeforeClose);
    } finally {
      vi.useRealTimers();
    }

    await vi.waitFor(() => {
      expect(commandsNamed('unwatch_directory')).toEqual(
        expect.arrayContaining([{ command: 'unwatch_directory', args: { watcherId: 'watch-3' } }]),
      );
    });
  });
});

describe('R? connections.lastFilesystemEvent and connections.bridgeStatus, wired over the watch path', () => {
  it('records the kind, source and path of a native event as connections.lastFilesystemEvent', async () => {
    const controller = await RuntimeController.create();
    await controller.navigate(createVirtualPath('/LOCAL-0/cases'));
    await vi.waitFor(() => expect(commandsNamed('watch_directory')).toHaveLength(1));

    await emit('hq:file-event', {
      watcherId: 'watch-1',
      kind: 'created',
      relativePaths: ['cases/K-01/report.txt'],
    });

    await vi.waitFor(() => {
      expect(appStore.getState().connections.lastFilesystemEvent).toBe(
        'FILE_ADDED tauri /LOCAL-0/cases/K-01/report.txt',
      );
    });

    controller.close();
    // `close` disposes the merged watch, whose native half unlistens over an
    // async IPC round trip it does not await; letting that settle here (as
    // the pre-existing case above already does through its own trailing
    // `waitFor`) keeps it from rejecting after this test's own mocks are gone.
    await vi.waitFor(() => expect(commandsNamed('unwatch_directory')).toHaveLength(1));
  });

  it('writes connections.bridgeStatus from the file-bridge source status on every navigate', async () => {
    // `stubRuntimeFetch` 404s the bridge's gRPC-Web endpoint, so every
    // `BridgeFileSource.list` call fails and `ExplorerService` reports it
    // 'offline' -- exactly the signal `bridgeStatusFromSourceStatus` reads.
    // The slice already initializes to 'offline', which would make a test
    // that only reads it afterwards pass whether or not `navigate` writes
    // anything; forcing it to 'online' first proves the write actually runs.
    const controller = await RuntimeController.create();
    const stateBeforeNavigate = appStore.getState();
    stateBeforeNavigate.replaceRuntimeState({
      ...stateBeforeNavigate,
      connections: { ...stateBeforeNavigate.connections, bridgeStatus: 'online' },
    });

    await controller.navigate(createVirtualPath('/LOCAL-0/cases'));

    expect(appStore.getState().connections.bridgeStatus).toBe('offline');

    controller.close();
    await vi.waitFor(() => expect(commandsNamed('unwatch_directory')).toHaveLength(1));
  });
});
