import type { SettingValue } from '@gremuchaya/settings-schema';

/**
 * What the group's half of the settings needs of `SettingsService` (R6, R29).
 *
 * Only the group scope appears here, and that is the contract rather than an
 * omission. `SETTINGS_SCOPE_TYPE_LOCAL_DRAFT` and `SESSION_PREVIEW` are
 * refused by the server by design -- `settings/service.ts`, `resolveScope`:
 * neither has a server-side home, because an unsent draft and a preview that
 * dies with the session are client states. The draft this application keeps
 * therefore stays its own, and only what an operator publishes reaches the
 * group. `DEVICE` is left out for the opposite reason: this client already
 * persists its device settings in `localStorage`, and a second home for them
 * would be two records of one fact.
 */

export interface GroupSettingsDocument {
  /** The revision the server reports; a client passes it to `WatchSettings`. */
  readonly revision: number;
  readonly values: Readonly<Record<string, SettingValue>>;
  /** ISO 8601, or empty when the server sent no instant. */
  readonly updatedAt: string;
}

/** One `SettingsPatchOperation`. `remove` clears the path instead of setting it. */
export interface GroupSettingsOperation {
  readonly path: string;
  readonly value?: SettingValue;
  readonly remove?: boolean;
}

/**
 * One row of the server's ledger, in the server's own vocabulary.
 *
 * `operation` is kept as the string the server sent -- `APPLY_DRAFT_PATCH`,
 * `RESET_ELEMENT`, `REVERT_SETTINGS_VERSION` -- and is deliberately not mapped
 * onto the client ledger's `patch`/`restore`/`undo`/`redo`. The two vocabularies
 * do not cover the same acts: the client has undo and redo, which the server
 * never sees, and the server has a version revert, which the client cannot
 * perform. Folding either into the other would put a word in the operator's
 * history that nothing actually did.
 */
export interface GroupSettingsHistoryEntry {
  readonly id: string;
  /** ISO 8601, or empty when the server sent no instant. */
  readonly at: string;
  readonly operation: string;
  readonly category: string;
  readonly elementId: string;
  /** The setting paths the entry's patch names, in the order it named them. */
  readonly changedIds: readonly string[];
  readonly revision: number;
  readonly actorDeviceId: string;
}

/**
 * One page of the server's ledger.
 *
 * There is no total and no page count, and that is the server's shape rather
 * than a gap here: `listSettingsHistory` answers with `previousCursor` always
 * empty and `approximateTotal` always `0`, because the read is a keyset over
 * `(occurred_at, id)` and a `COUNT` over a table that grows without bound
 * would be a second statement per page. A client that invented either would
 * be showing the operator a number nobody computed.
 */
export interface GroupSettingsHistoryPage {
  readonly entries: readonly GroupSettingsHistoryEntry[];
  /** Empty when there is nothing after this page. */
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export interface GroupSettingsHistoryQuery {
  /** Empty for the newest page; otherwise the previous page's `nextCursor`. */
  readonly cursor: string;
  /** The server defaults to 50 and caps at 200. */
  readonly pageSize: number;
}

/**
 * One tick of `WatchSettings` (R6).
 *
 * The RPC is restricted server-side to the *effective* document --
 * `settings/service.ts`'s own comment on `watchSettings`, enforced by
 * `settings/store.ts`'s `pollChanges` reading only `effectiveScopeType` --
 * so every event it yields is a change to what the group actually agreed,
 * never to somebody's open draft. That is why only the revision is carried
 * here: `GroupSettingsSync.watchGroupSettings` re-reads the document through
 * `GetEffectiveSettings` rather than trying to reconstruct it from the event,
 * which keeps one path responsible for applying a group answer instead of two.
 */
export interface GroupSettingsWatchEvent {
  readonly revision: number;
}

export interface GroupSettingsPort {
  /**
   * The values that reach this device, merged factory → theme → group →
   * device. `includeDraft` overlays each scope's unpublished draft, which is
   * what an operator previewing a group change needs to see.
   */
  getEffectiveSettings(includeDraft: boolean, signal?: AbortSignal): Promise<GroupSettingsDocument>;
  applyGroupDraftPatch(
    operations: readonly GroupSettingsOperation[],
    signal?: AbortSignal,
  ): Promise<GroupSettingsDocument>;
  publishGroupDraft(signal?: AbortSignal): Promise<GroupSettingsDocument>;
  resetGroupElement(elementId: string, signal?: AbortSignal): Promise<GroupSettingsDocument>;
  listGroupHistory(
    query: GroupSettingsHistoryQuery,
    signal?: AbortSignal,
  ): Promise<GroupSettingsHistoryPage>;
  /**
   * Streams the group's published document as it moves. `afterRevision`
   * resumes a reconnect where the last one left off; `0` asks for every
   * version row the scope still holds.
   */
  watchSettings(
    afterRevision: number,
    signal?: AbortSignal,
  ): AsyncIterable<GroupSettingsWatchEvent>;
}
