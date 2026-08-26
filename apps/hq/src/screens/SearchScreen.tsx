'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { TerminalButton, TerminalInput } from '@gremuchaya/ui/primitives';

import { dateTimeFormat, foldCase } from '@/application/localization/intl';
import { EmptyState, Panel, SeverityBadge, StatusBadge } from '@/components/operations/OpsUi';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { useOperationsStore } from '@/state/operationsStore';

type SearchHit = {
  readonly id: string;
  readonly kind: 'object' | 'case' | 'file' | 'event' | 'alert';
  readonly title: string;
  readonly detail: string;
  readonly href?: string;
  readonly severity?: 'info' | 'normal' | 'warning' | 'critical';
  readonly status?: Parameters<typeof StatusBadge>[0]['status'];
};

/** What `toLocaleString()` printed, named rather than left implicit. */
const stampParts = { dateStyle: 'short', timeStyle: 'medium' } as const;

export function SearchScreen() {
  const router = useRouter();
  const inputRef = useRef<HTMLElement>(null);
  const state = useOperationsStore((value) => value);
  useEffect(() => inputRef.current?.focus(), []);
  const query = foldCase(state.ui.searchQuery.trim());
  const hits = useMemo<SearchHit[]>(() => {
    if (query.length === 0) return [];
    const includes = (value: string) => foldCase(value).includes(query);
    return [
      ...Object.values(state.objects)
        .filter((item) => includes(`${item.id} ${item.name} ${item.callsign} ${item.sectorId}`))
        .map((item) => ({
          id: item.id,
          kind: 'object' as const,
          title: `${item.id} / ${item.name}`,
          detail: `${item.kind} · ${item.sectorId} · ${item.callsign}`,
          href: `/objects/${item.id}`,
          status: item.status,
        })),
      ...Object.values(state.cases)
        .filter((item) => includes(`${item.id} ${item.code} ${item.title} ${item.tags.join(' ')}`))
        .map((item) => ({
          id: item.id,
          kind: 'case' as const,
          title: item.title,
          detail: `${item.code} · ${item.source}`,
          href: `/cases/${item.id}`,
          status: item.status,
        })),
      ...Object.values(state.attachments)
        .filter((item) =>
          includes(`${item.id} ${item.title} ${item.tags.join(' ')} ${item.source}`),
        )
        .map((item) => ({
          id: item.id,
          kind: 'file' as const,
          title: item.title,
          detail: `${item.kind} · ${item.source} · ${item.sizeLabel}`,
          href: '/files',
          status: item.status,
        })),
      ...state.events
        .filter((item) => includes(`${item.id} ${item.title} ${item.description} ${item.source}`))
        .slice(0, 30)
        .map((item) => ({
          id: item.id,
          kind: 'event' as const,
          title: item.title,
          detail: `${item.source} · ${dateTimeFormat(stampParts).format(new Date(item.timestamp))}`,
          severity: item.severity,
        })),
      ...Object.values(state.alerts)
        .filter((item) => includes(`${item.id} ${item.title} ${item.description} ${item.source}`))
        .map((item) => ({
          id: item.id,
          kind: 'alert' as const,
          title: item.title,
          detail: `${item.source} · ${item.sectorId} · ${item.lifecycle}`,
          severity: item.level,
        })),
    ].slice(0, 80);
  }, [query, state.alerts, state.attachments, state.cases, state.events, state.objects]);

  // Stable, because the tiles depend on it: redefined every render it would
  // rebuild both panels on every keystroke in the search field.
  const openHit = useCallback(
    (hit: SearchHit) => {
      if (hit.kind === 'file') state.selectFile(hit.id);
      if (hit.kind === 'event' || hit.kind === 'alert') state.openDrawer(hit.kind, hit.id);
      if (hit.href !== undefined) router.push(hit.href);
    },
    [router, state],
  );

  /*
   * Priority here expresses the arrangement, not the order tiles would be
   * given up in. On a master-detail screen the tiles total exactly twelve
   * columns, so every one of them is placed even in a single-row grid --
   * measured at 1024x768 through 2560x1440, nothing is ever displaced -- and
   * the drop order priority also encodes is unreachable. What the operator
   * does notice is the reading order, and the resolver places the highest
   * priority leftmost.
   */
  const tiles: readonly ScreenTile[] = useMemo(
    () => [
      {
        title: 'РЕЗУЛЬТАТЫ',
        category: 'records',
        descriptor: {
          id: 'results',
          priority: 100,
          variants: [
            { presentation: 'full', columns: 9, rows: 1 },
            { presentation: 'compact', columns: 7, rows: 1 },
          ],
          canStretchHorizontally: true,
          canStretchVertically: true,
        },
        render: () => (
          <Panel
            title="РЕЗУЛЬТАТЫ"
            eyebrow="UNIFIED SEARCH / ALL ENTITIES"
            className="search-results"
          >
            {query.length === 0 ? (
              <div className="search-help">
                <strong>БЫСТРЫЙ ПОИСК</strong>
                <p>
                  Попробуйте:{' '}
                  <TerminalButton onClick={() => state.setSearchQuery('K-17')}>K-17</TerminalButton>{' '}
                  <TerminalButton onClick={() => state.setSearchQuery('S-03')}>S-03</TerminalButton>{' '}
                  <TerminalButton onClick={() => state.setSearchQuery('сигнал')}>
                    СИГНАЛ
                  </TerminalButton>{' '}
                  <TerminalButton onClick={() => state.setSearchQuery('альфа')}>
                    АЛЬФА
                  </TerminalButton>
                </p>
                <span>CTRL+K — ОТКРЫТЬ ПОИСК ИЗ ЛЮБОГО РАЗДЕЛА</span>
              </div>
            ) : hits.length === 0 ? (
              <EmptyState>СОВПАДЕНИЙ НЕ НАЙДЕНО</EmptyState>
            ) : (
              <div className="search-hit-list">
                {hits.map((hit, index) => (
                  <TerminalButton
                    key={`${hit.kind}-${hit.id}-${index}`}
                    onClick={() => openHit(hit)}
                  >
                    <i>[{hit.kind.slice(0, 3).toUpperCase()}]</i>
                    <span>
                      <strong>{hit.title}</strong>
                      <small>{hit.detail}</small>
                    </span>
                    {hit.status === undefined ? (
                      hit.severity === undefined ? null : (
                        <SeverityBadge severity={hit.severity} />
                      )
                    ) : (
                      <StatusBadge status={hit.status} />
                    )}
                    <b>ENTER ›</b>
                  </TerminalButton>
                ))}
              </div>
            )}
          </Panel>
        ),
      },
      {
        title: 'ИНДЕКС',
        category: 'summary',
        descriptor: {
          id: 'index',
          priority: 80,
          variants: [
            { presentation: 'full', columns: 3, rows: 1 },
            { presentation: 'minimal', columns: 2, rows: 1 },
          ],
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel title="ИНДЕКС" eyebrow="LOCAL DATASET" className="search-index">
            <dl>
              <div>
                <dt>ОБЪЕКТЫ</dt>
                <dd>{Object.keys(state.objects).length}</dd>
              </div>
              <div>
                <dt>ДЕЛА</dt>
                <dd>{Object.keys(state.cases).length}</dd>
              </div>
              <div>
                <dt>МАТЕРИАЛЫ</dt>
                <dd>{Object.keys(state.attachments).length}</dd>
              </div>
              <div>
                <dt>СОБЫТИЯ</dt>
                <dd>{state.events.length}</dd>
              </div>
              <div>
                <dt>ТРЕВОГИ</dt>
                <dd>{Object.keys(state.alerts).length}</dd>
              </div>
            </dl>
            <footer>
              INDEX: READY
              <br />
              STORAGE: LOCAL
              <br />
              NETWORK: NOT REQUIRED
            </footer>
          </Panel>
        ),
      },
    ],
    [hits, openHit, query, state],
  );

  return (
    <div className="ops-screen search-screen">
      <header className="search-command">
        <span>GLOBAL INDEX //</span>
        <label>
          <i>/</i>
          <TerminalInput
            ref={inputRef}
            value={state.ui.searchQuery}
            onChange={(event) => state.setSearchQuery(event.target.value)}
            aria-label="Глобальный поиск"
            placeholder="ID, НАЗВАНИЕ, ПОЗЫВНОЙ, СЕКТОР, ТЕГ, ИСТОЧНИК..."
          />
          <kbd>ESC</kbd>
        </label>
        <small>
          {query.length === 0 ? 'ВВЕДИТЕ ЗАПРОС' : `${hits.length} СОВПАДЕНИЙ / LOCAL INDEX`}
        </small>
      </header>
      <TileGrid tiles={tiles} columns={12} className="search-layout" screen="search" />
    </div>
  );
}
