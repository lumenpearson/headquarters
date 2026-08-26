import { describe, expect, it, vi } from 'vitest';

import type {
  ControlPlaneAuthConfig,
  ControlPlaneConfig,
  ControlPlaneStorageConfig,
} from '../config.js';
import type { SqlClient, SqlClientFactory, SqlStatement } from '../db/database.js';
import type { MigrationRunResult } from '../db/migrations.js';
import type { StorageGrantIssuerFactory } from '../storage/s3-grant-issuer.js';

import {
  createConfiguredPairedDeviceLifecycle,
  type MigrationRunner,
} from './configured-lifecycle.js';

const databaseUrl = 'postgresql://role:password@ep-hq.neon.tech/headquarters?sslmode=require';
const fixedNow = new Date('2026-08-18T09:00:00.000Z');

describe('configured paired-device lifecycle', () => {
  it('keeps health-only control-plane configuration free of database and auth side effects', async () => {
    const databaseFactory = vi.fn<SqlClientFactory>(() => new RecordingSqlClient());

    await expect(
      createConfiguredPairedDeviceLifecycle(
        { port: 0, host: '127.0.0.1', allowedOrigins: ['http://127.0.0.1:3000'] },
        { databaseFactory },
      ),
    ).resolves.toBeUndefined();

    expect(databaseFactory).not.toHaveBeenCalled();
  });

  it('runs migrations before returning a durable lifecycle, SyncService, and authenticated realtime admission', async () => {
    // The first scripted answer is the installation identity startup reads
    // straight after the migration gate; the two after it are the lifecycle's.
    const database = new RecordingSqlClient([
      [{ installation_id: '3f1c2b7a-0d4e-4f6a-9c2b-8e1d5a7c9f30' }],
      [createdLifecycleRow()],
      [pairingCodeRow()],
    ]);
    const events: string[] = [];
    const hashCredential = vi.fn(
      (kind: 'access' | 'pair' | 'refresh', raw: string) => `configured-${kind}-${raw.length}`,
    );
    const verifyBootstrapSecret = vi.fn(
      (candidate: string) => candidate === 'test-bootstrap-secret',
    );
    const migrationRunner = vi.fn<MigrationRunner>(async (client) => {
      events.push('migrations');
      expect(client).toBe(database);
      return { applied: ['0001_control_plane_foundation'], skipped: [] };
    });

    const configured = await createConfiguredPairedDeviceLifecycle(
      authenticatedConfig({ hashCredential, verifyBootstrapSecret }),
      {
        database,
        migrationRunner,
        now: () => fixedNow,
        randomBytes: deterministicRandomBytes(),
      },
    );

    expect(configured).toBeDefined();
    if (configured === undefined) throw new Error('Configured lifecycle was not created');

    expect(configured.migrations).toEqual({
      applied: ['0001_control_plane_foundation'],
      skipped: [],
    });
    // Read after the gate and carried onto the lifecycle, so `GetCapabilities`
    // reports which database the migrations above just ran against.
    expect(configured.installationId).toBe('3f1c2b7a-0d4e-4f6a-9c2b-8e1d5a7c9f30');
    expect(configured.syncService.createGroup).toBeTypeOf('function');
    expect(configured.realtime.admission).toBeDefined();
    expect(events).toEqual(['migrations']);

    const created = await configured.runtime.createGroup({
      name: 'Gremuchaya operational group',
      initialDevice: {
        name: 'Primary workstation',
        publicKey: 'ed25519:primary',
        platform: 'windows',
        applicationVersion: '0.1.0',
      },
    });
    await configured.runtime.createPairingCode(
      {
        group: created.group,
        device: created.device,
        role: created.device.role,
        sessionId: '018b2a02-0000-7000-8000-000000000003',
        accessTokenId: '018b2a02-0000-7000-8000-000000000004',
      },
      created.group.id,
      'EDITOR',
    );

    expect(events).toEqual(['migrations']);
    // The installation read at index 0, then the two mutations above it.
    expect(database.queries).toHaveLength(3);
    const createGroupStatement = database.queries[1];
    const createPairingCodeStatement = database.queries[2];
    expect(createGroupStatement?.values).toContainEqual(new Date('2026-08-18T09:02:00.000Z'));
    expect(createGroupStatement?.values).toContainEqual(new Date('2026-08-18T11:00:00.000Z'));
    expect(createPairingCodeStatement?.values).toContainEqual(new Date('2026-08-18T09:30:00.000Z'));
    expect(hashCredential.mock.calls.map(([kind]) => kind)).toEqual(['access', 'refresh', 'pair']);
    expect(verifyBootstrapSecret).not.toHaveBeenCalled();

    await expect(
      configured.realtime.admission?.admit({
        accessToken: 'opaque-access-token',
        groupId: '018b2a02-0000-7000-8000-000000000001',
        deviceId: '018b2a02-0000-7000-8000-000000000002',
      }),
    ).resolves.toBe(false);
    expect(hashCredential).toHaveBeenLastCalledWith('access', 'opaque-access-token');
  });

  it('uses the Neon SqlClient factory after auth is configured without opening a live connection in tests', async () => {
    const driver = new RecordingSqlClient();
    const databaseFactory = vi.fn<SqlClientFactory>(() => driver);
    const migrationRunner = vi.fn<MigrationRunner>(async (database) => {
      await database.query({ text: 'SELECT 1' });
      return emptyMigrationResult();
    });

    await createConfiguredPairedDeviceLifecycle(authenticatedConfig(), {
      databaseFactory,
      migrationRunner,
    });

    expect(databaseFactory).toHaveBeenCalledExactlyOnceWith(databaseUrl);
    // The migration runner's own statement, then the one read of the
    // installation identity. Nothing else reaches the driver at startup.
    expect(driver.queries.map((statement) => statement.text.split('\n')[0]?.trim())).toEqual([
      'SELECT 1',
      'SELECT installation_id::text AS installation_id',
    ]);
  });

  it('does not return enabled collaborators when the immutable migration gate fails', async () => {
    const database = new RecordingSqlClient();
    const migrationRunner = vi.fn<MigrationRunner>(async () => {
      throw new Error('migration gate failed');
    });

    await expect(
      createConfiguredPairedDeviceLifecycle(authenticatedConfig(), { database, migrationRunner }),
    ).rejects.toThrow('migration gate failed');
    expect(database.queries).toHaveLength(0);
  });

  /*
   * A serverless web deployment cold-starts often and concurrently, and each
   * start would otherwise open the same `pg_advisory_xact_lock` transaction.
   * `runMigrationsOnStart: false` says the sequence ran as a deployment step,
   * and this startup must then touch no ledger at all -- while still reading
   * the installation identity, because `GetCapabilities` reports it and a
   * client compares it before it trusts anything.
   */
  it('leaves the migration transaction to the deployment when the operator moved it there', async () => {
    const database = new RecordingSqlClient([
      [{ installation_id: '7d0a4e18-4b7c-4a51-9f2e-3c6b1d8a05f4' }],
    ]);
    const migrationRunner = vi.fn<MigrationRunner>(async () => emptyMigrationResult());

    const configured = await createConfiguredPairedDeviceLifecycle(
      { ...authenticatedConfig(), runMigrationsOnStart: false },
      { database, migrationRunner },
    );

    expect(migrationRunner).not.toHaveBeenCalled();
    expect(configured?.migrations).toEqual({ applied: [], skipped: [] });
    expect(configured?.installationId).toBe('7d0a4e18-4b7c-4a51-9f2e-3c6b1d8a05f4');
  });

  it('leaves presence on the durable store and reports Redis unconfigured when no Redis is set', async () => {
    const database = new RecordingSqlClient();

    const configured = await createConfiguredPairedDeviceLifecycle(authenticatedConfig(), {
      database,
      migrationRunner: async () => emptyMigrationResult(),
    });

    expect(configured?.coordination.configured).toBe(false);
    // Merely constructing the coordination client must not reach Upstash, or a
    // deployment without Redis could not start at all.
    expect(configured?.coordination.initialized).toBe(false);
  });

  it('coordinates presence through Redis once the pair is configured', async () => {
    const database = new RecordingSqlClient();
    const coordinationFactory = vi.fn(() => {
      throw new Error('the coordination client must stay lazy until it is used');
    });

    const configured = await createConfiguredPairedDeviceLifecycle(
      {
        ...authenticatedConfig(),
        redis: { restUrl: 'https://example.upstash.io', restToken: 'token-value' },
      },
      {
        database,
        migrationRunner: async () => emptyMigrationResult(),
        coordinationFactory,
      },
    );

    expect(configured?.coordination.configured).toBe(true);
    expect(coordinationFactory).not.toHaveBeenCalled();
    // The decorator is what turns a stale durable row into an OFFLINE reading,
    // so choosing it is the observable difference Redis makes here.
    expect(configured?.presence.constructor.name).toBe('CoordinatedPresenceStore');
  });

  it('builds the storage grant issuer from the storage configuration alone, and not otherwise', async () => {
    const storage: ControlPlaneStorageConfig = {
      endpoint: 'https://s3.example.test',
      region: 'eu-central-1',
      bucket: 'materials',
      forcePathStyle: false,
      grantTtlMs: 900_000,
      presign: () => new URL('https://materials.s3.example.test/x'),
      sign: () => ({}),
    };
    const storageFactory = vi.fn<StorageGrantIssuerFactory>(() => ({
      createMultipartUpload: () => ({ remoteUploadId: 'remote' }),
      issueUploadPart: () => ({ url: 'https://materials.s3.example.test/x', expiresAt: fixedNow }),
      completeMultipartUpload: () => undefined,
      abortMultipartUpload: () => undefined,
      issueDownload: () => ({ url: 'https://materials.s3.example.test/x', expiresAt: fixedNow }),
      issuePreview: () => ({ url: 'https://materials.s3.example.test/x', expiresAt: fixedNow }),
    }));

    const withoutStorage = await createConfiguredPairedDeviceLifecycle(authenticatedConfig(), {
      database: new RecordingSqlClient(),
      migrationRunner: async () => emptyMigrationResult(),
      storageFactory,
    });
    expect(withoutStorage?.storageConfigured).toBe(false);
    expect(storageFactory).not.toHaveBeenCalled();

    const withStorage = await createConfiguredPairedDeviceLifecycle(
      { ...authenticatedConfig(), storage },
      {
        database: new RecordingSqlClient(),
        migrationRunner: async () => emptyMigrationResult(),
        storageFactory,
      },
    );
    expect(withStorage?.storageConfigured).toBe(true);
    // The factory receives the frozen configuration itself, which is the only
    // object that can sign: the composition root never sees a key.
    expect(storageFactory).toHaveBeenCalledExactlyOnceWith(storage);
  });

  it('rejects manually constructed auth configuration without a database URL', async () => {
    await expect(
      createConfiguredPairedDeviceLifecycle({
        port: 0,
        host: '127.0.0.1',
        allowedOrigins: ['http://127.0.0.1:3000'],
        auth: authConfig(),
      }),
    ).rejects.toThrow('HQ_CONTROL_PLANE_DATABASE_URL');
  });
});

function authenticatedConfig(overrides: Partial<ControlPlaneAuthConfig> = {}): ControlPlaneConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    allowedOrigins: ['http://127.0.0.1:3000'],
    databaseUrl,
    auth: authConfig(overrides),
  };
}

function authConfig(overrides: Partial<ControlPlaneAuthConfig> = {}): ControlPlaneAuthConfig {
  return {
    tokenHashVersion: 'v1',
    accessTokenLifetimeMs: 120_000,
    refreshTokenLifetimeMs: 7_200_000,
    pairingCodeLifetimeMs: 1_800_000,
    hashCredential: (kind, raw) => `hash-${kind}-${raw.length}`,
    verifyBootstrapSecret: (candidate) => candidate === 'test-bootstrap-secret',
    ...overrides,
  };
}

function emptyMigrationResult(): MigrationRunResult {
  return { applied: [], skipped: [] };
}

class RecordingSqlClient implements SqlClient {
  readonly queries: SqlStatement[] = [];
  readonly transactions: SqlStatement[][] = [];
  readonly #responses: Array<readonly Record<string, unknown>[]>;

  constructor(responses: readonly (readonly Record<string, unknown>[])[] = []) {
    this.#responses = responses.map((response) => [...response]);
  }

  async query<Row extends Record<string, unknown>>(
    statement: SqlStatement,
  ): Promise<readonly Row[]> {
    this.queries.push({ text: statement.text, values: [...(statement.values ?? [])] });
    return (this.#responses.shift() ?? []) as readonly Row[];
  }

  async transaction(statements: readonly SqlStatement[]): Promise<void> {
    this.transactions.push([...statements]);
  }
}

function createdLifecycleRow(): Record<string, unknown> {
  return {
    group_id: '018b2a02-0000-7000-8000-000000000001',
    group_name: 'Gremuchaya operational group',
    group_authority_mode: 'LEADER',
    group_leader_device_id: '018b2a02-0000-7000-8000-000000000002',
    group_revision: '1',
    group_created_at: fixedNow,
    group_updated_at: fixedNow,
    device_id: '018b2a02-0000-7000-8000-000000000002',
    device_name: 'Primary workstation',
    device_public_key: 'ed25519:primary',
    device_platform: 'windows',
    device_application_version: '0.1.0',
    device_status: 'ONLINE',
    device_created_at: fixedNow,
    device_last_seen_at: fixedNow,
    role: 'ADMIN',
    session_id: '018b2a02-0000-7000-8000-000000000003',
    access_token_expires_at: new Date('2026-08-18T09:02:00.000Z'),
    refresh_token_expires_at: new Date('2026-08-18T11:00:00.000Z'),
  };
}

function pairingCodeRow(): Record<string, unknown> {
  return {
    pairing_group_id: '018b2a02-0000-7000-8000-000000000001',
    pairing_role: 'EDITOR',
    pairing_expires_at: new Date('2026-08-18T09:30:00.000Z'),
  };
}

function deterministicRandomBytes(): (size: number) => Uint8Array {
  let offset = 0;
  return (size) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) bytes[index] = (offset + index) & 0xff;
    offset += size;
    return bytes;
  };
}
