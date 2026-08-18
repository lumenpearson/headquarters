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

export interface RealtimeTransport {
  publish(event: GroupEventPublication): void;
  close(): Promise<void>;
}

/**
 * Attaches the binary Protobuf realtime endpoint to the same HTTP server as
 * ConnectRPC. Authentication/pairing validation is deliberately kept outside
 * this transport; it is added by the SyncService once device credentials are
 * persisted. Until then, this endpoint is a local development foundation and
 * validates only the protocol envelope, origin allow-list, and group/device IDs.
 */
export function attachRealtimeTransport(
  server: HttpServer,
  config: ControlPlaneConfig,
  hub = new RealtimeHub(),
): RealtimeTransport {
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxRealtimeFrameBytes,
  });

  server.on('upgrade', (request, socket, head) => {
    if (!isRealtimeUpgrade(request, config)) {
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

    const dispose = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      subscribedGroupId = undefined;
    };

    websocket.on('message', (raw, isBinary) => {
      if (!isBinary) {
        sendError(
          websocket,
          'realtime.binary_required',
          'Realtime frames must use binary Protobuf.',
        );
        return;
      }

      let frame: realtimeV1.RealtimeClientFrame;
      try {
        frame = fromBinary(realtimeV1.RealtimeClientFrameSchema, rawDataToBytes(raw));
      } catch {
        sendError(websocket, 'realtime.invalid_frame', 'Realtime frame could not be decoded.');
        return;
      }

      if (frame.payload.case === 'hello') {
        if (unsubscribe !== undefined) {
          sendError(websocket, 'realtime.duplicate_hello', 'A connection can subscribe only once.');
          return;
        }
        const groupId = frame.payload.value.groupId?.value.trim();
        const deviceId = frame.payload.value.deviceId?.value.trim();
        if (
          groupId === undefined ||
          groupId.length === 0 ||
          deviceId === undefined ||
          deviceId.length === 0
        ) {
          sendError(
            websocket,
            'realtime.invalid_hello',
            'Client hello must include non-empty group_id and device_id values.',
          );
          return;
        }
        subscribedGroupId = groupId;
        unsubscribe = hub.subscribe({
          groupId,
          afterSequence: frame.payload.value.afterSequence,
          send: (serverFrame) => sendFrame(websocket, serverFrame),
        });
        return;
      }

      if (frame.payload.case === 'ack') {
        const acknowledgedGroupId = frame.payload.value.groupId?.value;
        if (subscribedGroupId === undefined || acknowledgedGroupId !== subscribedGroupId) {
          sendError(
            websocket,
            'realtime.invalid_ack',
            'Acknowledgement does not match the active group.',
          );
        }
        return;
      }

      if (frame.payload.case === 'ping') {
        sendFrame(
          websocket,
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

      sendError(websocket, 'realtime.empty_frame', 'Realtime frame has no supported payload.');
    });

    websocket.once('close', dispose);
    websocket.once('error', dispose);
  });

  return {
    publish: (event) => hub.publish(event),
    close: () => closeWebSocketServer(websocketServer),
  };
}

function hasRealtimePath(request: IncomingMessage): boolean {
  return requestPath(request) === realtimePath;
}

function isRealtimeUpgrade(request: IncomingMessage, config: ControlPlaneConfig): boolean {
  if (!hasRealtimePath(request)) return false;
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
