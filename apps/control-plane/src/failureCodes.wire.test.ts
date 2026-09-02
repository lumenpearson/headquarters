import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import {
  ControlPlaneFailure,
  ControlPlaneFailureDetailSchema,
  SyncService,
  syncV1,
} from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import type { ControlPlaneConfig } from './config.js';
import { createControlPlaneFetchHandler, type ControlPlaneFetchHandler } from './fetch-adapter.js';
import { RealtimeHub } from './realtime/hub.js';
import { InMemoryPresenceStore } from './sync/presence-store.js';
import { PairedDeviceRuntime } from './sync/runtime.js';
import { createPairedDeviceSyncService } from './sync/service.js';

/**
 * What a browser actually receives, over the only transport this project ships
 * (ADR 0003, 0008): binary gRPC-Web. `errors.test.ts` proves the
 * classification; only this proves the detail survives being packed into
 * `google.rpc.Status`, base64-encoded into the `grpc-status-details-bin`
 * trailer, and decoded on the other side.
 *
 * It runs against the Fetch adapter in reduced mode, which needs no database
 * and registers the router the configured path also registers -- so the
 * interceptor attached in `routes.ts` is the one under test.
 */
const origin = 'http://127.0.0.1:3000';
const baseUrl = 'http://control-plane.test/api';
const bootstrapSecret = 'failure-codes-bootstrap-secret-with-at-least-thirty-two-characters';
const tokenPepper = 'failure-codes-token-pepper-with-at-least-thirty-two-characters';

describe('control-plane failure codes over binary gRPC-Web', () => {
  it('answers a call with no bearer token with its own code', async () => {
    const sync = await client();
    const refusal = await capture(
      sync.createPairingCode({
        groupId: { value: 'irrelevant' },
        role: syncV1.DeviceRole.EDITOR,
      }),
    );

    expect(refusal.findDetails(ControlPlaneFailureDetailSchema)[0]?.code).toBe(
      ControlPlaneFailure.BEARER_TOKEN_REQUIRED,
    );
    expect(refusal.code).toBe(Code.Unauthenticated);
  });

  it('answers an unusable bearer token with one neutral code', async () => {
    const sync = await client();
    const refusal = await capture(
      sync.createPairingCode(
        { groupId: { value: 'irrelevant' }, role: syncV1.DeviceRole.EDITOR },
        { headers: { authorization: 'Bearer not-a-real-token' } },
      ),
    );

    expect(refusal.findDetails(ControlPlaneFailureDetailSchema)[0]?.code).toBe(
      ControlPlaneFailure.SESSION_UNAUTHENTICATED,
    );
    // Whatever the sentence becomes, it must not name the credential it read.
    expect(refusal.rawMessage).not.toContain('not-a-real-token');
  });

  it('answers a missing bootstrap secret with its own code', async () => {
    const sync = await client();
    const refusal = await capture(
      sync.createGroup({
        name: 'Штаб',
        initialDevice: {
          name: 'Primary workstation',
          publicKey: 'ed25519:failure-codes-primary',
          platform: 'windows',
          applicationVersion: '0.1.0',
        },
      }),
    );

    expect(refusal.findDetails(ControlPlaneFailureDetailSchema)[0]?.code).toBe(
      ControlPlaneFailure.BOOTSTRAP_AUTHORIZATION_REQUIRED,
    );
  });

  it('distinguishes one absent collaborator from another', async () => {
    const sync = await client();
    const refusal = await capture(
      sync.readGroupEvents({ groupId: { value: 'irrelevant' }, afterSequence: 0n, limit: 0 }),
    );

    // Not merely `unimplemented`: this deployment has a device lifecycle and no
    // durable event log, and the two are different things to fix.
    expect(refusal.findDetails(ControlPlaneFailureDetailSchema)[0]?.code).toBe(
      ControlPlaneFailure.EVENT_LOG_UNAVAILABLE,
    );
    expect(refusal.code).toBe(Code.Unimplemented);
  });

  /*
   * `WatchGroup` is the one handler with no `withRuntimeErrors` of its own, and
   * it is a server-streaming method, so its whole prologue -- the hub check, the
   * authentication and the group check -- runs while the response is being
   * iterated, long after the call itself resolved. A refusal raised there used
   * to reach the browser as Connect's `unknown` carrying the runtime's raw
   * message. The router-wide interceptor has to wrap the response iterable, not
   * just the call, for this to carry a code.
   */
  it('codes a refusal raised inside a server-streaming response', async () => {
    const sync = await client({ hub: new RealtimeHub() });
    const created = await sync.createGroup(
      {
        name: 'Штаб',
        initialDevice: {
          name: 'Primary workstation',
          publicKey: 'ed25519:failure-codes-primary',
          platform: 'windows',
          applicationVersion: '0.1.0',
        },
      },
      { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
    );
    const accessToken = created.session?.accessToken ?? '';
    expect(accessToken).not.toBe('');

    const refusal = await capture(
      sync.watchGroup(
        { groupId: { value: 'a-group-this-session-does-not-belong-to' }, afterSequence: 0n },
        { headers: { authorization: `Bearer ${accessToken}` } },
      ),
    );

    expect(refusal.findDetails(ControlPlaneFailureDetailSchema)[0]?.code).toBe(
      ControlPlaneFailure.PERMISSION_DENIED,
    );
    expect(refusal.code).toBe(Code.PermissionDenied);
  });
});

async function client(options: { readonly hub?: RealtimeHub } = {}) {
  const config: ControlPlaneConfig = { port: 0, host: '127.0.0.1', allowedOrigins: [origin] };
  const handler = await createControlPlaneFetchHandler(config, {
    prefix: '/api',
    syncService: createPairedDeviceSyncService({
      runtime: new PairedDeviceRuntime({ tokenPepper }),
      verifyBootstrapSecret: (candidate) => candidate === bootstrapSecret,
      presence: new InMemoryPresenceStore(),
      ...(options.hub === undefined ? {} : { hub: options.hub }),
    }),
  });
  return createClient(
    SyncService,
    createGrpcWebTransport({ baseUrl, useBinaryFormat: true, fetch: throughHandler(handler) }),
  );
}

/**
 * Connect's fetch client calls `fetch` with a single `Request` it built, so the
 * handler receives exactly what a runtime would hand a route.
 */
function throughHandler(handler: ControlPlaneFetchHandler): typeof globalThis.fetch {
  return async (input, init) => {
    const request =
      input instanceof Request && init === undefined ? input : new Request(input, init);
    return handler(request);
  };
}

/** Awaits a call that must fail, and hands back the refusal. */
async function capture(pending: Promise<unknown> | AsyncIterable<unknown>): Promise<ConnectError> {
  try {
    if (Symbol.asyncIterator in pending) {
      for await (const _ of pending) void _;
    } else {
      await pending;
    }
  } catch (error: unknown) {
    if (error instanceof ConnectError) return error;
    throw error;
  }
  throw new Error('Expected the call to be refused.');
}
