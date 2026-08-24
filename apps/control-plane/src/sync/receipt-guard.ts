import type { SqlClient } from '../db/database.js';

import {
  encodeFingerprintPayload,
  encodeRequestIdPayload,
  normalizeRequestId,
  type FingerprintField,
  type MutationReceiptContext,
  type MutationScope,
} from './receipts.js';
import { normalizeDatabaseError, readBigInt, readOptionalText, readText, sql } from './rows.js';
import { PairedDeviceRuntimeError } from './runtime.js';

/** The receipt identity of one mutation attempt, resolved before its statement runs. */
export interface MutationReceiptClaim {
  readonly scope: MutationScope;
  readonly requestIdHash: string;
  readonly fingerprint: string;
  readonly expiresAt: Date;
  /** False when a completed receipt already owns this identity, so this is a retry. */
  readonly claimed: boolean;
}

/** A completed receipt as stored, before any scope-specific reading of it. */
export interface StoredMutationReceipt {
  readonly groupId: string | undefined;
  readonly deviceId: string | undefined;
  readonly sessionId: string | undefined;
  readonly resourceHash: string | undefined;
  readonly revision: bigint | undefined;
  readonly sequence: bigint | undefined;
  readonly resourceId: string | undefined;
}

export interface MutationReceiptGuardOptions {
  readonly database: SqlClient;
  /** The same purpose-separated hasher every credential in this package goes through. */
  readonly hashReceipt: (payload: string) => string;
  readonly tokenHashVersion: string;
  readonly receiptLifetimeMs: number;
  readonly now: () => Date;
}

/**
 * Claiming and reading durable idempotency receipts.
 *
 * This was two private methods of `DurablePairedDeviceRuntime` while that class
 * was the only module issuing mutations. F6 adds mutating RPCs to the realtime
 * event store and to four new services; each of them needs the identical claim
 * statement, and a second copy of it is the one thing that could make two
 * retries of the same request disagree about whether they are retries.
 *
 * The statement text is unchanged from the runtime's private version, so the
 * structural tests that assert its shape still describe what runs.
 */
export class MutationReceiptGuard {
  readonly #database: SqlClient;
  readonly #hashReceipt: (payload: string) => string;
  readonly #tokenHashVersion: string;
  readonly #receiptLifetimeMs: number;
  readonly #now: () => Date;

  constructor(options: MutationReceiptGuardOptions) {
    this.#database = options.database;
    this.#hashReceipt = options.hashReceipt;
    this.#tokenHashVersion = options.tokenHashVersion;
    this.#receiptLifetimeMs = options.receiptLifetimeMs;
    this.#now = options.now;
  }

  /**
   * Reserves the receipt identity for one mutation attempt.
   *
   * An absent request id is the proto3 default for a client that has not opted
   * into retries, so it returns `undefined` and no statement is issued at all.
   */
  async claim(
    scope: MutationScope,
    mutation: MutationReceiptContext | undefined,
    now: Date,
    fields: readonly FingerprintField[],
  ): Promise<MutationReceiptClaim | undefined> {
    const requestId = normalizeRequestId(mutation?.requestId);
    if (requestId === undefined) return undefined;
    const identity = {
      scope,
      requestIdHash: this.hash(encodeRequestIdPayload(scope, requestId)),
      fingerprint: this.hash(encodeFingerprintPayload(scope, fields)),
      expiresAt: new Date(now.getTime() + this.#receiptLifetimeMs),
    };
    const rows = await this.query(
      sql(
        `INSERT INTO mutation_receipts (
           scope, request_id_hash, hash_version, request_fingerprint, claimed_at, expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (scope, request_id_hash) DO UPDATE
           SET claimed_at = EXCLUDED.claimed_at,
               expires_at = EXCLUDED.expires_at,
               request_fingerprint = EXCLUDED.request_fingerprint
           -- A completed receipt refuses the claim; an unfinished one belongs
           -- to an attempt that never committed and carries no authority, so
           -- it is taken over rather than treated as a conflict.
           WHERE mutation_receipts.completed_at IS NULL
         RETURNING request_id_hash AS receipt_claimed`,
        [
          identity.scope,
          identity.requestIdHash,
          this.#tokenHashVersion,
          identity.fingerprint,
          now,
          identity.expiresAt,
        ],
      ),
    );
    return { ...identity, claimed: rows.length > 0 };
  }

  /**
   * Explains a mutation statement that produced no row while a receipt claim
   * was in play. The claim is refused only by a committed receipt, so a
   * completed row means a previous attempt already performed this exact
   * mutation and the caller is retrying it.
   *
   * An incomplete row is this attempt's own claim: the mutation genuinely
   * failed, and the operation's real error is raised so a retry is not
   * disguised as success.
   */
  async resolveRefused(
    receipt: MutationReceiptClaim,
    mutationFailure: PairedDeviceRuntimeError,
  ): Promise<StoredMutationReceipt> {
    const rows = await this.query(
      sql(
        `SELECT
           receipt.request_fingerprint AS receipt_fingerprint,
           receipt.completed_at AS receipt_completed_at,
           receipt.group_id AS receipt_group_id,
           receipt.device_id AS receipt_device_id,
           receipt.session_id AS receipt_session_id,
           receipt.resource_hash AS receipt_resource_hash,
           receipt.revision AS receipt_revision,
           receipt.sequence AS receipt_sequence,
           receipt.resource_id AS receipt_resource_id
         FROM mutation_receipts AS receipt
         WHERE receipt.scope = $1
           AND receipt.request_id_hash = $2
           AND receipt.expires_at > $3`,
        [receipt.scope, receipt.requestIdHash, this.#now()],
      ),
    );
    const row = rows[0];
    if (row?.receipt_completed_at === undefined || row.receipt_completed_at === null) {
      throw mutationFailure;
    }
    if (readText(row.receipt_fingerprint, 'receipt_fingerprint') !== receipt.fingerprint) {
      throw new PairedDeviceRuntimeError(
        'ALREADY_EXISTS',
        'The mutation request identifier was already used with a different request payload.',
      );
    }
    return {
      groupId: readOptionalText(row.receipt_group_id),
      deviceId: readOptionalText(row.receipt_device_id),
      sessionId: readOptionalText(row.receipt_session_id),
      resourceHash: readOptionalText(row.receipt_resource_hash),
      revision: readNullableBigInt(row.receipt_revision, 'receipt_revision'),
      sequence: readNullableBigInt(row.receipt_sequence, 'receipt_sequence'),
      resourceId: readOptionalText(row.receipt_resource_id),
    };
  }

  hash(payload: string): string {
    const hash = this.#hashReceipt(payload);
    if (typeof hash !== 'string' || hash.trim().length === 0) {
      throw new Error('hashCredential must return a non-empty opaque credential hash');
    }
    return hash;
  }

  private async query(
    statement: ReturnType<typeof sql>,
  ): Promise<readonly Record<string, unknown>[]> {
    try {
      return await this.#database.query(statement);
    } catch (error: unknown) {
      throw normalizeDatabaseError(error);
    }
  }
}

/**
 * A receipt records identity, never authority. A completed row that is missing
 * the field its own scope requires means the stored outcome cannot be trusted,
 * so replay refuses rather than guessing.
 */
export function replayNoLongerAuthorized(): PairedDeviceRuntimeError {
  return new PairedDeviceRuntimeError(
    'UNAUTHENTICATED',
    'The recorded mutation can no longer issue credentials.',
  );
}

export function requireOutcomeField(value: string | undefined, field: string): string {
  if (value === undefined) {
    throw new PairedDeviceRuntimeError(
      'UNAUTHENTICATED',
      `The recorded mutation is missing ${field} and can no longer be replayed.`,
    );
  }
  return value;
}

function readNullableBigInt(value: unknown, field: string): bigint | undefined {
  return value === null || value === undefined ? undefined : readBigInt(value, field);
}
