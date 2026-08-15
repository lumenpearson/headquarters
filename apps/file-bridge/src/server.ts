import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { Code, ConnectError, cors, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import type { BridgeConfig, BridgeEvent, BridgeEntry } from '@gremuchaya/config';
import { EntryKind, FileBridgeService, FileEventKind } from '@gremuchaya/protocol';

import { BridgeEventHub } from './BridgeEventHub.js';
import { BridgeService } from './BridgeService.js';
import { BridgeWatcher } from './BridgeWatcher.js';
import { loadBridgeConfig } from './config.js';
import { PathSecurityError } from './pathSecurity.js';

const protocolVersion = 2 as const;
const chunkSize = 64 * 1024;

export async function startBridge(config: BridgeConfig) {
  const service = new BridgeService(config);
  const startedAt = new Date().toISOString();
  const events = new BridgeEventHub();
  const watcher = new BridgeWatcher(config, (event) => events.publish(event));
  const rpcHandler = connectNodeAdapter({
    connect: false,
    grpc: false,
    grpcWeb: true,
    routes: (router) => registerBridgeRoutes(router, service, events, startedAt),
  });
  const server = createServer((request, response) => {
    if (!prepareGrpcWebResponse(request, response, config)) return;
    void rpcHandler(request, response);
  });

  await watcher.start();
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(config.port, '127.0.0.1', () => resolveListening());
  });

  return {
    server,
    watcher,
    close: async () => {
      await watcher.close();
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      );
    },
  };
}

function registerBridgeRoutes(
  router: ConnectRouter,
  service: BridgeService,
  events: BridgeEventHub,
  startedAt: string,
): void {
  router.service(FileBridgeService, {
    health() {
      return {
        service: 'gremuchaya-file-bridge',
        protocolVersion,
        status: 'ok',
        startedAt,
        transport: 'grpc-web+protobuf',
      };
    },
    async list(request) {
      try {
        const entries = await service.list(required(request.mountId, 'mount_id'), request.path);
        return { entries: entries.map(toRpcEntry) };
      } catch (error: unknown) {
        throw toConnectError(error);
      }
    },
    async *readFile(request, context) {
      try {
        const file = await service.resolveFile(
          required(request.mountId, 'mount_id'),
          required(request.path, 'path'),
        );
        let sequence = 0;
        for await (const data of createReadStream(file.path, { highWaterMark: chunkSize })) {
          if (context.signal.aborted) return;
          yield {
            data: new Uint8Array(data),
            name: file.name,
            mimeType: file.mimeType,
            totalSize: BigInt(file.size),
            sequence,
          };
          sequence += 1;
        }
        if (sequence === 0) {
          yield {
            data: new Uint8Array(),
            name: file.name,
            mimeType: file.mimeType,
            totalSize: 0n,
            sequence: 0,
          };
        }
      } catch (error: unknown) {
        throw toConnectError(error);
      }
    },
    async *watch(request, context) {
      for await (const event of events.subscribe(request.mountIds, context.signal)) {
        yield toRpcEvent(event);
      }
    },
  });
}

function prepareGrpcWebResponse(
  request: IncomingMessage,
  response: ServerResponse,
  config: BridgeConfig,
): boolean {
  setSecurityHeaders(response);
  const origin = request.headers.origin;
  if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
    response.statusCode = 403;
    response.end();
    return false;
  }
  if (origin !== undefined) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader(
      'Vary',
      'Origin,Access-Control-Request-Method,Access-Control-Request-Headers',
    );
  }
  response.setHeader('Access-Control-Expose-Headers', cors.exposedHeaders.join(','));
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.setHeader('Access-Control-Allow-Methods', cors.allowedMethods.join(','));
    response.setHeader('Access-Control-Allow-Headers', cors.allowedHeaders.join(','));
    response.setHeader('Access-Control-Max-Age', '7200');
    response.end();
    return false;
  }
  return true;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}

function toRpcEntry(entry: BridgeEntry) {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind === 'directory' ? EntryKind.DIRECTORY : EntryKind.FILE,
    mimeType: entry.mimeType ?? '',
    byteSize: BigInt(entry.byteSize ?? 0),
    modifiedAt: entry.modifiedAt,
  };
}

function toRpcEvent(event: BridgeEvent) {
  const kinds: Readonly<Record<BridgeEvent['type'], FileEventKind>> = {
    FILE_ADDED: FileEventKind.ADDED,
    FILE_CHANGED: FileEventKind.CHANGED,
    FILE_REMOVED: FileEventKind.REMOVED,
    DIRECTORY_CHANGED: FileEventKind.DIRECTORY_CHANGED,
    FILE_READY: FileEventKind.READY,
  };
  return {
    kind: kinds[event.type],
    mountId: event.mountId,
    path: event.path,
    issuedAtMs: BigInt(Date.now()),
  };
}

function required(value: string, field: string): string {
  if (value.length === 0) throw new ConnectError(`Missing field: ${field}`, Code.InvalidArgument);
  return value;
}

function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof PathSecurityError) {
    return new ConnectError(error.message, Code.PermissionDenied);
  }
  if (hasCode(error, 'ENOENT')) {
    return new ConnectError(
      error instanceof Error ? error.message : 'File not found',
      Code.NotFound,
    );
  }
  return new ConnectError(
    error instanceof Error ? error.message : 'Unknown bridge error',
    Code.InvalidArgument,
  );
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

if (
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname
    .replace(/^\//u, '')
    .replaceAll('/', '\\')
    .toLocaleLowerCase('en-US') === process.argv[1].toLocaleLowerCase('en-US')
) {
  const config = await loadBridgeConfig();
  await startBridge(config);
  process.stdout.write(
    `gremuchaya-file-bridge listening with gRPC-Web on http://127.0.0.1:${config.port}\n`,
  );
}
