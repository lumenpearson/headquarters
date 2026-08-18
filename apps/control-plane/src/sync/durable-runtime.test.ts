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

    const statement = database.queries[0];
    expect(statement.text).toContain('WITH inserted_group AS');
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
    const issueStatement = database.queries[0];
    const redeemStatement = database.queries[1];
    expect(issueStatement.text).toContain('WITH locked_group AS MATERIALIZED');
    expect(issueStatement.text).toContain('authorized_actor AS MATERIALIZED');
    expect(redeemStatement.text).toContain('pairing_candidate AS MATERIALIZED');
    expect(redeemStatement.text).toContain('locked_group AS MATERIALIZED');
    expect(redeemStatement.text).toContain('locked_pairing_code AS MATERIALIZED');
    expect(redeemStatement.text).toContain('active_code_creator AS MATERIALIZED');
    expect(redeemStatement.text).toContain('FOR UPDATE');
    expect(redeemStatement.text).toContain('consumed_by_device_id');
    expect(redeemStatement.text).toContain('INSERT INTO group_memberships');
    expect(redeemStatement.text).toContain('updated_group AS (');
    expect(redeemStatement.text).toContain('SET revision = groups.revision + 1');
    expectCredentialIsNeverPersisted(issueStatement, grant.code);
    expectCredentialIsNeverPersisted(redeemStatement, grant.code);
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

    const statement = database.queries[0];
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
    expect(database.queries[0].text).toContain('replayed_previous_token AS');
    expect(database.queries[0].text).toContain('NOT EXISTS (SELECT 1 FROM active_session)');
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

    const [authenticateStatement, listStatement, revokeStatement] = database.queries;
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

    const statement = database.queries[0];
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

    const values = database.queries[0].values ?? [];
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
    expect(database.queries[0].values?.[0]).toBe(expectedHash);
    expectCredentialIsNeverPersisted(database.queries[0], rawAccessToken);
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
  readonly #responses: Array<readonly Record<string, unknown>[]>;

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
  };
}

function lifecycleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...groupRow(),
    ...deviceRow({ device_id: ownerDeviceId, device_name: 'HQ primary', role: 'ADMIN' }),
    session_id: '018b2a02-0000-7000-8000-000000000010',
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

function expectCredentialIsNeverPersisted(statement: SqlStatement, rawCredential: string): void {
  const serializedValues = JSON.stringify(statement.values ?? [], (_key, value: unknown) =>
    value instanceof Date ? value.toISOString() : value,
  );
  expect(statement.text).not.toContain(rawCredential);
  expect(serializedValues).not.toContain(rawCredential);
}
