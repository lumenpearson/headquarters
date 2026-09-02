'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TerminalButton, TerminalInput, TerminalSelect } from '@gremuchaya/ui/primitives';

import { compareText, dateTimeFormat, foldCase } from '@/application/localization/intl';
import { useTranslate } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import { useRecordPage } from '@/application/records/useRecordPage';
import { useTablePageSize } from '@/application/records/useTablePageSize';
import { EmptyState, Panel, ProgressBar, StatusBadge } from '@/components/operations/OpsUi';
import { RecordPagination } from '@/components/operations/RecordPagination';
import { useContextMenuAction } from '@/components/contextMenus/ContextMenuRuntime';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { useOperationsStore } from '@/state/operationsStore';

/** What `toLocaleTimeString()` printed, named rather than left implicit. */
const clockParts = { timeStyle: 'medium' } as const;

type ObjectKindFilter = 'all' | 'person' | 'vehicle' | 'device' | 'group';

/** Keyed by the union rather than built with a template string, so a kind with no message is a compile error. */
const objectKindFilterLabelIds: Readonly<Record<ObjectKindFilter, MessageId>> = {
  all: 'objects.kindAll',
  person: 'objects.kindPerson',
  vehicle: 'objects.kindVehicle',
  device: 'objects.kindDevice',
  group: 'objects.kindGroup',
};

const objectKindFilters = [
  'all',
  'person',
  'vehicle',
  'device',
  'group',
] as const satisfies readonly ObjectKindFilter[];

type ObjectKind = 'person' | 'vehicle' | 'device' | 'group';

const objectKindLabelIds: Readonly<Record<ObjectKind, MessageId>> = {
  person: 'objects.kindLabelPerson',
  vehicle: 'objects.kindLabelVehicle',
  device: 'objects.kindLabelDevice',
  group: 'objects.kindLabelGroup',
};

const objectKinds = [
  'person',
  'vehicle',
  'device',
  'group',
] as const satisfies readonly ObjectKind[];

type ObjectSortKey = 'id' | 'name' | 'threat' | 'lastSeenAt';

type ObjectTabValue = 'summary' | 'activity' | 'relations' | 'files' | 'map' | 'video';

/** Keyed by the union rather than built with a template string, so a tab with no message is a compile error. */
const objectTabLabelIds: Readonly<Record<ObjectTabValue, MessageId>> = {
  summary: 'objects.tabSummary',
  activity: 'objects.tabActivity',
  relations: 'objects.tabRelations',
  files: 'objects.tabFiles',
  map: 'objects.tabMap',
  video: 'objects.tabVideo',
};

const objectTabs = [
  'summary',
  'activity',
  'relations',
  'files',
  'map',
  'video',
] as const satisfies readonly ObjectTabValue[];

export function ObjectsScreen({ detailId }: { readonly detailId?: string }) {
  const translate = useTranslate();
  const router = useRouter();
  const state = useOperationsStore((value) => value);
  useContextMenuAction('record.open', (subject) => {
    if (subject !== undefined) router.push(`/objects/${subject}`);
  });
  useContextMenuAction('record.select', (subject) => {
    if (subject !== undefined) state.selectObject(subject);
  });
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ObjectKindFilter>('all');
  const [tab, setTab] = useState<ObjectTabValue>('summary');
  const selectedId = detailId ?? state.ui.selectedObjectId;
  const selected = state.objects[selectedId] ?? Object.values(state.objects)[0];
  const pageSize = useTablePageSize();
  const allObjects = useMemo(() => Object.values(state.objects), [state.objects]);
  const [sortKey, setSortKey] = useState<ObjectSortKey>('id');
  const [descending, setDescending] = useState(false);
  const normalizedQuery = foldCase(query);
  const objectKindOptions = useMemo(
    () =>
      objectKindFilters.map((value) => ({
        value,
        label: translate(objectKindFilterLabelIds[value]),
      })),
    [translate],
  );
  // The question is the kind filter plus the search text: either one narrows
  // the registry, and without this the operator kept whatever page the
  // previous filter had left them on.
  const { page: objectPage, goToPage } = useRecordPage(
    allObjects,
    {
      pageSize,
      filters: [
        (object) => kind === 'all' || object.kind === kind,
        (object) =>
          foldCase(`${object.id} ${object.name} ${object.callsign} ${object.sectorId}`).includes(
            normalizedQuery,
          ),
      ],
      comparator: (left, right) => {
        const a = left[sortKey];
        const b = right[sortKey];
        const result =
          typeof a === 'number' && typeof b === 'number'
            ? a - b
            : compareText(String(a), String(b));
        return descending ? -result : result;
      },
    },
    `${kind}:${normalizedQuery}`,
  );
  const objects = objectPage.items;

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
        title: translate('objects.registryTitle'),
        category: 'records',
        descriptor: {
          id: 'registry',
          priority: 100,
          variants: [
            { presentation: 'full', columns: 8, rows: 1 },
            { presentation: 'compact', columns: 6, rows: 1 },
          ],
          canStretchHorizontally: true,
          canStretchVertically: true,
        },
        render: () => (
          <Panel
            title={translate('objects.registryTitle')}
            eyebrow={translate('objects.registryEyebrow', { total: objectPage.total })}
            className="objects-registry"
          >
            <div className="ops-filterbar">
              <label>
                <span>/</span>
                <TerminalInput
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label={translate('objects.searchAriaLabel')}
                  placeholder={translate('objects.searchPlaceholder')}
                />
              </label>
              <TerminalSelect
                value={kind}
                options={objectKindOptions}
                onValueChange={setKind}
                label={translate('objects.kindSelectLabel')}
              />
            </div>
            {objects.length === 0 ? (
              <EmptyState>{translate('objects.noMatches')}</EmptyState>
            ) : (
              <div className="ops-table-wrap">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>
                        <TerminalButton
                          onClick={() => {
                            setDescending(sortKey === 'id' ? !descending : false);
                            setSortKey('id');
                          }}
                        >
                          ID {sortKey === 'id' ? (descending ? '▼' : '▲') : ''}
                        </TerminalButton>
                      </th>
                      <th>
                        <TerminalButton
                          onClick={() => {
                            setDescending(sortKey === 'name' ? !descending : false);
                            setSortKey('name');
                          }}
                        >
                          {translate('objects.columnNameCallsign')}{' '}
                          {sortKey === 'name' ? (descending ? '▼' : '▲') : ''}
                        </TerminalButton>
                      </th>
                      <th>{translate('field.type')}</th>
                      <th>{translate('field.status')}</th>
                      <th>{translate('field.sector')}</th>
                      <th>
                        <TerminalButton
                          onClick={() => {
                            setDescending(sortKey === 'lastSeenAt' ? !descending : true);
                            setSortKey('lastSeenAt');
                          }}
                        >
                          {translate('field.lastSeen')}{' '}
                          {sortKey === 'lastSeenAt' ? (descending ? '▼' : '▲') : ''}
                        </TerminalButton>
                      </th>
                      <th>
                        <TerminalButton
                          onClick={() => {
                            setDescending(sortKey === 'threat' ? !descending : true);
                            setSortKey('threat');
                          }}
                        >
                          {translate('field.threat')}{' '}
                          {sortKey === 'threat' ? (descending ? '▼' : '▲') : ''}
                        </TerminalButton>
                      </th>
                      <th>{translate('field.cases')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {objects.map((object) => (
                      <tr
                        key={object.id}
                        className={object.id === selected?.id ? 'is-selected' : ''}
                        data-interactive="true"
                        data-context-menu="record"
                        data-context-subject={object.id}
                        onClick={() => state.selectObject(object.id)}
                        onDoubleClick={() => router.push(`/objects/${object.id}`)}
                      >
                        <td>
                          <strong>{object.id}</strong>
                        </td>
                        <td>
                          {object.name}
                          <small>{object.callsign}</small>
                        </td>
                        <td>{object.kind.toUpperCase()}</td>
                        <td>
                          <StatusBadge status={object.status} />
                        </td>
                        <td>{object.sectorId}</td>
                        <td>{dateTimeFormat(clockParts).format(new Date(object.lastSeenAt))}</td>
                        <td>
                          <ProgressBar
                            value={object.threat}
                            tone={object.threat > 70 ? 'critical' : 'warning'}
                          />
                        </td>
                        <td>{object.linkedCaseIds.length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <RecordPagination
              page={objectPage}
              onPage={goToPage}
              label={translate('objects.paginationLabel')}
            >
              <span>{translate('registry.selectedFooter', { id: selected?.id ?? '—' })}</span>
            </RecordPagination>
          </Panel>
        ),
      },
      {
        title: translate('objects.detailTitle'),
        category: 'detail',
        descriptor: {
          id: 'detail',
          priority: 90,
          variants: [
            { presentation: 'full', columns: 4, rows: 1 },
            { presentation: 'compact', columns: 3, rows: 1 },
          ],
          canStretchHorizontally: true,
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel
            title={translate('objects.detailTitle')}
            eyebrow={selected?.id ?? translate('objects.noObjectEyebrow')}
            className="object-detail-panel"
          >
            {selected === undefined ? (
              <EmptyState>{translate('objects.noObjectSelected')}</EmptyState>
            ) : (
              <>
                <header className="object-detail-header">
                  <div className={`object-symbol object-symbol--${selected.kind}`}>
                    [{selected.kind.slice(0, 3).toUpperCase()}]
                  </div>
                  <div>
                    <span>{selected.callsign}</span>
                    <strong>{selected.name}</strong>
                    <StatusBadge status={selected.status} />
                  </div>
                  <b>
                    {translate('field.threat')}
                    <br />
                    <strong>{selected.threat}</strong>
                  </b>
                </header>
                <nav className="object-tabs">
                  {objectTabs.map((value) => (
                    <TerminalButton
                      key={value}
                      className={tab === value ? 'is-active' : ''}
                      onClick={() => setTab(value)}
                    >
                      {translate(objectTabLabelIds[value])}
                    </TerminalButton>
                  ))}
                </nav>
                <ObjectTab tab={tab} objectId={selected.id} />
                <footer className="object-actions">
                  <TerminalButton onClick={() => router.push('/map')}>
                    {translate('objects.showOnMapButton')}
                  </TerminalButton>
                  <TerminalButton onClick={() => router.push('/video')}>
                    {translate('objects.openVideoButton')}
                  </TerminalButton>
                  <TerminalButton
                    onClick={() => router.push(`/cases/${selected.linkedCaseIds[0] ?? 'CASE-01'}`)}
                  >
                    {translate('objects.linkedCaseButton')}
                  </TerminalButton>
                </footer>
              </>
            )}
          </Panel>
        ),
      },
    ],
    [
      descending,
      goToPage,
      kind,
      objectKindOptions,
      objectPage,
      objects,
      query,
      router,
      selected,
      sortKey,
      state,
      tab,
      translate,
    ],
  );

  return (
    <div className="ops-screen objects-screen">
      <header className="ops-screen__title">
        <div>
          <span>{translate('objects.headerEyebrow')}</span>
          <h1>
            {detailId === undefined
              ? translate('objects.headerRegistryTitle')
              : translate('objects.headerDetailTitle', { id: detailId })}
          </h1>
        </div>
        <div className="object-kind-metrics">
          {objectKinds.map((value) => (
            <TerminalButton key={value} onClick={() => setKind(value)}>
              <small>{translate(objectKindLabelIds[value])}</small>
              <strong>
                {Object.values(state.objects).filter((object) => object.kind === value).length}
              </strong>
            </TerminalButton>
          ))}
        </div>
      </header>
      <TileGrid tiles={tiles} columns={12} className="objects-layout" screen="objects" />
    </div>
  );
}

function ObjectTab({ tab, objectId }: { readonly tab: ObjectTabValue; readonly objectId: string }) {
  const translate = useTranslate();
  const state = useOperationsStore((value) => value);
  const object = state.objects[objectId];
  if (object === undefined) return null;
  if (tab === 'summary')
    return (
      <div className="object-summary">
        <dl className="ops-definition-list">
          <div>
            <dt>{translate('objects.idCallsignLabel')}</dt>
            <dd>
              {object.id} / {object.callsign}
            </dd>
          </div>
          <div>
            <dt>{translate('field.type')}</dt>
            <dd>{object.kind.toUpperCase()}</dd>
          </div>
          <div>
            <dt>{translate('field.sector')}</dt>
            <dd>{object.sectorId}</dd>
          </div>
          <div>
            <dt>{translate('field.coordinates')}</dt>
            <dd>
              {object.position.lat}, {object.position.lng}
            </dd>
          </div>
          <div>
            <dt>{translate('field.speed')}</dt>
            <dd>
              {object.speed} {translate('unit.kmh')}
            </dd>
          </div>
          <div>
            <dt>{translate('field.altitude')}</dt>
            <dd>
              {object.altitude} {translate('unit.m')}
            </dd>
          </div>
          <div>
            <dt>{translate('field.channel')}</dt>
            <dd>{object.channelId}</dd>
          </div>
          <div>
            <dt>{translate('field.source')}</dt>
            <dd>{object.source}</dd>
          </div>
        </dl>
        <section>
          <h3>{translate('objects.signalThreatHeading')}</h3>
          <ProgressBar
            value={object.signal}
            tone={object.signal < 30 ? 'critical' : 'ok'}
            label={translate('field.signal')}
          />
          <ProgressBar
            value={object.threat}
            tone={object.threat > 70 ? 'critical' : 'warning'}
            label={translate('field.threat')}
          />
        </section>
      </div>
    );
  if (tab === 'activity')
    return (
      <div className="event-feed">
        {state.events
          .filter((event) => event.linkedObjectIds.includes(objectId))
          .slice(0, 12)
          .map((event) => (
            <TerminalButton key={event.id} onClick={() => state.openDrawer('event', event.id)}>
              <time>{dateTimeFormat(clockParts).format(new Date(event.timestamp))}</time>
              <i className={`severity-dot severity-dot--${event.severity}`} />
              <span>
                <strong>{event.title}</strong>
                <small>{event.source}</small>
              </span>
            </TerminalButton>
          ))}
      </div>
    );
  if (tab === 'relations')
    return (
      <div className="relation-graph">
        <svg viewBox="0 0 600 320">
          <line x1="300" y1="160" x2="90" y2="64" />
          <line x1="300" y1="160" x2="505" y2="54" />
          <line x1="300" y1="160" x2="110" y2="266" />
          <line x1="300" y1="160" x2="496" y2="274" />
        </svg>
        <i className="is-main" style={{ left: '50%', top: '50%' }}>
          {objectId}
        </i>
        {object.linkedCaseIds.map((id, index) => (
          <i
            key={id}
            style={{ left: `${index % 2 === 0 ? 16 : 82}%`, top: `${index < 2 ? 18 : 82}%` }}
          >
            {id}
          </i>
        ))}
      </div>
    );
  if (tab === 'files')
    return (
      <div className="linked-file-list">
        {object.linkedFileIds.map((id) => {
          const file = state.attachments[id];
          return file === undefined ? null : (
            <TerminalButton key={id} onClick={() => state.openDrawer('file', id)}>
              <i>[{file.kind.toUpperCase()}]</i>
              <span>
                <strong>{file.title}</strong>
                <small>
                  {file.id} / {file.sizeLabel}
                </small>
              </span>
            </TerminalButton>
          );
        })}
      </div>
    );
  if (tab === 'map')
    return (
      <TerminalButton className="object-map-preview">
        <span style={{ left: `${object.position.x}%`, top: `${object.position.y}%` }}>
          {object.id}
        </span>
        <footer>
          {object.position.lat}, {object.position.lng}
        </footer>
      </TerminalButton>
    );
  const camera = Object.values(state.cameras).find((candidate) => candidate.objectId === objectId);
  return (
    <div className="object-video-preview">
      <div>
        <span>{camera?.id ?? translate('objects.noCameraLabel')}</span>
        <strong>
          {camera?.status === 'SIGNAL_LOST'
            ? translate('objects.signalLostLabel')
            : translate('objects.localVideoFeedLabel')}
        </strong>
      </div>
    </div>
  );
}
