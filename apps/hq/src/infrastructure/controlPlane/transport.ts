import type { Interceptor, Transport } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';

/**
 * The one transport every control-plane service client shares.
 *
 * Binary gRPC-Web, as the bridge client and ADR 0003 have it; no REST and no
 * JSON. The interceptors are what make the transport a session's: the bearer
 * interceptor reads the token at call time, so one transport serves a client
 * from before pairing to after the last refresh.
 */
export function createControlPlaneTransport(
  baseUrl: string,
  interceptors: readonly Interceptor[] = [],
): Transport {
  return createGrpcWebTransport({
    baseUrl,
    useBinaryFormat: true,
    interceptors: [...interceptors],
  });
}
