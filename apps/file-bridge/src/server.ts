import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { cors, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import {
  bridgeConfigSchema,
  bridgeProtocolVersion,
  type BridgeConfig,
  type BridgeEvent,
  type BridgeEntry,
} from '@gremuchaya/config';
import { BridgeFailure, EntryKind, FileBridgeService, FileEventKind } from '@gremuchaya/protocol';

import { BridgeEventHub } from './BridgeEventHub.js';
import { BridgeService } from './BridgeService.js';
import { BridgeWatcher } from './BridgeWatcher.js';
import { loadBridgeConfig } from './config.js';
import { BridgeFailureError, bridgeFailureInterceptor, toBridgeConnectError } from './errors.js';
import { MaterialMirror, type MaterialImportEntry } from './MaterialMirror.js';
import {
  MaterialPlaybackGrantError,
  MaterialPlaybackRegistry,
  type MaterialPlaybackSource,
} from './MaterialPlaybackRegistry.js';

const protocolVersion = bridgeProtocolVersion;
const chunkSize = 64 * 1024;

export async function startBridge(config: BridgeConfig) {
  // The executable is also called directly by tests and native launchers.
  // Normalize here so legacy JSON configs receive newly introduced safe defaults.
  // Port 0 is retained only as Node's explicit ephemeral-port test hook.
  const normalizedConfig = {
    ...bridgeConfigSchema.parse({ ...config, port: config.port === 0 ? 1024 : config.port }),
    port: config.port,
  };
  const service = new BridgeService(normalizedConfig);
  const materials = new MaterialMirror(normalizedConfig);
  const playback = new MaterialPlaybackRegistry();
  const startedAt = new Date().toISOString();
  const events = new BridgeEventHub();
  let bridgeOrigin: string | undefined;
  const watcher = new BridgeWatcher(normalizedConfig, (event) => events.publish(event));
  const rpcHandler = connectNodeAdapter({
    connect: false,
    grpc: false,
    grpcWeb: true,
    // Applied to every registered method, so a handler that raises without a
    // `try` of its own still answers with a code rather than with Connect's
    // `unknown` and the raw exception text.
    interceptors: [bridgeFailureInterceptor],
    routes: (router) =>
      registerBridgeRoutes(router, service, materials, playback, events, startedAt, () =>
        requireBridgeOrigin(bridgeOrigin),
      ),
  });
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/v1/material-playback/') === true) {
      const playbackPath = parsePlaybackPath(request.url);
      if (playbackPath === null) {
        respondNotFound(response);
        return;
      }
      serveMaterialPlayback(request, response, normalizedConfig, playback, playbackPath);
      return;
    }
    if (!prepareGrpcWebResponse(request, response, normalizedConfig)) return;
    void rpcHandler(request, response);
  });

  if (normalizedConfig.materialImport.enabled) await materials.initialize();
  await watcher.start();
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(normalizedConfig.port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      bridgeOrigin = `http://127.0.0.1:${address.port}`;
      resolveListening();
    });
  });

  return {
    server,
    watcher,
    activePlaybackGrantCount: () => playback.activeCount(),
    activeWatchSubscriberCount: () => events.subscriberCount(),
    close: async () => {
      playback.clear();
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
  materials: MaterialMirror,
  playback: MaterialPlaybackRegistry,
  events: BridgeEventHub,
  startedAt: string,
  bridgeOrigin: () => string,
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
        throw toBridgeConnectError(error);
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
        throw toBridgeConnectError(error);
      }
    },
    async *watch(request, context) {
      for await (const event of events.subscribe(request.mountIds, context.signal)) {
        yield toRpcEvent(event);
      }
    },
    async beginMaterialImport(request) {
      try {
        return {
          session: toRpcImportSession(
            await materials.begin({
              mountId: required(request.mountId, 'mount_id'),
              fileName: required(request.fileName, 'file_name'),
              declaredMimeType: request.declaredMimeType,
              totalSize: request.totalSize,
              expectedBlake3: request.expectedBlake3,
            }),
          ),
        };
      } catch (error: unknown) {
        throw toBridgeConnectError(error);
      }
    },
    async uploadMaterialChunk(request) {
      try {
        return {
          session: toRpcImportSession(
            await materials.append(
              required(request.uploadId, 'upload_id'),
              request.offset,
              request.data,
            ),
          ),
        };
      } catch (error: unknown) {
        throw toBridgeConnectError(error);
      }
    },
    getMaterialImportStatus(request) {
      try {
        return {
          session: toRpcImportSession(materials.status(required(request.uploadId, 'upload_id'))),
        };
      } catch (error: unknown) {
        throw toBridgeConnectError(error);
      }
    },
    async completeMaterialImport(request) {
      try {
        const completed = await materials.complete(required(request.uploadId, 'upload_id'));
        return {
          material: toRpcImportedMaterial(completed.material),
          deduplicated: completed.deduplicated,
        };
      } catch (error: unknown) {
        throw toBridgeConnectError(error);
      }
    },
    async cancelMaterialImport(request) {
      try {
        return {
          session: toRpcImportSession(
            await materials.cancel(required(request.uploadId, 'upload_id')),
          ),
        };
      } catch (error: unknown) {
        throw toBridgeConnectError(error);
      }
    },
    async listImportedMaterials(request) {
      try {
        const page = await materials.list(
          required(request.mountId, 'mount_id'),
          request.pageSize,
          request.cursor,
        );
        return {
          materials: page.materials.map(toRpcImportedMaterial),
          nextCursor: page.nextCursor,
        };
      } catch (error: unknown) {
        throw toBridgeConnectError(error);
      }
    },
    async *readImportedMaterial(request, context) {
      try {
        const resolved = await materials.resolve(
          required(request.mountId, 'mount_id'),
          required(request.materialId, 'material_id'),
        );
        let sequence = 0;
        for await (const data of createReadStream(resolved.path, { highWaterMark: chunkSize })) {
          if (context.signal.aborted) return;
          yield {
            data: new Uint8Array(data),
            material: toRpcImportedMaterial(resolved.material),
            sequence,
          };
          sequence += 1;
        }
        if (sequence === 0) {
          yield {
            data: new Uint8Array(),
            material: toRpcImportedMaterial(resolved.material),
            sequence: 0,
          };
        }
      } catch (error: unknown) {
        throw toBridgeConnectError(error);
      }
    },
    async getMaterialPlaybackGrant(request) {
      try {
        const source = await materials.resolve(
          required(request.mountId, 'mount_id'),
          required(request.materialId, 'material_id'),
        );
        const grant = playback.issue(source, bridgeOrigin());
        return {
          grant: {
            grantId: grant.grantId,
            url: grant.url,
            expiresAtMs: BigInt(grant.expiresAtMs),
            mimeType: grant.mimeType,
            byteSize: BigInt(grant.byteSize),
          },
        };
      } catch (error: unknown) {
        throw toBridgeConnectError(error);
      }
    },
    revokeMaterialPlaybackGrant(request) {
      return { revoked: playback.revoke(required(request.grantId, 'grant_id')) };
    },
  });
}

interface PlaybackPath {
  readonly grantId: string;
  readonly token: string;
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

function parsePlaybackPath(requestUrl: string): PlaybackPath | null {
  const match = /^\/v1\/material-playback\/([0-9a-f-]{36})\/([0-9a-f]{64})$/iu.exec(requestUrl);
  return match?.[1] !== undefined && match[2] !== undefined
    ? { grantId: match[1], token: match[2] }
    : null;
}

function serveMaterialPlayback(
  request: IncomingMessage,
  response: ServerResponse,
  config: BridgeConfig,
  playback: MaterialPlaybackRegistry,
  playbackPath: PlaybackPath,
): void {
  if (!preparePlaybackResponse(request, response, config)) return;
  const source = playback.authorize(playbackPath.grantId, playbackPath.token);
  if (source === undefined) {
    respondNotFound(response);
    return;
  }

  const range = parseByteRange(request.headers.range, source.material.byteSize);
  if (range === null) {
    response.statusCode = 416;
    response.setHeader('Content-Range', `bytes */${source.material.byteSize}`);
    response.end();
    return;
  }

  const selectedRange = range ?? fullRange(source.material.byteSize);
  const contentLength = selectedRange === null ? 0 : selectedRange.end - selectedRange.start + 1;
  response.statusCode = range === undefined ? 200 : 206;
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Type', source.material.mimeType);
  response.setHeader('Content-Length', String(contentLength));
  if (range !== undefined && selectedRange !== null) {
    response.setHeader(
      'Content-Range',
      `bytes ${selectedRange.start}-${selectedRange.end}/${source.material.byteSize}`,
    );
  }
  if (request.method === 'HEAD' || selectedRange === null) {
    response.end();
    return;
  }

  pipePlaybackRange(source, selectedRange, response);
}

function preparePlaybackResponse(
  request: IncomingMessage,
  response: ServerResponse,
  config: BridgeConfig,
): boolean {
  setSecurityHeaders(response);
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
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
  response.setHeader(
    'Access-Control-Expose-Headers',
    'Accept-Ranges,Content-Length,Content-Range,Content-Type',
  );
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Range');
    response.setHeader('Access-Control-Max-Age', '7200');
    response.end();
    return false;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET, HEAD, OPTIONS');
    response.end();
    return false;
  }
  return true;
}

function parseByteRange(value: string | undefined, size: number): ByteRange | undefined | null {
  if (value === undefined) return undefined;
  if (size === 0 || value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (match === null || (match[1] === '' && match[2] === '')) return null;

  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function fullRange(size: number): ByteRange | null {
  return size === 0 ? null : { start: 0, end: size - 1 };
}

function pipePlaybackRange(
  source: MaterialPlaybackSource,
  range: ByteRange,
  response: ServerResponse,
): void {
  const stream = createReadStream(source.path, { start: range.start, end: range.end });
  response.once('close', () => stream.destroy());
  stream.once('error', (error) => response.destroy(error));
  stream.pipe(response);
}

function respondNotFound(response: ServerResponse): void {
  setSecurityHeaders(response);
  response.statusCode = 404;
  response.end();
}

function requireBridgeOrigin(value: string | undefined): string {
  if (value === undefined) {
    throw new MaterialPlaybackGrantError(
      BridgeFailure.PLAYBACK_UNAVAILABLE,
      'Bridge is not listening yet.',
    );
  }
  return value;
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

function toRpcImportSession(session: {
  readonly uploadId: string;
  readonly totalSize: number;
  readonly receivedSize: number;
  readonly chunkSize: number;
  readonly state: string;
}) {
  return {
    uploadId: session.uploadId,
    totalSize: BigInt(session.totalSize),
    receivedSize: BigInt(session.receivedSize),
    chunkSize: session.chunkSize,
    state: session.state,
  };
}

function toRpcImportedMaterial(material: MaterialImportEntry) {
  return {
    materialId: material.materialId,
    displayName: material.displayName,
    mimeType: material.mimeType,
    byteSize: BigInt(material.byteSize),
    contentHash: material.contentHash,
    createdAt: material.createdAt,
  };
}

/**
 * The field name is not sent.
 *
 * `Missing field: mount_id` named a contract field, which is harmless, but it
 * was also the last place a bridge error text was assembled rather than chosen,
 * and a caption cannot be built out of an interpolated identifier. The code says
 * a required field was empty; which one is a client defect, visible in the
 * client's own stack.
 */
function required(value: string, field: string): string {
  if (value.length === 0) {
    throw new BridgeFailureError(BridgeFailure.MISSING_FIELD, `Missing field: ${field}`);
  }
  return value;
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
