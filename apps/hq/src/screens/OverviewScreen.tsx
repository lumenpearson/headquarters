'use client';

import { useRouter } from 'next/navigation';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import {
  Gauge,
  Metric,
  Panel,
  ProgressBar,
  SeverityBadge,
  StatusBadge,
} from '@/components/operations/OpsUi';
import { useOperationsStore } from '@/state/operationsStore';

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
  const evidence = ['video', 'audio', 'document', 'report', 'map', 'image'].map((kind) => ({
    kind,
    count: attachments.filter((file) => file.kind === kind).length,
  }));
  const directions = ['intelligence', 'collection', 'analysis', 'operations', 'support'] as const;

  return (
    <div className="ops-screen overview-screen">
      <header className="ops-screen__title operation-titlebar">
        <div>
          <span>OPERATION / {operation.code}</span>
          <h1>СВОДКА ОПЕРАЦИИ «{operation.title}»</h1>
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

      <div className="overview-layout">
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
          <p>{operation.summary}</p>
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
        </Panel>

        <Panel
          title="ГОТОВНОСТЬ К МИССИИ"
          eyebrow="MISSION / READINESS"
          className="overview-readiness"
        >
          <Gauge value={metrics.readiness} label="ОБЩАЯ ГОТОВНОСТЬ" detail="ПОРOГ ДОПУСКА 80%" />
          <div className="readiness-list">
            {[
              ['ЛИЧНЫЙ СОСТАВ', 94, '/objects'],
              ['РАЗВЕДДАННЫЕ', 87, '/analytics'],
              ['ТЕХНИЧЕСКИЕ СРЕДСТВА', 82, '/system'],
              ['ПОДДЕРЖКА', 76, '/communications'],
              ['ЛОГИСТИКА', 91, '/map'],
            ].map(([label, value, href]) => (
              <TerminalButton key={String(label)} onClick={() => router.push(String(href))}>
                <span>{label}</span>
                <ProgressBar value={Number(value)} />
              </TerminalButton>
            ))}
          </div>
        </Panel>

        <Panel
          title="ХРОНОЛОГИЯ ОПЕРАЦИИ"
          eyebrow="TIMELINE / 09–19 SEP"
          className="overview-timeline"
        >
          <div className="operation-timeline">
            {[...events.slice(0, 7)].reverse().map((event, index) => (
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

        <Panel
          title="ЦЕЛИ ОПЕРАЦИИ"
          eyebrow="OBJECTIVES / CHECKLIST"
          className="overview-objectives"
        >
          <ol className="objective-list">
            {tasks.slice(0, 6).map((task) => (
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

        <Panel
          title="КЛЮЧЕВЫЕ ВЕХИ"
          eyebrow="MILESTONES / VERIFIED"
          className="overview-milestones"
        >
          <div className="milestone-list">
            {events.slice(0, 5).map((event, index) => (
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

        <Panel title="ЦЕЛИ" eyebrow="TARGETS / LINKED" className="overview-targets">
          <div className="metric-grid metric-grid--four">
            <Metric label="ВСЕГО" value={objects.length} onClick={() => router.push('/objects')} />
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

        <Panel title="АКТИВНЫЕ ЗАДАЧИ" eyebrow="TASKS / LIVE" className="overview-tasks">
          <div className="metric-grid metric-grid--four">
            <Metric label="ВСЕГО" value={tasks.length} />
            <Metric label="ВЫПОЛНЕНО" value={completedTasks} tone="ok" />
            <Metric label="В ПРОЦЕССЕ" value={activeTasks} tone="warning" />
            <Metric label="ОЖИДАЕТ" value={tasks.length - completedTasks - activeTasks} />
          </div>
        </Panel>

        <Panel
          title="ПРОГРЕСС ПО НАПРАВЛЕНИЯМ"
          eyebrow="DIRECTIONS / ANALYTICS"
          className="overview-directions"
        >
          <div className="direction-list">
            {directions.map((direction) => {
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

        <Panel title="ПОСЛЕДНИЕ ОБНОВЛЕНИЯ" eyebrow="EVENT BUS / LIVE" className="overview-events">
          <div className="event-feed">
            {events.map((event) => (
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

        <Panel
          title="УРОВЕНЬ УГРОЗЫ ПО СЕКТОРАМ"
          eyebrow="THREAT / SECTORS"
          className="overview-threats"
        >
          <div className="threat-list">
            {sectors.map((sector) => (
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
      </div>
    </div>
  );
}
