import type { SqlClient, SqlParameter } from '../db/database.js';
import type { MutationReceiptGuard } from '../sync/receipt-guard.js';
import type { MutationReceiptContext } from '../sync/receipts.js';
import {
  normalizeDatabaseError,
  readBigInt,
  readDate,
  readJsonArray,
  readJsonObject,
  readOptionalText,
  readText,
  sql,
} from '../sync/rows.js';
import { PairedDeviceRuntimeError } from '../sync/runtime.js';

import {
  requireAddressableScope,
  type SettingsActor,
  type SettingsScopeKind,
  type SettingsScopeRef,
} from './store.js';

/**
 * The `layout_documents` / `layout_versions` adapter.
 *
 * Both tables were created by migration 0001 and, until this module, reached by
 * no code at all — correction C32 measured that and named the reason: no RPC of
 * the contract could fill them. `PublishDocumentDelta` with
 * `SYNCHRONIZED_DOCUMENT_TYPE_LAYOUT` carries a CRDT delta, and merging one into
 * `layout_documents.layout jsonb NOT NULL` needs an engine this process does not
 * depend on, so that method records the delta in `sync_snapshots` and relays it.
 * The alternative C32 named is what this is: a whole-document put.
 *
 * Three decisions are worth stating once here rather than at each call site.
 *
 * **A layout is one row per scope and screen**, addressed by the partial unique
 * indexes migration 0008 created — `(group_id, screen_id)` for a group's
 * arrangement and `(device_id, screen_id)` for a device's own. They are the
 * `ON CONFLICT` targets the put infers, which is what makes two concurrent puts
 * of one screen produce revisions N and N+1 instead of two documents.
 *
 * **The whole arrangement is written, and the expected revision is checked
 * inside the same statement.** A whole-document put with no compare is a
 * lost-update generator; a compare made by reading first and writing second is
 * the read-then-write race this package refuses everywhere. The check therefore
 * lives in the `ON CONFLICT DO UPDATE ... WHERE` predicate, which PostgreSQL
 * evaluates against the row the upsert has already locked.
 *
 * **A version row records the resulting tiles, not a patch.** `ListLayoutHistory`
 * reads them back, and a future revert would be a single statement over one of
 * them rather than a replay of every later delta.
 *
 * Nothing is written to `history_events`: that table is the settings history
 * `ListSettingsHistory` pages by `scope`, and a layout row carrying the same
 * scope name would surface inside it as a settings change that never happened.
 * `layout_versions` is the layout's own log, which is exactly what it was
 * created for.
 */

export interface LayoutTilePlacementInput {
  readonly tileId: string;
  readonly column: number;
  readonly row: number;
  readonly columnSpan: number;
  readonly rowSpan: number;
  readonly hidden: boolean;
}

export interface LayoutDocumentRecord {
  readonly id: string;
  readonly scope: SettingsScopeRef;
  readonly screenId: string;
  readonly tiles: readonly LayoutTilePlacementInput[];
  readonly revision: bigint;
  readonly updatedAt: Date;
}

export interface LayoutHistoryEntryRecord {
  readonly revision: bigint;
  readonly tiles: readonly LayoutTilePlacementInput[];
  readonly actorDeviceId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface LayoutHistoryPage {
  readonly entries: readonly LayoutHistoryEntryRecord[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export interface PutLayoutDocumentInput {
  readonly actor: SettingsActor;
  readonly scope: SettingsScopeRef;
  readonly screenId: string;
  readonly tiles: readonly LayoutTilePlacementInput[];
  /** Zero means "whatever is stored"; any other value must be the stored revision. */
  readonly expectedRevision: bigint;
  readonly correlationId: string;
  readonly mutation?: MutationReceiptContext;
}

export interface ReadLayoutDocumentInput {
  readonly actor: SettingsActor;
  readonly scope: SettingsScopeRef;
  readonly screenId: string;
}

export interface ListLayoutHistoryInput extends ReadLayoutDocumentInput {
  readonly pageSize: number;
  readonly cursor: string;
}

export interface LayoutStore {
  putDocument(input: PutLayoutDocumentInput): Promise<LayoutDocumentRecord>;
  readDocument(input: ReadLayoutDocumentInput): Promise<LayoutDocumentRecord | undefined>;
  listHistory(input: ListLayoutHistoryInput): Promise<LayoutHistoryPage>;
}

export interface DurableLayoutStoreOptions {
  readonly database: SqlClient;
  /**
   * Shared with every other store rather than built here: one request identifier
   * has to mean the same thing whichever service received it, and a put that
   * replaces an operator's arrangement is destructive to a revision the caller
   * cannot restore.
   */
  readonly receipts: MutationReceiptGuard;
  readonly now?: () => Date;
  readonly defaultHistoryPageSize?: number;
  readonly maxHistoryPageSize?: number;
}

export const defaultLayoutHistoryPageSize = 50;
export const maxLayoutHistoryPageSize = 200;

/** The longest `screen_id` a layout may name; `layout_documents.screen_id` is free text. */
export const maxScreenIdLength = 120;
/** A bound on one document, so a single put cannot make an unbounded row. */
export const maxLayoutTiles = 256;
export const maxTileIdLength = 120;
/** The bounded grid `@gremuchaya/layout-engine` packs; a coordinate outside it draws nowhere. */
export const maxLayoutGridExtent = 4096;

/** Rearranging the group's wall is an editorial act; arranging one's own screen is not. */
const groupWriterRoles = JSON.stringify(['EDITOR', 'ADMIN']);
const anyActiveRoles = JSON.stringify(['VIEWER', 'EDITOR', 'ADMIN']);

interface LayoutScopeShape {
  /** The `group_id, device_id` pair of a written row, taken from the actor CTE. */
  readonly identityColumns: string;
  /** The partial unique index migration 0008 created for this shape. */
  readonly conflictTarget: string;
  /** Ties an existing layout row to the authorized actor. */
  matchActor(alias: string): string;
  documentGroupId(actor: SettingsActor): string | null;
  documentDeviceId(actor: SettingsActor): string | null;
}

const groupShape: LayoutScopeShape = {
  identityColumns: 'authorized_actor.group_id, NULL::uuid',
  conflictTarget: '(group_id, screen_id) WHERE group_id IS NOT NULL AND device_id IS NULL',
  matchActor: (alias) =>
    `${alias}.group_id = authorized_actor.group_id AND ${alias}.device_id IS NULL`,
  // The actor's own group, never the one the request named. `requireAddressableScope`
  // refuses a foreign scope before the statement runs, and taking the identity
  // from the membership CTE makes the statement itself unable to reach one.
  documentGroupId: (actor) => actor.groupId,
  documentDeviceId: () => null,
};

const deviceShape: LayoutScopeShape = {
  identityColumns: 'NULL::uuid, authorized_actor.device_id',
  // The device index is not partial on `group_id`, so a row that filled both
  // columns would sit in it too. Writing `group_id` as NULL keeps a device
  // layout in exactly one index, which is what makes the conflict target
  // deterministic.
  conflictTarget: '(device_id, screen_id) WHERE device_id IS NOT NULL',
  matchActor: (alias) =>
    `${alias}.device_id = authorized_actor.device_id AND ${alias}.group_id IS NULL`,
  documentGroupId: () => null,
  documentDeviceId: (actor) => actor.deviceId,
};

function shapeOf(scope: SettingsScopeRef): LayoutScopeShape {
  if (scope.kind === 'GROUP') return groupShape;
  if (scope.kind === 'DEVICE') return deviceShape;
  throw new PairedDeviceRuntimeError(
    'PERMISSION_DENIED',
    'Only a group or a device arranges a screen; factory and theme scopes hold no layout.',
  );
}

/**
 * The prologue every layout mutation shares, in the same parameter order the
 * settings spine uses so one reader can compare them line by line:
 *
 * - `$1` receipt scope, or NULL when the caller opted out of retries
 * - `$2` receipt request-id hash, or NULL
 * - `$3` acting group id
 * - `$4` acting device id
 * - `$5` the roles that may perform this mutation, as a JSON array
 * - `$6` screen id
 * - `$7` the tiles, as a JSON array
 * - `$8` the mutation instant
 * - `$9` correlation id
 * - `$10` the expected revision, as text; `0` means unconditional
 */
const layoutMutationPrologue = `WITH locked_receipt AS MATERIALIZED (
           -- The claim was committed by its own statement, so the row is
           -- visible here. FOR UPDATE holds it for the duration of this
           -- mutation, which serializes concurrent retries of one request
           -- identifier.
           SELECT receipt.request_id_hash
           FROM mutation_receipts AS receipt
           WHERE receipt.scope = $1
             AND receipt.request_id_hash = $2
             AND receipt.completed_at IS NULL
           FOR UPDATE OF receipt
         ),
         mutation_gate AS MATERIALIZED (
           SELECT 1 AS open FROM locked_receipt
           UNION ALL
           SELECT 1 AS open WHERE $2::text IS NULL
         ),
         authorized_actor AS MATERIALIZED (
           -- Authorization is re-derived here rather than trusted from the
           -- caller: an access token stays valid for its lifetime, and a device
           -- revoked a moment ago must not be able to rearrange the wall. The
           -- row identity below comes from this CTE, not from a parameter, so a
           -- caller cannot address one group's layout while proving membership
           -- in another.
           SELECT membership.group_id, membership.device_id
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           CROSS JOIN mutation_gate
           WHERE membership.group_id = $3
             AND membership.device_id = $4
             AND membership.revoked_at IS NULL
             AND membership.role IN (SELECT jsonb_array_elements_text($5::jsonb))
             AND devices.status <> 'REVOKED'
           FOR UPDATE OF membership
         )`;

export class DurableLayoutStore implements LayoutStore {
  readonly #database: SqlClient;
  readonly #receipts: MutationReceiptGuard;
  readonly #now: () => Date;
  readonly #defaultPageSize: number;
  readonly #maxPageSize: number;

  constructor(options: DurableLayoutStoreOptions) {
    this.#database = options.database;
    this.#receipts = options.receipts;
    this.#now = options.now ?? (() => new Date());
    this.#defaultPageSize = options.defaultHistoryPageSize ?? defaultLayoutHistoryPageSize;
    this.#maxPageSize = options.maxHistoryPageSize ?? maxLayoutHistoryPageSize;
  }

  /**
   * Writes the whole arrangement of one screen, in one statement.
   *
   * The document row, its version row and the receipt completion are CTEs of the
   * same statement because the `SqlClient` has no interactive transaction to
   * hold them together: a put that committed without its version row would
   * leave a revision the history cannot explain, and one that completed its
   * receipt without the write would answer a retry with a document nobody wrote.
   */
  async putDocument(input: PutLayoutDocumentInput): Promise<LayoutDocumentRecord> {
    const shape = shapeOf(input.scope);
    // The statement writes the actor's own row whatever the request named, so
    // without this a caller aiming at another group would quietly rearrange its
    // own screen and be told it succeeded.
    requireAddressableScope(input.actor, input.scope);
    const screenId = requireScreenId(input.screenId);
    const tiles = normalizeTiles(input.tiles);
    const expectedRevision = requireExpectedRevision(input.expectedRevision);
    const encodedTiles = JSON.stringify(tiles);
    const now = this.#now();

    const receipt = await this.#receipts.claim('PUT_LAYOUT_DOCUMENT', input.mutation, now, [
      ['group_id', input.actor.groupId],
      ['actor_device_id', input.actor.deviceId],
      ['scope_type', input.scope.kind],
      ['screen_id', screenId],
      ['expected_revision', expectedRevision.toString()],
      ['tiles', encodedTiles],
    ]);
    if (receipt?.claimed === false) return this.replayDocument(receipt, input.scope, screenId);

    const statement = `${layoutMutationPrologue},
         written AS (
           INSERT INTO layout_documents (
             id, group_id, device_id, screen_id, layout, revision, updated_at
           )
           SELECT gen_random_uuid(), ${shape.identityColumns}, $6,
                  jsonb_build_object('tiles', $7::jsonb), 1, $8
           FROM authorized_actor
           -- A caller that named a revision is creating nothing: the row it
           -- claims to have edited must already exist at that revision. The
           -- conflict predicate below re-decides this against the locked row;
           -- this one only keeps the insert branch from minting revision 1 for
           -- a screen the caller believed it was updating.
           WHERE $10::bigint = 0
              OR EXISTS (
                   SELECT 1
                   FROM layout_documents AS existing
                   WHERE ${shape.matchActor('existing')}
                     AND existing.screen_id = $6
                     AND existing.revision = $10::bigint
                 )
           ON CONFLICT ${shape.conflictTarget} DO UPDATE
             SET layout = EXCLUDED.layout,
                 -- The revision is derived from the row the upsert just locked,
                 -- never from a value this process read earlier. That is what
                 -- makes two concurrent puts produce N and N+1.
                 revision = layout_documents.revision + 1,
                 updated_at = EXCLUDED.updated_at
             -- The lost-update guard. PostgreSQL evaluates this against the
             -- locked existing row, so a put whose expected revision was
             -- overtaken between the client's read and this statement writes
             -- nothing and is refused, instead of discarding the arrangement
             -- the other device just published.
             WHERE $10::bigint = 0 OR layout_documents.revision = $10::bigint
           RETURNING id, group_id, device_id, screen_id, layout, revision, updated_at
         ),
         recorded_version AS (
           -- Exactly one version row per put, at the revision the write just
           -- produced. UNIQUE (document_id, revision) is what stops two
           -- concurrent writers from both claiming it.
           INSERT INTO layout_versions (
             id, document_id, revision, patch, actor_device_id, correlation_id, created_at
           )
           SELECT gen_random_uuid(), written.id, written.revision,
                  jsonb_build_object('tiles', $7::jsonb), $4, $9, $8
           FROM written
           RETURNING revision
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = $3,
               resource_id = written.id,
               revision = written.revision,
               completed_at = $8
           FROM written
           WHERE receipt.scope = $1
             AND receipt.request_id_hash = $2
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM authorized_actor) AS actor_active,
           (SELECT written.id FROM written) AS id,
           (SELECT written.group_id FROM written) AS group_id,
           (SELECT written.device_id FROM written) AS device_id,
           (SELECT written.screen_id FROM written) AS screen_id,
           (SELECT written.layout FROM written) AS layout,
           -- Cast to text because a bigint reaches this process as whatever the
           -- driver decides, and a revision rounded through a double is a
           -- corrupted document.
           (SELECT written.revision::text FROM written) AS revision,
           (SELECT written.updated_at FROM written) AS updated_at`;

    const rows = await this.query(
      sql(statement, [
        receipt?.scope ?? null,
        receipt?.requestIdHash ?? null,
        input.actor.groupId,
        input.actor.deviceId,
        input.scope.kind === 'GROUP' ? groupWriterRoles : anyActiveRoles,
        screenId,
        encodedTiles,
        now,
        input.correlationId,
        expectedRevision.toString(),
      ] satisfies readonly SqlParameter[]),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The layout mutation produced no result.',
      );
    }
    if (receipt !== undefined && row.receipt_claimed !== true) {
      return this.replayDocument(receipt, input.scope, screenId);
    }
    if (row.actor_active !== true) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Only an active member of the group with a sufficient role can change this layout.',
      );
    }
    if (row.id === null || row.id === undefined) {
      // The actor was authorized and nothing was written, so the expected
      // revision is the only thing that can have refused the write. The message
      // names the condition rather than the stored revision: reporting the
      // current number here would answer a request that was denied.
      throw new PairedDeviceRuntimeError(
        'ABORTED',
        'This screen has been rearranged since the revision the request names.',
      );
    }
    return toLayoutDocument(row, input.scope.kind);
  }

  /**
   * Reads one screen's arrangement, or nothing.
   *
   * The reader's membership is re-checked in the same statement for the same
   * reason a writer's is: a revoked device holding a live access token must not
   * keep reading the group it was removed from.
   */
  async readDocument(input: ReadLayoutDocumentInput): Promise<LayoutDocumentRecord | undefined> {
    const shape = shapeOf(input.scope);
    requireAddressableScope(input.actor, input.scope);
    const screenId = requireScreenId(input.screenId);
    const rows = await this.query(
      sql(
        `SELECT
           document.id,
           document.group_id,
           document.device_id,
           document.screen_id,
           document.layout,
           document.revision::text AS revision,
           document.updated_at
         FROM layout_documents AS document
         WHERE document.screen_id = $3
           AND document.group_id IS NOT DISTINCT FROM $4::uuid
           AND document.device_id IS NOT DISTINCT FROM $5::uuid
           AND EXISTS (
             SELECT 1
             FROM group_memberships AS membership
             JOIN devices ON devices.id = membership.device_id
             WHERE membership.group_id = $1
               AND membership.device_id = $2
               AND membership.revoked_at IS NULL
               AND devices.status <> 'REVOKED'
           )`,
        [
          input.actor.groupId,
          input.actor.deviceId,
          screenId,
          shape.documentGroupId(input.actor),
          shape.documentDeviceId(input.actor),
        ],
      ),
    );
    const row = rows[0];
    return row === undefined ? undefined : toLayoutDocument(row, input.scope.kind);
  }

  /**
   * Reads the screen's recorded revisions, newest first, by keyset.
   *
   * The cursor is the revision itself rather than an offset: revisions are
   * unique per document and strictly increasing, so a page boundary keeps
   * meaning the same row after a put has landed underneath it.
   */
  async listHistory(input: ListLayoutHistoryInput): Promise<LayoutHistoryPage> {
    const shape = shapeOf(input.scope);
    requireAddressableScope(input.actor, input.scope);
    const screenId = requireScreenId(input.screenId);
    const pageSize = this.boundedPageSize(input.pageSize);
    const cursor = decodeHistoryCursor(input.cursor);
    const rows = await this.query(
      sql(
        `SELECT
           version.revision::text AS revision,
           version.patch,
           version.actor_device_id,
           version.correlation_id,
           version.created_at
         FROM layout_versions AS version
         JOIN layout_documents AS document ON document.id = version.document_id
         WHERE document.screen_id = $3
           AND document.group_id IS NOT DISTINCT FROM $4::uuid
           AND document.device_id IS NOT DISTINCT FROM $5::uuid
           AND ($6::bigint IS NULL OR version.revision < $6::bigint)
           AND EXISTS (
             SELECT 1
             FROM group_memberships AS membership
             JOIN devices ON devices.id = membership.device_id
             WHERE membership.group_id = $1
               AND membership.device_id = $2
               AND membership.revoked_at IS NULL
               AND devices.status <> 'REVOKED'
           )
         ORDER BY version.revision DESC
         -- One extra row is the cheapest honest answer to "is there more": a
         -- COUNT would be a second statement over a table that only grows.
         LIMIT $7`,
        [
          input.actor.groupId,
          input.actor.deviceId,
          screenId,
          shape.documentGroupId(input.actor),
          shape.documentDeviceId(input.actor),
          cursor === undefined ? null : cursor.toString(),
          pageSize + 1,
        ],
      ),
    );
    const hasMore = rows.length > pageSize;
    const entries = rows.slice(0, pageSize).map(toHistoryEntry);
    const last = entries.at(-1);
    return {
      entries,
      hasMore,
      nextCursor: hasMore && last !== undefined ? encodeHistoryCursor(last.revision) : '',
    };
  }

  /**
   * Answers a retried put with the document its original attempt produced.
   *
   * The tiles come from the version row at the recorded revision rather than
   * from the document as it stands now: a later put may have moved it on, and
   * returning that would tell the caller its own request produced an
   * arrangement it never sent.
   */
  private async replayDocument(
    receipt: Parameters<MutationReceiptGuard['resolveRefused']>[0],
    scope: SettingsScopeRef,
    screenId: string,
  ): Promise<LayoutDocumentRecord> {
    const outcome = await this.#receipts.resolveRefused(
      receipt,
      new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The layout mutation produced no result.',
      ),
    );
    if (outcome.resourceId === undefined || outcome.revision === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded layout mutation is missing its document and cannot be replayed.',
      );
    }
    const rows = await this.query(
      sql(
        `SELECT
           document.id,
           document.group_id,
           document.device_id,
           document.screen_id,
           version.patch AS layout,
           version.revision::text AS revision,
           version.created_at AS updated_at
         FROM layout_versions AS version
         JOIN layout_documents AS document ON document.id = version.document_id
         WHERE version.document_id = $1 AND version.revision = $2::bigint`,
        [outcome.resourceId, outcome.revision.toString()],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded layout mutation is no longer retained and cannot be replayed.',
      );
    }
    const replayed = toLayoutDocument(row, scope.kind);
    if (replayed.screenId !== screenId) {
      // The receipt identity is the request id, and its fingerprint already
      // covers the screen; a stored document for another screen would mean the
      // guard resolved a different request, which must not be answered as this
      // one's success.
      throw new PairedDeviceRuntimeError(
        'ALREADY_EXISTS',
        'The mutation request identifier was already used for another screen.',
      );
    }
    return replayed;
  }

  private boundedPageSize(requested: number): number {
    if (!Number.isInteger(requested) || requested <= 0) return this.#defaultPageSize;
    return Math.min(requested, this.#maxPageSize);
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
 * Bounds and de-duplicates the arrangement before it becomes a row.
 *
 * A tile named twice is not a merge problem — it is two answers to "where is
 * this tile" — so the last one wins and the document holds one placement per
 * tile. The bounds exist because `layout_documents.layout` is `jsonb` with no
 * shape of its own: without them one request could store an arbitrarily large
 * document that every later read would have to carry.
 */
export function normalizeTiles(
  tiles: readonly LayoutTilePlacementInput[],
): readonly LayoutTilePlacementInput[] {
  if (tiles.length > maxLayoutTiles) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `A layout must not carry more than ${maxLayoutTiles.toString()} tiles.`,
    );
  }
  const byTile = new Map<string, LayoutTilePlacementInput>();
  for (const tile of tiles) {
    const tileId = tile.tileId.trim();
    if (tileId.length === 0) {
      throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'A layout tile must name a tile id.');
    }
    if (tileId.length > maxTileIdLength) {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        `A layout tile id must not exceed ${maxTileIdLength.toString()} characters.`,
      );
    }
    byTile.set(tileId, {
      tileId,
      column: requireExtent(tile.column, 'column'),
      row: requireExtent(tile.row, 'row'),
      columnSpan: requireSpan(tile.columnSpan, 'column_span'),
      rowSpan: requireSpan(tile.rowSpan, 'row_span'),
      hidden: tile.hidden,
    });
  }
  return [...byTile.values()];
}

function requireExtent(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > maxLayoutGridExtent) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `${field} must be between 0 and ${maxLayoutGridExtent.toString()}.`,
    );
  }
  return value;
}

function requireSpan(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > maxLayoutGridExtent) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `${field} must be between 1 and ${maxLayoutGridExtent.toString()}.`,
    );
  }
  return value;
}

function requireScreenId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'screen_id must not be empty.');
  }
  if (normalized.length > maxScreenIdLength) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `screen_id must not exceed ${maxScreenIdLength.toString()} characters.`,
    );
  }
  return normalized;
}

function requireExpectedRevision(value: bigint): bigint {
  if (value < 0n) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      'expected_revision must not be negative.',
    );
  }
  return value;
}

function toLayoutDocument(
  row: Record<string, unknown>,
  kind: SettingsScopeKind,
): LayoutDocumentRecord {
  const resourceId =
    kind === 'GROUP' ? readOptionalText(row.group_id) : readOptionalText(row.device_id);
  return {
    id: readText(row.id, 'id'),
    scope: { kind, ...(resourceId === undefined ? {} : { resourceId }) },
    screenId: readText(row.screen_id, 'screen_id'),
    tiles: readTiles(row.layout),
    revision: readBigInt(row.revision, 'revision'),
    updatedAt: readDate(row.updated_at, 'updated_at'),
  };
}

function toHistoryEntry(row: Record<string, unknown>): LayoutHistoryEntryRecord {
  return {
    revision: readBigInt(row.revision, 'revision'),
    tiles: readTiles(row.patch),
    actorDeviceId: readOptionalText(row.actor_device_id) ?? '',
    correlationId: readOptionalText(row.correlation_id) ?? '',
    occurredAt: readDate(row.created_at, 'created_at'),
  };
}

/**
 * Reads the stored `{tiles: [...]}` back.
 *
 * Every field is re-derived rather than trusted: the column is `jsonb`, so a row
 * written by a future build — or by hand — can hold anything, and a placement
 * with a missing coordinate must not reach a screen as `undefined`.
 */
function readTiles(value: unknown): readonly LayoutTilePlacementInput[] {
  const document = readJsonObject(value, 'layout');
  const tiles = document.tiles === undefined ? [] : readJsonArray(document.tiles, 'tiles');
  return tiles.map((entry) => ({
    // The stored keys are this module's own field names: `normalizeTiles`
    // produces the objects and `JSON.stringify` writes them, so the document is
    // never a re-encoding of the wire message and no name mapping is involved.
    tileId: typeof entry.tileId === 'string' ? entry.tileId : '',
    column: readNumber(entry.column),
    row: readNumber(entry.row),
    columnSpan: readNumber(entry.columnSpan),
    rowSpan: readNumber(entry.rowSpan),
    hidden: entry.hidden === true,
  }));
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The cursor carries the revision, so a page boundary names an exact row. */
export function encodeHistoryCursor(revision: bigint): string {
  return Buffer.from(`layout:${revision.toString()}`, 'utf8').toString('base64url');
}

function decodeHistoryCursor(cursor: string): bigint | undefined {
  if (cursor.trim().length === 0) return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^layout:(\d+)$/u.exec(decoded);
  if (match?.[1] === undefined) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      'The layout history page cursor is not one this service issued.',
    );
  }
  return BigInt(match[1]);
}
