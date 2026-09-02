'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { t } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import type {
  GroupSettingsHistoryEntry,
  GroupSettingsPort,
} from '@/application/sync/groupSettingsPort';
import {
  currentGroupRuntime,
  noGroupRuntime,
  subscribeGroupRuntime,
} from '@/components/sync/groupRuntimeHolder';

/**
 * How many rows one page asks for. The server defaults to 50 and caps at 200;
 * this list sits in a side panel beside the local ledger's six, so a page it
 * can show without a scrollbar of its own is the honest size.
 */
const pageSize = 10;

export type GroupSettingsHistoryStatus =
  /** No group session, or the scope filter is not asking for the group. */
  'unavailable' | 'loading' | 'ready' | 'failed';

export interface GroupSettingsHistoryView {
  readonly status: GroupSettingsHistoryStatus;
  /** Every row loaded so far, newest first, in the order the server sent them. */
  readonly entries: readonly GroupSettingsHistoryEntry[];
  readonly hasMore: boolean;
  readonly failure: string;
  /** Loads the next page and appends it. A no-op while one is in flight. */
  readonly loadMore: () => void;
  /** Drops everything and re-reads from the newest row. */
  readonly reload: () => void;
}

/**
 * What has been read, and which ledger it was read from.
 *
 * The key is carried *inside* the state rather than reset by an effect. A
 * ledger belongs to one group and one reload; when either changes, the rows on
 * screen are no longer about the ledger being asked for, and the empty state is
 * derived during render instead of written by a `setState` in an effect body --
 * which would be the cascading render `react-hooks/set-state-in-effect` names.
 */
interface Ledger {
  readonly key: string;
  readonly entries: readonly GroupSettingsHistoryEntry[];
  readonly cursor: string;
  readonly hasMore: boolean;
  readonly status: GroupSettingsHistoryStatus;
  readonly failure: string;
}

function emptyLedger(key: string, status: GroupSettingsHistoryStatus): Ledger {
  return { key, entries: [], cursor: '', hasMore: false, status, failure: '' };
}

/**
 * The group's settings ledger, paged forward (R29, the group half).
 *
 * It is a *different shape* from the local ledger and is deliberately not
 * flattened into it. `querySettingsHistory` pages by number over an array it
 * holds entirely, so it can answer "page 3 of 7, 41 events". `ListSettingsHistory`
 * is a keyset read over `(occurred_at, id)` and answers only "here are ten
 * rows, and there are more": `previousCursor` is always empty and
 * `approximateTotal` is always `0`, because a `COUNT` over a table that grows
 * without bound would be a second statement on every page.
 *
 * So this hook offers exactly what the server offers -- forward, one page at a
 * time, with no total and no page count. A page number derived from the rows
 * loaded so far would be a number nobody computed, and on a shoot day the
 * operator reading it would have no way to tell.
 */
export function useGroupSettingsHistory(enabled: boolean): GroupSettingsHistoryView {
  const group = useSyncExternalStore(subscribeGroupRuntime, currentGroupRuntime, noGroupRuntime);
  const port = group === null ? null : group.settings;
  const [generation, setGeneration] = useState(0);
  const key = ledgerKey(generation, enabled, group?.groupId ?? '', port);
  const [stored, setStored] = useState<Ledger>(() => emptyLedger(key, 'unavailable'));
  /** Guards a second read while one is in flight, without a re-render. */
  const loading = useRef(false);

  // Derived, not written: a ledger for another group or another reload is
  // simply not this one's, and the empty state stands until the read lands.
  const ledger =
    stored.key === key
      ? stored
      : emptyLedger(key, port === null || !enabled ? 'unavailable' : 'loading');

  useEffect(() => {
    if (port === null || !enabled) return;
    const controller = new AbortController();
    loading.current = true;
    void port
      .listGroupHistory({ cursor: '', pageSize }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setStored({
          key,
          entries: page.entries,
          cursor: page.nextCursor,
          hasMore: page.hasMore,
          status: 'ready',
          failure: '',
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStored({ ...emptyLedger(key, 'failed'), failure: describe(error) });
      })
      .finally(() => {
        loading.current = false;
      });
    return () => controller.abort();
  }, [enabled, key, port]);

  const loadMore = useCallback(() => {
    if (port === null || loading.current || !ledger.hasMore || ledger.cursor === '') return;
    const cursor = ledger.cursor;
    loading.current = true;
    void port
      .listGroupHistory({ cursor, pageSize })
      .then((page) => {
        // Appended rather than replaced: the operator is reading backwards
        // through time and the rows already on screen are still true. The key
        // guards the append, so a page that lands after a reload is dropped
        // rather than stitched onto a ledger it does not belong to.
        setStored((previous) =>
          previous.key !== key
            ? previous
            : {
                ...previous,
                entries: [...previous.entries, ...page.entries],
                cursor: page.nextCursor,
                hasMore: page.hasMore,
              },
        );
      })
      .catch((error: unknown) => {
        setStored((previous) =>
          previous.key !== key
            ? previous
            : { ...previous, status: 'failed', failure: describe(error) },
        );
      })
      .finally(() => {
        loading.current = false;
      });
  }, [key, ledger.cursor, ledger.hasMore, port]);

  const reload = useCallback(() => {
    setGeneration((previous) => previous + 1);
  }, []);

  return useMemo(
    () => ({
      status: ledger.status,
      entries: ledger.entries,
      hasMore: ledger.hasMore,
      failure: ledger.failure,
      loadMore,
      reload,
    }),
    [ledger.entries, ledger.failure, ledger.hasMore, ledger.status, loadMore, reload],
  );
}

/**
 * What identifies one ledger.
 *
 * The port instance is not part of it. Two clients for the same group answer
 * the same rows, and keying on the object would re-read the ledger every time
 * the runtime rebuilt one -- which it does whenever the connection's
 * capabilities change.
 */
function ledgerKey(
  generation: number,
  enabled: boolean,
  groupId: string,
  port: GroupSettingsPort | null,
): string {
  return `${generation}|${enabled ? 'on' : 'off'}|${groupId}|${port === null ? 'none' : 'port'}`;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message.length === 0
    ? t('settings.groupHistoryUnavailableError')
    : t('settings.groupHistoryError', { message });
}

/**
 * The server's operation vocabulary, for the operator, keyed by the exact
 * string the server sends rather than by a union: {@link groupHistoryOperationLabel}
 * shows an operation this table has no entry for verbatim, which a
 * `Record<Union, MessageId>` cannot do (there would be no union member to hold
 * the unknown case).
 *
 * Not mapped onto the local ledger's words. `RESET_ELEMENT` and
 * `REVERT_SETTINGS_VERSION` have no local counterpart, and `undo`/`redo` have
 * no server one; a label that borrowed across would put a word in the history
 * that nothing actually did. An operation this build does not know is shown
 * verbatim rather than as "прочее", because a newer control plane naming a new
 * one is still telling the truth.
 */
const groupHistoryOperationMessageIds: Readonly<Record<string, MessageId>> = {
  APPLY_DRAFT_PATCH: 'settings.groupHistoryOperationApplyDraftPatch',
  DISCARD_DRAFT: 'settings.groupHistoryOperationDiscardDraft',
  PUBLISH_DRAFT: 'settings.groupHistoryOperationPublishDraft',
  RESET_CATEGORY: 'settings.groupHistoryOperationResetCategory',
  RESET_ELEMENT: 'settings.groupHistoryOperationResetElement',
  RESET_ALL: 'settings.groupHistoryOperationResetAll',
  IMPORT_SETTINGS: 'settings.groupHistoryOperationImportSettings',
  REVERT_SETTINGS_VERSION: 'settings.groupHistoryOperationRevertVersion',
};

export function groupHistoryOperationLabel(operation: string): string {
  const id = groupHistoryOperationMessageIds[operation];
  return id === undefined ? operation : t(id);
}
