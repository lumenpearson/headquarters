import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { timestampNow } from '@bufbuild/protobuf/wkt';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import type { syncV1 } from '@gremuchaya/protocol';

import { loadControlPlaneConfig, type ControlPlaneConfig } from './config.js';
import { decideRpcHttpPolicy } from './http-policy.js';
import { attachRealtimeTransport } from './realtime/server.js';
import type { GroupEventPublication } from './realtime/server.js';
import {
  registerControlPlaneRoutes,
  resolveControlPlaneCollaborators,
  type ControlPlaneStartOptions,
} from './routes.js';

export interface RunningControlPlane {
  readonly server: ReturnType<typeof createServer>;
  publishGroupEvent(event: GroupEventPublication): Promise<syncV1.GroupEvent>;
  close(): Promise<void>;
}

export async function startControlPlane(
  config: ControlPlaneConfig,
  options: ControlPlaneStartOptions = {},
): Promise<RunningControlPlane> {
  const collaborators = await resolveControlPlaneCollaborators(config, options);
  const startedAt = timestampNow();
  const rpcHandler = connectNodeAdapter({
    connect: true,
    grpc: false,
    grpcWeb: true,
    routes: (router) => registerControlPlaneRoutes(router, startedAt, collaborators),
  });
  const server = createServer((request, response) => {
    if (!prepareRpcResponse(request, response, config)) return;
    void rpcHandler(request, response);
  });
  const realtime = attachRealtimeTransport(server, config, collaborators.realtime);

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(config.port, config.host, resolveListening);
  });

  return {
    server,
    publishGroupEvent: (event: GroupEventPublication) => realtime.publish(event),
    close: async () => {
      await realtime.close();
      const closed = new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      );
      // `server.close` alone waits for every open connection, and `WatchGroup`
      // is a stream that by design never ends. Without this a control plane
      // with one watcher attached could not be shut down at all — which on a
      // shoot day means it cannot be restarted either.
      server.closeAllConnections();
      await closed;
    },
  };
}

/**
 * Applies the shared origin policy to a Node response, and says whether the
 * router still has to run. The decision itself lives in `http-policy.ts`
 * because the Fetch adapter answers to the same allowlist; only the
 * `(req, res)` shape is this adapter's own.
 */
function prepareRpcResponse(
  request: IncomingMessage,
  response: ServerResponse,
  config: ControlPlaneConfig,
): boolean {
  const policy = decideRpcHttpPolicy(
    { method: request.method, origin: request.headers.origin },
    config.allowedOrigins,
  );
  for (const [name, value] of policy.headers) response.setHeader(name, value);
  if (policy.terminalStatus === undefined) return true;
  response.statusCode = policy.terminalStatus;
  response.end();
  return false;
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const config = loadControlPlaneConfig();
  const running = await startControlPlane(config);
  const address = running.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  process.stdout.write(`gremuchaya-control-plane listening on http://${config.host}:${port}\n`);
}

function isEntrypoint(moduleUrl: string, executablePath: string | undefined): boolean {
  if (executablePath === undefined) return false;
  const modulePath = new URL(moduleUrl).pathname.replace(/^\//u, '').replaceAll('/', '\\');
  return modulePath.toLocaleLowerCase('en-US') === executablePath.toLocaleLowerCase('en-US');
}
