import { timestampNow } from '@bufbuild/protobuf/wkt';
import { createConnectRouter } from '@connectrpc/connect';
import { createFetchHandler } from '@connectrpc/connect/protocol';

import type { ControlPlaneConfig } from './config.js';
import { decideRpcHttpPolicy, type RpcHttpPolicy } from './http-policy.js';
import {
  registerControlPlaneRoutes,
  resolveControlPlaneCollaborators,
  type ControlPlaneStartOptions,
} from './routes.js';

/**
 * The second adapter over the same router.
 *
 * `server.ts` binds a socket and answers `(IncomingMessage, ServerResponse)`;
 * a serverless web deployment has no socket to bind and answers `Request` with
 * `Response`. What must not fork between them is the route table and the origin
 * rule, so this file registers the routes with the same
 * `registerControlPlaneRoutes` and reads the same `decideRpcHttpPolicy` — it is
 * a second transport, not a second control plane.
 *
 * `@connectrpc/connect/protocol` is marked `@private` upstream and does not
 * follow semantic versioning. The wire suite beside this file drives a real
 * `createGrpcWebTransport` through the handler, so an upgrade that changes the
 * subpath fails a test rather than a shoot day.
 */

export type ControlPlaneFetchHandler = (request: Request) => Promise<Response>;

export interface ControlPlaneFetchHandlerOptions extends ControlPlaneStartOptions {
  /**
   * The path the handler is mounted at, without a trailing slash — `/api` for
   * a Next.js route at `app/api/[[...rpc]]`. RPC paths are absolute
   * (`/gremuchaya.control.v1.ControlPlaneService/Health`), so the prefix is
   * what makes the mounted URL and the client's `baseUrl` agree.
   */
  readonly prefix?: string;
}

/**
 * Builds the route table once and returns the request handler.
 *
 * Resolving collaborators runs the migration transaction, so a caller must
 * hold the returned promise for the life of the process rather than calling
 * this per request.
 */
export async function createControlPlaneFetchHandler(
  config: ControlPlaneConfig,
  options: ControlPlaneFetchHandlerOptions = {},
): Promise<ControlPlaneFetchHandler> {
  const collaborators = await resolveControlPlaneCollaborators(config, options);
  const startedAt = timestampNow();
  // The same three protocol flags the Node adapter passes: Connect and
  // gRPC-Web, never native gRPC, which needs HTTP trailers no Fetch runtime
  // exposes (ADR 0003, ADR 0008).
  const router = createConnectRouter({ connect: true, grpc: false, grpcWeb: true });
  registerControlPlaneRoutes(router, startedAt, collaborators);

  const prefix = normalizePrefix(options.prefix);
  const routes = new Map<string, ControlPlaneFetchHandler>();
  for (const handler of router.handlers) {
    routes.set(`${prefix}${handler.requestPath}`, createFetchHandler(handler, {}));
  }

  return async (request: Request): Promise<Response> => {
    const policy = decideRpcHttpPolicy(
      { method: request.method, origin: request.headers.get('origin') ?? undefined },
      config.allowedOrigins,
    );
    if (policy.terminalStatus !== undefined) {
      return new Response(null, { status: policy.terminalStatus, headers: policyHeaders(policy) });
    }

    // Dispatch on the path alone. A router that fell back to a prefix match
    // would answer a method it never registered, and a client cannot tell a
    // deployment that lacks a service from one that mis-routes it.
    const route = routes.get(new URL(request.url).pathname);
    if (route === undefined) {
      return new Response(null, { status: 404, headers: policyHeaders(policy) });
    }

    const response = await route(request);
    // The security and CORS headers belong on the RPC answer too, not only on
    // the refusals: the Node adapter sets them before the router writes a byte.
    for (const [name, value] of policy.headers) response.headers.set(name, value);
    return response;
  };
}

function policyHeaders(policy: RpcHttpPolicy): Headers {
  const headers = new Headers();
  for (const [name, value] of policy.headers) headers.set(name, value);
  return headers;
}

/** `Health`'s registered path is absolute, so the prefix must not end in `/`. */
function normalizePrefix(prefix: string | undefined): string {
  if (prefix === undefined) return '';
  const trimmed = prefix.replace(/\/+$/u, '');
  if (trimmed.length === 0) return '';
  if (!trimmed.startsWith('/')) {
    throw new Error('Control-plane fetch handler prefix must start with "/"');
  }
  return trimmed;
}
