import type { AddressInfo } from 'node:net';

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { realtimeV1, syncV1 } from '@gremuchaya/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { startControlPlane } from '../server.js';
import { createPairedDeviceRealtimeAdmission } from '../sync/realtime-admission.js';
import { PairedDeviceRuntime } from '../sync/runtime.js';

const allowedOrigin = 'http://127.0.0.1:3000';

describe('binary realtime WebSocket transport', () => {
  let closeControlPlane: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeControlPlane?.();
    closeControlPlane = undefined;
  });

  it('does not expose realtime without explicit authenticated admission or development mode', async () => {
    const running = await startControlPlane({ port: 0, allowedOrigins: [allowedOrigin] });
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;

    await expectUpgradeStatus(`ws://127.0.0.1:${address.port}/realtime`, 403);
  });

  it('replays the missed cursor range after reconnect and streams subsequent group events', async () => {
    const running = await startDevelopmentRealtime();
    closeControlPlane = running.close;
    const baseUrl = realtimeBaseUrl(running.server.address() as AddressInfo);

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

  it('admits only the exact paired device and group from a binary authenticated hello', async () => {
    const runtime = new PairedDeviceRuntime({
      tokenPepper: 'test-token-pepper-with-at-least-thirty-two-characters',
    });
    const created = runtime.createGroup({
      name: 'Realtime group',
      initialDevice: {
        name: 'Realtime workstation',
        publicKey: 'ed25519:realtime',
        platform: 'windows',
        applicationVersion: '0.1.0',
      },
    });
    const running = await startControlPlane(
      { port: 0, allowedOrigins: [allowedOrigin] },
      { realtime: { admission: createPairedDeviceRealtimeAdmission(runtime) } },
    );
    closeControlPlane = running.close;
    const baseUrl = realtimeBaseUrl(running.server.address() as AddressInfo);

    const admitted = await openRealtime(baseUrl, 0n, {
      groupId: created.group.id,
      deviceId: created.device.id,
      accessToken: created.session.accessToken,
    });
    expect((await admitted.next()).payload.case).toBe('ready');
    await admitted.close();

    const rejected = await openSocket(baseUrl);
    sendHello(rejected.socket, {
      groupId: 'wrong-group',
      deviceId: created.device.id,
      accessToken: created.session.accessToken,
    });
    expect((await rejected.next()).payload).toMatchObject({
      case: 'error',
      value: { code: 'realtime.unauthenticated', retryable: false },
    });
    await rejected.close();

    const beforeHello = await openSocket(baseUrl);
    beforeHello.socket.send(
      toBinary(
        realtimeV1.RealtimeClientFrameSchema,
        create(realtimeV1.RealtimeClientFrameSchema, {
          payload: { case: 'ping', value: { clientMonotonicMs: 1n } },
        }),
      ),
    );
    expect((await beforeHello.next()).payload).toMatchObject({
      case: 'error',
      value: { code: 'realtime.admission_required', retryable: false },
    });
    await beforeHello.close();
  });

  it('rejects non-binary frames with a typed protocol error', async () => {
    const running = await startDevelopmentRealtime();
    closeControlPlane = running.close;
    const stream = await openSocket(realtimeBaseUrl(running.server.address() as AddressInfo));

    stream.socket.send('not-a-protobuf-frame');
    const frame = await stream.next();
    expect(frame.payload).toMatchObject({
      case: 'error',
      value: { code: 'realtime.binary_required', retryable: false },
    });
    await stream.close();
  });

  it('requires an explicit resync when the replay cursor falls outside retained history', async () => {
    const running = await startDevelopmentRealtime();
    closeControlPlane = running.close;
    const baseUrl = realtimeBaseUrl(running.server.address() as AddressInfo);
    for (let sequence = 1n; sequence <= 513n; sequence += 1n) {
      running.publishGroupEvent({ groupId: 'group-01', event: groupEvent(sequence) });
    }

    const stream = await openRealtime(baseUrl, 0n);
    expect((await stream.next()).payload.case).toBe('ready');
    expect((await stream.next()).payload).toMatchObject({
      case: 'resyncRequired',
      value: { requestedAfterSequence: 0n, earliestAvailableSequence: 2n },
    });
    await stream.close();
  });

  it('rejects WebSocket upgrades from origins outside the control-plane allow-list', async () => {
    const running = await startDevelopmentRealtime();
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

async function startDevelopmentRealtime() {
  const running = await startControlPlane(
    { port: 0, allowedOrigins: [allowedOrigin] },
    { realtime: { allowUnauthenticatedDevelopment: true } },
  );
  return running;
}

function realtimeBaseUrl(address: AddressInfo): string {
  return `ws://127.0.0.1:${address.port}/realtime`;
}

async function expectUpgradeStatus(url: string, expectedStatus: number): Promise<void> {
  const socket = new WebSocket(url, { origin: allowedOrigin });
  const statusCode = await new Promise<number>((resolveStatus, rejectStatus) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolveStatus(response.statusCode ?? 0);
    });
    socket.once('open', () => rejectStatus(new Error('Unexpectedly opened a realtime socket.')));
    socket.once('error', () => undefined);
  });
  expect(statusCode).toBe(expectedStatus);
}

async function openRealtime(
  baseUrl: string,
  afterSequence: bigint,
  hello: Partial<RealtimeHello> = {},
): Promise<RealtimeTestStream> {
  const stream = await openSocket(baseUrl);
  sendHello(stream.socket, { afterSequence, ...hello });
  return stream;
}

function sendHello(socket: WebSocket, hello: Partial<RealtimeHello> = {}): void {
  socket.send(
    toBinary(
      realtimeV1.RealtimeClientFrameSchema,
      create(realtimeV1.RealtimeClientFrameSchema, {
        payload: {
          case: 'hello',
          value: {
            groupId: { value: hello.groupId ?? 'group-01' },
            deviceId: { value: hello.deviceId ?? 'device-01' },
            afterSequence: hello.afterSequence ?? 0n,
            accessToken: hello.accessToken ?? '',
          },
        },
      }),
    ),
  );
}

interface RealtimeHello {
  readonly groupId: string;
  readonly deviceId: string;
  readonly afterSequence: bigint;
  readonly accessToken: string;
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
