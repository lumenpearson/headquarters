import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { ControlPlaneService, SyncService, controlV1, syncV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import type { ControlPlaneConfig } from './config.js';
import { createControlPlaneFetchHandler, type ControlPlaneFetchHandler } from './fetch-adapter.js';
import { InMemoryPresenceStore } from './sync/presence-store.js';
import { PairedDeviceRuntime } from './sync/runtime.js';
import { createPairedDeviceSyncService } from './sync/service.js';

/**
 * That the Fetch adapter serves the same wire the Node adapter serves.
 *
 * The transport is a real `createGrpcWebTransport` with binary framing; only
 * its `fetch` is replaced, by one that hands the `Request` straight to the
 * handler. Nothing is scripted and no socket is opened, so what passes here is
 * genuine gRPC-Web envelope encoding, header propagation and trailer parsing —
 * the parts a hand-rolled harness would quietly get wrong.
 *
 * It is also the guard on `@connectrpc/connect/protocol`, whose
 * `createFetchHandler` is marked `@private` and does not follow semantic
 * versioning: a dependency bump that changes it fails here rather than in a
 * deployment.
 */
const origin = 'http://127.0.0.1:3000';
const baseUrl = 'http://control-plane.test/api';
const bootstrapSecret = 'fetch-adapter-bootstrap-secret-with-at-least-thirty-two-characters';
const tokenPepper = 'fetch-adapter-token-pepper-with-at-least-thirty-two-characters';

describe('control-plane Fetch adapter over binary gRPC-Web', () => {
  it('answers Health, GetCapabilities and an authenticated SyncService mutation', async () => {
    const { handler, responses } = await mountedHandler();
    const transport = createGrpcWebTransport({
      baseUrl,
      useBinaryFormat: true,
      fetch: throughHandler(handler, responses),
    });
    const control = createClient(ControlPlaneService, transport);
    const sync = createClient(SyncService, transport);

    const health = await control.health({});
    expect(health).toMatchObject({
      service: 'gremuchaya-control-plane',
      version: '0.1.0',
      protocolVersion: 'gremuchaya.v1',
      status: controlV1.ServingStatus.SERVING,
    });

    const capabilities = await control.getCapabilities({});
    expect(capabilities.capabilities).toContainEqual({
      $typeName: 'gremuchaya.control.v1.Capability',
      name: 'transport.grpc-web',
      version: 'v1',
      enabled: true,
    });
    // The injected SyncService is what makes this true, exactly as it does on
    // the Node adapter: the capability list is built from the collaborators,
    // not from a constant either adapter carries.
    expect(capabilityEnabled(capabilities, 'sync.device-lifecycle')).toBe(true);
    // No durable event log was supplied, so the group-event surface stays off
    // rather than answering an empty success.
    expect(capabilityEnabled(capabilities, 'sync')).toBe(false);

    // A mutation authenticated by the operator bootstrap secret...
    const created = await sync.createGroup(
      {
        name: 'Штаб',
        initialDevice: {
          name: 'Primary workstation',
          publicKey: 'ed25519:fetch-adapter-primary',
          platform: 'windows',
          applicationVersion: '0.1.0',
        },
      },
      { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
    );
    const groupId = required(created.group?.id?.value, 'group id');
    const accessToken = required(created.session?.accessToken, 'access token');

    // ...and a mutation authenticated by the bearer token that one issued. Both
    // credentials travel as request headers, which is the part of the round
    // trip a handler that only forwarded a body would lose.
    const grant = await sync.createPairingCode(
      { groupId: { value: groupId }, role: syncV1.DeviceRole.EDITOR },
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    expect(required(grant.pairingCode?.code, 'pairing code').length).toBeGreaterThan(0);
    expect(grant.pairingCode?.groupId?.value).toBe(groupId);
    expect(grant.pairingCode?.role).toBe(syncV1.DeviceRole.EDITOR);

    // Every answer the router produced carries the security headers too, not
    // only the refusals below.
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    }
    expect(responses).toHaveLength(4);
  });

  it('refuses an unauthorized bearer token with the same neutral error as the Node adapter', async () => {
    const { handler, responses } = await mountedHandler();
    const sync = createClient(
      SyncService,
      createGrpcWebTransport({
        baseUrl,
        useBinaryFormat: true,
        fetch: throughHandler(handler, responses),
      }),
    );

    const refused = await sync
      .createPairingCode(
        { groupId: { value: 'no-such-group' }, role: syncV1.DeviceRole.EDITOR },
        { headers: { authorization: 'Bearer not-a-real-token' } },
      )
      .catch((error: unknown) => error);

    expect(String(refused)).toContain('unauthenticated');
  });

  it('refuses an origin outside the allowlist without letting it read the reply', async () => {
    const { handler } = await mountedHandler();

    const response = await handler(
      new Request(`${baseUrl}/gremuchaya.control.v1.ControlPlaneService/Health`, {
        method: 'POST',
        headers: { origin: 'https://untrusted.example' },
      }),
    );

    expect(response.status).toBe(403);
    // The refusal must not carry the header that would let the browser read it.
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  /**
   * Measured against a live Vercel deployment on 2026-08-27, before the policy
   * knew what origin it had been addressed on: the interface and the RPC shared
   * one origin, and the deployment answered its own application with 403.
   *
   * `Origin` is sent on every request whose method is not GET or HEAD, and
   * every RPC is a POST, so the header is always there; what no configuration
   * could supply is the host, which a preview deployment mints per build and a
   * production deployment can also be reached on through an alias. Revert the
   * comparison in `decideRpcHttpPolicy` and this returns 403 again.
   */
  it('serves a call from the origin it was addressed on, which no allowlist names', async () => {
    const { handler } = await mountedHandler();
    const selfOrigin = new URL(baseUrl).origin;
    // The premise: this origin is deliberately absent from the allowlist.
    expect(selfOrigin).not.toBe(origin);

    const response = await handler(
      new Request(`${baseUrl}/gremuchaya.control.v1.ControlPlaneService/Health`, {
        method: 'POST',
        headers: { origin: selfOrigin, 'content-type': 'application/json' },
        body: '{}',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: 'gremuchaya-control-plane' });
    expect(response.headers.get('access-control-allow-origin')).toBe(selfOrigin);
  });

  it('answers a same-origin preflight the allowlist does not name', async () => {
    const { handler } = await mountedHandler();
    const selfOrigin = new URL(baseUrl).origin;

    const response = await handler(
      new Request(`${baseUrl}/gremuchaya.sync.v1.SyncService/CreateGroup`, {
        method: 'OPTIONS',
        headers: {
          origin: selfOrigin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-hq-bootstrap-secret',
        },
      }),
    );

    // Without this the browser never sends the POST above at all.
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(selfOrigin);
  });

  it('answers a preflight with the two headers pairing actually sends', async () => {
    const { handler } = await mountedHandler();

    const response = await handler(
      new Request(`${baseUrl}/gremuchaya.sync.v1.SyncService/CreateGroup`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-grpc-web,x-hq-bootstrap-secret',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    const allowedHeaders = (response.headers.get('access-control-allow-headers') ?? '').split(',');
    // Without these two a browser can read Health and pair nothing.
    expect(allowedHeaders).toContain('authorization');
    expect(allowedHeaders).toContain('x-hq-bootstrap-secret');
    expect(response.headers.get('access-control-max-age')).toBe('7200');
    expect(response.headers.get('vary')).toContain('Origin');
  });

  /**
   * Measured on a live Vercel deployment on 2026-08-27, which reported
   * `sync.realtime-admission` enabled while serving no socket at all.
   *
   * `ControlPlaneRuntime` reads that flag to choose `'socket'` over
   * `'poll'`, so the deployment was telling its own client to open a
   * connection nothing would accept -- and the polling feed Э6 built for
   * exactly this deployment would never have been used. An admission
   * collaborator authorizes a socket; it does not serve one.
   */
  it('reports realtime admission off even when an admission collaborator exists', async () => {
    const handler = await createControlPlaneFetchHandler(
      { port: 0, host: '127.0.0.1', allowedOrigins: [origin] },
      {
        prefix: '/api',
        syncService: createPairedDeviceSyncService({
          runtime: new PairedDeviceRuntime({ tokenPepper }),
          verifyBootstrapSecret: (candidate) => candidate === bootstrapSecret,
          presence: new InMemoryPresenceStore(),
        }),
        // Present, and deliberately never consulted: this adapter has no HTTP
        // server for `attachRealtimeTransport` to hang an upgrade handler on.
        realtime: { admission: { admit: () => false } },
      },
    );

    const capabilities = await capabilitiesThrough(handler);

    expect(capabilities['sync.realtime-admission']).toBe(false);
    // The neighbouring flag stays on, so this is the realtime surface being
    // reported honestly rather than the whole capability list collapsing.
    expect(capabilities['sync.device-lifecycle']).toBe(true);
  });

  it('answers a path the router never registered with 404 rather than a prefix match', async () => {
    const { handler } = await mountedHandler();

    const unregistered = await handler(new Request(`${baseUrl}/api/health`, { method: 'POST' }));
    // The mount prefix alone is not a route either: a handler that fell back to
    // it would answer for a method it does not have.
    const bare = await handler(
      new Request('http://control-plane.test/gremuchaya.control.v1.ControlPlaneService/Health', {
        method: 'POST',
      }),
    );

    expect([unregistered.status, bare.status]).toEqual([404, 404]);
  });
});

interface MountedHandler {
  readonly handler: ControlPlaneFetchHandler;
  readonly responses: Response[];
}

/**
 * The handler in reduced mode: no `auth` configuration, so
 * `resolveControlPlaneCollaborators` takes the injected SyncService rather
 * than building the durable lifecycle. That is the one path that needs no
 * database, and it exercises the same router registration the configured path
 * uses.
 */
async function mountedHandler(): Promise<MountedHandler> {
  const config: ControlPlaneConfig = {
    port: 0,
    host: '127.0.0.1',
    allowedOrigins: [origin],
  };
  const handler = await createControlPlaneFetchHandler(config, {
    prefix: '/api',
    syncService: createPairedDeviceSyncService({
      runtime: new PairedDeviceRuntime({ tokenPepper }),
      verifyBootstrapSecret: (candidate) => candidate === bootstrapSecret,
      presence: new InMemoryPresenceStore(),
    }),
  });
  return { handler, responses: [] };
}

/**
 * Connect's fetch client calls `fetch` with a single `Request` it built, so
 * the handler receives exactly what a runtime would hand a route: no
 * re-wrapping, and no chance of losing a streamed body to a missing `duplex`.
 */
function throughHandler(
  handler: ControlPlaneFetchHandler,
  responses: Response[],
): typeof globalThis.fetch {
  return async (input, init) => {
    const request =
      input instanceof Request && init === undefined ? input : new Request(input, init);
    const response = await handler(request);
    responses.push(response.clone());
    return response;
  };
}

/** The capability list as a name -> enabled map, read over the mounted route. */
async function capabilitiesThrough(
  handler: ControlPlaneFetchHandler,
): Promise<Record<string, boolean>> {
  const response = await handler(
    new Request(`${baseUrl}/gremuchaya.control.v1.ControlPlaneService/GetCapabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    readonly capabilities: readonly { readonly name: string; readonly enabled?: boolean }[];
  };
  return Object.fromEntries(body.capabilities.map((c) => [c.name, c.enabled === true]));
}

function capabilityEnabled(
  response: {
    readonly capabilities: readonly { readonly name: string; readonly enabled: boolean }[];
  },
  name: string,
): boolean {
  const capability = response.capabilities.find((candidate) => candidate.name === name);
  if (capability === undefined) throw new Error(`Missing capability: ${name}`);
  return capability.enabled;
}

function required<Value>(value: Value | undefined, field: string): Value {
  if (value === undefined) throw new Error(`Expected ${field} in the response.`);
  return value;
}
