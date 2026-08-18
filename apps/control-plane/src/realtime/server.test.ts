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

  it('serializes revoked-editor delivery so no later group event leaks and reauthentication is required', async () => {
    const { runtime, owner, ownerAuthenticated, editor } = createPairedEditorRuntime();
    const running = await startControlPlane(
      { port: 0, allowedOrigins: [allowedOrigin] },
      {
        realtime: {
          admission: createPairedDeviceRealtimeAdmission(runtime),
          revalidationIntervalMs: 10,
        },
      },
    );
    closeControlPlane = running.close;
    const baseUrl = realtimeBaseUrl(running.server.address() as AddressInfo);
    const editorStream = await openRealtime(baseUrl, 0n, {
      groupId: owner.group.id,
      deviceId: editor.device.id,
      accessToken: editor.session.accessToken,
    });
    expect((await editorStream.next()).payload.case).toBe('ready');

    runtime.revokeDevice(ownerAuthenticated, owner.group.id, editor.device.id);
    running.publishGroupEvent({ groupId: owner.group.id, event: groupEvent(1n) });

    const closed = await closeWithin(editorStream);
    expect(closed.code).toBe(1008);
    expect(editorStream.receivedFrames().some(isGroupEventFrame)).toBe(false);
    expect(editorStream.receivedFrames()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            case: 'error',
            value: expect.objectContaining({ code: 'realtime.reauthentication_required' }),
          }),
        }),
      ]),
    );

    const retry = await openSocket(baseUrl);
    sendHello(retry.socket, {
      groupId: owner.group.id,
      deviceId: editor.device.id,
      accessToken: editor.session.accessToken,
    });
    expect((await retry.next()).payload).toMatchObject({
      case: 'error',
      value: { code: 'realtime.unauthenticated', retryable: false },
    });
    expect((await closeWithin(retry)).code).toBe(1008);
  });

  it('invalidates a socket whose fresh access token is revoked by refresh-token replay', async () => {
    const { runtime, owner, editor } = createPairedEditorRuntime();
    const refreshed = runtime.refreshDeviceSession(editor.session.refreshToken);
    const running = await startControlPlane(
      { port: 0, allowedOrigins: [allowedOrigin] },
      {
        realtime: {
          admission: createPairedDeviceRealtimeAdmission(runtime),
          revalidationIntervalMs: 60_000,
        },
      },
    );
    closeControlPlane = running.close;
    const baseUrl = realtimeBaseUrl(running.server.address() as AddressInfo);
    const stream = await openRealtime(baseUrl, 0n, {
      groupId: owner.group.id,
      deviceId: editor.device.id,
      accessToken: refreshed.accessToken,
    });
    expect((await stream.next()).payload.case).toBe('ready');

    expect(() => runtime.refreshDeviceSession(editor.session.refreshToken)).toThrow(
      'refresh token is invalid',
    );
    running.publishGroupEvent({ groupId: owner.group.id, event: groupEvent(1n) });

    expect((await closeWithin(stream)).code).toBe(1008);
    expect(stream.receivedFrames().some(isGroupEventFrame)).toBe(false);
    expect(stream.receivedFrames()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            case: 'error',
            value: expect.objectContaining({ code: 'realtime.reauthentication_required' }),
          }),
        }),
      ]),
    );
  });

  it('invalidates a socket after its access token expires', async () => {
    let now = new Date('2026-08-18T12:00:00.000Z');
    const { runtime, owner, editor } = createPairedEditorRuntime({
      now: () => now,
      accessTokenLifetimeMs: 50,
    });
    const running = await startControlPlane(
      { port: 0, allowedOrigins: [allowedOrigin] },
      {
        realtime: {
          admission: createPairedDeviceRealtimeAdmission(runtime),
          revalidationIntervalMs: 60_000,
        },
      },
    );
    closeControlPlane = running.close;
    const stream = await openRealtime(
      realtimeBaseUrl(running.server.address() as AddressInfo),
      0n,
      {
        groupId: owner.group.id,
        deviceId: editor.device.id,
        accessToken: editor.session.accessToken,
      },
    );
    expect((await stream.next()).payload.case).toBe('ready');

    now = new Date(now.getTime() + 50);
    running.publishGroupEvent({ groupId: owner.group.id, event: groupEvent(1n) });

    expect((await closeWithin(stream)).code).toBe(1008);
    expect(stream.receivedFrames().some(isGroupEventFrame)).toBe(false);
  });

  it('periodically invalidates an idle revoked paired-device socket without waiting for another event', async () => {
    const { runtime, owner, ownerAuthenticated, editor } = createPairedEditorRuntime();
    const running = await startControlPlane(
      { port: 0, allowedOrigins: [allowedOrigin] },
      {
        realtime: {
          admission: createPairedDeviceRealtimeAdmission(runtime),
          revalidationIntervalMs: 10,
        },
      },
    );
    closeControlPlane = running.close;
    const editorStream = await openRealtime(
      realtimeBaseUrl(running.server.address() as AddressInfo),
      0n,
      {
        groupId: owner.group.id,
        deviceId: editor.device.id,
        accessToken: editor.session.accessToken,
      },
    );
    expect((await editorStream.next()).payload.case).toBe('ready');

    runtime.revokeDevice(ownerAuthenticated, owner.group.id, editor.device.id);

    expect((await closeWithin(editorStream)).code).toBe(1008);
    expect(editorStream.receivedFrames().some(isGroupEventFrame)).toBe(false);
  });

  it('revalidates every protected outbound frame and inbound acknowledgement or ping', async () => {
    const validations: Array<{ accessToken: string; groupId: string; deviceId: string }> = [];
    const running = await startControlPlane(
      { port: 0, allowedOrigins: [allowedOrigin] },
      {
        realtime: {
          admission: {
            admit: () => true,
            revalidate: (input) => {
              validations.push(input);
              return true;
            },
          },
          revalidationIntervalMs: 60_000,
        },
      },
    );
    closeControlPlane = running.close;
    const baseUrl = realtimeBaseUrl(running.server.address() as AddressInfo);
    const stream = await openRealtime(baseUrl, 0n, {
      groupId: 'group-01',
      deviceId: 'device-01',
      accessToken: 'opaque-access-token',
    });
    expect((await stream.next()).payload.case).toBe('ready');
    expect(validations).toEqual([
      { accessToken: 'opaque-access-token', groupId: 'group-01', deviceId: 'device-01' },
    ]);

    running.publishGroupEvent({ groupId: 'group-01', event: groupEvent(1n) });
    expectGroupSequence(await stream.next(), 1n);
    await waitFor(() => validations.length === 2);

    sendAck(stream.socket, 'group-01', 1n);
    await waitFor(() => validations.length === 3);

    sendPing(stream.socket, 42n);
    expect((await stream.next()).payload).toMatchObject({
      case: 'pong',
      value: { clientMonotonicMs: 42n },
    });
    await waitFor(() => validations.length === 4);
    await stream.close();
  });

  it('fails closed with a legacy admission implementation that only supplies admit', async () => {
    let allowed = true;
    const running = await startControlPlane(
      { port: 0, allowedOrigins: [allowedOrigin] },
      {
        realtime: {
          admission: { admit: () => allowed },
          revalidationIntervalMs: 60_000,
        },
      },
    );
    closeControlPlane = running.close;
    const stream = await openRealtime(
      realtimeBaseUrl(running.server.address() as AddressInfo),
      0n,
      {
        groupId: 'group-01',
        deviceId: 'device-01',
        accessToken: 'legacy-opaque-access-token',
      },
    );
    expect((await stream.next()).payload.case).toBe('ready');

    allowed = false;
    running.publishGroupEvent({ groupId: 'group-01', event: groupEvent(1n) });

    expect((await closeWithin(stream)).code).toBe(1008);
    expect(stream.receivedFrames().some(isGroupEventFrame)).toBe(false);
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

function createPairedEditorRuntime(
  options: Partial<ConstructorParameters<typeof PairedDeviceRuntime>[0]> = {},
) {
  const runtime = new PairedDeviceRuntime({
    tokenPepper: 'test-token-pepper-with-at-least-thirty-two-characters',
    ...options,
  });
  const owner = runtime.createGroup({
    name: 'Realtime group',
    initialDevice: {
      name: 'Realtime owner',
      publicKey: 'ed25519:realtime-owner',
      platform: 'windows',
      applicationVersion: '0.1.0',
    },
  });
  const ownerAuthenticated = runtime.authenticateAccessToken(owner.session.accessToken);
  const editor = runtime.pairDevice({
    pairingCode: runtime.createPairingCode(ownerAuthenticated, owner.group.id, 'EDITOR').code,
    name: 'Realtime editor',
    publicKey: 'ed25519:realtime-editor',
    platform: 'windows',
    applicationVersion: '0.1.0',
  });
  return { runtime, owner, ownerAuthenticated, editor };
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

function sendAck(socket: WebSocket, groupId: string, sequence: bigint): void {
  socket.send(
    toBinary(
      realtimeV1.RealtimeClientFrameSchema,
      create(realtimeV1.RealtimeClientFrameSchema, {
        payload: { case: 'ack', value: { groupId: { value: groupId }, sequence } },
      }),
    ),
  );
}

function sendPing(socket: WebSocket, clientMonotonicMs: bigint): void {
  socket.send(
    toBinary(
      realtimeV1.RealtimeClientFrameSchema,
      create(realtimeV1.RealtimeClientFrameSchema, {
        payload: { case: 'ping', value: { clientMonotonicMs } },
      }),
    ),
  );
}

async function openSocket(url: string): Promise<RealtimeTestStream> {
  const socket = new WebSocket(url, { origin: allowedOrigin });
  const queue: realtimeV1.RealtimeServerFrame[] = [];
  const received: realtimeV1.RealtimeServerFrame[] = [];
  const waiters: Array<(frame: realtimeV1.RealtimeServerFrame) => void> = [];
  const closeWaiters: Array<(info: RealtimeCloseInfo) => void> = [];
  let closeInfo: RealtimeCloseInfo | undefined;
  socket.on('message', (raw, isBinary) => {
    if (!isBinary) throw new Error('Expected a binary WebSocket frame.');
    const frame = fromBinary(realtimeV1.RealtimeServerFrameSchema, toBytes(raw));
    received.push(frame);
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(frame);
    else waiter(frame);
  });
  socket.on('close', (code, reason) => {
    closeInfo = { code, reason: reason.toString() };
    for (const resolveClose of closeWaiters.splice(0)) resolveClose(closeInfo);
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen);
    socket.once('error', rejectOpen);
  });

  const waitForClose = (): Promise<RealtimeCloseInfo> => {
    if (closeInfo !== undefined) return Promise.resolve(closeInfo);
    return new Promise((resolveClose) => closeWaiters.push(resolveClose));
  };

  return {
    socket,
    next: () => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolveFrame) => waiters.push(resolveFrame));
    },
    receivedFrames: () => [...received],
    waitForClose,
    close: async () => {
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'test complete');
      await waitForClose();
    },
  };
}

interface RealtimeCloseInfo {
  readonly code: number;
  readonly reason: string;
}

interface RealtimeTestStream {
  readonly socket: WebSocket;
  readonly next: () => Promise<realtimeV1.RealtimeServerFrame>;
  readonly receivedFrames: () => readonly realtimeV1.RealtimeServerFrame[];
  readonly waitForClose: () => Promise<RealtimeCloseInfo>;
  readonly close: () => Promise<void>;
}

async function closeWithin(
  stream: RealtimeTestStream,
  timeoutMs = 1_000,
): Promise<RealtimeCloseInfo> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stream.waitForClose(),
      new Promise<RealtimeCloseInfo>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Realtime socket did not close within ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Condition did not become true within ${timeoutMs} ms.`);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}

function groupEvent(sequence: bigint): syncV1.GroupEvent {
  return create(syncV1.GroupEventSchema, {
    sequence,
    kind: syncV1.GroupEventKind.DOCUMENT_DELTA,
  });
}

function isGroupEventFrame(frame: realtimeV1.RealtimeServerFrame): boolean {
  return frame.payload.case === 'groupEvent';
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
