'use client';

import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { useTranslate } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import { channelDomain } from '@/application/simulation/simulationCurves';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import {
  Gauge,
  Metric,
  Panel,
  ProgressBar,
  SeverityBadge,
  Sparkline,
} from '@/components/operations/OpsUi';
import { useOperationsStore } from '@/state/operationsStore';

const riskForecast = [
  { id: 'analytics.forecastSignalLoss', code: 'K-17', value: 82, tone: 'critical' },
  { id: 'analytics.forecastOverload', code: 'CH-03', value: 64, tone: 'warning' },
  { id: 'analytics.forecastIntersection', code: 'S-03', value: 47, tone: 'warning' },
  { id: 'analytics.forecastDegradation', code: 'STORAGE-02', value: 21, tone: 'normal' },
] as const satisfies ReadonlyArray<{
  readonly id: MessageId;
  readonly code: string;
  readonly value: number;
  readonly tone: 'critical' | 'warning' | 'normal';
}>;

const sourceConfidence = [
  { id: 'field.kindVideo', value: 94 },
  { id: 'analytics.sourceRadioIntercept', value: 78 },
  { id: 'analytics.sourceFieldTeams', value: 88 },
  { id: 'analytics.sourceSensors', value: 91 },
  { id: 'analytics.sourceOpenSources', value: 63 },
] as const satisfies ReadonlyArray<{ readonly id: MessageId; readonly value: number }>;

type AnalyticsFilter = 'all' | 'intelligence' | 'collection' | 'analysis' | 'operations';

/** `overview.direction*` already carries three of these five words for the overview screen's own filter. */
const analyticsFilterLabelIds: Readonly<Record<AnalyticsFilter, MessageId>> = {
  all: 'analytics.filterAll',
  intelligence: 'overview.directionIntelligence',
  collection: 'overview.directionCollection',
  analysis: 'overview.directionAnalysis',
  operations: 'overview.directionOperations',
};

const analyticsFilters = [
  'all',
  'intelligence',
  'collection',
  'analysis',
  'operations',
] as const satisfies readonly AnalyticsFilter[];

export function AnalyticsScreen() {
  const translate = useTranslate();
  const state = useOperationsStore((value) => value);
  const objects = useMemo(() => Object.values(state.objects), [state.objects]);
  const sectors = useMemo(() => Object.values(state.sectors), [state.sectors]);
  const insights = useMemo(() => Object.values(state.insights), [state.insights]);
  const activeObjects = objects.filter(
    (object) => object.status === 'ACTIVE' || object.status === 'WATCHED',
  );
  const averageThreat = Math.round(
    objects.reduce((sum, object) => sum + object.threat, 0) / objects.length,
  );
  const averageSignal = Math.round(
    objects.reduce((sum, object) => sum + object.signal, 0) / objects.length,
  );

  /*
   * Only `matrix` names a route: `/map` shows the same sectors as ground
   * rather than as a table. The rest are this screen's own reading of records
   * held elsewhere -- there is no second screen that draws them -- so they
   * hide rather than promise somewhere to go.
   */
  const tiles: readonly ScreenTile[] = useMemo(
    () => [
      {
        title: translate('analytics.indexTitle'),
        category: 'summary',
        descriptor: {
          id: 'index',
          priority: 100,
          variants: [
            { presentation: 'full', columns: 1, rows: 2 },
            { presentation: 'compact', columns: 1, rows: 1 },
          ],
          canStretchVertically: true,
        },
        render: (presentation) => (
          <Panel
            title={translate('analytics.indexTitle')}
            eyebrow={translate('analytics.indexEyebrow')}
            className="analytics-index"
          >
            <Gauge
              value={state.metrics.readiness}
              label={translate('analytics.circuitReadinessLabel')}
              detail={translate('analytics.thresholdDetail')}
            />
            <div className="analytics-index__readout">
              <Metric
                label={translate('analytics.metricActiveObjects')}
                value={activeObjects.length}
                tone="warning"
              />
              <Metric
                label={translate('analytics.metricAverageThreat')}
                value={`${averageThreat}%`}
                tone={averageThreat > 55 ? 'warning' : 'normal'}
              />
              <Metric
                label={translate('analytics.metricSignalQuality')}
                value={`${averageSignal}%`}
                tone="ok"
              />
              <Metric
                label={translate('analytics.metricForecast')}
                value={translate('analytics.forecastStableValue')}
                detail={translate('analytics.forecastHorizonDetail')}
                tone="ok"
              />
            </div>
            {presentation === 'full' ? (
              <Sparkline
                values={state.metricsHistory.readiness}
                domain={channelDomain('readiness')}
                label={translate('analytics.indexSparklineLabel')}
              />
            ) : null}
          </Panel>
        ),
      },
      {
        title: translate('analytics.insightsTitle'),
        category: 'summary',
        descriptor: {
          id: 'insights',
          priority: 95,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          hideWhenOverflow: true,
        },
        render: (presentation) => (
          <Panel
            title={translate('analytics.insightsTitle')}
            eyebrow={translate('analytics.insightsEyebrow')}
            className="analytics-insights"
          >
            {insights.slice(0, presentation === 'full' ? insights.length : 2).map((insight) => (
              <TerminalButton
                key={insight.id}
                onClick={() => state.openDrawer('insight', insight.id)}
              >
                <SeverityBadge severity={insight.priority} />
                <span>
                  <strong>{insight.title}</strong>
                  <small>{insight.explanation}</small>
                </span>
                <i>{insight.linkedObjectIds.join(' / ')}</i>
              </TerminalButton>
            ))}
          </Panel>
        ),
      },
      {
        title: translate('analytics.matrixTitle'),
        category: 'geo',
        descriptor: {
          id: 'matrix',
          priority: 90,
          variants: [{ presentation: 'full', columns: 1, rows: 1 }],
          canStretchHorizontally: true,
          canStretchVertically: true,
          relocationRoute: '/map',
        },
        render: () => (
          <Panel
            title={translate('analytics.matrixTitle')}
            eyebrow={translate('analytics.matrixEyebrow')}
            className="analytics-matrix"
          >
            <div className="sector-matrix">
              {sectors.map((sector) => (
                <TerminalButton
                  key={sector.id}
                  style={
                    {
                      '--threat': `${sector.threat}%`,
                      '--readiness': `${sector.readiness}%`,
                    } as CSSProperties
                  }
                  onClick={() => state.setMapView([sector.center.lat, sector.center.lng], 14)}
                >
                  <strong>{sector.code}</strong>
                  <span>{sector.name}</span>
                  <ProgressBar
                    value={sector.threat}
                    label={translate('field.threat')}
                    tone={sector.threat > 65 ? 'critical' : 'warning'}
                  />
                  <ProgressBar
                    value={sector.readiness}
                    label={translate('analytics.readyLabel')}
                    tone="ok"
                  />
                </TerminalButton>
              ))}
            </div>
          </Panel>
        ),
      },
      {
        title: translate('analytics.correlationTitle'),
        category: 'events',
        descriptor: {
          id: 'correlation',
          priority: 85,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          hideWhenOverflow: true,
        },
        render: (presentation) => (
          <Panel
            title={translate('analytics.correlationTitle')}
            eyebrow={translate('analytics.correlationEyebrow')}
            className="analytics-correlation"
          >
            <div
              className="correlation-chart"
              aria-label={translate('analytics.correlationChartAriaLabel')}
            >
              {state.events.slice(0, 48).map((event, index) => (
                <i
                  key={event.id}
                  className={`is-${event.severity}`}
                  style={{
                    left: `${(index % 16) * 6.25 + 1}%`,
                    bottom: `${10 + ((index * 17) % 70)}%`,
                  }}
                  title={event.title}
                />
              ))}
              <span className="correlation-chart__axis">00:00 ─ 02:00 ─ 04:00 ─ 06:00 ─ 08:00</span>
            </div>
            {presentation === 'full' ? (
              <div className="analytics-legend">
                <span>
                  <i className="is-normal" />
                  {translate('analytics.legendNormal')}
                </span>
                <span>
                  <i className="is-warning" />
                  {translate('analytics.legendDeviation')}
                </span>
                <span>
                  <i className="is-critical" />
                  {translate('analytics.legendCritical')}
                </span>
              </div>
            ) : null}
          </Panel>
        ),
      },
      {
        title: translate('analytics.forecastTitle'),
        category: 'telemetry',
        descriptor: {
          id: 'forecast',
          priority: 80,
          variants: [{ presentation: 'full', columns: 1, rows: 1 }],
          canStretchHorizontally: true,
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel
            title={translate('analytics.forecastTitle')}
            eyebrow={translate('analytics.forecastEyebrow')}
            className="analytics-forecast"
          >
            {riskForecast.map((item) => (
              <div key={item.id}>
                <span>{translate(item.id, { code: item.code })}</span>
                <ProgressBar value={item.value} tone={item.tone} />
                <b>{item.value}%</b>
              </div>
            ))}
          </Panel>
        ),
      },
      {
        title: translate('analytics.confidenceTitle'),
        category: 'telemetry',
        descriptor: {
          id: 'confidence',
          priority: 75,
          variants: [{ presentation: 'full', columns: 1, rows: 1 }],
          canStretchHorizontally: true,
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel
            title={translate('analytics.confidenceTitle')}
            eyebrow={translate('analytics.confidenceEyebrow')}
            className="analytics-confidence"
          >
            {sourceConfidence.map((item) => (
              <div key={item.id}>
                <span>{translate(item.id)}</span>
                <ProgressBar value={item.value} tone={item.value > 80 ? 'ok' : 'warning'} />
              </div>
            ))}
          </Panel>
        ),
      },
    ],
    [activeObjects.length, averageSignal, averageThreat, insights, sectors, state, translate],
  );

  return (
    <div className="ops-screen analytics-screen">
      <header className="ops-screen__title">
        <div>
          <span>{translate('analytics.headerEyebrow')}</span>
          <h1>{translate('analytics.headerTitle')}</h1>
        </div>
        <div className="ops-segmented">
          {analyticsFilters.map((filter) => (
            <TerminalButton
              key={filter}
              className={state.ui.analyticsFilter === filter ? 'is-active' : ''}
              onClick={() => state.setAnalyticsFilter(filter)}
            >
              [{filter === 'all' ? '*' : filter.slice(0, 3).toUpperCase()}]{' '}
              {translate(analyticsFilterLabelIds[filter])}
            </TerminalButton>
          ))}
        </div>
      </header>

      <TileGrid tiles={tiles} columns={3} className="analytics-layout" screen="analytics" />
    </div>
  );
}
