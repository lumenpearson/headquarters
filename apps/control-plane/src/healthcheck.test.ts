import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ControlPlaneAuthConfig, ControlPlaneConfig } from './config.js';
import type { SqlClient, SqlClientFactory, SqlStatement } from './db/database.js';
import type { MigrationRunResult } from './db/migrations.js';
import { parseHealthcheckArguments, runHealthcheck } from './healthcheck.js';
import { startControlPlane } from './server.js';

/*
 * Every case here drives a real control plane over the real transport
 * `runHealthcheck` builds -- binary gRPC-Web from `@connectrpc/connect-node`
 * against a listening `node:http` server on an ephemeral port. Nothing is
 * stubbed, because what the probe has to be trusted about is precisely that it
 * reaches this service the way a client does. There is no fixed sleep anywhere:
 * every wait is a resolved RPC or a closed socket.
 */
describe('control-plane healthcheck', () => {
  let closeControlPlane: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeControlPlane?.();
    closeControlPlane = undefined;
  });

  it('exits 0 when the plane is SERVING and the required capability is enabled', async () => {
    const baseUrl = await startHealthOnlyPlane();

    const outcome = await runHealthcheck({
      baseUrl,
      requiredCapabilities: ['control.health', 'transport.grpc-web'],
      refusedCapabilities: [],
      requiredDependencies: [],
      timeoutMs: 5_000,
    });

    expect(outcome).toEqual({
      exitCode: 0,
      report:
        'gremuchaya-control-plane 0.1.0 is SERVING with control.health, transport.grpc-web enabled',
    });
  });

  /*
   * The failure this exists to catch, stated positively: a container that was
   * given a database URL and two secrets, and started health-only anyway
   * because one of them was rejected, answers `Health` with `SERVING`. Only the
   * capability list can tell the two apart.
   */
  it('exits non-zero when a required capability is off on a SERVING plane', async () => {
    const baseUrl = await startHealthOnlyPlane();

    const outcome = await runHealthcheck({
      baseUrl,
      requiredCapabilities: ['control.health', 'sync.device-lifecycle'],
      refusedCapabilities: [],
      requiredDependencies: [],
      timeoutMs: 5_000,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('missing: sync.device-lifecycle');
    // The capabilities that were satisfied are not named as missing; a probe
    // that listed the whole set would make a one-capability gap unreadable.
    expect(outcome.report).not.toContain('control.health,');
  });

  it('exits non-zero when a refused capability is present and enabled', async () => {
    const baseUrl = await startHealthOnlyPlane();

    const outcome = await runHealthcheck({
      baseUrl,
      requiredCapabilities: [],
      refusedCapabilities: ['transport.grpc-web'],
      requiredDependencies: [],
      timeoutMs: 5_000,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('present: transport.grpc-web');
  });

  /*
   * A capability the plane lists as `enabled: false` is not "present". The
   * whole surface is reported at every startup, health-only included, so a
   * refusal that keyed on the name appearing in the list at all would fail
   * every deployment there is.
   */
  it('accepts a refused capability that the plane reports disabled', async () => {
    const baseUrl = await startHealthOnlyPlane();

    const outcome = await runHealthcheck({
      baseUrl,
      requiredCapabilities: ['control.health'],
      refusedCapabilities: ['sync.device-lifecycle', 'materials.storage-grants'],
      requiredDependencies: [],
      timeoutMs: 5_000,
    });

    expect(outcome.exitCode).toBe(0);
  });

  /*
   * The assertion the CI smoke job makes against the compose stack, made here
   * against the same code path with a scripted database. `sync.realtime-admission`
   * is the capability the container has and a serverless deployment does not.
   */
  it('exits 0 against an auth-configured plane asked for its durable surface', async () => {
    const database = new RecordingSqlClient();
    const migrationRunner = vi.fn(async (): Promise<MigrationRunResult> => emptyMigrationResult());
    const running = await startControlPlane(authenticatedConfig(), {
      pairedDeviceLifecycle: { database, migrationRunner },
    });
    closeControlPlane = running.close;
    const { port } = running.server.address() as AddressInfo;

    const outcome = await runHealthcheck({
      baseUrl: `http://127.0.0.1:${port}`,
      requiredCapabilities: ['sync.device-lifecycle', 'sync.realtime-admission', 'settings'],
      refusedCapabilities: ['materials.storage-grants'],
      requiredDependencies: [],
      timeoutMs: 5_000,
    });

    expect(outcome.exitCode).toBe(0);
    // Nothing the probe prints may carry a deployment secret. It reads none, and
    // this is what keeps that true if the report ever starts quoting the config.
    expect(outcome.report).not.toContain(bootstrapSecretForTest);
    expect(outcome.report).not.toContain(tokenPepperForTest);
  });

  /*
   * `Health` reports the service `SERVING` whether or not its dependencies are
   * configured, which is right -- a control plane with no Redis is serving. The
   * two cases below are what lets a deployment that configured one say so, and
   * are what the CI smoke job asserts against the compose stack: `database`
   * SERVING there means the TCP driver reached PostgreSQL, because the HTTP
   * driver cannot reach a host on a container network at all.
   */
  it('exits 0 when a named dependency is itself SERVING', async () => {
    const baseUrl = await startAuthenticatedPlane();

    const outcome = await runHealthcheck({
      baseUrl,
      requiredCapabilities: [],
      refusedCapabilities: [],
      requiredDependencies: ['database'],
      timeoutMs: 5_000,
    });

    expect(outcome.exitCode).toBe(0);
  });

  it('exits non-zero when a named dependency is unconfigured or absent', async () => {
    const baseUrl = await startAuthenticatedPlane();

    // `redis` is reported and unconfigured in this startup; `storage` likewise.
    await expect(
      runHealthcheck({
        baseUrl,
        requiredCapabilities: [],
        refusedCapabilities: [],
        requiredDependencies: ['redis'],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ exitCode: 1, report: expect.stringContaining('without redis') });

    // A dependency the process never reports at all fails for the stronger
    // reason, and must not read as satisfied through an absent entry.
    await expect(
      runHealthcheck({
        baseUrl,
        requiredCapabilities: [],
        refusedCapabilities: [],
        requiredDependencies: ['a-dependency-this-service-does-not-have'],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  /*
   * The property an orchestrator depends on above all others: a plane that is
   * not there fails the probe rather than throwing out of it. The port is one
   * the operating system has just handed back, so the connection is refused
   * immediately and nothing in this case waits on a timeout.
   */
  it('exits non-zero, without throwing, when nothing answers at the address', async () => {
    const running = await startControlPlane(healthOnlyConfig());
    const { port } = running.server.address() as AddressInfo;
    await running.close();

    const outcome = await runHealthcheck({
      baseUrl: `http://127.0.0.1:${port}`,
      requiredCapabilities: ['control.health'],
      refusedCapabilities: [],
      requiredDependencies: [],
      timeoutMs: 2_000,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('did not answer');
  });

  describe('arguments', () => {
    /*
     * The container binds the wildcard address, which cannot be connected to.
     * The image's own HEALTHCHECK passes no `--base-url`, so this default is
     * the whole of what it probes.
     */
    it('probes loopback when the process binds the wildcard address', () => {
      expect(
        parseHealthcheckArguments([], {
          HQ_CONTROL_PLANE_HOST: '0.0.0.0',
          HQ_CONTROL_PLANE_PORT: '4100',
        }).baseUrl,
      ).toBe('http://127.0.0.1:4100');
      expect(parseHealthcheckArguments([], { HQ_CONTROL_PLANE_HOST: '::' }).baseUrl).toBe(
        'http://[::1]:4100',
      );
      expect(parseHealthcheckArguments([], {}).baseUrl).toBe('http://127.0.0.1:4100');
    });

    it('keeps a named host and brackets an IPv6 literal', () => {
      expect(
        parseHealthcheckArguments([], {
          HQ_CONTROL_PLANE_HOST: 'control-plane',
          HQ_CONTROL_PLANE_PORT: '9000',
        }).baseUrl,
      ).toBe('http://control-plane:9000');
      expect(parseHealthcheckArguments([], { HQ_CONTROL_PLANE_HOST: 'fd00::1' }).baseUrl).toBe(
        'http://[fd00::1]:4100',
      );
    });

    it('collects every repetition of the three list flags', () => {
      const options = parseHealthcheckArguments([
        '--base-url',
        'http://127.0.0.1:4100',
        '--require-capability',
        'sync.device-lifecycle',
        '--require-capability',
        'sync.realtime-admission',
        '--refuse-capability',
        'materials.storage-grants',
        '--require-dependency',
        'database',
        '--timeout-ms',
        '1500',
      ]);

      expect(options).toEqual({
        baseUrl: 'http://127.0.0.1:4100',
        requiredCapabilities: ['sync.device-lifecycle', 'sync.realtime-admission'],
        refusedCapabilities: ['materials.storage-grants'],
        requiredDependencies: ['database'],
        timeoutMs: 1_500,
      });
    });

    /*
     * A HEALTHCHECK line is written once and read by nobody again. A misspelled
     * flag that was ignored would leave the probe asserting less than the
     * Dockerfile says it does, and every run would still be green.
     */
    it('refuses an unknown flag and a flag with no value', () => {
      expect(() => parseHealthcheckArguments(['--require-capabilities', 'sync'])).toThrow(
        'Unknown healthcheck argument: --require-capabilities',
      );
      expect(() => parseHealthcheckArguments(['--require-capability'])).toThrow(
        '--require-capability requires a value',
      );
      expect(() =>
        parseHealthcheckArguments(['--require-capability', '--refuse-capability', 'sync']),
      ).toThrow('--require-capability requires a value');
      expect(() => parseHealthcheckArguments(['--timeout-ms', '0'])).toThrow(
        '--timeout-ms must be between 1 and 60000',
      );
    });
  });

  async function startAuthenticatedPlane(): Promise<string> {
    const migrationRunner = vi.fn(async (): Promise<MigrationRunResult> => emptyMigrationResult());
    const running = await startControlPlane(authenticatedConfig(), {
      pairedDeviceLifecycle: { database: new RecordingSqlClient(), migrationRunner },
    });
    closeControlPlane = running.close;
    const { port } = running.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async function startHealthOnlyPlane(): Promise<string> {
    const databaseFactory = vi.fn<SqlClientFactory>(() => new RecordingSqlClient());
    const running = await startControlPlane(healthOnlyConfig(), {
      pairedDeviceLifecycle: { databaseFactory },
    });
    closeControlPlane = running.close;
    const { port } = running.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }
});

const tokenPepperForTest = 'healthcheck-token-pepper-value-not-in-any-report';
const bootstrapSecretForTest = 'healthcheck-bootstrap-secret-not-in-any-report';

function healthOnlyConfig(): ControlPlaneConfig {
  return { port: 0, host: '127.0.0.1', allowedOrigins: ['http://127.0.0.1:3000'] };
}

function authenticatedConfig(overrides: Partial<ControlPlaneAuthConfig> = {}): ControlPlaneConfig {
  return {
    ...healthOnlyConfig(),
    databaseUrl: 'postgresql://role:password@postgres:5432/headquarters?sslmode=disable',
    databaseDriver: 'postgres',
    auth: {
      tokenHashVersion: 'v1',
      accessTokenLifetimeMs: 120_000,
      refreshTokenLifetimeMs: 7_200_000,
      pairingCodeLifetimeMs: 1_800_000,
      hashCredential: (kind, raw) => `${tokenPepperForTest}-${kind}-${raw.length}`,
      verifyBootstrapSecret: (candidate) => candidate === bootstrapSecretForTest,
      ...overrides,
    },
  };
}

function emptyMigrationResult(): MigrationRunResult {
  return { applied: [], skipped: [] };
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
