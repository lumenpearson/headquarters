'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TerminalButton, TerminalCheckbox } from '@gremuchaya/ui/primitives';

import { useContextMenuAction } from '@/components/contextMenus/ContextMenuRuntime';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { Panel, ProgressBar, StatusBadge } from '@/components/operations/OpsUi';
import { YandexTacticalMap } from '@/components/operations/YandexTacticalMap';
import { type MapLayer, useOperationsStore } from '@/state/operationsStore';

const MOSCOW_OPERATION_CENTER = [55.7558, 37.6173] as const;

type ChannelSort = 'id' | 'encryption' | 'load' | 'packetLoss' | 'latency';

const channelColumns = [
  ['id', 'КАНАЛ'],
  ['encryption', 'ENC'],
  ['load', 'LOAD'],
  ['packetLoss', 'LOSS'],
  ['latency', 'LAT'],
] as const satisfies ReadonlyArray<readonly [ChannelSort, string]>;

const layerLabels: Readonly<Record<MapLayer, string>> = {
  friendly: 'СВОИ ПОДРАЗДЕЛЕНИЯ',
  hostile: 'ПРОТИВНИК',
  neutral: 'НЕЙТРАЛЬНЫЕ',
  infrastructure: 'ИНФРАСТРУКТУРА',
  restricted: 'ЗОНЫ ОГРАНИЧЕНИЙ',
  tasks: 'МАРКЕРЫ И ЗАДАЧИ',
  routes: 'МАРШРУТЫ',
  alerts: 'ТРЕВОГИ',
  communications: 'СВЯЗЬ',
  sensors: 'ДАТЧИКИ',
};

export function TacticalMapScreen() {
  const router = useRouter();
  const state = useOperationsStore((value) => value);
  useContextMenuAction('record.open', (subject) => {
    if (subject !== undefined) state.openDrawer('channel', subject);
  });
  const selected = state.objects[state.ui.selectedObjectId];
  const visibleObjects = useMemo(
    () =>
      Object.values(state.objects).filter((object) => {
        if (object.kind === 'group') return state.ui.mapLayers.friendly;
        if (object.threat >= 70) return state.ui.mapLayers.hostile;
        if (['address', 'device', 'point'].includes(object.kind)) {
          return state.ui.mapLayers.infrastructure;
        }
        return state.ui.mapLayers.neutral;
      }),
    [state.objects, state.ui.mapLayers],
  );
  const activeAlerts = useMemo(
    () => Object.values(state.alerts).filter((alert) => alert.lifecycle !== 'RESOLVED'),
    [state.alerts],
  );

  /*
   * The one table on this screen, and the last of the data screens to have no
   * ordering of its own: an operator looking for the channel that is losing
   * packets had to read all of them.
   */
  const [channelSort, setChannelSort] = useState<ChannelSort>('id');
  const [channelDescending, setChannelDescending] = useState(false);
  const channels = useMemo(
    () =>
      [...Object.values(state.channels)].sort((left, right) => {
        const a = left[channelSort];
        const b = right[channelSort];
        const result =
          typeof a === 'number' && typeof b === 'number'
            ? a - b
            : String(a).localeCompare(String(b));
        return channelDescending ? -result : result;
      }),
    [channelDescending, channelSort, state.channels],
  );

  /*
   * The map surface holds the top priority and names no route: it is what
   * the screen is. `selected` and `channels` have screens that show the same
   * records in full; layers, routes and sensors are drawn here and nowhere
   * else, so they say they hide rather than point at something else.
   */
  const tiles: readonly ScreenTile[] = useMemo(
    () => [
      {
        title: 'ТАКТИЧЕСКАЯ КАРТА',
        category: 'geo',
        descriptor: {
          id: 'surface',
          priority: 100,
          variants: [
            { presentation: 'full', columns: 8, rows: 3 },
            { presentation: 'compact', columns: 6, rows: 2 },
            // One row, so the tile that holds the top priority can always be
            // placed: it declares no way to leave, and the smallest grid the
            // runtime makes is a single row.
            { presentation: 'minimal', columns: 4, rows: 1 },
          ],
          canStretchHorizontally: true,
          canStretchVertically: true,
        },
        render: () => (
          <YandexTacticalMap
            center={state.ui.mapCenter}
            zoom={state.ui.mapZoom}
            layers={state.ui.mapLayers}
            objects={visibleObjects}
            routes={Object.values(state.routes)}
            alerts={activeAlerts}
            sensors={Object.values(state.sensors)}
            sectors={state.sectors}
            selectedObjectId={state.ui.selectedObjectId}
            selectedRouteId={state.ui.selectedRouteId}
            onSelectObject={state.selectObject}
            onSelectRoute={(id) => {
              state.selectRoute(id);
              state.openDrawer('route', id);
            }}
            onOpenAlert={(id) => state.openDrawer('alert', id)}
            onMapViewChange={state.setMapView}
          />
        ),
      },
      {
        title: 'ВЫБРАННЫЙ ОБЪЕКТ',
        category: 'detail',
        descriptor: {
          id: 'selected',
          priority: 90,
          variants: [
            { presentation: 'full', columns: 4, rows: 2 },
            { presentation: 'compact', columns: 4, rows: 1 },
          ],
          canStretchVertically: true,
          relocationRoute: '/objects',
        },
        render: () => (
          <Panel title="ВЫБРАННЫЙ ОБЪЕКТ" eyebrow="TRACK / CURRENT" className="map-selected-object">
            {selected === undefined ? null : (
              <>
                <header>
                  <strong>
                    {selected.id} / {selected.callsign}
                  </strong>
                  <StatusBadge status={selected.status} />
                </header>
                <dl className="ops-definition-list">
                  <div>
                    <dt>ТИП</dt>
                    <dd>{selected.kind.toUpperCase()}</dd>
                  </div>
                  <div>
                    <dt>КООРДИНАТЫ</dt>
                    <dd>
                      {selected.position.lat}, {selected.position.lng}
                    </dd>
                  </div>
                  <div>
                    <dt>СКОРОСТЬ</dt>
                    <dd>{selected.speed} КМ/Ч</dd>
                  </div>
                  <div>
                    <dt>ВЫСОТА</dt>
                    <dd>{selected.altitude} М</dd>
                  </div>
                  <div>
                    <dt>КАНАЛ</dt>
                    <dd>{selected.channelId}</dd>
                  </div>
                  <div>
                    <dt>ИСТОЧНИК</dt>
                    <dd>{selected.source}</dd>
                  </div>
                  <div>
                    <dt>СИГНАЛ</dt>
                    <dd>{selected.signal}%</dd>
                  </div>
                </dl>
                <div className="map-object-actions">
                  <TerminalButton onClick={() => router.push(`/objects/${selected.id}`)}>
                    [O] ОБЪЕКТ
                  </TerminalButton>
                  <TerminalButton onClick={() => state.selectRoute('RT-01')}>
                    [T] СОПРОВОЖДАТЬ
                  </TerminalButton>
                  <TerminalButton onClick={() => router.push('/video/cameras')}>
                    [V] ВИДЕО
                  </TerminalButton>
                  <TerminalButton
                    onClick={() =>
                      state.openDrawer(
                        'event',
                        state.events.find((event) => event.linkedObjectIds.includes(selected.id))
                          ?.id ?? 'EV-01',
                      )
                    }
                  >
                    [H] ИСТОРИЯ
                  </TerminalButton>
                </div>
              </>
            )}
          </Panel>
        ),
      },
      {
        title: 'АКТИВНЫЕ ТРЕВОГИ',
        category: 'events',
        descriptor: {
          id: 'alerts',
          priority: 85,
          variants: [
            { presentation: 'full', columns: 4, rows: 1 },
            { presentation: 'minimal', columns: 3, rows: 1 },
          ],
          canStretchHorizontally: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel title="АКТИВНЫЕ ТРЕВОГИ" eyebrow="ALERTS / CURRENT AREA" className="map-alerts">
            <div className="compact-alert-list">
              {Object.values(state.alerts)
                .filter((alert) => alert.lifecycle !== 'RESOLVED')
                .slice(0, 6)
                .map((alert) => (
                  <TerminalButton
                    key={alert.id}
                    onClick={() => {
                      state.setMapView([alert.coordinates.lat, alert.coordinates.lng], 15);
                      state.openDrawer('alert', alert.id);
                    }}
                  >
                    <i>!</i>
                    <span>
                      <strong>{alert.title}</strong>
                      <small>
                        {alert.id} / {alert.sectorId}
                      </small>
                    </span>
                    <b>{alert.lifecycle}</b>
                  </TerminalButton>
                ))}
            </div>
          </Panel>
        ),
      },
      {
        title: 'СЛОИ',
        category: 'navigation',
        descriptor: {
          id: 'layers',
          priority: 80,
          variants: [
            { presentation: 'full', columns: 3, rows: 2 },
            { presentation: 'minimal', columns: 2, rows: 1 },
          ],
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel title="СЛОИ" eyebrow="LAYER STACK / PERSISTED" className="map-layers">
            <div className="layer-list">
              {(Object.keys(layerLabels) as MapLayer[]).map((layer) => (
                <div className="layer-list__row" key={layer}>
                  <TerminalCheckbox
                    checked={state.ui.mapLayers[layer]}
                    onCheckedChange={() => state.toggleMapLayer(layer)}
                    label={layerLabels[layer]}
                  />
                  <span>{layerLabels[layer]}</span>
                </div>
              ))}
            </div>
            <footer>
              <span>ЛЕГЕНДА</span>
              <p>
                <i className="legend-mark legend-mark--friendly" /> СВОЙ
              </p>
              <p>
                <i className="legend-mark legend-mark--hostile" /> УГРОЗА
              </p>
              <p>
                <i className="legend-mark legend-mark--neutral" /> НЕЙТРАЛЬНЫЙ
              </p>
            </footer>
          </Panel>
        ),
      },
      {
        title: 'МАРШРУТЫ И КОРИДОРЫ',
        category: 'geo',
        descriptor: {
          id: 'routes',
          priority: 75,
          variants: [
            { presentation: 'full', columns: 4, rows: 1 },
            { presentation: 'minimal', columns: 3, rows: 1 },
          ],
          canStretchHorizontally: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel title="МАРШРУТЫ И КОРИДОРЫ" eyebrow="ROUTES / 08" className="map-routes-panel">
            <div className="route-list">
              {Object.values(state.routes).map((route) => (
                <TerminalButton
                  key={route.id}
                  className={route.id === state.ui.selectedRouteId ? 'is-selected' : ''}
                  onClick={() => {
                    state.selectRoute(route.id);
                    state.openDrawer('route', route.id);
                  }}
                >
                  <span>
                    <strong>
                      {route.id} / {route.name}
                    </strong>
                    <small>
                      {route.lengthKm} КМ / ETA {route.etaMinutes} МИН / RISK {route.risk}
                    </small>
                  </span>
                  <ProgressBar
                    value={route.progress}
                    tone={route.risk > 60 ? 'critical' : 'normal'}
                  />
                </TerminalButton>
              ))}
            </div>
          </Panel>
        ),
      },
      {
        title: 'СИГНАЛЫ И ДАТЧИКИ',
        category: 'telemetry',
        descriptor: {
          id: 'sensors',
          priority: 70,
          variants: [
            { presentation: 'full', columns: 4, rows: 1 },
            { presentation: 'minimal', columns: 3, rows: 1 },
          ],
          canStretchHorizontally: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel title="СИГНАЛЫ И ДАТЧИКИ" eyebrow="SENSORS / LIVE" className="map-sensors-panel">
            <div className="sensor-list">
              {Object.values(state.sensors)
                .slice(0, 7)
                .map((sensor) => (
                  <TerminalButton key={sensor.id}>
                    <span>
                      <strong>{sensor.id}</strong>
                      <small>{sensor.name}</small>
                    </span>
                    <ProgressBar
                      value={sensor.signal}
                      tone={sensor.signal < 40 ? 'critical' : 'ok'}
                    />
                  </TerminalButton>
                ))}
            </div>
          </Panel>
        ),
      },
      {
        title: 'КАНАЛЫ СВЯЗИ',
        category: 'records',
        descriptor: {
          id: 'channels',
          priority: 65,
          variants: [
            { presentation: 'full', columns: 5, rows: 1 },
            { presentation: 'minimal', columns: 3, rows: 1 },
          ],
          canStretchHorizontally: true,
          relocationRoute: '/communications',
        },
        render: () => (
          <Panel title="КАНАЛЫ СВЯЗИ" eyebrow="COMMS / ENCRYPTED" className="map-channels-panel">
            <table className="ops-table">
              <thead>
                <tr>
                  {channelColumns.map(([column, caption]) => (
                    <th key={column}>
                      <TerminalButton
                        onClick={() => {
                          setChannelDescending(channelSort === column ? !channelDescending : false);
                          setChannelSort(column);
                        }}
                      >
                        {caption} {channelSort === column ? (channelDescending ? '▼' : '▲') : ''}
                      </TerminalButton>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {channels.slice(0, 6).map((channel) => (
                  <tr
                    key={channel.id}
                    data-interactive="true"
                    data-context-menu="record"
                    data-context-subject={channel.id}
                    onClick={() => state.openDrawer('channel', channel.id)}
                  >
                    <td>{channel.id}</td>
                    <td>{channel.encryption}</td>
                    <td>{channel.load}%</td>
                    <td>{channel.packetLoss}%</td>
                    <td>{channel.latency}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ),
      },
    ],
    [
      activeAlerts,
      channelDescending,
      channelSort,
      channels,
      router,
      selected,
      state,
      visibleObjects,
    ],
  );

  return (
    <div className="ops-screen map-screen">
      <header className="ops-screen__title">
        <div>
          <span>GEO / LOCAL VECTOR LAYER</span>
          <h1>ТАКТИЧЕСКАЯ КАРТА</h1>
        </div>
        <div className="map-toolbar">
          <TerminalButton onClick={() => state.setMapView(MOSCOW_OPERATION_CENTER, 12)}>
            [R] RESET VIEW
          </TerminalButton>
          <TerminalButton
            onClick={() => state.setMapView(state.ui.mapCenter, state.ui.mapZoom - 1)}
          >
            [-] ZOOM
          </TerminalButton>
          <strong>Z{state.ui.mapZoom.toFixed(1)}</strong>
          <TerminalButton
            onClick={() => state.setMapView(state.ui.mapCenter, state.ui.mapZoom + 1)}
          >
            [+] ZOOM
          </TerminalButton>
          <span>{state.ui.mapCenter.map((value) => value.toFixed(5)).join(' / ')}</span>
        </div>
      </header>
      <TileGrid tiles={tiles} columns={12} className="map-layout" screen="map" />
    </div>
  );
}
