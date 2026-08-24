import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';

import type { SqlClient } from '../db/database.js';
import { normalizePageSize as boundPageSize } from './paging.js';
import {
  groupMutationEpilogue,
  groupMutationProjection,
  groupMutationPrologue,
} from './group-mutations.js';
import type { FingerprintField, MutationReceiptContext, MutationScope } from './receipts.js';
import {
  MutationReceiptGuard,
  replayNoLongerAuthorized,
  requireOutcomeField,
  type MutationReceiptClaim,
  type StoredMutationReceipt,
} from './receipt-guard.js';
import {
  hex,
  isRecord,
  normalizeDatabaseError,
  readBigInt,
  readBoolean,
  readDate,
  readJsonArray,
  readJsonObject,
  readText,
  requireOneRow,
  sql,
} from './rows.js';
import { PairedDeviceRuntimeError } from './runtime.js';
import type {
  AuthenticatedDevice,
  AuthorityMode,
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
const defaultMutationReceiptLifetimeMs = 24 * 60 * 60 * 1000;
const defaultPageSize = 50;
const maxPageSize = 100;

export type DurableCredentialKind = 'access' | 'pair' | 'receipt' | 'refresh';

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
  /**
   * How long a completed idempotency receipt keeps answering retries. It
   * bounds both `mutation_receipts` growth and the window in which a recorded
   * mutation can re-issue credentials.
   */
  readonly mutationReceiptLifetimeMs?: number;
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
  readonly access_token_id?: unknown;
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
  readonly receipt_fingerprint?: unknown;
  readonly receipt_completed_at?: unknown;
  readonly receipt_group_id?: unknown;
  readonly receipt_device_id?: unknown;
  readonly receipt_session_id?: unknown;
  readonly receipt_resource_hash?: unknown;
  readonly receipt_revision?: unknown;
  readonly receipt_claimed?: unknown;
  readonly receipt_sequence?: unknown;
  readonly group_present?: unknown;
  readonly leader_is_active?: unknown;
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
  readonly #mutationReceiptLifetimeMs: number;
  readonly #receipts: MutationReceiptGuard;

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
    this.#mutationReceiptLifetimeMs = positiveLifetime(
      options.mutationReceiptLifetimeMs ?? defaultMutationReceiptLifetimeMs,
      'mutationReceiptLifetimeMs',
    );
    this.#receipts = new MutationReceiptGuard({
      database: this.#database,
      hashReceipt: (payload) => this.#hashCredential('receipt', payload),
      tokenHashVersion: this.#tokenHashVersion,
      receiptLifetimeMs: this.#mutationReceiptLifetimeMs,
      now: () => this.currentTime(),
    });
  }

  /** The receipt guard this runtime already configured, for collaborators that share its identity. */
  get receiptGuard(): MutationReceiptGuard {
    return this.#receipts;
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
    const receipt = await this.claimReceipt('CREATE_GROUP', input.mutation, now, [
      ['group_name', groupName],
      ['device_name', device.name],
      ['public_key', device.publicKey],
      ['platform', device.platform],
      ['application_version', device.applicationVersion],
    ]);

    if (receipt?.claimed === false) return this.replayCreatedLifecycle(receipt, now);

    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH locked_receipt AS MATERIALIZED (
           -- The claim was committed by its own statement, so the row
           -- is visible here. FOR UPDATE holds it for the duration of
           -- this mutation, which serializes concurrent retries of one
           -- request identifier.
           SELECT receipt.request_id_hash
           FROM mutation_receipts AS receipt
           WHERE receipt.scope = $16
             AND receipt.request_id_hash = $17
             AND receipt.completed_at IS NULL
           FOR UPDATE OF receipt
         ),
         mutation_gate AS MATERIALIZED (
           SELECT 1 AS open FROM locked_receipt
           UNION ALL
           SELECT 1 AS open WHERE $17::text IS NULL
         ),
         inserted_group AS (
           INSERT INTO groups (
             id, name, authority_mode, leader_device_id, revision, created_at, updated_at
           )
           SELECT $1, $2, 'LEADER', $3, 1, $4, $4 FROM mutation_gate
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
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = inserted_group.id,
               device_id = inserted_device.id,
               session_id = inserted_session.id,
               completed_at = $4
           FROM inserted_group
           CROSS JOIN inserted_device
           CROSS JOIN inserted_session
           WHERE receipt.scope = $16
             AND receipt.request_id_hash = $17
           RETURNING receipt.request_id_hash
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
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
        ],
      ),
    );

    const row = rows[0];
    if (row !== undefined) return this.toCreatedLifecycle(row, session);
    const bootstrapFailure = new PairedDeviceRuntimeError(
      'FAILED_PRECONDITION',
      'Unable to create the initial paired device.',
    );
    if (receipt === undefined) throw bootstrapFailure;
    const outcome = await this.resolveRefusedClaim(receipt, bootstrapFailure);
    const replayed = await this.reissueSessionCredentials(
      requireOutcomeField(outcome.sessionId, 'session_id'),
      now,
    );
    return this.toCreatedLifecycle(replayed.row, replayed.material);
  }

  /**
   * A pairing code is bound to the exact session and access token that
   * requested it, not only to the issuing device: `authorized_actor` locks
   * and re-validates that live session/access-token pair before the insert,
   * and `pairDevice` repeats the same check at redemption. This keeps a code
   * from outliving the credential that created it, matching the in-memory
   * `PairedDeviceRuntime.requireActivePairingIssuer` contract.
   */
  async createPairingCode(
    authenticated: AuthenticatedDevice,
    groupId: string,
    role: Exclude<DeviceRole, 'ADMIN'>,
    mutation?: MutationReceiptContext,
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
    const codeHash = this.hashToken('pair', code);
    const expiresAt = new Date(now.getTime() + this.#pairingCodeLifetimeMs);
    const receipt = await this.claimReceipt('CREATE_PAIRING_CODE', mutation, now, [
      ['group_id', normalizedGroupId],
      ['role', role],
      ['actor_device_id', authenticated.device.id],
      ['actor_access_token_id', authenticated.accessTokenId],
    ]);
    if (receipt?.claimed === false) {
      return this.replacePairingCode(receipt, normalizedGroupId, role, now);
    }

    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH locked_receipt AS MATERIALIZED (
           -- The claim was committed by its own statement, so the row
           -- is visible here. FOR UPDATE holds it for the duration of
           -- this mutation, which serializes concurrent retries of one
           -- request identifier.
           SELECT receipt.request_id_hash
           FROM mutation_receipts AS receipt
           WHERE receipt.scope = $10
             AND receipt.request_id_hash = $11
             AND receipt.completed_at IS NULL
           FOR UPDATE OF receipt
         ),
         mutation_gate AS MATERIALIZED (
           SELECT 1 AS open FROM locked_receipt
           UNION ALL
           SELECT 1 AS open WHERE $11::text IS NULL
         ),
         locked_group AS MATERIALIZED (
           SELECT groups.id
           FROM groups
           CROSS JOIN mutation_gate
           WHERE groups.id = $2
           FOR UPDATE OF groups
         ),
         authorized_actor AS MATERIALIZED (
           SELECT membership.device_id
           FROM group_memberships AS membership
           JOIN devices AS device ON device.id = membership.device_id
           JOIN locked_group ON locked_group.id = membership.group_id
           JOIN device_sessions AS issuer_session
             ON issuer_session.id = $8
            AND issuer_session.device_id = membership.device_id
            AND issuer_session.group_id = membership.group_id
            AND issuer_session.revoked_at IS NULL
            AND issuer_session.expires_at > $6
           JOIN device_access_tokens AS issuer_access_token
             ON issuer_access_token.id = $9
            AND issuer_access_token.session_id = issuer_session.id
            AND issuer_access_token.revoked_at IS NULL
            AND issuer_access_token.expires_at > $6
           WHERE membership.device_id = $5
             AND membership.revoked_at IS NULL
             AND device.status <> 'REVOKED'
             AND membership.role = 'ADMIN'
           FOR UPDATE OF membership, device, issuer_session, issuer_access_token
         ),
         issued_pairing_code AS (
           INSERT INTO pairing_codes (
             code_hash, group_id, role, expires_at, created_by_device_id, created_at, hash_version,
             created_by_session_id, created_by_access_token_id
           )
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
           WHERE EXISTS (SELECT 1 FROM authorized_actor)
           RETURNING code_hash, group_id, role, expires_at
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = issued_pairing_code.group_id,
               resource_hash = issued_pairing_code.code_hash,
               completed_at = $6
           FROM issued_pairing_code
           WHERE receipt.scope = $10
             AND receipt.request_id_hash = $11
           RETURNING receipt.request_id_hash
         )
         SELECT
           group_id AS pairing_group_id,
           role AS pairing_role,
           expires_at AS pairing_expires_at
         FROM issued_pairing_code`,
        [
          codeHash,
          normalizedGroupId,
          role,
          expiresAt,
          authenticated.device.id,
          now,
          this.#tokenHashVersion,
          authenticated.sessionId,
          authenticated.accessTokenId,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (row !== undefined) {
      return {
        code,
        groupId: readText(row.pairing_group_id, 'pairing_group_id'),
        role: readPairingRole(row.pairing_role),
        expiresAt: readDate(row.pairing_expires_at, 'pairing_expires_at'),
      };
    }
    const authorizationFailure = new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'Only an active group administrator can create a pairing code.',
    );
    if (receipt === undefined) throw authorizationFailure;
    return this.replacePairingCode(receipt, normalizedGroupId, role, now);
  }

  /**
   * Answers a retried pairing-code request.
   *
   * Only the code's hash was stored, so the original value cannot be returned
   * and a replacement has to be minted. The recorded code is retired in the
   * same statement: without that, one retry leaves two live capabilities and
   * the operator knows about only one of them. If the recorded code has already
   * been consumed the pairing it authorised has happened, and minting another
   * would grant a second capability nobody asked for.
   */
  private async replayCreatedLifecycle(
    receipt: MutationReceiptClaim,
    now: Date,
  ): Promise<{
    readonly group: PairedGroup;
    readonly device: PairedDevice;
    readonly session: PairedDeviceSession;
  }> {
    const outcome = await this.resolveRefusedClaim(receipt, replayNoLongerAuthorized());
    const replayed = await this.reissueSessionCredentials(
      requireOutcomeField(outcome.sessionId, 'session_id'),
      now,
    );
    return this.toCreatedLifecycle(replayed.row, replayed.material);
  }

  private async replacePairingCode(
    receipt: MutationReceiptClaim,
    groupId: string,
    role: Exclude<DeviceRole, 'ADMIN'>,
    now: Date,
  ): Promise<PairingCodeGrant> {
    const outcome = await this.resolveRefusedClaim(receipt, replayNoLongerAuthorized());
    const recordedCodeHash = requireOutcomeField(outcome.resourceHash, 'resource_hash');
    const code = this.createToken('pair');
    const expiresAt = new Date(now.getTime() + this.#pairingCodeLifetimeMs);
    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH recorded_code AS MATERIALIZED (
           SELECT
             pairing_code.code_hash,
             pairing_code.group_id,
             pairing_code.role,
             pairing_code.created_by_device_id,
             pairing_code.created_by_session_id,
             pairing_code.created_by_access_token_id,
             pairing_code.consumed_at
           FROM pairing_codes AS pairing_code
           WHERE pairing_code.code_hash = $1
           FOR UPDATE OF pairing_code
         ),
         replaceable_code AS (
           SELECT * FROM recorded_code WHERE recorded_code.consumed_at IS NULL
         ),
         retired_code AS (
           UPDATE pairing_codes AS pairing_code
           SET revoked_at = COALESCE(pairing_code.revoked_at, $2)
           FROM replaceable_code
           WHERE pairing_code.code_hash = replaceable_code.code_hash
           RETURNING pairing_code.code_hash
         ),
         issued_pairing_code AS (
           INSERT INTO pairing_codes (
             code_hash, group_id, role, expires_at, created_by_device_id, created_at, hash_version,
             created_by_session_id, created_by_access_token_id
           )
           SELECT
             $3,
             replaceable_code.group_id,
             replaceable_code.role,
             $4,
             replaceable_code.created_by_device_id,
             $2,
             $5,
             replaceable_code.created_by_session_id,
             replaceable_code.created_by_access_token_id
           FROM replaceable_code
           JOIN retired_code ON retired_code.code_hash = replaceable_code.code_hash
           RETURNING code_hash, group_id, role, expires_at
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET resource_hash = issued_pairing_code.code_hash
           FROM issued_pairing_code
           WHERE receipt.scope = $6
             AND receipt.request_id_hash = $7
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM recorded_code) AS actor_active,
           EXISTS (SELECT 1 FROM replaceable_code) AS target_active,
           (SELECT issued_pairing_code.group_id FROM issued_pairing_code) AS pairing_group_id,
           (SELECT issued_pairing_code.role FROM issued_pairing_code) AS pairing_role,
           (SELECT issued_pairing_code.expires_at FROM issued_pairing_code) AS pairing_expires_at`,
        [
          recordedCodeHash,
          now,
          this.hashToken('pair', code),
          expiresAt,
          this.#tokenHashVersion,
          receipt.scope,
          receipt.requestIdHash,
        ],
      ),
    );
    const row = requireOneRow(rows, 'The recorded pairing code can no longer be replaced.');
    if (!readBoolean(row.actor_active, 'actor_active')) throw replayNoLongerAuthorized();
    if (!readBoolean(row.target_active, 'target_active')) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The pairing code created by this request has already been used.',
      );
    }
    const issuedGroupId = readText(row.pairing_group_id, 'pairing_group_id');
    if (issuedGroupId !== groupId || readPairingRole(row.pairing_role) !== role) {
      throw new PairedDeviceRuntimeError(
        'ALREADY_EXISTS',
        'The mutation request identifier was already used with a different request payload.',
      );
    }
    return {
      code,
      groupId: issuedGroupId,
      role,
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
    const pairingCodeHash = this.hashToken('pair', pairingCode);
    const receipt = await this.claimReceipt('PAIR_DEVICE', input.mutation, now, [
      ['pairing_code_hash', pairingCodeHash],
      ['device_name', device.name],
      ['public_key', device.publicKey],
      ['platform', device.platform],
      ['application_version', device.applicationVersion],
    ]);

    if (receipt?.claimed === false) return this.replayCreatedLifecycle(receipt, now);

    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH locked_receipt AS MATERIALIZED (
           -- The claim was committed by its own statement, so the row
           -- is visible here. FOR UPDATE holds it for the duration of
           -- this mutation, which serializes concurrent retries of one
           -- request identifier.
           SELECT receipt.request_id_hash
           FROM mutation_receipts AS receipt
           WHERE receipt.scope = $15
             AND receipt.request_id_hash = $16
             AND receipt.completed_at IS NULL
           FOR UPDATE OF receipt
         ),
         -- Every data-modifying CTE below chains from this gate, so a refused
         -- claim makes the whole statement a no-op rather than a second
         -- redemption. The conflicting update also takes the receipt row lock,
         -- which serializes concurrent retries of one request identifier.
         mutation_gate AS MATERIALIZED (
           SELECT 1 AS open FROM locked_receipt
           UNION ALL
           SELECT 1 AS open WHERE $16::text IS NULL
         ),
         pairing_candidate AS MATERIALIZED (
           SELECT pairing_code.group_id
           FROM pairing_codes AS pairing_code
           CROSS JOIN mutation_gate
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
             pairing_code.created_by_device_id,
             pairing_code.created_by_session_id,
             pairing_code.created_by_access_token_id
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
           -- The issuer's session and access token must still be the live
           -- credential that created this code: a NULL binding (legacy row)
           -- or a retired one (rotated, replayed, or revoked) never matches,
           -- so redemption fails closed instead of trusting device membership
           -- alone.
           JOIN device_sessions AS issuer_session
             ON issuer_session.id = locked_pairing_code.created_by_session_id
            AND issuer_session.device_id = membership.device_id
            AND issuer_session.group_id = membership.group_id
            AND issuer_session.revoked_at IS NULL
            AND issuer_session.expires_at > $3
           JOIN device_access_tokens AS issuer_access_token
             ON issuer_access_token.id = locked_pairing_code.created_by_access_token_id
            AND issuer_access_token.session_id = issuer_session.id
            AND issuer_access_token.revoked_at IS NULL
            AND issuer_access_token.expires_at > $3
           WHERE membership.revoked_at IS NULL
             AND creator_device.status <> 'REVOKED'
           FOR UPDATE OF membership, creator_device, issuer_session, issuer_access_token
         ),
         valid_pairing_code AS (
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
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = inserted_membership.group_id,
               device_id = inserted_membership.device_id,
               session_id = inserted_session.id,
               completed_at = $3
           FROM inserted_membership
           CROSS JOIN inserted_session
           WHERE receipt.scope = $15
             AND receipt.request_id_hash = $16
           RETURNING receipt.request_id_hash
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
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (row !== undefined) return this.toCreatedLifecycle(row, session);
    const pairingFailure = new PairedDeviceRuntimeError(
      'UNAUTHENTICATED',
      'The pairing code is invalid, expired, or has already been consumed.',
    );
    if (receipt === undefined) throw pairingFailure;
    const outcome = await this.resolveRefusedClaim(receipt, pairingFailure);
    const replayed = await this.reissueSessionCredentials(
      requireOutcomeField(outcome.sessionId, 'session_id'),
      now,
    );
    return this.toCreatedLifecycle(replayed.row, replayed.material);
  }

  async refreshDeviceSession(
    refreshToken: string,
    mutation?: MutationReceiptContext,
  ): Promise<PairedDeviceSession> {
    const token = requireText(refreshToken, 'refresh_token');
    const now = this.currentTime();
    const nextRefreshToken = this.createToken('refresh');
    const nextAccessToken = this.createToken('access');
    const nextAccessTokenId = this.createId(now);
    const refreshTokenExpiresAt = new Date(now.getTime() + this.#refreshTokenLifetimeMs);
    const accessTokenExpiresAt = new Date(now.getTime() + this.#accessTokenLifetimeMs);
    const refreshTokenHash = this.hashToken('refresh', token);
    const receipt = await this.claimReceipt('REFRESH_DEVICE_SESSION', mutation, now, [
      ['refresh_token_hash', refreshTokenHash],
    ]);

    if (receipt?.claimed === false) {
      return (await this.replayCreatedLifecycle(receipt, now)).session;
    }

    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH locked_receipt AS MATERIALIZED (
           -- The claim was committed by its own statement, so the row
           -- is visible here. FOR UPDATE holds it for the duration of
           -- this mutation, which serializes concurrent retries of one
           -- request identifier.
           SELECT receipt.request_id_hash
           FROM mutation_receipts AS receipt
           WHERE receipt.scope = $9
             AND receipt.request_id_hash = $10
             AND receipt.completed_at IS NULL
           FOR UPDATE OF receipt
         ),
         -- Both candidate CTEs chain from this gate, and every rotation and
         -- replay-revocation CTE below chains from them. A refused claim
         -- therefore makes the statement a no-op instead of letting a retry
         -- of an already-rotated token be classified as an attack.
         mutation_gate AS MATERIALIZED (
           SELECT 1 AS open FROM locked_receipt
           UNION ALL
           SELECT 1 AS open WHERE $10::text IS NULL
         ),
         refresh_candidate AS MATERIALIZED (
           SELECT session.id, session.group_id
           FROM device_sessions AS session
           CROSS JOIN mutation_gate
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
           CROSS JOIN mutation_gate
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
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = rotated_session.group_id,
               device_id = rotated_session.device_id,
               session_id = rotated_session.id,
               completed_at = $3
           FROM rotated_session
           WHERE receipt.scope = $9
             AND receipt.request_id_hash = $10
           RETURNING receipt.request_id_hash
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
          refreshTokenHash,
          this.#tokenHashVersion,
          now,
          this.hashToken('refresh', nextRefreshToken),
          refreshTokenExpiresAt,
          nextAccessTokenId,
          this.hashToken('access', nextAccessToken),
          accessTokenExpiresAt,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
        ],
      ),
    );
    const row = rows[0];
    if (row !== undefined) {
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
    const refreshFailure = new PairedDeviceRuntimeError(
      'UNAUTHENTICATED',
      'The refresh token is invalid or expired.',
    );
    if (receipt === undefined) throw refreshFailure;
    const outcome = await this.resolveRefusedClaim(receipt, refreshFailure);
    const replayed = await this.reissueSessionCredentials(
      requireOutcomeField(outcome.sessionId, 'session_id'),
      now,
    );
    return {
      accessToken: replayed.material.accessToken,
      refreshToken: replayed.material.refreshToken,
      accessTokenExpiresAt: readDate(
        replayed.row.access_token_expires_at,
        'access_token_expires_at',
      ),
      refreshTokenExpiresAt: readDate(
        replayed.row.refresh_token_expires_at,
        'refresh_token_expires_at',
      ),
      deviceId: readText(replayed.row.device_id, 'device_id'),
      groupId: readText(replayed.row.group_id, 'group_id'),
      role: readRole(replayed.row.role),
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
             session.id AS session_id,
             access_token.id AS access_token_id
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
      accessTokenId: readText(row.access_token_id, 'access_token_id'),
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
    const pageSize = boundPageSize(requestedPageSize, { defaultPageSize, maxPageSize });
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
    mutation?: MutationReceiptContext,
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
    const receipt = await this.claimReceipt('REVOKE_DEVICE', mutation, now, [
      ['group_id', normalizedGroupId],
      ['device_id', normalizedDeviceId],
      ['actor_device_id', authenticated.device.id],
    ]);
    if (receipt?.claimed === false) return this.replayRevokedDevice(receipt);

    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH locked_receipt AS MATERIALIZED (
           -- The claim was committed by its own statement, so the row
           -- is visible here. FOR UPDATE holds it for the duration of
           -- this mutation, which serializes concurrent retries of one
           -- request identifier.
           SELECT receipt.request_id_hash
           FROM mutation_receipts AS receipt
           WHERE receipt.scope = $5
             AND receipt.request_id_hash = $6
             AND receipt.completed_at IS NULL
           FOR UPDATE OF receipt
         ),
         mutation_gate AS MATERIALIZED (
           SELECT 1 AS open FROM locked_receipt
           UNION ALL
           SELECT 1 AS open WHERE $6::text IS NULL
         ),
         locked_group AS MATERIALIZED (
           SELECT groups.id, groups.authority_mode, groups.leader_device_id
           FROM groups
           CROSS JOIN mutation_gate
           WHERE groups.id = $1
           FOR UPDATE OF groups
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
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = updated_group.group_id,
               device_id = revoked_membership.device_id,
               revision = updated_group.group_revision,
               completed_at = $4
           FROM updated_group
           CROSS JOIN revoked_membership
           WHERE receipt.scope = $5
             AND receipt.request_id_hash = $6
           RETURNING receipt.request_id_hash
         )
         SELECT
           -- Unlike every other mutation here, this statement's projection is
           -- built from scalar subqueries, so it returns a row even when the
           -- gate is shut. The replay path has to read the gate explicitly
           -- rather than infer it from an empty result.
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
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
        [
          normalizedGroupId,
          authenticated.device.id,
          normalizedDeviceId,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to revoke the paired device.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayRevokedDevice(receipt);
    }
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

  /**
   * Answers a retried revoke.
   *
   * A revoke is not naturally idempotent: re-running it would bump the group
   * revision a second time and then fail, because the membership it wants is
   * already gone. The recorded revision is returned rather than the group's
   * current one, so the caller sees the revision its own mutation produced
   * instead of whatever the group has drifted to since.
   */
  private async replayRevokedDevice(
    receipt: MutationReceiptClaim,
  ): Promise<{ readonly group: PairedGroup; readonly device: PairedDevice }> {
    const outcome = await this.resolveRefusedClaim(receipt, replayNoLongerAuthorized());
    const recordedGroupId = requireOutcomeField(outcome.groupId, 'group_id');
    const recordedDeviceId = requireOutcomeField(outcome.deviceId, 'device_id');
    if (outcome.revision === undefined) throw replayNoLongerAuthorized();

    const rows = await this.query<LifecycleRow>(
      sql(
        `SELECT
           groups.id AS group_id,
           groups.name AS group_name,
           groups.authority_mode AS group_authority_mode,
           groups.leader_device_id AS group_leader_device_id,
           $3::bigint AS group_revision,
           groups.created_at AS group_created_at,
           groups.updated_at AS group_updated_at,
           devices.id AS device_id,
           devices.name AS device_name,
           devices.public_key AS device_public_key,
           devices.platform AS device_platform,
           devices.application_version AS device_application_version,
           'REVOKED' AS device_status,
           devices.created_at AS device_created_at,
           devices.last_seen_at AS device_last_seen_at,
           membership.role AS role
         FROM groups
         JOIN devices ON devices.id = $2
         JOIN group_memberships AS membership
           ON membership.group_id = groups.id
          AND membership.device_id = devices.id
         WHERE groups.id = $1`,
        [recordedGroupId, recordedDeviceId, outcome.revision.toString()],
      ),
    );
    const row = rows[0];
    if (row === undefined) throw replayNoLongerAuthorized();
    return { group: toGroup(row), device: toDevice(row) };
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

  /**
   * Resolves the receipt identity of one mutation. An absent or empty
   * `request_id` is the proto3 default for a client that has not opted into
   * retries, so it returns `undefined` and every receipt parameter is bound to
   * NULL, leaving the pre-receipt statement semantics unchanged.
   */
  /**
   * Renames a group.
   *
   * The rename rides the shared spine's single `UPDATE groups`, so the new name
   * and the revision bump are one row write. Only an active administrator may
   * issue it, and the receipt records the revision the rename produced so a
   * retry answers with that number rather than whatever the group drifted to.
   */
  async updateGroup(
    authenticated: AuthenticatedDevice,
    groupId: string,
    name: string,
    mutation?: MutationReceiptContext,
  ): Promise<{ readonly group: PairedGroup }> {
    const normalizedGroupId = requireText(groupId, 'group_id');
    const normalizedName = requireText(name.trim(), 'name');
    this.requireSameGroup(authenticated, normalizedGroupId);
    const now = this.currentTime();
    const receipt = await this.claimReceipt('UPDATE_GROUP', mutation, now, [
      ['group_id', normalizedGroupId],
      ['name', normalizedName],
      ['actor_device_id', authenticated.device.id],
    ]);
    if (receipt?.claimed === false) return this.replayGroupMutation(receipt);

    const rows = await this.query<LifecycleRow>(
      sql(
        `${groupMutationPrologue},
         applied AS (
           SELECT
             locked_group.id AS group_id,
             NULL::uuid AS device_id,
             $6::text AS next_name,
             NULL::text AS next_authority_mode,
             NULL::uuid AS next_leader_device_id
           FROM actor
           CROSS JOIN locked_group
           WHERE actor.role = 'ADMIN'
         )${groupMutationEpilogue}
         ${groupMutationProjection}`,
        [
          normalizedGroupId,
          authenticated.device.id,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          normalizedName,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to rename the group.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayGroupMutation(receipt);
    }
    this.requireActingAdministrator(
      row,
      'Only an active group administrator can rename the group.',
    );
    return { group: this.requireMutatedGroup(row) };
  }

  /**
   * Switches a group between single-leader and multi-authority operation.
   *
   * Switching *to* `LEADER` while the group names no active leader would leave
   * a mode nobody can act in, so it is refused rather than silently accepted:
   * the caller sets a leader first.
   */
  async setAuthorityMode(
    authenticated: AuthenticatedDevice,
    groupId: string,
    mode: AuthorityMode,
    mutation?: MutationReceiptContext,
  ): Promise<{ readonly group: PairedGroup }> {
    const normalizedGroupId = requireText(groupId, 'group_id');
    this.requireSameGroup(authenticated, normalizedGroupId);
    const now = this.currentTime();
    const receipt = await this.claimReceipt('SET_AUTHORITY_MODE', mutation, now, [
      ['group_id', normalizedGroupId],
      ['authority_mode', mode],
      ['actor_device_id', authenticated.device.id],
    ]);
    if (receipt?.claimed === false) return this.replayGroupMutation(receipt);

    const rows = await this.query<LifecycleRow>(
      sql(
        `${groupMutationPrologue},
         leader_is_active AS (
           SELECT EXISTS (
             SELECT 1
             FROM group_memberships AS membership
             JOIN locked_group ON locked_group.id = membership.group_id
             WHERE membership.device_id = locked_group.leader_device_id
               AND membership.revoked_at IS NULL
           ) AS value
         ),
         applied AS (
           SELECT
             locked_group.id AS group_id,
             NULL::uuid AS device_id,
             NULL::text AS next_name,
             $6::text AS next_authority_mode,
             NULL::uuid AS next_leader_device_id
           FROM actor
           CROSS JOIN locked_group
           CROSS JOIN leader_is_active
           WHERE actor.role = 'ADMIN'
             AND ($6::text <> 'LEADER' OR leader_is_active.value)
         )${groupMutationEpilogue}
         ${groupMutationProjection},
           (SELECT leader_is_active.value FROM leader_is_active) AS leader_is_active`,
        [
          normalizedGroupId,
          authenticated.device.id,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          mode,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to change the group authority mode.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayGroupMutation(receipt);
    }
    this.requireActingAdministrator(
      row,
      'Only an active group administrator can change the authority mode.',
    );
    if (mode === 'LEADER' && !readBoolean(row.leader_is_active, 'leader_is_active')) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'Set an active group leader before switching the group to leader authority.',
      );
    }
    return { group: this.requireMutatedGroup(row) };
  }

  /**
   * Moves group leadership to another active member.
   *
   * The membership check is made here rather than left to
   * `groups_leader_membership_fk`: that constraint is deferred, so a device id
   * that names no active member would surface at commit as a driver error whose
   * message says nothing about leadership.
   */
  async setLeader(
    authenticated: AuthenticatedDevice,
    groupId: string,
    deviceId: string,
    mutation?: MutationReceiptContext,
  ): Promise<{ readonly group: PairedGroup }> {
    const normalizedGroupId = requireText(groupId, 'group_id');
    const normalizedDeviceId = requireText(deviceId, 'device_id');
    this.requireSameGroup(authenticated, normalizedGroupId);
    const now = this.currentTime();
    const receipt = await this.claimReceipt('SET_LEADER', mutation, now, [
      ['group_id', normalizedGroupId],
      ['device_id', normalizedDeviceId],
      ['actor_device_id', authenticated.device.id],
    ]);
    if (receipt?.claimed === false) return this.replayGroupMutation(receipt);

    const rows = await this.query<LifecycleRow>(
      sql(
        `${groupMutationPrologue},
         target AS MATERIALIZED (
           SELECT membership.group_id, membership.device_id, membership.role
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           JOIN locked_group ON locked_group.id = membership.group_id
           WHERE membership.device_id = $6
             AND membership.revoked_at IS NULL
             AND devices.status <> 'REVOKED'
           FOR UPDATE OF membership
         ),
         applied AS (
           SELECT
             locked_group.id AS group_id,
             NULL::uuid AS device_id,
             NULL::text AS next_name,
             NULL::text AS next_authority_mode,
             target.device_id AS next_leader_device_id
           FROM actor
           CROSS JOIN locked_group
           CROSS JOIN target
           WHERE actor.role = 'ADMIN'
         )${groupMutationEpilogue}
         ${groupMutationProjection},
           EXISTS (SELECT 1 FROM target) AS target_active`,
        [
          normalizedGroupId,
          authenticated.device.id,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          normalizedDeviceId,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to change the group leader.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayGroupMutation(receipt);
    }
    this.requireActingAdministrator(
      row,
      'Only an active group administrator can change the group leader.',
    );
    if (!readBoolean(row.target_active, 'target_active')) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'Group leadership can only be given to an active member of the group.',
      );
    }
    return { group: this.requireMutatedGroup(row) };
  }

  /**
   * Changes what a member of the group may do.
   *
   * Two invariants are enforced under the membership lock rather than by a
   * read-then-write: a group never loses its last administrator, and the leader
   * of a `LEADER`-mode group is never demoted out of `ADMIN`. Both are exactly
   * the races a structural test cannot observe.
   */
  async setDeviceRole(
    authenticated: AuthenticatedDevice,
    groupId: string,
    deviceId: string,
    role: DeviceRole,
    mutation?: MutationReceiptContext,
  ): Promise<{ readonly group: PairedGroup; readonly device: PairedDevice }> {
    const normalizedGroupId = requireText(groupId, 'group_id');
    const normalizedDeviceId = requireText(deviceId, 'device_id');
    this.requireSameGroup(authenticated, normalizedGroupId);
    const now = this.currentTime();
    const receipt = await this.claimReceipt('SET_DEVICE_ROLE', mutation, now, [
      ['group_id', normalizedGroupId],
      ['device_id', normalizedDeviceId],
      ['role', role],
      ['actor_device_id', authenticated.device.id],
    ]);
    if (receipt?.claimed === false) return this.replayRoleChange(receipt);

    const rows = await this.query<LifecycleRow>(
      sql(
        `${groupMutationPrologue},
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
           WHERE membership.device_id = $6
             AND membership.revoked_at IS NULL
           FOR UPDATE OF membership
         ),
         eligible_target AS (
           SELECT target.group_id, target.device_id
           FROM actor
           CROSS JOIN target
           CROSS JOIN active_admin_count
           WHERE actor.role = 'ADMIN'
             AND NOT (
               target.role = 'ADMIN'
               AND $7::text <> 'ADMIN'
               AND active_admin_count.value = 1
             )
             AND NOT (target.target_is_leader AND $7::text <> 'ADMIN')
         ),
         changed_membership AS (
           UPDATE group_memberships AS membership
           SET role = $7
           FROM eligible_target
           WHERE membership.group_id = eligible_target.group_id
             AND membership.device_id = eligible_target.device_id
             AND membership.revoked_at IS NULL
           RETURNING membership.group_id, membership.device_id, membership.role
         ),
         applied AS (
           SELECT
             changed_membership.group_id AS group_id,
             changed_membership.device_id AS device_id,
             NULL::text AS next_name,
             NULL::text AS next_authority_mode,
             NULL::uuid AS next_leader_device_id
           FROM changed_membership
         )${groupMutationEpilogue}
         ${groupMutationProjection},
           EXISTS (SELECT 1 FROM target) AS target_active,
           (SELECT target.role FROM target LIMIT 1) AS target_role,
           COALESCE((SELECT target.target_is_leader FROM target LIMIT 1), false) AS target_is_leader,
           (
             SELECT jsonb_build_object(
               'device_id', target.device_id,
               'device_name', target.device_name,
               'device_public_key', target.device_public_key,
               'device_platform', target.device_platform,
               'device_application_version', target.device_application_version,
               'device_status', target.device_status,
               'device_created_at', target.device_created_at,
               'device_last_seen_at', target.device_last_seen_at,
               'role', changed_membership.role
             )
             FROM target
             JOIN changed_membership
               ON changed_membership.group_id = target.group_id
              AND changed_membership.device_id = target.device_id
           ) AS device`,
        [
          normalizedGroupId,
          authenticated.device.id,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          normalizedDeviceId,
          role,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to change the paired device role.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayRoleChange(receipt);
    }
    this.requireActingAdministrator(
      row,
      'Only an active group administrator can change a paired device role.',
    );
    if (!readBoolean(row.target_active, 'target_active')) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The paired device does not exist.');
    }
    if (role !== 'ADMIN' && readBoolean(row.target_is_leader, 'target_is_leader')) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'Transfer group leadership before demoting the current leader.',
      );
    }
    if (
      role !== 'ADMIN' &&
      row.target_role === 'ADMIN' &&
      readBigInt(row.active_admin_count, 'active_admin_count') === 1n
    ) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'A group must retain at least one active administrator.',
      );
    }
    const device = readJsonObject(row.device, 'device');
    if (Object.keys(device).length === 0) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The paired device role could not be changed because its state changed concurrently.',
      );
    }
    return { group: this.requireMutatedGroup(row), device: toDevice(device) };
  }

  private requireSameGroup(authenticated: AuthenticatedDevice, groupId: string): void {
    if (authenticated.group.id !== groupId) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The authenticated device does not belong to the requested group.',
      );
    }
  }

  private requireActingAdministrator(row: LifecycleRow, message: string): void {
    if (!readBoolean(row.group_present, 'group_present')) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The group does not exist.');
    }
    if (!readBoolean(row.actor_active, 'actor_active') || row.actor_role !== 'ADMIN') {
      throw new PairedDeviceRuntimeError('PERMISSION_DENIED', message);
    }
  }

  private requireMutatedGroup(row: LifecycleRow): PairedGroup {
    const group = readJsonObject(row.group, 'group');
    if (Object.keys(group).length === 0) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The group could not be updated because its state changed concurrently.',
      );
    }
    return toGroup(group);
  }

  /**
   * Answers a retried group mutation with the revision the original produced.
   *
   * None of these mutations is naturally idempotent — each bumps the revision —
   * so re-running one would move the group a second time. The recorded revision
   * is returned instead of the group's current one.
   */
  private async replayGroupMutation(
    receipt: MutationReceiptClaim,
  ): Promise<{ readonly group: PairedGroup }> {
    const outcome = await this.resolveRefusedClaim(receipt, replayNoLongerAuthorized());
    const recordedGroupId = requireOutcomeField(outcome.groupId, 'group_id');
    if (outcome.revision === undefined) throw replayNoLongerAuthorized();
    const rows = await this.query<LifecycleRow>(
      sql(
        `SELECT
           groups.id AS group_id,
           groups.name AS group_name,
           groups.authority_mode AS group_authority_mode,
           groups.leader_device_id AS group_leader_device_id,
           $2::bigint AS group_revision,
           groups.created_at AS group_created_at,
           groups.updated_at AS group_updated_at
         FROM groups
         WHERE groups.id = $1`,
        [recordedGroupId, outcome.revision.toString()],
      ),
    );
    return { group: toGroup(requireOneRow(rows, 'The recorded group no longer exists.')) };
  }

  private async replayRoleChange(
    receipt: MutationReceiptClaim,
  ): Promise<{ readonly group: PairedGroup; readonly device: PairedDevice }> {
    const outcome = await this.resolveRefusedClaim(receipt, replayNoLongerAuthorized());
    const recordedGroupId = requireOutcomeField(outcome.groupId, 'group_id');
    const recordedDeviceId = requireOutcomeField(outcome.deviceId, 'device_id');
    if (outcome.revision === undefined) throw replayNoLongerAuthorized();
    const rows = await this.query<LifecycleRow>(
      sql(
        `SELECT
           groups.id AS group_id,
           groups.name AS group_name,
           groups.authority_mode AS group_authority_mode,
           groups.leader_device_id AS group_leader_device_id,
           $3::bigint AS group_revision,
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
           membership.role AS role
         FROM groups
         JOIN group_memberships AS membership ON membership.group_id = groups.id
         JOIN devices ON devices.id = membership.device_id
         WHERE groups.id = $1 AND membership.device_id = $2`,
        [recordedGroupId, recordedDeviceId, outcome.revision.toString()],
      ),
    );
    const row = requireOneRow(rows, 'The recorded membership no longer exists.');
    return { group: toGroup(row), device: toDevice(row) };
  }

  /**
   * Receipt handling is delegated whole.
   *
   * The claim cannot travel inside the mutation statement. PostgreSQL runs
   * every data-modifying CTE against the same pre-statement snapshot, so a CTE
   * that inserted the receipt and a later CTE that completed it never saw each
   * other: the completion matched no row, `completed_at` stayed NULL, and every
   * retry re-ran the mutation. Committing the claim first is what makes the
   * receipt row visible to the mutation statement that has to complete it.
   *
   * The statement itself now lives in `MutationReceiptGuard`, because the
   * realtime event store and the four F6 services issue the identical claim and
   * a second copy of it is the one thing that could make two retries of one
   * request disagree about whether they are retries.
   */
  private claimReceipt(
    scope: MutationScope,
    mutation: MutationReceiptContext | undefined,
    now: Date,
    fields: readonly FingerprintField[],
  ): Promise<MutationReceiptClaim | undefined> {
    return this.#receipts.claim(scope, mutation, now, fields);
  }

  private resolveRefusedClaim(
    receipt: MutationReceiptClaim,
    mutationFailure: PairedDeviceRuntimeError,
  ): Promise<StoredMutationReceipt> {
    return this.#receipts.resolveRefused(receipt, mutationFailure);
  }

  /**
   * Answers a retry by issuing fresh credentials on the session the original
   * mutation created, because no response — and therefore no raw token — was
   * ever stored.
   *
   * The receipt records identity, never authority: membership, device status
   * and session liveness are re-checked here, so a mutation that was valid
   * when it committed cannot resurrect credentials after a revoke. Rotation is
   * mandatory rather than incidental — only the hash of the current refresh
   * token exists, so the previous credential cannot be returned again.
   */
  private async reissueSessionCredentials(
    sessionId: string,
    now: Date,
  ): Promise<{ readonly row: LifecycleRow; readonly material: SessionMaterial }> {
    const nextRefreshToken = this.createToken('refresh');
    const nextAccessToken = this.createToken('access');
    const nextAccessTokenId = this.createId(now);
    const refreshTokenExpiresAt = new Date(now.getTime() + this.#refreshTokenLifetimeMs);
    const accessTokenExpiresAt = new Date(now.getTime() + this.#accessTokenLifetimeMs);
    const material: SessionMaterial = {
      id: sessionId,
      accessTokenId: nextAccessTokenId,
      accessToken: nextAccessToken,
      accessTokenHash: this.hashToken('access', nextAccessToken),
      accessTokenExpiresAt,
      refreshToken: nextRefreshToken,
      refreshTokenHash: this.hashToken('refresh', nextRefreshToken),
      refreshTokenExpiresAt,
    };

    const rows = await this.query<LifecycleRow>(
      sql(
        `WITH locked_group AS MATERIALIZED (
           SELECT groups.id
           FROM groups
           JOIN device_sessions AS session ON session.group_id = groups.id
           WHERE session.id = $1
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
             session.refresh_hash_version
           FROM device_sessions AS session
           JOIN locked_group ON locked_group.id = session.group_id
           JOIN group_memberships AS membership
             ON membership.group_id = session.group_id
            AND membership.device_id = session.device_id
            AND membership.revoked_at IS NULL
           JOIN devices ON devices.id = session.device_id
           WHERE session.id = $1
             AND session.revoked_at IS NULL
             AND session.expires_at > $2
             AND devices.status <> 'REVOKED'
           FOR UPDATE OF session, membership
         ),
         rotated_session AS (
           UPDATE device_sessions AS session
           SET refresh_previous_token_hash = active_session.refresh_token_hash,
               refresh_previous_hash_version = active_session.refresh_hash_version,
               refresh_previous_expires_at = active_session.expires_at,
               refresh_previous_retired_at = $2,
               refresh_token_hash = $3,
               refresh_hash_version = $4,
               issued_at = $2,
               expires_at = $5,
               refresh_rotated_at = $2,
               last_seen_at = $2
           FROM active_session
           WHERE session.id = active_session.id
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
             $2,
             'ROTATED'
           FROM active_session
           JOIN rotated_session ON rotated_session.id = active_session.id
           ON CONFLICT (token_hash) DO NOTHING
         ),
         retired_access_tokens AS (
           UPDATE device_access_tokens AS access_token
           SET revoked_at = $2,
               revoked_reason = 'REFRESH_ROTATED'
           WHERE access_token.session_id IN (SELECT rotated_session.id FROM rotated_session)
             AND access_token.revoked_at IS NULL
           RETURNING access_token.id
         ),
         issued_access_token AS (
           INSERT INTO device_access_tokens (
             id, session_id, token_hash, hash_version, issued_at, expires_at, last_seen_at
           )
           SELECT $6, rotated_session.id, $7, $4, $2, $8, $2
           FROM rotated_session
           RETURNING session_id, expires_at
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
          sessionId,
          now,
          material.refreshTokenHash,
          this.#tokenHashVersion,
          refreshTokenExpiresAt,
          nextAccessTokenId,
          material.accessTokenHash,
          accessTokenExpiresAt,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'UNAUTHENTICATED',
        'The recorded mutation can no longer issue credentials.',
      );
    }
    return { row, material };
  }

  private async query<Row extends Record<string, unknown>>(
    statement: ReturnType<typeof sql>,
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

/**
 * A receipt records identity, never authority. A completed row that is missing
 * the field its own scope requires means the stored outcome cannot be trusted,
 * so replay refuses rather than guessing.
 */

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
