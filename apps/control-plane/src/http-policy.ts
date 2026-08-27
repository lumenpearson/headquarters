import { cors } from '@connectrpc/connect';

/**
 * The one origin, preflight and security-header decision the control plane
 * makes, in a shape neither HTTP adapter owns.
 *
 * There are two adapters over the same router — the Node server in
 * `server.ts` and the Fetch handler in `fetch-adapter.ts` — and an origin rule
 * written twice is an origin rule that drifts. The rule is a pure function of
 * two request facts, so both adapters can read it and neither can hold a
 * different opinion about who may call and what a preflight answers.
 */

/** What the decision reads from a request; nothing else about it matters. */
export interface RpcHttpRequest {
  /** `GET`, `POST`, `OPTIONS`; `undefined` only where a runtime omits it. */
  readonly method: string | undefined;
  /** The `Origin` header verbatim, or `undefined` when the caller sent none. */
  readonly origin: string | undefined;
  /**
   * The origin the request was addressed to, when the adapter can name it.
   *
   * A serverless web deployment answers on a host no configuration can list in
   * advance: every preview deployment gets its own, and the production host can
   * be reached through an alias or a custom domain as well. The interface and
   * the RPC then share an origin, and the browser still sends `Origin` --
   * every RPC is a POST, and a same-origin POST carries the header -- so the
   * allowlist refused the application's own calls with 403.
   *
   * Left `undefined` by the Node adapter, whose behaviour is therefore
   * unchanged: it serves the packaged desktop and the set's LAN, where the
   * origins that may call are exactly the ones an operator configured.
   */
  readonly selfOrigin?: string | undefined;
}

export interface RpcHttpPolicy {
  /**
   * Header name/value pairs the answer carries, in order. They are applied
   * whether the router runs or not, so a refusal is as well-formed as a reply.
   */
  readonly headers: readonly (readonly [name: string, value: string])[];
  /**
   * Set when the request must be answered here rather than by the router: 403
   * for an origin outside the allowlist, 204 for a preflight. Both are
   * bodiless. `undefined` means the router answers.
   */
  readonly terminalStatus?: number;
}

/**
 * Headers a preflight may carry beyond Connect's own list.
 *
 * `authorization` is every authenticated method's bearer credential and
 * `x-hq-bootstrap-secret` is the one CreateGroup presents; a browser that
 * cannot send them cannot pair a device at all.
 */
const additionalAllowedHeaders = ['authorization', 'x-hq-bootstrap-secret'] as const;

const preflightMaxAgeSeconds = '7200';

export function decideRpcHttpPolicy(
  request: RpcHttpRequest,
  allowedOrigins: readonly string[],
): RpcHttpPolicy {
  const headers: [string, string][] = securityHeaders();
  const origin = request.origin;

  // A request addressed to the origin it came from is the application calling
  // itself; the allowlist exists to decide which *other* origins may call, and
  // it is never consulted here. Compared verbatim, so a deployment reached on a
  // second host is same-origin on that host and cross-origin from the first.
  const sameOrigin = origin !== undefined && origin === request.selfOrigin;

  // A disallowed origin is refused before anything else is decided, and the
  // refusal carries no `Access-Control-Allow-Origin`: a browser must not be
  // able to read a reply the allowlist did not authorize.
  if (origin !== undefined && !sameOrigin && !allowedOrigins.includes(origin)) {
    return { headers, terminalStatus: 403 };
  }

  if (origin !== undefined) {
    headers.push(['Access-Control-Allow-Origin', origin]);
    headers.push(['Vary', 'Origin,Access-Control-Request-Method,Access-Control-Request-Headers']);
  }
  headers.push(['Access-Control-Expose-Headers', cors.exposedHeaders.join(',')]);

  if (request.method === 'OPTIONS') {
    headers.push(['Access-Control-Allow-Methods', cors.allowedMethods.join(',')]);
    headers.push([
      'Access-Control-Allow-Headers',
      [...new Set([...cors.allowedHeaders, ...additionalAllowedHeaders])].join(','),
    ]);
    headers.push(['Access-Control-Max-Age', preflightMaxAgeSeconds]);
    return { headers, terminalStatus: 204 };
  }

  return { headers };
}

function securityHeaders(): [string, string][] {
  return [
    ['Cache-Control', 'no-store'],
    ['X-Content-Type-Options', 'nosniff'],
    // `cross-origin` rather than `same-site`: the packaged desktop shell runs on
    // `tauri.localhost` while the control plane answers on whatever host the
    // deployment gave it, and those are different registrable domains, so
    // `same-site` made the browser discard a response the server had already
    // authorized. What protects this surface is the bearer token every method
    // but `Health` and `GetCapabilities` requires, together with the origin
    // allowlist above -- not a header that only decides who may read a reply
    // already sent. The two unauthenticated methods report the service's own
    // name, version, capability list and installation identity, which is exactly
    // what a client must read before it can authenticate at all.
    ['Cross-Origin-Resource-Policy', 'cross-origin'],
    ['Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"],
  ];
}
