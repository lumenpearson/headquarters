import { create } from '@bufbuild/protobuf';
import { createVirtualPath, type FileSourceEvent } from '@gremuchaya/domain';
import { FileEventKind, WatchResponseSchema, type WatchResponse } from '@gremuchaya/protocol';
import { describe, expect, it, vi } from 'vitest';

import { BridgeFileSource, type BridgeWatchClient } from './BridgeFileSource';

interface FakeBridgeWatch {
  readonly client: BridgeWatchClient;
  /** The mount ids of every `Watch` call, read off the request the source sent. */
  readonly requests: (readonly string[])[];
  /** The signal the source handed the RPC, which is what an abort acts on. */
  signal(): AbortSignal;
  /** Whether the stream has been closed, by a throw or by the pump letting go. */
  closed(): boolean;
  emit(response: WatchResponse): void;
  fail(error: Error): void;
}

/**
 * A `Watch` stream stated the way the wire states it, not a spy on one.
 *
 * It keeps yielding after the call is aborted, which the real transport would
 * not: a fake that stopped by itself would leave the source's own guard
 * against delivering a response it no longer wants untested.
 */
function fakeBridgeWatch(): FakeBridgeWatch {
  const requests: (readonly string[])[] = [];
  const queue: WatchResponse[] = [];
  let callSignal: AbortSignal | undefined;
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  let closed = false;
  const notify = () => {
    wake?.();
    wake = undefined;
  };

  async function* stream(): AsyncGenerator<WatchResponse, void> {
    try {
      for (;;) {
        if (failure !== undefined) throw failure;
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      closed = true;
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
    closed: () => closed,
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
});
