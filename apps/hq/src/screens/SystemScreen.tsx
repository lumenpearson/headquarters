'use client';

import { useEffect, useMemo, useState } from 'react';
import type { TilePresentation } from '@gremuchaya/layout-engine';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { dateTimeFormat } from '@/application/localization/intl';
import { t, useTranslate } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import {
  useBooleanSetting,
  useNumberSetting,
  useStringSetting,
} from '@/application/personalization/useSetting';
import { channelDomain, scatteredAreaReading } from '@/application/simulation/simulationCurves';
import { useTelemetryMeasurement } from '@/application/telemetry/useTelemetryMeasurement';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { Metric, Panel, ProgressBar, Sparkline, StatusBadge } from '@/components/operations/OpsUi';
import {
  readNativeMediaGatewayStatus,
  type NativeMediaGatewayStatus,
} from '@/infrastructure/tauri/nativeMediaGatewayStatus';
import { useOperationsStore, type OperationsState } from '@/state/operationsStore';

const storageAreas = ['CORE', 'EVENTS', 'VIDEO', 'EVIDENCE', 'ARCHIVE', 'SNAPSHOTS'] as const;

/** `storageAreas`'s six labels, in the operator's language. */
const storageAreaLabelIds: Readonly<Record<(typeof storageAreas)[number], MessageId>> = {
  CORE: 'system.storageAreaCore',
  EVENTS: 'system.storageAreaEvents',
  VIDEO: 'system.storageAreaVideo',
  EVIDENCE: 'system.storageAreaEvidence',
  ARCHIVE: 'nav.archive',
  SNAPSHOTS: 'system.storageAreaSnapshots',
};

const clockParts = { timeStyle: 'medium' } as const;

/**
 * How far a storage area's reading may scatter from the contour's own
 * `storage` channel, in display percentage points either side of it.
 */
const storageAreaSpread = 18;

/** How often the measured telemetry panel re-reads the registered client. */
const telemetryMeasurementPollMs = 5_000;

/**
 * `gremuchaya.telemetry.v1.TelemetrySeverity`'s four bands, read into the
 * tones `Metric` draws — the same fold `apps/control-plane` applies to its
 * own operational log (`operationsStore.ts`, `eventSeverities`): `elevated`
 * reads calmly, alongside `normal`, because a four-band severity and a
 * three-tone metric cannot both keep their own vocabulary. `unspecified` — a
 * source the registry names but no sample reached, or a channel a stored
 * profile no longer carries (`apps/control-plane/src/telemetry/service.ts`,
 * `readSource`) — reads as the metric's own `normal` tone, never as `ok`: it
 * is not a measurement of a calm reading, it is the absence of one.
 */
function metricToneFor(
  severity: 'normal' | 'elevated' | 'degraded' | 'critical' | 'unspecified',
): 'normal' | 'ok' | 'warning' | 'critical' {
  if (severity === 'critical') return 'critical';
  if (severity === 'degraded') return 'warning';
  if (severity === 'normal' || severity === 'elevated') return 'ok';
  return 'normal';
}

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
      caption: t('system.telemetryNativeCaption'),
      seriesTag: t('system.telemetrySeriesTagNative'),
      sample: null,
      notice: t('system.telemetryNativeNotice'),
    };
  }
  if (source === 'hybrid') {
    return {
      caption: t('system.telemetryHybridCaption'),
      seriesTag: t('system.telemetrySeriesTagSimulated'),
      sample: simulated,
      notice: t('system.telemetryHybridNotice'),
    };
  }
  return {
    caption: t('system.telemetrySimulationCaption'),
    seriesTag: t('system.telemetrySeriesTagSimulated'),
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
    return (
      <p className="system-native-media__notice">
        {t('system.mediaGatewayNoResponse', { error: reading.error })}
      </p>
    );
  }
  const status = reading.status;
  if (status === null) {
    return <p className="system-native-media__notice">{t('system.mediaGatewayWebOnlyNotice')}</p>;
  }
  return (
    <>
      {status.available ? null : (
        <p className="system-native-media__notice">{t('system.mediaGatewayStoppedNotice')}</p>
      )}
      <div className="metric-grid metric-grid--four">
        <Metric
          label={t('system.mediaGatewaySourcesLabel')}
          value={status.configuredStreams}
          detail={t('system.mediaGatewayLimitDetail', { limit: status.maxWorkers })}
        />
        <Metric
          label={t('system.mediaGatewayActiveLabel')}
          value={status.activeStreams}
          detail={
            status.startingStreams > 0
              ? t('system.mediaGatewayStartingDetail', { count: status.startingStreams })
              : t('system.mediaGatewayStableDetail')
          }
          tone={status.activeStreams > 0 ? 'ok' : 'normal'}
        />
        <Metric
          label={t('system.mediaGatewayReconnectingLabel')}
          value={status.reconnectingStreams}
          detail={t('system.mediaGatewayBackoffDetail')}
          tone={status.reconnectingStreams > 0 ? 'warning' : 'normal'}
        />
        <Metric
          label={t('system.mediaGatewayFailedLabel')}
          value={status.failedStreams}
          detail={t('system.mediaGatewayDegradedDetail')}
          tone={status.failedStreams > 0 ? 'critical' : 'normal'}
        />
      </div>
      {presentation === 'full' && status.streams.length > 0 ? (
        <table className="ops-table">
          <thead>
            <tr>
              <th>{t('system.mediaGatewayColumnCamera')}</th>
              <th>{t('system.mediaGatewayColumnState')}</th>
              <th>{t('system.mediaGatewayColumnViewers')}</th>
              <th>{t('system.mediaGatewayColumnFailuresRestarts')}</th>
              <th>{t('system.mediaGatewayColumnManifest')}</th>
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
                    ? t('system.mediaGatewayManifestNone')
                    : `${Math.round(stream.manifestAgeMs / 1000)} ${t('systemUnit.seconds')}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="system-native-media__notice">
        {t('system.mediaGatewayOriginLabel', { origin: status.origin })}
      </p>
    </>
  );
}

export function SystemScreen() {
  const state = useOperationsStore((value) => value);
  // Subscribed, unlike `t`: `measuredTelemetryTile` below is memoised on
  // `measurement` alone, and its `title` field is a plain property rather
  // than a closure, fixed at build time. Without this the tile would keep
  // whichever language was in force when the measurement client first
  // answered, since nothing about a locale change would otherwise touch that
  // memo's dependency list.
  const translate = useTranslate();
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
  const simulationSeed = useNumberSetting('simulation.seed');
  const telemetry = readTelemetry(telemetrySource, state.metrics);
  const sample = telemetry.sample;
  const nativeMedia = useNativeMediaGateway();
  const measurement = useTelemetryMeasurement(telemetryMeasurementPollMs);
  const measuredTelemetryTile: ScreenTile | null = useMemo(
    () =>
      measurement !== null && measurement.available
        ? {
            title: translate('system.measuredTelemetryTitle'),
            category: 'telemetry',
            descriptor: {
              id: 'measured-telemetry',
              priority: 65,
              variants: [
                { presentation: 'full', columns: 2, rows: 1 },
                { presentation: 'minimal', columns: 1, rows: 1 },
              ],
              canStretchHorizontally: true,
              hideWhenOverflow: true,
            },
            render: () => (
              <Panel
                title={translate('system.measuredTelemetryTitle')}
                eyebrow={translate('system.measuredTelemetryEyebrow')}
                className="system-measured-telemetry"
              >
                <div className="metric-grid metric-grid--four">
                  {measurement.sources.map((source) => (
                    <Metric
                      key={source.sourceKey}
                      label={source.name}
                      value={source.value === undefined ? '—' : `${source.value}${source.unit}`}
                      detail={
                        source.simulated
                          ? translate('system.simulatedSourceDetail')
                          : translate('system.hostSourceDetail')
                      }
                      tone={metricToneFor(source.severity)}
                    />
                  ))}
                </div>
              </Panel>
            ),
          }
        : null,
    [measurement, translate],
  );

  /*
   * `systemNodes` and `audit` are read by this screen and no other, so both
   * declare `hideWhenOverflow` rather than a route: there is nowhere else that
   * shows those records. `network` has one -- `/communications` shows the same
   * channels in full.
   */
  const tiles: readonly ScreenTile[] = useMemo(
    () => [
      {
        title: t('system.resourcesTitle'),
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
            title={t('system.resourcesTitle')}
            eyebrow={`${t('system.resourcesHostPrefix')} / ${telemetry.caption}`}
            className="system-resources"
          >
            {telemetry.notice === null ? null : (
              <p className="system-resources__source">{telemetry.notice}</p>
            )}
            <div className="metric-grid metric-grid--four">
              <Metric
                label={t('system.metricLabelCpu')}
                value={sampleValue(sample?.cpu)}
                detail={
                  sample === null ? t('system.metricNoSampleDetail') : t('system.cpuSpecDetail')
                }
                tone={
                  sample === null ? 'normal' : sample.cpu > loadWarningPercent ? 'critical' : 'ok'
                }
              />
              <Metric
                label={t('system.metricLabelRam')}
                value={sampleValue(sample?.ram)}
                detail={
                  sample === null ? t('system.metricNoSampleDetail') : t('system.ramSpecDetail')
                }
                tone={
                  sample === null ? 'normal' : sample.ram > loadWarningPercent ? 'warning' : 'ok'
                }
              />
              <Metric
                label={t('system.metricLabelGpu')}
                value={sampleValue(sample?.gpu)}
                detail={
                  sample === null ? t('system.metricNoSampleDetail') : t('system.gpuSpecDetail')
                }
                tone={sample === null ? 'normal' : 'ok'}
              />
              <Metric
                label={t('system.metricLabelStorage')}
                value={sampleValue(sample?.storage)}
                detail={
                  sample === null ? t('system.metricNoSampleDetail') : t('system.storageSpecDetail')
                }
                tone={sample === null ? 'normal' : 'warning'}
              />
            </div>
            {/*
             * No sample, no charts. The series is `metricsHistory`, which the
             * simulation fills reading by reading (R31) — so it is the same
             * source `sample` is under `simulation` and `hybrid`, and under
             * `native` there is no sample and nothing is drawn. A host sampler
             * landing later has to fill a history of its own before these plot
             * anything, rather than borrowing the simulated one.
             */}
            {presentation === 'full' && showCharts && sample !== null ? (
              <div className="resource-charts">
                <div>
                  <span>
                    {t('system.metricLabelCpu')} / {state.metricsHistory.cpu.length}{' '}
                    {t('systemUnit.samples')} / {telemetry.seriesTag}
                  </span>
                  <Sparkline
                    values={state.metricsHistory.cpu}
                    domain={channelDomain('cpu')}
                    label={`${t('system.metricLabelCpu')} / ${telemetry.seriesTag}`}
                  />
                </div>
                <div>
                  <span>
                    {t('system.networkInLabel')} / {state.metricsHistory.networkIn.length}{' '}
                    {t('systemUnit.samples')} / {telemetry.seriesTag}
                  </span>
                  <Sparkline
                    values={state.metricsHistory.networkIn}
                    domain={channelDomain('network-in')}
                    label={`${t('system.networkInSparklineLabel')} / ${telemetry.seriesTag}`}
                  />
                </div>
                {/*
                 * The outbound half. Before this the panel drew only
                 * `network-in`, so an operator reading `/system` saw one side
                 * of the graph and had no way to tell a quiet uplink from one
                 * this screen never showed.
                 */}
                <div>
                  <span>
                    {t('system.networkOutLabel')} / {state.metricsHistory.networkOut.length}{' '}
                    {t('systemUnit.samples')} / {telemetry.seriesTag}
                  </span>
                  <Sparkline
                    values={state.metricsHistory.networkOut}
                    domain={channelDomain('network-out')}
                    label={`${t('system.networkOutSparklineLabel')} / ${telemetry.seriesTag}`}
                  />
                </div>
              </div>
            ) : null}
          </Panel>
        ),
      },
      {
        title: t('system.nodesTitle'),
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
          <Panel
            title={t('system.nodesTitle')}
            eyebrow={t('system.nodesEyebrow')}
            className="system-nodes"
          >
            <table className="ops-table">
              <thead>
                <tr>
                  <th>{t('system.nodesColumnNode')}</th>
                  <th>{t('system.nodesColumnTypeIp')}</th>
                  <th>{t('system.nodesColumnStatus')}</th>
                  <th>{t('system.nodesColumnLoad')}</th>
                  <th>{t('system.nodesColumnTemp')}</th>
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
        title: t('system.networkTitle'),
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
          <Panel
            title={t('system.networkTitle')}
            eyebrow={t('system.networkEyebrow')}
            className="system-network"
          >
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
                    {channel.encryption} · {channel.latency} {t('unit.ms')} ·{' '}
                    {t('system.packetLossLabel')} {channel.packetLoss}%
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
        title: t('system.auditTitle'),
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
            title={t('system.auditTitle')}
            eyebrow={t('system.auditEyebrow')}
            className="system-audit"
          >
            <div className="audit-log">
              {state.audit.slice(0, presentation === 'full' ? auditRows : 6).map((entry) => (
                <div key={entry.id}>
                  <time>{dateTimeFormat(clockParts).format(new Date(entry.timestamp))}</time>
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
        title: t('system.storageTitle'),
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
          <Panel
            title={t('system.storageTitle')}
            eyebrow={t('system.storageEyebrow')}
            className="system-storage"
          >
            <div className="storage-map">
              {storageAreas.map((item, index) => (
                <div key={item}>
                  <i>[{String(index + 1).padStart(2, '0')}]</i>
                  <span>{t(storageAreaLabelIds[item])}</span>
                  <b>
                    {scatteredAreaReading(
                      state.metrics.storage,
                      BigInt(Math.trunc(simulationSeed)),
                      state.metrics.simulationStep * storageAreas.length + index,
                      storageAreaSpread,
                    )}
                    %
                  </b>
                </div>
              ))}
            </div>
            <p>{t('system.storageIntegrityNote')}</p>
          </Panel>
        ),
      },
      {
        title: t('system.nativeMediaTitle'),
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
            title={t('system.nativeMediaTitle')}
            eyebrow={t('system.nativeMediaEyebrow')}
            className="system-native-media"
          >
            <NativeMediaGatewayReport reading={nativeMedia} presentation={presentation} />
          </Panel>
        ),
      },
      /*
       * The measured half beside the simulated readings above (R31). Present
       * only once a `TelemetryClient` is registered
       * (`application/telemetry/telemetryMeasurementClient.ts`) and answers
       * with real sources: no deployment does yet, so this screen degrades to
       * exactly what it drew before the measurement half existed, tile
       * absent rather than a panel reporting "not built" on every session.
       */
      ...(measuredTelemetryTile === null ? [] : [measuredTelemetryTile]),
    ],
    [
      auditRows,
      channels,
      loadWarningPercent,
      measuredTelemetryTile,
      nativeMedia,
      nodeTemperatureLimit,
      nodes,
      sample,
      showCharts,
      signalFloorPercent,
      simulationSeed,
      state,
      telemetry,
    ],
  );

  return (
    <div className="ops-screen system-screen">
      <header className="ops-screen__title">
        <div>
          <span>
            {t('system.controlNodeLabel')} / {state.production.screenId}
          </span>
          <h1>{t('system.screenTitle')}</h1>
        </div>
        <div className="system-health">
          <i />
          {t('system.contourStableLabel')} /{' '}
          {t('system.nodesNormalCount', {
            normal: nodes.filter((node) => node.status === 'NORMAL' || node.status === 'ACTIVE')
              .length,
            count: nodes.length,
          })}
        </div>
      </header>
      <TileGrid tiles={tiles} columns={3} className="system-layout" screen="system" />
    </div>
  );
}
