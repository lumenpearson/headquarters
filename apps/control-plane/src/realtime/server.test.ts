import type { AddressInfo } from 'node:net';

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { realtimeV1, syncV1 } from '@gremuchaya/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { startControlPlane } from '../server.js';

const allowedOrigin = 'http://127.0.0.1:3000';

describe('binary realtime WebSocket transport', () => {
  let closeControlPlane: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeControlPlane?.();
    closeControlPlane = undefined;
  });

  it('replays the missed cursor range after reconnect and streams subsequent group events', async () => {
    const running = await startControlPlane({ port: 0, allowedOrigins: [allowedOrigin] });
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;
    const baseUrl = `ws://127.0.0.1:${address.port}/realtime`;

    const first = await openRealtime(baseUrl, 0n);
    expect((await first.next()).payload.case).toBe('ready');
    running.publishGroupEvent({ groupId: 'group-01', event: groupEvent(1n) });
    expectGroupSequence(await first.next(), 1n);
    await first.close();

    running.publishGroupEvent({ groupId: 'group-01', event: groupEvent(2n) });
    const reconnected = await openRealtime(baseUrl, 1n);
    expect((await reconnected.next()).payload.case).toBe('ready');
    expectGroupSequence(await reconnected.next(), 2n);

    running.publishGroupEvent({ groupId: 'group-01', event: groupEvent(3n) });
    expectGroupSequence(await reconnected.next(), 3n);
    await reconnected.close();
  });

  it('rejects non-binary frames with a typed protocol error', async () => {
    const running = await startControlPlane({ port: 0, allowedOrigins: [allowedOrigin] });
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;
    const stream = await openSocket(`ws://127.0.0.1:${address.port}/realtime`);

    stream.socket.send('not-a-protobuf-frame');
    const frame = await stream.next();
    expect(frame.payload).toMatchObject({
      case: 'error',
      value: { code: 'realtime.binary_required', retryable: false },
    });
    await stream.close();
  });

  it('requires an explicit resync when the replay cursor falls outside retained history', async () => {
    const running = await startControlPlane({ port: 0, allowedOrigins: [allowedOrigin] });
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;
    for (let sequence = 1n; sequence <= 513n; sequence += 1n) {
      running.publishGroupEvent({ groupId: 'group-01', event: groupEvent(sequence) });
    }

    const stream = await openRealtime(`ws://127.0.0.1:${address.port}/realtime`, 0n);
    expect((await stream.next()).payload.case).toBe('ready');
    expect((await stream.next()).payload).toMatchObject({
      case: 'resyncRequired',
      value: { requestedAfterSequence: 0n, earliestAvailableSequence: 2n },
    });
    await stream.close();
  });

  it('rejects WebSocket upgrades from origins outside the control-plane allow-list', async () => {
    const running = await startControlPlane({ port: 0, allowedOrigins: [allowedOrigin] });
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/realtime`, {
      origin: 'https://untrusted.example',
    });

    const statusCode = await new Promise<number>((resolveStatus, rejectStatus) => {
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolveStatus(response.statusCode ?? 0);
      });
      socket.once('open', () =>
        rejectStatus(new Error('Untrusted origin unexpectedly opened a socket.')),
      );
      socket.once('error', () => undefined);
    });
    expect(statusCode).toBe(403);
  });
});

async function openRealtime(baseUrl: string, afterSequence: bigint): Promise<RealtimeTestStream> {
  const stream = await openSocket(baseUrl);
  stream.socket.send(
    toBinary(
      realtimeV1.RealtimeClientFrameSchema,
      create(realtimeV1.RealtimeClientFrameSchema, {
        payload: {
          case: 'hello',
          value: {
            groupId: { value: 'group-01' },
            deviceId: { value: 'device-01' },
            afterSequence,
          },
        },
      }),
    ),
  );
  return stream;
}

async function openSocket(url: string): Promise<RealtimeTestStream> {
  const socket = new WebSocket(url, { origin: allowedOrigin });
  const queue: realtimeV1.RealtimeServerFrame[] = [];
  const waiters: Array<(frame: realtimeV1.RealtimeServerFrame) => void> = [];
  socket.on('message', (raw, isBinary) => {
    if (!isBinary) throw new Error('Expected a binary WebSocket frame.');
    const frame = fromBinary(realtimeV1.RealtimeServerFrameSchema, toBytes(raw));
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(frame);
    else waiter(frame);
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen);
    socket.once('error', rejectOpen);
  });

  return {
    socket,
    next: () => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolveFrame) => waiters.push(resolveFrame));
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolveClose();
          return;
        }
        socket.once('close', () => resolveClose());
        socket.close(1000, 'test complete');
      }),
  };
}

interface RealtimeTestStream {
  readonly socket: WebSocket;
  readonly next: () => Promise<realtimeV1.RealtimeServerFrame>;
  readonly close: () => Promise<void>;
}

function groupEvent(sequence: bigint): syncV1.GroupEvent {
  return create(syncV1.GroupEventSchema, {
    sequence,
    kind: syncV1.GroupEventKind.DOCUMENT_DELTA,
  });
}

function expectGroupSequence(frame: realtimeV1.RealtimeServerFrame, sequence: bigint): void {
  expect(frame.payload.case).toBe('groupEvent');
  if (frame.payload.case !== 'groupEvent') throw new Error('Expected group event frame.');
  expect(frame.payload.value.event?.sequence).toBe(sequence);
}

function toBytes(raw: WebSocket.RawData): Uint8Array {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return raw;
}
