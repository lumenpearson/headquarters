import { createClient, type Transport } from '@connectrpc/connect';
import { SettingsService, settingsV1 } from '@gremuchaya/protocol';
import type { SettingValue } from '@gremuchaya/settings-schema';

import { ControlPlaneError } from '@/application/sync/controlPlanePort';
import type {
  GroupSettingsDocument,
  GroupSettingsHistoryEntry,
  GroupSettingsHistoryPage,
  GroupSettingsHistoryQuery,
  GroupSettingsOperation,
  GroupSettingsPort,
  GroupSettingsWatchEvent,
} from '@/application/sync/groupSettingsPort';

import { toEpochMs } from './groupEventCodec';

/*
 * Wire shapes declared structurally, in the idiom `ControlPlaneClient` set:
 * the generated client is assignable to these and so is a fake. Only the
 * fields this facade reads or writes are named.
 */
interface WireTimestamp {
  readonly seconds: bigint;
  readonly nanos: number;
}

interface WireResourceId {
  readonly value: string;
}

interface WireRevision {
  readonly number: bigint;
  readonly etag: string;
}

interface WireScope {
  readonly type: settingsV1.SettingsScopeType;
  readonly resourceId: WireResourceId;
}

/** `gremuchaya.common.v1.SettingValue`, which is a oneof of six kinds. */
interface WireSettingValue {
  readonly kind:
    | { readonly case: 'stringValue'; readonly value: string }
    | { readonly case: 'integerValue'; readonly value: bigint }
    | { readonly case: 'numberValue'; readonly value: number }
    | { readonly case: 'booleanValue'; readonly value: boolean }
    | { readonly case: 'binaryValue'; readonly value: Uint8Array }
    | { readonly case: 'stringList'; readonly value: { readonly values: readonly string[] } }
    | { readonly case: undefined; readonly value?: undefined };
}

interface WirePatchOperation {
  readonly path: string;
  readonly value?: WireSettingValue | undefined;
  readonly remove: boolean;
}

interface WireDocument {
  readonly scope?: WireScope | undefined;
  readonly values: Readonly<Record<string, WireSettingValue>>;
  readonly revision?: WireRevision | undefined;
  readonly updatedAt?: WireTimestamp | undefined;
}

interface WireHistoryEntry {
  readonly id?: WireResourceId | undefined;
  readonly scope?: WireScope | undefined;
  readonly category: string;
  readonly elementId: string;
  readonly operation: string;
  readonly patch: readonly WirePatchOperation[];
  readonly revision?: WireRevision | undefined;
  readonly actorDeviceId?: WireResourceId | undefined;
  readonly occurredAt?: WireTimestamp | undefined;
}

interface WireMutationContext {
  readonly requestId: string;
  readonly actorDeviceId?: WireResourceId;
}

interface CallOptions {
  readonly signal?: AbortSignal;
}

export interface SettingsRpcClient {
  getEffectiveSettings(
    request: {
      readonly groupId: WireResourceId;
      readonly deviceId: WireResourceId;
      readonly includeDraft: boolean;
    },
    options?: CallOptions,
  ): Promise<{ readonly document?: WireDocument | undefined }>;
  applyDraftPatch(
    request: {
      readonly context: WireMutationContext;
      readonly scope: WireScope;
      readonly operations: readonly WirePatchOperation[];
    },
    options?: CallOptions,
  ): Promise<{ readonly draft?: WireDocument | undefined }>;
  publishDraft(
    request: { readonly context: WireMutationContext; readonly scope: WireScope },
    options?: CallOptions,
  ): Promise<{ readonly published?: WireDocument | undefined }>;
  resetElement(
    request: {
      readonly context: WireMutationContext;
      readonly scope: WireScope;
      readonly elementId: string;
    },
    options?: CallOptions,
  ): Promise<{ readonly document?: WireDocument | undefined }>;
  listSettingsHistory(
    request: {
      readonly scope: WireScope;
      readonly page: { readonly pageSize: number; readonly cursor: string };
    },
    options?: CallOptions,
  ): Promise<{
    readonly entries: readonly WireHistoryEntry[];
    readonly page?: { readonly nextCursor: string; readonly hasMore: boolean } | undefined;
  }>;
  watchSettings(
    request: { readonly scope: WireScope; readonly afterRevision: bigint },
    options?: CallOptions,
  ): AsyncIterable<{ readonly event?: WireSettingsEvent | undefined }>;
}

/** Only the field this facade reads: `WatchSettingsResponse.event.sequence`. */
interface WireSettingsEvent {
  readonly sequence: bigint;
}

export interface GroupSettingsClientOptions {
  readonly groupId: string;
  readonly deviceId: string;
  /** The shared authenticated transport; unused when `client` is injected. */
  readonly transport?: Transport;
  readonly client?: SettingsRpcClient;
  readonly mintRequestId?: () => string;
}

/**
 * Browser-facing adapter for `SettingsService`, group scope only (R6, R29).
 *
 * Every call names `SETTINGS_SCOPE_TYPE_GROUP` with this session's own group
 * id, which is what the server checks before touching the database: a scope
 * naming another group is refused as `PERMISSION_DENIED` without a statement
 * running (`settings/service.ts`, `resolveScope`). Passing the id from the
 * session rather than from a caller means a surface cannot ask for a group it
 * is not in even by accident.
 */
export class GroupSettingsClient implements GroupSettingsPort {
  readonly #client: SettingsRpcClient;
  readonly #groupId: string;
  readonly #deviceId: string;
  readonly #mintRequestId: () => string;

  constructor(options: GroupSettingsClientOptions) {
    this.#groupId = options.groupId;
    this.#deviceId = options.deviceId;
    this.#mintRequestId = options.mintRequestId ?? (() => crypto.randomUUID());
    if (options.client !== undefined) {
      this.#client = options.client;
    } else if (options.transport !== undefined) {
      this.#client = createClient(SettingsService, options.transport) as SettingsRpcClient;
    } else {
      throw new Error('GroupSettingsClient needs a transport or an injected client.');
    }
  }

  async getEffectiveSettings(
    includeDraft: boolean,
    signal?: AbortSignal,
  ): Promise<GroupSettingsDocument> {
    const response = await this.#client.getEffectiveSettings(
      {
        groupId: { value: this.#groupId },
        deviceId: { value: this.#deviceId },
        includeDraft,
      },
      options(signal),
    );
    return toDocument(response.document);
  }

  async applyGroupDraftPatch(
    operations: readonly GroupSettingsOperation[],
    signal?: AbortSignal,
  ): Promise<GroupSettingsDocument> {
    const response = await this.#client.applyDraftPatch(
      {
        context: this.#mutation(),
        scope: this.#scope(),
        operations: operations.map(toWirePatchOperation),
      },
      options(signal),
    );
    return toDocument(response.draft);
  }

  async publishGroupDraft(signal?: AbortSignal): Promise<GroupSettingsDocument> {
    const response = await this.#client.publishDraft(
      { context: this.#mutation(), scope: this.#scope() },
      options(signal),
    );
    return toDocument(response.published);
  }

  async resetGroupElement(elementId: string, signal?: AbortSignal): Promise<GroupSettingsDocument> {
    const response = await this.#client.resetElement(
      { context: this.#mutation(), scope: this.#scope(), elementId },
      options(signal),
    );
    return toDocument(response.document);
  }

  /**
   * One page of the group's ledger, newest first.
   *
   * The cursor is opaque here on purpose. The server builds it as
   * `base64url("<ISO occurredAt>|<uuid id>")` and reads it back as a keyset
   * position; a client that parsed it would be duplicating a decision it does
   * not own, and one that skipped it for an offset would repeat or lose rows
   * whenever a change landed between two pages.
   */
  async listGroupHistory(
    query: GroupSettingsHistoryQuery,
    signal?: AbortSignal,
  ): Promise<GroupSettingsHistoryPage> {
    const response = await this.#client.listSettingsHistory(
      {
        scope: this.#scope(),
        page: { pageSize: query.pageSize, cursor: query.cursor },
      },
      options(signal),
    );
    return {
      entries: response.entries.map(toHistoryEntry),
      nextCursor: response.page?.nextCursor ?? '',
      hasMore: response.page?.hasMore ?? false,
    };
  }

  /**
   * `SettingsService.WatchSettings`, one `GroupSettingsWatchEvent` per frame.
   *
   * A thin pass-through: the wire event carries a document too, but
   * `GroupSettingsSync` re-reads through `getEffectiveSettings` rather than
   * consuming it, so nothing here is decoded beyond the revision that says a
   * read is due.
   */
  async *watchSettings(
    afterRevision: number,
    signal?: AbortSignal,
  ): AsyncIterable<GroupSettingsWatchEvent> {
    const stream = this.#client.watchSettings(
      { scope: this.#scope(), afterRevision: BigInt(Math.max(0, Math.trunc(afterRevision))) },
      options(signal),
    );
    for await (const response of stream) {
      const sequence = response.event?.sequence;
      if (sequence === undefined) continue;
      yield { revision: Number(sequence) };
    }
  }

  #scope(): WireScope {
    return {
      type: settingsV1.SettingsScopeType.GROUP,
      resourceId: { value: this.#groupId },
    };
  }

  #mutation(): WireMutationContext {
    return { requestId: this.#mintRequestId(), actorDeviceId: { value: this.#deviceId } };
  }
}

function options(signal: AbortSignal | undefined): CallOptions {
  return signal === undefined ? {} : { signal };
}

function toDocument(document: WireDocument | undefined): GroupSettingsDocument {
  if (document === undefined) {
    throw new ControlPlaneError('unknown', 'Control plane returned no settings document.');
  }
  const values: Record<string, SettingValue> = {};
  for (const [path, wire] of Object.entries(document.values)) {
    const value = toSettingValue(wire);
    // A value this build cannot read is dropped rather than failing the whole
    // document, which is the same rule the server applies to a stored value it
    // can no longer parse: one unreadable entry must not take a shoot-day
    // screen's settings with it.
    if (value !== undefined) values[path] = value;
  }
  return {
    revision: Number(document.revision?.number ?? 0n),
    values,
    updatedAt: toIsoInstant(document.updatedAt),
  };
}

function toHistoryEntry(entry: WireHistoryEntry): GroupSettingsHistoryEntry {
  return {
    id: entry.id?.value ?? '',
    at: toIsoInstant(entry.occurredAt),
    operation: entry.operation,
    category: entry.category,
    elementId: entry.elementId,
    changedIds: entry.patch.map((operation) => operation.path),
    revision: Number(entry.revision?.number ?? 0n),
    actorDeviceId: entry.actorDeviceId?.value ?? '',
  };
}

function toWirePatchOperation(operation: GroupSettingsOperation): WirePatchOperation {
  const remove = operation.remove === true;
  const value = remove || operation.value === undefined ? undefined : operation.value;
  return {
    path: operation.path,
    remove,
    ...(value === undefined ? {} : { value: toWireSettingValue(value) }),
  };
}

/**
 * The six kinds of `SettingValue`, mapped from the four this schema uses.
 *
 * A whole number becomes `integerValue` and a fractional one `numberValue`,
 * which is what the server's own JSON round-trip preserves. `binaryValue` has
 * no counterpart in `@gremuchaya/settings-schema` and is never produced here.
 */
function toWireSettingValue(value: SettingValue): WireSettingValue {
  if (typeof value === 'boolean') return { kind: { case: 'booleanValue', value } };
  if (typeof value === 'string') return { kind: { case: 'stringValue', value } };
  if (typeof value === 'number') {
    return Number.isSafeInteger(value)
      ? { kind: { case: 'integerValue', value: BigInt(value) } }
      : { kind: { case: 'numberValue', value } };
  }
  return { kind: { case: 'stringList', value: { values: [...value] } } };
}

function toSettingValue(value: WireSettingValue | undefined): SettingValue | undefined {
  switch (value?.kind.case) {
    case 'stringValue':
      return value.kind.value;
    case 'integerValue':
      return Number(value.kind.value);
    case 'numberValue':
      return value.kind.value;
    case 'booleanValue':
      return value.kind.value;
    case 'stringList':
      return [...value.kind.value.values];
    default:
      // `binaryValue` and an unset oneof both land here. Neither is a value
      // this schema can hold, and inventing one would be worse than dropping it.
      return undefined;
  }
}

function toIsoInstant(timestamp: WireTimestamp | undefined): string {
  const epochMs = toEpochMs(timestamp);
  return epochMs === 0 ? '' : new Date(epochMs).toISOString();
}
