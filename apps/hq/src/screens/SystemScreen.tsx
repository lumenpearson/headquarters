'use client';

import { useEffect, useMemo, useState } from 'react';
import type { TilePresentation } from '@gremuchaya/layout-engine';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import {
  useBooleanSetting,
  useNumberSetting,
  useStringSetting,
} from '@/application/personalization/useSetting';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { Metric, Panel, ProgressBar, Sparkline, StatusBadge } from '@/components/operations/OpsUi';
import {
  readNativeMediaGatewayStatus,
  type NativeMediaGatewayStatus,
} from '@/infrastructure/tauri/nativeMediaGatewayStatus';
import { useOperationsStore, type OperationsState } from '@/state/operationsStore';

const storageAreas = ['CORE', 'EVENTS', 'VIDEO', 'EVIDENCE', 'ARCHIVE', 'SNAPSHOTS'] as const;
const storageUse = [48, 63, 82, 57, 74, 12] as const;

/**
 * How often the native media gateway is re-read.
 *
 * Slow on purpose: the counters describe ffmpeg workers whose state changes on
 * the scale of a reconnect, and each read crosses the IPC boundary and takes
 * the gateway's worker lock.
 */
const nativeMediaGatewayPollMs = 5_000;

interface NativeMediaReading {
  readonly status: NativeMediaGatewayStatus | null;
  readonly error: string | null;
}

/**
 * Reads `get_media_gateway_status` from the native shell.
 *
 * The command was registered when the RTSP→HLS gateway landed and called from
 * nowhere, so the only way to learn that a camera was reconnecting was to read
 * ffmpeg's output in a terminal. A `null` status means there is no native shell
 * in this session, which is different from a gateway that answered with zero
 * streams and is reported as such.
 */
function useNativeMediaGateway(): NativeMediaReading {
  const [reading, setReading] = useState<NativeMediaReading>({ status: null, error: null });
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const read = (): void => {
      void readNativeMediaGatewayStatus()
        .then((status) => {
          if (cancelled) return;
          setReading({ status, error: null });
          // Without a native shell one read is the whole answer, and a poll
          // would be a timer that can never change its own result.
          if (status !== null && timer === null) {
            timer = window.setInterval(read, nativeMediaGatewayPollMs);
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setReading({
            status: null,
            error: error instanceof Error ? error.message : 'MEDIA_GATEWAY_ERROR',
          });
        });
    };
    read();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, []);
  return reading;
}

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

function NativeMediaGatewayReport({
  reading,
  presentation,
}: {
  readonly reading: NativeMediaReading;
  readonly presentation: TilePresentation;
}) {
  if (reading.error !== null) {
    return <p className="system-native-media__notice">ШЛЮЗ НЕ ОТВЕЧАЕТ: {reading.error}</p>;
  }
  const status = reading.status;
  if (status === null) {
    return (
      <p className="system-native-media__notice">
        НАТИВНЫЙ МЕДИАШЛЮЗ ЕСТЬ ТОЛЬКО В ДЕСКТОП-СБОРКЕ: В ВЕБ-СЕССИИ СЧЁТЧИКОВ ШЛЮЗА НЕТ.
      </p>
    );
  }
  return (
    <>
      {status.available ? null : (
        <p className="system-native-media__notice">ШЛЮЗ ОСТАНОВЛЕН: ПОТОКИ НЕ ОБСЛУЖИВАЮТСЯ.</p>
      )}
      <div className="metric-grid metric-grid--four">
        <Metric
          label="ИСТОЧНИКОВ"
          value={status.configuredStreams}
          detail={`ЛИМИТ ${status.maxWorkers}`}
        />
        <Metric
          label="АКТИВНО"
          value={status.activeStreams}
          detail={status.startingStreams > 0 ? `ЗАПУСК ${status.startingStreams}` : 'УСТОЙЧИВО'}
          tone={status.activeStreams > 0 ? 'ok' : 'normal'}
        />
        <Metric
          label="ПЕРЕПОДКЛЮЧЕНИЕ"
          value={status.reconnectingStreams}
          detail="BACKOFF"
          tone={status.reconnectingStreams > 0 ? 'warning' : 'normal'}
        />
        <Metric
          label="ОТКАЗ"
          value={status.failedStreams}
          detail="DEGRADED"
          tone={status.failedStreams > 0 ? 'critical' : 'normal'}
        />
      </div>
      {presentation === 'full' && status.streams.length > 0 ? (
        <table className="ops-table">
          <thead>
            <tr>
              <th>КАМЕРА</th>
              <th>СОСТОЯНИЕ</th>
              <th>ЗРИТЕЛИ</th>
              <th>СБОЕВ / ПЕРЕЗАПУСКОВ</th>
              <th>МАНИФЕСТ</th>
            </tr>
          </thead>
          <tbody>
            {status.streams.map((stream) => (
              <tr key={stream.cameraId}>
                <td>
                  <strong>{stream.cameraId}</strong>
                  <small>{stream.streamId}</small>
                </td>
                <td className={stream.state === 'degraded' ? 'is-critical' : ''}>
                  {stream.state.toUpperCase()}
                </td>
                <td>{stream.consumers}</td>
                <td>
                  {stream.consecutiveFailures} / {stream.totalRestarts}
                </td>
                <td>
                  {stream.manifestAgeMs === null
                    ? 'НЕТ'
                    : `${Math.round(stream.manifestAgeMs / 1000)} С`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="system-native-media__notice">ORIGIN: {status.origin}</p>
    </>
  );
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
  const loadWarningPercent = useNumberSetting('telemetry.loadWarningPercent');
  const nodeTemperatureLimit = useNumberSetting('telemetry.nodeTemperatureLimit');
  const signalFloorPercent = useNumberSetting('telemetry.signalFloorPercent');
  const showCharts = useBooleanSetting('telemetry.showCharts');
  const auditRows = useNumberSetting('diagnostics.auditRows');
  const telemetry = readTelemetry(telemetrySource, state.metrics);
  const sample = telemetry.sample;
  const nativeMedia = useNativeMediaGateway();

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
                tone={
                  sample === null ? 'normal' : sample.cpu > loadWarningPercent ? 'critical' : 'ok'
                }
              />
              <Metric
                label="RAM"
                value={sampleValue(sample?.ram)}
                detail={sample === null ? 'ОТСЧЁТА НЕТ' : '43.5 / 64 GB'}
                tone={
                  sample === null ? 'normal' : sample.ram > loadWarningPercent ? 'warning' : 'ok'
                }
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
            {presentation === 'full' && showCharts && sample !== null ? (
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
                    <td className={node.temperature > nodeTemperatureLimit ? 'is-critical' : ''}>
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
                  tone={channel.signal < signalFloorPercent ? 'critical' : 'ok'}
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
              {state.audit.slice(0, presentation === 'full' ? auditRows : 6).map((entry) => (
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
      {
        title: 'НАТИВНЫЙ МЕДИАШЛЮЗ',
        category: 'telemetry',
        descriptor: {
          id: 'native-media',
          priority: 70,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          hideWhenOverflow: true,
        },
        render: (presentation) => (
          <Panel
            title="НАТИВНЫЙ МЕДИАШЛЮЗ"
            eyebrow="NATIVE GATEWAY / RTSP TO HLS"
            className="system-native-media"
          >
            <NativeMediaGatewayReport reading={nativeMedia} presentation={presentation} />
          </Panel>
        ),
      },
    ],
    [
      auditRows,
      channels,
      loadWarningPercent,
      nativeMedia,
      nodeTemperatureLimit,
      nodes,
      sample,
      showCharts,
      signalFloorPercent,
      state,
      telemetry,
    ],
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
