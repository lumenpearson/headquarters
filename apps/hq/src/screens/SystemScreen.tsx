'use client';

import { useMemo } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { useStringSetting } from '@/application/personalization/useSetting';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { Metric, Panel, ProgressBar, Sparkline, StatusBadge } from '@/components/operations/OpsUi';
import { useOperationsStore, type OperationsState } from '@/state/operationsStore';

const storageAreas = ['CORE', 'EVENTS', 'VIDEO', 'EVIDENCE', 'ARCHIVE', 'SNAPSHOTS'] as const;
const storageUse = [48, 63, 82, 57, 74, 12] as const;

/** The host counters this screen reports, however they were obtained. */
type HostSample = OperationsState['metrics'];

interface TelemetryReading {
  /** Names, in the panel eyebrow, where the numbers below came from. */
  readonly caption: string;
  /**
   * Appended to every series label. A chart carries no eyebrow of its own, so
   * without it a substituted series reads as a measurement of this machine.
   */
  readonly seriesTag: string;
  /** The sample, or `null` when the named source has nothing to give. */
  readonly sample: HostSample | null;
  /** Shown in place of the numbers when there is no sample. */
  readonly notice: string | null;
}

function sampleValue(reading: number | undefined): string {
  return reading === undefined ? '—' : `${reading}%`;
}

/*
 * What `telemetry.source` selects, and what each of its three values does
 * today.
 *
 * - `simulation` samples the deterministic world: `metrics` in
 *   `operationsStore`, advanced by `simulationTick`. This is the reading the
 *   screen showed before the setting had a consumer.
 * - `native` asks for counters read from this machine. Nothing in this build
 *   produces them: `apps/hq/src-tauri` registers window management, the media
 *   gateway and the read-only native filesystem, and no command that reports
 *   CPU, RAM, GPU or NIC use, and the web build has no such reading at all.
 *   So the panel shows no numbers and states that the source is unavailable.
 *   Showing the simulated series under a native heading is the one outcome
 *   this must not produce: an operator who chose `native` would be told the
 *   host is at 43% by a generator.
 * - `hybrid` prefers host counters and falls back to the simulation for what
 *   they do not cover. Today they cover nothing, so the fallback is the whole
 *   reading and every series is tagged as substituted rather than measured.
 *
 * When a host sampler lands, this function is where its reading is taken, and
 * only the `native` and `hybrid` branches change.
 */
function readTelemetry(source: string, simulated: HostSample): TelemetryReading {
  if (source === 'native') {
    return {
      caption: 'NATIVE / ИСТОЧНИК НЕДОСТУПЕН',
      seriesTag: 'N/A',
      sample: null,
      notice:
        'ИСТОЧНИК ТЕЛЕМЕТРИИ NATIVE НЕ ЧИТАЕТСЯ В ЭТОЙ СБОРКЕ: СЧЁТЧИКОВ ХОСТА НЕТ НИ В ВЕБ-, НИ В ДЕСКТОП-СЛОЕ. ВЫБЕРИТЕ SIMULATION ИЛИ HYBRID.',
    };
  }
  if (source === 'hybrid') {
    return {
      caption: 'HYBRID / ЗАМЕЩЕНО СИМУЛЯЦИЕЙ',
      seriesTag: 'SIM',
      sample: simulated,
      notice: 'СЧЁТЧИКИ ХОСТА НЕДОСТУПНЫ: ВСЕ РЯДЫ ВЗЯТЫ ИЗ СИМУЛЯЦИИ.',
    };
  }
  return {
    caption: 'SIM / ДЕТЕРМИНИРОВАННЫЙ МИР',
    seriesTag: 'SIM',
    sample: simulated,
    notice: null,
  };
}

export function SystemScreen() {
  const state = useOperationsStore((value) => value);
  const nodes = Object.values(state.systemNodes);
  const channels = Object.values(state.channels);

  /*
   * `telemetry.source` governs the host counters and nothing else on the
   * screen: nodes, channels and the storage contour are records of the
   * operational world, not readings of this machine, and no source selection
   * would change where they come from.
   */
  const telemetrySource = useStringSetting('telemetry.source');
  const telemetry = readTelemetry(telemetrySource, state.metrics);
  const sample = telemetry.sample;

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
        category: 'telemetry',
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
            eyebrow={`HOST / ${telemetry.caption}`}
            className="system-resources"
          >
            {telemetry.notice === null ? null : (
              <p className="system-resources__source">{telemetry.notice}</p>
            )}
            <div className="metric-grid metric-grid--four">
              <Metric
                label="CPU"
                value={sampleValue(sample?.cpu)}
                detail={sample === null ? 'ОТСЧЁТА НЕТ' : '16C / 4.8 GHZ'}
                tone={sample === null ? 'normal' : sample.cpu > 80 ? 'critical' : 'ok'}
              />
              <Metric
                label="RAM"
                value={sampleValue(sample?.ram)}
                detail={sample === null ? 'ОТСЧЁТА НЕТ' : '43.5 / 64 GB'}
                tone={sample === null ? 'normal' : sample.ram > 80 ? 'warning' : 'ok'}
              />
              <Metric
                label="GPU"
                value={sampleValue(sample?.gpu)}
                detail={sample === null ? 'ОТСЧЁТА НЕТ' : 'VIDEO PIPELINE'}
                tone={sample === null ? 'normal' : 'ok'}
              />
              <Metric
                label="STORAGE"
                value={sampleValue(sample?.storage)}
                detail={sample === null ? 'ОТСЧЁТА НЕТ' : '2.8 / 4.0 TB'}
                tone={sample === null ? 'normal' : 'warning'}
              />
            </div>
            {/*
             * No sample, no charts: a history plotted from the fixed leading
             * values alone would draw a line the named source never produced.
             */}
            {presentation === 'full' && sample !== null ? (
              <div className="resource-charts">
                <div>
                  <span>CPU HISTORY / 60S / {telemetry.seriesTag}</span>
                  <Sparkline
                    values={[31, 44, 39, 55, 48, 61, 43, sample.cpu]}
                    label={`CPU / ${telemetry.seriesTag}`}
                  />
                </div>
                <div>
                  <span>NETWORK IN / OUT / {telemetry.seriesTag}</span>
                  <Sparkline
                    values={[24, 31, 28, 42, 56, 49, 67, sample.networkIn / 6]}
                    label={`Сеть / ${telemetry.seriesTag}`}
                  />
                </div>
              </div>
            ) : null}
          </Panel>
        ),
      },
      {
        title: 'СИСТЕМНЫЕ УЗЛЫ',
        category: 'records',
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
        category: 'telemetry',
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
        category: 'events',
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
        category: 'telemetry',
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
    [channels, nodes, sample, state, telemetry],
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
      <TileGrid tiles={tiles} columns={3} className="system-layout" screen="system" />
    </div>
  );
}
