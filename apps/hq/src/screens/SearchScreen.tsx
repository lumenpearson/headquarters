'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { TerminalButton, TerminalInput } from '@gremuchaya/ui/primitives';

import { EmptyState, Panel, SeverityBadge, StatusBadge } from '@/components/operations/OpsUi';
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

export function SearchScreen() {
  const router = useRouter();
  const inputRef = useRef<HTMLElement>(null);
  const state = useOperationsStore((value) => value);
  useEffect(() => inputRef.current?.focus(), []);
  const query = state.ui.searchQuery.trim().toLocaleLowerCase('ru-RU');
  const hits = useMemo<SearchHit[]>(() => {
    if (query.length === 0) return [];
    const includes = (value: string) => value.toLocaleLowerCase('ru-RU').includes(query);
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
          detail: `${item.source} · ${new Date(item.timestamp).toLocaleString('ru-RU')}`,
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

  const openHit = (hit: SearchHit) => {
    if (hit.kind === 'file') state.selectFile(hit.id);
    if (hit.kind === 'event' || hit.kind === 'alert') state.openDrawer(hit.kind, hit.id);
    if (hit.href !== undefined) router.push(hit.href);
  };

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
      <div className="search-layout">
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
                <TerminalButton onClick={() => state.setSearchQuery('альфа')}>АЛЬФА</TerminalButton>
              </p>
              <span>CTRL+K — ОТКРЫТЬ ПОИСК ИЗ ЛЮБОГО РАЗДЕЛА</span>
            </div>
          ) : hits.length === 0 ? (
            <EmptyState>СОВПАДЕНИЙ НЕ НАЙДЕНО</EmptyState>
          ) : (
            <div className="search-hit-list">
              {hits.map((hit, index) => (
                <TerminalButton key={`${hit.kind}-${hit.id}-${index}`} onClick={() => openHit(hit)}>
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
      </div>
    </div>
  );
}
