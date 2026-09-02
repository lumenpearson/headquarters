import type { SqlClient, SqlParameter } from '../db/database.js';
import type { MutationReceiptClaim, MutationReceiptGuard } from '../sync/receipt-guard.js';
import type { FingerprintField, MutationReceiptContext, MutationScope } from '../sync/receipts.js';
import {
  isRecord,
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

/**
 * The `settings_documents` / `settings_versions` / `history_events` adapter.
 *
 * Three decisions in here are not obvious from the tables, so they are stated
 * once at the top rather than repeated at every call site.
 *
 * **A scope is one row, addressed by a partial unique index.** `SettingsScope`
 * carries a single `resource_id`, while `settings_documents` has both
 * `group_id` and `device_id`. `FACTORY` and `THEME` leave both NULL, `GROUP`
 * fills `group_id`, `DEVICE` fills `device_id`. Migration 0008 created one
 * partial unique index per shape precisely because NULLs do not collide in a
 * plain unique index, and those indexes are the `ON CONFLICT` targets every
 * write here infers. `LOCAL_DRAFT` and `SESSION_PREVIEW` fill neither column
 * and are not `FACTORY`/`THEME`, so a row for them would violate the table's
 * own CHECK; they are refused with `INVALID_ARGUMENT` instead of being given an
 * invented table. They are client-side states by definition — a draft that
 * never left the machine and a preview that dies with the session — so there is
 * nothing for the server to store.
 *
 * **A draft is the same scope under a draft `scope_type`.** `scope_type` is
 * free text and carries no CHECK, so `GROUP_DRAFT` and `DEVICE_DRAFT` are
 * addressable by the very same partial unique indexes as `GROUP` and `DEVICE`:
 * `(scope_type, group_id)` and `(scope_type, device_id)` already include the
 * discriminator. This needs no migration and keeps a draft under the same
 * cascade as the effective document it belongs to.
 *
 * **A version row records the resulting values, not only the patch.**
 * `settings_versions.patch` stores `{operation, operations, values}`. The
 * `values` half is what makes `RevertSettingsVersion` a single statement: the
 * Neon HTTP driver has no interactive transaction, so a revert that had to read
 * a revision and then replay every later patch would be a read-then-write and
 * therefore a race.
 */

/** The scopes that have a server-side home. */
export type SettingsScopeKind = 'FACTORY' | 'THEME' | 'GROUP' | 'DEVICE';

export interface SettingsScopeRef {
  readonly kind: SettingsScopeKind;
  /** Present exactly for `GROUP` and `DEVICE`; the shared scopes address no resource. */
  readonly resourceId?: string;
}

/** Who is acting, as the authenticated session named them. */
export interface SettingsActor {
  readonly groupId: string;
  readonly deviceId: string;
}

/**
 * Setting values as stored: a map from setting path to the protobuf-JSON form
 * of `common.v1.SettingValue`. The canonical JSON encoding is used rather than
 * a hand-rolled one so a value round-trips through the database exactly as the
 * client sent it, including the `int64`-as-string and `bytes`-as-base64 rules.
 */
export type SettingsValueMap = Readonly<Record<string, unknown>>;

export interface SettingsDocumentRecord {
  readonly id: string;
  readonly scope: SettingsScopeRef;
  readonly draft: boolean;
  readonly schemaVersion: string;
  readonly values: SettingsValueMap;
  readonly revision: bigint;
  readonly updatedAt: Date;
}

export interface SettingsPatchOperationInput {
  readonly path: string;
  /** The protobuf-JSON form of `common.v1.SettingValue`; absent for a removal. */
  readonly value?: unknown;
  readonly remove: boolean;
}

/**
 * What a mutation did, written to both `settings_versions.patch->>'operation'`
 * and `history_events.operation`. It is a closed set rather than free text so
 * `WatchSettings` can map a stored revision back onto a `SettingsEventKind`
 * without guessing.
 */
export type SettingsOperation =
  | 'APPLY_DRAFT_PATCH'
  | 'DISCARD_DRAFT'
  | 'PUBLISH_DRAFT'
  | 'RESET_CATEGORY'
  | 'RESET_ELEMENT'
  | 'RESET_ALL'
  | 'IMPORT_SETTINGS'
  | 'REVERT_SETTINGS_VERSION';

export interface SettingsHistoryEntryRecord {
  readonly id: string;
  readonly scope: SettingsScopeRef;
  readonly category: string;
  readonly elementId: string;
  readonly operation: string;
  readonly operations: readonly SettingsPatchOperationInput[];
  readonly revision: bigint;
  readonly actorDeviceId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface SettingsHistoryPage {
  readonly entries: readonly SettingsHistoryEntryRecord[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

/** One observed revision change, as `WatchSettings` reports it. */
export interface SettingsChange {
  readonly document: SettingsDocumentRecord;
  readonly operation: SettingsOperation | undefined;
  readonly correlationId: string;
}

export interface ReadDocumentsInput {
  readonly actor: SettingsActor;
  readonly scopes: readonly SettingsScopeRef[];
  readonly includeDraft: boolean;
}

interface MutationInput {
  readonly actor: SettingsActor;
  readonly scope: SettingsScopeRef;
  readonly schemaVersion: string;
  readonly correlationId: string;
  readonly mutation?: MutationReceiptContext;
}

export interface ApplyDraftPatchInput extends MutationInput {
  readonly operations: readonly SettingsPatchOperationInput[];
}

export type DraftInput = MutationInput;

export interface ResetInput extends MutationInput {
  readonly mode: 'CATEGORY' | 'ELEMENT' | 'ALL';
  /** The category for `CATEGORY`, the setting path for `ELEMENT`, empty for `ALL`. */
  readonly target: string;
}

export interface ImportInput extends MutationInput {
  readonly values: SettingsValueMap;
}

export interface RevertInput extends MutationInput {
  readonly targetRevision: bigint;
}

export interface ListHistoryInput {
  readonly actor: SettingsActor;
  readonly scope: SettingsScopeRef;
  readonly pageSize: number;
  readonly cursor: string;
}

export interface PollChangesInput {
  readonly actor: SettingsActor;
  readonly scope: SettingsScopeRef;
  readonly afterRevision: bigint;
}

export interface SettingsStore {
  readDocuments(input: ReadDocumentsInput): Promise<readonly SettingsDocumentRecord[]>;
  applyDraftPatch(input: ApplyDraftPatchInput): Promise<SettingsDocumentRecord>;
  discardDraft(input: DraftInput): Promise<SettingsDocumentRecord>;
  publishDraft(input: DraftInput): Promise<SettingsDocumentRecord>;
  reset(input: ResetInput): Promise<SettingsDocumentRecord>;
  importDocument(input: ImportInput): Promise<SettingsDocumentRecord>;
  revertVersion(input: RevertInput): Promise<SettingsDocumentRecord>;
  listHistory(input: ListHistoryInput): Promise<SettingsHistoryPage>;
  pollChanges(input: PollChangesInput): Promise<readonly SettingsChange[]>;
}

export interface DurableSettingsStoreOptions {
  readonly database: SqlClient;
  /**
   * The receipt guard the paired-device runtime already configured. It is
   * required rather than optional because every mutation here is destructive to
   * a revision the caller cannot restore, and a second claim statement is the
   * one thing that could make two retries of one request disagree about whether
   * they are retries.
   */
  readonly receipts: MutationReceiptGuard;
  readonly now?: () => Date;
  /** How many history entries one page may carry when the caller names no size. */
  readonly defaultHistoryPageSize?: number;
  readonly maxHistoryPageSize?: number;
}

export const defaultHistoryPageSize = 50;
export const maxHistoryPageSize = 200;

/** The default schema version stamped on a document a mutation has to create. */
export const unknownSchemaVersion = 'unknown';

/**
 * Every mutation writes this into `history_events.origin`. The column exists so
 * a reader can tell an operator action taken through the control plane from one
 * a shoot-day machine performed locally and synchronized later.
 */
const historyOrigin = 'CONTROL_PLANE';

/**
 * `category` and `element_id` describe a single setting, so a patch that spans
 * several categories has no one category to name. It records this instead of an
 * arbitrary member, which would make the group history read as though only one
 * category had changed.
 */
export const manyCategories = '*';

/** Changing group-wide settings is an editorial act; reading them is not. */
const groupWriterRoles = JSON.stringify(['EDITOR', 'ADMIN']);
/**
 * A device's own settings are its personalization, so a viewer may change them.
 * The membership join still has to match, which is what keeps a revoked device
 * from writing anything at all.
 */
const anyActiveRoles = JSON.stringify(['VIEWER', 'EDITOR', 'ADMIN']);

/**
 * The SQL spine every settings mutation shares.
 *
 * Parameter positions are fixed so a mutation can add its own without
 * renumbering the spine:
 *
 * - `$1` receipt scope, or NULL when the caller opted out of retries
 * - `$2` receipt request-id hash, or NULL
 * - `$3` acting group id
 * - `$4` acting device id
 * - `$5` the roles that may perform this mutation, as a JSON array
 * - `$6` the `scope_type` of the row being written
 * - `$7` schema version
 * - `$8` the mutation instant
 * - `$9` operation name
 * - `$10` the patch operations, as a JSON array
 * - `$11` correlation id
 * - `$12` history category
 * - `$13` history element id, or NULL
 * - `$14` the addressed scope name, for history
 * - `$15` onwards: whatever the mutation itself needs
 */
export const firstSettingsMutationParameter = 15;

const settingsMutationPrologue = `WITH locked_receipt AS MATERIALIZED (
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
           -- revoked a moment ago must not be able to write a setting. The row
           -- identity below is taken from this CTE, not from a parameter, so a
           -- caller cannot address one group's document while proving
           -- membership in another.
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

const settingsMutationEpilogue = `,
         recorded_version AS (
           -- Exactly one version row per mutation, at the revision the write
           -- just produced. UNIQUE (document_id, revision) is what stops two
           -- concurrent writers from both claiming it.
           INSERT INTO settings_versions (
             id, document_id, revision, patch, actor_device_id, correlation_id, created_at
           )
           SELECT gen_random_uuid(), written.id, written.revision,
                  jsonb_build_object(
                    -- jsonb_build_object accepts "any", which tells the planner
                    -- nothing about a bare parameter; without the cast
                    -- PostgreSQL cannot decide its type at all.
                    'operation', $9::text,
                    'operations', $10::jsonb,
                    'values', COALESCE(written.document -> 'values', '{}'::jsonb)
                  ),
                  $4, $11, $8
           FROM written
           RETURNING revision
         ),
         recorded_history AS (
           -- The history row rides the same statement as the write. Appending
           -- it afterwards would mean a mutation could commit while its history
           -- entry did not, and R29's group history would be missing exactly
           -- the changes that mattered most.
           INSERT INTO history_events (
             id, group_id, device_id, scope, category, element_id,
             operation, patch, revision, correlation_id, origin, occurred_at
           )
           SELECT gen_random_uuid(), $3, $4, $14, $12, $13,
                  $9, $10::jsonb, written.revision, $11, '${historyOrigin}', $8
           FROM written
           RETURNING id
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
         )`;

/**
 * The projection every settings mutation returns.
 *
 * It is built from scalar subqueries so the statement yields a row even when
 * the gate is shut; the replay path reads `receipt_claimed` explicitly rather
 * than inferring a retry from an empty result. `revision` is cast to text
 * because a `bigint` reaches this process as whatever the driver decides, and
 * a revision silently rounded through a double is a corrupted document.
 */
function settingsMutationProjection(sourcePresent: string): string {
  return `SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM authorized_actor) AS actor_active,
           ${sourcePresent} AS source_present,
           (SELECT written.id FROM written) AS id,
           (SELECT written.group_id FROM written) AS group_id,
           (SELECT written.device_id FROM written) AS device_id,
           (SELECT written.scope_type FROM written) AS scope_type,
           (SELECT written.schema_version FROM written) AS schema_version,
           (SELECT written.document FROM written) AS document,
           (SELECT written.revision::text FROM written) AS revision,
           (SELECT written.updated_at FROM written) AS updated_at`;
}

interface ScopeShape {
  /** The `group_id, device_id` pair of a written row, taken from the actor CTE. */
  readonly identityColumns: string;
  /** The partial unique index migration 0008 created for this shape. */
  readonly conflictTarget: string;
  /** Ties an existing document row to the authorized actor. */
  matchActor(alias: string): string;
  /** The scope's identity as `readDocuments` and `pollChanges` address it. */
  documentGroupId(actor: SettingsActor, scope: SettingsScopeRef): string | null;
  documentDeviceId(actor: SettingsActor, scope: SettingsScopeRef): string | null;
}

const groupShape: ScopeShape = {
  identityColumns: 'authorized_actor.group_id, NULL::uuid',
  conflictTarget: '(scope_type, group_id) WHERE group_id IS NOT NULL AND device_id IS NULL',
  matchActor: (alias) =>
    `${alias}.group_id = authorized_actor.group_id AND ${alias}.device_id IS NULL`,
  // The actor's own group, never the one the request named. A bearer token
  // names exactly one group, so a scope naming another is not addressable by
  // this caller; `requireAddressableScope` refuses it before the statement runs
  // and this makes the statement itself unable to reach it either.
  documentGroupId: (actor) => actor.groupId,
  documentDeviceId: () => null,
};

const deviceShape: ScopeShape = {
  identityColumns: 'NULL::uuid, authorized_actor.device_id',
  conflictTarget: '(scope_type, device_id) WHERE device_id IS NOT NULL AND group_id IS NULL',
  matchActor: (alias) =>
    `${alias}.device_id = authorized_actor.device_id AND ${alias}.group_id IS NULL`,
  documentGroupId: () => null,
  documentDeviceId: (actor) => actor.deviceId,
};

const sharedShape: ScopeShape = {
  // Never used for a write: `FACTORY` and `THEME` are read-only over RPC.
  identityColumns: 'NULL::uuid, NULL::uuid',
  conflictTarget: '(scope_type) WHERE group_id IS NULL AND device_id IS NULL',
  matchActor: (alias) => `${alias}.group_id IS NULL AND ${alias}.device_id IS NULL`,
  documentGroupId: () => null,
  documentDeviceId: () => null,
};

/**
 * Refuses a scope the caller cannot address.
 *
 * `SettingsScope` carries one resource id and a bearer token names exactly one
 * group and one device, so a request naming anything else is asking for a
 * document it has no claim to. Reading was the gap: every mutation already
 * projected its identity from the authorized membership CTE, but the read path
 * bound the requested id straight into the statement and proved only that the
 * caller was active in its *own* group — which any legitimate device is.
 *
 * Silently substituting the caller's own scope would be worse than refusing:
 * the client would believe it had read the group it asked for.
 *
 * Exported so `DurableLayoutStore` applies this exact rule rather than a second
 * copy of it: a layout is addressed by the same `SettingsScope`, and two
 * implementations of one scope check are how a corrected rule stays corrected in
 * only one of them.
 */
export function requireAddressableScope(actor: SettingsActor, scope: SettingsScopeRef): void {
  const requested = scope.resourceId?.trim();
  if (requested === undefined || requested.length === 0) return;
  if (scope.kind === 'GROUP' && requested !== actor.groupId) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      "The authenticated device cannot address another group's settings.",
    );
  }
  if (scope.kind === 'DEVICE' && requested !== actor.deviceId) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      "The authenticated device cannot address another device's settings.",
    );
  }
}

function shapeOf(scope: SettingsScopeRef): ScopeShape {
  if (scope.kind === 'GROUP') return groupShape;
  if (scope.kind === 'DEVICE') return deviceShape;
  return sharedShape;
}

/**
 * The `scope_type` a draft of this scope occupies.
 *
 * A draft is a row of the same scope shape under a different discriminator, so
 * it lands in the same partial unique index and cascades with the same parent.
 */
export function draftScopeType(kind: SettingsScopeKind): string {
  return `${kind}_DRAFT`;
}

export function effectiveScopeType(kind: SettingsScopeKind): string {
  return kind;
}

/**
 * The category a setting path belongs to is its first segment: `appearance` in
 * `appearance.theme`. The control plane holds no descriptor table, so the path
 * is the only category evidence a mutation carries; deriving it here keeps
 * `ResetCategory` from needing a schema the deployment may not have.
 */
export function categoryOfPath(path: string): string {
  const separator = path.indexOf('.');
  return separator === -1 ? path : path.slice(0, separator);
}

export class DurableSettingsStore implements SettingsStore {
  readonly #database: SqlClient;
  readonly #receipts: MutationReceiptGuard;
  readonly #now: () => Date;
  readonly #defaultPageSize: number;
  readonly #maxPageSize: number;

  constructor(options: DurableSettingsStoreOptions) {
    this.#database = options.database;
    this.#receipts = options.receipts;
    this.#now = options.now ?? (() => new Date());
    this.#defaultPageSize = options.defaultHistoryPageSize ?? defaultHistoryPageSize;
    this.#maxPageSize = options.maxHistoryPageSize ?? maxHistoryPageSize;
  }

  /**
   * Reads every requested scope in one statement.
   *
   * The scopes arrive as a JSON array joined against the table rather than as a
   * generated `IN` list, because `GetEffectiveSettings` asks for four scopes of
   * three different shapes at once and issuing four round trips would let the
   * group document move between two of them.
   */
  async readDocuments(input: ReadDocumentsInput): Promise<readonly SettingsDocumentRecord[]> {
    for (const scope of input.scopes) requireAddressableScope(input.actor, scope);
    const wanted = input.scopes.flatMap((scope) => {
      const shape = shapeOf(scope);
      const identity = {
        group_id: shape.documentGroupId(input.actor, scope),
        device_id: shape.documentDeviceId(input.actor, scope),
      };
      const rows = [{ ...identity, scope_type: effectiveScopeType(scope.kind) }];
      // A draft exists only for the two addressable scopes; `FACTORY` and
      // `THEME` are configuration and are never edited through this service.
      if (input.includeDraft && (scope.kind === 'GROUP' || scope.kind === 'DEVICE')) {
        rows.push({ ...identity, scope_type: draftScopeType(scope.kind) });
      }
      return rows;
    });
    if (wanted.length === 0) return [];

    const rows = await this.query(
      sql(
        `SELECT
           document.id,
           document.group_id,
           document.device_id,
           document.scope_type,
           document.schema_version,
           document.document,
           document.revision::text AS revision,
           document.updated_at
         FROM settings_documents AS document
         JOIN jsonb_array_elements($3::jsonb) AS wanted(entry)
           ON document.scope_type = wanted.entry ->> 'scope_type'
          AND document.group_id IS NOT DISTINCT FROM (wanted.entry ->> 'group_id')::uuid
          AND document.device_id IS NOT DISTINCT FROM (wanted.entry ->> 'device_id')::uuid
         -- The reader's membership is re-checked in the same statement for the
         -- same reason a writer's is: a revoked device holding a live access
         -- token must not keep reading the group it was removed from.
         WHERE EXISTS (
           SELECT 1
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           WHERE membership.group_id = $1
             AND membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND devices.status <> 'REVOKED'
         )`,
        [input.actor.groupId, input.actor.deviceId, JSON.stringify(wanted)],
      ),
    );
    return rows.map(toDocumentRecord);
  }

  // `async` so a malformed patch reaches the caller as a rejected promise like
  // every other failure of this method, rather than as a synchronous throw the
  // service's error mapping would never see.
  async applyDraftPatch(input: ApplyDraftPatchInput): Promise<SettingsDocumentRecord> {
    const operations = normalizeOperations(input.operations);
    if (operations.length === 0) {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        'A draft patch must carry at least one operation.',
      );
    }
    return this.mutate({
      ...input,
      receiptScope: 'APPLY_SETTINGS_PATCH',
      operation: 'APPLY_DRAFT_PATCH',
      writesDraft: true,
      operations,
      insertValues: patchedValues(emptyValues),
      updateValues: patchedValues(existingValues),
      fingerprint: [['operations', JSON.stringify(operations)]],
    });
  }

  /**
   * Discards the draft and records the discard against the effective document.
   *
   * The discard still bumps the effective revision: a watcher learns that the
   * scope changed only from a revision moving, and a draft that vanished
   * without one would leave every client showing an edit that no longer exists.
   */
  discardDraft(input: DraftInput): Promise<SettingsDocumentRecord> {
    const shape = shapeOf(input.scope);
    return this.mutate({
      ...input,
      receiptScope: 'DISCARD_SETTINGS_DRAFT',
      operation: 'DISCARD_DRAFT',
      writesDraft: false,
      operations: [],
      // The effective values are untouched; only the revision and the history
      // move, which is what makes the discard observable.
      insertValues: emptyValues,
      updateValues: existingValues,
      leadingCtes: `,
         discarded_draft AS (
           DELETE FROM settings_documents AS draft
           USING authorized_actor
           WHERE draft.scope_type = $15
             AND ${shape.matchActor('draft')}
           RETURNING draft.id
         )`,
      writtenFrom: 'authorized_actor CROSS JOIN discarded_draft',
      sourcePresent: 'EXISTS (SELECT 1 FROM discarded_draft)',
      missingSource: () =>
        new PairedDeviceRuntimeError('NOT_FOUND', 'This scope has no draft to discard.'),
      extraParameters: [draftScopeType(input.scope.kind)],
      fingerprint: [],
    });
  }

  /**
   * Moves the draft into the effective document, in one statement.
   *
   * The publish, its version row, its history row and the removal of the draft
   * are all CTEs of the same statement. Splitting them would leave a window in
   * which the draft had been published and still existed, and the Neon HTTP
   * driver offers no interactive transaction to close it.
   */
  publishDraft(input: DraftInput): Promise<SettingsDocumentRecord> {
    const shape = shapeOf(input.scope);
    return this.mutate({
      ...input,
      receiptScope: 'PUBLISH_SETTINGS_DRAFT',
      operation: 'PUBLISH_DRAFT',
      writesDraft: false,
      operations: [],
      insertValues: 'published_draft.values',
      // The proposed row already carries the draft's values, so the update
      // branch reads them from `EXCLUDED` rather than from the CTE: a subquery
      // inside `ON CONFLICT DO UPDATE` would re-enter a statement that is
      // already mid-write.
      updateValues: `EXCLUDED.document -> 'values'`,
      leadingCtes: `,
         published_draft AS MATERIALIZED (
           SELECT draft.id, COALESCE(draft.document -> 'values', '{}'::jsonb) AS values
           FROM settings_documents AS draft
           JOIN authorized_actor ON ${shape.matchActor('draft')}
           WHERE draft.scope_type = $15
           FOR UPDATE OF draft
         )`,
      writtenFrom: 'authorized_actor CROSS JOIN published_draft',
      // The DELETE and the upsert touch different rows of the same table, which
      // PostgreSQL defines; only two data-modifying CTEs against the *same* row
      // would be undefined.
      trailingCtes: `,
         removed_draft AS (
           DELETE FROM settings_documents AS draft
           WHERE draft.id IN (SELECT published_draft.id FROM published_draft)
             AND EXISTS (SELECT 1 FROM written)
           RETURNING draft.id
         )`,
      sourcePresent: 'EXISTS (SELECT 1 FROM published_draft)',
      missingSource: () =>
        new PairedDeviceRuntimeError('NOT_FOUND', 'This scope has no draft to publish.'),
      extraParameters: [draftScopeType(input.scope.kind)],
      fingerprint: [],
    });
  }

  /**
   * Resets the effective document, not the draft.
   *
   * A reset is a deliberate destructive act rather than an edit under review,
   * so it lands on the document the screens are actually reading. What it
   * removes is decided in SQL from the stored keys, because the control plane
   * holds no descriptor table and cannot enumerate a category from a schema.
   */
  reset(input: ResetInput): Promise<SettingsDocumentRecord> {
    const operation: SettingsOperation =
      input.mode === 'ALL'
        ? 'RESET_ALL'
        : input.mode === 'CATEGORY'
          ? 'RESET_CATEGORY'
          : 'RESET_ELEMENT';
    return this.mutate({
      ...input,
      receiptScope: 'RESET_SETTINGS',
      operation,
      writesDraft: false,
      operations: [],
      insertValues:
        input.mode === 'ALL' ? emptyValues : keptValues(emptyValues, resetPredicate(input.mode)),
      updateValues:
        input.mode === 'ALL' ? emptyValues : keptValues(existingValues, resetPredicate(input.mode)),
      category: input.mode === 'CATEGORY' ? input.target : manyCategories,
      ...(input.mode === 'ELEMENT' ? { elementId: input.target } : {}),
      extraParameters: input.mode === 'ALL' ? [] : [input.target],
      fingerprint: [
        ['mode', input.mode],
        ['target', input.target],
      ],
    });
  }

  /**
   * Writes an imported value set into the draft.
   *
   * Import lands in the draft rather than the effective document so an operator
   * reviews a file from outside the deployment before the wall screens follow
   * it. Publishing it is a second, deliberate call.
   */
  importDocument(input: ImportInput): Promise<SettingsDocumentRecord> {
    const values = JSON.stringify(input.values);
    return this.mutate({
      ...input,
      receiptScope: 'IMPORT_SETTINGS',
      operation: 'IMPORT_SETTINGS',
      // The payload names the schema it was exported under; that is the one
      // case where a caller's schema version is a fact about the document.
      adoptsSchemaVersion: true,
      writesDraft: true,
      operations: [],
      insertValues: '$15::jsonb',
      updateValues: `EXCLUDED.document -> 'values'`,
      extraParameters: [values],
      fingerprint: [['values', values]],
    });
  }

  /**
   * Restores the values a named revision produced.
   *
   * The source is `settings_versions.patch->'values'`, which is why that column
   * stores the resulting document and not only the operations: reading a
   * revision and then writing it back would be a read-then-write, and a
   * concurrent patch between the two would be silently discarded.
   */
  revertVersion(input: RevertInput): Promise<SettingsDocumentRecord> {
    const shape = shapeOf(input.scope);
    return this.mutate({
      ...input,
      receiptScope: 'REVERT_SETTINGS_VERSION',
      operation: 'REVERT_SETTINGS_VERSION',
      writesDraft: false,
      operations: [],
      insertValues: 'reverted_source.values',
      updateValues: `EXCLUDED.document -> 'values'`,
      leadingCtes: `,
         reverted_source AS MATERIALIZED (
           SELECT COALESCE(version.patch -> 'values', '{}'::jsonb) AS values
           FROM settings_versions AS version
           JOIN settings_documents AS document ON document.id = version.document_id
           JOIN authorized_actor ON ${shape.matchActor('document')}
           WHERE document.scope_type = $6
             AND version.revision = $15::bigint
         )`,
      writtenFrom: 'authorized_actor CROSS JOIN reverted_source',
      sourcePresent: 'EXISTS (SELECT 1 FROM reverted_source)',
      missingSource: () =>
        new PairedDeviceRuntimeError(
          'NOT_FOUND',
          'This scope has no recorded version at the requested revision.',
        ),
      extraParameters: [input.targetRevision.toString()],
      fingerprint: [['target_revision', input.targetRevision.toString()]],
    });
  }

  /**
   * Reads the scope's history newest first, by keyset rather than by offset.
   *
   * `(occurred_at, id)` is compared as a row value so the cursor names an exact
   * position: an OFFSET page would silently repeat or skip entries whenever a
   * mutation landed between two requests, which on a shoot day is the norm.
   */
  async listHistory(input: ListHistoryInput): Promise<SettingsHistoryPage> {
    requireAddressableScope(input.actor, input.scope);
    const cursor = decodeHistoryCursor(input.cursor);
    const pageSize = this.boundedPageSize(input.pageSize);
    const shape = shapeOf(input.scope);
    const rows = await this.query(
      sql(
        `SELECT
           event.id,
           event.scope,
           event.category,
           event.element_id,
           event.operation,
           event.patch,
           event.revision::text AS revision,
           event.device_id,
           event.correlation_id,
           event.occurred_at
         FROM history_events AS event
         WHERE event.scope = $1
           AND event.group_id = $2
           AND ($3::uuid IS NULL OR event.device_id = $3::uuid)
           AND (
             $4::timestamptz IS NULL
             OR (event.occurred_at, event.id) < ($4::timestamptz, $5::uuid)
           )
           AND EXISTS (
             SELECT 1
             FROM group_memberships AS membership
             JOIN devices ON devices.id = membership.device_id
             WHERE membership.group_id = $2
               AND membership.device_id = $6
               AND membership.revoked_at IS NULL
               AND devices.status <> 'REVOKED'
           )
         ORDER BY event.occurred_at DESC, event.id DESC
         LIMIT $7`,
        [
          input.scope.kind,
          input.actor.groupId,
          shape.documentDeviceId(input.actor, input.scope),
          cursor?.occurredAt ?? null,
          cursor?.id ?? null,
          input.actor.deviceId,
          // One extra row is the cheapest honest answer to "is there more":
          // a COUNT would be a second statement over a table that grows without
          // bound.
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
      nextCursor:
        hasMore && last !== undefined ? encodeHistoryCursor(last.occurredAt, last.id) : '',
    };
  }

  /**
   * The read behind `WatchSettings`.
   *
   * There is no pub/sub in this deployment — the realtime hub exists for group
   * events and knows nothing about settings documents — so the stream is a
   * poll of the scope's revision. The version row at that revision supplies the
   * operation, which is what lets the caller report the change as a kind rather
   * than as "something moved".
   */
  async pollChanges(input: PollChangesInput): Promise<readonly SettingsChange[]> {
    requireAddressableScope(input.actor, input.scope);
    const shape = shapeOf(input.scope);
    // The effective document only. `after_revision` is one number on the wire
    // and the draft row carries a counter of its own, so watching both meant
    // one watermark advancing past two independent sequences: after a publish
    // deleted the draft, the next draft restarted at revision 1 and every
    // watcher above that number went blind to it for good. Restricting the
    // watch to the published document keeps the watermark a single monotonic
    // sequence — which is also the right answer for what a watch is *for*: a
    // wall screen follows what the group published, not somebody's open draft.
    const scopeTypes: string[] = [effectiveScopeType(input.scope.kind)];
    const rows = await this.query(
      sql(
        `SELECT
           document.id,
           document.group_id,
           document.device_id,
           document.scope_type,
           document.schema_version,
           document.document,
           document.revision::text AS revision,
           document.updated_at,
           version.patch ->> 'operation' AS operation,
           version.correlation_id
         FROM settings_documents AS document
         LEFT JOIN settings_versions AS version
           ON version.document_id = document.id
          AND version.revision = document.revision
         WHERE document.scope_type IN (SELECT jsonb_array_elements_text($3::jsonb))
           AND document.group_id IS NOT DISTINCT FROM $4::uuid
           AND document.device_id IS NOT DISTINCT FROM $5::uuid
           AND document.revision > $6::bigint
           AND EXISTS (
             SELECT 1
             FROM group_memberships AS membership
             JOIN devices ON devices.id = membership.device_id
             WHERE membership.group_id = $1
               AND membership.device_id = $2
               AND membership.revoked_at IS NULL
               AND devices.status <> 'REVOKED'
           )
         ORDER BY document.revision ASC, document.scope_type ASC`,
        [
          input.actor.groupId,
          input.actor.deviceId,
          JSON.stringify(scopeTypes),
          shape.documentGroupId(input.actor, input.scope),
          shape.documentDeviceId(input.actor, input.scope),
          input.afterRevision.toString(),
        ],
      ),
    );
    return rows.map((row) => ({
      document: toDocumentRecord(row),
      operation: toOperation(readOptionalText(row.operation)),
      correlationId: readOptionalText(row.correlation_id) ?? '',
    }));
  }

  /**
   * The one place a settings document is written.
   *
   * Assembling every mutation from the same prologue, `written` CTE and
   * epilogue is deliberate: the lock order, the receipt gate and the
   * version/history pair must be identical everywhere, and six copies of them
   * is how one corrected rule becomes five uncorrected ones.
   */
  private async mutate(input: {
    readonly receiptScope: MutationScope;
    readonly operation: SettingsOperation;
    readonly actor: SettingsActor;
    readonly scope: SettingsScopeRef;
    readonly schemaVersion: string;
    readonly correlationId: string;
    readonly mutation?: MutationReceiptContext;
    readonly writesDraft: boolean;
    readonly operations: readonly SettingsPatchOperationInput[];
    /** The value map a row created by this mutation carries. */
    readonly insertValues: string;
    /** The value map an existing row carries after this mutation. */
    readonly updateValues: string;
    readonly fingerprint: readonly FingerprintField[];
    readonly leadingCtes?: string;
    readonly trailingCtes?: string;
    readonly writtenFrom?: string;
    readonly sourcePresent?: string;
    readonly missingSource?: () => PairedDeviceRuntimeError;
    readonly category?: string;
    readonly elementId?: string;
    /** True only for the mutations whose payload declares a schema of its own. */
    readonly adoptsSchemaVersion?: boolean;
    readonly extraParameters?: readonly SqlParameter[];
  }): Promise<SettingsDocumentRecord> {
    if (input.scope.kind !== 'GROUP' && input.scope.kind !== 'DEVICE') {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Factory and theme settings are read-only over this service.',
      );
    }
    // The statement writes the actor's own row whatever the request named, so
    // without this a caller aiming at another group would quietly change its
    // own and be told it succeeded.
    requireAddressableScope(input.actor, input.scope);
    const shape = shapeOf(input.scope);
    const now = this.#now();
    const category = input.category ?? categoryOf(input.operations);
    const elementId = input.elementId ?? elementOf(input.operations);
    const receipt = await this.#receipts.claim(input.receiptScope, input.mutation, now, [
      ['group_id', input.actor.groupId],
      ['actor_device_id', input.actor.deviceId],
      ['scope_type', input.scope.kind],
      ['resource_id', input.scope.resourceId ?? ''],
      ['operation', input.operation],
      ...input.fingerprint,
    ]);
    if (receipt?.claimed === false) return this.replayDocument(receipt);

    const scopeType = input.writesDraft
      ? draftScopeType(input.scope.kind)
      : effectiveScopeType(input.scope.kind);
    const statement = `${settingsMutationPrologue}${input.leadingCtes ?? ''},
         written AS (
           INSERT INTO settings_documents (
             id, group_id, device_id, scope_type, schema_version, document, revision, updated_at
           )
           SELECT gen_random_uuid(), ${shape.identityColumns}, $6, $7,
                  jsonb_build_object('values', ${input.insertValues}), 1, $8
           FROM ${input.writtenFrom ?? 'authorized_actor'}
           ON CONFLICT ${shape.conflictTarget} DO UPDATE
             SET document = jsonb_build_object('values', ${input.updateValues}),
                 -- The stored schema version is kept unless the mutation is one
                 -- that carries a schema with it. Every patch used to overwrite
                 -- it with whatever the caller declared, so one client running
                 -- an older build quietly relabelled the group's document as
                 -- that build's schema.
                 schema_version = ${
                   input.adoptsSchemaVersion === true
                     ? 'EXCLUDED.schema_version'
                     : 'settings_documents.schema_version'
                 },
                 -- The revision is derived from the row the upsert just locked,
                 -- never from a value this process read earlier. That is the
                 -- whole reason two concurrent writers produce N and N+1
                 -- instead of both producing N.
                 revision = settings_documents.revision + 1,
                 updated_at = EXCLUDED.updated_at
           RETURNING id, group_id, device_id, scope_type, schema_version, document, revision, updated_at
         )${input.trailingCtes ?? ''}${settingsMutationEpilogue}
         ${settingsMutationProjection(input.sourcePresent ?? 'true')}`;

    const rows = await this.query(
      sql(statement, [
        receipt?.scope ?? null,
        receipt?.requestIdHash ?? null,
        input.actor.groupId,
        input.actor.deviceId,
        input.scope.kind === 'GROUP' ? groupWriterRoles : anyActiveRoles,
        scopeType,
        input.schemaVersion,
        now,
        input.operation,
        JSON.stringify(input.operations),
        input.correlationId,
        category,
        elementId ?? null,
        input.scope.kind,
        ...(input.extraParameters ?? []),
      ]),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The settings mutation produced no result.',
      );
    }
    if (receipt !== undefined && row.receipt_claimed !== true) return this.replayDocument(receipt);
    if (row.actor_active !== true) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Only an active member of the group with a sufficient role can change these settings.',
      );
    }
    if (row.source_present !== true) {
      throw (input.missingSource ?? defaultMissingSource)();
    }
    if (row.id === null || row.id === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The settings document could not be written because its state changed concurrently.',
      );
    }
    return toDocumentRecord(row);
  }

  /**
   * Answers a retried mutation with the document its original attempt produced.
   *
   * The values come from the version row at the recorded revision rather than
   * from the document as it stands now: a later mutation may have moved it on,
   * and returning that would tell the caller its own request produced a change
   * it never made.
   */
  private async replayDocument(receipt: MutationReceiptClaim): Promise<SettingsDocumentRecord> {
    const outcome = await this.#receipts.resolveRefused(
      receipt,
      new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The settings mutation produced no result.',
      ),
    );
    if (outcome.resourceId === undefined || outcome.revision === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded settings mutation is missing its document and cannot be replayed.',
      );
    }
    const rows = await this.query(
      sql(
        `SELECT
           document.id,
           document.group_id,
           document.device_id,
           document.scope_type,
           document.schema_version,
           jsonb_build_object('values', COALESCE(version.patch -> 'values', '{}'::jsonb)) AS document,
           version.revision::text AS revision,
           version.created_at AS updated_at
         FROM settings_versions AS version
         JOIN settings_documents AS document ON document.id = version.document_id
         WHERE version.document_id = $1 AND version.revision = $2::bigint`,
        [outcome.resourceId, outcome.revision.toString()],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded settings mutation is no longer retained and cannot be replayed.',
      );
    }
    return toDocumentRecord(row);
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

/** The value map a freshly inserted row starts from. */
const emptyValues = `'{}'::jsonb`;
/** The value map an existing row already holds, inside `ON CONFLICT DO UPDATE`. */
const existingValues = `COALESCE(settings_documents.document -> 'values', '{}'::jsonb)`;

/**
 * Applies the patch to a value map inside the statement.
 *
 * Every key the patch names is dropped from the existing map and re-added only
 * when the operation is not a removal, so one expression covers set, replace
 * and remove without the process ever reading the document first.
 */
function patchedValues(base: string): string {
  return `(
             SELECT COALESCE(jsonb_object_agg(merged.path, merged.value), '{}'::jsonb)
             FROM (
               SELECT existing.key AS path, existing.value AS value
               FROM jsonb_each(${base}) AS existing
               WHERE NOT EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements($10::jsonb) AS operation
                 WHERE operation ->> 'path' = existing.key
               )
               UNION ALL
               SELECT operation ->> 'path', operation -> 'value'
               FROM jsonb_array_elements($10::jsonb) AS operation
               WHERE COALESCE((operation ->> 'remove')::boolean, false) = false
             ) AS merged
           )`;
}

function keptValues(base: string, predicate: string): string {
  return `(
             SELECT COALESCE(jsonb_object_agg(kept.key, kept.value), '{}'::jsonb)
             FROM jsonb_each(${base}) AS kept
             WHERE ${predicate}
           )`;
}

function resetPredicate(mode: 'CATEGORY' | 'ELEMENT'): string {
  // A category owns every path whose first segment is its name; an element is
  // one exact path.
  return mode === 'CATEGORY' ? `split_part(kept.key, '.', 1) <> $15` : `kept.key <> $15`;
}

function defaultMissingSource(): PairedDeviceRuntimeError {
  return new PairedDeviceRuntimeError(
    'NOT_FOUND',
    'The settings mutation found nothing to act on.',
  );
}

/**
 * Collapses repeated paths, last one winning.
 *
 * `jsonb_object_agg` raises on a duplicate key, so a client that sent the same
 * path twice would get a driver error instead of the obvious result. Resolving
 * it here also fixes what the fingerprint covers: two patches that differ only
 * in a shadowed operation are the same request.
 */
function normalizeOperations(
  operations: readonly SettingsPatchOperationInput[],
): readonly SettingsPatchOperationInput[] {
  const byPath = new Map<string, SettingsPatchOperationInput>();
  for (const operation of operations) {
    const path = operation.path.trim();
    if (path.length === 0) {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        'A settings patch operation must name a path.',
      );
    }
    if (!operation.remove && operation.value === undefined) {
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        `The settings patch operation for ${path} carries neither a value nor a removal.`,
      );
    }
    byPath.set(path, { ...operation, path });
  }
  return [...byPath.values()];
}

function categoryOf(operations: readonly SettingsPatchOperationInput[]): string {
  const categories = new Set(operations.map((operation) => categoryOfPath(operation.path)));
  const only = [...categories];
  return only.length === 1 && only[0] !== undefined ? only[0] : manyCategories;
}

function elementOf(operations: readonly SettingsPatchOperationInput[]): string | undefined {
  return operations.length === 1 ? operations[0]?.path : undefined;
}

function toDocumentRecord(row: Record<string, unknown>): SettingsDocumentRecord {
  const scopeType = readText(row.scope_type, 'scope_type');
  const decoded = decodeScopeType(scopeType);
  const document = readJsonObject(row.document, 'document');
  const rawValues = document.values;
  if (rawValues !== undefined && !isRecord(rawValues)) {
    throw new Error('The database returned an invalid settings document values map.');
  }
  const resourceId =
    decoded.kind === 'GROUP'
      ? readOptionalText(row.group_id)
      : decoded.kind === 'DEVICE'
        ? readOptionalText(row.device_id)
        : undefined;
  return {
    id: readText(row.id, 'id'),
    scope: { kind: decoded.kind, ...(resourceId === undefined ? {} : { resourceId }) },
    draft: decoded.draft,
    schemaVersion: readText(row.schema_version, 'schema_version'),
    values: rawValues ?? {},
    revision: readBigInt(row.revision, 'revision'),
    updatedAt: readDate(row.updated_at, 'updated_at'),
  };
}

function toHistoryEntry(row: Record<string, unknown>): SettingsHistoryEntryRecord {
  const decoded = decodeScopeType(readText(row.scope, 'scope'));
  const deviceId = readOptionalText(row.device_id);
  const resourceId = decoded.kind === 'DEVICE' ? deviceId : undefined;
  return {
    id: readText(row.id, 'id'),
    scope: { kind: decoded.kind, ...(resourceId === undefined ? {} : { resourceId }) },
    category: readOptionalText(row.category) ?? '',
    elementId: readOptionalText(row.element_id) ?? '',
    operation: readText(row.operation, 'operation'),
    operations: readJsonArray(row.patch, 'patch').map(toPatchOperation),
    revision: readBigInt(row.revision, 'revision'),
    actorDeviceId: deviceId ?? '',
    correlationId: readOptionalText(row.correlation_id) ?? '',
    occurredAt: readDate(row.occurred_at, 'occurred_at'),
  };
}

function toPatchOperation(entry: Record<string, unknown>): SettingsPatchOperationInput {
  const value = entry.value;
  return {
    path: typeof entry.path === 'string' ? entry.path : '',
    remove: entry.remove === true,
    ...(value === undefined || value === null ? {} : { value }),
  };
}

function decodeScopeType(value: string): {
  readonly kind: SettingsScopeKind;
  readonly draft: boolean;
} {
  const draft = value.endsWith('_DRAFT');
  const kind = draft ? value.slice(0, -'_DRAFT'.length) : value;
  if (kind === 'FACTORY' || kind === 'THEME' || kind === 'GROUP' || kind === 'DEVICE') {
    return { kind, draft };
  }
  throw new Error(`The database returned an unknown settings scope type ${value}.`);
}

function toOperation(value: string | undefined): SettingsOperation | undefined {
  switch (value) {
    case 'APPLY_DRAFT_PATCH':
    case 'DISCARD_DRAFT':
    case 'PUBLISH_DRAFT':
    case 'RESET_CATEGORY':
    case 'RESET_ELEMENT':
    case 'RESET_ALL':
    case 'IMPORT_SETTINGS':
    case 'REVERT_SETTINGS_VERSION':
      return value;
    default:
      // A row written by a future version names an operation this build does
      // not know. Reporting it as absent is honest; guessing a kind is not.
      return undefined;
  }
}

interface HistoryCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

/**
 * The cursor carries the sort key, not an offset, so a page boundary keeps
 * meaning the same row after the table has grown underneath it.
 */
export function encodeHistoryCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeHistoryCursor(cursor: string): HistoryCursor | undefined {
  if (cursor.trim().length === 0) return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  const occurredAt = separator === -1 ? '' : decoded.slice(0, separator);
  const id = separator === -1 ? '' : decoded.slice(separator + 1);
  const parsed = new Date(occurredAt);
  if (id.length === 0 || Number.isNaN(parsed.getTime())) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      'The history page cursor is not one this service issued.',
    );
  }
  return { occurredAt: parsed, id };
}
