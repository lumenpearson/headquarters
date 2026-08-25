'use client';

import type { TilePresentation } from '@gremuchaya/layout-engine';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { EditableContent } from '@/components/edit/EditableContent';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import {
  Gauge,
  Metric,
  Panel,
  ProgressBar,
  SeverityBadge,
  StatusBadge,
} from '@/components/operations/OpsUi';
import { useOperationsStore } from '@/state/operationsStore';

/**
 * How many rows of a list a tile shows at each presentation.
 *
 * The resolver picks the presentation; the tile decides what less means. A
 * tile that only shrank its box would push the same content into a smaller
 * panel and hand the difference to the scrollbar, which is R30's fallback,
 * not R10's answer.
 */
const listLength: Readonly<Record<TilePresentation, number>> = {
  full: 8,
  compact: 4,
  minimal: 2,
};

const readinessRows = [
  ['ЛИЧНЫЙ СОСТАВ', 94, '/objects'],
  ['РАЗВЕДДАННЫЕ', 87, '/analytics'],
  ['ТЕХНИЧЕСКИЕ СРЕДСТВА', 82, '/system'],
  ['ПОДДЕРЖКА', 76, '/communications'],
  ['ЛОГИСТИКА', 91, '/map'],
] as const;

const directions = ['intelligence', 'collection', 'analysis', 'operations', 'support'] as const;

const evidenceKinds = ['video', 'audio', 'document', 'report', 'map', 'image'] as const;

export function OverviewScreen() {
  const router = useRouter();
  const operation = useOperationsStore((state) => state.operation);
  const sectors = useOperationsStore((state) => Object.values(state.sectors));
  const objects = useOperationsStore((state) => Object.values(state.objects));
  const tasks = useOperationsStore((state) => Object.values(state.tasks));
  const attachments = useOperationsStore((state) => Object.values(state.attachments));
  const events = useOperationsStore((state) => state.events.slice(0, 8));
  const alerts = useOperationsStore((state) => Object.values(state.alerts));
  const metrics = useOperationsStore((state) => state.metrics);
  const openDrawer = useOperationsStore((state) => state.openDrawer);
  const selectObject = useOperationsStore((state) => state.selectObject);
  const setFileFilter = useOperationsStore((state) => state.setFileKindFilter);
  const setAnalyticsFilter = useOperationsStore((state) => state.setAnalyticsFilter);

  const completedTasks = tasks.filter((task) => task.status === 'completed').length;
  const activeTasks = tasks.filter((task) => task.status === 'active').length;
  const evidence = evidenceKinds.map((kind) => ({
    kind,
    count: attachments.filter((file) => file.kind === kind).length,
  }));

  /*
   * Priority is the order the operator would give a tile up in, not the order
   * the tiles are written, and it is read from what a shift needs to know
   * about the state of the operation: what the operation is (`brief`), where
   * the danger is (`threats`), how the objects stand (`targets`), what just
   * happened (`events`), and only then the roll-ups that summarise those same
   * records from another angle. The tiles that declare `relocationRoute` all have a
   * screen of their own showing the same records in full, which is what makes
   * them safe to move; `objectives` and `tasks` have none and say so with
   * `hideWhenOverflow` rather than pointing at a route that shows something
   * else. Measured, not assumed: `state.tasks` is read by this screen alone.
   *
   * `brief` declares no overflow policy because it cannot need one: it holds
   * the highest priority, so it is placed first into an empty grid, and its
   * `minimal` variant is one cell of a grid that always has at least four.
   */
  const tiles: readonly ScreenTile[] = useMemo(
    () => [
      {
        title: 'ОБЗОР ОПЕРАЦИИ',
        category: 'summary',
        descriptor: {
          id: 'brief',
          priority: 100,
          variants: [
            { presentation: 'full', columns: 2, rows: 2 },
            { presentation: 'compact', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          canStretchVertically: true,
        },
        render: (presentation) => (
          <Panel
            title="ОБЗОР ОПЕРАЦИИ"
            eyebrow="BRIEF / CURRENT PHASE"
            className="overview-brief"
            actions={
              <TerminalButton
                className="ops-link-button"
                onClick={() => openDrawer('event', events[0]?.id ?? 'EV-01')}
              >
                [ENTER] ПОЛНАЯ КАРТОЧКА
              </TerminalButton>
            }
          >
            <p>
              <EditableContent field="operation.summary" entityId={operation.id}>
                {operation.summary}
              </EditableContent>
            </p>
            {presentation === 'full' ? (
              <TerminalButton className="operation-schematic" onClick={() => router.push('/map')}>
                <svg viewBox="0 0 600 220" aria-label="Схема сектора операции">
                  {Array.from({ length: 9 }, (_, row) =>
                    Array.from({ length: 23 }, (_, column) => (
                      <circle
                        key={`${row}-${column}`}
                        cx={16 + column * 26}
                        cy={14 + row * 24}
                        r="1.5"
                      />
                    )),
                  )}
                  <path d="M40 174C138 126 188 150 256 91S422 44 552 74" />
                  <circle className="is-target" cx="385" cy="61" r="8" />
                  <circle className="is-target-ring" cx="385" cy="61" r="20" />
                </svg>
                <span>СЕКТОР S-03 / TARGET K-17 / ФАЗА {operation.currentPhase}</span>
              </TerminalButton>
            ) : null}
          </Panel>
        ),
      },
      {
        title: 'ХРОНОЛОГИЯ ОПЕРАЦИИ',
        category: 'events',
        descriptor: {
          id: 'timeline',
          priority: 80,
          variants: [
            { presentation: 'full', columns: 4, rows: 1 },
            { presentation: 'compact', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          relocationRoute: '/analytics',
        },
        render: (presentation) => (
          <Panel
            title="ХРОНОЛОГИЯ ОПЕРАЦИИ"
            eyebrow="TIMELINE / 09–19 SEP"
            className="overview-timeline"
          >
            <div className="operation-timeline">
              {[...events.slice(0, 7)]
                .reverse()
                .slice(0, listLength[presentation])
                .map((event, index) => (
                  <TerminalButton
                    key={event.id}
                    className={index < 4 ? 'is-complete' : index === 4 ? 'is-current' : ''}
                    onClick={() => openDrawer('event', event.id)}
                    title={event.description}
                  >
                    <i />
                    <time>
                      {new Date(event.timestamp).toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                    <strong>{event.title}</strong>
                    <small>{event.source}</small>
                  </TerminalButton>
                ))}
            </div>
          </Panel>
        ),
      },
      {
        title: 'ГОТОВНОСТЬ К МИССИИ',
        category: 'telemetry',
        descriptor: {
          id: 'readiness',
          priority: 75,
          variants: [
            { presentation: 'full', columns: 1, rows: 2 },
            { presentation: 'compact', columns: 1, rows: 1 },
          ],
          canStretchVertically: true,
          relocationRoute: '/analytics',
        },
        render: (presentation) => (
          <Panel
            title="ГОТОВНОСТЬ К МИССИИ"
            eyebrow="MISSION / READINESS"
            className="overview-readiness"
          >
            <Gauge value={metrics.readiness} label="ОБЩАЯ ГОТОВНОСТЬ" detail="ПОРOГ ДОПУСКА 80%" />
            <div className="readiness-list">
              {readinessRows.slice(0, listLength[presentation]).map(([label, value, href]) => (
                <TerminalButton key={label} onClick={() => router.push(href)}>
                  <span>{label}</span>
                  <ProgressBar value={value} />
                </TerminalButton>
              ))}
            </div>
          </Panel>
        ),
      },
      {
        title: 'УРОВЕНЬ УГРОЗЫ ПО СЕКТОРАМ',
        category: 'geo',
        descriptor: {
          id: 'threats',
          priority: 95,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          relocationRoute: '/map',
        },
        render: (presentation) => (
          <Panel
            title="УРОВЕНЬ УГРОЗЫ ПО СЕКТОРАМ"
            eyebrow="THREAT / SECTORS"
            className="overview-threats"
          >
            <div className="threat-list">
              {sectors.slice(0, listLength[presentation]).map((sector) => (
                <TerminalButton
                  key={sector.id}
                  onClick={() => router.push(`/map?sector=${sector.id}`)}
                >
                  <span>
                    <strong>{sector.code}</strong>
                    <small>{sector.name}</small>
                  </span>
                  <ProgressBar
                    value={sector.threat}
                    tone={sector.threat > 70 ? 'critical' : sector.threat > 45 ? 'warning' : 'ok'}
                  />
                  <b>{sector.threat}</b>
                </TerminalButton>
              ))}
            </div>
            <footer>
              <span>АКТИВНЫХ ТРЕВОГ</span>
              <strong>{alerts.filter((alert) => alert.lifecycle !== 'RESOLVED').length}</strong>
              <TerminalButton
                onClick={() =>
                  openDrawer(
                    'alert',
                    alerts.find((alert) => alert.lifecycle === 'NEW')?.id ?? 'AL-101',
                  )
                }
              >
                [ENTER] ПЕРВАЯ ТРЕВОГА
              </TerminalButton>
            </footer>
          </Panel>
        ),
      },
      {
        title: 'ПОСЛЕДНИЕ ОБНОВЛЕНИЯ',
        category: 'events',
        descriptor: {
          id: 'events',
          priority: 85,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          relocationRoute: '/analytics',
        },
        render: (presentation) => (
          <Panel
            title="ПОСЛЕДНИЕ ОБНОВЛЕНИЯ"
            eyebrow="EVENT BUS / LIVE"
            className="overview-events"
          >
            <div className="event-feed">
              {events.slice(0, listLength[presentation]).map((event) => (
                <TerminalButton key={event.id} onClick={() => openDrawer('event', event.id)}>
                  <time>{new Date(event.timestamp).toLocaleTimeString('ru-RU')}</time>
                  <i className={`severity-dot severity-dot--${event.severity}`} />
                  <span>
                    <strong>{event.title}</strong>
                    <small>
                      {event.source} / {event.linkedObjectIds.join(', ')}
                    </small>
                  </span>
                </TerminalButton>
              ))}
            </div>
          </Panel>
        ),
      },
      {
        title: 'ЦЕЛИ ОПЕРАЦИИ',
        category: 'records',
        descriptor: {
          id: 'objectives',
          priority: 70,
          variants: [
            { presentation: 'full', columns: 1, rows: 2 },
            { presentation: 'compact', columns: 1, rows: 1 },
          ],
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: (presentation) => (
          <Panel
            title="ЦЕЛИ ОПЕРАЦИИ"
            eyebrow="OBJECTIVES / CHECKLIST"
            className="overview-objectives"
          >
            <ol className="objective-list">
              {tasks.slice(0, listLength[presentation]).map((task) => (
                <li key={task.id} className={`is-${task.status}`}>
                  <TerminalButton onClick={() => openDrawer('task', task.id)}>
                    <i>
                      {task.status === 'completed'
                        ? '[X]'
                        : task.status === 'active'
                          ? '[>]'
                          : task.status === 'blocked'
                            ? '[!]'
                            : '[ ]'}
                    </i>
                    <span>{task.title}</span>
                    <b>{task.progress}%</b>
                  </TerminalButton>
                </li>
              ))}
            </ol>
          </Panel>
        ),
      },
      {
        title: 'КЛЮЧЕВЫЕ ВЕХИ',
        category: 'events',
        descriptor: {
          id: 'milestones',
          priority: 65,
          variants: [
            { presentation: 'full', columns: 1, rows: 2 },
            { presentation: 'compact', columns: 1, rows: 1 },
          ],
          canStretchVertically: true,
          relocationRoute: '/analytics',
        },
        render: (presentation) => (
          <Panel
            title="КЛЮЧЕВЫЕ ВЕХИ"
            eyebrow="MILESTONES / VERIFIED"
            className="overview-milestones"
          >
            <div className="milestone-list">
              {events.slice(0, listLength[presentation]).map((event, index) => (
                <TerminalButton key={event.id} onClick={() => openDrawer('event', event.id)}>
                  <time>{new Date(event.timestamp).toLocaleTimeString('ru-RU')}</time>
                  <i>{String(5 - index).padStart(2, '0')}</i>
                  <span>
                    <strong>{event.title}</strong>
                    <small>
                      {event.linkedObjectIds.join(', ')} / {event.source}
                    </small>
                  </span>
                  <SeverityBadge severity={event.severity} />
                </TerminalButton>
              ))}
            </div>
          </Panel>
        ),
      },
      {
        title: 'СЕКТОР ОПЕРАЦИИ',
        category: 'geo',
        descriptor: {
          id: 'sector',
          priority: 60,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          relocationRoute: '/map',
        },
        render: () => (
          <Panel
            title="СЕКТОР ОПЕРАЦИИ"
            eyebrow="GEO / S-03"
            className="overview-sector"
            actions={
              <TerminalButton className="ops-link-button" onClick={() => router.push('/map')}>
                [04] ОТКРЫТЬ КАРТУ
              </TerminalButton>
            }
          >
            <TerminalButton className="sector-mini-map" onClick={() => router.push('/map')}>
              <span className="sector-zone sector-zone--a">S-01</span>
              <span className="sector-zone sector-zone--b">S-03</span>
              <span className="sector-zone sector-zone--c">S-05</span>
              <i className="sector-target">K-17</i>
            </TerminalButton>
            <div className="sector-readout">
              <span>55.755812 N</span>
              <span>37.617298 E</span>
              <strong>ПРОМЫШЛЕННАЯ ЗОНА / КОНТУР 3</strong>
            </div>
          </Panel>
        ),
      },
      {
        title: 'ПРОГРЕСС ПО НАПРАВЛЕНИЯМ',
        category: 'telemetry',
        descriptor: {
          id: 'directions',
          priority: 55,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          relocationRoute: '/analytics',
        },
        render: (presentation) => (
          <Panel
            title="ПРОГРЕСС ПО НАПРАВЛЕНИЯМ"
            eyebrow="DIRECTIONS / ANALYTICS"
            className="overview-directions"
          >
            <div className="direction-list">
              {directions.slice(0, listLength[presentation]).map((direction) => {
                const subset = tasks.filter((task) => task.direction === direction);
                const progress =
                  subset.length === 0
                    ? 0
                    : subset.reduce((sum, task) => sum + task.progress, 0) / subset.length;
                return (
                  <TerminalButton
                    key={direction}
                    onClick={() => {
                      setAnalyticsFilter(direction);
                      router.push('/analytics');
                    }}
                  >
                    <span>{direction.toUpperCase()}</span>
                    <ProgressBar value={progress} />
                  </TerminalButton>
                );
              })}
            </div>
          </Panel>
        ),
      },
      {
        title: 'СОБРАННЫЕ ДОКАЗАТЕЛЬСТВА',
        category: 'records',
        descriptor: {
          id: 'evidence',
          priority: 50,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          relocationRoute: '/files',
        },
        render: () => (
          <Panel
            title="СОБРАННЫЕ ДОКАЗАТЕЛЬСТВА"
            eyebrow="EVIDENCE / LOCAL"
            className="overview-evidence"
          >
            <div className="evidence-grid">
              {evidence.map((item) => (
                <TerminalButton
                  key={item.kind}
                  onClick={() => {
                    setFileFilter(item.kind);
                    router.push('/files');
                  }}
                >
                  <i>[{item.kind.slice(0, 3).toUpperCase()}]</i>
                  <strong>{String(item.count).padStart(2, '0')}</strong>
                  <span>{item.kind.toUpperCase()}</span>
                </TerminalButton>
              ))}
            </div>
          </Panel>
        ),
      },
      {
        title: 'ЦЕЛИ',
        category: 'records',
        descriptor: {
          id: 'targets',
          priority: 90,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          relocationRoute: '/objects',
        },
        render: () => (
          <Panel title="ЦЕЛИ" eyebrow="TARGETS / LINKED" className="overview-targets">
            <div className="metric-grid metric-grid--four">
              <Metric
                label="ВСЕГО"
                value={objects.length}
                onClick={() => router.push('/objects')}
              />
              <Metric
                label="НЕЙТРАЛИЗОВАНО"
                value={objects.filter((object) => object.status === 'NEUTRALIZED').length}
                tone="ok"
                onClick={() => router.push('/objects')}
              />
              <Metric
                label="В РАБОТЕ"
                value={
                  objects.filter(
                    (object) => object.status === 'ACTIVE' || object.status === 'WATCHED',
                  ).length
                }
                tone="warning"
                onClick={() => router.push('/objects')}
              />
              <Metric
                label="ПОТЕРЯ СИГНАЛА"
                value={objects.filter((object) => object.status === 'SIGNAL_LOST').length}
                tone="critical"
                onClick={() => {
                  selectObject('K-17');
                  router.push('/objects/K-17');
                }}
              />
            </div>
          </Panel>
        ),
      },
      {
        title: 'АКТИВНЫЕ ЗАДАЧИ',
        category: 'records',
        descriptor: {
          id: 'tasks',
          priority: 45,
          variants: [{ presentation: 'full', columns: 1, rows: 1 }],
          canStretchHorizontally: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel title="АКТИВНЫЕ ЗАДАЧИ" eyebrow="TASKS / LIVE" className="overview-tasks">
            <div className="metric-grid metric-grid--four">
              <Metric label="ВСЕГО" value={tasks.length} />
              <Metric label="ВЫПОЛНЕНО" value={completedTasks} tone="ok" />
              <Metric label="В ПРОЦЕССЕ" value={activeTasks} tone="warning" />
              <Metric label="ОЖИДАЕТ" value={tasks.length - completedTasks - activeTasks} />
            </div>
          </Panel>
        ),
      },
    ],
    [
      activeTasks,
      alerts,
      completedTasks,
      evidence,
      events,
      metrics.readiness,
      objects,
      openDrawer,
      operation.currentPhase,
      operation.id,
      operation.summary,
      router,
      sectors,
      selectObject,
      setAnalyticsFilter,
      setFileFilter,
      tasks,
    ],
  );

  return (
    <div className="ops-screen overview-screen">
      <header className="ops-screen__title operation-titlebar">
        <div>
          <span>OPERATION / {operation.code}</span>
          <h1>
            СВОДКА ОПЕРАЦИИ «
            <EditableContent field="operation.title" entityId={operation.id}>
              {operation.title}
            </EditableContent>
            »
          </h1>
        </div>
        <div className="operation-titlebar__metrics">
          <StatusBadge status={operation.status} />
          <span>
            <small>ПРИОРИТЕТ</small>
            <strong>{operation.priority}</strong>
          </span>
          <span>
            <small>УГРОЗА</small>
            <strong className="is-critical">{operation.threatLevel}</strong>
          </span>
          <span>
            <small>ПЕРИОД</small>
            <strong>09–19.09.2026</strong>
          </span>
        </div>
        <div className="operation-progress">
          <ProgressBar value={operation.progress} label="ОБЩИЙ ПРОГРЕСС" tone="warning" />
        </div>
      </header>

      <TileGrid tiles={tiles} columns={4} className="overview-layout" screen="overview" />
    </div>
  );
}
