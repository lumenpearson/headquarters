'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TerminalButton, TerminalInput, TerminalSelect } from '@gremuchaya/ui/primitives';

import { EmptyState, Panel, ProgressBar, StatusBadge } from '@/components/operations/OpsUi';
import { useContextMenuAction } from '@/components/contextMenus/ContextMenuRuntime';
import { useOperationsStore } from '@/state/operationsStore';

type ObjectKindFilter = 'all' | 'person' | 'vehicle' | 'device' | 'group';

const objectKindOptions = [
  { value: 'all', label: 'ВСЕ ТИПЫ' },
  { value: 'person', label: 'ЛИЦА' },
  { value: 'vehicle', label: 'ТРАНСПОРТ' },
  { value: 'device', label: 'УСТРОЙСТВА' },
  { value: 'group', label: 'ГРУППЫ' },
] as const satisfies ReadonlyArray<{
  readonly value: ObjectKindFilter;
  readonly label: string;
}>;

export function ObjectsScreen({ detailId }: { readonly detailId?: string }) {
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
  const [tab, setTab] = useState<'summary' | 'activity' | 'relations' | 'files' | 'map' | 'video'>(
    'summary',
  );
  const selectedId = detailId ?? state.ui.selectedObjectId;
  const selected = state.objects[selectedId] ?? Object.values(state.objects)[0];
  const objects = useMemo(
    () =>
      Object.values(state.objects).filter(
        (object) =>
          (kind === 'all' || object.kind === kind) &&
          `${object.id} ${object.name} ${object.callsign} ${object.sectorId}`
            .toLocaleLowerCase('ru-RU')
            .includes(query.toLocaleLowerCase('ru-RU')),
      ),
    [kind, query, state.objects],
  );

  return (
    <div className="ops-screen objects-screen">
      <header className="ops-screen__title">
        <div>
          <span>ENTITIES / NORMALIZED REGISTRY</span>
          <h1>{detailId === undefined ? 'РЕЕСТР ОБЪЕКТОВ' : `КАРТОЧКА ОБЪЕКТА ${detailId}`}</h1>
        </div>
        <div className="object-kind-metrics">
          {['person', 'vehicle', 'device', 'group'].map((value) => (
            <TerminalButton key={value} onClick={() => setKind(value as ObjectKindFilter)}>
              <small>{value.toUpperCase()}</small>
              <strong>
                {Object.values(state.objects).filter((object) => object.kind === value).length}
              </strong>
            </TerminalButton>
          ))}
        </div>
      </header>
      <div className="objects-layout">
        <Panel
          title="ОБЪЕКТЫ"
          eyebrow={`REGISTRY / ${objects.length}`}
          className="objects-registry"
        >
          <div className="ops-filterbar">
            <label>
              <span>/</span>
              <TerminalInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Поиск объектов"
                placeholder="ID / ИМЯ / ПОЗЫВНОЙ / СЕКТОР"
              />
            </label>
            <TerminalSelect
              value={kind}
              options={objectKindOptions}
              onValueChange={setKind}
              label="Тип объекта"
            />
          </div>
          {objects.length === 0 ? (
            <EmptyState>СОВПАДЕНИЙ НЕ ОБНАРУЖЕНО</EmptyState>
          ) : (
            <div className="ops-table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>NAME / CALLSIGN</th>
                    <th>TYPE</th>
                    <th>STATUS</th>
                    <th>SECTOR</th>
                    <th>LAST SEEN</th>
                    <th>THREAT</th>
                    <th>CASES</th>
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
                      <td>{new Date(object.lastSeenAt).toLocaleTimeString('ru-RU')}</td>
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
        </Panel>
        <Panel
          title="КАРТОЧКА ОБЪЕКТА"
          eyebrow={selected?.id ?? 'NO OBJECT'}
          className="object-detail-panel"
        >
          {selected === undefined ? (
            <EmptyState>ОБЪЕКТ НЕ ВЫБРАН</EmptyState>
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
                  THREAT
                  <br />
                  <strong>{selected.threat}</strong>
                </b>
              </header>
              <nav className="object-tabs">
                {(['summary', 'activity', 'relations', 'files', 'map', 'video'] as const).map(
                  (value) => (
                    <TerminalButton
                      key={value}
                      className={tab === value ? 'is-active' : ''}
                      onClick={() => setTab(value)}
                    >
                      {value.toUpperCase()}
                    </TerminalButton>
                  ),
                )}
              </nav>
              <ObjectTab tab={tab} objectId={selected.id} />
              <footer className="object-actions">
                <TerminalButton onClick={() => router.push('/map')}>
                  [04] ПОКАЗАТЬ НА КАРТЕ
                </TerminalButton>
                <TerminalButton onClick={() => router.push('/video')}>
                  [05] ОТКРЫТЬ ВИДЕО
                </TerminalButton>
                <TerminalButton
                  onClick={() => router.push(`/cases/${selected.linkedCaseIds[0] ?? 'CASE-01'}`)}
                >
                  [03] СВЯЗАННОЕ ДЕЛО
                </TerminalButton>
              </footer>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

function ObjectTab({
  tab,
  objectId,
}: {
  readonly tab: 'summary' | 'activity' | 'relations' | 'files' | 'map' | 'video';
  readonly objectId: string;
}) {
  const state = useOperationsStore((value) => value);
  const object = state.objects[objectId];
  if (object === undefined) return null;
  if (tab === 'summary')
    return (
      <div className="object-summary">
        <dl className="ops-definition-list">
          <div>
            <dt>ID / ПОЗЫВНОЙ</dt>
            <dd>
              {object.id} / {object.callsign}
            </dd>
          </div>
          <div>
            <dt>ТИП</dt>
            <dd>{object.kind.toUpperCase()}</dd>
          </div>
          <div>
            <dt>СЕКТОР</dt>
            <dd>{object.sectorId}</dd>
          </div>
          <div>
            <dt>КООРДИНАТЫ</dt>
            <dd>
              {object.position.lat}, {object.position.lng}
            </dd>
          </div>
          <div>
            <dt>СКОРОСТЬ</dt>
            <dd>{object.speed} КМ/Ч</dd>
          </div>
          <div>
            <dt>ВЫСОТА</dt>
            <dd>{object.altitude} М</dd>
          </div>
          <div>
            <dt>КАНАЛ</dt>
            <dd>{object.channelId}</dd>
          </div>
          <div>
            <dt>ИСТОЧНИК</dt>
            <dd>{object.source}</dd>
          </div>
        </dl>
        <section>
          <h3>СИГНАЛ / УГРОЗА</h3>
          <ProgressBar
            value={object.signal}
            tone={object.signal < 30 ? 'critical' : 'ok'}
            label="SIGNAL"
          />
          <ProgressBar
            value={object.threat}
            tone={object.threat > 70 ? 'critical' : 'warning'}
            label="THREAT"
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
              <time>{new Date(event.timestamp).toLocaleTimeString('ru-RU')}</time>
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
        <span>{camera?.id ?? 'NO CAMERA'}</span>
        <strong>{camera?.status === 'SIGNAL_LOST' ? 'ПОТЕРЯ СИГНАЛА' : 'LOCAL VIDEO FEED'}</strong>
      </div>
    </div>
  );
}
