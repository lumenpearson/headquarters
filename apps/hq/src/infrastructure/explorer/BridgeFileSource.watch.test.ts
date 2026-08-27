import { create } from '@bufbuild/protobuf';
import { createVirtualPath, type FileSourceEvent } from '@gremuchaya/domain';
import { FileEventKind, WatchResponseSchema, type WatchResponse } from '@gremuchaya/protocol';
import { describe, expect, it, vi } from 'vitest';

import { BridgeFileSource, type BridgeWatchClient } from './BridgeFileSource';

interface FakeBridgeWatch {
  readonly client: BridgeWatchClient;
  /** The mount ids of every `Watch` call, read off the request the source sent. */
  readonly requests: (readonly string[])[];
  /** The signal the source handed the most recent RPC, which is what an abort acts on. */
  signal(): AbortSignal;
  /** Whether any stream has closed, by a throw or by the pump letting go. */
  closed(): boolean;
  /** How many separate streams have closed -- distinguishes one from several. */
  closedCount(): number;
  emit(response: WatchResponse): void;
  fail(error: Error): void;
}

/**
 * A `Watch` stream stated the way the wire states it, not a spy on one.
 *
 * It keeps yielding after the call is aborted, which the real transport would
 * not: a fake that stopped by itself would leave the source's own guard
 * against delivering a response it no longer wants untested. It also allows
 * more than one `client.watch()` call to be live at once -- the source is
 * only ever supposed to make one at a time, but a stale stream whose teardown
 * hasn't landed yet coexisting with a fresh one is exactly the race some of
 * the tests below need to construct, and every waiting stream is woken on
 * `emit`/`fail` so whichever one is still eligible (not yet aborted, not yet
 * failed) can make progress.
 */
function fakeBridgeWatch(): FakeBridgeWatch {
  const requests: (readonly string[])[] = [];
  const queue: WatchResponse[] = [];
  let callSignal: AbortSignal | undefined;
  const wakers = new Set<() => void>();
  let failure: Error | undefined;
  let closedCount = 0;
  const notify = () => {
    const pending = [...wakers];
    wakers.clear();
    for (const wake of pending) wake();
  };

  async function* stream(): AsyncGenerator<WatchResponse, void> {
    // A fresh `Watch` call starts healthy even if a previous one on this same
    // fake had already failed -- otherwise a source reopening after a
    // transport failure could never be tested, since the new stream would
    // throw on its very first turn too.
    failure = undefined;
    try {
      for (;;) {
        if (failure !== undefined) throw failure;
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wakers.add(resolve);
        });
      }
    } finally {
      closedCount += 1;
    }
  }

  return {
    client: {
      watch(request, options) {
        requests.push(request.mountIds ?? []);
        callSignal = options?.signal;
        return stream();
      },
    },
    requests,
    signal: () => {
      if (callSignal === undefined) throw new Error('Watch was never called.');
      return callSignal;
    },
    closed: () => closedCount > 0,
    closedCount: () => closedCount,
    emit: (response) => {
      queue.push(response);
      notify();
    },
    fail: (error) => {
      failure = error;
      notify();
    },
  };
}

function watchResponse(kind: FileEventKind, path: string, mountId = 'incoming'): WatchResponse {
  return create(WatchResponseSchema, { kind, mountId, path, issuedAtMs: 1n });
}

function bridgeSource(fake: FakeBridgeWatch): BridgeFileSource {
  return new BridgeFileSource('http://127.0.0.1:7788', 'incoming', fake.client);
}

describe('BridgeFileSource watch', () => {
  it('subscribes to its own mount and maps every event kind', async () => {
    const fake = fakeBridgeWatch();
    const seen: FileSourceEvent[] = [];
    await bridgeSource(fake).watch(createVirtualPath('/cases'), (event) => seen.push(event));

    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt'));
    fake.emit(watchResponse(FileEventKind.CHANGED, '/cases/K-01/report.txt'));
    fake.emit(watchResponse(FileEventKind.REMOVED, '/cases/K-01/report.txt'));
    fake.emit(watchResponse(FileEventKind.DIRECTORY_CHANGED, '/cases/K-02'));
    fake.emit(watchResponse(FileEventKind.READY, '/cases/K-01/report.txt'));

    await vi.waitFor(() => expect(seen).toHaveLength(5));
    expect(seen).toEqual([
      { type: 'FILE_ADDED', sourceId: 'file-bridge', path: '/cases/K-01/report.txt' },
      { type: 'FILE_CHANGED', sourceId: 'file-bridge', path: '/cases/K-01/report.txt' },
      { type: 'FILE_REMOVED', sourceId: 'file-bridge', path: '/cases/K-01/report.txt' },
      { type: 'DIRECTORY_CHANGED', sourceId: 'file-bridge', path: '/cases/K-02' },
      { type: 'FILE_READY', sourceId: 'file-bridge', path: '/cases/K-01/report.txt' },
    ]);
    expect(fake.requests).toEqual([['incoming']]);
  });

  it('delivers only what lies at or under the watched directory', async () => {
    const fake = fakeBridgeWatch();
    const seen: FileSourceEvent[] = [];
    await bridgeSource(fake).watch(createVirtualPath('/cases'), (event) => seen.push(event));

    // The two the source must drop come first, so waiting for the two it keeps
    // proves the whole batch was read rather than only its head.
    fake.emit(watchResponse(FileEventKind.ADDED, '/materials/K-01/report.txt'));
    // A sibling whose name only begins with the watched one: `/cases-archive`
    // is a different directory, however the paths compare as strings.
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases-archive/K-01/report.txt'));
    fake.emit(watchResponse(FileEventKind.DIRECTORY_CHANGED, '/cases'));
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/deep/report.txt'));

    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([
      { type: 'DIRECTORY_CHANGED', sourceId: 'file-bridge', path: '/cases' },
      { type: 'FILE_ADDED', sourceId: 'file-bridge', path: '/cases/K-01/deep/report.txt' },
    ]);
  });

  it('delivers the whole mount when the mount root is watched', async () => {
    const fake = fakeBridgeWatch();
    const seen: FileSourceEvent[] = [];
    await bridgeSource(fake).watch(createVirtualPath('/'), (event) => seen.push(event));

    fake.emit(watchResponse(FileEventKind.ADDED, '/materials/K-01/report.txt'));
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt'));

    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map((event) => event.path)).toEqual([
      '/materials/K-01/report.txt',
      '/cases/K-01/report.txt',
    ]);
  });

  it('drops an event addressed to another mount', async () => {
    const fake = fakeBridgeWatch();
    const seen: FileSourceEvent[] = [];
    await bridgeSource(fake).watch(createVirtualPath('/cases'), (event) => seen.push(event));

    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt', 'archive'));
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt'));

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen).toEqual([
      { type: 'FILE_ADDED', sourceId: 'file-bridge', path: '/cases/K-01/report.txt' },
    ]);
  });

  it('drops a kind and a path it cannot name', async () => {
    const fake = fakeBridgeWatch();
    const seen: FileSourceEvent[] = [];
    await bridgeSource(fake).watch(createVirtualPath('/cases'), (event) => seen.push(event));

    fake.emit(watchResponse(FileEventKind.UNSPECIFIED, '/cases/K-01/report.txt'));
    // Proto3 enums are open: a newer bridge can send a kind this build has no
    // member for, and the cast is how that reaches the mapping from here.
    fake.emit(watchResponse(99 as FileEventKind, '/cases/K-01/report.txt'));
    // Two paths `createVirtualPath` refuses to brand: a NUL byte, and a
    // traversal that names a directory the mount does not contain.
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/rep\u0000ort.txt'));
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/../secret/report.txt'));
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt'));

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen).toEqual([
      { type: 'FILE_ADDED', sourceId: 'file-bridge', path: '/cases/K-01/report.txt' },
    ]);
  });

  it('aborts the stream on dispose and delivers nothing after it', async () => {
    const fake = fakeBridgeWatch();
    const seen: FileSourceEvent[] = [];
    const watch = await bridgeSource(fake).watch(createVirtualPath('/cases'), (event) =>
      seen.push(event),
    );

    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    watch.dispose();
    expect(fake.signal().aborted).toBe(true);

    // The fake ignores the abort, so this response is put in front of the pump
    // anyway; the stream closes only because the pump let go of it, and the
    // event must not have reached the listener on the way.
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-02/notes.txt'));
    await vi.waitFor(() => expect(fake.closed()).toBe(true));
    expect(seen).toHaveLength(1);
  });

  it('stops the watch when the stream fails instead of rejecting', async () => {
    const fake = fakeBridgeWatch();
    const seen: FileSourceEvent[] = [];
    const watch = await bridgeSource(fake).watch(createVirtualPath('/cases'), (event) =>
      seen.push(event),
    );

    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt'));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    // The pump runs detached from this caller, so a re-thrown transport error
    // would arrive as an unhandled rejection -- which fails the run rather
    // than the watch.
    fake.fail(new Error('bridge went away'));
    await vi.waitFor(() => expect(fake.closed()).toBe(true));

    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-02/notes.txt'));
    watch.dispose();
    expect(seen).toHaveLength(1);
  });

  it('multiplexes two watchers on the same mount into one Watch request', async () => {
    const fake = fakeBridgeWatch();
    const source = bridgeSource(fake);
    const casesSeen: FileSourceEvent[] = [];
    const materialsSeen: FileSourceEvent[] = [];
    await source.watch(createVirtualPath('/cases'), (event) => casesSeen.push(event));
    await source.watch(createVirtualPath('/materials'), (event) => materialsSeen.push(event));

    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt'));
    fake.emit(watchResponse(FileEventKind.ADDED, '/materials/M-01/photo.jpg'));

    await vi.waitFor(() => expect(casesSeen).toHaveLength(1));
    await vi.waitFor(() => expect(materialsSeen).toHaveLength(1));
    // One request for both watchers, not one per watcher: `WatchRequest` names
    // a mount, and a second identical RPC against the same mount would only
    // double the wire traffic for the same events.
    expect(fake.requests).toEqual([['incoming']]);
    expect(casesSeen).toEqual([
      { type: 'FILE_ADDED', sourceId: 'file-bridge', path: '/cases/K-01/report.txt' },
    ]);
    expect(materialsSeen).toEqual([
      { type: 'FILE_ADDED', sourceId: 'file-bridge', path: '/materials/M-01/photo.jpg' },
    ]);
  });

  it('keeps the stream for a surviving watcher and aborts only once the last one disposes', async () => {
    const fake = fakeBridgeWatch();
    const source = bridgeSource(fake);
    const casesSeen: FileSourceEvent[] = [];
    const materialsSeen: FileSourceEvent[] = [];
    const casesWatch = await source.watch(createVirtualPath('/cases'), (event) =>
      casesSeen.push(event),
    );
    const materialsWatch = await source.watch(createVirtualPath('/materials'), (event) =>
      materialsSeen.push(event),
    );
    // Pins the shared-stream identity this test is actually about: under the
    // old per-watcher implementation this would already be two requests, and
    // `fake.signal()` returning the *last* call's signal would have made both
    // abort assertions below pass regardless of whether anything was shared.
    expect(fake.requests).toEqual([['incoming']]);

    casesWatch.dispose();
    // A watcher remains, so the shared stream must not have been touched.
    expect(fake.signal().aborted).toBe(false);

    // Addressed to the directory whose watcher just disposed: it must not
    // reach `casesSeen`, which proves the dispose removed it from the fan-out
    // rather than merely happening to coincide with no more `/cases` traffic.
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-02/notes.txt'));
    fake.emit(watchResponse(FileEventKind.ADDED, '/materials/M-01/photo.jpg'));
    await vi.waitFor(() => expect(materialsSeen).toHaveLength(1));
    expect(casesSeen).toHaveLength(0);

    materialsWatch.dispose();
    expect(fake.signal().aborted).toBe(true);
  });

  it('opens a fresh stream for a later watch after a transport failure', async () => {
    const fake = fakeBridgeWatch();
    const source = bridgeSource(fake);
    const firstSeen: FileSourceEvent[] = [];
    await source.watch(createVirtualPath('/cases'), (event) => firstSeen.push(event));

    fake.fail(new Error('bridge went away'));
    await vi.waitFor(() => expect(fake.closedCount()).toBe(1));

    // The failed stream's teardown nulled `#stream`, and the still-registered
    // first watcher stays deaf until the next call reopens it for everyone --
    // the documented degradation. This is that next call.
    const secondSeen: FileSourceEvent[] = [];
    const secondWatch = await source.watch(createVirtualPath('/cases'), (event) =>
      secondSeen.push(event),
    );
    expect(fake.requests).toHaveLength(2);

    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt'));
    await vi.waitFor(() => expect(secondSeen).toHaveLength(1));
    expect(secondSeen).toEqual([
      { type: 'FILE_ADDED', sourceId: 'file-bridge', path: '/cases/K-01/report.txt' },
    ]);

    secondWatch.dispose();
  });

  it('joins the newer stream instead of nulling it when a stale teardown lands late', async () => {
    const fake = fakeBridgeWatch();
    const source = bridgeSource(fake);

    const firstWatch = await source.watch(createVirtualPath('/cases'), () => {});
    firstWatch.dispose();
    // `#stream` is null again once the last watcher disposes, so this opens a
    // second, independent `Watch` request instead of joining the first.
    const secondWatch = await source.watch(createVirtualPath('/cases'), () => {});
    expect(fake.requests).toHaveLength(2);

    // The fake keeps yielding to a disposed stream, the same way a real one
    // would keep delivering until the transport actually notices the abort;
    // only once it gets a response does the first stream's pump notice
    // `signal.aborted` and let go. This wakes the stale pump specifically,
    // without touching the second, live one.
    fake.emit(watchResponse(FileEventKind.ADDED, '/cases/K-01/report.txt'));
    await vi.waitFor(() => expect(fake.closedCount()).toBe(1));

    // The stale teardown landed after `#stream` had already moved on to the
    // second request. Without the identity check in the pump's `finally` it
    // would null that live record anyway, and this third `watch()` would open
    // a third request instead of joining the second.
    const thirdWatch = await source.watch(createVirtualPath('/cases'), () => {});
    expect(fake.requests).toHaveLength(2);

    thirdWatch.dispose();
    secondWatch.dispose();
  });
});
