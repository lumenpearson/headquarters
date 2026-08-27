import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { Code, ConnectError, createClient, type Client } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import type { BridgeConfig } from '@gremuchaya/config';
import { createVirtualPath } from '@gremuchaya/domain';
import {
  EntryKind,
  FileBridgeService,
  FileEventKind,
  type WatchResponse,
} from '@gremuchaya/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { startBridge } from './server.js';

/**
 * Timing policy for this file.
 *
 * Every wait below is event-driven: a test either awaits the next message of a
 * real gRPC-Web stream or polls the running bridge's own subscriber count. No
 * assertion is made after a fixed sleep, because the delivery latency is not
 * ours to choose — chokidar hands the operating system's notification straight
 * to the hub, and FILE_READY trails the add by one `stableFile.probeIntervalMs`
 * probe. On this machine that is tens of milliseconds. The deadline below is two
 * orders of magnitude above that budget, so a loaded CI agent has to be a
 * hundred times slower than a developer workstation before a green behaviour
 * turns red, while a broken chain still reports within ten seconds rather than
 * hanging until the runner gives up. The per-test timeout leaves room for the
 * deadline to expire and name the event that never arrived.
 */
const eventDeadlineMs = 10_000;
const testTimeoutMs = 30_000;
const pollOptions = { timeout: eventDeadlineMs, interval: 10 } as const;

describe('gRPC-Web file bridge watch stream', () => {
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  let root: string | undefined;
  const openStreams: AbortController[] = [];

  afterEach(async () => {
    // `server.close()` resolves only once every response has finished, and a
    // Watch response stays open by design. Aborting the client end asks for
    // that, but an abandoned stream can leave its socket lingering in the
    // client's connection pool, so the server end is cut as well. Without it a
    // teardown outlives the test it belonged to and reports a hook timeout on
    // top of whatever actually failed.
    for (const controller of openStreams) controller.abort();
    openStreams.length = 0;
    bridge?.server.closeAllConnections();
    await bridge?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    bridge = undefined;
    root = undefined;
  });

  function openWatchStream(client: Client<typeof FileBridgeService>, mountIds: string[]) {
    const controller = new AbortController();
    openStreams.push(controller);
    const stream = client.watch({ mountIds }, { signal: controller.signal });
    return { controller, events: stream[Symbol.asyncIterator]() };
  }

  it(
    'delivers a file written into a watched mount over an open Watch stream',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'gremuchaya-watch-'));
      const mountRoot = join(root, 'incoming');
      await mkdir(join(mountRoot, 'reports'), { recursive: true });
      // The watcher subscribes to `realpath(mount.root)` and reports every path
      // relative to that canonical root, and the mount's path guard rejects
      // anything resolving outside it. Writing through the same canonical form is
      // what makes `/reports/take-01.txt` an assertion about the mapping rather
      // than about whatever indirection the temp directory carries.
      const canonicalMountRoot = await realpath(mountRoot);

      const running = await startBridge(
        watchBridgeConfig([
          {
            id: 'incoming',
            label: 'ВХОДЯЩИЕ',
            root: mountRoot,
            virtualPath: createVirtualPath('/ВХОДЯЩИЕ'),
          },
        ]),
      );
      bridge = running;
      await withDeadline(running.watcher.whenArmed(), 'the initial scan of every mount');
      const client = connectToBridge(running.server.address() as AddressInfo);
      const stream = openWatchStream(client, ['incoming']);
      // The hub replays nothing, so an event published before the subscription is
      // registered is simply lost. Waiting for the bridge's own subscriber count
      // is the handshake the protocol does not provide; without it the write
      // below would race the request and a sleep would be standing in for proof.
      await expect.poll(() => running.activeWatchSubscriberCount(), pollOptions).toBe(1);

      const writtenAtMs = Date.now();
      await writeFile(join(canonicalMountRoot, 'reports', 'take-01.txt'), 'дубль 1', 'utf8');

      const received = await readWatchEventsUntil(
        stream.events,
        (event) => event.kind === FileEventKind.READY,
        'the READY event for /reports/take-01.txt',
      );

      // The first thing the stream carries is the creation itself, addressed by
      // mount id and by the path relative to that mount — never a physical one.
      expect(received[0]).toMatchObject({
        kind: FileEventKind.ADDED,
        mountId: 'incoming',
        path: '/reports/take-01.txt',
      });
      expect(received.at(-1)).toMatchObject({
        kind: FileEventKind.READY,
        mountId: 'incoming',
        path: '/reports/take-01.txt',
      });
      // Nothing else may ride along. A write can produce a CHANGED between the
      // add and the readiness probe, but no other mount and no other path.
      expect([...new Set(received.map((event) => `${event.mountId}${event.path}`))]).toEqual([
        'incoming/reports/take-01.txt',
      ]);
      expect(
        received.filter(
          (event) =>
            event.kind !== FileEventKind.ADDED &&
            event.kind !== FileEventKind.CHANGED &&
            event.kind !== FileEventKind.READY,
        ),
      ).toEqual([]);
      // The timestamp is stamped when the event is converted for the wire, so it
      // cannot predate the write that caused it.
      const issuedAtMs = Number(received[0]?.issuedAtMs ?? 0n);
      expect(issuedAtMs).toBeGreaterThanOrEqual(writtenAtMs);
      expect(issuedAtMs).toBeLessThanOrEqual(Date.now());
    },
    testTimeoutMs,
  );

  it(
    'withholds events for a mount the request did not name and for writes outside every mount',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'gremuchaya-watch-scope-'));
      const watchedRoot = join(root, 'watched');
      const ignoredRoot = join(root, 'ignored');
      const outsideRoot = join(root, 'outside');
      await mkdir(watchedRoot);
      await mkdir(ignoredRoot);
      await mkdir(outsideRoot);
      const canonicalWatchedRoot = await realpath(watchedRoot);
      const canonicalIgnoredRoot = await realpath(ignoredRoot);
      const canonicalOutsideRoot = await realpath(outsideRoot);

      const running = await startBridge(
        watchBridgeConfig([
          {
            id: 'watched',
            label: 'НАБЛЮДАЕМЫЕ',
            root: watchedRoot,
            virtualPath: createVirtualPath('/НАБЛЮДАЕМЫЕ'),
          },
          {
            id: 'ignored',
            label: 'ПРОЧИЕ',
            root: ignoredRoot,
            virtualPath: createVirtualPath('/ПРОЧИЕ'),
          },
        ]),
      );
      bridge = running;
      await withDeadline(running.watcher.whenArmed(), 'the initial scan of every mount');
      const client = connectToBridge(running.server.address() as AddressInfo);
      const scoped = openWatchStream(client, ['watched']);
      // An empty mount filter means "every mount", so this second stream is the
      // witness: it reports what the bridge actually published, which is what
      // turns the scoped stream's silence into evidence instead of a guess.
      const witness = openWatchStream(client, []);
      await expect.poll(() => running.activeWatchSubscriberCount(), pollOptions).toBe(2);

      // Ordered on purpose. `outside/` sits under the same temp root but under no
      // mount, so nothing may ever report it; `ignored/` is a configured mount, so
      // the bridge does publish it and only the subscription filter may drop it.
      await writeFile(join(canonicalOutsideRoot, 'stray.txt'), 'вне монтирования', 'utf8');
      await writeFile(join(canonicalIgnoredRoot, 'ignored-take.txt'), 'чужой монтаж', 'utf8');
      const witnessed = [
        ...(await readWatchEventsUntil(
          witness.events,
          (event) => event.mountId === 'ignored',
          'the unnamed mount event on the unfiltered stream',
        )),
      ];

      await writeFile(join(canonicalWatchedRoot, 'sentinel.txt'), 'наблюдаемый файл', 'utf8');
      const scopedEvents = await readWatchEventsUntil(
        scoped.events,
        (event) => event.path === '/sentinel.txt',
        'the sentinel event on the scoped stream',
      );
      // `publish` fans out synchronously to every subscriber, so by the time the
      // witness yielded the unnamed mount's event that event was already queued
      // for this stream too — and that happened before the sentinel was written.
      // A filter that let it through would therefore have placed it in front of
      // the sentinel here, so an exact match is a real exclusion proof and not a
      // race that happened to go our way.
      expect(scopedEvents.map((event) => `${event.mountId}${event.path}`)).toEqual([
        'watched/sentinel.txt',
      ]);
      expect(scopedEvents[0]).toMatchObject({ kind: FileEventKind.ADDED });

      witnessed.push(
        ...(await readWatchEventsUntil(
          witness.events,
          (event) => event.path === '/sentinel.txt',
          'the sentinel event on the unfiltered stream',
        )),
      );
      // The stray write completed before the unnamed mount's write began, and the
      // witness has now seen events from both later writes, so an event for
      // `outside/stray.txt` would have arrived by now if any watcher covered it.
      expect(witnessed.filter((event) => event.path.includes('stray'))).toEqual([]);
      expect([...new Set(witnessed.map((event) => event.mountId))]).toEqual(['ignored', 'watched']);
    },
    testTimeoutMs,
  );

  it(
    'releases the server-side subscription when a client aborts and keeps serving afterwards',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'gremuchaya-watch-abort-'));
      const mountRoot = join(root, 'incoming');
      await mkdir(mountRoot);
      const canonicalMountRoot = await realpath(mountRoot);
      const running = await startBridge(
        watchBridgeConfig([
          {
            id: 'incoming',
            label: 'ВХОДЯЩИЕ',
            root: mountRoot,
            virtualPath: createVirtualPath('/ВХОДЯЩИЕ'),
          },
        ]),
      );
      bridge = running;
      await withDeadline(running.watcher.whenArmed(), 'the initial scan of every mount');
      const client = connectToBridge(running.server.address() as AddressInfo);

      // A dropped stream is the ordinary case — a screen closes, a window
      // reloads — so the teardown path must not leave a rejection behind for the
      // process to trip over later.
      const unhandled: unknown[] = [];
      const recordUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', recordUnhandled);
      try {
        const stream = openWatchStream(client, ['incoming']);
        await expect.poll(() => running.activeWatchSubscriberCount(), pollOptions).toBe(1);
        await writeFile(join(canonicalMountRoot, 'first.txt'), 'первый', 'utf8');
        // Abort a stream that is actually carrying traffic. A subscription that
        // has yielded and one that never woke leave the handler in different
        // places, and only the first resembles a client that walked away.
        const first = await nextWatchEvent(stream.events, 'the first event', eventDeadlineMs);
        expect(first).toMatchObject({
          kind: FileEventKind.ADDED,
          mountId: 'incoming',
          path: '/first.txt',
        });

        stream.controller.abort();
        // Either termination is clean: connect surfaces a client abort as a
        // cancelled call, and a stream the server already finished ends the
        // iterator instead. What must not happen is a hang or a transport error.
        expect(['ended', 'cancelled']).toContain(await settleAbortedStream(stream.events));
        // The handler's `for await` has to unwind so the hub generator's
        // `finally` runs. A subscriber left behind would go on queueing events
        // for a reader that will never come back.
        await expect.poll(() => running.activeWatchSubscriberCount(), pollOptions).toBe(0);

        expect(await client.health({})).toMatchObject({ status: 'ok' });
        const listed = await client.list({ mountId: 'incoming', path: '/' });
        expect(listed.entries.map((entry) => [entry.name, entry.kind])).toEqual([
          ['first.txt', EntryKind.FILE],
        ]);
        const chunks: Uint8Array[] = [];
        for await (const chunk of client.readFile({ mountId: 'incoming', path: '/first.txt' })) {
          chunks.push(chunk.data);
        }
        expect(new TextDecoder().decode(joinChunks(chunks))).toBe('первый');

        // The watcher and the hub survived the abort as well, not only the HTTP
        // server: a fresh subscription still receives what the dropped one would
        // have received.
        const resumed = openWatchStream(client, ['incoming']);
        await expect.poll(() => running.activeWatchSubscriberCount(), pollOptions).toBe(1);
        await writeFile(join(canonicalMountRoot, 'second.txt'), 'второй', 'utf8');
        const afterAbort = await readWatchEventsUntil(
          resumed.events,
          (event) => event.path === '/second.txt',
          'the event for /second.txt on the resumed stream',
        );
        expect(afterAbort.at(-1)).toMatchObject({
          kind: FileEventKind.ADDED,
          mountId: 'incoming',
          path: '/second.txt',
        });

        resumed.controller.abort();
        expect(['ended', 'cancelled']).toContain(await settleAbortedStream(resumed.events));
        await expect.poll(() => running.activeWatchSubscriberCount(), pollOptions).toBe(0);
        // Node reports an unhandled rejection on the turn after it happens, so
        // the loop gets that turn before the listener comes off.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      } finally {
        process.off('unhandledRejection', recordUnhandled);
      }
      expect(unhandled).toEqual([]);
    },
    testTimeoutMs,
  );
});

function watchBridgeConfig(mounts: BridgeConfig['mounts']): BridgeConfig {
  return {
    version: 1,
    transport: 'grpc-web',
    port: 0,
    readOnly: true,
    allowedOrigins: ['http://127.0.0.1:3000'],
    mounts,
    // FILE_READY waits for two identical stat readings, so the probe interval is
    // the floor on how long a finished write takes to be announced. The schema's
    // minimum is the fastest this may legally be configured; the tests still wait
    // on the event rather than on the clock, so this only bounds the happy path.
    stableFile: { probeIntervalMs: 50, timeoutMs: 500 },
    watchDebounceMs: 25,
    // The parser defaults this and the schema refuses `enabled` on a read-only
    // bridge, so the disabled form is the only one this configuration can take.
    materialImport: {
      enabled: false,
      maxFileBytes: 5 * 1024 * 1024 * 1024,
      chunkSizeBytes: 1024 * 1024,
    },
  };
}

function connectToBridge(address: AddressInfo): Client<typeof FileBridgeService> {
  return createClient(
    FileBridgeService,
    createGrpcWebTransport({
      baseUrl: `http://127.0.0.1:${address.port}`,
      useBinaryFormat: true,
    }),
  );
}

/**
 * Bounds a wait on the bridge's own state.
 *
 * A watcher that never finishes its initial scan announces nothing, and
 * `ignoreInitial` makes that indistinguishable from a broken chain. Awaiting the
 * armed watch instead of sleeping is what keeps the write below a trigger rather
 * than a race against the scan.
 */
async function withDeadline<T>(
  work: Promise<T>,
  label: string,
  timeoutMs = eventDeadlineMs,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

async function readWatchEventsUntil(
  events: AsyncIterator<WatchResponse>,
  matches: (event: WatchResponse) => boolean,
  label: string,
): Promise<readonly WatchResponse[]> {
  const deadline = Date.now() + eventDeadlineMs;
  const received: WatchResponse[] = [];
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out after ${eventDeadlineMs} ms waiting for ${label}.`);
    }
    const event = await nextWatchEvent(events, label, remaining);
    received.push(event);
    if (matches(event)) return received;
  }
}

async function nextWatchEvent(
  events: AsyncIterator<WatchResponse>,
  label: string,
  timeoutMs: number,
): Promise<WatchResponse> {
  const pending = events.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.`)),
      timeoutMs,
    );
  });
  try {
    const result = await Promise.race([pending, expiry]);
    if (result.done === true) throw new Error(`The watch stream ended before ${label}.`);
    return result.value;
  } catch (error: unknown) {
    // The pull outlives its deadline. Adopting its eventual rejection keeps a
    // missing event a failure of this assertion instead of the whole worker.
    void pending.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function settleAbortedStream(events: AsyncIterator<WatchResponse>): Promise<string> {
  const deadline = Date.now() + eventDeadlineMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'still open';
    const outcome = await settleNextPull(events, remaining);
    // A message already on the wire when the abort landed is not a failure to
    // terminate — the watcher keeps reporting a finished write for as long as
    // the stableFile probe runs. Drain those and keep waiting for the end.
    if (outcome !== 'delivered another message') return outcome;
  }
}

async function settleNextPull(
  events: AsyncIterator<WatchResponse>,
  timeoutMs: number,
): Promise<string> {
  // The rejection is mapped rather than raced, so a pull that outlives the
  // deadline cannot surface later as an unhandled rejection.
  const pending = events.next().then(
    (result) => (result.done === true ? 'ended' : 'delivered another message'),
    (error: unknown) => describeStreamFailure(error),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('still open'), timeoutMs);
  });
  try {
    return await Promise.race([pending, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

function describeStreamFailure(error: unknown): string {
  if (error instanceof ConnectError && error.code === Code.Canceled) return 'cancelled';
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  return `failed with ${String(error)}`;
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
