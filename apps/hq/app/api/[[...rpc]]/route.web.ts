import { loadControlPlaneConfig } from '@gremuchaya/control-plane/config';
import {
  createControlPlaneFetchHandler,
  type ControlPlaneFetchHandler,
} from '@gremuchaya/control-plane/fetch';

/**
 * The control plane, mounted inside the web build on the app's own origin.
 *
 * `route.web.ts` rather than `route.ts` on purpose: `next.config.ts` puts
 * `web.ts` in `pageExtensions` only for the web target, so the desktop build
 * -- which is `output: 'export'` and would refuse a dynamic route handler --
 * sees a file that matches no route leaf and imports nothing. The desktop
 * shell keeps talking to a control-plane process over the network, exactly as
 * it does today; this route is the second adapter for the browser build, not a
 * replacement for that process.
 *
 * One origin for the interface and the RPC means the browser client sends no
 * `Origin` header at all here, so the allowlist is never consulted for a
 * same-origin call. It still is for the packaged shell and for any other
 * machine, which is why the shared policy answers this route as well.
 */

// `node:crypto`, `node:net` and the Postgres driver: the Edge runtime has
// none of them, and the credential hashing this service does is not portable
// to Web Crypto without changing the stored hash version.
export const runtime = 'nodejs';
// Every method here reads or writes group state behind a bearer token. A
// cached RPC answer would serve one device's reply to another.
export const dynamic = 'force-dynamic';

/**
 * One resolution per instance, not per request.
 *
 * Building the handler resolves the collaborators, which on an auth-configured
 * deployment opens the migration transaction and its `pg_advisory_xact_lock`.
 * A serverless instance answers many requests; repeating that per request
 * would serialize the whole endpoint behind one advisory lock.
 */
let pending: Promise<ControlPlaneFetchHandler> | undefined;

function controlPlane(): Promise<ControlPlaneFetchHandler> {
  // A failed start must not poison the instance for the rest of its life: the
  // memo is cleared on rejection so the next request tries again, while
  // requests that arrived during the attempt still share its outcome.
  pending ??= createControlPlaneFetchHandler(loadControlPlaneConfig(), { prefix: '/api' }).catch(
    (error: unknown) => {
      pending = undefined;
      throw error;
    },
  );
  return pending;
}

async function serve(request: Request): Promise<Response> {
  let handler: ControlPlaneFetchHandler;
  try {
    handler = await controlPlane();
  } catch (error: unknown) {
    // The reason belongs in the deployment's own log, never in the reply: the
    // configuration errors this can throw name the variables a deployment is
    // missing, and that is a map of the surface for anyone who can call it.
    console.error('control-plane route failed to start', error);
    return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  return handler(request);
}

export async function GET(request: Request): Promise<Response> {
  return serve(request);
}

export async function POST(request: Request): Promise<Response> {
  return serve(request);
}

export async function OPTIONS(request: Request): Promise<Response> {
  return serve(request);
}
