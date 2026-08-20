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

  it(
    'answers a retried pairing once, from the receipt, without a second redemption',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const grant = await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR');
      const request = { ...newDevice(grant.code), mutation: { requestId: uniqueSuffix() } };

      const first = await runtime.pairDevice(request);
      const retry = await runtime.pairDevice(request);

      expect(retry.device.id).toBe(first.device.id);
      // One mutation means one revision bump. A second redemption would show up
      // here even if the response happened to look identical.
      expect(retry.group.revision).toBe(first.group.revision);
      const state = await database.query<{ devices: number; consumed: number }>({
        text: `SELECT
                 (SELECT count(*)::int FROM group_memberships
                   WHERE group_id = $1 AND revoked_at IS NULL) AS devices,
                 (SELECT count(*)::int FROM pairing_codes
                   WHERE group_id = $1 AND consumed_at IS NOT NULL) AS consumed`,
        values: [owner.groupId],
      });
      expect(state[0]).toEqual({ devices: 2, consumed: 1 });

      // Credentials are re-issued rather than replayed, so what matters is that
      // the retry's credentials actually authenticate.
      const identity = await runtime.authenticateAccessToken(retry.session.accessToken);
      expect(identity.device.id).toBe(first.device.id);
      expect(identity.role).toBe('EDITOR');
    },
    networkTimeoutMs,
  );

  it(
    'admits exactly one device when two identical retries race',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const grant = await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR');
      const request = { ...newDevice(grant.code), mutation: { requestId: uniqueSuffix() } };

      const [left, right] = await Promise.all([
        runtime.pairDevice(request),
        runtime.pairDevice(request),
      ]);

      // The receipt row lock serializes the two calls: one performs the
      // mutation, the other is refused the claim and replays its outcome.
      expect(left.device.id).toBe(right.device.id);
      const state = await database.query<{ members: number; receipts: number }>({
        text: `SELECT
                 (SELECT count(*)::int FROM group_memberships
                   WHERE group_id = $1 AND revoked_at IS NULL) AS members,
                 (SELECT count(*)::int FROM mutation_receipts
                   WHERE scope = 'PAIR_DEVICE'
                     AND completed_at IS NOT NULL
                     AND group_id = $1) AS receipts`,
        values: [owner.groupId],
      });
      expect(state[0]?.members).toBe(2);
      expect(state[0]?.receipts).toBe(1);
    },
    networkTimeoutMs,
  );

  it(
    'treats a retried refresh as a retry, and the same token without one as a replay',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const mutation = { requestId: uniqueSuffix() };

      const rotated = await runtime.refreshDeviceSession(owner.refreshToken, mutation);
      // The retry presents the token rotation just retired. Without a receipt
      // this is indistinguishable from a stolen-credential replay, and the
      // session family would be revoked.
      const retry = await runtime.refreshDeviceSession(owner.refreshToken, mutation);

      expect(retry.deviceId).toBe(rotated.deviceId);
      const identity = await runtime.authenticateAccessToken(retry.accessToken);
      expect(identity.device.id).toBe(rotated.deviceId);
      const sessions = await database.query<{ n: number }>({
        text: `SELECT count(*)::int AS n FROM device_sessions
               WHERE device_id = $1 AND revoked_reason = 'REFRESH_REPLAY'`,
        values: [rotated.deviceId],
      });
      expect(sessions[0]?.n).toBe(0);

      // Receipts add a retry path without weakening replay defence: the same
      // presentation with no request identifier still revokes the family.
      await expect(runtime.refreshDeviceSession(owner.refreshToken)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      const revoked = await database.query<{ n: number }>({
        text: `SELECT count(*)::int AS n FROM device_sessions
               WHERE device_id = $1 AND revoked_reason = 'REFRESH_REPLAY'`,
        values: [rotated.deviceId],
      });
      expect(revoked[0]?.n).toBe(1);
    },
    networkTimeoutMs,
  );

  it(
    'rejects a request identifier reused with a different payload',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const first = await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR');
      const second = await runtime.createPairingCode(owner.authenticated, owner.groupId, 'VIEWER');
      const requestId = uniqueSuffix();
      await runtime.pairDevice({ ...newDevice(first.code), mutation: { requestId } });

      await expect(
        runtime.pairDevice({ ...newDevice(second.code), mutation: { requestId } }),
      ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });

      const unconsumed = await database.query<{ n: number }>({
        text: `SELECT count(*)::int AS n FROM pairing_codes
               WHERE group_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
        values: [owner.groupId],
      });
      expect(unconsumed[0]?.n).toBe(1);
    },
    networkTimeoutMs,
  );

  it(
    'leaves a request identifier reusable when its mutation failed',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const mutation = { requestId: uniqueSuffix() };

      await expect(
        runtime.pairDevice({ ...newDevice('hq_pair_never-issued'), mutation }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

      // The failed attempt committed an incomplete receipt. It must stay
      // re-claimable, or one lost request would burn the identifier forever.
      const grant = await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR');
      const paired = await runtime.pairDevice({ ...newDevice(grant.code), mutation });
      expect(paired.device.role).toBe('EDITOR');
    },
    networkTimeoutMs,
  );

  it(
    'refuses to re-issue credentials from a receipt after the device is revoked',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const grant = await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR');
      const request = { ...newDevice(grant.code), mutation: { requestId: uniqueSuffix() } };
      const paired = await runtime.pairDevice(request);

      await runtime.revokeDevice(owner.authenticated, owner.groupId, paired.device.id);

      // A receipt records identity, never authority. Re-issuance re-checks
      // membership, device status and session liveness against the database.
      await expect(runtime.pairDevice(request)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    },
    networkTimeoutMs,
  );

  it(
    'persists no raw credential or request identifier in a receipt row',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const grant = await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR');
      const requestId = uniqueSuffix();
      const paired = await runtime.pairDevice({
        ...newDevice(grant.code),
        mutation: { requestId },
      });

      const rows = await database.query<Record<string, unknown>>({
        text: `SELECT * FROM mutation_receipts
               WHERE scope = 'PAIR_DEVICE'
                 AND session_id IS NOT NULL
                 AND group_id = $1`,
        values: [paired.group.id],
      });
      expect(rows).toHaveLength(1);
      const serialized = JSON.stringify(rows[0]);
      for (const secret of [
        requestId,
        grant.code,
        paired.session.accessToken,
        paired.session.refreshToken,
      ]) {
        expect(serialized).not.toContain(secret);
      }
      expect(rows[0]?.session_id).toEqual(expect.any(String));
    },
    networkTimeoutMs,
  );

  it(
    'answers a retried bootstrap without creating a second group',
    async () => {
      const runtime = createRuntime();
      const request = {
        name: `Terminal ${uniqueSuffix()}`,
        initialDevice: {
          name: 'HQ primary',
          publicKey: `ed25519:${uniqueSuffix()}`,
          platform: 'windows',
          applicationVersion: '0.1.0',
        },
        mutation: { requestId: uniqueSuffix() },
      };

      const first = await runtime.createGroup(request);
      const retry = await runtime.createGroup(request);

      expect(retry.group.id).toBe(first.group.id);
      expect(retry.device.id).toBe(first.device.id);
      const groups = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM groups WHERE name = $1',
        values: [request.name],
      });
      expect(groups[0]?.n).toBe(1);
      const identity = await runtime.authenticateAccessToken(retry.session.accessToken);
      expect(identity.group.id).toBe(first.group.id);
      expect(identity.role).toBe('ADMIN');
    },
    networkTimeoutMs,
  );

  it(
    'retires the code a retried pairing-code request already minted',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const mutation = { requestId: uniqueSuffix() };

      const first = await runtime.createPairingCode(
        owner.authenticated,
        owner.groupId,
        'EDITOR',
        mutation,
      );
      const retry = await runtime.createPairingCode(
        owner.authenticated,
        owner.groupId,
        'EDITOR',
        mutation,
      );

      expect(retry.code).not.toBe(first.code);
      // Exactly one live capability per request. Without the retirement the
      // operator would hold one code while a second stayed redeemable.
      const live = await database.query<{ n: number }>({
        text: `SELECT count(*)::int AS n FROM pairing_codes
               WHERE group_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
        values: [owner.groupId],
      });
      expect(live[0]?.n).toBe(1);
      await expect(runtime.pairDevice(newDevice(first.code))).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      const paired = await runtime.pairDevice(newDevice(retry.code));
      expect(paired.device.role).toBe('EDITOR');
    },
    networkTimeoutMs,
  );

  it(
    'refuses to mint a replacement once the recorded code has been consumed',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const mutation = { requestId: uniqueSuffix() };
      const grant = await runtime.createPairingCode(
        owner.authenticated,
        owner.groupId,
        'EDITOR',
        mutation,
      );
      await runtime.pairDevice(newDevice(grant.code));

      await expect(
        runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR', mutation),
      ).rejects.toMatchObject({ code: 'FAILED_PRECONDITION' });
    },
    networkTimeoutMs,
  );

  it(
    'answers a retried revoke with the revision its own mutation produced',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const first = await runtime.pairDevice(
        newDevice(
          (await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR')).code,
        ),
      );
      const second = await runtime.pairDevice(
        newDevice(
          (await runtime.createPairingCode(owner.authenticated, owner.groupId, 'EDITOR')).code,
        ),
      );
      const mutation = { requestId: uniqueSuffix() };

      const revoked = await runtime.revokeDevice(
        owner.authenticated,
        owner.groupId,
        first.device.id,
        mutation,
      );
      // An unrelated revoke moves the group on. A replay that re-read the group
      // would report a revision this caller never produced.
      await runtime.revokeDevice(owner.authenticated, owner.groupId, second.device.id);
      const retry = await runtime.revokeDevice(
        owner.authenticated,
        owner.groupId,
        first.device.id,
        mutation,
      );

      expect(retry.device.id).toBe(revoked.device.id);
      expect(retry.device.status).toBe('REVOKED');
      expect(retry.group.revision).toBe(revoked.group.revision);
      const group = await database.query<{ revision: string }>({
        text: 'SELECT revision::text AS revision FROM groups WHERE id = $1',
        values: [owner.groupId],
      });
      // Two revokes happened, so the group is one ahead of the replayed value:
      // the retry bumped nothing.
      expect(BigInt(group[0]?.revision ?? '0')).toBe(revoked.group.revision + 1n);
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
