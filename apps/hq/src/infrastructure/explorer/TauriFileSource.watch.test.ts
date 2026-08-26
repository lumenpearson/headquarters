// @vitest-environment jsdom
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { createVirtualPath, type FileSourceEvent } from '@gremuchaya/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TauriFileSource } from './TauriFileSource';

interface RecordedCall {
  readonly command: string;
  readonly args: unknown;
}

let calls: RecordedCall[] = [];
let nextWatcher = 1;

/*
 * Stands in for `native_fs.rs`: it answers `list_native_roots` so the source
 * learns the `LOCAL-0` segment (nothing else can be watched until it has), and
 * hands out watcher ids the way `watch_directory` does, one per call.
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

beforeEach(mockNativeFs);

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, 'isTauri');
});

describe('TauriFileSource native watcher', () => {
  it('opens one watcher per directory and releases it on dispose', async () => {
    const source = new TauriFileSource();
    await source.list(createVirtualPath('/'));

    const watch = await source.watch(createVirtualPath('/LOCAL-0/cases'), () => undefined);

    expect(commandsNamed('watch_directory')).toEqual([
      { command: 'watch_directory', args: { rootIndex: 0, relativePath: 'cases' } },
    ]);

    watch.dispose();
    await vi.waitFor(() =>
      expect(commandsNamed('unwatch_directory')).toEqual([
        { command: 'unwatch_directory', args: { watcherId: 'watch-1' } },
      ]),
    );
  });

  it('releases the previous watcher when the same path is watched again', async () => {
    const source = new TauriFileSource();
    await source.list(createVirtualPath('/'));
    const path = createVirtualPath('/LOCAL-0/cases');

    await source.watch(path, () => undefined);
    await source.watch(path, () => undefined);

    // The id map is keyed by virtual path, so the second watch had to give the
    // first one back; leaving it open would leak an OS handle the explorer can
    // no longer name.
    expect(commandsNamed('unwatch_directory')).toEqual([
      { command: 'unwatch_directory', args: { watcherId: 'watch-1' } },
    ]);
    expect(commandsNamed('watch_directory')).toHaveLength(2);
  });

  it('disposes only once however often dispose is called', async () => {
    const source = new TauriFileSource();
    await source.list(createVirtualPath('/'));
    const watch = await source.watch(createVirtualPath('/LOCAL-0/cases'), () => undefined);

    watch.dispose();
    watch.dispose();
    await vi.waitFor(() => expect(commandsNamed('unwatch_directory')).toHaveLength(1));
  });

  it('re-brands native paths as virtual paths and maps the event kind', async () => {
    const source = new TauriFileSource();
    await source.list(createVirtualPath('/'));
    const seen: FileSourceEvent[] = [];
    await source.watch(createVirtualPath('/LOCAL-0/cases'), (event) => seen.push(event));

    await emit('hq:file-event', {
      watcherId: 'watch-1',
      kind: 'created',
      relativePaths: ['cases/K-01/report.txt'],
    });
    await emit('hq:file-event', {
      watcherId: 'watch-1',
      kind: 'modified',
      relativePaths: ['cases/K-01/report.txt', 'cases/K-02/notes.txt'],
    });
    await emit('hq:file-event', {
      watcherId: 'watch-1',
      kind: 'removed',
      relativePaths: ['cases/K-02/notes.txt'],
    });

    expect(seen).toEqual([
      { type: 'FILE_ADDED', sourceId: 'tauri', path: '/LOCAL-0/cases/K-01/report.txt' },
      { type: 'FILE_CHANGED', sourceId: 'tauri', path: '/LOCAL-0/cases/K-01/report.txt' },
      { type: 'FILE_CHANGED', sourceId: 'tauri', path: '/LOCAL-0/cases/K-02/notes.txt' },
      { type: 'FILE_REMOVED', sourceId: 'tauri', path: '/LOCAL-0/cases/K-02/notes.txt' },
    ]);
  });

  it('reports a rename against the watched directory and drops the noisy kind', async () => {
    const source = new TauriFileSource();
    await source.list(createVirtualPath('/'));
    const seen: FileSourceEvent[] = [];
    await source.watch(createVirtualPath('/LOCAL-0/cases'), (event) => seen.push(event));

    await emit('hq:file-event', {
      watcherId: 'watch-1',
      kind: 'renamed',
      // The Windows watcher reports a move as a `Modify(Name)` pair: one of
      // these two names no longer exists and the other just appeared.
      relativePaths: ['cases/old.txt', 'cases/new.txt'],
    });
    await emit('hq:file-event', {
      watcherId: 'watch-1',
      kind: 'other',
      relativePaths: ['cases/K-01/report.txt'],
    });

    expect(seen).toEqual([
      { type: 'DIRECTORY_CHANGED', sourceId: 'tauri', path: '/LOCAL-0/cases' },
    ]);
  });

  it('ignores an event addressed to another watcher', async () => {
    const source = new TauriFileSource();
    await source.list(createVirtualPath('/'));
    const seen: FileSourceEvent[] = [];
    await source.watch(createVirtualPath('/LOCAL-0/cases'), (event) => seen.push(event));

    await emit('hq:file-event', {
      watcherId: 'watch-99',
      kind: 'created',
      relativePaths: ['cases/K-01/report.txt'],
    });

    expect(seen).toEqual([]);
  });

  it('stops delivering to a disposed watch', async () => {
    const source = new TauriFileSource();
    await source.list(createVirtualPath('/'));
    const seen: FileSourceEvent[] = [];
    const watch = await source.watch(createVirtualPath('/LOCAL-0/cases'), (event) =>
      seen.push(event),
    );

    watch.dispose();
    await vi.waitFor(() => expect(commandsNamed('unwatch_directory')).toHaveLength(1));
    await emit('hq:file-event', {
      watcherId: 'watch-1',
      kind: 'created',
      relativePaths: ['cases/K-01/report.txt'],
    });

    expect(seen).toEqual([]);
  });

  it('watches nothing for the virtual root and refuses an unlisted root', async () => {
    const source = new TauriFileSource();

    // `/` is the list of registered native roots, which is fixed for the life
    // of the process; there is no directory behind it to watch.
    const root = await source.watch(createVirtualPath('/'), () => undefined);
    root.dispose();
    expect(commandsNamed('watch_directory')).toEqual([]);

    await expect(
      source.watch(createVirtualPath('/LOCAL-9/cases'), () => undefined),
    ).rejects.toThrow(/Native root is not registered/u);
  });

  it('refuses to watch without a native shell', async () => {
    const source = new TauriFileSource();
    await source.list(createVirtualPath('/'));
    Reflect.deleteProperty(globalThis, 'isTauri');

    expect(source.isAvailable()).toBe(false);
    await expect(
      source.watch(createVirtualPath('/LOCAL-0/cases'), () => undefined),
    ).rejects.toThrow(/Tauri runtime is unavailable/u);
  });
});
