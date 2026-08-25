import {
  getSettingDefinition,
  type SettingCategory,
  type SettingsDraftCheckpoint,
} from '@gremuchaya/settings-schema';

import type { ContentOverrides } from '@/application/edit/contentFields';
import { queryRecords } from '@/application/records/query';

export const settingsHistoryOperations = [
  'patch',
  'reset-category',
  'reset-all',
  'import',
  'discard',
  'publish',
  'restore',
  'undo',
  'redo',
] as const;

export type SettingsHistoryOperation = (typeof settingsHistoryOperations)[number];
export type SettingsHistoryOrder = 'newest' | 'oldest';

export const settingsHistoryScopes = ['device', 'group'] as const;

/**
 * Whether a change reaches beyond this machine.
 *
 * `SettingScope` has declared `'group'` since the schema was written, five
 * definitions carry it, and the value was read in exactly one place — as text
 * in a label. It decided nothing (C23). Here it decides something: an entry is
 * `group` when it changed at least one group-scoped setting, which is the same
 * as saying it will propagate once a group exists, and `device` when it changed
 * none.
 *
 * Derived rather than stored by the caller. The scope of a change is a fact
 * about the settings it touched, and a caller free to assert otherwise is a
 * caller free to be wrong about it.
 */
export type SettingsHistoryScope = (typeof settingsHistoryScopes)[number];

export function scopeOfChangedIds(changedIds: readonly string[]): SettingsHistoryScope {
  return changedIds.some((id) => getSettingDefinition(id)?.scope === 'group') ? 'group' : 'device';
}

/**
 * The content overrides around a domain-content edit (R4).
 *
 * Present only on an entry that changed content. A settings entry carries
 * none, and the store reads its absence as "content untouched" rather than as
 * an empty set, so undoing a theme change never moves a date.
 */
export interface ContentHistoryCheckpoint {
  readonly before: ContentOverrides;
  readonly after: ContentOverrides;
}

export interface SettingsHistoryEntry {
  readonly id: string;
  readonly at: string;
  readonly operation: SettingsHistoryOperation;
  readonly category?: SettingCategory | undefined;
  readonly changedIds: readonly string[];
  /** Derived from `changedIds`; see {@link scopeOfChangedIds}. */
  readonly scope: SettingsHistoryScope;
  readonly before: SettingsDraftCheckpoint;
  readonly after: SettingsDraftCheckpoint;
  readonly publishedRevision?: number;
  readonly content?: ContentHistoryCheckpoint;
}

export interface SettingsHistoryQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly order: SettingsHistoryOrder;
  readonly operation?: SettingsHistoryOperation | undefined;
  readonly category?: SettingCategory | undefined;
  readonly settingId?: string | undefined;
  readonly scope?: SettingsHistoryScope | undefined;
  /** ISO calendar date in the operator locale, for example 2026-08-18. */
  readonly date?: string | undefined;
}

export interface SettingsHistoryPage {
  readonly items: readonly SettingsHistoryEntry[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
}

/**
 * What a caller supplies. `scope` is absent because it is derived, and optional
 * rather than forbidden so a stored entry can be passed straight back through.
 */
export type SettingsHistoryEntryInput = Omit<SettingsHistoryEntry, 'scope'> & {
  readonly scope?: SettingsHistoryScope;
};

export function createSettingsHistoryEntry(entry: SettingsHistoryEntryInput): SettingsHistoryEntry {
  const changedIds = unique(entry.changedIds);
  const { content, ...rest } = entry;
  return {
    ...rest,
    changedIds,
    // Recomputed rather than taken from the caller, so a stored entry cannot
    // disagree with the definitions it names.
    scope: scopeOfChangedIds(changedIds),
    before: cloneCheckpoint(entry.before),
    after: cloneCheckpoint(entry.after),
    ...(content === undefined
      ? {}
      : { content: { before: { ...content.before }, after: { ...content.after } } }),
  };
}

export function querySettingsHistory(
  entries: readonly SettingsHistoryEntry[],
  query: SettingsHistoryQuery,
): SettingsHistoryPage {
  const settingId = query.settingId?.toLowerCase();
  const page = queryRecords(entries, {
    page: query.page,
    // The ledger's own bound, kept: it is a dense list in a side panel, not a
    // table with a page-size control.
    pageSize: Math.min(50, query.pageSize),
    filters: [
      (entry) => query.operation === undefined || entry.operation === query.operation,
      (entry) => query.category === undefined || entry.category === query.category,
      (entry) =>
        settingId === undefined ||
        entry.changedIds.some((id) => id.toLowerCase().includes(settingId)),
      (entry) => query.scope === undefined || entry.scope === query.scope,
      (entry) => query.date === undefined || entry.at.startsWith(query.date),
    ],
    comparator: (left, right) => {
      const comparison = left.at.localeCompare(right.at) || left.id.localeCompare(right.id);
      return query.order === 'oldest' ? comparison : -comparison;
    },
  });
  return { items: page.items, page: page.page, pageCount: page.pageCount, total: page.total };
}

export function cloneSettingsHistoryEntry(entry: SettingsHistoryEntry): SettingsHistoryEntry {
  return createSettingsHistoryEntry(entry);
}

function cloneCheckpoint(checkpoint: SettingsDraftCheckpoint): SettingsDraftCheckpoint {
  return {
    values: Object.fromEntries(
      Object.entries(checkpoint.values).map(([id, value]) => [
        id,
        Array.isArray(value) ? [...value] : value,
      ]),
    ),
    changedIds: [...checkpoint.changedIds],
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
