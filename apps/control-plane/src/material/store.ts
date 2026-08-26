import { randomUUID } from 'node:crypto';

import type { SqlClient, SqlStatement } from '../db/database.js';
import type { MutationReceiptClaim, MutationReceiptGuard } from '../sync/receipt-guard.js';
import type { MutationReceiptContext, MutationScope } from '../sync/receipts.js';
import {
  isRecord,
  normalizeDatabaseError,
  readBigInt,
  readBoolean,
  readDate,
  readJson,
  readJsonArray,
  readJsonObject,
  readOptionalDate,
  readOptionalText,
  readText,
  requireOneRow,
  sql,
} from '../sync/rows.js';
import { normalizePageSize as boundPageSize } from '../sync/paging.js';
import { PairedDeviceRuntimeError, type AuthenticatedDevice } from '../sync/runtime.js';

/**
 * The material library of a group: what was uploaded, which bytes it is made
 * of, and what may still be done to it.
 *
 * Two properties shape every statement in this file.
 *
 * The first is content addressing. `material_objects` is keyed by
 * `(group_id, content_hash)` and carries a reference count, so the same bytes
 * uploaded twice occupy one row and two materials. That count is the only thing
 * standing between a purge and bytes another material still needs, which is why
 * it is never computed in TypeScript: it is incremented by the same statement
 * that creates the material and decremented by the same statement that destroys
 * one, and the column's own `CHECK (reference_count >= 0)` is the last guard.
 *
 * The second is that `materials.current_version_id` has no foreign key — it
 * would cycle with `material_versions.material_id`, so migration 0001 left it
 * unconstrained. Nothing in the schema stops it pointing at a version that does
 * not exist. Every statement that inserts a version therefore writes the
 * pointer in the same statement, never in a follow-up update: a second
 * sub-statement cannot see the row the first one inserted, so a follow-up would
 * either match nothing or race a concurrent version.
 *
 * As everywhere else in this package, a mutation is one parameterized statement
 * built from data-modifying CTEs. The Neon HTTP driver offers no interactive
 * transaction, so a read-then-write would let a device revoked between the two
 * writes anyway.
 */

export type MaterialCategoryName =
  | 'UNSPECIFIED'
  | 'VIDEO'
  | 'CAMERA'
  | 'IMAGE'
  | 'AUDIO'
  | 'DOCUMENT'
  | 'MAP'
  | 'INTERCEPT'
  | 'DOSSIER'
  | 'REPORT'
  | 'ARCHIVE'
  | 'TECHNICAL'
  | 'OTHER';

export type MaterialStatusName =
  'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' | 'TRASHED' | 'QUARANTINED';

export type UploadStateName =
  'PENDING' | 'UPLOADING' | 'VERIFYING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

/** The three transitions `materials` alone can testify to; see {@link readMaterialEvents}. */
export type MaterialEventKindName = 'CREATED' | 'UPDATED' | 'TRASHED';

export interface MaterialRecord {
  readonly id: string;
  readonly groupId: string;
  readonly displayName: string;
  readonly category: MaterialCategoryName;
  readonly mimeType: string;
  readonly byteSize: bigint;
  readonly contentHash: string;
  readonly status: MaterialStatusName;
  readonly currentVersionId: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
  readonly revision: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly trashedAt: Date | undefined;
}

export interface MaterialVersionRecord {
  readonly id: string;
  readonly materialId: string;
  readonly sequence: bigint;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
  readonly originalFileName: string;
  readonly createdAt: Date;
  readonly createdByDeviceId: string | undefined;
}

export interface UploadSessionRecord {
  readonly id: string;
  readonly groupId: string;
  readonly materialId: string | undefined;
  readonly versionId: string | undefined;
  readonly state: UploadStateName;
  readonly totalSize: bigint;
  readonly receivedSize: bigint;
  readonly chunkSize: number;
  readonly maxConcurrency: number;
  readonly expiresAt: Date;
  /**
   * The object store's own multipart upload id, once one has been opened. It is
   * server-side plumbing bound to this session, never surfaced to a client: the
   * protocol `UploadSession` has no field for it, and `toProtocolSession` omits
   * it deliberately.
   */
  readonly storageUploadId?: string;
}

/** One contiguous byte range of an upload, as stored in `upload_parts`. */
export interface UploadPartRecord {
  readonly partNumber: number;
  readonly offset: bigint;
  readonly length: bigint;
}

/** Where a version's bytes live, for whoever is allowed to mint a URL for them. */
export interface StoredObjectLocation {
  readonly materialId: string;
  readonly versionId: string;
  readonly storageKey: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
}

export interface MaterialPage {
  readonly items: readonly MaterialRecord[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
  readonly approximateTotal: bigint;
}

export interface MaterialVersionPage {
  readonly items: readonly MaterialVersionRecord[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
  readonly approximateTotal: bigint;
}

export interface MaterialEventRecord {
  readonly materialId: string;
  readonly kind: MaterialEventKindName;
  readonly revision: bigint;
  readonly occurredAt: Date;
  /** Milliseconds since the epoch of `materials.updated_at`; see {@link readMaterialEvents}. */
  readonly sequence: bigint;
}

export interface BeginUploadInput {
  readonly groupId: string;
  /** A client-proposed identity, so a lost response does not orphan a material. */
  readonly materialId?: string;
  readonly displayName: string;
  readonly originalFileName: string;
  readonly category: MaterialCategoryName;
  readonly mimeType: string;
  readonly totalSize: bigint;
  readonly contentHash: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface BeginUploadOutcome {
  readonly material: MaterialRecord;
  readonly session: UploadSessionRecord;
  readonly parts: readonly UploadPartRecord[];
  readonly storageKey: string;
  /** True when the group already held these bytes, so nothing has to be uploaded. */
  readonly deduplicated: boolean;
}

export interface CreateMaterialVersionInput {
  readonly groupId: string;
  readonly materialId: string;
  readonly originalFileName: string;
  readonly mimeType: string;
  readonly totalSize: bigint;
  readonly contentHash: string;
}

export interface CreateMaterialVersionOutcome {
  readonly material: MaterialRecord;
  readonly version: MaterialVersionRecord;
  readonly session: UploadSessionRecord;
  readonly parts: readonly UploadPartRecord[];
  readonly storageKey: string;
}

export interface CompletedUploadPartInput {
  readonly partNumber: number;
  readonly etag: string;
  readonly checksum: string;
}

export interface UpdateMaterialMetadataInput {
  readonly groupId: string;
  readonly materialId: string;
  readonly displayName: string;
  readonly category: MaterialCategoryName;
  readonly metadata: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
}

export interface UploadStatusOutcome {
  readonly session: UploadSessionRecord;
  readonly completedParts: readonly number[];
}

export interface PurgedMaterial {
  readonly materialId: string;
  readonly revision: bigint;
  /** True when the purge removed the last reference and the object row with it. */
  readonly objectRemoved: boolean;
}

export interface DurableMaterialStoreOptions {
  readonly database: SqlClient;
  /**
   * Supplied when the store must answer retried mutations. Without it a request
   * that carries a `request_id` is refused rather than silently performed a
   * second time.
   */
  readonly receipts?: MutationReceiptGuard;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly uploadChunkSize?: number;
  readonly uploadConcurrency?: number;
  readonly uploadSessionLifetimeMs?: number;
}

const defaultUploadChunkSize = 8 * 1024 * 1024;
const defaultUploadConcurrency = 4;
const defaultUploadSessionLifetimeMs = 24 * 60 * 60 * 1000;
const defaultPageSize = 50;
const maxPageSize = 100;
const maxWatchBatch = 256;
/** S3-style multipart uploads cap out in the low thousands; this stays well inside every backend. */
const maxUploadParts = 1000;
const maxMetadataEntries = 100;
const maxMetadataKeyLength = 200;
const maxMetadataValueLength = 4000;
const maxTagCount = 64;
const maxTagLength = 120;
const maxDisplayNameLength = 500;
const contentHashPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,199}$/u;

/**
 * The SQL spine every material mutation shares.
 *
 * Parameter positions are fixed so a mutation can add its own without
 * renumbering the spine:
 *
 * - `$1` group id — the group the caller's access token names, re-checked here
 *   rather than trusted, so a token cannot reach a material in another group
 * - `$2` acting device id
 * - `$3` the mutation instant
 * - `$4` receipt scope, or NULL when the caller opted out of retries
 * - `$5` receipt request-id hash, or NULL
 * - `$6` the row the mutation names — a material id, or an upload id
 * - `$7` onwards: whatever the mutation itself needs
 *
 * `mutation_gate` is what makes an opted-out caller behave identically to one
 * whose claim is live: with `$5` NULL the gate opens unconditionally, and with a
 * claim it opens only while that claim is uncompleted. Locks are taken in the
 * package's established order — membership, then the row being changed — so no
 * two mutations can wait on each other in opposite directions.
 */
const receiptGate = `WITH locked_receipt AS MATERIALIZED (
           -- The claim was committed by its own statement, so the row is
           -- visible here. FOR UPDATE holds it for the duration of this
           -- mutation, which serializes concurrent retries of one request
           -- identifier.
           SELECT receipt.request_id_hash
           FROM mutation_receipts AS receipt
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
             AND receipt.completed_at IS NULL
           FOR UPDATE OF receipt
         ),
         mutation_gate AS MATERIALIZED (
           SELECT 1 AS open FROM locked_receipt
           UNION ALL
           SELECT 1 AS open WHERE $5::text IS NULL
         )`;

const activeEditor = `editor AS MATERIALIZED (
           SELECT membership.group_id, membership.device_id, membership.role
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           CROSS JOIN mutation_gate
           WHERE membership.group_id = $1
             AND membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND membership.role IN ('EDITOR', 'ADMIN')
             AND devices.status <> 'REVOKED'
           FOR UPDATE OF membership
         )`;

/**
 * Locks the material being changed and re-derives it from the caller's own
 * membership. A material reached through `editor` can only be one in the group
 * the caller is an active editor of, so authorization is a join rather than a
 * separate check that could be forgotten.
 */
const lockedMaterial = `locked_material AS MATERIALIZED (
           SELECT material.*
           FROM materials AS material
           JOIN editor ON editor.group_id = material.group_id
           WHERE material.id = $6
           FOR UPDATE OF material
         )`;

const materialMutationPrologue = `${receiptGate},
         ${activeEditor},
         ${lockedMaterial}`;

/** A read path's membership check: any active member may look, whatever their role. */
const activeMemberPrologue = `WITH active_member AS (
           SELECT membership.group_id, membership.device_id
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           WHERE membership.group_id = $1
             AND membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND devices.status <> 'REVOKED'
         )`;

/**
 * Every `bigint` column is cast to text on the way into JSON.
 *
 * `to_jsonb` would render them as JSON numbers, and a material larger than
 * 2^53 bytes would come back rounded — a silent corruption of exactly the
 * values this service exists to move.
 */
function materialJson(alias: string): string {
  return `jsonb_build_object(
             'id', ${alias}.id,
             'group_id', ${alias}.group_id,
             'display_name', ${alias}.display_name,
             'category', ${alias}.category,
             'mime_type', ${alias}.mime_type,
             'byte_size', ${alias}.byte_size::text,
             'content_hash', ${alias}.content_hash,
             'status', ${alias}.status,
             'current_version_id', ${alias}.current_version_id,
             'metadata', ${alias}.metadata,
             'revision', ${alias}.revision::text,
             'created_at', ${alias}.created_at,
             'updated_at', ${alias}.updated_at,
             'trashed_at', ${alias}.trashed_at,
             'tags', ${storedTagsJson(alias)}
           )`;
}

/**
 * The tags a material currently has, read from the link table.
 *
 * `UpdateMaterialMetadata` cannot use this: its own link writes are invisible
 * to the statement that performs them, so it projects the requested set
 * instead. See {@link requestedTagsJson}.
 */
function storedTagsJson(alias: string): string {
  return `COALESCE(
             (
               SELECT jsonb_agg(link.tag_value ORDER BY link.tag_value)
               FROM material_tag_links AS link
               WHERE link.material_id = ${alias}.id
             ),
             '[]'::jsonb
           )`;
}

function requestedTagsJson(parameter: number): string {
  return `COALESCE(
             (
               SELECT jsonb_agg(DISTINCT requested.value)
               FROM jsonb_array_elements_text($${parameter.toString()}::jsonb) AS requested(value)
             ),
             '[]'::jsonb
           )`;
}

/** `materialJson` with the tag projection replaced; used only by the metadata mutation. */
function materialJsonWithTags(alias: string, tags: string): string {
  return `jsonb_build_object(
             'id', ${alias}.id,
             'group_id', ${alias}.group_id,
             'display_name', ${alias}.display_name,
             'category', ${alias}.category,
             'mime_type', ${alias}.mime_type,
             'byte_size', ${alias}.byte_size::text,
             'content_hash', ${alias}.content_hash,
             'status', ${alias}.status,
             'current_version_id', ${alias}.current_version_id,
             'metadata', ${alias}.metadata,
             'revision', ${alias}.revision::text,
             'created_at', ${alias}.created_at,
             'updated_at', ${alias}.updated_at,
             'trashed_at', ${alias}.trashed_at,
             'tags', ${tags}
           )`;
}

function versionJson(alias: string): string {
  return `jsonb_build_object(
             'id', ${alias}.id,
             'material_id', ${alias}.material_id,
             'sequence', ${alias}.sequence::text,
             'content_hash', ${alias}.content_hash,
             'mime_type', ${alias}.mime_type,
             'byte_size', ${alias}.byte_size::text,
             'original_file_name', ${alias}.original_file_name,
             'created_by_device_id', ${alias}.created_by_device_id,
             'created_at', ${alias}.created_at
           )`;
}

function sessionJson(alias: string): string {
  return `jsonb_build_object(
             'id', ${alias}.id,
             'group_id', ${alias}.group_id,
             'material_id', ${alias}.material_id,
             'version_id', ${alias}.version_id,
             'state', ${alias}.state,
             'total_size', ${alias}.total_size::text,
             'received_size', ${alias}.received_size::text,
             'chunk_size', ${alias}.chunk_size,
             'max_concurrency', ${alias}.max_concurrency,
             'expires_at', ${alias}.expires_at,
             'storage_upload_id', ${alias}.storage_upload_id
           )`;
}

/**
 * The `materials` adapter.
 *
 * Reads take any active member; mutations take an active `EDITOR` or `ADMIN`.
 * Both are re-derived inside the statement rather than read from the
 * authenticated caller, because an access token stays valid for its lifetime
 * and a device revoked a moment ago must not be able to write.
 */
export class DurableMaterialStore {
  readonly #database: SqlClient;
  readonly #receipts: MutationReceiptGuard | undefined;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #uploadChunkSize: number;
  readonly #uploadConcurrency: number;
  readonly #uploadSessionLifetimeMs: number;

  constructor(options: DurableMaterialStoreOptions) {
    this.#database = options.database;
    this.#receipts = options.receipts;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => randomUUID());
    this.#uploadChunkSize = positiveInteger(
      options.uploadChunkSize ?? defaultUploadChunkSize,
      'uploadChunkSize',
    );
    this.#uploadConcurrency = positiveInteger(
      options.uploadConcurrency ?? defaultUploadConcurrency,
      'uploadConcurrency',
    );
    this.#uploadSessionLifetimeMs = positiveInteger(
      options.uploadSessionLifetimeMs ?? defaultUploadSessionLifetimeMs,
      'uploadSessionLifetimeMs',
    );
  }

  // ---------------------------------------------------------------- reads

  listMaterials(
    authenticated: AuthenticatedDevice,
    groupId: string,
    requestedPageSize: number,
    cursor: string,
  ): Promise<MaterialPage> {
    return this.listMaterialPage(authenticated, groupId, requestedPageSize, cursor, false);
  }

  listTrash(
    authenticated: AuthenticatedDevice,
    groupId: string,
    requestedPageSize: number,
    cursor: string,
  ): Promise<MaterialPage> {
    return this.listMaterialPage(authenticated, groupId, requestedPageSize, cursor, true);
  }

  async getMaterial(
    authenticated: AuthenticatedDevice,
    materialId: string,
  ): Promise<{
    readonly material: MaterialRecord;
    readonly currentVersion: MaterialVersionRecord | undefined;
  }> {
    const normalizedId = requireIdentifier(materialId, 'material_id');
    const rows = await this.query(
      sql(
        `${activeMemberPrologue},
         visible_material AS (
           SELECT material.*
           FROM materials AS material
           JOIN active_member ON active_member.group_id = material.group_id
           WHERE material.id = $3
         )
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           (SELECT ${materialJson('visible_material')} FROM visible_material) AS material,
           (
             SELECT ${versionJson('version')}
             FROM visible_material
             JOIN material_versions AS version
               ON version.id = visible_material.current_version_id
           ) AS version`,
        [authenticated.group.id, authenticated.device.id, normalizedId],
      ),
    );
    const row = requireOneRow(rows, 'Unable to read the material.');
    this.assertMember(row);
    const material = row.material;
    if (material === null || material === undefined) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The material does not exist.');
    }
    const version = row.version;
    return {
      material: toMaterial(readJsonObject(material, 'material')),
      currentVersion:
        version === null || version === undefined
          ? undefined
          : toVersion(readJsonObject(version, 'version')),
    };
  }

  async listVersions(
    authenticated: AuthenticatedDevice,
    materialId: string,
    requestedPageSize: number,
    cursor: string,
  ): Promise<MaterialVersionPage> {
    const normalizedId = requireIdentifier(materialId, 'material_id');
    const pageSize = boundPageSize(requestedPageSize, { defaultPageSize, maxPageSize });
    const decoded = decodeVersionCursor(cursor);
    const rows = await this.query(
      sql(
        `${activeMemberPrologue},
         owner_material AS (
           SELECT material.id
           FROM materials AS material
           JOIN active_member ON active_member.group_id = material.group_id
           WHERE material.id = $3
         ),
         matching AS MATERIALIZED (
           SELECT version.*
           FROM material_versions AS version
           JOIN owner_material ON owner_material.id = version.material_id
         ),
         page AS (
           SELECT matching.*
           FROM matching
           WHERE $5::bigint IS NULL OR matching.sequence < $5::bigint
           ORDER BY matching.sequence DESC
           LIMIT $4
         )
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           (SELECT COUNT(*) FROM matching) AS approximate_total,
           COALESCE(
             (
               SELECT jsonb_agg(${versionJson('page')} ORDER BY page.sequence DESC)
               FROM page
             ),
             '[]'::jsonb
           ) AS items`,
        [
          authenticated.group.id,
          authenticated.device.id,
          normalizedId,
          pageSize + 1,
          decoded === undefined ? null : decoded.toString(),
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to list material versions.');
    this.assertMember(row);
    const items = readJsonArray(row.items, 'items').map(toVersion);
    const hasMore = items.length > pageSize;
    const visible = hasMore ? items.slice(0, pageSize) : items;
    const last = visible.at(-1);
    return {
      items: visible,
      nextCursor: hasMore && last !== undefined ? encodeVersionCursor(last) : '',
      hasMore,
      approximateTotal: readBigInt(row.approximate_total, 'approximate_total'),
    };
  }

  async getUploadStatus(
    authenticated: AuthenticatedDevice,
    uploadId: string,
  ): Promise<UploadStatusOutcome> {
    const normalizedId = requireIdentifier(uploadId, 'upload_id');
    const rows = await this.query(
      sql(
        `${activeMemberPrologue},
         visible_session AS (
           SELECT session.*
           FROM upload_sessions AS session
           JOIN active_member ON active_member.group_id = session.group_id
           WHERE session.id = $3
         )
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           (SELECT ${sessionJson('visible_session')} FROM visible_session) AS session,
           COALESCE(
             (
               SELECT jsonb_agg(part.part_number ORDER BY part.part_number)
               FROM upload_parts AS part
               JOIN visible_session ON visible_session.id = part.upload_id
               WHERE part.completed_at IS NOT NULL
             ),
             '[]'::jsonb
           ) AS completed_parts`,
        [authenticated.group.id, authenticated.device.id, normalizedId],
      ),
    );
    const row = requireOneRow(rows, 'Unable to read the upload session.');
    this.assertMember(row);
    const session = row.session;
    if (session === null || session === undefined) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The upload session does not exist.');
    }
    return {
      session: toSession(readJsonObject(session, 'session')),
      completedParts: readNumberArray(row.completed_parts, 'completed_parts'),
    };
  }

  /**
   * Records the object store's multipart upload id against an open session.
   *
   * `BeginUpload` and `CreateMaterialVersion` open the multipart upload only
   * after the session row exists — the store decides deduplication first, and a
   * deduplicated upload needs no multipart at all — so the id arrives in this
   * one follow-up statement rather than as a column of the create. The write is
   * gated on `storage_upload_id IS NULL`, which makes it a no-op the second time:
   * a replayed `BeginUpload` reuses the id already recorded rather than opening
   * a second multipart, and this statement refuses to overwrite the first.
   *
   * Authorization is the same join every mutation uses — an active `EDITOR` or
   * `ADMIN` of the session's own group — re-derived here rather than trusted
   * from the caller, because an access token outlives a revocation.
   */
  async attachStorageUploadId(
    authenticated: AuthenticatedDevice,
    uploadId: string,
    storageUploadId: string,
  ): Promise<void> {
    const groupId = authenticated.group.id;
    const normalizedUploadId = requireIdentifier(uploadId, 'upload_id');
    const normalizedRemoteId = requireBoundedText(storageUploadId, 'storage_upload_id');
    const rows = await this.query(
      sql(
        `WITH editor AS MATERIALIZED (
           SELECT membership.group_id
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           WHERE membership.group_id = $1
             AND membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND membership.role IN ('EDITOR', 'ADMIN')
             AND devices.status <> 'REVOKED'
           FOR UPDATE OF membership
         ),
         attached AS (
           UPDATE upload_sessions AS session
           SET storage_upload_id = $4, updated_at = $3
           FROM editor
           WHERE session.id = $5
             AND session.group_id = editor.group_id
             AND session.storage_upload_id IS NULL
             AND session.state IN ('PENDING', 'UPLOADING', 'VERIFYING')
           RETURNING session.id
         )
         SELECT
           EXISTS (SELECT 1 FROM editor) AS editor_active,
           EXISTS (SELECT 1 FROM attached) AS attached`,
        [groupId, authenticated.device.id, this.#now(), normalizedRemoteId, normalizedUploadId],
      ),
    );
    const row = requireOneRow(rows, 'Unable to record the storage upload id.');
    this.assertEditor(row);
    if (!readBoolean(row.attached, 'attached')) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The upload session cannot record a storage upload id: it is closed or already carries one.',
      );
    }
  }

  /**
   * Resolves the bytes behind a material version, for a caller that is about to
   * mint a storage URL for them.
   *
   * The version is looked up through `materials`, so a version id belonging to
   * another group's material resolves to nothing rather than to a storage key.
   */
  async readObjectLocation(
    authenticated: AuthenticatedDevice,
    materialId: string,
    versionId: string | undefined,
  ): Promise<StoredObjectLocation> {
    const normalizedMaterialId = requireIdentifier(materialId, 'material_id');
    const normalizedVersionId =
      versionId === undefined || versionId.trim().length === 0
        ? null
        : requireIdentifier(versionId, 'version_id');
    const rows = await this.query(
      sql(
        `${activeMemberPrologue},
         visible_material AS (
           SELECT material.*
           FROM materials AS material
           JOIN active_member ON active_member.group_id = material.group_id
           WHERE material.id = $3
         ),
         resolved_version AS (
           SELECT version.*
           FROM material_versions AS version
           JOIN visible_material ON visible_material.id = version.material_id
           WHERE version.id = COALESCE($4::uuid, visible_material.current_version_id)
         )
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           EXISTS (SELECT 1 FROM visible_material) AS material_present,
           (
             SELECT jsonb_build_object(
               'material_id', resolved_version.material_id,
               'version_id', resolved_version.id,
               'content_hash', resolved_version.content_hash,
               'mime_type', resolved_version.mime_type,
               'byte_size', resolved_version.byte_size::text,
               'storage_key', object.storage_key
             )
             FROM resolved_version
             JOIN visible_material ON visible_material.id = resolved_version.material_id
             JOIN material_objects AS object
               ON object.group_id = visible_material.group_id
              AND object.content_hash = resolved_version.content_hash
           ) AS location`,
        [
          authenticated.group.id,
          authenticated.device.id,
          normalizedMaterialId,
          normalizedVersionId,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to read the material version.');
    this.assertMember(row);
    if (!readBoolean(row.material_present, 'material_present')) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The material does not exist.');
    }
    const location = row.location;
    if (location === null || location === undefined) {
      // A material whose upload never completed has no version and no stored
      // object. That is a precondition, not a missing resource: the caller may
      // retry once the upload finishes.
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The material has no stored version to grant access to.',
      );
    }
    const decoded = readJsonObject(location, 'location');
    return {
      materialId: readText(decoded.material_id, 'material_id'),
      versionId: readText(decoded.version_id, 'version_id'),
      storageKey: readText(decoded.storage_key, 'storage_key'),
      contentHash: readText(decoded.content_hash, 'content_hash'),
      mimeType: readText(decoded.mime_type, 'mime_type'),
      byteSize: readBigInt(decoded.byte_size, 'byte_size'),
    };
  }

  /**
   * The change feed behind `WatchMaterialEvents`.
   *
   * There is no material event table and no pub/sub in this deployment: the
   * control plane runs on a serverless HTTP driver with no `LISTEN`/`NOTIFY`
   * channel, and the realtime hub's `sync_events` log belongs to document
   * synchronization rather than to the library. What `materials` already has is
   * `updated_at` and an index on `(group_id, updated_at DESC)`, so the watch
   * cursor is that timestamp in milliseconds and the stream is a poll.
   *
   * Two consequences are deliberate and visible to clients. A purge cannot be
   * observed, because the row that would have carried the event is gone. And
   * several changes inside one millisecond are one cursor value, so the caller
   * receives the whole millisecond again on resume — at-least-once, never
   * silently lossy.
   */
  async readMaterialEvents(
    authenticated: AuthenticatedDevice,
    groupId: string,
    afterSequence: bigint,
    limit: number,
  ): Promise<readonly MaterialEventRecord[]> {
    const normalizedGroupId = requireIdentifier(groupId, 'group_id');
    this.assertAuthenticatedGroup(authenticated, normalizedGroupId);
    const batch = Math.min(Math.max(Math.trunc(limit), 1), maxWatchBatch);
    const rows = await this.query(
      sql(
        `${activeMemberPrologue}
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           COALESCE(
             (
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'material_id', changed.id,
                   'revision', changed.revision::text,
                   'created_at', changed.created_at,
                   'updated_at', changed.updated_at,
                   'trashed_at', changed.trashed_at,
                   'sequence', (EXTRACT(EPOCH FROM changed.updated_at) * 1000)::bigint::text
                 )
                 ORDER BY changed.updated_at ASC, changed.id ASC
               )
               FROM (
                 SELECT material.*
                 FROM materials AS material
                 CROSS JOIN active_member
                 WHERE material.group_id = active_member.group_id
                   AND (EXTRACT(EPOCH FROM material.updated_at) * 1000)::bigint >= $3::bigint
                 ORDER BY material.updated_at ASC, material.id ASC
                 LIMIT $4
               ) AS changed
             ),
             '[]'::jsonb
           ) AS events`,
        [authenticated.group.id, authenticated.device.id, afterSequence.toString(), batch],
      ),
    );
    const row = requireOneRow(rows, 'Unable to read material events.');
    this.assertMember(row);
    return readJsonArray(row.events, 'events').map(toMaterialEvent);
  }

  // ------------------------------------------------------------ mutations

  /**
   * Creates a material and reserves its bytes.
   *
   * The whole point of the statement is the `locked_object` CTE: whether the
   * group already holds `content_hash` decides the material's status, whether a
   * version exists immediately, whether an upload session has anything left to
   * do, and what the caller is told. Locking that row is what stops a
   * concurrent purge from deleting the object between the decision and the
   * reference this statement is about to add to it.
   */
  async beginUpload(
    authenticated: AuthenticatedDevice,
    input: BeginUploadInput,
    mutation?: MutationReceiptContext,
  ): Promise<BeginUploadOutcome> {
    const groupId = requireIdentifier(input.groupId, 'group_id');
    this.assertAuthenticatedGroup(authenticated, groupId);
    const displayName = requireBoundedText(input.displayName, 'display_name');
    const originalFileName = requireBoundedText(input.originalFileName, 'original_file_name');
    const mimeType = requireBoundedText(input.mimeType, 'mime_type');
    const contentHash = requireContentHash(input.contentHash);
    const totalSize = requireByteSize(input.totalSize);
    const metadata = requireMetadata(input.metadata ?? {});
    const materialId =
      input.materialId === undefined || input.materialId.trim().length === 0
        ? this.#newId()
        : requireIdentifier(input.materialId, 'material_id');
    const now = this.#now();
    const uploadId = this.#newId();
    const versionId = this.#newId();
    const chunkSize = chunkSizeFor(totalSize, this.#uploadChunkSize);
    const parts = planUploadParts(totalSize, chunkSize);
    const storageKey = storageKeyFor(groupId, contentHash);

    const receipt = await this.claim('BEGIN_MATERIAL_UPLOAD', mutation, now, [
      ['group_id', groupId],
      ['material_id', materialId],
      ['content_hash', contentHash],
      ['total_size', totalSize.toString()],
      ['display_name', displayName],
    ]);
    if (receipt?.claimed === false) return this.replayBeginUpload(authenticated, receipt);

    const rows = await this.query(
      sql(
        `${receiptGate},
         ${activeEditor},
         locked_object AS MATERIALIZED (
           -- The presence of this row is the deduplication decision. FOR UPDATE
           -- holds it so a concurrent purge cannot drop the object between the
           -- decision and the reference the next CTE adds to it.
           SELECT object.group_id, object.content_hash, object.storage_key, object.byte_size
           FROM material_objects AS object
           JOIN editor ON editor.group_id = object.group_id
           WHERE object.content_hash = $7
           FOR UPDATE OF object
         ),
         claimed_object AS (
           INSERT INTO material_objects (
             group_id, content_hash, byte_size, storage_key, reference_count, created_at
           )
           SELECT editor.group_id, $7, $8::bigint, COALESCE(existing.storage_key, $9), 1, $3
           FROM editor
           LEFT JOIN locked_object AS existing ON existing.group_id = editor.group_id
           ON CONFLICT (group_id, content_hash) DO UPDATE
             SET reference_count = material_objects.reference_count + 1
           RETURNING group_id, content_hash, storage_key
         ),
         inserted_material AS (
           INSERT INTO materials (
             id, group_id, display_name, category, mime_type, byte_size, content_hash,
             status, current_version_id, metadata, revision, created_at, updated_at
           )
           SELECT
             $6, claimed_object.group_id, $10, $11, $12,
             -- On the deduplicated path the size is the one the stored object
             -- already records, not the one the request declared. The bytes
             -- exist and their length is a fact; taking the caller's number let
             -- a second upload of the same content publish a material whose
             -- declared size did not match what a download would return.
             COALESCE((SELECT existing.byte_size FROM locked_object AS existing), $8::bigint),
             claimed_object.content_hash,
             CASE WHEN EXISTS (SELECT 1 FROM locked_object) THEN 'READY' ELSE 'UPLOADING' END,
             -- Written here rather than by a follow-up UPDATE: a second
             -- sub-statement cannot see the row this one inserts, and
             -- current_version_id has no foreign key to catch the mistake.
             CASE WHEN EXISTS (SELECT 1 FROM locked_object) THEN $13::uuid ELSE NULL END,
             $14::jsonb, 1, $3, $3
           FROM claimed_object
           RETURNING *
         ),
         inserted_version AS (
           INSERT INTO material_versions (
             id, material_id, sequence, content_hash, mime_type, byte_size,
             original_file_name, created_by_device_id, created_at
           )
           SELECT
             $13, inserted_material.id, inserted_material.revision,
             inserted_material.content_hash, inserted_material.mime_type,
             inserted_material.byte_size, $15, $2, $3
           FROM inserted_material
           WHERE EXISTS (SELECT 1 FROM locked_object)
           RETURNING *
         ),
         inserted_session AS (
           INSERT INTO upload_sessions (
             id, group_id, material_id, version_id, state, total_size, received_size,
             chunk_size, max_concurrency, expires_at, created_at, updated_at
           )
           SELECT
             $16, inserted_material.group_id, inserted_material.id,
             CASE WHEN EXISTS (SELECT 1 FROM locked_object) THEN $13::uuid ELSE NULL END,
             CASE WHEN EXISTS (SELECT 1 FROM locked_object) THEN 'COMPLETED' ELSE 'PENDING' END,
             $8::bigint,
             CASE WHEN EXISTS (SELECT 1 FROM locked_object) THEN $8::bigint ELSE 0 END,
             $17, $18, $19, $3, $3
           FROM inserted_material
           RETURNING *
         ),
         inserted_parts AS (
           INSERT INTO upload_parts (upload_id, part_number, offset_bytes, byte_length)
           SELECT inserted_session.id, part.part_number, part.offset_bytes, part.byte_length
           FROM inserted_session
           CROSS JOIN jsonb_to_recordset($20::jsonb)
             AS part(part_number integer, offset_bytes bigint, byte_length bigint)
           WHERE NOT EXISTS (SELECT 1 FROM locked_object)
           RETURNING part_number, offset_bytes, byte_length
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = inserted_session.group_id,
               resource_id = inserted_session.id,
               completed_at = $3
           FROM inserted_session
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM editor) AS editor_active,
           EXISTS (SELECT 1 FROM locked_object) AS deduplicated,
           (SELECT claimed_object.storage_key FROM claimed_object) AS storage_key,
           (SELECT ${materialJson('inserted_material')} FROM inserted_material) AS material,
           (SELECT ${sessionJson('inserted_session')} FROM inserted_session) AS session,
           COALESCE(
             (
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'part_number', inserted_parts.part_number,
                   'offset_bytes', inserted_parts.offset_bytes::text,
                   'byte_length', inserted_parts.byte_length::text
                 )
                 ORDER BY inserted_parts.part_number
               )
               FROM inserted_parts
             ),
             '[]'::jsonb
           ) AS parts`,
        [
          groupId,
          authenticated.device.id,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          materialId,
          contentHash,
          totalSize.toString(),
          storageKey,
          displayName,
          input.category,
          mimeType,
          versionId,
          JSON.stringify(metadata),
          originalFileName,
          uploadId,
          chunkSize,
          this.#uploadConcurrency,
          new Date(now.getTime() + this.#uploadSessionLifetimeMs),
          JSON.stringify(
            parts.map((part) => ({
              part_number: part.partNumber,
              offset_bytes: part.offset.toString(),
              byte_length: part.length.toString(),
            })),
          ),
        ],
      ),
    );

    const row = requireOneRow(rows, 'Unable to begin the material upload.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayBeginUpload(authenticated, receipt);
    }
    this.assertEditor(row);
    const material = row.material;
    const session = row.session;
    if (material === null || material === undefined || session === null || session === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The material upload could not be started.',
      );
    }
    return {
      material: toMaterial(readJsonObject(material, 'material')),
      session: toSession(readJsonObject(session, 'session')),
      parts: readJsonArray(row.parts, 'parts').map(toPart),
      storageKey: readText(row.storage_key, 'storage_key'),
      deduplicated: readBoolean(row.deduplicated, 'deduplicated'),
    };
  }

  /**
   * Records the version an upload produced.
   *
   * The session may have been opened by `BeginUpload`, which left `version_id`
   * NULL because no version existed yet, or by `CreateMaterialVersion`, which
   * already inserted one. Both shapes are completed here by the same statement:
   * the version is inserted only when the session has none, and
   * `materials.current_version_id` is set to whichever of the two ids is the
   * real one.
   */
  async completeUpload(
    authenticated: AuthenticatedDevice,
    uploadId: string,
    contentHash: string,
    parts: readonly CompletedUploadPartInput[],
    mutation?: MutationReceiptContext,
  ): Promise<{ readonly material: MaterialRecord; readonly version: MaterialVersionRecord }> {
    const normalizedUploadId = requireIdentifier(uploadId, 'upload_id');
    const normalizedHash = requireContentHash(contentHash);
    const completedParts = requireCompletedParts(parts);
    const now = this.#now();
    const versionId = this.#newId();

    const receipt = await this.claim('COMPLETE_MATERIAL_UPLOAD', mutation, now, [
      ['upload_id', normalizedUploadId],
      ['content_hash', normalizedHash],
      ['part_count', completedParts.length.toString()],
    ]);
    if (receipt?.claimed === false) return this.replayCompleteUpload(authenticated, receipt);

    const rows = await this.query(
      sql(
        `${receiptGate},
         ${activeEditor},
         locked_session AS MATERIALIZED (
           SELECT session.*
           FROM upload_sessions AS session
           JOIN editor ON editor.group_id = session.group_id
           WHERE session.id = $6
           FOR UPDATE OF session
         ),
         completable_session AS (
           SELECT locked_session.*
           FROM locked_session
           WHERE locked_session.state IN ('PENDING', 'UPLOADING', 'VERIFYING')
             AND locked_session.material_id IS NOT NULL
         ),
         locked_material AS MATERIALIZED (
           SELECT material.*
           FROM materials AS material
           JOIN completable_session ON completable_session.material_id = material.id
           FOR UPDATE OF material
         ),
         verified_material AS (
           -- The bytes the caller says it uploaded must be the bytes the
           -- material reserved. Without this the version would name content
           -- that no material_objects row accounts for, and the reference
           -- count would be protecting the wrong object.
           SELECT locked_material.*
           FROM locked_material
           WHERE locked_material.content_hash = $9
         ),
         completed_parts AS (
           UPDATE upload_parts AS part
           SET etag = supplied.etag,
               checksum = supplied.checksum,
               completed_at = $3
           FROM completable_session
           CROSS JOIN verified_material
           CROSS JOIN jsonb_to_recordset($7::jsonb)
             AS supplied(part_number integer, etag text, checksum text)
           WHERE part.upload_id = completable_session.id
             AND part.part_number = supplied.part_number
           RETURNING part.part_number
         ),
         finished_session AS (
           UPDATE upload_sessions AS session
           SET state = 'COMPLETED',
               received_size = session.total_size,
               version_id = COALESCE(session.version_id, $8::uuid),
               updated_at = $3
           FROM completable_session
           CROSS JOIN verified_material
           WHERE session.id = completable_session.id
           RETURNING session.id, session.material_id, session.version_id, session.total_size
         ),
         inserted_version AS (
           INSERT INTO material_versions (
             id, material_id, sequence, content_hash, mime_type, byte_size,
             original_file_name, created_by_device_id, created_at
           )
           SELECT
             $8, verified_material.id, verified_material.revision + 1, $9,
             verified_material.mime_type, completable_session.total_size,
             -- CompleteUploadRequest carries no file name, so the first
             -- version of a material records the name the material was created
             -- under. CreateMaterialVersion is where a later version gets one
             -- of its own.
             verified_material.display_name,
             $2, $3
           FROM verified_material
           CROSS JOIN completable_session
           WHERE completable_session.version_id IS NULL
           RETURNING *
         ),
         updated_material AS (
           UPDATE materials AS material
           SET status = 'READY',
               -- The pointer and the version are written by one statement
               -- because nothing in the schema relates them: current_version_id
               -- has no foreign key, so a follow-up update could leave it
               -- naming a version that was never inserted.
               current_version_id = COALESCE(completable_session.version_id, $8::uuid),
               revision = material.revision + 1,
               updated_at = $3
           FROM completable_session
           CROSS JOIN verified_material
           WHERE material.id = completable_session.material_id
           RETURNING material.*
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = updated_material.group_id,
               resource_id = finished_session.id,
               revision = updated_material.revision,
               completed_at = $3
           FROM updated_material
           CROSS JOIN finished_session
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM editor) AS editor_active,
           EXISTS (SELECT 1 FROM locked_session) AS session_present,
           EXISTS (SELECT 1 FROM completable_session) AS session_completable,
           EXISTS (SELECT 1 FROM verified_material) AS content_verified,
           (SELECT COUNT(*) FROM completed_parts) AS completed_part_count,
           (SELECT ${materialJson('updated_material')} FROM updated_material) AS material,
           (
             SELECT ${versionJson('version')}
             FROM finished_session
             JOIN material_versions AS version ON version.id = finished_session.version_id
           ) AS existing_version,
           (SELECT ${versionJson('inserted_version')} FROM inserted_version) AS inserted_version`,
        [
          authenticated.group.id,
          authenticated.device.id,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          normalizedUploadId,
          JSON.stringify(
            completedParts.map((part) => ({
              part_number: part.partNumber,
              etag: part.etag,
              checksum: part.checksum,
            })),
          ),
          versionId,
          normalizedHash,
        ],
      ),
    );

    const row = requireOneRow(rows, 'Unable to complete the material upload.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayCompleteUpload(authenticated, receipt);
    }
    this.assertEditor(row);
    if (!readBoolean(row.session_present, 'session_present')) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The upload session does not exist.');
    }
    if (!readBoolean(row.session_completable, 'session_completable')) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The upload session is no longer open for completion.',
      );
    }
    if (!readBoolean(row.content_verified, 'content_verified')) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'content_hash does not match the content this upload reserved.',
      );
    }
    const material = row.material;
    const version = row.inserted_version ?? row.existing_version;
    if (material === null || material === undefined || version === null || version === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The material upload could not be completed.',
      );
    }
    return {
      material: toMaterial(readJsonObject(material, 'material')),
      version: toVersion(readJsonObject(version, 'version')),
    };
  }

  async cancelUpload(
    authenticated: AuthenticatedDevice,
    uploadId: string,
    mutation?: MutationReceiptContext,
  ): Promise<{ readonly uploadId: string; readonly materialId: string | undefined }> {
    const normalizedUploadId = requireIdentifier(uploadId, 'upload_id');
    const now = this.#now();
    const receipt = await this.claim('CANCEL_MATERIAL_UPLOAD', mutation, now, [
      ['upload_id', normalizedUploadId],
    ]);
    if (receipt?.claimed === false) {
      const outcome = await this.resolveRefused(
        receipt,
        new PairedDeviceRuntimeError(
          'FAILED_PRECONDITION',
          'The upload session could not be cancelled.',
        ),
      );
      return {
        uploadId: requireRecordedResource(outcome.resourceId),
        materialId: undefined,
      };
    }

    const rows = await this.query(
      sql(
        `${receiptGate},
         ${activeEditor},
         locked_session AS MATERIALIZED (
           SELECT session.*
           FROM upload_sessions AS session
           JOIN editor ON editor.group_id = session.group_id
           WHERE session.id = $6
           FOR UPDATE OF session
         ),
         cancelled_session AS (
           UPDATE upload_sessions AS session
           SET state = 'CANCELLED', updated_at = $3
           FROM locked_session
           WHERE session.id = locked_session.id
             AND locked_session.state IN ('PENDING', 'UPLOADING', 'VERIFYING')
           RETURNING session.id, session.group_id, session.material_id
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = cancelled_session.group_id,
               resource_id = cancelled_session.id,
               completed_at = $3
           FROM cancelled_session
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM editor) AS editor_active,
           EXISTS (SELECT 1 FROM locked_session) AS session_present,
           (SELECT cancelled_session.id FROM cancelled_session) AS upload_id,
           (SELECT cancelled_session.material_id FROM cancelled_session) AS material_id`,
        [
          authenticated.group.id,
          authenticated.device.id,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          normalizedUploadId,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to cancel the material upload.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      const outcome = await this.resolveRefused(
        receipt,
        new PairedDeviceRuntimeError(
          'FAILED_PRECONDITION',
          'The upload session could not be cancelled.',
        ),
      );
      return { uploadId: requireRecordedResource(outcome.resourceId), materialId: undefined };
    }
    this.assertEditor(row);
    if (!readBoolean(row.session_present, 'session_present')) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The upload session does not exist.');
    }
    const cancelled = readOptionalText(row.upload_id);
    if (cancelled === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The upload session has already finished and cannot be cancelled.',
      );
    }
    return { uploadId: cancelled, materialId: readOptionalText(row.material_id) };
  }

  /**
   * Opens an upload for a new version of an existing material.
   *
   * The version sequence is the material revision this mutation produces, not
   * `MAX(sequence) + 1`. Under READ COMMITTED a waiting statement re-reads only
   * the row it locked, so a `MAX` subquery over `material_versions` would still
   * see the pre-wait snapshot and two concurrent callers would compute the same
   * number — `UNIQUE (material_id, sequence)` would then reject one of them.
   * `UPDATE materials SET revision = revision + 1` is re-evaluated against the
   * committed row instead, so the two callers get consecutive numbers and the
   * unique index never has to fire.
   *
   * Reference counting follows the material, not the version:
   * `material_objects.reference_count` is the number of materials naming those
   * bytes. Pointing a material at different content therefore releases the old
   * object and claims the new one here, both driven by the locked material row
   * so that a second concurrent version request sees the content hash the first
   * one already installed and does not claim the same object twice.
   */
  async createMaterialVersion(
    authenticated: AuthenticatedDevice,
    input: CreateMaterialVersionInput,
    mutation?: MutationReceiptContext,
  ): Promise<CreateMaterialVersionOutcome> {
    const groupId = requireIdentifier(input.groupId, 'group_id');
    this.assertAuthenticatedGroup(authenticated, groupId);
    const materialId = requireIdentifier(input.materialId, 'material_id');
    const originalFileName = requireBoundedText(input.originalFileName, 'original_file_name');
    const mimeType = requireBoundedText(input.mimeType, 'mime_type');
    const contentHash = requireContentHash(input.contentHash);
    const totalSize = requireByteSize(input.totalSize);
    const now = this.#now();
    const uploadId = this.#newId();
    const versionId = this.#newId();
    const chunkSize = chunkSizeFor(totalSize, this.#uploadChunkSize);
    const parts = planUploadParts(totalSize, chunkSize);
    const storageKey = storageKeyFor(groupId, contentHash);

    const receipt = await this.claim('CREATE_MATERIAL_VERSION', mutation, now, [
      ['group_id', groupId],
      ['material_id', materialId],
      ['content_hash', contentHash],
      ['total_size', totalSize.toString()],
      ['original_file_name', originalFileName],
    ]);
    if (receipt?.claimed === false) {
      return this.replayCreateMaterialVersion(authenticated, receipt);
    }

    const rows = await this.query(
      sql(
        `${materialMutationPrologue},
         eligible_material AS (
           -- Every CTE below reads this rather than locked_material. When the
           -- object bookkeeping was gated on the unfiltered lock, a version
           -- begun against a trashed material still moved reference counts
           -- while the material itself was left untouched, and nothing put them
           -- back.
           SELECT locked_material.*
           FROM locked_material
           WHERE locked_material.trashed_at IS NULL
         ),
         claimed_object AS (
           -- A reference is held by a *version row*, not by whichever content a
           -- material currently points at. So a new version always claims, even
           -- when it repeats the material's current hash, and the previous
           -- object is never released here: the version that referenced it is
           -- still listed, still restorable, and its bytes still have to exist.
           -- Releasing at this point deleted content while an upload of its
           -- replacement was still in flight.
           INSERT INTO material_objects (
             group_id, content_hash, byte_size, storage_key, reference_count, created_at
           )
           SELECT eligible_material.group_id, $7, $8::bigint, $9, 1, $3
           FROM eligible_material
           ON CONFLICT (group_id, content_hash) DO UPDATE
             SET reference_count = material_objects.reference_count + 1
           RETURNING group_id, content_hash, storage_key
         ),
         updated_material AS (
           UPDATE materials AS material
           SET status = 'UPLOADING',
               content_hash = $7,
               mime_type = $10,
               byte_size = $8::bigint,
               current_version_id = $11::uuid,
               revision = material.revision + 1,
               updated_at = $3
           FROM eligible_material
           JOIN claimed_object ON claimed_object.group_id = eligible_material.group_id
           WHERE material.id = eligible_material.id
           RETURNING material.*
         ),
         inserted_version AS (
           INSERT INTO material_versions (
             id, material_id, sequence, content_hash, mime_type, byte_size,
             original_file_name, created_by_device_id, created_at
           )
           SELECT
             $11, updated_material.id, updated_material.revision, $7, $10, $8::bigint,
             $12, $2, $3
           FROM updated_material
           RETURNING *
         ),
         inserted_session AS (
           INSERT INTO upload_sessions (
             id, group_id, material_id, version_id, state, total_size, received_size,
             chunk_size, max_concurrency, expires_at, created_at, updated_at
           )
           SELECT
             $13, updated_material.group_id, updated_material.id, inserted_version.id,
             'PENDING', $8::bigint, 0, $14, $15, $16, $3, $3
           FROM inserted_version
           JOIN updated_material ON updated_material.id = inserted_version.material_id
           RETURNING *
         ),
         inserted_parts AS (
           INSERT INTO upload_parts (upload_id, part_number, offset_bytes, byte_length)
           SELECT inserted_session.id, part.part_number, part.offset_bytes, part.byte_length
           FROM inserted_session
           CROSS JOIN jsonb_to_recordset($17::jsonb)
             AS part(part_number integer, offset_bytes bigint, byte_length bigint)
           RETURNING part_number, offset_bytes, byte_length
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = updated_material.group_id,
               resource_id = inserted_session.id,
               revision = updated_material.revision,
               completed_at = $3
           FROM updated_material
           CROSS JOIN inserted_session
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM editor) AS editor_active,
           EXISTS (SELECT 1 FROM locked_material) AS material_present,
           (SELECT COALESCE(claimed_object.storage_key, $9) FROM claimed_object) AS claimed_key,
           (SELECT ${materialJson('updated_material')} FROM updated_material) AS material,
           (SELECT ${versionJson('inserted_version')} FROM inserted_version) AS version,
           (SELECT ${sessionJson('inserted_session')} FROM inserted_session) AS session,
           COALESCE(
             (
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'part_number', inserted_parts.part_number,
                   'offset_bytes', inserted_parts.offset_bytes::text,
                   'byte_length', inserted_parts.byte_length::text
                 )
                 ORDER BY inserted_parts.part_number
               )
               FROM inserted_parts
             ),
             '[]'::jsonb
           ) AS parts`,
        [
          groupId,
          authenticated.device.id,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          materialId,
          contentHash,
          totalSize.toString(),
          storageKey,
          mimeType,
          versionId,
          originalFileName,
          uploadId,
          chunkSize,
          this.#uploadConcurrency,
          new Date(now.getTime() + this.#uploadSessionLifetimeMs),
          JSON.stringify(
            parts.map((part) => ({
              part_number: part.partNumber,
              offset_bytes: part.offset.toString(),
              byte_length: part.length.toString(),
            })),
          ),
        ],
      ),
    );

    const row = requireOneRow(rows, 'Unable to create the material version.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayCreateMaterialVersion(authenticated, receipt);
    }
    this.assertEditor(row);
    if (!readBoolean(row.material_present, 'material_present')) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The material does not exist.');
    }
    const material = row.material;
    const version = row.version;
    const session = row.session;
    if (
      material === null ||
      material === undefined ||
      version === null ||
      version === undefined ||
      session === null ||
      session === undefined
    ) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'A trashed material cannot receive a new version.',
      );
    }
    return {
      material: toMaterial(readJsonObject(material, 'material')),
      version: toVersion(readJsonObject(version, 'version')),
      session: toSession(readJsonObject(session, 'session')),
      parts: readJsonArray(row.parts, 'parts').map(toPart),
      storageKey: readOptionalText(row.claimed_key) ?? storageKey,
    };
  }

  /**
   * Replaces a material's descriptive fields and its whole tag set.
   *
   * Tags are group-scoped vocabulary (`material_tags`) with a composite foreign
   * key from the links, so a link can only name a tag the group already
   * declares. Both are written here: the vocabulary upsert and the link insert
   * are ordered by a data dependency rather than by hope, because the foreign
   * key is checked after the statement and would otherwise depend on the
   * planner's choice of CTE order.
   */
  async updateMaterialMetadata(
    authenticated: AuthenticatedDevice,
    input: UpdateMaterialMetadataInput,
    mutation?: MutationReceiptContext,
  ): Promise<{ readonly material: MaterialRecord }> {
    const groupId = requireIdentifier(input.groupId, 'group_id');
    this.assertAuthenticatedGroup(authenticated, groupId);
    const materialId = requireIdentifier(input.materialId, 'material_id');
    const displayName = requireBoundedText(input.displayName, 'display_name');
    const metadata = requireMetadata(input.metadata);
    const tags = requireTags(input.tags);
    const now = this.#now();

    const receipt = await this.claim('UPDATE_MATERIAL_METADATA', mutation, now, [
      ['group_id', groupId],
      ['material_id', materialId],
      ['display_name', displayName],
      ['category', input.category],
      ['metadata', JSON.stringify(metadata)],
      ['tags', JSON.stringify(tags)],
    ]);
    if (receipt?.claimed === false) return this.replayMaterial(authenticated, receipt);

    const rows = await this.query(
      sql(
        `${materialMutationPrologue},
         requested_tags AS (
           SELECT DISTINCT requested.value
           FROM jsonb_array_elements_text($9::jsonb) AS requested(value)
         ),
         upserted_tags AS (
           INSERT INTO material_tags (group_id, value, created_at)
           SELECT locked_material.group_id, requested_tags.value, $3
           FROM locked_material
           CROSS JOIN requested_tags
           ON CONFLICT (group_id, value) DO NOTHING
           RETURNING group_id, value
         ),
         unlinked_tags AS (
           DELETE FROM material_tag_links AS link
           USING locked_material
           WHERE link.material_id = locked_material.id
             AND NOT EXISTS (
               SELECT 1 FROM requested_tags WHERE requested_tags.value = link.tag_value
             )
           RETURNING link.tag_value
         ),
         linked_tags AS (
           INSERT INTO material_tag_links (material_id, group_id, tag_value)
           SELECT locked_material.id, locked_material.group_id, requested_tags.value
           FROM locked_material
           CROSS JOIN requested_tags
           -- The count is never read. It exists to make the vocabulary upsert a
           -- dependency of this insert, so the composite foreign key cannot be
           -- checked against a tag row the planner had not written yet.
           CROSS JOIN (SELECT COUNT(*) AS declared FROM upserted_tags) AS vocabulary
           ON CONFLICT (material_id, tag_value) DO NOTHING
           RETURNING tag_value
         ),
         updated_material AS (
           UPDATE materials AS material
           SET display_name = $7,
               category = $8,
               metadata = $10::jsonb,
               revision = material.revision + 1,
               updated_at = $3
           FROM locked_material
           WHERE material.id = locked_material.id
           RETURNING material.*
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = updated_material.group_id,
               resource_id = updated_material.id,
               revision = updated_material.revision,
               completed_at = $3
           FROM updated_material
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM editor) AS editor_active,
           EXISTS (SELECT 1 FROM locked_material) AS material_present,
           (SELECT COUNT(*) FROM linked_tags) AS linked_tag_count,
           (SELECT COUNT(*) FROM unlinked_tags) AS unlinked_tag_count,
           (
             SELECT ${materialJsonWithTags('updated_material', requestedTagsJson(9))}
             FROM updated_material
           ) AS material`,
        [
          groupId,
          authenticated.device.id,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          materialId,
          displayName,
          input.category,
          JSON.stringify(tags),
          JSON.stringify(metadata),
        ],
      ),
    );
    return {
      material: await this.readMutatedMaterial(
        authenticated,
        rows,
        receipt,
        'Unable to update the material metadata.',
      ),
    };
  }

  async moveToTrash(
    authenticated: AuthenticatedDevice,
    groupId: string,
    materialId: string,
    mutation?: MutationReceiptContext,
  ): Promise<{ readonly material: MaterialRecord }> {
    return {
      material: await this.setTrashState(
        authenticated,
        groupId,
        materialId,
        'TRASH_MATERIAL',
        mutation,
      ),
    };
  }

  async restoreMaterial(
    authenticated: AuthenticatedDevice,
    groupId: string,
    materialId: string,
    mutation?: MutationReceiptContext,
  ): Promise<{ readonly material: MaterialRecord }> {
    return {
      material: await this.setTrashState(
        authenticated,
        groupId,
        materialId,
        'RESTORE_MATERIAL',
        mutation,
      ),
    };
  }

  /**
   * Destroys a trashed material and releases its claim on the bytes.
   *
   * The release is two mutually exclusive branches over the same locked object
   * row: a decrement while other materials still name it, a delete when this
   * was the last one. They cannot both apply, because their conditions read the
   * same re-locked `reference_count`, and neither can drive the column below
   * zero — which the column's own `CHECK (reference_count >= 0)` would refuse
   * anyway.
   */
  async purgeMaterial(
    authenticated: AuthenticatedDevice,
    groupId: string,
    materialId: string,
    confirmation: string,
    mutation?: MutationReceiptContext,
  ): Promise<PurgedMaterial> {
    const normalizedGroupId = requireIdentifier(groupId, 'group_id');
    this.assertAuthenticatedGroup(authenticated, normalizedGroupId);
    const normalizedMaterialId = requireIdentifier(materialId, 'material_id');
    // A purge is the one mutation this service cannot undo, so it asks the
    // caller to name what they are destroying rather than accepting any
    // non-empty acknowledgement.
    if (confirmation.trim() !== normalizedMaterialId) {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        'confirmation must repeat the identifier of the material being purged.',
      );
    }
    const now = this.#now();
    const receipt = await this.claim('PURGE_MATERIAL', mutation, now, [
      ['group_id', normalizedGroupId],
      ['material_id', normalizedMaterialId],
    ]);
    if (receipt?.claimed === false) {
      const outcome = await this.resolveRefused(
        receipt,
        new PairedDeviceRuntimeError('FAILED_PRECONDITION', 'The material could not be purged.'),
      );
      return {
        materialId: requireRecordedResource(outcome.resourceId),
        revision: outcome.revision ?? 0n,
        objectRemoved: false,
      };
    }

    const rows = await this.query(
      sql(
        `${materialMutationPrologue},
         purgeable_material AS (
           SELECT locked_material.*
           FROM locked_material
           WHERE locked_material.trashed_at IS NOT NULL
         ),
         held_references AS (
           -- What this material actually holds, hash by hash. Releasing a
           -- single reference for the material's current content was wrong in
           -- both directions: a material with three versions of three contents
           -- held three references and stranded two objects for good, and a
           -- material still uploading its first version holds a reference no
           -- version row accounts for yet.
           SELECT held.content_hash, SUM(held.holds) AS holds
           FROM (
             SELECT versions.content_hash, COUNT(*)::bigint AS holds
             FROM material_versions AS versions
             JOIN purgeable_material ON purgeable_material.id = versions.material_id
             GROUP BY versions.content_hash
             UNION ALL
             -- A fresh upload claims its object at BeginUpload, before any
             -- version row exists; CompleteUpload is what turns that claim into
             -- a version. Purging in between has to release it all the same.
             SELECT purgeable_material.content_hash, 1::bigint AS holds
             FROM purgeable_material
             WHERE NOT EXISTS (
               SELECT 1
               FROM material_versions AS versions
               WHERE versions.material_id = purgeable_material.id
                 AND versions.content_hash = purgeable_material.content_hash
             )
           ) AS held
           GROUP BY held.content_hash
         ),
         locked_object AS MATERIALIZED (
           SELECT object.group_id, object.content_hash, object.reference_count
           FROM material_objects AS object
           JOIN purgeable_material ON purgeable_material.group_id = object.group_id
           JOIN held_references ON held_references.content_hash = object.content_hash
           FOR UPDATE OF object
         ),
         purged_material AS (
           DELETE FROM materials AS material
           USING purgeable_material
           WHERE material.id = purgeable_material.id
           RETURNING material.id, material.group_id, material.revision
         ),
         released_object AS (
           -- The decrement is refused rather than allowed to reach zero: the
           -- delete below is the only way a count leaves its last holder, so
           -- the column can never go negative even if both branches ran.
           UPDATE material_objects AS object
           SET reference_count = object.reference_count - held_references.holds
           FROM locked_object
           JOIN held_references ON held_references.content_hash = locked_object.content_hash
           WHERE object.group_id = locked_object.group_id
             AND object.content_hash = locked_object.content_hash
             AND locked_object.reference_count > held_references.holds
             AND EXISTS (SELECT 1 FROM purged_material)
           RETURNING object.content_hash
         ),
         dropped_object AS (
           DELETE FROM material_objects AS object
           USING locked_object
           JOIN held_references ON held_references.content_hash = locked_object.content_hash
           WHERE object.group_id = locked_object.group_id
             AND object.content_hash = locked_object.content_hash
             AND locked_object.reference_count <= held_references.holds
             AND EXISTS (SELECT 1 FROM purged_material)
           RETURNING object.content_hash
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = purged_material.group_id,
               resource_id = purged_material.id,
               revision = purged_material.revision,
               completed_at = $3
           FROM purged_material
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM editor) AS editor_active,
           EXISTS (SELECT 1 FROM locked_material) AS material_present,
           EXISTS (SELECT 1 FROM purgeable_material) AS material_purgeable,
           EXISTS (SELECT 1 FROM dropped_object) AS object_removed,
           (SELECT purged_material.id FROM purged_material) AS material_id,
           (SELECT purged_material.revision FROM purged_material) AS revision`,
        [
          normalizedGroupId,
          authenticated.device.id,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          normalizedMaterialId,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to purge the material.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      const outcome = await this.resolveRefused(
        receipt,
        new PairedDeviceRuntimeError('FAILED_PRECONDITION', 'The material could not be purged.'),
      );
      return {
        materialId: requireRecordedResource(outcome.resourceId),
        revision: outcome.revision ?? 0n,
        objectRemoved: false,
      };
    }
    this.assertEditor(row);
    if (!readBoolean(row.material_present, 'material_present')) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The material does not exist.');
    }
    if (!readBoolean(row.material_purgeable, 'material_purgeable')) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'Move the material to the trash before purging it.',
      );
    }
    return {
      materialId: readText(row.material_id, 'material_id'),
      revision: readBigInt(row.revision, 'revision'),
      objectRemoved: readBoolean(row.object_removed, 'object_removed'),
    };
  }

  // ------------------------------------------------------------- internals

  private async setTrashState(
    authenticated: AuthenticatedDevice,
    groupId: string,
    materialId: string,
    scope: Extract<MutationScope, 'TRASH_MATERIAL' | 'RESTORE_MATERIAL'>,
    mutation: MutationReceiptContext | undefined,
  ): Promise<MaterialRecord> {
    const normalizedGroupId = requireIdentifier(groupId, 'group_id');
    this.assertAuthenticatedGroup(authenticated, normalizedGroupId);
    const normalizedMaterialId = requireIdentifier(materialId, 'material_id');
    const trashing = scope === 'TRASH_MATERIAL';
    const now = this.#now();
    const receipt = await this.claim(scope, mutation, now, [
      ['group_id', normalizedGroupId],
      ['material_id', normalizedMaterialId],
    ]);
    if (receipt?.claimed === false) {
      return (await this.replayMaterial(authenticated, receipt)).material;
    }

    const rows = await this.query(
      sql(
        `${materialMutationPrologue},
         eligible_material AS (
           SELECT locked_material.*
           FROM locked_material
           WHERE (locked_material.trashed_at IS NULL) = $7::boolean
         ),
         updated_material AS (
           UPDATE materials AS material
           SET trashed_at = CASE WHEN $7::boolean THEN $3::timestamptz ELSE NULL END,
               -- A restored material returns to READY only if it has bytes to
               -- be ready with; one whose upload never finished goes back to
               -- UPLOADING rather than claiming a version it does not have.
               status = CASE
                 WHEN $7::boolean THEN 'TRASHED'
                 WHEN material.current_version_id IS NULL THEN 'UPLOADING'
                 ELSE 'READY'
               END,
               revision = material.revision + 1,
               updated_at = $3
           FROM eligible_material
           WHERE material.id = eligible_material.id
           RETURNING material.*
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = updated_material.group_id,
               resource_id = updated_material.id,
               revision = updated_material.revision,
               completed_at = $3
           FROM updated_material
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM editor) AS editor_active,
           EXISTS (SELECT 1 FROM locked_material) AS material_present,
           (SELECT ${materialJson('updated_material')} FROM updated_material) AS material`,
        [
          normalizedGroupId,
          authenticated.device.id,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          normalizedMaterialId,
          trashing,
        ],
      ),
    );
    return this.readMutatedMaterial(
      authenticated,
      rows,
      receipt,
      trashing
        ? 'The material is already in the trash.'
        : 'The material is not in the trash and cannot be restored.',
    );
  }

  private async listMaterialPage(
    authenticated: AuthenticatedDevice,
    groupId: string,
    requestedPageSize: number,
    cursor: string,
    trashed: boolean,
  ): Promise<MaterialPage> {
    const normalizedGroupId = requireIdentifier(groupId, 'group_id');
    this.assertAuthenticatedGroup(authenticated, normalizedGroupId);
    const pageSize = boundPageSize(requestedPageSize, { defaultPageSize, maxPageSize });
    const decoded = decodeMaterialCursor(cursor);
    const rows = await this.query(
      sql(
        `${activeMemberPrologue},
         matching AS MATERIALIZED (
           SELECT material.*
           FROM materials AS material
           JOIN active_member ON active_member.group_id = material.group_id
           WHERE (material.trashed_at IS NOT NULL) = $3::boolean
         ),
         page AS (
           SELECT matching.*
           FROM matching
           WHERE $5::timestamptz IS NULL
              OR (matching.updated_at, matching.id) < ($5::timestamptz, $6::uuid)
           ORDER BY matching.updated_at DESC, matching.id DESC
           LIMIT $4
         )
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           (SELECT COUNT(*) FROM matching) AS approximate_total,
           COALESCE(
             (
               SELECT jsonb_agg(
                 ${materialJson('page')} ORDER BY page.updated_at DESC, page.id DESC
               )
               FROM page
             ),
             '[]'::jsonb
           ) AS items`,
        [
          normalizedGroupId,
          authenticated.device.id,
          trashed,
          pageSize + 1,
          decoded?.updatedAt ?? null,
          decoded?.materialId ?? null,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to list materials.');
    this.assertMember(row);
    const items = readJsonArray(row.items, 'items').map(toMaterial);
    const hasMore = items.length > pageSize;
    const visible = hasMore ? items.slice(0, pageSize) : items;
    const last = visible.at(-1);
    return {
      items: visible,
      nextCursor: hasMore && last !== undefined ? encodeMaterialCursor(last) : '',
      hasMore,
      approximateTotal: readBigInt(row.approximate_total, 'approximate_total'),
    };
  }

  /** The shared tail of every mutation that answers with the material it changed. */
  private async readMutatedMaterial(
    authenticated: AuthenticatedDevice,
    rows: readonly Record<string, unknown>[],
    receipt: MutationReceiptClaim | undefined,
    ineligibleMessage: string,
  ): Promise<MaterialRecord> {
    const row = requireOneRow(rows, 'Unable to change the material.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return (await this.replayMaterial(authenticated, receipt)).material;
    }
    this.assertEditor(row);
    if (!readBoolean(row.material_present, 'material_present')) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The material does not exist.');
    }
    const material = row.material;
    if (material === null || material === undefined) {
      throw new PairedDeviceRuntimeError('FAILED_PRECONDITION', ineligibleMessage);
    }
    return toMaterial(readJsonObject(material, 'material'));
  }

  /**
   * Answers a retried mutation with the material its original run produced.
   *
   * The receipt records the identity of that row and nothing else, so the
   * material is read back as it stands now. That is deliberate: a retry asks
   * whether the mutation happened, and the honest answer is the current state
   * of the resource it created, not a replayed copy of a response body.
   */
  private async replayMaterial(
    authenticated: AuthenticatedDevice,
    receipt: MutationReceiptClaim,
  ): Promise<{ readonly material: MaterialRecord }> {
    const outcome = await this.resolveRefused(
      receipt,
      new PairedDeviceRuntimeError('FAILED_PRECONDITION', 'The material could not be changed.'),
    );
    const materialId = requireRecordedResource(outcome.resourceId);
    const replayed = await this.getMaterial(authenticated, materialId);
    return { material: replayed.material };
  }

  private async replayBeginUpload(
    authenticated: AuthenticatedDevice,
    receipt: MutationReceiptClaim,
  ): Promise<BeginUploadOutcome> {
    const outcome = await this.resolveRefused(
      receipt,
      new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The material upload could not be started.',
      ),
    );
    const uploadId = requireRecordedResource(outcome.resourceId);
    const status = await this.getUploadStatus(authenticated, uploadId);
    const materialId = status.session.materialId;
    if (materialId === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded upload no longer names a material and cannot be replayed.',
      );
    }
    const replayed = await this.getMaterial(authenticated, materialId);
    const parts = await this.readUploadParts(uploadId);
    return {
      material: replayed.material,
      session: status.session,
      parts,
      storageKey: storageKeyFor(replayed.material.groupId, replayed.material.contentHash),
      // A retry never re-deduplicates: the bytes were accounted for by the run
      // that owns this receipt, and reporting otherwise would invite the caller
      // to upload them a second time.
      deduplicated: parts.length === 0,
    };
  }

  private async replayCreateMaterialVersion(
    authenticated: AuthenticatedDevice,
    receipt: MutationReceiptClaim,
  ): Promise<CreateMaterialVersionOutcome> {
    const outcome = await this.resolveRefused(
      receipt,
      new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The material version could not be created.',
      ),
    );
    const uploadId = requireRecordedResource(outcome.resourceId);
    const status = await this.getUploadStatus(authenticated, uploadId);
    const materialId = status.session.materialId;
    const versionId = status.session.versionId;
    if (materialId === undefined || versionId === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded upload no longer names a version and cannot be replayed.',
      );
    }
    const replayed = await this.getMaterial(authenticated, materialId);
    const version = await this.readVersion(authenticated, versionId);
    return {
      material: replayed.material,
      version,
      session: status.session,
      parts: await this.readUploadParts(uploadId),
      storageKey: storageKeyFor(replayed.material.groupId, version.contentHash),
    };
  }

  private async replayCompleteUpload(
    authenticated: AuthenticatedDevice,
    receipt: MutationReceiptClaim,
  ): Promise<{ readonly material: MaterialRecord; readonly version: MaterialVersionRecord }> {
    const outcome = await this.resolveRefused(
      receipt,
      new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The material upload could not be completed.',
      ),
    );
    const uploadId = requireRecordedResource(outcome.resourceId);
    const status = await this.getUploadStatus(authenticated, uploadId);
    const materialId = status.session.materialId;
    const versionId = status.session.versionId;
    if (materialId === undefined || versionId === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded upload no longer names a version and cannot be replayed.',
      );
    }
    const replayed = await this.getMaterial(authenticated, materialId);
    return {
      material: replayed.material,
      version: await this.readVersion(authenticated, versionId),
    };
  }

  private async readVersion(
    authenticated: AuthenticatedDevice,
    versionId: string,
  ): Promise<MaterialVersionRecord> {
    const rows = await this.query(
      sql(
        `${activeMemberPrologue}
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           (
             SELECT ${versionJson('version')}
             FROM material_versions AS version
             JOIN materials AS material ON material.id = version.material_id
             JOIN active_member ON active_member.group_id = material.group_id
             WHERE version.id = $3
           ) AS version`,
        [authenticated.group.id, authenticated.device.id, versionId],
      ),
    );
    const row = requireOneRow(rows, 'Unable to read the material version.');
    this.assertMember(row);
    const version = row.version;
    if (version === null || version === undefined) {
      throw new PairedDeviceRuntimeError('NOT_FOUND', 'The material version does not exist.');
    }
    return toVersion(readJsonObject(version, 'version'));
  }

  private async readUploadParts(uploadId: string): Promise<readonly UploadPartRecord[]> {
    const rows = await this.query(
      sql(
        `SELECT part_number, offset_bytes::text AS offset_bytes, byte_length::text AS byte_length
         FROM upload_parts
         WHERE upload_id = $1 AND completed_at IS NULL
         ORDER BY part_number`,
        [uploadId],
      ),
    );
    return rows.map((row) => ({
      partNumber: Number(readBigInt(row.part_number, 'part_number')),
      offset: readBigInt(row.offset_bytes, 'offset_bytes'),
      length: readBigInt(row.byte_length, 'byte_length'),
    }));
  }

  private claim(
    scope: MutationScope,
    mutation: MutationReceiptContext | undefined,
    now: Date,
    fields: readonly (readonly [string, string])[],
  ): Promise<MutationReceiptClaim | undefined> {
    if (mutation === undefined) return Promise.resolve(undefined);
    return this.requireReceipts().claim(scope, mutation, now, fields);
  }

  private resolveRefused(
    receipt: MutationReceiptClaim,
    failure: PairedDeviceRuntimeError,
  ): ReturnType<MutationReceiptGuard['resolveRefused']> {
    return this.requireReceipts().resolveRefused(receipt, failure);
  }

  private requireReceipts(): MutationReceiptGuard {
    const guard = this.#receipts;
    if (guard === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'This control plane cannot answer retried material mutations: no receipt guard is configured.',
      );
    }
    return guard;
  }

  /**
   * A device's access token names exactly one group, so a request naming any
   * other is refused before it reaches a statement. The SQL re-checks
   * membership regardless; this only keeps the refusal legible.
   */
  private assertAuthenticatedGroup(authenticated: AuthenticatedDevice, groupId: string): void {
    if (authenticated.group.id !== groupId) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The authenticated device does not belong to the requested group.',
      );
    }
  }

  private assertMember(row: Record<string, unknown>): void {
    if (!readBoolean(row.member_active, 'member_active')) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The authenticated device is no longer an active member of the group.',
      );
    }
  }

  private assertEditor(row: Record<string, unknown>): void {
    if (!readBoolean(row.editor_active, 'editor_active')) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Only an active group editor can change the material library.',
      );
    }
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
 * Material-shaped keyset cursors.
 *
 * `durable-runtime.ts` has a pair of its own, over a device's creation instant
 * and identity. Sharing them would tie two unrelated orderings together: the
 * library is ordered newest-changed first, so its cursor carries `updated_at`
 * and descends, and a device cursor decoded here would silently produce a page
 * from the wrong end of the list.
 */
export function encodeMaterialCursor(material: MaterialRecord): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: material.updatedAt.toISOString(), materialId: material.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeMaterialCursor(
  cursor: string,
): { readonly updatedAt: Date; readonly materialId: string } | undefined {
  if (cursor.length === 0) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      !isRecord(decoded) ||
      typeof decoded.updatedAt !== 'string' ||
      typeof decoded.materialId !== 'string'
    ) {
      throw new Error('invalid cursor payload');
    }
    const updatedAt = new Date(decoded.updatedAt);
    if (Number.isNaN(updatedAt.getTime()) || decoded.materialId.length === 0) {
      throw new Error('invalid cursor values');
    }
    return { updatedAt, materialId: decoded.materialId };
  } catch {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'The page cursor is invalid.');
  }
}

/** Versions are ordered by their own per-material sequence, so the cursor is that number. */
export function encodeVersionCursor(version: MaterialVersionRecord): string {
  return Buffer.from(JSON.stringify({ sequence: version.sequence.toString() }), 'utf8').toString(
    'base64url',
  );
}

export function decodeVersionCursor(cursor: string): bigint | undefined {
  if (cursor.length === 0) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(decoded) || typeof decoded.sequence !== 'string') {
      throw new Error('invalid cursor payload');
    }
    if (!/^\d+$/u.test(decoded.sequence)) throw new Error('invalid cursor values');
    return BigInt(decoded.sequence);
  } catch {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'The page cursor is invalid.');
  }
}

/**
 * The object key a group's content hash maps to.
 *
 * It is derived rather than generated, so the same bytes in the same group
 * always address the same object even if two callers race to declare them.
 * `material_objects.storage_key` is globally unique, which the group prefix is
 * what guarantees.
 */
export function storageKeyFor(groupId: string, contentHash: string): string {
  return `materials/${groupId}/${contentHash}`;
}

/**
 * Splits a declared size into upload parts.
 *
 * The chunk size grows rather than the part count when a file is large, because
 * every object store bounds the number of parts in a multipart upload and none
 * of them bounds the size of one.
 */
export function planUploadParts(totalSize: bigint, chunkSize: number): readonly UploadPartRecord[] {
  const parts: UploadPartRecord[] = [];
  const chunk = BigInt(chunkSize);
  let offset = 0n;
  let partNumber = 1;
  while (offset < totalSize) {
    const length = totalSize - offset < chunk ? totalSize - offset : chunk;
    parts.push({ partNumber, offset, length });
    offset += length;
    partNumber += 1;
  }
  return parts;
}

function chunkSizeFor(totalSize: bigint, preferredChunkSize: number): number {
  const preferred = BigInt(preferredChunkSize);
  const cap = BigInt(maxUploadParts);
  if (totalSize <= preferred * cap) return preferredChunkSize;
  const required = (totalSize + cap - 1n) / cap;
  if (required > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      'total_size is larger than this service can accept.',
    );
  }
  return Number(required);
}

function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  return normalized;
}

function requireBoundedText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  if (normalized.length > maxDisplayNameLength) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `${field} must not exceed ${maxDisplayNameLength.toString()} characters.`,
    );
  }
  return normalized;
}

/**
 * The content hash is part of a storage key, so it is bounded and restricted to
 * characters that cannot escape a path segment. Without this a client could
 * name an object outside its own group's prefix.
 */
function requireContentHash(value: string): string {
  const normalized = value.trim();
  if (!contentHashPattern.test(normalized)) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      'content_hash must be 8 to 200 characters of letters, digits, and ":._-".',
    );
  }
  return normalized;
}

function requireByteSize(value: bigint): bigint {
  if (value < 0n) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'total_size must not be negative.');
  }
  return value;
}

function requireMetadata(
  metadata: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(metadata);
  if (entries.length > maxMetadataEntries) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `metadata must not exceed ${maxMetadataEntries.toString()} entries.`,
    );
  }
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > maxMetadataKeyLength) {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        `metadata keys must be 1 to ${maxMetadataKeyLength.toString()} characters.`,
      );
    }
    if (value.length > maxMetadataValueLength) {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        `metadata values must not exceed ${maxMetadataValueLength.toString()} characters.`,
      );
    }
  }
  return Object.fromEntries(entries);
}

function requireTags(tags: readonly string[]): readonly string[] {
  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
  if (normalized.length > maxTagCount) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `a material must not carry more than ${maxTagCount.toString()} tags.`,
    );
  }
  for (const tag of normalized) {
    if (tag.length > maxTagLength) {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        `a tag must not exceed ${maxTagLength.toString()} characters.`,
      );
    }
  }
  return normalized.sort();
}

function requireCompletedParts(
  parts: readonly CompletedUploadPartInput[],
): readonly CompletedUploadPartInput[] {
  const seen = new Set<number>();
  for (const part of parts) {
    if (!Number.isSafeInteger(part.partNumber) || part.partNumber < 1) {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        'every completed part must carry a positive part number.',
      );
    }
    if (seen.has(part.partNumber)) {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        'a completed part number must not be repeated.',
      );
    }
    seen.add(part.partNumber);
  }
  return parts;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function toMaterial(row: Record<string, unknown>): MaterialRecord {
  return {
    id: readText(row.id, 'id'),
    groupId: readText(row.group_id, 'group_id'),
    displayName: readText(row.display_name, 'display_name'),
    category: readCategory(row.category),
    mimeType: readText(row.mime_type, 'mime_type'),
    byteSize: readBigInt(row.byte_size, 'byte_size'),
    contentHash: readText(row.content_hash, 'content_hash'),
    status: readStatus(row.status),
    currentVersionId: readOptionalText(row.current_version_id),
    metadata: readStringMap(row.metadata, 'metadata'),
    tags: readStringArray(row.tags, 'tags'),
    revision: readBigInt(row.revision, 'revision'),
    createdAt: readDate(row.created_at, 'created_at'),
    updatedAt: readDate(row.updated_at, 'updated_at'),
    trashedAt: readOptionalDate(row.trashed_at, 'trashed_at'),
  };
}

function toVersion(row: Record<string, unknown>): MaterialVersionRecord {
  return {
    id: readText(row.id, 'id'),
    materialId: readText(row.material_id, 'material_id'),
    sequence: readBigInt(row.sequence, 'sequence'),
    contentHash: readText(row.content_hash, 'content_hash'),
    mimeType: readText(row.mime_type, 'mime_type'),
    byteSize: readBigInt(row.byte_size, 'byte_size'),
    originalFileName: readText(row.original_file_name, 'original_file_name'),
    createdAt: readDate(row.created_at, 'created_at'),
    createdByDeviceId: readOptionalText(row.created_by_device_id),
  };
}

function toSession(row: Record<string, unknown>): UploadSessionRecord {
  const storageUploadId = readOptionalText(row.storage_upload_id);
  return {
    id: readText(row.id, 'id'),
    groupId: readText(row.group_id, 'group_id'),
    materialId: readOptionalText(row.material_id),
    versionId: readOptionalText(row.version_id),
    state: readUploadState(row.state),
    totalSize: readBigInt(row.total_size, 'total_size'),
    receivedSize: readBigInt(row.received_size, 'received_size'),
    chunkSize: Number(readBigInt(row.chunk_size, 'chunk_size')),
    maxConcurrency: Number(readBigInt(row.max_concurrency, 'max_concurrency')),
    expiresAt: readDate(row.expires_at, 'expires_at'),
    ...(storageUploadId === undefined ? {} : { storageUploadId }),
  };
}

function toPart(row: Record<string, unknown>): UploadPartRecord {
  return {
    partNumber: Number(readBigInt(row.part_number, 'part_number')),
    offset: readBigInt(row.offset_bytes, 'offset_bytes'),
    length: readBigInt(row.byte_length, 'byte_length'),
  };
}

function toMaterialEvent(row: Record<string, unknown>): MaterialEventRecord {
  const createdAt = readDate(row.created_at, 'created_at');
  const updatedAt = readDate(row.updated_at, 'updated_at');
  const trashedAt = readOptionalDate(row.trashed_at, 'trashed_at');
  return {
    materialId: readText(row.material_id, 'material_id'),
    kind:
      trashedAt !== undefined
        ? 'TRASHED'
        : createdAt.getTime() === updatedAt.getTime()
          ? 'CREATED'
          : 'UPDATED',
    revision: readBigInt(row.revision, 'revision'),
    occurredAt: updatedAt,
    sequence: readBigInt(row.sequence, 'sequence'),
  };
}

function readCategory(value: unknown): MaterialCategoryName {
  const category = readText(value, 'category');
  switch (category) {
    case 'VIDEO':
    case 'CAMERA':
    case 'IMAGE':
    case 'AUDIO':
    case 'DOCUMENT':
    case 'MAP':
    case 'INTERCEPT':
    case 'DOSSIER':
    case 'REPORT':
    case 'ARCHIVE':
    case 'TECHNICAL':
    case 'OTHER':
    case 'UNSPECIFIED':
      return category;
    default:
      throw new Error('The database returned an invalid material category.');
  }
}

function readStatus(value: unknown): MaterialStatusName {
  const status = readText(value, 'status');
  switch (status) {
    case 'UPLOADING':
    case 'PROCESSING':
    case 'READY':
    case 'FAILED':
    case 'TRASHED':
    case 'QUARANTINED':
      return status;
    default:
      throw new Error('The database returned an invalid material status.');
  }
}

function readUploadState(value: unknown): UploadStateName {
  const state = readText(value, 'state');
  switch (state) {
    case 'PENDING':
    case 'UPLOADING':
    case 'VERIFYING':
    case 'COMPLETED':
    case 'CANCELLED':
    case 'FAILED':
      return state;
    default:
      throw new Error('The database returned an invalid upload state.');
  }
}

function readStringMap(value: unknown, field: string): Readonly<Record<string, string>> {
  const decoded = readJsonObject(value, field);
  const entries: [string, string][] = [];
  for (const [key, entry] of Object.entries(decoded)) {
    if (typeof entry !== 'string') {
      throw new Error(`The database returned an invalid ${field}.`);
    }
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}

function readStringArray(value: unknown, field: string): readonly string[] {
  const decoded = readJson(value, field);
  if (!Array.isArray(decoded) || !decoded.every((entry) => typeof entry === 'string')) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return decoded;
}

function readNumberArray(value: unknown, field: string): readonly number[] {
  const decoded = readJson(value, field);
  if (!Array.isArray(decoded) || !decoded.every((entry) => Number.isSafeInteger(entry))) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return decoded as readonly number[];
}

/** A receipt that recorded no resource cannot answer the retry it was written for. */
function requireRecordedResource(resourceId: string | undefined): string {
  if (resourceId === undefined) {
    throw new PairedDeviceRuntimeError(
      'FAILED_PRECONDITION',
      'The recorded mutation is missing resource_id and can no longer be replayed.',
    );
  }
  return resourceId;
}
