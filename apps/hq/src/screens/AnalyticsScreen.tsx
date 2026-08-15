'use client';

import { useMemo } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

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

      <div className="analytics-layout">
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
          <Sparkline values={analyticalSeries} label="Динамика индекса оперативной обстановки" />
        </Panel>

        <Panel
          title="КЛЮЧЕВЫЕ ВЫВОДЫ"
          eyebrow="INSIGHTS / MACHINE ASSISTED"
          className="analytics-insights"
        >
          {insights.map((insight) => (
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

        <Panel title="МАТРИЦА СЕКТОРОВ" eyebrow="THREAT × READINESS" className="analytics-matrix">
          <div className="sector-matrix">
            {sectors.map((sector) => (
              <TerminalButton
                key={sector.id}
                style={
                  {
                    '--threat': `${sector.threat}%`,
                    '--readiness': `${sector.readiness}%`,
                  } as React.CSSProperties
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
        </Panel>

        <Panel
          title="ПРОГНОЗ РИСКОВ"
          eyebrow="LOCAL HEURISTIC / 45 MIN"
          className="analytics-forecast"
        >
          {[
            ['ПОТЕРЯ СИГНАЛА K-17', 82, 'critical'],
            ['ПЕРЕГРУЗКА CH-03', 64, 'warning'],
            ['ПЕРЕСЕЧЕНИЕ S-03', 47, 'warning'],
            ['ДЕГРАДАЦИЯ STORAGE-02', 21, 'normal'],
          ].map(([label, value, tone]) => (
            <div key={String(label)}>
              <span>{label}</span>
              <ProgressBar value={Number(value)} tone={tone as 'normal' | 'warning' | 'critical'} />
              <b>{value}%</b>
            </div>
          ))}
        </Panel>

        <Panel
          title="НАДЁЖНОСТЬ ДАННЫХ"
          eyebrow="SOURCES / CONFIDENCE"
          className="analytics-confidence"
        >
          {[
            ['ВИДЕО', 94],
            ['РАДИОПЕРЕХВАТ', 78],
            ['ПОЛЕВЫЕ ГРУППЫ', 88],
            ['СЕНСОРЫ', 91],
            ['ОТКРЫТЫЕ ИСТОЧНИКИ', 63],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <span>{label}</span>
              <ProgressBar value={Number(value)} tone={Number(value) > 80 ? 'ok' : 'warning'} />
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}
