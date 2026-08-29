'use client';

import {
  getVirtualPathSegments,
  screenIds,
  type ExplorerNode,
  type ScreenId,
} from '@gremuchaya/domain';
import { TerminalButton, TerminalInput, TerminalSelect } from '@gremuchaya/ui/primitives';
import type { TerminalSelectOption } from '@gremuchaya/ui/primitives';
import { useMemo, useState } from 'react';

import { compareText, dateTimeFormat, foldCase } from '@/application/localization/intl';
import { useAppLocale } from '@/application/localization/locale';
import { useRuntime } from '@/components/runtime/RuntimeProvider';
import { useAppStore } from '@/state/appStore';

const explorerFilterOptions = [
  { value: 'all', label: 'ВСЕ ТИПЫ' },
  { value: 'documents', label: 'ДОКУМЕНТЫ' },
  { value: 'images', label: 'ИЗОБРАЖЕНИЯ' },
  { value: 'video', label: 'ВИДЕО' },
] as const;

const explorerSortOptions = [
  { value: 'name', label: 'ИМЯ' },
  { value: 'modifiedAt', label: 'ДАТА' },
  { value: 'size', label: 'РАЗМЕР' },
  { value: 'kind', label: 'ТИП' },
] as const;

const screenOptions: ReadonlyArray<TerminalSelectOption<ScreenId>> = screenIds.map((screenId) => ({
  value: screenId,
  label: screenId,
}));

export function VirtualExplorer() {
  // The subscription behind `formatDate` and `filterAndSort` below: both read
  // the locale at the moment they are called, and this component's other
  // selectors would not notice it moving.
  useAppLocale();
  const { controller } = useRuntime();
  const explorer = useAppStore((state) => state.explorer);
  const bridgeStatus = useAppStore((state) => state.connections.bridgeStatus);
  const lastFilesystemEvent = useAppStore((state) => state.connections.lastFilesystemEvent);
  const [targetScreen, setTargetScreen] = useState<ScreenId>('wall-center');
  const selected = explorer.nodes.find((node) => node.id === explorer.selectedNodeId) ?? null;
  const visibleNodes = useMemo(
    () =>
      filterAndSort(
        explorer.nodes,
        explorer.searchQuery,
        explorer.filter,
        explorer.sortBy,
        explorer.sortDirection,
      ),
    [explorer],
  );
  const segments = getVirtualPathSegments(explorer.activePath);

  const connectDirectory = async () => {
    if (controller === null) return;
    await controller.browserDirectory.connect();
    await controller.navigate(explorer.activePath);
  };

  return (
    <section className="virtual-explorer">
      <header className="explorer-toolbar">
        <div className="explorer-history">
          <TerminalButton
            onClick={() =>
              controller &&
              void controller.navigate(controller.explorerService.parent(explorer.activePath))
            }
          >
            [..]
          </TerminalButton>
          <TerminalButton
            onClick={() => controller && void controller.navigate(explorer.activePath)}
          >
            [R]
          </TerminalButton>
        </div>
        <div className="breadcrumbs">
          <TerminalButton onClick={() => controller && void controller.navigate('/')}>
            ~HQ
          </TerminalButton>
          {segments.map((segment, index) => (
            <span key={`${segment}-${index}`}>
              /{' '}
              <TerminalButton
                onClick={() =>
                  controller &&
                  void controller.navigate(`/${segments.slice(0, index + 1).join('/')}`)
                }
              >
                {segment}
              </TerminalButton>
            </span>
          ))}
        </div>
        <label className="explorer-search">
          <span>/</span>
          <TerminalInput
            value={explorer.searchQuery}
            onChange={(event) => controller?.setExplorerQuery(event.target.value)}
            aria-label="Поиск в материалах"
            placeholder="Поиск в материалах"
          />
        </label>
        <TerminalButton className="connect-button" onClick={() => void connectDirectory()}>
          [+] MOUNT DIR
        </TerminalButton>
      </header>
      <div className="explorer-layout">
        <aside className="explorer-tree">
          <span>БЫСТРЫЙ ДОСТУП</span>
          {['/ДЕЛА', '/МЕДИА', '/КАРТЫ', '/ПОДКЛЮЧЕННЫЕ МАТЕРИАЛЫ'].map((path) => (
            <TerminalButton key={path} onClick={() => controller && void controller.navigate(path)}>
              <i>[D]</i>
              {path.slice(1)}
            </TerminalButton>
          ))}
          <span>ИСТОЧНИКИ</span>
          {Object.entries(explorer.sourceStatuses).map(([source, status]) => (
            <div className="source-state" key={source}>
              <i className={`source-state--${status}`} />
              {source}
              <small>{status}</small>
            </div>
          ))}
          <div className="source-state source-state--bridge">
            <i className={`source-state--${bridgeStatus}`} />
            МОСТ ФАЙЛОВ
            <small>{bridgeStatus}</small>
          </div>
          <span>ПОСЛЕДНЕЕ СОБЫТИЕ</span>
          <div className="source-state source-state--last-event">
            <small>{lastFilesystemEvent ?? 'НЕТ СОБЫТИЙ'}</small>
          </div>
        </aside>
        <main className="explorer-main">
          <div className="explorer-controls">
            <span>{visibleNodes.length} ОБЪЕКТОВ</span>
            <div>
              <TerminalSelect
                value={explorer.filter}
                options={explorerFilterOptions}
                onValueChange={(value) =>
                  controller?.setExplorerOption('filter', value as typeof explorer.filter)
                }
                label="Фильтр материалов"
              />
              <TerminalSelect
                value={explorer.sortBy}
                options={explorerSortOptions}
                onValueChange={(value) =>
                  controller?.setExplorerOption('sortBy', value as typeof explorer.sortBy)
                }
                label="Сортировка материалов"
              />
            </div>
          </div>
          {explorer.loading ? (
            <div className="explorer-empty">СКАНИРОВАНИЕ ИСТОЧНИКОВ…</div>
          ) : visibleNodes.length === 0 ? (
            <div className="explorer-empty">
              <i>[ ]</i>
              <strong>ПАПКА ПУСТА</strong>
              <span>Подключите источник или вернитесь в корень.</span>
            </div>
          ) : (
            <div className={explorer.viewMode === 'grid' ? 'file-grid' : 'file-list'}>
              {explorer.viewMode === 'list' ? (
                <div className="file-list__head">
                  <span>ИМЯ</span>
                  <span>ИЗМЕНЁН</span>
                  <span>ТИП</span>
                  <span>РАЗМЕР</span>
                </div>
              ) : null}
              {visibleNodes.map((node) => (
                <FileRow
                  key={node.id}
                  node={node}
                  selected={node.id === explorer.selectedNodeId}
                  onSelect={() => controller?.selectNode(node.id)}
                  onOpen={() => controller && void controller.openNode(node)}
                />
              ))}
            </div>
          )}
        </main>
        <aside className="explorer-preview">
          {selected === null ? (
            <div className="preview-empty">
              <i>[..]</i>
              <span>ВЫБЕРИТЕ МАТЕРИАЛ</span>
            </div>
          ) : (
            <>
              <div className="preview-visual">
                <i>{iconForNode(selected)}</i>
                <span>{selected.iconHint ?? selected.kind}</span>
              </div>
              <h3>{selected.name}</h3>
              <dl>
                <dt>ПУТЬ</dt>
                <dd>{selected.path}</dd>
                <dt>ИСТОЧНИК</dt>
                <dd>{sourceForNode(selected)}</dd>
                <dt>РАЗМЕР</dt>
                <dd>{formatBytes(selected.displaySize)}</dd>
                <dt>ИЗМЕНЁН</dt>
                <dd>{formatDate(selected.modifiedAt)}</dd>
              </dl>
              <TerminalButton
                className="primary-action"
                onClick={() => controller && void controller.openNode(selected)}
              >
                ОТКРЫТЬ В РАБОЧЕЙ ОБЛАСТИ
              </TerminalButton>
              <div className="send-row">
                <TerminalSelect
                  value={targetScreen}
                  options={screenOptions}
                  onValueChange={setTargetScreen}
                  label="Целевой экран"
                />
                <TerminalButton
                  onClick={() => controller?.sendNodeToScreen(selected, targetScreen)}
                >
                  &gt; SCREEN
                </TerminalButton>
              </div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function FileRow({
  node,
  selected,
  onSelect,
  onOpen,
}: {
  readonly node: ExplorerNode;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
}) {
  return (
    <TerminalButton
      className={`file-row ${selected ? 'is-selected' : ''}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <i>{iconForNode(node)}</i>
      <span className="file-row__name">
        <strong>{node.name}</strong>
        <small>{node.tags?.join(' · ')}</small>
      </span>
      <span>{formatDate(node.modifiedAt)}</span>
      <span>{node.iconHint ?? node.kind}</span>
      <span>{formatBytes(node.displaySize)}</span>
    </TerminalButton>
  );
}

function filterAndSort(
  nodes: readonly ExplorerNode[],
  query: string,
  filter: string,
  sortBy: string,
  direction: 'asc' | 'desc',
): readonly ExplorerNode[] {
  const normalized = foldCase(query.trim());
  const filtered = nodes.filter((node) => {
    if (
      normalized !== '' &&
      !foldCase(`${node.name} ${node.tags?.join(' ') ?? ''}`).includes(normalized)
    )
      return false;
    if (filter === 'images') return node.iconHint === 'photo';
    if (filter === 'video') return node.iconHint === 'video';
    if (filter === 'documents') return node.iconHint === 'document' || node.iconHint === 'case';
    return true;
  });
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...filtered].sort((left, right) => {
    if (sortBy === 'size') return ((left.displaySize ?? 0) - (right.displaySize ?? 0)) * multiplier;
    if (sortBy === 'modifiedAt')
      return (left.modifiedAt ?? '').localeCompare(right.modifiedAt ?? '') * multiplier;
    if (sortBy === 'kind') return left.kind.localeCompare(right.kind) * multiplier;
    return compareText(left.name, right.name) * multiplier;
  });
}

function iconForNode(node: ExplorerNode): string {
  if (node.kind === 'real-directory' || node.kind === 'emulated-directory' || node.kind === 'mount')
    return '[D]';
  if (node.iconHint === 'photo') return '[I]';
  if (node.iconHint === 'video') return '[V]';
  if (node.iconHint === 'map') return '[M]';
  if (node.iconHint === 'graph') return '[G]';
  return '[F]';
}

function sourceForNode(node: ExplorerNode): string {
  if (node.kind === 'real-file' || node.kind === 'real-directory' || node.kind === 'mount')
    return node.sourceId;
  return 'emulated';
}

function formatBytes(value?: number): string {
  if (value === undefined) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value?: string): string {
  return value === undefined
    ? '—'
    : dateTimeFormat({
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value));
}
