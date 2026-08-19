import { createFactorySnapshot, createSettingsDraftCheckpoint } from '@gremuchaya/settings-schema';
import { describe, expect, it } from 'vitest';

import {
  createSettingsHistoryEntry,
  querySettingsHistory,
  type SettingsHistoryEntry,
} from './SettingsHistoryLedger';

function entry(
  id: string,
  at: string,
  operation: SettingsHistoryEntry['operation'],
  changedIds: readonly string[],
): SettingsHistoryEntry {
  const snapshot = createFactorySnapshot();
  return createSettingsHistoryEntry({
    id,
    at,
    operation,
    category: operation === 'reset-category' ? 'themes' : undefined,
    changedIds,
    before: createSettingsDraftCheckpoint({
      baseRevision: 0,
      values: snapshot.values,
      changedIds: [],
      history: [],
    }),
    after: createSettingsDraftCheckpoint({
      baseRevision: 0,
      values: { ...snapshot.values, 'themes.id': 'cold-cyan' },
      changedIds,
      history: [],
    }),
  });
}

describe('SettingsHistoryLedger', () => {
  it('returns a stable filtered and paginated local history', () => {
    const entries = [
      entry('history-01', '2026-08-18T10:00:00.000Z', 'patch', ['themes.id']),
      entry('history-02', '2026-08-18T11:00:00.000Z', 'reset-category', ['themes.id']),
      entry('history-03', '2026-08-19T10:00:00.000Z', 'import', ['layout.density']),
    ];

    const page = querySettingsHistory(entries, {
      page: 1,
      pageSize: 1,
      order: 'newest',
      date: '2026-08-18',
      settingId: 'themes',
    });

    expect(page).toMatchObject({
      total: 2,
      page: 1,
      pageCount: 2,
      items: [{ id: 'history-02', operation: 'reset-category' }],
    });
  });

  it('does not leak mutable checkpoint arrays to the caller', () => {
    const source = entry('history-01', '2026-08-18T10:00:00.000Z', 'patch', ['themes.id']);
    const stored = createSettingsHistoryEntry(source);
    (source.after.changedIds as string[]).push('layout.density');

    expect(stored.after.changedIds).toEqual(['themes.id']);
  });
});
