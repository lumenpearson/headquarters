import { invoke, isTauri } from '@tauri-apps/api/core';

/**
 * `fetch`-shaped adapter that carries control-plane traffic through the
 * native `control_plane_http_request` Tauri command when the desktop CSP
 * cannot admit the request's own address.
 *
 * `tauri.conf.json`'s `connect-src` names loopback and the deployed
 * `https://*.vercel.app` control plane; it cannot name an arbitrary LAN
 * address such as `http://192.168.10.5:4100` -- CSP wildcards only the
 * leftmost label of a hostname and cannot wildcard an IP at all -- so a
 * request to that address is refused by the webview before it is even
 * sent, and reads to the operator as a network failure rather than a
 * policy one (`docs/release/known-limitations.md`, "desktop CSP").
 *
 * `@connectrpc/connect-web`'s `createGrpcWebTransport` accepts a `fetch`
 * override for exactly this kind of substitution (`GrpcWebTransportOptions.fetch`).
 * `controlPlaneFetch` is meant to be handed to it unconditionally: on the
 * web build, or on desktop for an address the CSP already admits, it steps
 * aside and calls the real `fetch`; only a Tauri session pointed at a
 * literal LAN address routes through the native process, entirely outside
 * the webview's CSP.
 *
 * The command on the other end (`apps/hq/src-tauri/src/control_plane_proxy.rs`)
 * only carries `GET`/`POST` to `http://` at a private-use, loopback or
 * link-local literal address -- the health probe and the ConnectRPC binary
 * POSTs, buffered start to finish. A long-lived server-streaming call
 * (`WatchGroup`, `TimeSync`) is read to completion before it crosses back
 * over `ipc:`, so it does not complete through this path until the peer
 * closes the response on its own; that is a standing gap, not a bug in
 * this adapter, and is recorded in `docs/release/known-limitations.md`
 * alongside the realtime WebSocket channel, which never uses this fetch at
 * all.
 */
export function controlPlaneFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  if (!isTauri() || !requiresControlPlaneProxy(request.url)) {
    return fetch(input, init);
  }
  return invokeControlPlaneProxy(request);
}

/**
 * Whether `url` is an address the desktop CSP's `connect-src` cannot admit:
 * `http://` to a literal IPv4 or IPv6 address in a private-use, loopback or
 * link-local range, other than the loopback addresses the CSP already
 * names outright (`http://127.0.0.1:*`).
 *
 * Mirrors the allowlist `control_plane_proxy.rs` enforces server-side --
 * this function only decides whether the *adapter* attempts the proxy path;
 * the Rust command re-validates independently and is the actual security
 * boundary, so a mismatch here can misroute a request but cannot widen what
 * the native process is willing to carry.
 */
export function requiresControlPlaneProxy(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname;
  if (host === '127.0.0.1' || host === 'localhost') return false;
  return isPrivateOrLinkLocalIPv4(host) || isPrivateOrLinkLocalIPv6(host);
}

function isPrivateOrLinkLocalIPv4(host: string): boolean {
  const octets = parseIPv4(host);
  if (octets === null) return false;
  const [a, b] = octets;
  if (a === 127) return true; // loopback, other than 127.0.0.1 handled above
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16, link-local
  return false;
}

function parseIPv4(host: string): readonly [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (match === null) return null;
  const [, first, second, third, fourth] = match;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return null;
  }
  const octets = [Number(first), Number(second), Number(third), Number(fourth)] as const;
  if (octets.some((value) => value < 0 || value > 255)) return null;
  return octets;
}

function isPrivateOrLinkLocalIPv6(host: string): boolean {
  // `URL#hostname` reports an IPv6 literal unbracketed and lower-cased, e.g.
  // "::1" or "fd00::1". No DNS name reaches this branch: it is only ever a
  // literal, the same restriction the Rust side enforces.
  if (host === '::1') return true;
  return /^f[cd][0-9a-f]{2}:/u.test(host) || /^fe[89ab][0-9a-f]:/u.test(host);
}

/** What `control_plane_proxy.rs` expects on the wire, field for field. */
interface ControlPlaneProxyWireRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: readonly number[] | null;
}

/** What `control_plane_proxy.rs` returns, field for field. */
interface ControlPlaneProxyWireResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: readonly number[];
}

async function invokeControlPlaneProxy(request: Request): Promise<Response> {
  const arrayBuffer = await request.arrayBuffer();
  const body = arrayBuffer.byteLength > 0 ? Array.from(new Uint8Array(arrayBuffer)) : null;
  const wireRequest: ControlPlaneProxyWireRequest = {
    method: request.method,
    url: request.url,
    headers: Array.from(request.headers.entries()),
    body,
  };
  // Checked before `invoke` runs, not raced against it afterwards: a call
  // aborted before it started must not reach the native shell at all.
  if (request.signal.aborted) throw newAbortError();
  const invocation = invoke<ControlPlaneProxyWireResponse>('control_plane_http_request', {
    request: wireRequest,
  });
  const response = await raceWithAbort(invocation, request.signal);
  return new Response(Uint8Array.from(response.body), {
    status: response.status,
    headers: response.headers.map(([name, value]) => [name, value] as [string, string]),
  });
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (signal === null || signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(newAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(newAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function newAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}
