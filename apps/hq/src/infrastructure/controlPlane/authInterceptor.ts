import type { Interceptor } from '@connectrpc/connect';

/**
 * Adds `Authorization: Bearer <access>` to every call that has a token to add.
 *
 * The token is read at the moment of the call rather than captured when the
 * transport is built, so a refresh that rotated it is seen by the very next
 * request without rebuilding the client. Calls that need no credential --
 * `GetCapabilities`, `PairDevice`, `TimeSync` -- get the header too when a
 * session exists; the server ignores it there, and one interceptor that is
 * always right beats a list of exemptions that has to be kept in step with
 * `apps/control-plane/src/sync/service.ts`.
 */
export function createBearerInterceptor(readAccessToken: () => string | undefined): Interceptor {
  return (next) => async (request) => {
    const token = readAccessToken();
    if (token !== undefined && token.length > 0 && !request.header.has('Authorization')) {
      request.header.set('Authorization', `Bearer ${token}`);
    }
    return next(request);
  };
}
