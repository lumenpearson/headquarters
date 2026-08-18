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

export interface RealtimeAdmission {
  /**
   * Confirms that an opaque bearer token belongs to the exact group/device
   * pair in a binary ClientHello. Implementations must not log raw tokens.
   */
  admit(input: {
    readonly accessToken: string;
    readonly groupId: string;
    readonly deviceId: string;
  }): boolean | Promise<boolean>;
}

export interface RealtimeTransportOptions {
  readonly hub?: RealtimeHub;
  readonly admission?: RealtimeAdmission;
  /**
   * Test/local-development escape hatch. Production callers must provide an
   * admission implementation instead; the default is to expose no realtime
   * endpoint at all.
   */
  readonly allowUnauthenticatedDevelopment?: boolean;
}

export interface RealtimeTransport {
  publish(event: GroupEventPublication): void;
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

    const dispose = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      subscribedGroupId = undefined;
      helloPending = false;
      admitted = false;
    };

    websocket.on('message', (raw, isBinary) => {
      void handleRealtimeMessage({
        raw,
        isBinary,
        websocket,
        hub,
        admission: options.admission,
        allowUnauthenticatedDevelopment: options.allowUnauthenticatedDevelopment === true,
        getState: () => ({ subscribedGroupId, helloPending, admitted }),
        setState: (state) => {
          subscribedGroupId = state.subscribedGroupId;
          helloPending = state.helloPending;
          admitted = state.admitted;
        },
        subscribe: (groupId, afterSequence) => {
          subscribedGroupId = groupId;
          unsubscribe = hub.subscribe({
            groupId,
            afterSequence,
            send: (serverFrame) => sendFrame(websocket, serverFrame),
          });
        },
      }).catch(() => {
        sendError(websocket, 'realtime.internal', 'Realtime admission failed.');
        closeForPolicyViolation(websocket);
      });
    });

    websocket.once('close', dispose);
    websocket.once('error', dispose);
  });

  return {
    publish: (event) => hub.publish(event),
    close: () => closeWebSocketServer(websocketServer),
  };
}

interface RealtimeMessageContext {
  readonly raw: RawData;
  readonly isBinary: boolean;
  readonly websocket: WebSocket;
  readonly hub: RealtimeHub;
  readonly admission: RealtimeAdmission | undefined;
  readonly allowUnauthenticatedDevelopment: boolean;
  readonly getState: () => RealtimeConnectionState;
  readonly setState: (state: RealtimeConnectionState) => void;
  readonly subscribe: (groupId: string, afterSequence: bigint) => void;
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
    if (frame.payload.value.groupId?.value !== state.subscribedGroupId) {
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

  context.setState({ ...state, helloPending: true });
  try {
    if (context.admission !== undefined) {
      const admitted = await context.admission.admit({
        accessToken: hello.accessToken,
        groupId,
        deviceId,
      });
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
    context.subscribe(groupId, hello.afterSequence);
    context.setState({ subscribedGroupId: groupId, helloPending: false, admitted: true });
  } finally {
    const after = context.getState();
    if (after.helloPending && !after.admitted) context.setState({ ...after, helloPending: false });
  }
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
