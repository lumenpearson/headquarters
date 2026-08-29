// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { GroupChannel, GroupSessionCommand } from '@/application/sync/groupChannel';
import type {
  GroupSettingsDocument,
  GroupSettingsHistoryEntry,
  GroupSettingsHistoryPage,
  GroupSettingsPort,
} from '@/application/sync/groupSettingsPort';
import { setGroupRuntime } from '@/components/sync/groupRuntimeHolder';

import { groupHistoryOperationLabel, useGroupSettingsHistory } from './useGroupSettingsHistory';

/** The channel is irrelevant here; the holder simply requires one. */
const channel: GroupChannel = {
  groupId: 'group-a',
  deviceId: 'device-a',
  async publishDocumentDelta() {
    return { sequence: 1n, stateVector: new Uint8Array(0) };
  },
  async publishSessionCommand(): Promise<GroupSessionCommand> {
    throw new Error('not used');
  },
  subscribe() {
    return () => undefined;
  },
};

function entry(id: string, operation: string): GroupSettingsHistoryEntry {
  return {
    id,
    at: '2026-08-26T09:00:00.000Z',
    operation,
    category: 'telemetry',
    elementId: 'telemetry.source',
    changedIds: ['telemetry.source'],
    revision: 3,
    actorDeviceId: 'device-b',
  };
}

/**
 * A ledger that answers only forward, exactly as `ListSettingsHistory` does:
 * a cursor and a flag, never a total. A fake that reported one would let a
 * hook inventing a page count pass.
 */
function fakeSettings(pages: readonly GroupSettingsHistoryPage[]): GroupSettingsPort {
  return {
    async getEffectiveSettings(): Promise<GroupSettingsDocument> {
      return { revision: 1, values: {}, updatedAt: '' };
    },
    async applyGroupDraftPatch(): Promise<GroupSettingsDocument> {
      throw new Error('not used');
    },
    async publishGroupDraft(): Promise<GroupSettingsDocument> {
      throw new Error('not used');
    },
    async resetGroupElement(): Promise<GroupSettingsDocument> {
      throw new Error('not used');
    },
    async listGroupHistory(query) {
      // The cursor is opaque to the client, so the fake resolves it the way
      // the server does: by finding the page whose predecessor issued it.
      const index = pages.findIndex((_page, position) =>
        position === 0 ? query.cursor === '' : pages[position - 1]?.nextCursor === query.cursor,
      );
      return pages[index] ?? { entries: [], nextCursor: '', hasMore: false };
    },
    async *watchSettings() {
      // Unused by this hook.
    },
  };
}

function join(settings: GroupSettingsPort): void {
  act(() => {
    setGroupRuntime({
      groupId: 'group-a',
      deviceId: 'device-a',
      channel,
      delivery: 'socket',
      settings,
    });
  });
}

describe('useGroupSettingsHistory', () => {
  afterEach(() => {
    setGroupRuntime(null);
  });

  it('says there is nothing to read while this session is not in a group', () => {
    setGroupRuntime(null);
    const { result } = renderHook(() => useGroupSettingsHistory(true));
    expect(result.current.status).toBe('unavailable');
    expect(result.current.entries).toEqual([]);
  });

  it('reads nothing until the scope filter asks for the group', async () => {
    join(
      fakeSettings([{ entries: [entry('a', 'PUBLISH_DRAFT')], nextCursor: '', hasMore: false }]),
    );
    const { result } = renderHook(() => useGroupSettingsHistory(false));

    await Promise.resolve();
    expect(result.current.status).toBe('unavailable');
    expect(result.current.entries).toEqual([]);
  });

  it('appends the next page instead of replacing what is on screen', async () => {
    join(
      fakeSettings([
        { entries: [entry('a', 'APPLY_DRAFT_PATCH')], nextCursor: 'cursor-2', hasMore: true },
        { entries: [entry('b', 'RESET_ELEMENT')], nextCursor: '', hasMore: false },
      ]),
    );
    const { result } = renderHook(() => useGroupSettingsHistory(true));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.entries.map((row) => row.id)).toEqual(['a']);
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(result.current.entries.map((row) => row.id)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(false);
  });

  it('offers no total and no page count, because the server reports neither', async () => {
    join(
      fakeSettings([
        { entries: [entry('a', 'APPLY_DRAFT_PATCH')], nextCursor: 'cursor-2', hasMore: true },
      ]),
    );
    const { result } = renderHook(() => useGroupSettingsHistory(true));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(Object.keys(result.current).sort()).toEqual([
      'entries',
      'failure',
      'hasMore',
      'loadMore',
      'reload',
      'status',
    ]);
  });

  it('starts the ledger over on reload rather than carrying a stale cursor', async () => {
    join(
      fakeSettings([
        { entries: [entry('a', 'APPLY_DRAFT_PATCH')], nextCursor: 'cursor-2', hasMore: true },
        { entries: [entry('b', 'RESET_ELEMENT')], nextCursor: '', hasMore: false },
      ]),
    );
    const { result } = renderHook(() => useGroupSettingsHistory(true));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries.map((row) => row.id)).toEqual(['a']);
  });
});

describe('groupHistoryOperationLabel', () => {
  it('keeps an operation the client vocabulary has no word for', () => {
    expect(groupHistoryOperationLabel('REVERT_SETTINGS_VERSION')).toBe('ВОЗВРАТ К РЕВИЗИИ');
    expect(groupHistoryOperationLabel('RESET_ELEMENT')).toBe('СБРОС ПАРАМЕТРА');
  });

  it('shows an operation this build does not know verbatim rather than as "other"', () => {
    expect(groupHistoryOperationLabel('SOMETHING_A_NEWER_SERVER_DOES')).toBe(
      'SOMETHING_A_NEWER_SERVER_DOES',
    );
  });
});
