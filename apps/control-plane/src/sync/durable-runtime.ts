import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';

import type { SqlClient, SqlParameter, SqlStatement } from '../db/database.js';
import { PairedDeviceRuntimeError } from './runtime.js';
import type {
  AuthenticatedDevice,
  CreateGroupInput,
  DeviceRole,
  Page,
  PairedDevice,
  PairedDeviceSession,
  PairedGroup,
  PairDeviceInput,
  PairingCodeGrant,
} from './runtime.js';

const hashVersion = 'v1';
const defaultAccessTokenLifetimeMs = 15 * 60 * 1000;
const defaultRefreshTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const defaultPairingCodeLifetimeMs = 10 * 60 * 1000;
const defaultPageSize = 50;
const maxPageSize = 100;

export type DurableCredentialKind = 'access' | 'refresh' | 'pair';

export interface DurablePairedDeviceRuntimeOptions {
  /**
   * An already configured SQL client. This adapter intentionally does not read
   * environment variables, create a driver, or choose a deployment mode.
   */
  readonly database: SqlClient;
  /**
   * A configuration-owned HMAC closure. Production startup should pass this
   * instead of exposing a deployment secret to the lifecycle adapter.
   */
  readonly hashCredential?: (kind: DurableCredentialKind, raw: string) => string;
  /** Must match the hash-version column written alongside the credential hash. */
  readonly tokenHashVersion?: string;
  /**
   * Test-only compatibility fallback for callers that have not yet moved their
   * pepper behind `hashCredential`. It is never stored or returned.
   */
  readonly tokenPepper?: string;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly accessTokenLifetimeMs?: number;
  readonly refreshTokenLifetimeMs?: number;
  readonly pairingCodeLifetimeMs?: number;
}

interface SessionMaterial {
  readonly id: string;
  readonly accessTokenId: string;
  readonly accessToken: string;
  readonly accessTokenHash: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenHash: string;
  readonly refreshTokenExpiresAt: Date;
}

type LifecycleRow = Record<string, unknown> & {
  readonly group_id?: unknown;
  readonly group_name?: unknown;
  readonly group_authority_mode?: unknown;
  readonly group_leader_device_id?: unknown;
  readonly group_revision?: unknown;
  readonly group_created_at?: unknown;
  readonly group_updated_at?: unknown;
  readonly device_id?: unknown;
  readonly device_name?: unknown;
  readonly device_public_key?: unknown;
  readonly device_platform?: unknown;
  readonly device_application_version?: unknown;
  readonly device_status?: unknown;
  readonly device_created_at?: unknown;
  readonly device_last_seen_at?: unknown;
  readonly role?: unknown;
  readonly session_id?: unknown;
  readonly access_token_expires_at?: unknown;
  readonly refresh_token_expires_at?: unknown;
  readonly pairing_group_id?: unknown;
  readonly pairing_role?: unknown;
  readonly pairing_expires_at?: unknown;
  readonly requester_active?: unknown;
  readonly approximate_total?: unknown;
  readonly items?: unknown;
  readonly actor_active?: unknown;
  readonly actor_role?: unknown;
  readonly target_active?: unknown;
  readonly target_role?: unknown;
  readonly target_is_leader?: unknown;
  readonly active_admin_count?: unknown;
  readonly group?: unknown;
  readonly device?: unknown;
};

/**
 * PostgreSQL-backed counterpart to `PairedDeviceRuntime`.
 *
 * Each security-sensitive mutation is one parameterized statement with data
 * modifying CTEs. This is deliberate: the current `SqlClient` exposes a
 * batched transaction API but cannot read rows inside a transaction, so a
 * read-then-write sequence would open pairing-redemption and membership races.
 *
 * Refresh rotation keeps the immediately previous token hash on the same locked
 * session row (migration 0003). PostgreSQL re-evaluates a waiting `FOR UPDATE`
 * reader against that row, so a concurrent use of the just-rotated credential
 * is classified as replay and revokes the family rather than being mistaken for
 * an arbitrary invalid token. Historical hashes remain audit data and catch
 * older replays; they are not the sole concurrency control.
 *
 * Every group-membership mutation takes the group lock first. Refresh additionally
 * locks its session and active membership before issuing new credentials. Access
 * authentication mutates only its access-token heartbeat, never device-wide
 * liveness, so lifecycle mutations retain the order group → membership → session
 * → access token without an access-token/device lock cycle. A real PostgreSQL
 * concurrency suite is still required before a
 * production release; the local structural tests deliberately do not pretend to
 * execute CTEs against a database engine.
 */
export class DurablePairedDeviceRuntime {
  readonly #database: SqlClient;
  readonly #hashCredential: (kind: DurableCredentialKind, raw: string) => string;
  readonly #tokenHashVersion: string;
  readonly #now: () => Date;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #accessTokenLifetimeMs: number;
  readonly #refreshTokenLifetimeMs: number;
  readonly #pairingCodeLifetimeMs: number;

  constructor(options: DurablePairedDeviceRuntimeOptions) {
    this.#database = options.database;
    this.#tokenHashVersion = requireTokenHashVersion(options.tokenHashVersion ?? hashVersion);
    if (options.hashCredential !== undefined) {
      this.#hashCredential = options.hashCredential;
    } else {
      const tokenPepper = options.tokenPepper?.trim() ?? '';
      if (tokenPepper.length < 32) {
        throw new Error(
          'hashCredential is required in production; tokenPepper compatibility requires at least 32 non-whitespace characters',
        );
      }
      this.#hashCredential = (kind, raw) =>
        createHmac('sha256', tokenPepper)
          .update(`${this.#tokenHashVersion}\u0000${kind}\u0000${raw}`, 'utf8')
          .digest('base64url');
    }
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#accessTokenLifetimeMs = positiveLifetime(
      options.accessTokenLifetimeMs ?? defaultAccessTokenLifetimeMs,
      'accessTokenLifetimeMs',
    );
    this.#refreshTokenLifetimeMs = positiveLifetime(
      options.refreshTokenLifetimeMs ?? defaultRefreshTokenLifetimeMs,
      'refreshTokenLifetimeMs',
    );
    this.#pairingCodeLifetimeMs = positiveLifetime(
      options.pairingCodeLifetimeMs ?? defaultPairingCodeLifetimeMs,
      'pairingCodeLifetimeMs',
    );
  }

  async createGroup(input: CreateGroupInput): Promise<{
    readonly group: PairedGroup;
    readonly device: PairedDevice;
    readonly session: PairedDeviceSession;
  }> {
    const now = this.currentTime();
    const groupName = requireText(input.name, 'name');
    const device = normalizeDeviceInput(input.initialDevice);
    const groupId = this.createId(now);
    const deviceId = this.createId(now);
    const session = this.issueSessionMaterial(now);

    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH inserted_group AS (
           INSERT INTO groups (
             id, name, authority_mode, leader_device_id, revision, created_at, updated_at
           ) VALUES ($1, $2, 'LEADER', $3, 1, $4, $4)
           RETURNING id, name, authority_mode, leader_device_id, revision, created_at, updated_at
         ),
         inserted_device AS (
           INSERT INTO devices (
             id, name, public_key, platform, application_version, status, created_at, last_seen_at
           ) VALUES ($3, $5, $6, $7, $8, 'ONLINE', $4, $4)
           RETURNING id, name, public_key, platform, application_version, status, created_at, last_seen_at
         ),
         inserted_membership AS (
           INSERT INTO group_memberships (group_id, device_id, role, joined_at)
           SELECT inserted_group.id, inserted_device.id, 'ADMIN', $4
           FROM inserted_group CROSS JOIN inserted_device
           RETURNING group_id, device_id, role
         ),
         inserted_session AS (
           INSERT INTO device_sessions (
             id, device_id, group_id, refresh_token_hash, refresh_hash_version,
             issued_at, expires_at, last_seen_at
           )
           SELECT $9, inserted_device.id, inserted_group.id, $10, $11, $4, $12, $4
           FROM inserted_group CROSS JOIN inserted_device
           RETURNING id, device_id, group_id, expires_at
         ),
         inserted_access_token AS (
           INSERT INTO device_access_tokens (
             id, session_id, token_hash, hash_version, issued_at, expires_at, last_seen_at
           )
           SELECT $13, inserted_session.id, $14, $11, $4, $15, $4
           FROM inserted_session
           RETURNING session_id, expires_at
         )
         SELECT
           inserted_group.id AS group_id,
           inserted_group.name AS group_name,
           inserted_group.authority_mode AS group_authority_mode,
           inserted_group.leader_device_id AS group_leader_device_id,
           inserted_group.revision AS group_revision,
           inserted_group.created_at AS group_created_at,
           inserted_group.updated_at AS group_updated_at,
           inserted_device.id AS device_id,
           inserted_device.name AS device_name,
           inserted_device.public_key AS device_public_key,
           inserted_device.platform AS device_platform,
           inserted_device.application_version AS device_application_version,
           inserted_device.status AS device_status,
           inserted_device.created_at AS device_created_at,
           inserted_device.last_seen_at AS device_last_seen_at,
           inserted_membership.role AS role,
           inserted_session.id AS session_id,
           inserted_access_token.expires_at AS access_token_expires_at,
           inserted_session.expires_at AS refresh_token_expires_at
         FROM inserted_group
         CROSS JOIN inserted_device
         CROSS JOIN inserted_membership
         CROSS JOIN inserted_session
         CROSS JOIN inserted_access_token`,
        [
          groupId,
          groupName,
          deviceId,
          now,
          device.name,
          device.publicKey,
          device.platform,
          device.applicationVersion,
          session.id,
          session.refreshTokenHash,
          this.#tokenHashVersion,
          session.refreshTokenExpiresAt,
          session.accessTokenId,
          session.accessTokenHash,
          session.accessTokenExpiresAt,
        ],
      ),
    );

    const row = requireOneRow(rows, 'Unable to create the initial paired device.');
    return this.toCreatedLifecycle(row, session);
  }

  async createPairingCode(
    authenticated: AuthenticatedDevice,
    groupId: string,
    role: Exclude<DeviceRole, 'ADMIN'>,
  ): Promise<PairingCodeGrant> {
    const normalizedGroupId = requireText(groupId, 'group_id');
    this.assertContextActor(authenticated, authenticated.device.id);
    if (authenticated.group.id !== normalizedGroupId) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The authenticated device does not belong to the requested group.',
      );
    }
    if (role !== 'VIEWER' && role !== 'EDITOR') {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        'Pairing codes can grant only VIEWER or EDITOR access.',
      );
    }

    const now = this.currentTime();
    const code = this.createToken('pair');
    const expiresAt = new Date(now.getTime() + this.#pairingCodeLifetimeMs);
    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH locked_group AS MATERIALIZED (
           SELECT groups.id
           FROM groups
           WHERE groups.id = $2
           FOR UPDATE
         ),
         authorized_actor AS MATERIALIZED (
           SELECT membership.device_id
           FROM group_memberships AS membership
           JOIN devices AS device ON device.id = membership.device_id
           JOIN locked_group ON locked_group.id = membership.group_id
           WHERE membership.device_id = $5
             AND membership.revoked_at IS NULL
             AND device.status <> 'REVOKED'
             AND membership.role = 'ADMIN'
           FOR UPDATE OF membership, device
         ),
         issued_pairing_code AS (
           INSERT INTO pairing_codes (
             code_hash, group_id, role, expires_at, created_by_device_id, created_at, hash_version
           )
           SELECT $1, $2, $3, $4, $5, $6, $7
           WHERE EXISTS (SELECT 1 FROM authorized_actor)
           RETURNING group_id, role, expires_at
         )
         SELECT
           group_id AS pairing_group_id,
           role AS pairing_role,
           expires_at AS pairing_expires_at
         FROM issued_pairing_code`,
        [
          this.hashToken('pair', code),
          normalizedGroupId,
          role,
          expiresAt,
          authenticated.device.id,
          now,
          this.#tokenHashVersion,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Only an active group administrator can create a pairing code.',
      );
    }
    return {
      code,
      groupId: readText(row.pairing_group_id, 'pairing_group_id'),
      role: readPairingRole(row.pairing_role),
      expiresAt: readDate(row.pairing_expires_at, 'pairing_expires_at'),
    };
  }

  async pairDevice(input: PairDeviceInput): Promise<{
    readonly group: PairedGroup;
    readonly device: PairedDevice;
    readonly session: PairedDeviceSession;
  }> {
    const pairingCode = requireText(input.pairingCode, 'pairing_code');
    const device = normalizeDeviceInput(input);
    const now = this.currentTime();
    const deviceId = this.createId(now);
    const session = this.issueSessionMaterial(now);

    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH pairing_candidate AS MATERIALIZED (
           SELECT pairing_code.group_id
           FROM pairing_codes AS pairing_code
           WHERE pairing_code.code_hash = $1
             AND pairing_code.hash_version = $2
             AND pairing_code.consumed_at IS NULL
             AND pairing_code.revoked_at IS NULL
             AND pairing_code.expires_at > $3
         ),
         locked_group AS MATERIALIZED (
           SELECT groups.id
           FROM groups
           JOIN pairing_candidate ON pairing_candidate.group_id = groups.id
           FOR UPDATE OF groups
         ),
         locked_pairing_code AS MATERIALIZED (
           SELECT
             pairing_code.code_hash,
             pairing_code.group_id,
             pairing_code.role,
             pairing_code.created_by_device_id
           FROM pairing_codes AS pairing_code
           JOIN locked_group ON locked_group.id = pairing_code.group_id
           WHERE pairing_code.code_hash = $1
             AND pairing_code.hash_version = $2
             AND pairing_code.consumed_at IS NULL
             AND pairing_code.revoked_at IS NULL
             AND pairing_code.expires_at > $3
           FOR UPDATE OF pairing_code
         ),
         active_code_creator AS MATERIALIZED (
           SELECT membership.device_id
           FROM group_memberships AS membership
           JOIN devices AS creator_device ON creator_device.id = membership.device_id
           JOIN locked_pairing_code
             ON locked_pairing_code.group_id = membership.group_id
            AND locked_pairing_code.created_by_device_id = membership.device_id
           WHERE membership.revoked_at IS NULL
             AND creator_device.status <> 'REVOKED'
           FOR UPDATE OF membership, creator_device
         ),         valid_pairing_code AS (
           SELECT
             locked_pairing_code.code_hash,
             locked_pairing_code.group_id,
             locked_pairing_code.role
           FROM locked_pairing_code
           JOIN active_code_creator
             ON active_code_creator.device_id = locked_pairing_code.created_by_device_id
         ),
         inserted_device AS (
           INSERT INTO devices (
             id, name, public_key, platform, application_version, status, created_at, last_seen_at
           )
           SELECT $4, $5, $6, $7, $8, 'ONLINE', $3, $3
           FROM valid_pairing_code
           RETURNING id, name, public_key, platform, application_version, status, created_at, last_seen_at
         ),
         redeemed_pairing_code AS (
           UPDATE pairing_codes AS pairing_code
           SET consumed_at = $3,
               consumed_by_device_id = inserted_device.id
           FROM valid_pairing_code
           CROSS JOIN inserted_device
           WHERE pairing_code.code_hash = valid_pairing_code.code_hash
           RETURNING valid_pairing_code.group_id, valid_pairing_code.role
         ),
         inserted_membership AS (
           INSERT INTO group_memberships (group_id, device_id, role, joined_at)
           SELECT redeemed_pairing_code.group_id, inserted_device.id, redeemed_pairing_code.role, $3
           FROM redeemed_pairing_code
           CROSS JOIN inserted_device
           RETURNING group_id, device_id, role
         ),
         inserted_session AS (
           INSERT INTO device_sessions (
             id, device_id, group_id, refresh_token_hash, refresh_hash_version,
             issued_at, expires_at, last_seen_at
           )
           SELECT $9, inserted_membership.device_id, inserted_membership.group_id, $10, $2, $3, $11, $3
           FROM inserted_membership
           RETURNING id, device_id, group_id, expires_at
         ),
         inserted_access_token AS (
           INSERT INTO device_access_tokens (
             id, session_id, token_hash, hash_version, issued_at, expires_at, last_seen_at
           )
           SELECT $12, inserted_session.id, $13, $2, $3, $14, $3
           FROM inserted_session
           RETURNING session_id, expires_at
         ),
         updated_group AS (
           UPDATE groups
           SET revision = groups.revision + 1,
               updated_at = $3
           FROM inserted_membership
           WHERE groups.id = inserted_membership.group_id
           RETURNING
             groups.id,
             groups.name,
             groups.authority_mode,
             groups.leader_device_id,
             groups.revision,
             groups.created_at,
             groups.updated_at
         )
         SELECT
           updated_group.id AS group_id,
           updated_group.name AS group_name,
           updated_group.authority_mode AS group_authority_mode,
           updated_group.leader_device_id AS group_leader_device_id,
           updated_group.revision AS group_revision,
           updated_group.created_at AS group_created_at,
           updated_group.updated_at AS group_updated_at,
           inserted_device.id AS device_id,
           inserted_device.name AS device_name,
           inserted_device.public_key AS device_public_key,
           inserted_device.platform AS device_platform,
           inserted_device.application_version AS device_application_version,
           inserted_device.status AS device_status,
           inserted_device.created_at AS device_created_at,
           inserted_device.last_seen_at AS device_last_seen_at,
           inserted_membership.role AS role,
           inserted_session.id AS session_id,
           inserted_access_token.expires_at AS access_token_expires_at,
           inserted_session.expires_at AS refresh_token_expires_at
         FROM inserted_membership
         JOIN updated_group ON updated_group.id = inserted_membership.group_id
         JOIN inserted_device ON inserted_device.id = inserted_membership.device_id
         JOIN inserted_session ON inserted_session.device_id = inserted_device.id
         JOIN inserted_access_token ON inserted_access_token.session_id = inserted_session.id`,
        [
          this.hashToken('pair', pairingCode),
          this.#tokenHashVersion,
          now,
          deviceId,
          device.name,
          device.publicKey,
          device.platform,
          device.applicationVersion,
          session.id,
          session.refreshTokenHash,
          session.refreshTokenExpiresAt,
          session.accessTokenId,
          session.accessTokenHash,
          session.accessTokenExpiresAt,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'UNAUTHENTICATED',
        'The pairing code is invalid, expired, or has already been consumed.',
      );
    }
    return this.toCreatedLifecycle(row, session);
  }

  async refreshDeviceSession(refreshToken: string): Promise<PairedDeviceSession> {
    const token = requireText(refreshToken, 'refresh_token');
    const now = this.currentTime();
    const nextRefreshToken = this.createToken('refresh');
    const nextAccessToken = this.createToken('access');
    const nextAccessTokenId = this.createId(now);
    const refreshTokenExpiresAt = new Date(now.getTime() + this.#refreshTokenLifetimeMs);
    const accessTokenExpiresAt = new Date(now.getTime() + this.#accessTokenLifetimeMs);

    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH refresh_candidate AS MATERIALIZED (
           SELECT session.id, session.group_id
           FROM device_sessions AS session
           WHERE (session.refresh_token_hash = $1 AND session.refresh_hash_version = $2)
             OR (
               session.refresh_previous_token_hash = $1
               AND session.refresh_previous_hash_version = $2
               AND session.refresh_previous_expires_at > $3
             )
         ),
         historical_candidate AS MATERIALIZED (
           SELECT session.id, session.group_id
           FROM device_refresh_token_history AS refresh_history
           JOIN device_sessions AS session ON session.id = refresh_history.session_id
           WHERE refresh_history.token_hash = $1
             AND refresh_history.hash_version = $2
         ),
         candidate_groups AS MATERIALIZED (
           SELECT group_id FROM refresh_candidate
           UNION
           SELECT group_id FROM historical_candidate
         ),
         locked_group AS MATERIALIZED (
           SELECT groups.id
           FROM groups
           JOIN candidate_groups ON candidate_groups.group_id = groups.id
           FOR UPDATE OF groups
         ),
         active_session AS MATERIALIZED (
           SELECT
             session.id,
             session.device_id,
             session.group_id,
             session.issued_at,
             session.expires_at,
             session.refresh_token_hash,
             session.refresh_hash_version,
             session.refresh_previous_token_hash,
             session.refresh_previous_hash_version,
             session.refresh_previous_expires_at,
             session.refresh_token_hash = $1 AND session.refresh_hash_version = $2 AS current_match,
             session.refresh_previous_token_hash = $1
               AND session.refresh_previous_hash_version = $2
               AND session.refresh_previous_expires_at > $3 AS previous_match
           FROM device_sessions AS session
           JOIN locked_group ON locked_group.id = session.group_id
           JOIN group_memberships AS membership
             ON membership.group_id = session.group_id
            AND membership.device_id = session.device_id
            AND membership.revoked_at IS NULL
           JOIN devices ON devices.id = session.device_id
           WHERE session.revoked_at IS NULL
             AND session.expires_at > $3
             AND devices.status <> 'REVOKED'
             AND (
               (session.refresh_token_hash = $1 AND session.refresh_hash_version = $2)
               OR (
                 session.refresh_previous_token_hash = $1
                 AND session.refresh_previous_hash_version = $2
                 AND session.refresh_previous_expires_at > $3
               )
             )
           FOR UPDATE OF session, membership
         ),
         rotated_session AS (
           UPDATE device_sessions AS session
           SET refresh_previous_token_hash = active_session.refresh_token_hash,
               refresh_previous_hash_version = active_session.refresh_hash_version,
               refresh_previous_expires_at = active_session.expires_at,
               refresh_previous_retired_at = $3,
               refresh_token_hash = $4,
               refresh_hash_version = $2,
               issued_at = $3,
               expires_at = $5,
               refresh_rotated_at = $3,
               last_seen_at = $3
           FROM active_session
           WHERE session.id = active_session.id
             AND active_session.current_match
           RETURNING session.id, session.device_id, session.group_id, session.expires_at
         ),
         retired_refresh_token AS (
           INSERT INTO device_refresh_token_history (
             token_hash, session_id, hash_version, issued_at, expires_at, retired_at, retired_reason
           )
           SELECT
             active_session.refresh_token_hash,
             active_session.id,
             active_session.refresh_hash_version,
             active_session.issued_at,
             active_session.expires_at,
             $3,
             'ROTATED'
           FROM active_session
           JOIN rotated_session ON rotated_session.id = active_session.id
           ON CONFLICT (token_hash) DO NOTHING
         ),
         retired_access_tokens AS (
           UPDATE device_access_tokens AS access_token
           SET revoked_at = $3,
               revoked_reason = 'REFRESH_ROTATED'
           WHERE access_token.session_id IN (SELECT rotated_session.id FROM rotated_session)
             AND access_token.revoked_at IS NULL
           RETURNING access_token.id
         ),
         issued_access_token AS (
           INSERT INTO device_access_tokens (
             id, session_id, token_hash, hash_version, issued_at, expires_at, last_seen_at
           )
           SELECT $6, rotated_session.id, $7, $2, $3, $8, $3
           FROM rotated_session
           RETURNING session_id, expires_at
         ),
         replayed_previous_token AS (
           SELECT active_session.id AS session_id
           FROM active_session
           WHERE active_session.previous_match
             AND NOT EXISTS (SELECT 1 FROM rotated_session)
         ),
         historical_replay_session AS MATERIALIZED (
           SELECT session.id
           FROM device_refresh_token_history AS refresh_history
           JOIN device_sessions AS session ON session.id = refresh_history.session_id
           JOIN locked_group ON locked_group.id = session.group_id
           WHERE refresh_history.token_hash = $1
             AND refresh_history.hash_version = $2
             AND NOT EXISTS (SELECT 1 FROM active_session)
           FOR UPDATE OF session
         ),
         replayed_historical_token AS (
           UPDATE device_refresh_token_history AS refresh_history
           SET replay_detected_at = COALESCE(refresh_history.replay_detected_at, $3)
           FROM historical_replay_session
           WHERE refresh_history.token_hash = $1
             AND refresh_history.hash_version = $2
             AND refresh_history.session_id = historical_replay_session.id
           RETURNING refresh_history.session_id
         ),
         replayed_refresh_token AS (
           SELECT session_id FROM replayed_previous_token
           UNION
           SELECT session_id FROM replayed_historical_token
         ),
         replay_revoked_sessions AS (
           UPDATE device_sessions AS session
           SET revoked_at = COALESCE(session.revoked_at, $3),
               revoked_reason = COALESCE(session.revoked_reason, 'REFRESH_REPLAY')
           WHERE session.id IN (SELECT replayed_refresh_token.session_id FROM replayed_refresh_token)
             AND session.revoked_at IS NULL
           RETURNING session.id
         ),
         replay_revoked_access_tokens AS (
           UPDATE device_access_tokens AS access_token
           SET revoked_at = COALESCE(access_token.revoked_at, $3),
               revoked_reason = COALESCE(access_token.revoked_reason, 'REFRESH_REPLAY')
           WHERE access_token.session_id IN (SELECT replayed_refresh_token.session_id FROM replayed_refresh_token)
             AND access_token.revoked_at IS NULL
           RETURNING access_token.id
         )
         SELECT
           groups.id AS group_id,
           groups.name AS group_name,
           groups.authority_mode AS group_authority_mode,
           groups.leader_device_id AS group_leader_device_id,
           groups.revision AS group_revision,
           groups.created_at AS group_created_at,
           groups.updated_at AS group_updated_at,
           devices.id AS device_id,
           devices.name AS device_name,
           devices.public_key AS device_public_key,
           devices.platform AS device_platform,
           devices.application_version AS device_application_version,
           devices.status AS device_status,
           devices.created_at AS device_created_at,
           devices.last_seen_at AS device_last_seen_at,
           membership.role AS role,
           rotated_session.id AS session_id,
           issued_access_token.expires_at AS access_token_expires_at,
           rotated_session.expires_at AS refresh_token_expires_at
         FROM rotated_session
         JOIN issued_access_token ON issued_access_token.session_id = rotated_session.id
         JOIN groups ON groups.id = rotated_session.group_id
         JOIN devices ON devices.id = rotated_session.device_id
         JOIN group_memberships AS membership
           ON membership.group_id = rotated_session.group_id
          AND membership.device_id = rotated_session.device_id
          AND membership.revoked_at IS NULL
         WHERE devices.status <> 'REVOKED'`,
        [
          this.hashToken('refresh', token),
          this.#tokenHashVersion,
          now,
          this.hashToken('refresh', nextRefreshToken),
          refreshTokenExpiresAt,
          nextAccessTokenId,
          this.hashToken('access', nextAccessToken),
          accessTokenExpiresAt,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'UNAUTHENTICATED',
        'The refresh token is invalid or expired.',
      );
    }
    return {
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      accessTokenExpiresAt: readDate(row.access_token_expires_at, 'access_token_expires_at'),
      refreshTokenExpiresAt: readDate(row.refresh_token_expires_at, 'refresh_token_expires_at'),
      deviceId: readText(row.device_id, 'device_id'),
      groupId: readText(row.group_id, 'group_id'),
      role: readRole(row.role),
    };
  }
  /**
   * Credential authentication records a per-token heartbeat only. Global
   * device liveness is reconciled by presence processing; returning `now` as
   * the response observation timestamp avoids an access-token/device lock
   * cycle with refresh and group-membership mutations.
   */
  async authenticateAccessToken(accessToken: string): Promise<AuthenticatedDevice> {
    const token = requireText(accessToken, 'access_token');
    const now = this.currentTime();
    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH authenticated_access_token AS (
           UPDATE device_access_tokens AS access_token
           SET last_seen_at = $3
           FROM device_sessions AS session
           JOIN group_memberships AS membership
             ON membership.group_id = session.group_id
            AND membership.device_id = session.device_id
            AND membership.revoked_at IS NULL
           JOIN devices ON devices.id = session.device_id
           JOIN groups ON groups.id = session.group_id
           WHERE access_token.session_id = session.id
             AND access_token.token_hash = $1
             AND access_token.hash_version = $2
             AND access_token.revoked_at IS NULL
             AND access_token.expires_at > $3
             AND session.revoked_at IS NULL
             AND session.expires_at > $3
             AND devices.status <> 'REVOKED'
           RETURNING
             groups.id AS group_id,
             groups.name AS group_name,
             groups.authority_mode AS group_authority_mode,
             groups.leader_device_id AS group_leader_device_id,
             groups.revision AS group_revision,
             groups.created_at AS group_created_at,
             groups.updated_at AS group_updated_at,
             devices.id AS device_id,
             devices.name AS device_name,
             devices.public_key AS device_public_key,
             devices.platform AS device_platform,
             devices.application_version AS device_application_version,
             devices.status AS device_status,
             devices.created_at AS device_created_at,
             $3 AS device_last_seen_at,
             membership.role AS role,
             session.id AS session_id
         )
         SELECT * FROM authenticated_access_token`,
        [this.hashToken('access', token), this.#tokenHashVersion, now],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'UNAUTHENTICATED',
        'The access token is invalid or expired.',
      );
    }
    return {
      group: toGroup(row),
      device: toDevice(row),
      role: readRole(row.role),
      sessionId: readText(row.session_id, 'session_id'),
    };
  }

  async listDevices(
    authenticated: AuthenticatedDevice,
    groupId: string,
    requestedPageSize: number,
    cursor: string,
  ): Promise<Page<PairedDevice>> {
    const normalizedGroupId = requireText(groupId, 'group_id');
    if (authenticated.group.id !== normalizedGroupId) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The authenticated device does not belong to the requested group.',
      );
    }
    const pageSize = normalizePageSize(requestedPageSize);
    const decodedCursor = decodeCursor(cursor);
    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH active_requester AS (
           SELECT membership.device_id
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           WHERE membership.group_id = $1
             AND membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND devices.status <> 'REVOKED'
         ),
         all_active_members AS MATERIALIZED (
           SELECT
             devices.id AS device_id,
             devices.name AS device_name,
             devices.public_key AS device_public_key,
             devices.platform AS device_platform,
             devices.application_version AS device_application_version,
             devices.status AS device_status,
             devices.created_at AS device_created_at,
             devices.last_seen_at AS device_last_seen_at,
             membership.role AS role
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           WHERE membership.group_id = $1
             AND membership.revoked_at IS NULL
         ),
         page AS (
           SELECT *
           FROM all_active_members
           WHERE EXISTS (SELECT 1 FROM active_requester)
             AND (
               $4::timestamptz IS NULL
               OR (device_created_at, device_id) > ($4::timestamptz, $5::uuid)
             )
           ORDER BY device_created_at ASC, device_id ASC
           LIMIT $3
         )
         SELECT
           EXISTS (SELECT 1 FROM active_requester) AS requester_active,
           (SELECT COUNT(*) FROM all_active_members) AS approximate_total,
           COALESCE(
             jsonb_agg(to_jsonb(page) ORDER BY page.device_created_at ASC, page.device_id ASC),
             '[]'::jsonb
           ) AS items
         FROM page`,
        [
          normalizedGroupId,
          authenticated.device.id,
          pageSize + 1,
          decodedCursor?.createdAt ?? null,
          decodedCursor?.deviceId ?? null,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to list paired devices.');
    if (!readBoolean(row.requester_active, 'requester_active')) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The authenticated device is no longer an active group member.',
      );
    }
    const items = readJsonArray(row.items, 'items').map(toDevice);
    const hasMore = items.length > pageSize;
    const visibleItems = hasMore ? items.slice(0, pageSize) : items;
    const lastVisible = visibleItems.at(-1);
    return {
      items: visibleItems,
      nextCursor: hasMore && lastVisible !== undefined ? encodeCursor(lastVisible) : '',
      // The public protobuf contract exposes this field. The durable adapter
      // intentionally publishes forward keyset cursors only until the shared
      // `PageRequest` model gains an explicit direction field.
      previousCursor: '',
      hasMore,
      approximateTotal: readBigInt(row.approximate_total, 'approximate_total'),
    };
  }

  async revokeDevice(
    authenticated: AuthenticatedDevice,
    groupId: string,
    deviceId: string,
  ): Promise<{ readonly group: PairedGroup; readonly device: PairedDevice }> {
    const normalizedGroupId = requireText(groupId, 'group_id');
    const normalizedDeviceId = requireText(deviceId, 'device_id');
    if (authenticated.group.id !== normalizedGroupId) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The authenticated device does not belong to the requested group.',
      );
    }
    if (authenticated.device.id === normalizedDeviceId) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'An administrator cannot revoke the active device session.',
      );
    }
    const now = this.currentTime();
    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH locked_group AS MATERIALIZED (
           SELECT groups.id, groups.authority_mode, groups.leader_device_id
           FROM groups
           WHERE groups.id = $1
           FOR UPDATE
         ),
         actor AS MATERIALIZED (
           SELECT membership.group_id, membership.device_id, membership.role
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           JOIN locked_group ON locked_group.id = membership.group_id
           WHERE membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND devices.status <> 'REVOKED'
           FOR UPDATE OF membership
         ),
         target AS MATERIALIZED (
           SELECT
             membership.group_id,
             membership.device_id,
             membership.role,
             devices.name AS device_name,
             devices.public_key AS device_public_key,
             devices.platform AS device_platform,
             devices.application_version AS device_application_version,
             devices.status AS device_status,
             devices.created_at AS device_created_at,
             devices.last_seen_at AS device_last_seen_at,
             (
               locked_group.authority_mode = 'LEADER'
               AND locked_group.leader_device_id = membership.device_id
             ) AS target_is_leader
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           JOIN locked_group ON locked_group.id = membership.group_id
           WHERE membership.device_id = $3
             AND membership.revoked_at IS NULL
           FOR UPDATE OF membership
         ),
         active_admin_count AS (
           SELECT COUNT(*) AS value
           FROM group_memberships AS membership
           JOIN locked_group ON locked_group.id = membership.group_id
           WHERE membership.role = 'ADMIN'
             AND membership.revoked_at IS NULL
         ),
         eligible_target AS (
           SELECT target.group_id, target.device_id, target.role
           FROM actor
           CROSS JOIN target
           CROSS JOIN active_admin_count
           WHERE actor.role = 'ADMIN'
             AND NOT (target.role = 'ADMIN' AND active_admin_count.value = 1)
             AND NOT target.target_is_leader
         ),
         revoked_membership AS (
           UPDATE group_memberships AS membership
           SET revoked_at = $4
           FROM eligible_target
           WHERE membership.group_id = eligible_target.group_id
             AND membership.device_id = eligible_target.device_id
             AND membership.revoked_at IS NULL
           RETURNING membership.group_id, membership.device_id
         ),
         revoked_pairing_codes AS (
           UPDATE pairing_codes AS pairing_code
           SET revoked_at = $4
           FROM revoked_membership
           WHERE pairing_code.group_id = revoked_membership.group_id
             AND pairing_code.created_by_device_id = revoked_membership.device_id
             AND pairing_code.consumed_at IS NULL
             AND pairing_code.revoked_at IS NULL
           RETURNING pairing_code.code_hash
         ),
         revoked_sessions AS (
           UPDATE device_sessions AS session
           SET revoked_at = COALESCE(session.revoked_at, $4),
               revoked_reason = COALESCE(session.revoked_reason, 'DEVICE_REVOKED')
           FROM revoked_membership
           WHERE session.group_id = revoked_membership.group_id
             AND session.device_id = revoked_membership.device_id
             AND session.revoked_at IS NULL
           RETURNING session.id
         ),
         revoked_access_tokens AS (
           UPDATE device_access_tokens AS access_token
           SET revoked_at = COALESCE(access_token.revoked_at, $4),
               revoked_reason = COALESCE(access_token.revoked_reason, 'DEVICE_REVOKED')
           WHERE access_token.session_id IN (SELECT revoked_sessions.id FROM revoked_sessions)
             AND access_token.revoked_at IS NULL
           RETURNING access_token.id
         ),
         updated_group AS (
           UPDATE groups
           SET revision = groups.revision + 1,
               updated_at = $4
           WHERE groups.id IN (SELECT revoked_membership.group_id FROM revoked_membership)
           RETURNING
             groups.id AS group_id,
             groups.name AS group_name,
             groups.authority_mode AS group_authority_mode,
             groups.leader_device_id AS group_leader_device_id,
             groups.revision AS group_revision,
             groups.created_at AS group_created_at,
             groups.updated_at AS group_updated_at
         )
         SELECT
           EXISTS (SELECT 1 FROM actor) AS actor_active,
           (SELECT actor.role FROM actor LIMIT 1) AS actor_role,
           EXISTS (SELECT 1 FROM target) AS target_active,
           (SELECT target.role FROM target LIMIT 1) AS target_role,
           COALESCE((SELECT target.target_is_leader FROM target LIMIT 1), false) AS target_is_leader,
           (SELECT active_admin_count.value FROM active_admin_count) AS active_admin_count,
           (SELECT to_jsonb(updated_group) FROM updated_group) AS group,
           (
             SELECT jsonb_build_object(
               'device_id', target.device_id,
               'device_name', target.device_name,
               'device_public_key', target.device_public_key,
               'device_platform', target.device_platform,
               'device_application_version', target.device_application_version,
               -- The global device remains online for other groups. The
               -- mutation result is intentionally membership-scoped.
               'device_status', 'REVOKED',
               'device_created_at', target.device_created_at,
               'device_last_seen_at', target.device_last_seen_at,
               'role', target.role
             )
             FROM target
             JOIN revoked_membership
               ON revoked_membership.group_id = target.group_id
              AND revoked_membership.device_id = target.device_id
           ) AS device`,
        [normalizedGroupId, authenticated.device.id, normalizedDeviceId, now],
      ),
    );
    const row = requireOneRow(rows, 'Unable to revoke the paired device.');
    if (!readBoolean(row.actor_active, 'actor_active') || row.actor_role !== 'ADMIN') {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Only an active group administrator can revoke a paired device.',
      );
    }
    if (!readBoolean(row.target_active, 'target_active')) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The paired device does not exist.');
    }
    if (readBoolean(row.target_is_leader, 'target_is_leader')) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'Transfer group leadership before revoking the current leader.',
      );
    }
    if (
      row.target_role === 'ADMIN' &&
      readBigInt(row.active_admin_count, 'active_admin_count') === 1n
    ) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'A group must retain at least one active administrator.',
      );
    }
    const group = readJsonObject(row.group, 'group');
    const device = readJsonObject(row.device, 'device');
    if (Object.keys(group).length === 0 || Object.keys(device).length === 0) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The paired device could not be revoked because its state changed concurrently.',
      );
    }
    return { group: toGroup(group), device: toDevice(device) };
  }
  assertContextActor(authenticated: AuthenticatedDevice, actorDeviceId: string | undefined): void {
    if (actorDeviceId === undefined || actorDeviceId.length === 0) return;
    if (actorDeviceId !== authenticated.device.id) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The mutation context actor does not match the authenticated device.',
      );
    }
  }

  private async query<Row extends Record<string, unknown>>(
    statement: SqlStatement,
  ): Promise<readonly Row[]> {
    try {
      return await this.#database.query<Row>(statement);
    } catch (error: unknown) {
      throw normalizeDatabaseError(error);
    }
  }

  private toCreatedLifecycle(
    row: LifecycleRow,
    material: SessionMaterial,
  ): {
    readonly group: PairedGroup;
    readonly device: PairedDevice;
    readonly session: PairedDeviceSession;
  } {
    return {
      group: toGroup(row),
      device: toDevice(row),
      session: {
        accessToken: material.accessToken,
        refreshToken: material.refreshToken,
        accessTokenExpiresAt: readDate(row.access_token_expires_at, 'access_token_expires_at'),
        refreshTokenExpiresAt: readDate(row.refresh_token_expires_at, 'refresh_token_expires_at'),
        deviceId: readText(row.device_id, 'device_id'),
        groupId: readText(row.group_id, 'group_id'),
        role: readRole(row.role),
      },
    };
  }

  private issueSessionMaterial(now: Date): SessionMaterial {
    const accessToken = this.createToken('access');
    const refreshToken = this.createToken('refresh');
    return {
      id: this.createId(now),
      accessTokenId: this.createId(now),
      accessToken,
      accessTokenHash: this.hashToken('access', accessToken),
      accessTokenExpiresAt: new Date(now.getTime() + this.#accessTokenLifetimeMs),
      refreshToken,
      refreshTokenHash: this.hashToken('refresh', refreshToken),
      refreshTokenExpiresAt: new Date(now.getTime() + this.#refreshTokenLifetimeMs),
    };
  }

  private createToken(purpose: DurableCredentialKind): string {
    const bytes = this.#randomBytes(32);
    if (bytes.length < 32) throw new Error('randomBytes must return at least 32 bytes');
    return `hq_${purpose}_${Buffer.from(bytes.slice(0, 32)).toString('base64url')}`;
  }

  private hashToken(purpose: DurableCredentialKind, token: string): string {
    const hash = this.#hashCredential(purpose, token);
    if (typeof hash !== 'string' || hash.trim().length === 0) {
      throw new Error('hashCredential must return a non-empty opaque credential hash');
    }
    return hash;
  }

  private createId(now: Date): string {
    const random = this.#randomBytes(16);
    if (random.length < 16) throw new Error('randomBytes must return at least 16 bytes');
    const timestamp = BigInt(now.getTime());
    if (timestamp < 0n) throw new Error('now must not be before the Unix epoch');
    const uuid = new Uint8Array(16);
    for (let index = 5; index >= 0; index -= 1) {
      uuid[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
    }
    uuid[6] = (random[0] ?? 0) & 0x0f;
    uuid[6] |= 0x70;
    uuid[7] = random[1] ?? 0;
    uuid[8] = (random[2] ?? 0) & 0x3f;
    uuid[8] |= 0x80;
    uuid.set(random.slice(3, 10), 9);
    return `${hex(uuid.slice(0, 4))}-${hex(uuid.slice(4, 6))}-${hex(uuid.slice(6, 8))}-${hex(
      uuid.slice(8, 10),
    )}-${hex(uuid.slice(10, 16))}`;
  }

  private currentTime(): Date {
    const value = this.#now();
    if (Number.isNaN(value.getTime())) throw new Error('now must return a valid Date');
    return new Date(value.getTime());
  }
}

function sql(text: string, values: readonly SqlParameter[]): SqlStatement {
  return { text, values };
}

function requireOneRow(rows: readonly LifecycleRow[], message: string): LifecycleRow {
  const row = rows[0];
  if (row === undefined) throw new PairedDeviceRuntimeError('FAILED_PRECONDITION', message);
  return row;
}

function normalizeDeviceInput(input: {
  readonly name: string;
  readonly publicKey: string;
  readonly platform: string;
  readonly applicationVersion: string;
}): {
  readonly name: string;
  readonly publicKey: string;
  readonly platform: string;
  readonly applicationVersion: string;
} {
  return {
    name: requireText(input.name, 'device_name'),
    publicKey: requireText(input.publicKey, 'public_key'),
    platform: requireText(input.platform, 'platform'),
    applicationVersion: requireText(input.applicationVersion, 'application_version'),
  };
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  return normalized;
}

function positiveLifetime(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireTokenHashVersion(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new Error('tokenHashVersion must be a non-empty stable identifier');
  }
  return normalized;
}

function normalizePageSize(requestedPageSize: number): number {
  if (requestedPageSize === 0) return defaultPageSize;
  if (
    !Number.isSafeInteger(requestedPageSize) ||
    requestedPageSize < 1 ||
    requestedPageSize > maxPageSize
  ) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `page_size must be between 1 and ${maxPageSize}.`,
    );
  }
  return requestedPageSize;
}

function toGroup(row: Record<string, unknown>): PairedGroup {
  const authorityMode = readText(row.group_authority_mode, 'group_authority_mode');
  if (authorityMode !== 'LEADER' && authorityMode !== 'MULTI_AUTHORITY') {
    throw new Error('Unexpected group authority mode returned by the database.');
  }
  return {
    id: readText(row.group_id, 'group_id'),
    name: readText(row.group_name, 'group_name'),
    authorityMode,
    leaderDeviceId: readText(row.group_leader_device_id, 'group_leader_device_id'),
    revision: readBigInt(row.group_revision, 'group_revision'),
    createdAt: readDate(row.group_created_at, 'group_created_at'),
    updatedAt: readDate(row.group_updated_at, 'group_updated_at'),
  };
}

function toDevice(row: Record<string, unknown>): PairedDevice {
  return {
    id: readText(row.device_id, 'device_id'),
    name: readText(row.device_name, 'device_name'),
    publicKey: readText(row.device_public_key, 'device_public_key'),
    role: readRole(row.role),
    status: readDeviceStatus(row.device_status),
    platform: readText(row.device_platform, 'device_platform'),
    applicationVersion: readText(row.device_application_version, 'device_application_version'),
    createdAt: readDate(row.device_created_at, 'device_created_at'),
    lastSeenAt: readDate(row.device_last_seen_at, 'device_last_seen_at'),
  };
}

function readRole(value: unknown): DeviceRole {
  const role = readText(value, 'role');
  if (role === 'VIEWER' || role === 'EDITOR' || role === 'ADMIN') return role;
  throw new Error('Unexpected device role returned by the database.');
}

function readPairingRole(value: unknown): Exclude<DeviceRole, 'ADMIN'> {
  const role = readRole(value);
  if (role === 'VIEWER' || role === 'EDITOR') return role;
  throw new Error('Unexpected pairing role returned by the database.');
}

function readDeviceStatus(value: unknown): PairedDevice['status'] {
  const status = readText(value, 'device_status');
  if (status === 'OFFLINE' || status === 'ONLINE' || status === 'REVOKED') return status;
  throw new Error('Unexpected device status returned by the database.');
}

function readText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return value;
}

function readDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`The database returned an invalid ${field}.`);
  return date;
}

function readBigInt(value: unknown, field: string): bigint {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new Error('unsafe integer');
      return BigInt(value);
    }
    if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value);
  } catch {
    // Normalized error below keeps driver-specific conversion details out of responses.
  }
  throw new Error(`The database returned an invalid ${field}.`);
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`The database returned an invalid ${field}.`);
}

function readJsonArray(value: unknown, field: string): readonly Record<string, unknown>[] {
  const decoded = readJson(value, field);
  if (!Array.isArray(decoded) || !decoded.every(isRecord)) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return decoded;
}

function readJsonObject(value: unknown, field: string): Record<string, unknown> {
  const decoded = readJson(value, field);
  if (!isRecord(decoded)) throw new Error(`The database returned an invalid ${field}.`);
  return decoded;
}

function readJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`The database returned invalid JSON for ${field}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeCursor(device: PairedDevice): string {
  return Buffer.from(
    JSON.stringify({ createdAt: device.createdAt.toISOString(), deviceId: device.id }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(
  cursor: string,
): { readonly createdAt: Date; readonly deviceId: string } | undefined {
  if (cursor.length === 0) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      !isRecord(decoded) ||
      typeof decoded.createdAt !== 'string' ||
      typeof decoded.deviceId !== 'string'
    ) {
      throw new Error('invalid cursor payload');
    }
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime()) || decoded.deviceId.length === 0) {
      throw new Error('invalid cursor values');
    }
    return { createdAt, deviceId: decoded.deviceId };
  } catch {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'The page cursor is invalid.');
  }
}

function normalizeDatabaseError(error: unknown): Error {
  if (error instanceof PairedDeviceRuntimeError) return error;
  if (isPostgresError(error, '40P01') || isPostgresError(error, '40001')) {
    return new PairedDeviceRuntimeError(
      'ABORTED',
      'The lifecycle mutation conflicted with a concurrent operation. Retry after refreshing state.',
    );
  }
  if (isPostgresError(error, '23505')) {
    return new PairedDeviceRuntimeError(
      'ALREADY_EXISTS',
      'A record with the supplied unique identifier already exists.',
    );
  }
  if (isPostgresError(error, '23503')) {
    return new PairedDeviceRuntimeError(
      'FAILED_PRECONDITION',
      'The requested lifecycle state is no longer available.',
    );
  }
  if (error instanceof Error) return error;
  return new Error('The database rejected the paired-device operation.');
}

function isPostgresError(error: unknown, expectedCode: string): boolean {
  return isRecord(error) && error.code === expectedCode;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
