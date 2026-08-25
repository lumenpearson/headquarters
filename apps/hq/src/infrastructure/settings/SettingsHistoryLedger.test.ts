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

describe('the scope a change reaches', () => {
  const checkpoint = { values: {}, changedIds: [] };
  const entry = (id: string, changedIds: readonly string[]) =>
    createSettingsHistoryEntry({
      id,
      at: `2026-08-25T10:0${id}:00.000Z`,
      operation: 'patch',
      changedIds,
      before: checkpoint,
      after: checkpoint,
    });

  it('derives the scope from the definitions a change names', () => {
    // `SettingScope` has carried 'group' since the schema was written and
    // decided nothing anywhere (C23). It decides this.
    expect(entry('1', ['layout.density']).scope).toBe('device');
    expect(entry('2', ['advanced.liveEdit']).scope).toBe('group');
    // A change that touches both reaches the group, because part of it does.
    expect(entry('3', ['layout.density', 'github.draftOnly']).scope).toBe('group');
    // An id the schema does not know reaches nothing.
    expect(entry('4', ['not.a.setting']).scope).toBe('device');
  });

  it('recomputes the scope rather than trusting what it was handed', () => {
    const forged = createSettingsHistoryEntry({
      id: '5',
      at: '2026-08-25T10:05:00.000Z',
      operation: 'patch',
      changedIds: ['layout.density'],
      scope: 'group',
      before: checkpoint,
      after: checkpoint,
    });

    // A stored entry cannot disagree with the definitions it names.
    expect(forged.scope).toBe('device');
  });

  it('filters the history by the scope a change reached', () => {
    const entries = [entry('1', ['layout.density']), entry('2', ['advanced.liveEdit'])];

    const group = querySettingsHistory(entries, {
      page: 1,
      pageSize: 10,
      order: 'newest',
      scope: 'group',
    });
    const device = querySettingsHistory(entries, {
      page: 1,
      pageSize: 10,
      order: 'newest',
      scope: 'device',
    });

    // The operator's question is which of their changes will propagate once a
    // group exists, and which are only ever local.
    expect(group.items.map((item) => item.id)).toEqual(['2']);
    expect(device.items.map((item) => item.id)).toEqual(['1']);
    expect(group.total).toBe(1);
  });
});
