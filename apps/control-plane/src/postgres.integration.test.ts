import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { ControlPlaneService } from '@gremuchaya/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DurableConversionStore } from './conversion/store.js';
import type { SqlClient } from './db/database.js';
import { readInstallationId } from './db/installation.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from './db/liveDatabase.js';
import { migrations, runMigrations } from './db/migrations.js';
import { startControlPlane } from './server.js';
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
// This suite drops databases. Refusing to start beats warning in a comment:
// with both URLs configured, the two must not resolve to the same database.
// `liveTestDatabaseUrl` throws rather than skipping when they collide.
const testDatabaseUrl = liveTestDatabaseUrl();

const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';

describeIntegration('durable paired-device lifecycle against real PostgreSQL', () => {
  const pool = new DisposableDatabasePool(testDatabaseUrl ?? '');
  let database: SqlClient;

  beforeAll(async () => {
    // Sweep first: a previous run killed before `afterAll` leaves its database
    // behind, and the instant in the name is what makes that safe to decide.
    const swept = await pool.sweep();
    if (swept.dropped.length > 0) {
      // Raw stderr, not console.warn: Vitest's reporter intercepts console
      // output from hooks and never prints it, and a sweep that removes a
      // database has to be visible to whoever ran the suite.
      process.stderr.write(`Swept abandoned test databases: ${swept.dropped.join(', ')}\n`);
    }
    database = await pool.create();
    await runMigrations(database);
  }, networkTimeoutMs);

  afterAll(async () => {
    await pool.dropAll();
  }, networkTimeoutMs);

  it(
    'applies each immutable migration exactly once under simultaneous runners',
    async () => {
      const contended = await pool.create();

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

  /*
   * The property the reset detection rests on, proved rather than argued: the
   * identity is minted once and a second run of the whole sequence leaves it
   * exactly as it was. If a re-run could mint a new value, every paired client
   * would refuse its own control plane after a routine redeploy.
   */
  it(
    'keeps one installation identity across repeated migration runs',
    async () => {
      const first = await readInstallationId(database);
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

      await runMigrations(database);
      await runMigrations(database);

      expect(await readInstallationId(database)).toBe(first);
      const rows = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM control_plane_installation',
      });
      expect(rows[0]?.n).toBe(1);
    },
    networkTimeoutMs,
  );

  /*
   * The other half of the same property, and the one the feature exists for: a
   * database that was deleted and recreated at the same address reports a
   * different identity. Two disposable databases stand in for the same Neon
   * project before and after a re-provision.
   */
  it(
    'gives a freshly created database a different installation identity',
    async () => {
      const replacement = await pool.create();
      await runMigrations(replacement);

      const original = await readInstallationId(database);
      const replaced = await readInstallationId(replacement);

      expect(replaced).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
      expect(replaced).not.toBe(original);
    },
    networkTimeoutMs,
  );

  /*
   * Simultaneous runners against one empty database. The advisory lock already
   * serializes the sequence, and `ON CONFLICT (singleton) DO NOTHING` is the
   * second lock: whichever ordering wins, exactly one identity exists.
   */
  it(
    'mints exactly one installation identity under simultaneous first runs',
    async () => {
      const contended = await pool.create();

      await Promise.all([runMigrations(contended), runMigrations(contended)]);

      const rows = await contended.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM control_plane_installation',
      });
      expect(rows[0]?.n).toBe(1);
      expect(await readInstallationId(contended)).not.toBe('');
    },
    networkTimeoutMs,
  );

  /*
   * The whole chain, over the wire: a client that has not authenticated asks an
   * unauthenticated `GetCapabilities` and is told which database it is talking
   * to. Everything above proves the value; this proves it arrives.
   */
  it(
    'carries the identity of the live database to an unauthenticated client',
    async () => {
      const wireDatabase = await pool.create();
      await runMigrations(wireDatabase);
      const expected = await readInstallationId(wireDatabase);

      const running = await startControlPlane(
        {
          port: 0,
          host: '127.0.0.1',
          allowedOrigins: ['http://127.0.0.1:3000'],
          databaseUrl: testDatabaseUrl ?? '',
          auth: {
            tokenHashVersion: 'v1',
            accessTokenLifetimeMs: 900_000,
            refreshTokenLifetimeMs: 2_592_000_000,
            pairingCodeLifetimeMs: 600_000,
            // The probe under test is unauthenticated, so no credential is
            // ever hashed here; the closure exists because the presence of
            // `auth` is what makes startup build the durable lifecycle.
            hashCredential: (kind, credential) =>
              createHmac('sha256', tokenPepper).update(`${kind}:${credential}`).digest('base64url'),
            verifyBootstrapSecret: () => false,
          },
        },
        { pairedDeviceLifecycle: { database: wireDatabase } },
      );
      try {
        const address = running.server.address() as AddressInfo;
        const client = createClient(
          ControlPlaneService,
          createGrpcWebTransport({
            baseUrl: `http://127.0.0.1:${address.port}`,
            useBinaryFormat: true,
          }),
        );

        const capabilities = await client.getCapabilities({});

        expect(capabilities.installationId).toBe(expected);
        expect(capabilities.installationId).not.toBe('');
      } finally {
        await running.close();
      }
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

  /*
   * The conversion queue's one irreducibly concurrent claim.
   *
   * `conversion/store.test.ts` asserts that `FOR UPDATE ... SKIP LOCKED` is in
   * the statement, which proves nothing about what several workers do at the
   * same instant.
   *
   * Eight claims and eight queued jobs, not two and one, and the difference is
   * the whole test. Every claim orders by `created_at` and takes `LIMIT 1`, so
   * without `SKIP LOCKED` all eight select the same first row, serialize on its
   * lock, and each in turn re-checks a qual that still matches -- eight claims
   * of one job at attempts one through eight, seven of them rendering work
   * another worker owns. With it, each takes the next unlocked row. Two
   * concurrent claims against one row could not tell the two apart: they only
   * overlap if the second statement reaches the server before the first
   * commits, and that is a race the test would sometimes lose in the direction
   * of passing.
   */
  it(
    'hands eight queued conversion jobs to eight concurrent workers, one each',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const kinds = ['1080p', '720p', '480p', 'thumbnail', 'k5', 'k6', 'k7', 'k8'];
      const queued = await queueConversionJobs(owner.groupId, kinds);
      const store = new DurableConversionStore({ database });

      const claims = await Promise.all(kinds.map(() => store.claimNextJob()));

      const claimed = claims.filter((claim) => claim !== undefined);
      expect(claimed).toHaveLength(kinds.length);
      // Distinct rows: the property `SKIP LOCKED` exists to provide.
      expect(new Set(claimed.map((claim) => claim.jobId)).size).toBe(kinds.length);
      expect(new Set(claimed.map((claim) => claim.variant))).toEqual(new Set(kinds));
      // One increment each. A row claimed twice would come back at attempt two
      // and would have broken the fence for whichever worker holds attempt one.
      expect(claimed.every((claim) => claim.attempt === 1)).toBe(true);
      const rows = await database.query<{ state: string; attempt: number }>({
        text: 'SELECT state, attempt FROM conversion_jobs WHERE version_id = $1',
        values: [queued.versionId],
      });
      expect(rows.map((row) => row.state)).toEqual(kinds.map(() => 'RUNNING'));
      expect(rows.every((row) => row.attempt === 1)).toBe(true);
    },
    networkTimeoutMs,
  );

  /*
   * The other half of the same argument, on the write side. Two workers that
   * both believe they hold the job -- the stale one and the one that took it
   * over -- must not both record a rendition. The attempt fence decides.
   */
  it(
    'lets only the current attempt record a rendition for one job',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const queued = await queueOneConversionJob(owner.groupId);
      const store = new DurableConversionStore({ database, leaseMs: 1 });

      const stale = await store.claimNextJob();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const live = await store.claimNextJob();
      expect(live?.jobId).toBe(stale?.jobId);
      expect(live?.attempt).toBe(2);

      const [liveRecorded, staleRecorded] = await Promise.all([
        store.completeJob(live ?? unclaimed(), {
          storageKey: `renditions/${owner.groupId}/${queued.contentHash}/720p.mp4`,
          mimeType: 'video/mp4',
          byteSize: 4_096n,
          width: 1280,
          height: 720,
        }),
        store.completeJob(stale ?? unclaimed(), {
          storageKey: `renditions/${owner.groupId}/${queued.contentHash}/720p.mp4`,
          mimeType: 'video/mp4',
          byteSize: 8n,
          width: 4,
          height: 4,
        }),
      ]);

      expect(liveRecorded).toBe(true);
      expect(staleRecorded).toBe(false);
      const renditions = await database.query<{ width: number; byte_size: string }>({
        text: 'SELECT width, byte_size::text AS byte_size FROM material_renditions WHERE version_id = $1',
        values: [queued.versionId],
      });
      expect(renditions).toHaveLength(1);
      expect(renditions[0]?.width).toBe(1280);
    },
    networkTimeoutMs,
  );

  /**
   * The smallest library a conversion job can point at: one object, one
   * material, one version and one PENDING job per named kind. Written with raw
   * statements rather than through `MaterialService`, because what is under
   * test is the claim, not the upload lifecycle that produced the row.
   */
  async function queueConversionJobs(
    groupId: string,
    kinds: readonly string[],
  ): Promise<{
    readonly jobIds: readonly string[];
    readonly versionId: string;
    readonly contentHash: string;
  }> {
    const contentHash = `${uniqueSuffix()}${uniqueSuffix()}${uniqueSuffix()}${uniqueSuffix()}`;
    const materialId = randomUUID();
    const versionId = randomUUID();
    const jobIds = kinds.map(() => randomUUID());
    await database.query({
      text: `INSERT INTO material_objects (group_id, content_hash, byte_size, storage_key, reference_count)
             VALUES ($1, $2, 1048576, $3, 1)`,
      values: [groupId, contentHash, `materials/${groupId}/${contentHash}`],
    });
    await database.query({
      text: `INSERT INTO materials (
               id, group_id, display_name, category, mime_type, byte_size,
               content_hash, status, current_version_id
             ) VALUES ($1, $2, 'Съёмка', 'VIDEO', 'video/mp4', 1048576, $3, 'READY', $4)`,
      values: [materialId, groupId, contentHash, versionId],
    });
    await database.query({
      text: `INSERT INTO material_versions (
               id, material_id, sequence, content_hash, mime_type, byte_size, original_file_name
             ) VALUES ($1, $2, 1, $3, 'video/mp4', 1048576, 'take.mov')`,
      values: [versionId, materialId, contentHash],
    });
    for (const [index, kind] of kinds.entries()) {
      await database.query({
        text: `INSERT INTO conversion_jobs (id, group_id, material_id, version_id, kind, state)
               VALUES ($1, $2, $3, $4, $5, 'PENDING')`,
        values: [jobIds[index] ?? '', groupId, materialId, versionId, kind],
      });
    }
    return { jobIds, versionId, contentHash };
  }

  async function queueOneConversionJob(groupId: string): Promise<{
    readonly jobId: string;
    readonly versionId: string;
    readonly contentHash: string;
  }> {
    const queued = await queueConversionJobs(groupId, ['720p']);
    return { jobId: queued.jobIds[0] ?? '', ...queued };
  }

  function unclaimed(): never {
    throw new Error('expected a claimed conversion job');
  }

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
});

function uniqueSuffix(): string {
  return randomBytes(8).toString('hex');
}
