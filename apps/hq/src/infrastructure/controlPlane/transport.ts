import type { Interceptor, Transport } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';

import { controlPlaneFetch } from '@/infrastructure/tauri/controlPlaneLanProxy';

/**
 * The one transport every control-plane service client shares.
 *
 * Binary gRPC-Web, as the bridge client and ADR 0003 have it; no REST and no
 * JSON. The interceptors are what make the transport a session's: the bearer
 * interceptor reads the token at call time, so one transport serves a client
 * from before pairing to after the last refresh.
 *
 * `fetchImpl` defaults to `controlPlaneFetch`, which steps aside to the real
 * `fetch` on the web build and on desktop for any address the CSP already
 * admits; only a Tauri session pointed at a literal LAN address routes
 * through the native `control_plane_http_request` proxy command instead
 * (`docs/release/known-limitations.md`, "desktop CSP"). Passing a different
 * `fetchImpl` is for tests that supply their own.
 */
export function createControlPlaneTransport(
  baseUrl: string,
  interceptors: readonly Interceptor[] = [],
  fetchImpl: typeof fetch = controlPlaneFetch,
): Transport {
  return createGrpcWebTransport({
    baseUrl,
    useBinaryFormat: true,
    interceptors: [...interceptors],
    fetch: fetchImpl,
  });
}
