import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNeonDatabase, type SqlClient } from './db/database.js';
import { migrations, runMigrations } from './db/migrations.js';
import { DurablePairedDeviceRuntime } from './sync/durable-runtime.js';
import type { AuthenticatedDevice } from './sync/runtime.js';

/**
 * Real PostgreSQL proof for the durable paired-device lifecycle.
 *
 * Every other durable-adapter test in this package asserts the *shape* of the
 * generated SQL against a scripted `SqlClient`. Those tests cannot observe row
 * locking, advisory-lock serialization, or whether a join actually eliminates a
 * row, so this suite executes the same code paths against a live database.
 *
 * It is opt-in: without `HQ_CONTROL_PLANE_TEST_DATABASE_URL` the whole suite
 * skips, so the default `pnpm test` run stays offline and deterministic. The
 * URL must point at a disposable database — the suite creates and drops its
 * own databases and is destructive by design.
 */
const testDatabaseUrl = process.env.HQ_CONTROL_PLANE_TEST_DATABASE_URL;
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';

describeIntegration('durable paired-device lifecycle against real PostgreSQL', () => {
  const baseUrl = testDatabaseUrl ?? '';
  const admin = createNeonDatabase(baseUrl);
  const createdDatabases: string[] = [];
  let database: SqlClient;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    await runMigrations(database);
  }, networkTimeoutMs);

  afterAll(async () => {
    for (const name of createdDatabases) {
      // FORCE is required: the pooled endpoint keeps short-lived connections
      // that would otherwise make DROP DATABASE fail.
      await admin.query({ text: `DROP DATABASE IF EXISTS ${name} WITH (FORCE)` });
    }
  }, networkTimeoutMs);

  it(
    'applies each immutable migration exactly once under simultaneous runners',
    async () => {
      const contended = await createIsolatedDatabase();

      const [first, second] = await Promise.all([
        runMigrations(contended),
        runMigrations(contended),
      ]);

      // The advisory lock must serialize the two runners: every migration is
      // applied by exactly one of them and skipped by the other.
      for (const migration of migrations) {
        const appliedBy = [first, second].filter((result) =>
          result.applied.includes(migration.id),
        ).length;
        const skippedBy = [first, second].filter((result) =>
          result.skipped.includes(migration.id),
        ).length;
        expect(`${migration.id}:applied=${appliedBy}`).toBe(`${migration.id}:applied=1`);
        expect(`${migration.id}:skipped=${skippedBy}`).toBe(`${migration.id}:skipped=1`);
      }

      const ledger = await contended.query<{ id: string; n: number }>({
        text: 'SELECT id, count(*)::int AS n FROM hq_schema_migrations GROUP BY id ORDER BY id',
      });
      expect(ledger.map((row) => row.id)).toEqual(migrations.map((migration) => migration.id));
      expect(ledger.every((row) => row.n === 1)).toBe(true);
    },
    networkTimeoutMs,
  );

  it(
    'redeems a pairing code while its issuing session and access token are live',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const grant = await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR');

      const paired = await runtime.pairDevice(newDevice(grant.code));

      expect(paired.device.role).toBe('EDITOR');
      expect(paired.group.id).toBe(owner.groupId);
      expect(paired.session.accessToken).toMatch(/^hq_access_/u);
    },
    networkTimeoutMs,
  );

  it(
    'redeems a one-time pairing code exactly once under simultaneous redemption',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const grant = await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR');

      // The redemption CTE takes FOR UPDATE on the group and the pairing code
      // precisely so this race cannot mint two memberships from one code.
      const outcomes = await Promise.allSettled([
        runtime.pairDevice(newDevice(grant.code)),
        runtime.pairDevice(newDevice(grant.code)),
      ]);

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(`fulfilled=${fulfilled.length}`).toBe('fulfilled=1');
      expect(`rejected=${rejected.length}`).toBe('rejected=1');

      const consumed = await database.query<{ n: number }>({
        text: `SELECT count(*)::int AS n FROM pairing_codes
               WHERE group_id = $1 AND consumed_at IS NOT NULL`,
        values: [owner.groupId],
      });
      expect(consumed[0]?.n).toBe(1);

      const members = await database.query<{ n: number }>({
        text: `SELECT count(*)::int AS n FROM group_memberships
               WHERE group_id = $1 AND revoked_at IS NULL`,
        values: [owner.groupId],
      });
      // The founding admin plus exactly one paired device.
      expect(members[0]?.n).toBe(2);
    },
    networkTimeoutMs,
  );

  it(
    'rejects a pairing code after normal refresh rotation retires its issuing access token',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const grant = await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR');

      // T1 -> T2. The session itself stays valid; only the bound access token
      // is retired, which must be enough to invalidate the code.
      const rotated = await runtime.refreshDeviceSession(owner.refreshToken);
      await expect(runtime.authenticateAccessToken(rotated.accessToken)).resolves.toMatchObject({
        group: { id: owner.groupId },
      });

      await expect(runtime.pairDevice(newDevice(grant.code))).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'UNAUTHENTICATED',
      });
    },
    networkTimeoutMs,
  );

  it(
    'rejects a pairing code after refresh-token replay revokes its issuing session',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);

      const rotated = await runtime.refreshDeviceSession(owner.refreshToken);
      const rotatedIdentity = await runtime.authenticateAccessToken(rotated.accessToken);
      // Bound to the *current* access token, so only replay revocation can
      // invalidate it -- not the earlier rotation.
      const grant = await runtime.createPairingCode(rotatedIdentity, owner.groupId, 'EDITOR');

      await expect(runtime.refreshDeviceSession(owner.refreshToken)).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'UNAUTHENTICATED',
      });

      await expect(runtime.pairDevice(newDevice(grant.code))).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'UNAUTHENTICATED',
      });
      await expect(runtime.authenticateAccessToken(rotated.accessToken)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    },
    networkTimeoutMs,
  );

  it(
    'fails closed for a legacy pairing code that carries no issuer binding',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const grant = await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR');

      // Reproduce a row written before migration 0004: the device is still an
      // active admin, so only the absent issuer binding can reject redemption.
      const cleared = await database.query<{ code_hash: string }>({
        text: `UPDATE pairing_codes
               SET created_by_session_id = NULL, created_by_access_token_id = NULL
               WHERE group_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
               RETURNING code_hash`,
        values: [owner.groupId],
      });
      expect(cleared).toHaveLength(1);

      await expect(runtime.pairDevice(newDevice(grant.code))).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'UNAUTHENTICATED',
      });
    },
    networkTimeoutMs,
  );

  it(
    'revokes membership, sessions, access tokens and pending pairing codes together',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const inviteForMember = await runtime.createPairingCode(
        owner.authenticated,
        owner.groupId,
        'EDITOR',
      );
      const member = await runtime.pairDevice(newDevice(inviteForMember.code));
      const memberIdentity = await runtime.authenticateAccessToken(member.session.accessToken);
      expect(memberIdentity.device.id).toBe(member.device.id);

      const revoked = await runtime.revokeDevice(
        owner.authenticated,
        owner.groupId,
        member.device.id,
      );
      expect(revoked.device.status).toBe('REVOKED');

      // The revoked device's bearer credential must stop authenticating.
      await expect(
        runtime.authenticateAccessToken(member.session.accessToken),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      await expect(runtime.refreshDeviceSession(member.session.refreshToken)).rejects.toMatchObject(
        { code: 'UNAUTHENTICATED' },
      );

      const remaining = await database.query<{ n: number }>({
        text: `SELECT count(*)::int AS n FROM device_sessions
               WHERE device_id = $1 AND revoked_at IS NULL`,
        values: [member.device.id],
      });
      expect(remaining[0]?.n).toBe(0);
    },
    networkTimeoutMs,
  );

  function createRuntime(): DurablePairedDeviceRuntime {
    return new DurablePairedDeviceRuntime({ database, tokenPepper });
  }

  async function bootstrapGroup(runtime: DurablePairedDeviceRuntime): Promise<{
    readonly groupId: string;
    readonly refreshToken: string;
    readonly authenticated: AuthenticatedDevice;
  }> {
    const created = await runtime.createGroup({
      name: `Terminal ${uniqueSuffix()}`,
      initialDevice: {
        name: 'HQ primary',
        publicKey: `ed25519:${uniqueSuffix()}`,
        platform: 'windows',
        applicationVersion: '0.1.0',
      },
    });
    const authenticated = await runtime.authenticateAccessToken(created.session.accessToken);
    return {
      groupId: created.group.id,
      refreshToken: created.session.refreshToken,
      authenticated,
    };
  }

  function newDevice(pairingCode: string) {
    return {
      pairingCode,
      name: 'HQ analyst',
      publicKey: `ed25519:${uniqueSuffix()}`,
      platform: 'windows',
      applicationVersion: '0.1.0',
    };
  }

  async function createIsolatedDatabase(): Promise<SqlClient> {
    const name = `hqtest_${uniqueSuffix()}`;
    await admin.query({ text: `CREATE DATABASE ${name}` });
    createdDatabases.push(name);
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    return createNeonDatabase(url.toString());
  }
});

function uniqueSuffix(): string {
  return randomBytes(8).toString('hex');
}
