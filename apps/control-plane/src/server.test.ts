import type { AddressInfo } from 'node:net';

import { Code, createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { ControlPlaneService, SyncService, controlV1 } from '@gremuchaya/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ControlPlaneAuthConfig, ControlPlaneConfig } from './config.js';
import type { SqlClient, SqlClientFactory, SqlStatement } from './db/database.js';
import type { MigrationRunResult } from './db/migrations.js';
import { startControlPlane } from './server.js';

describe('gRPC-Web control-plane foundation', () => {
  let closeControlPlane: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeControlPlane?.();
    closeControlPlane = undefined;
  });

  it('serves typed health and capability discovery without REST endpoints', async () => {
    const databaseFactory = vi.fn<SqlClientFactory>(() => new RecordingSqlClient());
    const migrationRunner = vi.fn(async (): Promise<MigrationRunResult> => emptyMigrationResult());
    const running = await startControlPlane(
      {
        port: 0,
        host: '127.0.0.1',
        allowedOrigins: ['http://127.0.0.1:3000'],
      },
      {
        pairedDeviceLifecycle: { databaseFactory, migrationRunner },
      },
    );
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = createClient(
      ControlPlaneService,
      createGrpcWebTransport({ baseUrl, useBinaryFormat: true }),
    );

    const health = await client.health({});
    expect(health).toMatchObject({
      service: 'gremuchaya-control-plane',
      version: '0.1.0',
      protocolVersion: 'gremuchaya.v1',
      status: controlV1.ServingStatus.SERVING,
      dependencies: [],
    });
    expect(health.startedAt).toBeDefined();
    expect(health.checkedAt).toBeDefined();

    const capabilities = await client.getCapabilities({});
    expect(databaseFactory).not.toHaveBeenCalled();
    expect(migrationRunner).not.toHaveBeenCalled();
    expect(capabilityEnabled(capabilities, 'sync.device-lifecycle')).toBe(false);
    expect(capabilityEnabled(capabilities, 'sync.realtime-admission')).toBe(false);
    expect(capabilities.capabilities).toContainEqual({
      $typeName: 'gremuchaya.control.v1.Capability',
      name: 'transport.grpc-web',
      version: 'v1',
      enabled: true,
    });
    expect(capabilities.capabilities).toContainEqual({
      $typeName: 'gremuchaya.control.v1.Capability',
      name: 'materials',
      version: 'v1',
      enabled: false,
    });

    const unauthenticatedSync = createClient(
      SyncService,
      createGrpcWebTransport({ baseUrl, useBinaryFormat: true }),
    );
    await expect(
      unauthenticatedSync.createGroup({
        name: 'No implicit auth runtime',
        initialDevice: {
          name: 'No implicit auth device',
          publicKey: 'ed25519:no-implicit-runtime',
          platform: 'windows',
          applicationVersion: '0.1.0',
        },
      }),
    ).rejects.toMatchObject({ code: Code.Unimplemented });

    const preflight = await fetch(`${baseUrl}/gremuchaya.control.v1.ControlPlaneService/Health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-grpc-web',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3000');

    const forbidden = await fetch(`${baseUrl}/gremuchaya.control.v1.ControlPlaneService/Health`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.example' },
    });
    expect(forbidden.status).toBe(403);

    const legacy = await fetch(`${baseUrl}/api/health`);
    expect(legacy.status).toBe(404);
  });
  it('waits for durable migrations before advertising paired-device capabilities', async () => {
    const database = new RecordingSqlClient();
    const migrationGate = deferred<MigrationRunResult>();
    const events: string[] = [];
    const migrationRunner = vi.fn(async (client: SqlClient): Promise<MigrationRunResult> => {
      events.push('migration:start');
      expect(client).toBe(database);
      const result = await migrationGate.promise;
      events.push('migration:complete');
      return result;
    });

    const starting = startControlPlane(authenticatedConfig(), {
      pairedDeviceLifecycle: { database, migrationRunner },
    });
    let listening = false;
    const observedStart = starting.then(
      () => {
        listening = true;
      },
      () => undefined,
    );
    await Promise.resolve();
    const stateBeforeMigrationCompletes = {
      events: [...events],
      lifecycleCalls: migrationRunner.mock.calls.length,
      listening,
    };

    migrationGate.resolve({ applied: ['0001_control_plane_foundation'], skipped: [] });
    const running = await starting;
    closeControlPlane = running.close;
    await observedStart;

    expect(stateBeforeMigrationCompletes).toEqual({
      events: ['migration:start'],
      lifecycleCalls: 1,
      listening: false,
    });
    expect(events).toEqual(['migration:start', 'migration:complete']);
    expect(migrationRunner).toHaveBeenCalledExactlyOnceWith(database);

    const address = running.server.address() as AddressInfo;
    const client = createClient(
      ControlPlaneService,
      createGrpcWebTransport({
        baseUrl: `http://127.0.0.1:${address.port}`,
        useBinaryFormat: true,
      }),
    );
    const capabilities = await client.getCapabilities({});
    expect(capabilityEnabled(capabilities, 'sync.device-lifecycle')).toBe(true);
    expect(capabilityEnabled(capabilities, 'sync.realtime-admission')).toBe(true);
  });

  /*
   * The identity has to reach a client that has not authenticated yet, because
   * the point of it is to be checked before anything is trusted. This asserts
   * it over the real gRPC-Web transport on the unauthenticated method, not off
   * the handler object.
   */
  it('reports the database identity to an unauthenticated capability probe', async () => {
    const database = new RecordingSqlClient([
      { installation_id: '9a2c4b60-6f1e-4f6f-9c93-5d0f2b7a41d8' },
    ]);
    const migrationRunner = vi.fn(async (): Promise<MigrationRunResult> => emptyMigrationResult());
    const running = await startControlPlane(authenticatedConfig(), {
      pairedDeviceLifecycle: { database, migrationRunner },
    });
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;
    const client = createClient(
      ControlPlaneService,
      createGrpcWebTransport({
        baseUrl: `http://127.0.0.1:${address.port}`,
        useBinaryFormat: true,
      }),
    );

    const capabilities = await client.getCapabilities({});

    expect(capabilities.installationId).toBe('9a2c4b60-6f1e-4f6f-9c93-5d0f2b7a41d8');
    // Read once at startup, not per request: an unauthenticated endpoint must
    // not be a way to make the database work.
    const before = database.queries.length;
    await client.getCapabilities({});
    expect(database.queries.length).toBe(before);
  });

  /*
   * A process that reached no database has no identity to report, and saying
   * so with an empty string is what lets a client tell "cannot compare" from
   * "a different database". Anything else -- a throw, an invented value -- would
   * either take health-only startup down or make the comparison a lie.
   */
  it('reports an empty identity when startup reached no database at all', async () => {
    const running = await startControlPlane({
      port: 0,
      host: '127.0.0.1',
      allowedOrigins: ['http://127.0.0.1:3000'],
    });
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;
    const client = createClient(
      ControlPlaneService,
      createGrpcWebTransport({
        baseUrl: `http://127.0.0.1:${address.port}`,
        useBinaryFormat: true,
      }),
    );

    await expect(client.getCapabilities({})).resolves.toMatchObject({ installationId: '' });
  });

  /*
   * The bind address decides whether any other machine on the set's LAN can
   * reach the control plane at all, and a loopback-only bind fails silently:
   * the server serves perfectly to the one client sharing its interface.
   * `127.0.0.2` is a second loopback address, so this proves the configured
   * value is what `listen` receives without asking the test host for a network.
   */
  it('binds the interface the configuration names, not a hard-coded one', async () => {
    const running = await startControlPlane({
      port: 0,
      host: '127.0.0.2',
      allowedOrigins: ['http://127.0.0.1:3000'],
    });
    closeControlPlane = running.close;

    const address = running.server.address() as AddressInfo;

    expect(address.address).toBe('127.0.0.2');
  });

  /*
   * `Cross-Origin-Resource-Policy: same-site` discarded the response before the
   * packaged shell could read it: the client runs on `tauri.localhost` and the
   * control plane on whatever host the deployment gave it, which are different
   * registrable domains. What protects this surface is the bearer token and the
   * origin allowlist, so the header is `cross-origin`.
   */
  it('lets a cross-site client read the reply its origin was already allowed', async () => {
    const running = await startControlPlane({
      port: 0,
      host: '127.0.0.1',
      allowedOrigins: ['http://tauri.localhost'],
    });
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/gremuchaya.control.v1.ControlPlaneService/Health`,
      { method: 'OPTIONS', headers: { origin: 'http://tauri.localhost' } },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('fails closed when auth startup receives explicit volatile lifecycle overrides', async () => {
    const config = authenticatedConfig();

    await expect(startControlPlane(config, { syncService: {} })).rejects.toThrow(
      'cannot override the durable SyncService lifecycle',
    );
    await expect(
      startControlPlane(config, {
        realtime: { admission: { admit: () => true } },
      }),
    ).rejects.toThrow('cannot override durable realtime admission');
    await expect(
      startControlPlane(config, {
        realtime: { allowUnauthenticatedDevelopment: true },
      }),
    ).rejects.toThrow('cannot enable unauthenticated realtime transport');
  });

  it('forwards bounded realtime revalidation configuration through durable startup', async () => {
    const database = new RecordingSqlClient();
    const migrationRunner = vi.fn(async (): Promise<MigrationRunResult> => emptyMigrationResult());

    await expect(
      startControlPlane(authenticatedConfig(), {
        realtime: { revalidationIntervalMs: 9 },
        pairedDeviceLifecycle: { database, migrationRunner },
      }),
    ).rejects.toThrow('revalidationIntervalMs must be an integer between 10 and 60000');

    expect(migrationRunner).toHaveBeenCalledExactlyOnceWith(database);
  });
});

function authenticatedConfig(overrides: Partial<ControlPlaneAuthConfig> = {}): ControlPlaneConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    allowedOrigins: ['http://127.0.0.1:3000'],
    databaseUrl: 'postgresql://role:password@ep-hq.neon.tech/headquarters?sslmode=require',
    auth: {
      tokenHashVersion: 'v1',
      accessTokenLifetimeMs: 120_000,
      refreshTokenLifetimeMs: 7_200_000,
      pairingCodeLifetimeMs: 1_800_000,
      hashCredential: (kind, raw) => `test-${kind}-${raw.length}`,
      verifyBootstrapSecret: (candidate) => candidate === 'test-bootstrap-secret',
      ...overrides,
    },
  };
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

function emptyMigrationResult(): MigrationRunResult {
  return { applied: [], skipped: [] };
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value) => void;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise(value);
    },
  };
}

class RecordingSqlClient implements SqlClient {
  readonly queries: SqlStatement[] = [];
  readonly transactions: SqlStatement[][] = [];

  constructor(private readonly rows: readonly Record<string, unknown>[] = []) {}

  async query<Row extends Record<string, unknown>>(
    statement: SqlStatement,
  ): Promise<readonly Row[]> {
    this.queries.push({ text: statement.text, values: [...(statement.values ?? [])] });
    return this.rows as readonly Row[];
  }

  async transaction(statements: readonly SqlStatement[]): Promise<void> {
    this.transactions.push([...statements]);
  }
}
