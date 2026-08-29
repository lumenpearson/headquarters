import type { IncomingMessage, Server as HttpServer } from 'node:http';

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { timestampNow } from '@bufbuild/protobuf/wkt';
import { realtimeV1 } from '@gremuchaya/protocol';
import type { syncV1 } from '@gremuchaya/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type { ControlPlaneConfig } from '../config.js';

import { RealtimeHub, type GroupEventPublication } from './hub.js';

const realtimePath = '/realtime';
const maxRealtimeFrameBytes = 64 * 1024;
const policyViolationCloseCode = 1008;
const minimumRevalidationIntervalMs = 10;
const maximumRevalidationIntervalMs = 60_000;

/**
 * A short idle check bounds the period for which an otherwise inactive socket
 * can retain a credential that was revoked or expired after ClientHello.
 */
export const defaultRealtimeRevalidationIntervalMs = 15_000;

export interface RealtimeAdmissionInput {
  readonly accessToken: string;
  readonly groupId: string;
  readonly deviceId: string;
}

export interface RealtimeAdmission {
  /**
   * Confirms that an opaque bearer token belongs to the exact group/device
   * pair in a binary ClientHello. Implementations must not log raw tokens.
   */
  admit(input: RealtimeAdmissionInput): boolean | Promise<boolean>;
  /**
   * Re-checks an admitted connection before protected inbound and outbound
   * work. It is optional for compatibility: the transport falls back to
   * `admit` when it is not supplied, which preserves fail-closed behavior.
   */
  revalidate?(input: RealtimeAdmissionInput): boolean | Promise<boolean>;
}

export interface RealtimeTransportOptions {
  readonly hub?: RealtimeHub;
  readonly admission?: RealtimeAdmission;
  /**
   * Bounded idle authorization re-check interval. Values from 10 ms through
   * 60 s are accepted; the production-safe default is 15 s.
   */
  readonly revalidationIntervalMs?: number;
  /**
   * Test/local-development escape hatch. Production callers must provide an
   * admission implementation instead; the default is to expose no realtime
   * endpoint at all.
   */
  readonly allowUnauthenticatedDevelopment?: boolean;
}

export interface RealtimeTransport {
  publish(event: GroupEventPublication): Promise<syncV1.GroupEvent>;
  close(): Promise<void>;
}

/**
 * Attaches a binary Protobuf realtime endpoint to the same HTTP server as
 * ConnectRPC. Realtime is intentionally disabled unless an authenticated
 * admission collaborator or an explicit local-development escape hatch is
 * supplied. This prevents an enabled SyncService from silently retaining the
 * old arbitrary group/device subscription behavior.
 */
export function attachRealtimeTransport(
  server: HttpServer,
  config: ControlPlaneConfig,
  options: RealtimeTransportOptions = {},
): RealtimeTransport {
  const hub = options.hub ?? new RealtimeHub();
  const revalidationIntervalMs = normalizeRevalidationIntervalMs(options.revalidationIntervalMs);
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxRealtimeFrameBytes,
  });

  server.on('upgrade', (request, socket, head) => {
    if (!isRealtimeUpgrade(request, config, options)) {
      const status = hasRealtimePath(request) ? '403 Forbidden' : '404 Not Found';
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request);
    });
  });

  websocketServer.on('connection', (websocket) => {
    let unsubscribe: (() => void) | undefined;
    let subscribedGroupId: string | undefined;
    let helloPending = false;
    let admitted = false;
    let admissionInput: RealtimeAdmissionInput | undefined;
    let revalidationTimer: ReturnType<typeof setInterval> | undefined;
    let periodicRevalidationPending = false;
    // Bumped by every teardown. Subscribing is asynchronous now, so a close that
    // lands inside `hub.subscribe` would otherwise be followed by the resolved
    // unsubscribe being stored on a connection nobody will ever tear down again.
    let admissionGeneration = 0;
    const enqueue = createSerializedWorkQueue();

    const clearAdmission = () => {
      admissionGeneration += 1;
      unsubscribe?.();
      unsubscribe = undefined;
      subscribedGroupId = undefined;
      helloPending = false;
      admitted = false;
      // Raw bearer material never escapes this connection-local closure.
      admissionInput = undefined;
      periodicRevalidationPending = false;
      if (revalidationTimer !== undefined) {
        clearInterval(revalidationTimer);
        revalidationTimer = undefined;
      }
    };

    const enqueueSafely = (operation: RealtimeOperation) => {
      void enqueue(operation).catch(() => {
        clearAdmission();
        sendError(websocket, 'realtime.internal', 'Realtime admission failed.');
        closeForPolicyViolation(websocket);
      });
    };

    const startPeriodicRevalidation = () => {
      if (options.admission === undefined || revalidationTimer !== undefined) return;
      revalidationTimer = setInterval(() => {
        if (periodicRevalidationPending || !admitted) return;
        periodicRevalidationPending = true;
        enqueueSafely(async () => {
          try {
            await revalidateAdmittedConnection(connectionContext);
          } finally {
            periodicRevalidationPending = false;
          }
        });
      }, revalidationIntervalMs);
      revalidationTimer.unref?.();
    };

    const connectionContext: RealtimeConnectionContext = {
      websocket,
      admission: options.admission,
      allowUnauthenticatedDevelopment: options.allowUnauthenticatedDevelopment === true,
      getState: () => ({ subscribedGroupId, helloPending, admitted }),
      setState: (state) => {
        subscribedGroupId = state.subscribedGroupId;
        helloPending = state.helloPending;
        admitted = state.admitted;
      },
      getAdmissionInput: () => admissionInput,
      setAdmissionInput: (input) => {
        admissionInput = input;
      },
      invalidateAdmission: clearAdmission,
      startPeriodicRevalidation,
      subscribe: async (groupId, afterSequence) => {
        const generation = admissionGeneration;
        const release = await hub.subscribe({
          groupId,
          afterSequence,
          send: (serverFrame) =>
            enqueueSafely(() => deliverAuthorizedFrame(connectionContext, serverFrame)),
        });
        if (generation !== admissionGeneration) {
          release();
          return;
        }
        unsubscribe = release;
      },
    };

    websocket.on('message', (raw, isBinary) => {
      enqueueSafely(() =>
        handleRealtimeMessage({
          ...connectionContext,
          raw,
          isBinary,
        }),
      );
    });

    websocket.once('close', clearAdmission);
    websocket.once('error', clearAdmission);
  });

  return {
    publish: (event) => hub.publish(event),
    // The sockets are closed before the hub is: a cross-process replay still in
    // flight has nowhere to deliver once its connections are gone, and closing
    // the carrier first would leave that replay running past shutdown.
    close: async () => {
      await closeWebSocketServer(websocketServer);
      await hub.close();
    },
  };
}

type RealtimeOperation = () => void | Promise<void>;

interface RealtimeConnectionContext {
  readonly websocket: WebSocket;
  readonly admission: RealtimeAdmission | undefined;
  readonly allowUnauthenticatedDevelopment: boolean;
  readonly getState: () => RealtimeConnectionState;
  readonly setState: (state: RealtimeConnectionState) => void;
  /** Connection-local bearer material; never log or serialize this value. */
  readonly getAdmissionInput: () => RealtimeAdmissionInput | undefined;
  readonly setAdmissionInput: (input: RealtimeAdmissionInput | undefined) => void;
  readonly invalidateAdmission: () => void;
  readonly startPeriodicRevalidation: () => void;
  readonly subscribe: (groupId: string, afterSequence: bigint) => Promise<void>;
}

interface RealtimeMessageContext extends RealtimeConnectionContext {
  readonly raw: RawData;
  readonly isBinary: boolean;
}

interface RealtimeConnectionState {
  readonly subscribedGroupId: string | undefined;
  readonly helloPending: boolean;
  readonly admitted: boolean;
}

async function handleRealtimeMessage(context: RealtimeMessageContext): Promise<void> {
  if (!context.isBinary) {
    sendError(
      context.websocket,
      'realtime.binary_required',
      'Realtime frames must use binary Protobuf.',
    );
    return;
  }

  let frame: realtimeV1.RealtimeClientFrame;
  try {
    frame = fromBinary(realtimeV1.RealtimeClientFrameSchema, rawDataToBytes(context.raw));
  } catch {
    sendError(context.websocket, 'realtime.invalid_frame', 'Realtime frame could not be decoded.');
    return;
  }

  if (frame.payload.case === 'hello') {
    await handleHello(context, frame.payload.value);
    return;
  }

  if (frame.payload.case === 'ack') {
    const state = context.getState();
    if (!state.admitted || state.subscribedGroupId === undefined) {
      rejectBeforeAdmission(context.websocket);
      return;
    }
    if (!(await revalidateAdmittedConnection(context))) return;
    if (frame.payload.value.groupId?.value !== context.getState().subscribedGroupId) {
      sendError(
        context.websocket,
        'realtime.invalid_ack',
        'Acknowledgement does not match the active group.',
      );
    }
    return;
  }

  if (frame.payload.case === 'ping') {
    const state = context.getState();
    if (!state.admitted) {
      rejectBeforeAdmission(context.websocket);
      return;
    }
    if (!(await revalidateAdmittedConnection(context))) return;
    sendFrame(
      context.websocket,
      create(realtimeV1.RealtimeServerFrameSchema, {
        payload: {
          case: 'pong',
          value: {
            clientMonotonicMs: frame.payload.value.clientMonotonicMs,
            serverTime: timestampNow(),
          },
        },
      }),
    );
    return;
  }

  sendError(context.websocket, 'realtime.empty_frame', 'Realtime frame has no supported payload.');
}

async function handleHello(
  context: RealtimeMessageContext,
  hello: realtimeV1.ClientHello,
): Promise<void> {
  const state = context.getState();
  if (state.admitted || state.helloPending) {
    sendError(
      context.websocket,
      'realtime.duplicate_hello',
      'A connection can subscribe only once.',
    );
    return;
  }

  const groupId = hello.groupId?.value.trim();
  const deviceId = hello.deviceId?.value.trim();
  if (
    groupId === undefined ||
    groupId.length === 0 ||
    deviceId === undefined ||
    deviceId.length === 0
  ) {
    sendError(
      context.websocket,
      'realtime.invalid_hello',
      'Client hello must include non-empty group_id and device_id values.',
    );
    return;
  }

  const admissionInput: RealtimeAdmissionInput = {
    accessToken: hello.accessToken,
    groupId,
    deviceId,
  };
  context.setState({ ...state, helloPending: true });
  try {
    if (context.admission !== undefined) {
      const admitted = await context.admission.admit(admissionInput);
      if (!admitted) {
        sendError(
          context.websocket,
          'realtime.unauthenticated',
          'Realtime admission was rejected.',
        );
        closeForPolicyViolation(context.websocket);
        return;
      }
    } else if (!context.allowUnauthenticatedDevelopment) {
      sendError(
        context.websocket,
        'realtime.admission_required',
        'Realtime admission is required.',
      );
      closeForPolicyViolation(context.websocket);
      return;
    }

    if (context.websocket.readyState !== WebSocket.OPEN) return;
    // Store raw token material only after ClientHello succeeds, in the socket
    // closure that owns it. It is never exposed through the hub or logs.
    context.setAdmissionInput(context.admission === undefined ? undefined : admissionInput);
    context.setState({ subscribedGroupId: groupId, helloPending: false, admitted: true });
    await context.subscribe(groupId, hello.afterSequence);
    context.startPeriodicRevalidation();
  } finally {
    const after = context.getState();
    if (after.helloPending && !after.admitted) context.setState({ ...after, helloPending: false });
  }
}

/**
 * Both the hub and authorization require I/O. Each delivery is therefore queued
 * per connection: a later frame cannot overtake its revalidation, and a denial
 * removes the subscription before any group event is handed to the WebSocket.
 */
async function deliverAuthorizedFrame(
  context: RealtimeConnectionContext,
  frame: realtimeV1.RealtimeServerFrame,
): Promise<void> {
  if (!(await revalidateAdmittedConnection(context))) return;
  sendFrame(context.websocket, frame);
}

/**
 * Revalidates the exact authenticated triple before every protected operation.
 * A legacy admission implementation that only supplies `admit` stays secure:
 * `admit` is reused rather than treating the lack of `revalidate` as a pass.
 */
async function revalidateAdmittedConnection(context: RealtimeConnectionContext): Promise<boolean> {
  const state = context.getState();
  if (!state.admitted || state.subscribedGroupId === undefined) return false;
  if (context.admission === undefined) return true;

  const input = context.getAdmissionInput();
  if (input === undefined || input.groupId !== state.subscribedGroupId) {
    rejectAfterAdmission(context);
    return false;
  }

  let admitted = false;
  try {
    const validate = context.admission.revalidate ?? context.admission.admit;
    admitted = await validate(input);
  } catch {
    // Authorization provider errors fail closed and disclose no credential
    // details to the remote peer.
    admitted = false;
  }
  if (admitted) return true;

  rejectAfterAdmission(context);
  return false;
}

function rejectAfterAdmission(context: RealtimeConnectionContext): void {
  if (!context.getState().admitted) return;
  // Remove the hub listener before emitting a generic control frame. This is
  // the ordering guarantee that prevents a denied revalidation from leaking a
  // queued group event.
  context.invalidateAdmission();
  sendError(
    context.websocket,
    'realtime.reauthentication_required',
    'Realtime credentials are no longer valid. Reauthenticate and reconnect.',
  );
  closeForPolicyViolation(context.websocket);
}

function createSerializedWorkQueue(): (operation: RealtimeOperation) => Promise<void> {
  let tail = Promise.resolve();
  return (operation) => {
    const run = () => Promise.resolve(operation());
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
}

function normalizeRevalidationIntervalMs(value: number | undefined): number {
  if (value === undefined) return defaultRealtimeRevalidationIntervalMs;
  if (
    !Number.isSafeInteger(value) ||
    value < minimumRevalidationIntervalMs ||
    value > maximumRevalidationIntervalMs
  ) {
    throw new Error(
      `revalidationIntervalMs must be an integer between ${minimumRevalidationIntervalMs} and ${maximumRevalidationIntervalMs}`,
    );
  }
  return value;
}

function rejectBeforeAdmission(websocket: WebSocket): void {
  sendError(websocket, 'realtime.admission_required', 'Client hello admission is required first.');
  closeForPolicyViolation(websocket);
}

function closeForPolicyViolation(websocket: WebSocket): void {
  if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CLOSING) {
    websocket.close(policyViolationCloseCode, 'policy violation');
  }
}

function hasRealtimePath(request: IncomingMessage): boolean {
  return requestPath(request) === realtimePath;
}

function isRealtimeUpgrade(
  request: IncomingMessage,
  config: ControlPlaneConfig,
  options: RealtimeTransportOptions,
): boolean {
  if (!hasRealtimePath(request)) return false;
  if (options.admission === undefined && options.allowUnauthenticatedDevelopment !== true)
    return false;
  const origin = request.headers.origin;
  return origin === undefined || config.allowedOrigins.includes(origin);
}

function requestPath(request: IncomingMessage): string {
  const host = request.headers.host ?? 'localhost';
  return new URL(request.url ?? '/', `http://${host}`).pathname;
}

function rawDataToBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function sendFrame(websocket: WebSocket, frame: realtimeV1.RealtimeServerFrame): void {
  if (websocket.readyState === WebSocket.OPEN)
    websocket.send(toBinary(realtimeV1.RealtimeServerFrameSchema, frame));
}

function sendError(websocket: WebSocket, code: string, message: string): void {
  sendFrame(
    websocket,
    create(realtimeV1.RealtimeServerFrameSchema, {
      payload: {
        case: 'error',
        value: { code, message, retryable: false },
      },
    }),
  );
}

function closeWebSocketServer(websocketServer: WebSocketServer): Promise<void> {
  for (const client of websocketServer.clients) client.close(1001, 'control-plane shutdown');
  return new Promise<void>((resolveClose, rejectClose) => {
    websocketServer.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

export type { GroupEventPublication, syncV1 };
