import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { timestampNow } from '@bufbuild/protobuf/wkt';
import { cors, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { ControlPlaneService, controlV1 } from '@gremuchaya/protocol';

import { loadControlPlaneConfig, type ControlPlaneConfig } from './config.js';
import { attachRealtimeTransport } from './realtime/server.js';
import type { GroupEventPublication } from './realtime/server.js';

const serviceVersion = '0.1.0';
const protocolVersion = 'gremuchaya.v1';

export async function startControlPlane(config: ControlPlaneConfig) {
  const startedAt = timestampNow();
  const rpcHandler = connectNodeAdapter({
    connect: true,
    grpc: false,
    grpcWeb: true,
    routes: (router) => registerControlPlaneRoutes(router, startedAt),
  });
  const server = createServer((request, response) => {
    if (!prepareRpcResponse(request, response, config)) return;
    void rpcHandler(request, response);
  });
  const realtime = attachRealtimeTransport(server, config);

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(config.port, '127.0.0.1', resolveListening);
  });

  return {
    server,
    publishGroupEvent: (event: GroupEventPublication) => realtime.publish(event),
    close: async () => {
      await realtime.close();
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      );
    },
  };
}

function registerControlPlaneRoutes(
  router: ConnectRouter,
  startedAt: ReturnType<typeof timestampNow>,
): void {
  router.service(ControlPlaneService, {
    health() {
      return {
        service: 'gremuchaya-control-plane',
        version: serviceVersion,
        protocolVersion,
        status: controlV1.ServingStatus.SERVING,
        startedAt,
        checkedAt: timestampNow(),
        dependencies: [],
      };
    },
    getCapabilities() {
      return {
        capabilities: [
          { name: 'control.health', version: 'v1', enabled: true },
          { name: 'transport.connect', version: 'v1', enabled: true },
          { name: 'transport.grpc-web', version: 'v1', enabled: true },
          { name: 'materials', version: 'v1', enabled: false },
          { name: 'settings', version: 'v1', enabled: false },
          { name: 'sync', version: 'v1', enabled: false },
          { name: 'telemetry', version: 'v1', enabled: false },
          { name: 'integration', version: 'v1', enabled: false },
        ],
      };
    },
  });
}

function prepareRpcResponse(
  request: IncomingMessage,
  response: ServerResponse,
  config: ControlPlaneConfig,
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

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const config = loadControlPlaneConfig();
  const running = await startControlPlane(config);
  const address = running.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  process.stdout.write(`gremuchaya-control-plane listening on http://127.0.0.1:${port}\n`);
}

function isEntrypoint(moduleUrl: string, executablePath: string | undefined): boolean {
  if (executablePath === undefined) return false;
  const modulePath = new URL(moduleUrl).pathname.replace(/^\//u, '').replaceAll('/', '\\');
  return modulePath.toLocaleLowerCase('en-US') === executablePath.toLocaleLowerCase('en-US');
}
