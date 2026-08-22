'use client';

import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

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

const analyticalSeries = [42, 48, 45, 58, 61, 54, 68, 72, 67, 78, 84, 81, 88, 86, 92, 89];

const riskForecast = [
  ['ПОТЕРЯ СИГНАЛА K-17', 82, 'critical'],
  ['ПЕРЕГРУЗКА CH-03', 64, 'warning'],
  ['ПЕРЕСЕЧЕНИЕ S-03', 47, 'warning'],
  ['ДЕГРАДАЦИЯ STORAGE-02', 21, 'normal'],
] as const;

const sourceConfidence = [
  ['ВИДЕО', 94],
  ['РАДИОПЕРЕХВАТ', 78],
  ['ПОЛЕВЫЕ ГРУППЫ', 88],
  ['СЕНСОРЫ', 91],
  ['ОТКРЫТЫЕ ИСТОЧНИКИ', 63],
] as const;

export function AnalyticsScreen() {
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
        title: 'ИНДЕКС ОПЕРАЦИОННОЙ ОБСТАНОВКИ',
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
            title="ИНДЕКС ОПЕРАЦИОННОЙ ОБСТАНОВКИ"
            eyebrow="COMPOSITE SCORE / T+07:42"
            className="analytics-index"
          >
            <Gauge value={state.metrics.readiness} label="ГОТОВНОСТЬ КОНТУРА" detail="ПОРОГ: 80%" />
            <div className="analytics-index__readout">
              <Metric label="АКТИВНЫЕ ОБЪЕКТЫ" value={activeObjects.length} tone="warning" />
              <Metric
                label="СРЕДНЯЯ УГРОЗА"
                value={`${averageThreat}%`}
                tone={averageThreat > 55 ? 'warning' : 'normal'}
              />
              <Metric label="КАЧЕСТВО СИГНАЛА" value={`${averageSignal}%`} tone="ok" />
              <Metric label="ПРОГНОЗ" value="STABLE+" detail="ГОРИЗОНТ 45 МИН" tone="ok" />
            </div>
            {presentation === 'full' ? (
              <Sparkline
                values={analyticalSeries}
                label="Динамика индекса оперативной обстановки"
              />
            ) : null}
          </Panel>
        ),
      },
      {
        title: 'КЛЮЧЕВЫЕ ВЫВОДЫ',
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
            title="КЛЮЧЕВЫЕ ВЫВОДЫ"
            eyebrow="INSIGHTS / MACHINE ASSISTED"
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
        title: 'МАТРИЦА СЕКТОРОВ',
        descriptor: {
          id: 'matrix',
          priority: 90,
          variants: [{ presentation: 'full', columns: 1, rows: 1 }],
          canStretchHorizontally: true,
          canStretchVertically: true,
          relocationRoute: '/map',
        },
        render: () => (
          <Panel title="МАТРИЦА СЕКТОРОВ" eyebrow="THREAT × READINESS" className="analytics-matrix">
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
                    label="THREAT"
                    tone={sector.threat > 65 ? 'critical' : 'warning'}
                  />
                  <ProgressBar value={sector.readiness} label="READY" tone="ok" />
                </TerminalButton>
              ))}
            </div>
          </Panel>
        ),
      },
      {
        title: 'КОРРЕЛЯЦИЯ СОБЫТИЙ',
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
            title="КОРРЕЛЯЦИЯ СОБЫТИЙ"
            eyebrow="EVENT BUS / LAST 120"
            className="analytics-correlation"
          >
            <div className="correlation-chart" aria-label="График корреляции событий">
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
                  НОРМА
                </span>
                <span>
                  <i className="is-warning" />
                  ОТКЛОНЕНИЕ
                </span>
                <span>
                  <i className="is-critical" />
                  КРИТИЧЕСКОЕ
                </span>
              </div>
            ) : null}
          </Panel>
        ),
      },
      {
        title: 'ПРОГНОЗ РИСКОВ',
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
            title="ПРОГНОЗ РИСКОВ"
            eyebrow="LOCAL HEURISTIC / 45 MIN"
            className="analytics-forecast"
          >
            {riskForecast.map(([label, value, tone]) => (
              <div key={label}>
                <span>{label}</span>
                <ProgressBar value={value} tone={tone} />
                <b>{value}%</b>
              </div>
            ))}
          </Panel>
        ),
      },
      {
        title: 'НАДЁЖНОСТЬ ДАННЫХ',
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
            title="НАДЁЖНОСТЬ ДАННЫХ"
            eyebrow="SOURCES / CONFIDENCE"
            className="analytics-confidence"
          >
            {sourceConfidence.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <ProgressBar value={value} tone={value > 80 ? 'ok' : 'warning'} />
              </div>
            ))}
          </Panel>
        ),
      },
    ],
    [activeObjects.length, averageSignal, averageThreat, insights, sectors, state],
  );

  return (
    <div className="ops-screen analytics-screen">
      <header className="ops-screen__title">
        <div>
          <span>ANALYTICAL CORE / LOCAL MODEL</span>
          <h1>ОПЕРАТИВНАЯ АНАЛИТИКА</h1>
        </div>
        <div className="ops-segmented">
          {['all', 'intelligence', 'collection', 'analysis', 'operations'].map((filter) => (
            <TerminalButton
              key={filter}
              className={state.ui.analyticsFilter === filter ? 'is-active' : ''}
              onClick={() => state.setAnalyticsFilter(filter)}
            >
              [{filter === 'all' ? '*' : filter.slice(0, 3).toUpperCase()}] {filter.toUpperCase()}
            </TerminalButton>
          ))}
        </div>
      </header>

      <TileGrid tiles={tiles} columns={3} className="analytics-layout" screen="analytics" />
    </div>
  );
}
