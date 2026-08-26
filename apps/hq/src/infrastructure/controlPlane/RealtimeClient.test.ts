import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { realtimeV1, syncV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import type { RealtimeLinkState } from '@/application/sync/connection';
import type { GroupEventEnvelope, RealtimeIdentity } from '@/application/sync/groupChannel';

import { RealtimeClient, realtimeUrl, type RealtimeSocketLike } from './RealtimeClient';

/** A ping interval no backoff step could ever equal. */
const pingIntervalMs = 1_000_000;

const accessToken = 'access-token-that-must-never-be-in-a-url';

const identity: RealtimeIdentity = {
  groupId: 'group-a',
  deviceId: 'device-a',
  accessToken,
};

/**
 * A WebSocket stated as the wire states it, not a spy on one.
 *
 * Every frame is kept as raw bytes and decoded by the test, because the claims
 * under test are about what crosses the wire -- which sequence a hello resumes
 * from, whether an ack follows an event, whether the token is anywhere but the
 * hello body. A mock counting `send` calls could not answer any of them.
 */
class FakeSocket implements RealtimeSocketLike {
  binaryType = '';
  readyState = 1;
  readonly sent: Uint8Array[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send(data: ArrayBufferLike): void {
    this.sent.push(new Uint8Array(data));
  }

  close(code?: number, reason?: string): void {
    this.closedWith = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
    this.readyState = 3;
  }

  /** What the runtime does when the server opens the connection. */
  open(): void {
    this.onopen?.();
  }

  /** Delivers one server frame, as bytes, exactly as the server would. */
  deliver(frame: realtimeV1.RealtimeServerFrame): void {
    this.onmessage?.({ data: toBinary(realtimeV1.RealtimeServerFrameSchema, frame).buffer });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }

  frames(): realtimeV1.RealtimeClientFrame[] {
    return this.sent.map((bytes) => fromBinary(realtimeV1.RealtimeClientFrameSchema, bytes));
  }
}

interface Harness {
  readonly client: RealtimeClient;
  readonly sockets: FakeSocket[];
  readonly events: GroupEventEnvelope[];
  readonly statuses: RealtimeLinkState[];
  /** Reconnect delays only; the ping timer is filtered out by its interval. */
  readonly backoffDelays: () => number[];
  /** Runs every timer the client scheduled, oldest first. */
  readonly flushTimers: () => void;
  readonly latest: () => FakeSocket;
}

function harness(
  overrides: {
    readonly onResync?: (
      resync: {
        readonly requestedAfterSequence: bigint;
        readonly earliestAvailableSequence: bigint;
      },
      signal: AbortSignal,
    ) => Promise<{ readonly afterSequence: bigint } | null>;
    readonly onReauthenticationRequired?: () => void;
    readonly identity?: () => RealtimeIdentity | null;
  } = {},
): Harness {
  const sockets: FakeSocket[] = [];
  const events: GroupEventEnvelope[] = [];
  const statuses: RealtimeLinkState[] = [];
  const delays: number[] = [];
  let pending: (() => void)[] = [];
  const client = new RealtimeClient({
    baseUrl: 'http://127.0.0.1:4100',
    identity: overrides.identity ?? (() => identity),
    onEvent: (event) => events.push(event),
    onStatus: (state) => statuses.push(state),
    ...(overrides.onResync === undefined ? {} : { onResync: overrides.onResync }),
    ...(overrides.onReauthenticationRequired === undefined
      ? {}
      : { onReauthenticationRequired: overrides.onReauthenticationRequired }),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    schedule: (callback, delayMs) => {
      delays.push(delayMs);
      pending.push(callback);
      return () => {
        pending = pending.filter((candidate) => candidate !== callback);
      };
    },
    backoffMs: [10, 20, 40],
    // Long enough that no test's timer flush trips a ping it did not ask for,
    // and distinct enough that the harness can tell a ping from a reconnect.
    pingIntervalMs,
  });
  return {
    client,
    sockets,
    events,
    statuses,
    backoffDelays: () => delays.filter((delay) => delay !== pingIntervalMs),
    flushTimers: () => {
      const due = pending;
      pending = [];
      for (const callback of due) callback();
    },
    latest: () => {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error('No socket was opened.');
      return socket;
    },
  };
}

function readyFrame(resumedFrom: bigint): realtimeV1.RealtimeServerFrame {
  return create(realtimeV1.RealtimeServerFrameSchema, {
    payload: {
      case: 'ready',
      value: {
        connectionId: 'connection-1',
        resumedFromSequence: resumedFrom,
        serverTime: timestampFromDate(new Date(1_700_000_000_000)),
        protocolVersion: 'gremuchaya.realtime.v1',
      },
    },
  });
}

function eventFrame(sequence: bigint, documentId = 'settings.live-edit') {
  return create(realtimeV1.RealtimeServerFrameSchema, {
    payload: {
      case: 'groupEvent',
      value: {
        event: {
          sequence,
          kind: syncV1.GroupEventKind.DOCUMENT_DELTA,
          documentId: { value: documentId },
          documentDelta: new Uint8Array([sequence < 256n ? Number(sequence) : 0]),
          actorDeviceId: { value: 'device-b' },
          hybridLogicalClock: sequence,
          occurredAt: timestampFromDate(new Date(1_700_000_000_000)),
        },
      },
    },
  });
}

function resyncFrame(requested: bigint, earliest: bigint) {
  return create(realtimeV1.RealtimeServerFrameSchema, {
    payload: {
      case: 'resyncRequired',
      value: {
        groupId: { value: 'group-a' },
        requestedAfterSequence: requested,
        earliestAvailableSequence: earliest,
        reason: 'retained event history no longer covers the requested sequence',
      },
    },
  });
}

function errorFrame(code: string) {
  return create(realtimeV1.RealtimeServerFrameSchema, {
    payload: { case: 'error', value: { code, message: '', retryable: false } },
  });
}

function helloOf(socket: FakeSocket): realtimeV1.ClientHello {
  const frame = socket.frames()[0];
  if (frame?.payload.case !== 'hello') throw new Error('The first frame was not a hello.');
  return frame.payload.value;
}

describe('RealtimeClient', () => {
  it('puts the access token in the hello frame and never in the URL', () => {
    const test = harness();
    test.client.start();
    test.latest().open();

    expect(test.client.url).toBe('ws://127.0.0.1:4100/realtime');
    expect(test.client.url).not.toContain(accessToken);
    expect(test.latest().url).not.toContain(accessToken);
    expect(test.latest().url).not.toContain('token');
    expect(helloOf(test.latest()).accessToken).toBe(accessToken);
  });

  it('derives wss from https and replaces any path the base URL carried', () => {
    expect(realtimeUrl('https://plane.example:8443/api/v2?key=secret#frag')).toBe(
      'wss://plane.example:8443/realtime',
    );
  });

  it('greets from sequence zero, then replays in order and acknowledges each event', () => {
    const test = harness();
    test.client.start();
    const socket = test.latest();
    socket.open();
    expect(helloOf(socket).afterSequence).toBe(0n);

    socket.deliver(readyFrame(0n));
    socket.deliver(eventFrame(1n));
    socket.deliver(eventFrame(2n));

    expect(test.events.map((event) => event.sequence)).toEqual([1n, 2n]);
    const acks = socket
      .frames()
      .filter((frame) => frame.payload.case === 'ack')
      .map((frame) => (frame.payload.case === 'ack' ? frame.payload.value.sequence : -1n));
    expect(acks).toEqual([1n, 2n]);
    // Ready is what says the socket is live; the events do not re-announce it.
    expect(test.statuses.map((state) => state.status)).toEqual([
      'connecting',
      'live',
      'live',
      'live',
    ]);
    expect(test.statuses.at(-1)?.lastSequence).toBe(2);
  });

  it('resumes the next socket from the last applied sequence', () => {
    const test = harness();
    test.client.start();
    const first = test.latest();
    first.open();
    first.deliver(readyFrame(0n));
    first.deliver(eventFrame(1n));
    first.deliver(eventFrame(2n));
    first.drop();
    test.flushTimers();

    const second = test.latest();
    second.open();
    expect(second).not.toBe(first);
    expect(helloOf(second).afterSequence).toBe(2n);
  });

  it('drops an event the resume replayed twice', () => {
    const test = harness();
    test.client.start();
    const first = test.latest();
    first.open();
    first.deliver(readyFrame(0n));
    first.deliver(eventFrame(1n));
    first.deliver(eventFrame(2n));
    first.drop();
    test.flushTimers();

    const second = test.latest();
    second.open();
    second.deliver(readyFrame(2n));
    // The hub buffers live events across a replay, so an event published while
    // one was in flight arrives on both paths.
    second.deliver(eventFrame(2n));
    second.deliver(eventFrame(3n));

    expect(test.events.map((event) => event.sequence)).toEqual([1n, 2n, 3n]);
    const acks = second.frames().filter((frame) => frame.payload.case === 'ack');
    expect(acks).toHaveLength(1);
  });

  it('takes a snapshot when the retained log no longer covers the resume point', async () => {
    const asked: bigint[] = [];
    const test = harness({
      onResync: async (resync) => {
        asked.push(resync.earliestAvailableSequence);
        return { afterSequence: 90n };
      },
    });
    test.client.start();
    const first = test.latest();
    first.open();
    first.deliver(readyFrame(0n));
    first.deliver(resyncFrame(0n, 50n));

    // The socket is closed rather than re-greeted: a second hello on one
    // connection is `realtime.duplicate_hello`.
    expect(first.closedWith).toEqual({ code: 1000, reason: 'resync' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const second = test.latest();
    expect(second).not.toBe(first);
    second.open();
    expect(asked).toEqual([50n]);
    expect(helloOf(second).afterSequence).toBe(90n);
    expect(test.statuses.at(-1)?.resyncCount).toBe(1);
  });

  it('falls back to the oldest retained sequence when no snapshot exists', async () => {
    const test = harness({ onResync: async () => null });
    test.client.start();
    const first = test.latest();
    first.open();
    first.deliver(readyFrame(0n));
    first.deliver(resyncFrame(0n, 50n));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    test.latest().open();
    expect(helloOf(test.latest()).afterSequence).toBe(49n);
  });

  it('backs off between reconnects and stops widening at the last step', () => {
    const test = harness();
    test.client.start();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      test.latest().open();
      test.latest().drop();
      test.flushTimers();
    }
    expect(test.backoffDelays()).toEqual([10, 20, 40, 40]);
  });

  it('restarts the backoff only once the server has greeted the socket', () => {
    const test = harness();
    test.client.start();
    // Two sockets the server closes before `ServerReady`. A client that reset
    // on connect rather than on greeting would dial at 10 ms for ever.
    test.latest().open();
    test.latest().drop();
    test.flushTimers();
    test.latest().open();
    test.latest().drop();
    test.flushTimers();
    expect(test.backoffDelays()).toEqual([10, 20]);

    test.latest().open();
    test.latest().deliver(readyFrame(0n));
    test.latest().drop();
    test.flushTimers();
    expect(test.backoffDelays()).toEqual([10, 20, 10]);
  });

  it('stops for good on teardown and opens no further socket', () => {
    const test = harness();
    test.client.start();
    test.latest().open();
    test.latest().deliver(readyFrame(0n));
    const socket = test.latest();

    test.client.stop();

    expect(socket.closedWith).toEqual({ code: 1000, reason: 'client stopped' });
    expect(test.statuses.at(-1)?.status).toBe('off');
    // A close arriving after the stop must not resurrect the client.
    socket.drop();
    test.flushTimers();
    expect(test.sockets).toHaveLength(1);
  });

  it('does not reconnect on a refused credential and asks for a refresh instead', () => {
    let asked = 0;
    const test = harness({ onReauthenticationRequired: () => (asked += 1) });
    test.client.start();
    test.latest().open();
    test.latest().deliver(readyFrame(0n));
    test.latest().deliver(errorFrame('realtime.reauthentication_required'));

    expect(asked).toBe(1);
    expect(test.statuses.at(-1)?.status).toBe('off');
    test.flushTimers();
    expect(test.sockets).toHaveLength(1);
  });

  it('keeps the socket for an error naming one frame rather than the connection', () => {
    const test = harness();
    test.client.start();
    test.latest().open();
    test.latest().deliver(readyFrame(0n));
    test.latest().deliver(errorFrame('realtime.invalid_ack'));

    expect(test.latest().closedWith).toBeNull();
    expect(test.statuses.at(-1)?.status).toBe('live');
  });

  it('opens no socket at all without an identity to greet with', () => {
    const test = harness({ identity: () => null });
    test.client.start();
    expect(test.sockets).toHaveLength(0);
    expect(test.statuses.at(-1)?.status).toBe('off');
  });

  it('ignores a text frame rather than decoding it as Protobuf', () => {
    const test = harness();
    test.client.start();
    const socket = test.latest();
    socket.open();
    socket.deliver(readyFrame(0n));
    socket.onmessage?.({ data: 'not a protobuf frame' });
    expect(test.events).toHaveLength(0);
    expect(test.statuses.at(-1)?.status).toBe('live');
  });
});
