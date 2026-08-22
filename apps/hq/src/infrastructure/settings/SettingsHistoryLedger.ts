import type { SettingCategory, SettingsDraftCheckpoint } from '@gremuchaya/settings-schema';

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

export interface SettingsHistoryEntry {
  readonly id: string;
  readonly at: string;
  readonly operation: SettingsHistoryOperation;
  readonly category?: SettingCategory | undefined;
  readonly changedIds: readonly string[];
  readonly before: SettingsDraftCheckpoint;
  readonly after: SettingsDraftCheckpoint;
  readonly publishedRevision?: number;
}

export interface SettingsHistoryQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly order: SettingsHistoryOrder;
  readonly operation?: SettingsHistoryOperation | undefined;
  readonly category?: SettingCategory | undefined;
  readonly settingId?: string | undefined;
  /** ISO calendar date in the operator locale, for example 2026-08-18. */
  readonly date?: string | undefined;
}

export interface SettingsHistoryPage {
  readonly items: readonly SettingsHistoryEntry[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
}

export function createSettingsHistoryEntry(entry: SettingsHistoryEntry): SettingsHistoryEntry {
  return {
    ...entry,
    changedIds: unique(entry.changedIds),
    before: cloneCheckpoint(entry.before),
    after: cloneCheckpoint(entry.after),
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
