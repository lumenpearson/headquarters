import { createHash } from 'node:crypto';

import { create, fromJson, toJson, type JsonValue } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ControlPlaneFailure, SettingValueSchema, settingsV1 } from '@gremuchaya/protocol';
import type { SettingValue, SettingsService } from '@gremuchaya/protocol';

import { controlPlaneFailure, withRuntimeErrors } from '../errors.js';

import type { Awaitable, PairedDeviceLifecycle } from '../sync/lifecycle.js';
import {
  MutationRequestIdError,
  normalizeRequestId,
  type MutationReceiptContext,
} from '../sync/receipts.js';
import { PairedDeviceRuntimeError, type AuthenticatedDevice } from '../sync/runtime.js';

import {
  categoryOfPath,
  unknownSchemaVersion,
  type SettingsActor,
  type SettingsChange,
  type SettingsDocumentRecord,
  type SettingsHistoryEntryRecord,
  type SettingsOperation,
  type SettingsPatchOperationInput,
  type SettingsScopeKind,
  type SettingsScopeRef,
  type SettingsStore,
  type SettingsValueMap,
} from './store.js';

export interface SettingsServiceOptions {
  readonly runtime: PairedDeviceLifecycle;
  /**
   * Absent in a reduced deployment that has no database. Every RPC that needs
   * it answers `unimplemented` rather than an empty success, so a client can
   * tell a health-only control plane from a working one.
   */
  readonly store?: SettingsStore;
  /**
   * The descriptor set `GetSettingsSchema` serves. The control plane owns no
   * schema of its own — the shipped schema lives with the client that renders
   * it — so a deployment injects one or the RPC stays unimplemented.
   */
  readonly schema?: settingsV1.SettingsSchema;
  /** How often `WatchSettings` re-reads the scope's revision. */
  readonly watchPollIntervalMs?: number;
}

/** Frequent enough that an operator does not notice, cheap enough for one row. */
export const defaultWatchPollIntervalMs = 1000;

/** The only payload form `ExportSettings` produces and `ImportSettings` accepts. */
const settingsMediaType = 'application/json';

/**
 * ConnectRPC adapter for `SettingsService`.
 *
 * The scope rules are enforced twice on purpose. Here, a scope is resolved
 * against the authenticated session before any statement runs, so a caller
 * naming another group's settings is refused without touching the database. In
 * `DurableSettingsStore`, the same rule is re-derived from `group_memberships`
 * inside the mutation, because an access token stays valid for its lifetime and
 * the check that matters is the one that happens at the moment of the write.
 */
export function createSettingsService(
  options: SettingsServiceOptions,
): Partial<ServiceImpl<typeof SettingsService>> {
  const pollIntervalMs = requirePollInterval(
    options.watchPollIntervalMs ?? defaultWatchPollIntervalMs,
  );

  return {
    /**
     * Layers the scopes that reach one device, weakest first.
     *
     * The merge order is the personalization hierarchy R28 describes: factory
     * defaults, then the theme, then what the group agreed, then what this
     * device changed for itself. `include_draft` overlays each scope's draft on
     * top of that scope's published values, so an operator previewing an edit
     * sees exactly what publishing it would produce.
     */
    async getEffectiveSettings(request, context) {
      return withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        const actor = toActor(authenticated);
        assertOwnGroup(authenticated, request.groupId?.value);
        assertOwnDevice(authenticated, request.deviceId?.value);

        const scopes: readonly SettingsScopeRef[] = [
          { kind: 'FACTORY' },
          { kind: 'THEME' },
          { kind: 'GROUP', resourceId: actor.groupId },
          { kind: 'DEVICE', resourceId: actor.deviceId },
        ];
        const documents = await store.readDocuments({
          actor,
          scopes,
          includeDraft: request.includeDraft,
        });
        const ordered = orderByPrecedence(documents);
        if (ordered.length === 0) {
          throw new PairedDeviceRuntimeError(
            'NOT_FOUND',
            'No settings document exists for this device yet.',
          );
        }
        const merged: Record<string, unknown> = {};
        for (const document of ordered) Object.assign(merged, document.values);
        // The most specific contributor names the response: its revision is the
        // one a client passes back to `WatchSettings`, and a merged view has no
        // revision of its own.
        const leading = ordered[ordered.length - 1];
        if (leading === undefined) {
          throw new PairedDeviceRuntimeError(
            'NOT_FOUND',
            'No settings document exists for this device yet.',
          );
        }
        return {
          document: toProtocolDocument({ ...leading, values: merged }),
          contributingScopes: ordered.map((document) => toProtocolScope(document.scope)),
        };
      });
    },

    getSettingsSchema(request) {
      return withRuntimeErrors(() => {
        const schema = options.schema;
        if (schema === undefined) {
          throw controlPlaneFailure(ControlPlaneFailure.SETTINGS_SCHEMA_UNAVAILABLE);
        }
        const requested = request.version.trim();
        if (requested.length > 0 && requested !== schema.version) {
          throw new PairedDeviceRuntimeError(
            'NOT_FOUND',
            `This control plane serves settings schema ${schema.version}.`,
          );
        }
        return { schema };
      });
    },

    async applyDraftPatch(request, context) {
      return withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        const scope = resolveWritableScope(request.scope, authenticated);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const draft = await store.applyDraftPatch({
          actor: toActor(authenticated),
          scope,
          operations: request.operations.map(toPatchOperation),
          schemaVersion: unknownSchemaVersion,
          correlationId: request.context?.correlationId ?? '',
          ...toMutationInput(request.context?.requestId),
        });
        return { draft: toProtocolDocument(draft) };
      });
    },

    async discardDraft(request, context) {
      return withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        const scope = resolveWritableScope(request.scope, authenticated);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const effective = await store.discardDraft({
          actor: toActor(authenticated),
          scope,
          schemaVersion: unknownSchemaVersion,
          correlationId: request.context?.correlationId ?? '',
          ...toMutationInput(request.context?.requestId),
        });
        return { effective: toProtocolDocument(effective) };
      });
    },

    async publishDraft(request, context) {
      return withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        const scope = resolveWritableScope(request.scope, authenticated);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const published = await store.publishDraft({
          actor: toActor(authenticated),
          scope,
          schemaVersion: unknownSchemaVersion,
          correlationId: request.context?.correlationId ?? '',
          ...toMutationInput(request.context?.requestId),
        });
        return { published: toProtocolDocument(published) };
      });
    },

    async resetCategory(request, context) {
      return withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        const scope = resolveWritableScope(request.scope, authenticated);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const document = await store.reset({
          actor: toActor(authenticated),
          scope,
          mode: 'CATEGORY',
          target: requireText(request.category, 'category'),
          schemaVersion: unknownSchemaVersion,
          correlationId: request.context?.correlationId ?? '',
          ...toMutationInput(request.context?.requestId),
        });
        return { document: toProtocolDocument(document) };
      });
    },

    async resetElement(request, context) {
      return withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        const scope = resolveWritableScope(request.scope, authenticated);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const document = await store.reset({
          actor: toActor(authenticated),
          scope,
          mode: 'ELEMENT',
          target: requireText(request.elementId, 'element_id'),
          schemaVersion: unknownSchemaVersion,
          correlationId: request.context?.correlationId ?? '',
          ...toMutationInput(request.context?.requestId),
        });
        return { document: toProtocolDocument(document) };
      });
    },

    /**
     * Empties the scope's settings.
     *
     * `confirmation` must repeat the scope's own resource id. A reset that
     * cannot be undone by the caller needs a token the caller could only have
     * typed deliberately, and a fixed word would be one every client hardcodes.
     */
    async resetAll(request, context) {
      return withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        const scope = resolveWritableScope(request.scope, authenticated);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        if (request.confirmation.trim() !== scope.resourceId) {
          throw new PairedDeviceRuntimeError(
            'INVALID_ARGUMENT',
            'confirmation must repeat the identifier of the scope being reset.',
          );
        }
        const document = await store.reset({
          actor: toActor(authenticated),
          scope,
          mode: 'ALL',
          target: '',
          schemaVersion: unknownSchemaVersion,
          correlationId: request.context?.correlationId ?? '',
          ...toMutationInput(request.context?.requestId),
        });
        return { document: toProtocolDocument(document) };
      });
    },

    /**
     * Serves the scope's published values as a file.
     *
     * The checksum covers the exact bytes returned, so an operator carrying the
     * export between two air-gapped machines can tell a truncated copy from a
     * complete one before importing it.
     */
    async exportSettings(request, context) {
      return withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        const scope = resolveScope(request.scope, authenticated);
        const documents = await store.readDocuments({
          actor: toActor(authenticated),
          scopes: [scope],
          includeDraft: false,
        });
        const document = documents.find((candidate) => !candidate.draft);
        if (document === undefined) {
          throw new PairedDeviceRuntimeError(
            'NOT_FOUND',
            'This scope has no settings document to export.',
          );
        }
        const payload = Buffer.from(
          `${JSON.stringify(
            {
              schemaVersion: document.schemaVersion,
              scope: { type: document.scope.kind, resourceId: document.scope.resourceId ?? '' },
              revision: document.revision.toString(),
              values: document.values,
            },
            undefined,
            2,
          )}\n`,
          'utf8',
        );
        return {
          payload: Uint8Array.from(payload),
          mediaType: settingsMediaType,
          schemaVersion: document.schemaVersion,
          checksum: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
        };
      });
    },

    /**
     * Reads an exported file back into the scope's draft.
     *
     * A payload that fails validation is reported as violations and written
     * nowhere, whether or not `dry_run` was set: a partially applied import is
     * worse than a refused one, because the operator cannot tell which half
     * landed.
     */
    async importSettings(request, context) {
      return withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        const scope = resolveWritableScope(request.scope, authenticated);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        if (request.mediaType.trim().length > 0 && request.mediaType.trim() !== settingsMediaType) {
          throw new PairedDeviceRuntimeError(
            'INVALID_ARGUMENT',
            `Settings payloads must be ${settingsMediaType}.`,
          );
        }
        const parsed = parseImportPayload(request.payload);
        if (parsed.violations.length > 0) return { violations: [...parsed.violations] };
        if (request.dryRun) {
          // A dry run answers with what would be written, not with what is
          // stored, so the operator compares the file against the file.
          return { violations: [] };
        }
        const document = await store.importDocument({
          actor: toActor(authenticated),
          scope,
          values: parsed.values,
          schemaVersion: parsed.schemaVersion,
          correlationId: request.context?.correlationId ?? '',
          ...toMutationInput(request.context?.requestId),
        });
        return { document: toProtocolDocument(document), violations: [] };
      });
    },

    async revertSettingsVersion(request, context) {
      return withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        const scope = resolveWritableScope(request.scope, authenticated);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        const targetRevision = request.targetRevision?.number ?? 0n;
        if (targetRevision <= 0n) {
          throw new PairedDeviceRuntimeError(
            'INVALID_ARGUMENT',
            'target_revision must name a revision this scope actually recorded.',
          );
        }
        const document = await store.revertVersion({
          actor: toActor(authenticated),
          scope,
          targetRevision,
          schemaVersion: unknownSchemaVersion,
          correlationId: request.context?.correlationId ?? '',
          ...toMutationInput(request.context?.requestId),
        });
        return { document: toProtocolDocument(document) };
      });
    },

    async listSettingsHistory(request, context) {
      return withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        const scope = resolveScope(request.scope, authenticated);
        const page = await store.listHistory({
          actor: toActor(authenticated),
          scope,
          pageSize: request.page?.pageSize ?? 0,
          cursor: request.page?.cursor ?? '',
        });
        return {
          entries: page.entries.map(toProtocolHistoryEntry),
          page: {
            nextCursor: page.nextCursor,
            previousCursor: '',
            hasMore: page.hasMore,
            approximateTotal: 0n,
          },
        };
      });
    },

    /**
     * Streams the scope's revisions as they move.
     *
     * This is a poll, not a subscription, and deliberately so: the realtime hub
     * carries group events and knows nothing about settings documents, and
     * there is no message broker in this deployment. Inventing one here would
     * add an operational dependency the shoot-day runbook does not cover, for a
     * stream whose events arrive minutes apart. The cost is a bounded delay of
     * one poll interval; the guarantee is that a client that reconnects with
     * `after_revision` misses nothing, because the revisions are in the table
     * rather than in a process.
     */
    async *watchSettings(request, context) {
      const prepared = await withRuntimeErrors(async () => {
        const store = requireStore(options.store);
        const authenticated = await authenticateRequest(options.runtime, context);
        return {
          store,
          actor: toActor(authenticated),
          scope: resolveScope(request.scope, authenticated),
        };
      });

      let afterRevision = request.afterRevision;
      while (!context.signal.aborted) {
        const changes = await withRuntimeErrors(() =>
          prepared.store.pollChanges({
            actor: prepared.actor,
            scope: prepared.scope,
            afterRevision,
          }),
        );
        for (const change of changes) {
          if (context.signal.aborted) return;
          if (change.document.revision > afterRevision) afterRevision = change.document.revision;
          yield { event: toProtocolEvent(change) };
        }
        if (changes.length === 0) await waitForNextPoll(pollIntervalMs, context.signal);
      }
    },
  };
}

function authenticateRequest(
  runtime: PairedDeviceLifecycle,
  context: HandlerContext,
): Awaitable<AuthenticatedDevice> {
  return runtime.authenticateAccessToken(readBearerToken(context));
}

function readBearerToken(context: HandlerContext): string {
  const header = context.requestHeader.get('authorization');
  const match = header === null ? undefined : /^Bearer ([^\s]+)$/u.exec(header.trim());
  if (match?.[1] === undefined) {
    throw controlPlaneFailure(ControlPlaneFailure.BEARER_TOKEN_REQUIRED);
  }
  return match[1];
}

function toActor(authenticated: AuthenticatedDevice): SettingsActor {
  return { groupId: authenticated.group.id, deviceId: authenticated.device.id };
}

/**
 * Turns the wire scope into one this service can address.
 *
 * `LOCAL_DRAFT` and `SESSION_PREVIEW` are refused here rather than in SQL
 * because they have no server-side home at all: a row for either would leave
 * both `group_id` and `device_id` NULL without being `FACTORY` or `THEME`, and
 * `settings_documents`' own CHECK rejects exactly that. They are client states
 * by definition — an unsent draft and a preview that dies with the session — so
 * the honest answer names the reason instead of inventing a table for them.
 */
function resolveScope(
  scope: settingsV1.SettingsScope | undefined,
  authenticated: AuthenticatedDevice,
): SettingsScopeRef {
  const resourceId = scope?.resourceId?.value.trim() ?? '';
  switch (scope?.type) {
    case settingsV1.SettingsScopeType.FACTORY:
      return { kind: 'FACTORY' };
    case settingsV1.SettingsScopeType.THEME:
      return { kind: 'THEME' };
    case settingsV1.SettingsScopeType.GROUP:
      if (resourceId !== authenticated.group.id) {
        throw new PairedDeviceRuntimeError(
          'PERMISSION_DENIED',
          'A device may address only the settings of the group its session names.',
        );
      }
      return { kind: 'GROUP', resourceId };
    case settingsV1.SettingsScopeType.DEVICE:
      if (resourceId !== authenticated.device.id) {
        throw new PairedDeviceRuntimeError(
          'PERMISSION_DENIED',
          'A device may address only its own device settings.',
        );
      }
      return { kind: 'DEVICE', resourceId };
    case settingsV1.SettingsScopeType.LOCAL_DRAFT:
    case settingsV1.SettingsScopeType.SESSION_PREVIEW:
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        'LOCAL_DRAFT and SESSION_PREVIEW settings never leave the machine that holds them: ' +
          'the control plane stores no document for either scope.',
      );
    default:
      throw new PairedDeviceRuntimeError(
        'INVALID_ARGUMENT',
        'A settings scope must be named explicitly.',
      );
  }
}

/** `FACTORY` and `THEME` are configuration this deployment ships, not state an RPC edits. */
function resolveWritableScope(
  scope: settingsV1.SettingsScope | undefined,
  authenticated: AuthenticatedDevice,
): SettingsScopeRef & { readonly resourceId: string } {
  const resolved = resolveScope(scope, authenticated);
  if (resolved.kind !== 'GROUP' && resolved.kind !== 'DEVICE') {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'Factory and theme settings are read-only over this service.',
    );
  }
  return { ...resolved, resourceId: resolved.resourceId ?? '' };
}

function assertOwnGroup(authenticated: AuthenticatedDevice, groupId: string | undefined): void {
  if (groupId === undefined || groupId.length === 0) return;
  if (groupId !== authenticated.group.id) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'The authenticated device does not belong to the requested group.',
    );
  }
}

function assertOwnDevice(authenticated: AuthenticatedDevice, deviceId: string | undefined): void {
  if (deviceId === undefined || deviceId.length === 0) return;
  if (deviceId !== authenticated.device.id) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'A device may read only its own effective settings.',
    );
  }
}

function assertContextActor(
  authenticated: AuthenticatedDevice,
  actorDeviceId: string | undefined,
): void {
  if (actorDeviceId === undefined || actorDeviceId.length === 0) return;
  if (actorDeviceId !== authenticated.device.id) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'The mutation context actor does not match the authenticated device.',
    );
  }
}

/**
 * The precedence a merged view follows: factory defaults, then the theme, then
 * the group, then this device — with each scope's draft immediately above its
 * own published values.
 */
const scopePrecedence: readonly SettingsScopeKind[] = ['FACTORY', 'THEME', 'GROUP', 'DEVICE'];

function orderByPrecedence(
  documents: readonly SettingsDocumentRecord[],
): readonly SettingsDocumentRecord[] {
  return [...documents].sort((left, right) => {
    const byScope =
      scopePrecedence.indexOf(left.scope.kind) - scopePrecedence.indexOf(right.scope.kind);
    if (byScope !== 0) return byScope;
    return Number(left.draft) - Number(right.draft);
  });
}

function toProtocolScope(scope: SettingsScopeRef): settingsV1.SettingsScope {
  return create(settingsV1.SettingsScopeSchema, {
    type: toProtocolScopeType(scope.kind),
    resourceId: { value: scope.resourceId ?? '' },
  });
}

function toProtocolScopeType(kind: SettingsScopeKind): settingsV1.SettingsScopeType {
  if (kind === 'FACTORY') return settingsV1.SettingsScopeType.FACTORY;
  if (kind === 'THEME') return settingsV1.SettingsScopeType.THEME;
  if (kind === 'GROUP') return settingsV1.SettingsScopeType.GROUP;
  return settingsV1.SettingsScopeType.DEVICE;
}

function toProtocolDocument(document: SettingsDocumentRecord) {
  return {
    id: { value: document.id },
    scope: toProtocolScope(document.scope),
    values: toProtocolValues(document.values),
    revision: {
      number: document.revision,
      etag: `settings-${document.id}-revision-${document.revision.toString()}`,
    },
    updatedAt: timestampFromDate(document.updatedAt),
  };
}

/**
 * Decodes the stored value map.
 *
 * A stored value that no longer parses is dropped rather than failing the whole
 * read: one unreadable entry must not make every other setting on a shoot-day
 * screen unavailable.
 */
function toProtocolValues(values: SettingsValueMap): Record<string, SettingValue> {
  const decoded: Record<string, SettingValue> = {};
  for (const [path, raw] of Object.entries(values)) {
    const value = toValue(raw);
    if (value !== undefined) decoded[path] = value;
  }
  return decoded;
}

function toValue(raw: unknown): SettingValue | undefined {
  try {
    return fromJson(SettingValueSchema, raw as JsonValue);
  } catch {
    return undefined;
  }
}

function toPatchOperation(
  operation: settingsV1.SettingsPatchOperation,
): SettingsPatchOperationInput {
  return {
    path: operation.path,
    remove: operation.remove,
    ...(operation.value === undefined
      ? {}
      : { value: toJson(SettingValueSchema, operation.value) }),
  };
}

function toProtocolHistoryEntry(entry: SettingsHistoryEntryRecord) {
  return {
    id: { value: entry.id },
    scope: toProtocolScope(entry.scope),
    category: entry.category,
    elementId: entry.elementId,
    operation: entry.operation,
    patch: entry.operations.map(toProtocolPatchOperation),
    revision: {
      number: entry.revision,
      etag: `settings-history-${entry.id}`,
    },
    actorDeviceId: { value: entry.actorDeviceId },
    occurredAt: timestampFromDate(entry.occurredAt),
    correlationId: entry.correlationId,
  };
}

function toProtocolPatchOperation(operation: SettingsPatchOperationInput) {
  const value = operation.value === undefined ? undefined : toValue(operation.value);
  return {
    path: operation.path,
    remove: operation.remove,
    ...(value === undefined ? {} : { value }),
  };
}

/**
 * The event a revision change becomes.
 *
 * `sequence` carries the document revision rather than a stream counter: a
 * client that drops the connection resumes with `after_revision`, and a second
 * numbering would give it two orderings to reconcile.
 */
function toProtocolEvent(change: SettingsChange) {
  return {
    sequence: change.document.revision,
    kind: toEventKind(change.operation, change.document.draft),
    scope: toProtocolScope(change.document.scope),
    document: toProtocolDocument(change.document),
    occurredAt: timestampFromDate(change.document.updatedAt),
    correlationId: change.correlationId,
  };
}

function toEventKind(
  operation: SettingsOperation | undefined,
  draft: boolean,
): settingsV1.SettingsEventKind {
  switch (operation) {
    case 'APPLY_DRAFT_PATCH':
    case 'IMPORT_SETTINGS':
      return settingsV1.SettingsEventKind.DRAFT_UPDATED;
    case 'DISCARD_DRAFT':
      return settingsV1.SettingsEventKind.DRAFT_DISCARDED;
    case 'PUBLISH_DRAFT':
      return settingsV1.SettingsEventKind.PUBLISHED;
    case 'RESET_CATEGORY':
    case 'RESET_ELEMENT':
    case 'RESET_ALL':
      return settingsV1.SettingsEventKind.RESET;
    case 'REVERT_SETTINGS_VERSION':
      return settingsV1.SettingsEventKind.REVERTED;
    default:
      // A document whose version row this build cannot name is still a real
      // change; the row's own draft flag is the most the server can honestly
      // say about it.
      return draft
        ? settingsV1.SettingsEventKind.DRAFT_UPDATED
        : settingsV1.SettingsEventKind.PUBLISHED;
  }
}

interface ParsedImport {
  readonly schemaVersion: string;
  readonly values: SettingsValueMap;
  readonly violations: readonly { readonly field: string; readonly reason: string }[];
}

/**
 * Reads an exported payload back.
 *
 * Every value is decoded through the protobuf-JSON reader rather than trusted
 * as JSON, so a hand-edited file that names a type the contract does not have
 * is reported as a field violation instead of being stored and failing later on
 * a wall screen.
 */
function parseImportPayload(payload: Uint8Array): ParsedImport {
  const violations: { field: string; reason: string }[] = [];
  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(payload).toString('utf8'));
  } catch {
    return {
      schemaVersion: unknownSchemaVersion,
      values: {},
      violations: [{ field: 'payload', reason: 'The payload is not valid JSON.' }],
    };
  }
  if (!isRecord(document)) {
    return {
      schemaVersion: unknownSchemaVersion,
      values: {},
      violations: [{ field: 'payload', reason: 'The payload must be a JSON object.' }],
    };
  }
  const rawValues = document.values;
  if (!isRecord(rawValues)) {
    return {
      schemaVersion: unknownSchemaVersion,
      values: {},
      violations: [{ field: 'payload.values', reason: 'The payload carries no settings values.' }],
    };
  }
  const values: Record<string, unknown> = {};
  for (const [path, raw] of Object.entries(rawValues)) {
    if (path.trim().length === 0 || categoryOfPath(path).length === 0) {
      violations.push({ field: `values.${path}`, reason: 'A setting path must not be empty.' });
      continue;
    }
    const value = toValue(raw);
    if (value === undefined) {
      violations.push({
        field: `values.${path}`,
        reason: 'The value is not a gremuchaya.common.v1.SettingValue.',
      });
      continue;
    }
    values[path] = toJson(SettingValueSchema, value);
  }
  const schemaVersion =
    typeof document.schemaVersion === 'string' && document.schemaVersion.trim().length > 0
      ? document.schemaVersion
      : unknownSchemaVersion;
  return { schemaVersion, values, violations };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `request_id` is the only part of `MutationContext` that carries idempotency
 * meaning. `correlation_id` is response metadata and `issued_at` is a client
 * clock reading, so neither may take part in retry identity.
 */
function toMutationInput(requestId: string | undefined): {
  readonly mutation?: MutationReceiptContext;
} {
  try {
    const normalized = normalizeRequestId(requestId);
    return normalized === undefined ? {} : { mutation: { requestId: normalized } };
  } catch (error: unknown) {
    if (error instanceof MutationRequestIdError) {
      throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', error.message);
    }
    throw error;
  }
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  return normalized;
}

function requireStore(store: SettingsStore | undefined): SettingsStore {
  if (store === undefined) {
    throw controlPlaneFailure(ControlPlaneFailure.SETTINGS_STORAGE_UNAVAILABLE);
  }
  return store;
}

function requirePollInterval(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('watchPollIntervalMs must be a positive integer');
  }
  return value;
}

/**
 * Sleeps until the next poll or until the caller goes away, whichever comes
 * first. Waiting out the full interval after an abort would keep the handler —
 * and its database client — alive after nobody is listening.
 */
function waitForNextPoll(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, intervalMs);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
