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
import { useTranslate } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import { useRuntime } from '@/components/runtime/RuntimeProvider';
import { useAppStore } from '@/state/appStore';

const explorerFilterMessageIds = [
  { value: 'all', id: 'explorer.filterAll' },
  { value: 'documents', id: 'explorer.filterDocuments' },
  { value: 'images', id: 'explorer.filterImages' },
  { value: 'video', id: 'field.kindVideo' },
] as const satisfies ReadonlyArray<{ readonly value: string; readonly id: MessageId }>;

const explorerSortMessageIds = [
  { value: 'name', id: 'explorer.fieldName' },
  { value: 'modifiedAt', id: 'files.sortDate' },
  { value: 'size', id: 'field.size' },
  { value: 'kind', id: 'field.type' },
] as const satisfies ReadonlyArray<{ readonly value: string; readonly id: MessageId }>;

/*
 * The four quick-access shortcuts a picker offers, each a virtual path and
 * the id of the word drawn for it. The path is what `controller.navigate`
 * takes and stays exactly as `ExplorerService` addresses it in every locale
 * -- only the label an operator reads changes with `localization.locale`.
 */
const quickAccessEntries = [
  { path: '/ДЕЛА', id: 'field.cases' },
  { path: '/МЕДИА', id: 'explorer.quickAccessMedia' },
  { path: '/КАРТЫ', id: 'explorer.quickAccessMaps' },
  { path: '/ПОДКЛЮЧЕННЫЕ МАТЕРИАЛЫ', id: 'explorer.quickAccessConnectedMaterials' },
] as const satisfies ReadonlyArray<{ readonly path: string; readonly id: MessageId }>;

type SourceStatus = 'online' | 'offline' | 'permission-required' | 'empty';

const sourceStatusMessageIds: Readonly<Record<SourceStatus, MessageId>> = {
  online: 'explorer.status.online',
  offline: 'explorer.status.offline',
  'permission-required': 'explorer.sourceStatus.permissionRequired',
  empty: 'explorer.sourceStatus.empty',
};

type BridgeStatus = 'online' | 'connecting' | 'offline' | 'incompatible';

const bridgeStatusMessageIds: Readonly<Record<BridgeStatus, MessageId>> = {
  online: 'explorer.status.online',
  connecting: 'explorer.bridgeStatus.connecting',
  offline: 'explorer.status.offline',
  incompatible: 'explorer.bridgeStatus.incompatible',
};

export function VirtualExplorer() {
  // The subscription behind `formatDate` and `filterAndSort` below, as well
  // as every `translate` call in this component: all three read the locale at
  // the moment they are called, and this component's other selectors would
  // not notice it moving.
  const translate = useTranslate();
  const screenOptions: ReadonlyArray<TerminalSelectOption<ScreenId>> = screenIds.map(
    (screenId) => ({ value: screenId, label: screenId }),
  );
  const explorerFilterOptions = explorerFilterMessageIds.map(({ value, id }) => ({
    value,
    label: translate(id),
  }));
  const explorerSortOptions = explorerSortMessageIds.map(({ value, id }) => ({
    value,
    label: translate(id),
  }));
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
            aria-label={translate('explorer.searchLabel')}
            placeholder={translate('explorer.searchLabel')}
          />
        </label>
        <TerminalButton className="connect-button" onClick={() => void connectDirectory()}>
          {translate('explorer.mountButton')}
        </TerminalButton>
      </header>
      <div className="explorer-layout">
        <aside className="explorer-tree">
          <span>{translate('explorer.quickAccessHeading')}</span>
          {quickAccessEntries.map((entry) => (
            <TerminalButton
              key={entry.path}
              onClick={() => controller && void controller.navigate(entry.path)}
            >
              <i>[D]</i>
              {translate(entry.id)}
            </TerminalButton>
          ))}
          <span>{translate('explorer.sourcesHeading')}</span>
          {Object.entries(explorer.sourceStatuses).map(([source, status]) => (
            <div className="source-state" key={source}>
              <i className={`source-state--${status}`} />
              {source}
              <small>{translate(sourceStatusMessageIds[status])}</small>
            </div>
          ))}
          <div className="source-state source-state--bridge">
            <i className={`source-state--${bridgeStatus}`} />
            {translate('explorer.fileBridgeLabel')}
            <small>{translate(bridgeStatusMessageIds[bridgeStatus])}</small>
          </div>
          <span>{translate('explorer.lastEventHeading')}</span>
          <div className="source-state source-state--last-event">
            <small>{lastFilesystemEvent ?? translate('explorer.noEvents')}</small>
          </div>
        </aside>
        <main className="explorer-main">
          <div className="explorer-controls">
            <span>{translate('explorer.nodeCount', { count: visibleNodes.length })}</span>
            <div>
              <TerminalSelect
                value={explorer.filter}
                options={explorerFilterOptions}
                onValueChange={(value) =>
                  controller?.setExplorerOption('filter', value as typeof explorer.filter)
                }
                label={translate('explorer.filterSelectLabel')}
              />
              <TerminalSelect
                value={explorer.sortBy}
                options={explorerSortOptions}
                onValueChange={(value) =>
                  controller?.setExplorerOption('sortBy', value as typeof explorer.sortBy)
                }
                label={translate('files.sortSelectLabel')}
              />
            </div>
          </div>
          {explorer.loading ? (
            <div className="explorer-empty">{translate('explorer.scanningSources')}</div>
          ) : visibleNodes.length === 0 ? (
            <div className="explorer-empty">
              <i>[ ]</i>
              <strong>{translate('explorer.emptyFolderTitle')}</strong>
              <span>{translate('explorer.emptyFolderHint')}</span>
            </div>
          ) : (
            <div className={explorer.viewMode === 'grid' ? 'file-grid' : 'file-list'}>
              {explorer.viewMode === 'list' ? (
                <div className="file-list__head">
                  <span>{translate('explorer.fieldName')}</span>
                  <span>{translate('explorer.fieldModified')}</span>
                  <span>{translate('field.type')}</span>
                  <span>{translate('field.size')}</span>
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
              <span>{translate('explorer.selectMaterialPrompt')}</span>
            </div>
          ) : (
            <>
              <div className="preview-visual">
                <i>{iconForNode(selected)}</i>
                <span>{selected.iconHint ?? selected.kind}</span>
              </div>
              <h3>{selected.name}</h3>
              <dl>
                <dt>{translate('explorer.fieldPath')}</dt>
                <dd>{selected.path}</dd>
                <dt>{translate('field.source')}</dt>
                <dd>{sourceForNode(selected) ?? translate('explorer.emulatedSourceLabel')}</dd>
                <dt>{translate('field.size')}</dt>
                <dd>{formatBytes(selected.displaySize)}</dd>
                <dt>{translate('explorer.fieldModified')}</dt>
                <dd>{formatDate(selected.modifiedAt)}</dd>
              </dl>
              <TerminalButton
                className="primary-action"
                onClick={() => controller && void controller.openNode(selected)}
              >
                {translate('explorer.openInWorkspaceButton')}
              </TerminalButton>
              <div className="send-row">
                <TerminalSelect
                  value={targetScreen}
                  options={screenOptions}
                  onValueChange={setTargetScreen}
                  label={translate('explorer.targetScreenLabel')}
                />
                <TerminalButton
                  onClick={() => controller?.sendNodeToScreen(selected, targetScreen)}
                >
                  {translate('explorer.sendToScreenButton')}
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

/**
 * The node's own source id, or `null` for an emulated node -- left for the
 * caller to translate, since a source id is not itself a message.
 */
function sourceForNode(node: ExplorerNode): string | null {
  if (node.kind === 'real-file' || node.kind === 'real-directory' || node.kind === 'mount')
    return node.sourceId;
  return null;
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
