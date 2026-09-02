import { randomUUID } from 'node:crypto';

import type { SqlClient, SqlStatement } from '../db/database.js';
import {
  normalizeDatabaseError,
  readBigInt,
  readBoolean,
  readJsonObject,
  readOptionalText,
  readText,
  readTextArray,
  requireOneRow,
  sql,
} from '../sync/rows.js';
import { PairedDeviceRuntimeError, type AuthenticatedDevice } from '../sync/runtime.js';

import { renditionLadderFor, type RenditionSpec } from './ladder.js';

/**
 * The durable half of the conversion pipeline: the queue and its results.
 *
 * `conversion_jobs` has been in the schema since migration 0001 and no code has
 * ever read or written a row of it. This is that code. `material_renditions`
 * (migration 0012) is the other half: the job describes work, the rendition
 * describes what the work produced, and `GetPreviewGrant` reads only the second.
 *
 * Every statement here follows the package's rule -- one parameterized
 * statement built from data-modifying CTEs, never a read followed by a write.
 * The reason is sharper for a work queue than anywhere else in this package: a
 * read-then-write claim is the textbook way to hand one job to two workers, and
 * two ffmpeg processes writing one storage key would leave whichever finished
 * last as the rendition, with no rule saying which that was.
 *
 * Three mechanisms carry the concurrency argument, and none of them is in
 * TypeScript:
 *
 * - **`FOR UPDATE ... SKIP LOCKED`** in {@link DurableConversionStore.claimNextJob}.
 *   Two workers polling at the same instant take two different rows, or one
 *   takes a row and the other takes none; neither ever waits, and neither ever
 *   takes the row the other holds.
 * - **The attempt number as a fencing token.** A claim increments `attempt` and
 *   returns it, and every later write by that worker matches on it. A worker
 *   whose lease expired -- because its ffmpeg hung, or its process was paused --
 *   finds the row already re-claimed at a higher attempt and its completion
 *   changes nothing, rather than overwriting the rendition a live worker just
 *   recorded.
 * - **`UNIQUE (version_id, kind)` and `UNIQUE (version_id, variant)`.** The
 *   producer runs on `CompleteUpload` and again on any `GetPreviewGrant` that
 *   finds no rendition, so enqueueing has to be idempotent in the database
 *   rather than in the caller's memory.
 */

export type ConversionJobStateName = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

/** A job a worker now owns, with everything it needs to fetch the source. */
export interface ConversionJobClaim {
  readonly jobId: string;
  readonly groupId: string;
  readonly materialId: string;
  readonly versionId: string;
  /** `conversion_jobs.kind`, which is the `GetPreviewGrant.variant` string. */
  readonly variant: string;
  /** The fencing token: every later write by this worker matches on it. */
  readonly attempt: number;
  readonly sourceStorageKey: string;
  readonly sourceContentHash: string;
  readonly sourceMimeType: string;
  readonly sourceByteSize: bigint;
}

/** A rendition that exists, as the preview path needs it described. */
export interface RenditionRecord {
  readonly versionId: string;
  readonly variant: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
  readonly width: number;
  readonly height: number;
}

/** What a finished render produced. Dimensions are measured, never declared. */
export interface CompletedRenditionInput {
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
  readonly width: number;
  readonly height: number;
}

export interface ConversionQueueOutcome {
  /** The variants this call added. A variant already queued is not repeated. */
  readonly queued: readonly string[];
}

export interface DurableConversionStoreOptions {
  readonly database: SqlClient;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** How long a claim owns a job before another worker may take it over. */
  readonly leaseMs?: number;
  /** After this many attempts a job stops being retried and stays FAILED. */
  readonly maxAttempts?: number;
}

const defaultLeaseMs = 5 * 60 * 1000;
const defaultMaxAttempts = 3;
/**
 * How much of a failure is recorded.
 *
 * ffmpeg's stderr is a page of banner before the one line that matters, and the
 * tail is the part that names the cause. It is bounded because `detail` is read
 * by whoever debugs a shoot and because an unbounded process output is an
 * unbounded row.
 */
const maxDetailLength = 500;

/**
 * Membership, re-derived rather than trusted.
 *
 * Active membership -- not the editor role the material mutations demand -- is
 * the bar for both the producer and the rendition read. Queueing a transcode
 * changes nothing the group holds: it derives an artifact from bytes the caller
 * may already read, and refusing a viewer would mean a viewer's quality menu
 * could never be filled by anyone. A revoked device still fails, which is the
 * property that matters.
 */
const activeMemberPrologue = `WITH active_member AS (
           SELECT membership.group_id, membership.device_id
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           WHERE membership.group_id = $1
             AND membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND devices.status <> 'REVOKED'
         )`;

export class DurableConversionStore {
  readonly #database: SqlClient;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;

  constructor(options: DurableConversionStoreOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => randomUUID());
    this.#leaseMs = positiveInteger(options.leaseMs ?? defaultLeaseMs, 'leaseMs');
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? defaultMaxAttempts, 'maxAttempts');
  }

  get maxAttempts(): number {
    return this.#maxAttempts;
  }

  // ------------------------------------------------------------- producer

  /**
   * Queues the variants named, for a version the caller can reach.
   *
   * The group, material and version are re-derived from the caller's own
   * membership inside the statement rather than taken from the request, so a
   * version id belonging to another group joins to nothing and queues nothing.
   * A trashed material is excluded for the same reason its versions are not
   * served: work queued for content on its way out is work nobody asked for.
   *
   * `ON CONFLICT DO NOTHING` is what makes the call idempotent, and idempotence
   * is what lets both producers -- the upload completion and the preview grant
   * that finds nothing built -- run without coordinating.
   */
  async enqueueRenditions(
    authenticated: AuthenticatedDevice,
    materialId: string,
    versionId: string,
    variants: readonly string[],
  ): Promise<ConversionQueueOutcome> {
    const requested = [...new Set(variants.map((variant) => variant.trim()))].filter(
      (variant) => variant.length > 0,
    );
    if (requested.length === 0) return { queued: [] };
    const now = this.#now();
    const rows = await this.query(
      sql(
        `${activeMemberPrologue},
         target AS (
           -- Authorization is this join. A version reached through
           -- active_member can only be one in the caller's own group, so there
           -- is no separate check that a later edit could forget.
           SELECT material.group_id, material.id AS material_id, version.id AS version_id
           FROM material_versions AS version
           JOIN materials AS material ON material.id = version.material_id
           JOIN active_member ON active_member.group_id = material.group_id
           WHERE material.id = $4
             AND version.id = $5
             AND material.trashed_at IS NULL
         ),
         requested AS (
           SELECT entry.job_id, entry.kind
           FROM unnest($6::uuid[], $7::text[]) AS entry(job_id, kind)
         ),
         queued AS (
           INSERT INTO conversion_jobs (
             id, group_id, material_id, version_id, kind, state, attempt, created_at, updated_at
           )
           SELECT requested.job_id, target.group_id, target.material_id, target.version_id,
                  requested.kind, 'PENDING', 0, $3, $3
           FROM requested
           CROSS JOIN target
           -- The unique index from migration 0012. Without it the two producers
           -- would each queue the same transcode and two workers would spend
           -- two processes on one output.
           ON CONFLICT (version_id, kind) DO NOTHING
           RETURNING conversion_jobs.kind
         )
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           EXISTS (SELECT 1 FROM target) AS version_present,
           COALESCE(
             (SELECT array_agg(queued.kind ORDER BY queued.kind) FROM queued),
             ARRAY[]::text[]
           ) AS queued`,
        [
          authenticated.group.id,
          authenticated.device.id,
          now,
          requireIdentifier(materialId, 'material_id'),
          requireIdentifier(versionId, 'version_id'),
          `{${requested.map(() => this.#newId()).join(',')}}`,
          toTextArrayLiteral(requested),
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to queue material conversions.');
    assertMember(row);
    if (!readBoolean(row.version_present, 'version_present')) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The material version does not exist.');
    }
    return { queued: readTextArray(row.queued, 'queued') };
  }

  // ----------------------------------------------------------------- read

  /**
   * The rendition a variant names, if one has been built.
   *
   * `undefined` is the ordinary answer and the one every deployment gave before
   * this pipeline existed: no rendition, so the preview path signs the original
   * and the client reports that it received the original. The membership join
   * is here as well as on the location read that precedes it, because a read
   * that authorizes itself cannot be reached through a path that forgot to.
   */
  async readRendition(
    authenticated: AuthenticatedDevice,
    materialId: string,
    versionId: string,
    variant: string,
  ): Promise<RenditionRecord | undefined> {
    const normalizedVariant = variant.trim();
    if (normalizedVariant.length === 0) return undefined;
    const rows = await this.query(
      sql(
        `${activeMemberPrologue},
         visible_rendition AS (
           SELECT rendition.*
           FROM material_renditions AS rendition
           JOIN materials AS material ON material.id = rendition.material_id
           JOIN active_member ON active_member.group_id = material.group_id
           WHERE rendition.material_id = $3
             AND rendition.version_id = $4
             AND rendition.variant = $5
             AND material.trashed_at IS NULL
         )
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           (
             SELECT jsonb_build_object(
               'version_id', visible_rendition.version_id,
               'variant', visible_rendition.variant,
               'storage_key', visible_rendition.storage_key,
               'mime_type', visible_rendition.mime_type,
               -- text, not a JSON number: a rendition larger than 2^53 bytes
               -- would come back rounded, exactly as the material reads do.
               'byte_size', visible_rendition.byte_size::text,
               'width', visible_rendition.width,
               'height', visible_rendition.height
             )
             FROM visible_rendition
           ) AS rendition`,
        [
          authenticated.group.id,
          authenticated.device.id,
          requireIdentifier(materialId, 'material_id'),
          requireIdentifier(versionId, 'version_id'),
          normalizedVariant,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to read the material rendition.');
    assertMember(row);
    const rendition = row.rendition;
    if (rendition === null || rendition === undefined) return undefined;
    return toRendition(readJsonObject(rendition, 'rendition'));
  }

  // --------------------------------------------------------------- worker

  /**
   * Takes ownership of one job, or of none.
   *
   * This runs on the server's own behalf and carries no `AuthenticatedDevice`:
   * it is the process doing work it queued for itself, not a device asking for
   * anything. There is no group filter for the same reason -- one worker serves
   * every group this control plane holds.
   *
   * The joins are part of the claim rather than a check after it. A job whose
   * material was trashed, or whose object row is gone, is not claimable at all;
   * claiming it and then discovering the source missing would burn an attempt
   * and record a failure for something that is not a failure of conversion.
   */
  async claimNextJob(): Promise<ConversionJobClaim | undefined> {
    const now = this.#now();
    const leaseExpiresAt = new Date(now.getTime() + this.#leaseMs);
    const rows = await this.query(
      sql(
        `WITH claimable AS (
           SELECT job.id
           FROM conversion_jobs AS job
           JOIN materials AS material ON material.id = job.material_id
           JOIN material_versions AS version ON version.id = job.version_id
           JOIN material_objects AS object
             ON object.group_id = job.group_id
            AND object.content_hash = version.content_hash
           WHERE material.trashed_at IS NULL
             AND job.attempt < $3::int
             AND (
               job.state = 'PENDING'
               OR (
                 -- A lease that ran out is the only way a RUNNING job returns
                 -- to the queue. The worker that held it may still be alive, so
                 -- the attempt number below is what stops its late completion
                 -- from overwriting this one's.
                 job.state = 'RUNNING'
                 AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= $1)
               )
             )
           ORDER BY job.created_at, job.id
           -- SKIP LOCKED is the whole concurrency argument: a second worker
           -- polling at this instant takes the next row instead of waiting for
           -- this one or, worse, reading it as unclaimed.
           FOR UPDATE OF job SKIP LOCKED
           LIMIT 1
         ),
         claimed AS (
           UPDATE conversion_jobs AS job
           SET state = 'RUNNING',
               attempt = job.attempt + 1,
               lease_expires_at = $2,
               detail = NULL,
               updated_at = $1
           FROM claimable
           WHERE job.id = claimable.id
           RETURNING job.id, job.group_id, job.material_id, job.version_id, job.kind, job.attempt
         )
         SELECT claimed.id,
                claimed.group_id,
                claimed.material_id,
                claimed.version_id,
                claimed.kind,
                claimed.attempt,
                version.content_hash,
                version.mime_type,
                version.byte_size::text AS byte_size,
                object.storage_key
         FROM claimed
         JOIN material_versions AS version ON version.id = claimed.version_id
         JOIN material_objects AS object
           ON object.group_id = claimed.group_id
          AND object.content_hash = version.content_hash`,
        [now, leaseExpiresAt, this.#maxAttempts],
      ),
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      jobId: readText(row.id, 'id'),
      groupId: readText(row.group_id, 'group_id'),
      materialId: readText(row.material_id, 'material_id'),
      versionId: readText(row.version_id, 'version_id'),
      variant: readText(row.kind, 'kind'),
      attempt: readInteger(row.attempt, 'attempt'),
      sourceStorageKey: readText(row.storage_key, 'storage_key'),
      sourceContentHash: readText(row.content_hash, 'content_hash'),
      sourceMimeType: readText(row.mime_type, 'mime_type'),
      sourceByteSize: readBigInt(row.byte_size, 'byte_size'),
    };
  }

  /**
   * Records what a render produced and closes the job, in one statement.
   *
   * The rendition row and the job's state change cannot be two statements: a
   * crash between them would leave either a COMPLETED job with no rendition --
   * a variant the menu offers and nothing serves -- or a rendition no job
   * accounts for. `finished` reads `recorded` through `EXISTS`, and that
   * reference is what orders the two data-modifying CTEs: PostgreSQL does not
   * promise an execution order between siblings, but a CTE that reads another's
   * output must run after it.
   *
   * `false` means the claim was stale: the row was re-claimed under a higher
   * attempt while this worker was rendering, and the live worker's result is
   * the one that stands.
   */
  async completeJob(
    claim: ConversionJobClaim,
    rendition: CompletedRenditionInput,
  ): Promise<boolean> {
    const now = this.#now();
    const rows = await this.query(
      sql(
        `WITH locked_job AS MATERIALIZED (
           -- The attempt is the fence. A worker whose lease expired finds no
           -- row here, because the re-claim already incremented it.
           SELECT job.id, job.group_id, job.material_id, job.version_id, job.kind
           FROM conversion_jobs AS job
           WHERE job.id = $1
             AND job.attempt = $2::int
             AND job.state = 'RUNNING'
           FOR UPDATE OF job
         ),
         recorded AS (
           INSERT INTO material_renditions (
             id, group_id, material_id, version_id, variant,
             storage_key, mime_type, byte_size, width, height, created_at, updated_at
           )
           SELECT $4, locked_job.group_id, locked_job.material_id, locked_job.version_id,
                  locked_job.kind, $5, $6, $7::bigint, $8::int, $9::int, $3, $3
           FROM locked_job
           -- A re-render of an existing variant replaces it rather than adding
           -- a second row: the preview path has to have exactly one answer for
           -- (version, variant), and the newest render is that answer.
           ON CONFLICT (version_id, variant) DO UPDATE
             SET storage_key = EXCLUDED.storage_key,
                 mime_type = EXCLUDED.mime_type,
                 byte_size = EXCLUDED.byte_size,
                 width = EXCLUDED.width,
                 height = EXCLUDED.height,
                 updated_at = EXCLUDED.updated_at
           RETURNING material_renditions.id
         ),
         finished AS (
           UPDATE conversion_jobs AS job
           SET state = 'COMPLETED',
               lease_expires_at = NULL,
               detail = NULL,
               updated_at = $3
           FROM locked_job
           WHERE job.id = locked_job.id
             AND EXISTS (SELECT 1 FROM recorded)
           RETURNING job.id
         )
         SELECT EXISTS (SELECT 1 FROM finished) AS completed`,
        [
          claim.jobId,
          claim.attempt,
          now,
          this.#newId(),
          rendition.storageKey,
          rendition.mimeType,
          rendition.byteSize.toString(),
          rendition.width,
          rendition.height,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to record the material rendition.');
    return readBoolean(row.completed, 'completed');
  }

  /**
   * Records an honest failure and decides whether the job is retried.
   *
   * `detail` carries the bounded tail of whatever the renderer said -- an
   * ffmpeg stderr tail, a size refusal, an unknown variant. It is written
   * because a job that failed silently is indistinguishable from one that was
   * never queued, and the difference is the whole diagnosis.
   *
   * The retry decision is `CASE` in SQL rather than a branch here, so the
   * attempt this worker holds and the state it writes are decided from the same
   * locked row. `undefined` means the claim was stale, exactly as in
   * {@link completeJob}.
   *
   * `permanent` lowers the ceiling to one attempt, which sends the job straight
   * to FAILED. It is for the failures a retry cannot change -- a variant the
   * ladder does not declare, a source larger than this deployment converts --
   * where retrying twice more would spend a bucket download to reach the same
   * refusal and hide the real reason behind two more attempts.
   */
  async failJob(
    claim: ConversionJobClaim,
    detail: string,
    permanent = false,
  ): Promise<ConversionJobStateName | undefined> {
    const now = this.#now();
    const rows = await this.query(
      sql(
        `WITH locked_job AS MATERIALIZED (
           SELECT job.id, job.attempt
           FROM conversion_jobs AS job
           WHERE job.id = $1
             AND job.attempt = $2::int
             AND job.state = 'RUNNING'
           FOR UPDATE OF job
         ),
         recorded AS (
           UPDATE conversion_jobs AS job
           SET state = CASE
                 WHEN locked_job.attempt >= $5::int THEN 'FAILED'
                 ELSE 'PENDING'
               END,
               lease_expires_at = NULL,
               detail = $4,
               updated_at = $3
           FROM locked_job
           WHERE job.id = locked_job.id
           RETURNING job.state
         )
         SELECT (SELECT recorded.state FROM recorded) AS state`,
        [claim.jobId, claim.attempt, now, boundedDetail(detail), permanent ? 1 : this.#maxAttempts],
      ),
    );
    const row = requireOneRow(rows, 'Unable to record the conversion failure.');
    const state = readOptionalText(row.state);
    if (state === undefined) return undefined;
    return toJobState(state);
  }

  private async query(statement: SqlStatement): Promise<readonly Record<string, unknown>[]> {
    try {
      return await this.#database.query(statement);
    } catch (error: unknown) {
      throw normalizeDatabaseError(error);
    }
  }
}

/**
 * The variants a version should have, given the type its object is.
 *
 * A thin wrapper over the ladder, kept here because both producers ask the same
 * question and neither should decide it for itself.
 */
export function ladderVariantsFor(mimeType: string): readonly string[] {
  return renditionLadderFor(mimeType).map((spec: RenditionSpec) => spec.variant);
}

/**
 * Bounds whatever the renderer said, on one line.
 *
 * The *tail* is kept rather than the head: ffmpeg prints its build banner
 * first and the reason it stopped last, so the first 500 characters of a
 * failure are reliably the least useful 500 characters of it.
 */
export function boundedDetail(detail: string): string {
  const collapsed = detail.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return 'the renderer reported no detail';
  return collapsed.length > maxDetailLength
    ? `...${collapsed.slice(collapsed.length - (maxDetailLength - 3))}`
    : collapsed;
}

function toRendition(row: Record<string, unknown>): RenditionRecord {
  return {
    versionId: readText(row.version_id, 'version_id'),
    variant: readText(row.variant, 'variant'),
    storageKey: readText(row.storage_key, 'storage_key'),
    mimeType: readText(row.mime_type, 'mime_type'),
    byteSize: readBigInt(row.byte_size, 'byte_size'),
    width: readInteger(row.width, 'width'),
    height: readInteger(row.height, 'height'),
  };
}

function assertMember(row: Record<string, unknown>): void {
  if (!readBoolean(row.member_active, 'member_active')) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'The authenticated device is no longer an active member of the group.',
    );
  }
}

function toJobState(value: string): ConversionJobStateName {
  if (value === 'PENDING' || value === 'RUNNING' || value === 'COMPLETED' || value === 'FAILED') {
    return value;
  }
  throw new Error(`Unknown conversion job state: ${value}`);
}

function readInteger(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return Number(value);
  throw new Error(`Expected an integer ${field}`);
}

/**
 * A PostgreSQL array literal for the variant names.
 *
 * The names come from {@link renditionLadderFor}'s own table, never from a
 * request, but the literal is still built defensively: every element is
 * double-quoted with backslashes and quotes escaped, so a name could not end an
 * element early even if the table ever grew one. The value travels as a single
 * bound parameter cast to `text[]`, so nothing here is concatenated into SQL.
 */
function toTextArrayLiteral(values: readonly string[]): string {
  const escaped = values.map(
    (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
  );
  return `{${escaped.join(',')}}`;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

/** Trimmed and non-empty; the database decides whether it is a real uuid. */
function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  return normalized;
}
