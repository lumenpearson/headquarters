'use client';

import { useMemo } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { Metric, Panel, ProgressBar, Sparkline, StatusBadge } from '@/components/operations/OpsUi';
import { useOperationsStore } from '@/state/operationsStore';

const storageAreas = ['CORE', 'EVENTS', 'VIDEO', 'EVIDENCE', 'ARCHIVE', 'SNAPSHOTS'] as const;
const storageUse = [48, 63, 82, 57, 74, 12] as const;

export function SystemScreen() {
  const state = useOperationsStore((value) => value);
  const nodes = Object.values(state.systemNodes);
  const channels = Object.values(state.channels);

  /*
   * `systemNodes` and `audit` are read by this screen and no other, so both
   * declare `hideWhenOverflow` rather than a route: there is nowhere else that
   * shows those records. `network` has one -- `/communications` shows the same
   * channels in full.
   */
  const tiles: readonly ScreenTile[] = useMemo(
    () => [
      {
        title: 'РЕСУРСЫ РАБОЧЕЙ СТАНЦИИ',
        descriptor: {
          id: 'resources',
          priority: 100,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
        },
        render: (presentation) => (
          <Panel
            title="РЕСУРСЫ РАБОЧЕЙ СТАНЦИИ"
            eyebrow="HOST / LIVE TELEMETRY"
            className="system-resources"
          >
            <div className="metric-grid metric-grid--four">
              <Metric
                label="CPU"
                value={`${state.metrics.cpu}%`}
                detail="16C / 4.8 GHZ"
                tone={state.metrics.cpu > 80 ? 'critical' : 'ok'}
              />
              <Metric
                label="RAM"
                value={`${state.metrics.ram}%`}
                detail="43.5 / 64 GB"
                tone={state.metrics.ram > 80 ? 'warning' : 'ok'}
              />
              <Metric
                label="GPU"
                value={`${state.metrics.gpu}%`}
                detail="VIDEO PIPELINE"
                tone="ok"
              />
              <Metric
                label="STORAGE"
                value={`${state.metrics.storage}%`}
                detail="2.8 / 4.0 TB"
                tone="warning"
              />
            </div>
            {presentation === 'full' ? (
              <div className="resource-charts">
                <div>
                  <span>CPU HISTORY / 60S</span>
                  <Sparkline values={[31, 44, 39, 55, 48, 61, 43, state.metrics.cpu]} label="CPU" />
                </div>
                <div>
                  <span>NETWORK IN / OUT</span>
                  <Sparkline
                    values={[24, 31, 28, 42, 56, 49, 67, state.metrics.networkIn / 6]}
                    label="Сеть"
                  />
                </div>
              </div>
            ) : null}
          </Panel>
        ),
      },
      {
        title: 'СИСТЕМНЫЕ УЗЛЫ',
        descriptor: {
          id: 'nodes',
          priority: 95,
          variants: [
            { presentation: 'full', columns: 2, rows: 2 },
            { presentation: 'compact', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel title="СИСТЕМНЫЕ УЗЛЫ" eyebrow="LOCAL INFRASTRUCTURE" className="system-nodes">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>NODE</th>
                  <th>TYPE / IP</th>
                  <th>STATUS</th>
                  <th>LOAD</th>
                  <th>TEMP</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.id}>
                    <td>
                      <strong>{node.id}</strong>
                      <small>{node.name}</small>
                    </td>
                    <td>
                      {node.kind.toUpperCase()}
                      <small>{node.ip}</small>
                    </td>
                    <td>
                      <StatusBadge status={node.status} />
                    </td>
                    <td>
                      <ProgressBar value={node.load} />
                    </td>
                    <td className={node.temperature > 65 ? 'is-critical' : ''}>
                      {node.temperature}°C
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ),
      },
      {
        title: 'СЕТЕВЫЕ КАНАЛЫ',
        descriptor: {
          id: 'network',
          priority: 90,
          variants: [
            { presentation: 'full', columns: 1, rows: 2 },
            { presentation: 'compact', columns: 1, rows: 1 },
          ],
          canStretchVertically: true,
          relocationRoute: '/communications',
        },
        render: (presentation) => (
          <Panel title="СЕТЕВЫЕ КАНАЛЫ" eyebrow="ENCRYPTED LINKS" className="system-network">
            {channels.slice(0, presentation === 'full' ? 7 : 3).map((channel) => (
              <TerminalButton
                key={channel.id}
                onClick={() => state.openDrawer('channel', channel.id)}
              >
                <span>
                  <strong>
                    {channel.id} / {channel.name}
                  </strong>
                  <small>
                    {channel.encryption} · {channel.latency} MS · LOSS {channel.packetLoss}%
                  </small>
                </span>
                <ProgressBar
                  value={channel.signal}
                  tone={channel.signal < 50 ? 'critical' : 'ok'}
                />
              </TerminalButton>
            ))}
          </Panel>
        ),
      },
      {
        title: 'ЖУРНАЛ АУДИТА',
        descriptor: {
          id: 'audit',
          priority: 85,
          variants: [
            { presentation: 'full', columns: 1, rows: 2 },
            { presentation: 'compact', columns: 1, rows: 1 },
          ],
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: (presentation) => (
          <Panel
            title="ЖУРНАЛ АУДИТА"
            eyebrow="OPERATOR ACTIONS / APPEND ONLY"
            className="system-audit"
          >
            <div className="audit-log">
              {state.audit.slice(0, presentation === 'full' ? 14 : 6).map((entry) => (
                <div key={entry.id}>
                  <time>{new Date(entry.timestamp).toLocaleTimeString('ru-RU')}</time>
                  <i>{entry.operator}</i>
                  <strong>{entry.action}</strong>
                  <span>{entry.entityId}</span>
                </div>
              ))}
            </div>
          </Panel>
        ),
      },
      {
        title: 'КОНТУР ХРАНЕНИЯ',
        descriptor: {
          id: 'storage',
          priority: 80,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel title="КОНТУР ХРАНЕНИЯ" eyebrow="LOCAL / OFFLINE" className="system-storage">
            <div className="storage-map">
              {storageAreas.map((item, index) => (
                <div key={item}>
                  <i>[{String(index + 1).padStart(2, '0')}]</i>
                  <span>{item}</span>
                  <b>{storageUse[index]}%</b>
                </div>
              ))}
            </div>
            <p>ЦЕЛОСТНОСТЬ: VERIFIED / РЕПЛИКА: LOCAL-02 / ПОСЛЕДНЯЯ ПРОВЕРКА: 07:41:52</p>
          </Panel>
        ),
      },
    ],
    [channels, nodes, state],
  );

  return (
    <div className="ops-screen system-screen">
      <header className="ops-screen__title">
        <div>
          <span>CONTROL NODE / {state.production.screenId}</span>
          <h1>СИСТЕМА И РЕСУРСЫ</h1>
        </div>
        <div className="system-health">
          <i />
          КОНТУР СТАБИЛЕН /{' '}
          {nodes.filter((node) => node.status === 'NORMAL' || node.status === 'ACTIVE').length}/
          {nodes.length} УЗЛОВ В НОРМЕ
        </div>
      </header>
      <TileGrid tiles={tiles} columns={3} className="system-layout" />
    </div>
  );
}
