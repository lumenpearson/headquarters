import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from '../db/database.js';
import { DurablePairedDeviceRuntime } from './durable-runtime.js';
import type { AuthenticatedDevice } from './runtime.js';

const pepper = 'test-token-pepper-with-at-least-thirty-two-characters';
const groupId = '018b2a02-0000-7000-8000-000000000001';
const ownerDeviceId = '018b2a02-0000-7000-8000-000000000002';
const analystDeviceId = '018b2a02-0000-7000-8000-000000000003';
const now = new Date('2026-08-18T09:00:00.000Z');

describe('durable paired-device lifecycle adapter', () => {
  it('bootstraps the initial group, device, session, and access token in one parameterized CTE', async () => {
    const database = new ScriptedSqlClient([[lifecycleRow()]]);
    const runtime = createRuntime(database);

    const created = await runtime.createGroup({
      name: 'Terminal Red',
      initialDevice: deviceInput('HQ primary', 'ed25519:primary'),
    });

    expect(created.group).toMatchObject({ id: groupId, authorityMode: 'LEADER' });
    expect(created.device).toMatchObject({ id: ownerDeviceId, role: 'ADMIN' });
    expect(created.session.accessToken).toMatch(/^hq_access_/u);
    expect(created.session.refreshToken).toMatch(/^hq_refresh_/u);
    expect(database.transactions).toHaveLength(0);
    expect(database.queries).toHaveLength(1);

    const statement = requireStatement(database.queries, 0);
    expect(statement.text).toContain('inserted_group AS');
    expect(statement.text).toContain('INSERT INTO device_sessions');
    expect(statement.text).toContain('INSERT INTO device_access_tokens');
    expect(statement.text).not.toContain('Terminal Red');
    expect(statement.values).toContain('Terminal Red');
    expectCredentialIsNeverPersisted(statement, created.session.accessToken);
    expectCredentialIsNeverPersisted(statement, created.session.refreshToken);
  });

  it('issues and consumes a one-time pairing grant with a locked, atomic redemption statement', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          pairing_group_id: groupId,
          pairing_role: 'EDITOR',
          pairing_expires_at: new Date('2026-08-18T09:10:00.000Z'),
        },
      ],
      [
        lifecycleRow({
          device_id: analystDeviceId,
          device_name: 'HQ analyst',
          role: 'EDITOR',
          group_revision: '2',
        }),
      ],
    ]);
    const runtime = createRuntime(database);
    const grant = await runtime.createPairingCode(authenticatedAdmin(), groupId, 'EDITOR');

    const paired = await runtime.pairDevice({
      pairingCode: grant.code,
      ...deviceInput('HQ analyst', 'ed25519:analyst'),
    });

    expect(paired.device).toMatchObject({ id: analystDeviceId, role: 'EDITOR' });
    expect(paired.group.revision).toBe(2n);
    expect(database.transactions).toHaveLength(0);
    expect(database.queries).toHaveLength(2);
    const issueStatement = requireStatement(database.queries, 0);
    const redeemStatement = requireStatement(database.queries, 1);
    expect(issueStatement.text).toContain('locked_group AS MATERIALIZED');
    expect(issueStatement.text).toContain('authorized_actor AS MATERIALIZED');
    // Issuance locks and re-validates the exact live session/access-token
    // pair that authenticated the caller, not merely the device.
    expect(issueStatement.text).toContain('JOIN device_sessions AS issuer_session');
    expect(issueStatement.text).toContain('JOIN device_access_tokens AS issuer_access_token');
    expect(issueStatement.text).toContain('created_by_session_id, created_by_access_token_id');
    expect(issueStatement.values).toContain(authenticatedAdmin().sessionId);
    expect(issueStatement.values).toContain(authenticatedAdmin().accessTokenId);
    expect(redeemStatement.text).toContain('pairing_candidate AS MATERIALIZED');
    expect(redeemStatement.text).toContain('locked_group AS MATERIALIZED');
    expect(redeemStatement.text).toContain('locked_pairing_code AS MATERIALIZED');
    expect(redeemStatement.text).toContain('active_code_creator AS MATERIALIZED');
    // Redemption fails closed unless the issuer's session and access token are
    // still the exact, unrevoked credential that created the code: refresh
    // rotation, replay revocation, or a NULL legacy binding all remove the
    // match instead of falling back to device-only authority.
    expect(redeemStatement.text).toContain('JOIN device_sessions AS issuer_session');
    expect(redeemStatement.text).toContain('JOIN device_access_tokens AS issuer_access_token');
    expect(redeemStatement.text).toContain(
      'issuer_session.id = locked_pairing_code.created_by_session_id',
    );
    expect(redeemStatement.text).toContain(
      'issuer_access_token.id = locked_pairing_code.created_by_access_token_id',
    );
    expect(redeemStatement.text).toContain('issuer_session.revoked_at IS NULL');
    expect(redeemStatement.text).toContain('issuer_access_token.revoked_at IS NULL');
    expect(redeemStatement.text).toContain('FOR UPDATE');
    expect(redeemStatement.text).toContain('consumed_by_device_id');
    expect(redeemStatement.text).toContain('INSERT INTO group_memberships');
    expect(redeemStatement.text).toContain('updated_group AS (');
    expect(redeemStatement.text).toContain('SET revision = groups.revision + 1');
    expectCredentialIsNeverPersisted(issueStatement, grant.code);
    expectCredentialIsNeverPersisted(redeemStatement, grant.code);
  });

  it('does not issue a pairing code when the authenticated session or access token has gone stale', async () => {
    const database = new ScriptedSqlClient([[]]);
    const runtime = createRuntime(database);

    await expect(
      runtime.createPairingCode(authenticatedAdmin(), groupId, 'EDITOR'),
    ).rejects.toMatchObject({
      name: 'PairedDeviceRuntimeError',
      code: 'PERMISSION_DENIED',
    });

    expect(database.queries).toHaveLength(1);
    expect(requireStatement(database.queries, 0).text).toContain(
      'WHERE EXISTS (SELECT 1 FROM authorized_actor)',
    );
  });

  it('rejects redemption when the pairing code exists but its issuer session/access-token binding is absent', async () => {
    const database = new ScriptedSqlClient([[]]);
    const runtime = createRuntime(database);

    await expect(
      runtime.pairDevice({
        pairingCode: 'hq_pair_stale-or-legacy-code',
        ...deviceInput('HQ analyst', 'ed25519:analyst'),
      }),
    ).rejects.toMatchObject({
      name: 'PairedDeviceRuntimeError',
      code: 'UNAUTHENTICATED',
      message: expect.stringContaining('pairing code is invalid'),
    });

    expect(database.queries).toHaveLength(1);
  });

  it('rotates refresh credentials with same-row replay detection and shared revocation locks', async () => {
    const database = new ScriptedSqlClient([
      [
        lifecycleRow({
          role: 'EDITOR',
          device_id: analystDeviceId,
          device_name: 'HQ analyst',
          session_id: '018b2a02-0000-7000-8000-000000000010',
        }),
      ],
    ]);
    const runtime = createRuntime(database);
    const rawRefreshToken = 'raw-refresh-token-must-never-reach-sql';

    const refreshed = await runtime.refreshDeviceSession(rawRefreshToken);

    const statement = requireStatement(database.queries, 0);
    expect(refreshed.accessToken).toMatch(/^hq_access_/u);
    expect(refreshed.refreshToken).toMatch(/^hq_refresh_/u);
    expect(statement.text).toContain('active_session AS MATERIALIZED');
    expect(statement.text).toContain('membership.revoked_at IS NULL');
    expect(statement.text).toContain("devices.status <> 'REVOKED'");
    expect(statement.text).toContain('candidate_groups AS MATERIALIZED');
    expect(statement.text).toContain('locked_group AS MATERIALIZED');
    expect(statement.text).toContain('FOR UPDATE OF groups');
    expect(statement.text).toContain('FOR UPDATE OF session, membership');
    expect(statement.text).not.toContain('FOR UPDATE OF session, membership, devices');
    expect(statement.text).toContain('refresh_previous_token_hash');
    expect(statement.text).toContain('refresh_previous_hash_version');
    expect(statement.text).toContain('refresh_previous_expires_at');
    expect(statement.text).toContain('retired_refresh_token AS');
    expect(statement.text).toContain('replayed_previous_token AS');
    expect(statement.text).toContain('historical_replay_session AS MATERIALIZED');
    expect(statement.text).toContain('replayed_historical_token AS');
    expect(statement.text).toContain('replayed_refresh_token AS');
    expect(statement.text).toContain('replay_detected_at');
    expect(statement.text).toContain("'REFRESH_REPLAY'");
    expect(statement.text).not.toMatch(/SET\s+id\s*=/u);
    expect(database.queries).toHaveLength(1);
    expect(database.transactions).toHaveLength(0);
    expectCredentialIsNeverPersisted(statement, rawRefreshToken);
  });

  it('does not return replacement credentials when a locked refresh query yields no active row', async () => {
    const database = new ScriptedSqlClient([[]]);
    const runtime = createRuntime(database);

    await expect(
      runtime.refreshDeviceSession('invalid-or-expired-refresh-token'),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'UNAUTHENTICATED' });

    expect(database.queries).toHaveLength(1);
    expect(requireStatement(database.queries, 0).text).toContain('replayed_previous_token AS');
    expect(requireStatement(database.queries, 0).text).toContain(
      'NOT EXISTS (SELECT 1 FROM active_session)',
    );
  });

  it('authenticates, lists, and revokes through parameterized CTEs with no raw bearer credential', async () => {
    const database = new ScriptedSqlClient([
      [lifecycleRow()],
      [
        {
          requester_active: true,
          approximate_total: '2',
          items: [
            deviceRow({
              device_id: ownerDeviceId,
              device_name: 'HQ primary',
              role: 'ADMIN',
              device_status: 'OFFLINE',
            }),
            deviceRow({ device_id: analystDeviceId, device_name: 'HQ analyst', role: 'VIEWER' }),
          ],
        },
      ],
      [
        {
          actor_active: true,
          actor_role: 'ADMIN',
          target_active: true,
          target_role: 'VIEWER',
          target_is_leader: false,
          active_admin_count: '1',
          group: groupRow({ group_revision: '2' }),
          device: deviceRow({
            device_id: analystDeviceId,
            device_name: 'HQ analyst',
            role: 'VIEWER',
            device_status: 'REVOKED',
          }),
        },
      ],
    ]);
    const runtime = createRuntime(database);
    const rawAccessToken = 'raw-access-token-must-never-reach-sql';

    const authenticated = await runtime.authenticateAccessToken(rawAccessToken);
    const page = await runtime.listDevices(authenticated, groupId, 1, '');
    const revoked = await runtime.revokeDevice(authenticated, groupId, analystDeviceId);

    expect(authenticated).toMatchObject({ sessionId: '018b2a02-0000-7000-8000-000000000010' });
    expect(page).toMatchObject({ hasMore: true, approximateTotal: 2n });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.status).toBe('OFFLINE');
    expect(revoked).toMatchObject({
      group: { revision: 2n },
      device: { id: analystDeviceId, status: 'REVOKED' },
    });

    const authenticateStatement = requireStatement(database.queries, 0);
    const listStatement = requireStatement(database.queries, 1);
    const revokeStatement = requireStatement(database.queries, 2);
    expect(authenticateStatement.text).toContain('UPDATE device_access_tokens AS access_token');
    expect(authenticateStatement.text).not.toContain('touched_device');
    expect(listStatement.text).toContain('all_active_members AS MATERIALIZED');
    expect(listStatement.text).toContain('jsonb_agg');
    expect(revokeStatement.text).toContain('locked_group AS MATERIALIZED');
    expect(revokeStatement.text).toMatch(/locked_group AS MATERIALIZED \([\s\S]*?FOR UPDATE/u);
    expect(revokeStatement.text).toContain('active_admin_count AS');
    expect(revokeStatement.text).toContain('revoked_pairing_codes AS');
    expect(revokeStatement.text).toContain('revoked_access_tokens AS');
    expect(revokeStatement.text).toMatch(/revoked_sessions AS \([\s\S]*?FROM revoked_membership/u);
    expect(revokeStatement.text).not.toMatch(/UPDATE devices[\s\S]*?SET status = 'REVOKED'/u);
    expect(revokeStatement.text).not.toContain('FOR UPDATE OF membership, devices');
    expect(revokeStatement.text).toContain('target_is_leader');
    expect(revokeStatement.text).toContain("'DEVICE_REVOKED'");
    expect(revokeStatement.text).toContain("'device_status', 'REVOKED'");
    expectCredentialIsNeverPersisted(authenticateStatement, rawAccessToken);
    expect(database.transactions).toHaveLength(0);
  });

  it('binds an access token to its own active session before deriving a group identity', async () => {
    const database = new ScriptedSqlClient([[lifecycleRow()]]);
    const runtime = createRuntime(database);

    await runtime.authenticateAccessToken('cross-group-session-regression-token');

    const statement = requireStatement(database.queries, 0);
    expect(statement).toBeDefined();
    if (statement === undefined) throw new Error('Expected an access-token authentication query.');

    // `device_access_tokens` is the update target. This predicate is the
    // tenant boundary: without it PostgreSQL can pair the token row with any
    // active session returned by the FROM clause and return another group's
    // device identity.
    expect(statement.text).toMatch(
      /WHERE\s+access_token\.session_id = session\.id\s+AND\s+access_token\.token_hash = \$1/u,
    );
    expect(statement.text).toContain('membership.group_id = session.group_id');
    expect(statement.text).toContain('membership.device_id = session.device_id');
    expect(statement.text).toContain('groups.id = session.group_id');
    expect(statement.text).toContain('devices.id = session.device_id');

    // Revoking either the bearer token, its session, or its exact membership
    // must remove the row before it can produce an authenticated identity.
    expect(statement.text).toContain('access_token.revoked_at IS NULL');
    expect(statement.text).toContain('access_token.expires_at > $3');
    expect(statement.text).toContain('session.revoked_at IS NULL');
    expect(statement.text).toContain('session.expires_at > $3');
    expect(statement.text).toContain('membership.revoked_at IS NULL');
  });
  it('maps PostgreSQL deadlocks and serialization failures to retryable lifecycle errors', async () => {
    for (const code of ['40P01', '40001']) {
      const runtime = createRuntime(new RejectingSqlClient({ code }));

      await expect(
        runtime.createGroup({
          name: 'Terminal Red',
          initialDevice: deviceInput('HQ primary', `ed25519:${code}`),
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ABORTED' });
    }
  });

  it('uses the configuration-owned credential hasher and carries its hash version into SQL', async () => {
    const database = new ScriptedSqlClient([[lifecycleRow()]]);
    const receivedKinds: string[] = [];
    const runtime = new DurablePairedDeviceRuntime({
      database,
      tokenHashVersion: 'v2',
      hashCredential: (kind, raw) => {
        receivedKinds.push(`${kind}:${raw.startsWith(`hq_${kind}_`)}`);
        return `configured-hash-for-${kind}`;
      },
      now: () => now,
      randomBytes: deterministicRandomBytes(),
    });

    await runtime.createGroup({
      name: 'Terminal Red',
      initialDevice: deviceInput('HQ primary', 'ed25519:primary'),
    });

    const values = requireStatement(database.queries, 0).values ?? [];
    expect(receivedKinds).toEqual(['access:true', 'refresh:true']);
    expect(values).toContain('v2');
    expect(values).toContain('configured-hash-for-access');
    expect(values).toContain('configured-hash-for-refresh');
  });

  it('keeps the v1 fallback HMAC contract purpose-separated when a test supplies only a pepper', async () => {
    const database = new ScriptedSqlClient([[lifecycleRow()]]);
    const runtime = createRuntime(database);
    const rawAccessToken = 'v1-access-contract-check';

    await runtime.authenticateAccessToken(rawAccessToken);

    const expectedHash = createHmac('sha256', pepper)
      .update(`v1\u0000access\u0000${rawAccessToken}`, 'utf8')
      .digest('base64url');
    expect(requireStatement(database.queries, 0).values?.[0]).toBe(expectedHash);
    expectCredentialIsNeverPersisted(requireStatement(database.queries, 0), rawAccessToken);
  });
});

class RejectingSqlClient implements SqlClient {
  constructor(private readonly error: unknown) {}

  async query<Row extends Record<string, unknown>>(
    _statement: SqlStatement,
  ): Promise<readonly Row[]> {
    throw this.error;
  }

  async transaction(_statements: readonly SqlStatement[]): Promise<void> {
    throw this.error;
  }
}

class ScriptedSqlClient implements SqlClient {
  readonly queries: SqlStatement[] = [];
  readonly transactions: SqlStatement[][] = [];
  readonly #responses: Array<Record<string, unknown>[]>;

  constructor(responses: readonly (readonly Record<string, unknown>[])[]) {
    this.#responses = responses.map((response) => [...response]);
  }

  async query<Row extends Record<string, unknown>>(
    statement: SqlStatement,
  ): Promise<readonly Row[]> {
    this.queries.push({
      text: statement.text,
      values: statement.values === undefined ? [] : [...statement.values],
    });
    return (this.#responses.shift() ?? []) as readonly Row[];
  }

  async transaction(statements: readonly SqlStatement[]): Promise<void> {
    this.transactions.push([...statements]);
  }

  /**
   * A receipt fingerprint is an HMAC the adapter computes internally, so a
   * scripted "already completed" row can only be built once that value is
   * known. Rewriting it here keeps the test honest: it asserts the adapter
   * accepts its own fingerprint, never a hardcoded stand-in.
   */
  setReceiptFingerprint(fingerprint: unknown): void {
    for (const response of this.#responses) {
      for (const row of response) {
        if ('receipt_fingerprint' in row) {
          (row as { receipt_fingerprint: unknown }).receipt_fingerprint = fingerprint;
        }
      }
    }
  }
}

function createRuntime(database: SqlClient): DurablePairedDeviceRuntime {
  return new DurablePairedDeviceRuntime({
    database,
    tokenPepper: pepper,
    now: () => now,
    randomBytes: deterministicRandomBytes(),
  });
}

function deterministicRandomBytes(): (size: number) => Uint8Array {
  let offset = 0;
  return (size) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (offset + index) & 0xff;
    }
    offset += size;
    return bytes;
  };
}

function authenticatedAdmin(): AuthenticatedDevice {
  return {
    group: toGroup(groupRow()),
    device: toDevice(
      deviceRow({ device_id: ownerDeviceId, device_name: 'HQ primary', role: 'ADMIN' }),
    ),
    role: 'ADMIN',
    sessionId: '018b2a02-0000-7000-8000-000000000010',
    accessTokenId: '018b2a02-0000-7000-8000-000000000011',
  };
}

function lifecycleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...groupRow(),
    ...deviceRow({ device_id: ownerDeviceId, device_name: 'HQ primary', role: 'ADMIN' }),
    session_id: '018b2a02-0000-7000-8000-000000000010',
    access_token_id: '018b2a02-0000-7000-8000-000000000011',
    access_token_expires_at: new Date('2026-08-18T09:15:00.000Z'),
    refresh_token_expires_at: new Date('2026-09-17T09:00:00.000Z'),
    ...overrides,
  };
}

function groupRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    group_id: groupId,
    group_name: 'Terminal Red',
    group_authority_mode: 'LEADER',
    group_leader_device_id: ownerDeviceId,
    group_revision: '1',
    group_created_at: now,
    group_updated_at: now,
    ...overrides,
  };
}

function deviceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_id: ownerDeviceId,
    device_name: 'HQ primary',
    device_public_key: 'ed25519:primary',
    device_platform: 'windows',
    device_application_version: '0.1.0',
    device_status: 'ONLINE',
    device_created_at: now,
    device_last_seen_at: now,
    role: 'ADMIN',
    ...overrides,
  };
}

function deviceInput(name: string, publicKey: string) {
  return {
    name,
    publicKey,
    platform: 'windows',
    applicationVersion: '0.1.0',
  };
}

function toGroup(row: Record<string, unknown>) {
  return {
    id: row.group_id as string,
    name: row.group_name as string,
    authorityMode: row.group_authority_mode as 'LEADER',
    leaderDeviceId: row.group_leader_device_id as string,
    revision: BigInt(row.group_revision as string),
    createdAt: row.group_created_at as Date,
    updatedAt: row.group_updated_at as Date,
  };
}

function toDevice(row: Record<string, unknown>) {
  return {
    id: row.device_id as string,
    name: row.device_name as string,
    publicKey: row.device_public_key as string,
    role: row.role as 'ADMIN',
    status: row.device_status as 'ONLINE',
    platform: row.device_platform as string,
    applicationVersion: row.device_application_version as string,
    createdAt: row.device_created_at as Date,
    lastSeenAt: row.device_last_seen_at as Date,
  };
}
describe('durable mutation idempotency receipts', () => {
  it('claims in a statement of its own, so the mutation can complete the row', async () => {
    const database = new ScriptedSqlClient([
      [{ receipt_claimed: 'claimed' }],
      [
        {
          pairing_group_id: groupId,
          pairing_role: 'EDITOR',
          pairing_expires_at: new Date('2026-08-18T09:10:00.000Z'),
        },
      ],
      [{ receipt_claimed: 'claimed' }],
      [lifecycleRow({ device_id: analystDeviceId, role: 'EDITOR', group_revision: '2' })],
    ]);
    const runtime = createRuntime(database);
    const grant = await runtime.createPairingCode(authenticatedAdmin(), groupId, 'EDITOR', {
      requestId: 'req-code',
    });

    const paired = await runtime.pairDevice({
      pairingCode: grant.code,
      ...deviceInput('HQ analyst', 'ed25519:analyst'),
      mutation: { requestId: 'req-pair-1' },
    });

    const claim = requireStatement(database.queries, 2);
    const redeem = requireStatement(database.queries, 3);
    // The claim must not travel inside the mutation. PostgreSQL runs every
    // data-modifying CTE against one pre-statement snapshot, so a receipt
    // inserted by a CTE is invisible to the CTE that has to complete it, and
    // `completed_at` would stay NULL forever.
    expect(claim.text).toContain('INSERT INTO mutation_receipts');
    expect(claim.text).toContain('ON CONFLICT (scope, request_id_hash) DO UPDATE');
    expect(claim.text).toContain('WHERE mutation_receipts.completed_at IS NULL');
    expect(redeem.text).not.toContain('INSERT INTO mutation_receipts');
    // The mutation locks the committed row instead, which is what serializes
    // two concurrent retries of one identifier.
    expect(redeem.text).toContain('locked_receipt AS MATERIALIZED');
    expect(redeem.text).toContain('FOR UPDATE OF receipt');
    expect(redeem.text).toContain('CROSS JOIN mutation_gate');
    expect(redeem.text).toContain('completed_receipt AS');
    expect(claim.values).toContain('PAIR_DEVICE');

    // Only hashes are ever bound: not the raw identifier, not the code, not a
    // credential the response carries.
    expect(claim.values).not.toContain('req-pair-1');
    expect(redeem.values).not.toContain('req-pair-1');
    expectCredentialIsNeverPersisted(claim, grant.code);
    expectCredentialIsNeverPersisted(redeem, grant.code);
    expectCredentialIsNeverPersisted(redeem, paired.session.accessToken);
    expectCredentialIsNeverPersisted(redeem, paired.session.refreshToken);
  });

  it('issues no claim statement at all when the caller supplies no request id', async () => {
    const database = new ScriptedSqlClient([[lifecycleRow()]]);
    const runtime = createRuntime(database);

    await runtime.refreshDeviceSession('hq_refresh_token');

    expect(database.queries).toHaveLength(1);
    const statement = requireStatement(database.queries, 0);
    expect(statement.text).not.toContain('INSERT INTO mutation_receipts');
    expect(statement.values?.slice(8)).toEqual([null, null]);
    // A NULL identifier keeps the gate open, so pre-receipt behaviour is intact.
    expect(statement.text).toContain('SELECT 1 AS open WHERE $10::text IS NULL');
  });

  it('skips the mutation entirely once a completed receipt owns the identity', async () => {
    const database = new ScriptedSqlClient([
      // The claim is refused: no row comes back.
      [],
      [
        {
          receipt_fingerprint: undefined,
          receipt_completed_at: now,
          receipt_group_id: groupId,
          receipt_device_id: analystDeviceId,
          receipt_session_id: '018b2a02-0000-7000-8000-000000000010',
        },
      ],
      [lifecycleRow({ device_id: analystDeviceId, role: 'EDITOR', group_revision: '2' })],
    ]);
    const runtime = createRuntime(database);
    database.setReceiptFingerprint(
      await fingerprintFor((probe) =>
        probe.pairDevice({
          pairingCode: 'hq_pair_retry',
          ...deviceInput('HQ analyst', 'ed25519:analyst'),
          mutation: { requestId: 'req-pair-retry' },
        }),
      ),
    );

    const replayed = await runtime.pairDevice({
      pairingCode: 'hq_pair_retry',
      ...deviceInput('HQ analyst', 'ed25519:analyst'),
      mutation: { requestId: 'req-pair-retry' },
    });

    expect(database.queries).toHaveLength(3);
    // No redemption statement is issued: claim, read the receipt, re-issue.
    expect(database.queries.some((statement) => statement.text.includes('pairing_candidate'))).toBe(
      false,
    );
    expect(requireStatement(database.queries, 1).text).toContain(
      'FROM mutation_receipts AS receipt',
    );
    expect(requireStatement(database.queries, 2).text).toContain('rotated_session AS');
    expect(replayed.device.id).toBe(analystDeviceId);
    expect(replayed.session.accessToken).toMatch(/^hq_access_/u);
  });

  it('reports a reused identifier with a different payload instead of issuing credentials', async () => {
    const database = new ScriptedSqlClient([
      [],
      [
        {
          receipt_fingerprint: 'a-different-requests-fingerprint',
          receipt_completed_at: now,
          receipt_group_id: groupId,
          receipt_device_id: analystDeviceId,
          receipt_session_id: '018b2a02-0000-7000-8000-000000000010',
        },
      ],
    ]);
    const runtime = createRuntime(database);

    await expect(
      runtime.refreshDeviceSession('hq_refresh_token', { requestId: 'req-collision' }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ALREADY_EXISTS' });
    // No third query: a mismatched fingerprint must not reach re-issuance.
    expect(database.queries).toHaveLength(2);
  });

  it('reports the operation failure when its own claim did commit', async () => {
    const database = new ScriptedSqlClient([
      [{ receipt_claimed: 'claimed' }],
      [],
      [
        {
          receipt_fingerprint: 'irrelevant',
          receipt_completed_at: null,
          receipt_group_id: null,
          receipt_device_id: null,
          receipt_session_id: null,
        },
      ],
    ]);
    const runtime = createRuntime(database);

    await expect(
      runtime.refreshDeviceSession('hq_refresh_token', { requestId: 'req-failed' }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'UNAUTHENTICATED' });
  });
});

describe('durable receipts for the remaining mutations', () => {
  it('gates bootstrap behind the claim and records the session it created', async () => {
    const database = new ScriptedSqlClient([[{ receipt_claimed: 'claimed' }], [lifecycleRow()]]);
    const runtime = createRuntime(database);

    await runtime.createGroup({
      name: 'Terminal Red',
      initialDevice: deviceInput('HQ primary', 'ed25519:primary'),
      mutation: { requestId: 'req-bootstrap' },
    });

    const statement = requireStatement(database.queries, 1);
    // The group insert selects from the gate, so a refused claim cannot create
    // a second group.
    expect(statement.text).toContain("SELECT $1, $2, 'LEADER', $3, 1, $4, $4 FROM mutation_gate");
    expect(statement.text).toContain('completed_receipt AS');
    expect(requireStatement(database.queries, 0).values).toContain('CREATE_GROUP');
    expect(requireStatement(database.queries, 0).values).not.toContain('req-bootstrap');
  });

  it('records the code hash so a retry can retire what it already minted', async () => {
    const database = new ScriptedSqlClient([
      [{ receipt_claimed: 'claimed' }],
      [
        {
          pairing_group_id: groupId,
          pairing_role: 'EDITOR',
          pairing_expires_at: new Date('2026-08-18T09:10:00.000Z'),
        },
      ],
    ]);
    const runtime = createRuntime(database);

    const grant = await runtime.createPairingCode(authenticatedAdmin(), groupId, 'EDITOR', {
      requestId: 'req-code',
    });

    const statement = requireStatement(database.queries, 1);
    expect(statement.text).toContain('resource_hash = issued_pairing_code.code_hash');
    expect(statement.text).toContain('CROSS JOIN mutation_gate');
    expect(requireStatement(database.queries, 0).values).toContain('CREATE_PAIRING_CODE');
    // Only the hash is persisted; the code itself never becomes a parameter.
    expectCredentialIsNeverPersisted(statement, grant.code);
  });

  it('replaces a recorded pairing code and refuses once it has been consumed', async () => {
    const replaced = new ScriptedSqlClient([
      [],
      [
        {
          receipt_fingerprint: undefined,
          receipt_completed_at: now,
          receipt_group_id: groupId,
          receipt_resource_hash: 'recorded-code-hash',
        },
      ],
      [
        {
          actor_active: true,
          target_active: true,
          pairing_group_id: groupId,
          pairing_role: 'EDITOR',
          pairing_expires_at: new Date('2026-08-18T09:10:00.000Z'),
        },
      ],
    ]);
    const fingerprint = await fingerprintFor((probe) =>
      probe.createPairingCode(authenticatedAdmin(), groupId, 'EDITOR', { requestId: 'req-code' }),
    );
    replaced.setReceiptFingerprint(fingerprint);

    const grant = await createRuntime(replaced).createPairingCode(
      authenticatedAdmin(),
      groupId,
      'EDITOR',
      { requestId: 'req-code' },
    );

    expect(grant.code).toMatch(/^hq_pair_/u);
    const replacement = requireStatement(replaced.queries, 2);
    // The retirement and the replacement are one statement, so a retry can
    // never leave two live capabilities.
    expect(replacement.text).toContain('retired_code AS');
    expect(replacement.text).toContain('INSERT INTO pairing_codes');
    expect(replacement.values).toContain('recorded-code-hash');

    const consumed = new ScriptedSqlClient([
      [],
      [
        {
          receipt_fingerprint: undefined,
          receipt_completed_at: now,
          receipt_group_id: groupId,
          receipt_resource_hash: 'recorded-code-hash',
        },
      ],
      [{ actor_active: true, target_active: false }],
    ]);
    consumed.setReceiptFingerprint(fingerprint);
    await expect(
      createRuntime(consumed).createPairingCode(authenticatedAdmin(), groupId, 'EDITOR', {
        requestId: 'req-code',
      }),
    ).rejects.toMatchObject({ code: 'FAILED_PRECONDITION' });
  });

  it('replays a revoke with the revision its own mutation produced', async () => {
    const database = new ScriptedSqlClient([
      [],
      [
        {
          receipt_fingerprint: undefined,
          receipt_completed_at: now,
          receipt_group_id: groupId,
          receipt_device_id: analystDeviceId,
          receipt_revision: '7',
        },
      ],
      [
        {
          // The replay statement projects the recorded revision as a bound
          // parameter, so this is what PostgreSQL would return for it.
          ...groupRow({ group_revision: '7' }),
          ...deviceRow({
            device_id: analystDeviceId,
            role: 'EDITOR',
            device_status: 'REVOKED',
          }),
        },
      ],
    ]);
    database.setReceiptFingerprint(
      await fingerprintFor((probe) =>
        probe.revokeDevice(authenticatedAdmin(), groupId, analystDeviceId, {
          requestId: 'req-revoke',
        }),
      ),
    );

    const replayed = await createRuntime(database).revokeDevice(
      authenticatedAdmin(),
      groupId,
      analystDeviceId,
      { requestId: 'req-revoke' },
    );

    // Unlike every other mutation here, the revoke projection is built from
    // scalar subqueries and returns a row even when the gate is shut, so the
    // refused claim has to short-circuit before the statement is issued.
    expect(database.queries.some((statement) => statement.text.includes('eligible_target'))).toBe(
      false,
    );
    expect(requireStatement(database.queries, 2).text).toContain('$3::bigint AS group_revision');
    expect(requireStatement(database.queries, 2).values).toContain('7');
    expect(replayed.group.revision).toBe(7n);
    // Membership-scoped, like the mutation itself: the device may still be
    // online in another group, so the status is a literal in the projection.
    expect(requireStatement(database.queries, 2).text).toContain("'REVOKED' AS device_status");
    expect(replayed.device.status).toBe('REVOKED');
  });
});

/**
 * A receipt fingerprint is an HMAC the adapter computes internally, so a
 * scripted "already completed" row can only be built once that value is known.
 * Running the call against a client that answers nothing surfaces the claim
 * statement, whose last parameter is the fingerprint. This keeps the test
 * honest: it asserts the adapter accepts its own fingerprint, never a
 * hardcoded stand-in.
 */
async function fingerprintFor(
  call: (runtime: DurablePairedDeviceRuntime) => Promise<unknown>,
): Promise<unknown> {
  const probe = new ScriptedSqlClient([[]]);
  await call(createRuntime(probe)).catch(() => undefined);
  const values = probe.queries[0]?.values ?? [];
  return values[3];
}

/**
 * Indexing a recorded statement list is unchecked under `noUncheckedIndexedAccess`, and a
 * silently `undefined` statement would turn a missing query into a vacuously passing
 * assertion. Failing loudly here keeps "the store issued this statement" a real claim.
 */
function requireStatement(statements: readonly SqlStatement[], index: number): SqlStatement {
  const statement = statements[index];
  if (statement === undefined) {
    throw new Error(`No statement was issued at index ${String(index)}`);
  }
  return statement;
}

function expectCredentialIsNeverPersisted(statement: SqlStatement, rawCredential: string): void {
  const serializedValues = JSON.stringify(statement.values ?? [], (_key, value: unknown) =>
    value instanceof Date ? value.toISOString() : value,
  );
  expect(statement.text).not.toContain(rawCredential);
  expect(serializedValues).not.toContain(rawCredential);
}
