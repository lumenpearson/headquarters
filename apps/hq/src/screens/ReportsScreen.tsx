'use client';

import { useMemo, useState } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { EmptyState, Panel, StatusBadge } from '@/components/operations/OpsUi';
import { useOperationsStore } from '@/state/operationsStore';

export function ReportsScreen() {
  const state = useOperationsStore((value) => value);
  const [kind, setKind] = useState('all');
  const [selectedId, setSelectedId] = useState('REP-01');
  const reports = useMemo(
    () => Object.values(state.reports).filter((report) => kind === 'all' || report.kind === kind),
    [kind, state.reports],
  );
  const selected = state.reports[selectedId] ?? reports[0];

  return (
    <div className="ops-screen reports-screen">
      <header className="ops-screen__title">
        <div>
          <span>REPORTING / LOCAL GENERATOR</span>
          <h1>ОТЧЁТЫ И СВОДКИ</h1>
        </div>
        <TerminalButton
          tone="primary"
          className="ops-action ops-action--primary"
          onClick={() => setSelectedId('REP-01')}
        >
          [N] СФОРМИРОВАТЬ СВОДКУ
        </TerminalButton>
      </header>
      <div className="reports-layout">
        <Panel title="ТИПЫ ОТЧЁТОВ" eyebrow="INDEX / TEMPLATES" className="reports-kinds">
          {[
            'all',
            'operation',
            'object',
            'sector',
            'incident',
            'communications',
            'video',
            'system',
            'analytics',
          ].map((item) => (
            <TerminalButton
              key={item}
              className={kind === item ? 'is-active' : ''}
              onClick={() => setKind(item)}
            >
              <i>[{item === 'all' ? '*' : item.slice(0, 3).toUpperCase()}]</i>
              <span>{item.toUpperCase()}</span>
              <b>
                {item === 'all'
                  ? Object.keys(state.reports).length
                  : Object.values(state.reports).filter((report) => report.kind === item).length}
              </b>
            </TerminalButton>
          ))}
        </Panel>
        <Panel
          title="РЕЕСТР ОТЧЁТОВ"
          eyebrow={`${reports.length} RECORDS / VERIFIED`}
          className="reports-registry"
        >
          {reports.length === 0 ? (
            <EmptyState>ОТЧЁТЫ ЭТОГО ТИПА ОТСУТСТВУЮТ</EmptyState>
          ) : (
            <table className="ops-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>NAME</th>
                  <th>TYPE</th>
                  <th>CREATED</th>
                  <th>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr
                    key={report.id}
                    className={selected?.id === report.id ? 'is-selected' : ''}
                    onClick={() => setSelectedId(report.id)}
                  >
                    <td>{report.id}</td>
                    <td>
                      <strong>{report.title}</strong>
                    </td>
                    <td>{report.kind.toUpperCase()}</td>
                    <td>{new Date(report.createdAt).toLocaleString('ru-RU')}</td>
                    <td>
                      <StatusBadge status={report.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel
          title="ПРЕДПРОСМОТР ДОКУМЕНТА"
          eyebrow={selected?.id ?? 'NO SELECTION'}
          className="report-preview"
        >
          {selected === undefined ? (
            <EmptyState>ОТЧЁТ НЕ ВЫБРАН</EmptyState>
          ) : (
            <article className="report-document">
              <header>
                <i>[ГС / HQ]</i>
                <div>
                  <strong>{selected.title}</strong>
                  <span>
                    {selected.id} / {selected.kind.toUpperCase()}
                  </span>
                </div>
                <StatusBadge status={selected.status} />
              </header>
              <section>
                <h3>1. ОПЕРАТИВНАЯ ОБСТАНОВКА</h3>
                <p>
                  Контур операции «Гремучая смесь» функционирует штатно. Объект K-17 остаётся
                  приоритетной точкой наблюдения. Данные локального event bus согласованы.
                </p>
                <h3>2. ЗАРЕГИСТРИРОВАННЫЕ ИЗМЕНЕНИЯ</h3>
                <ul>
                  <li>Сигнал камеры K-17 требует подтверждения оператора.</li>
                  <li>Сектор S-03 переведён в усиленный режим наблюдения.</li>
                  <li>Защищённые каналы связи доступны и синхронизированы.</li>
                </ul>
                <h3>3. РЕКОМЕНДАЦИИ</h3>
                <p>
                  Продолжить наблюдение, сохранить активные маршруты и выполнить контрольную сверку
                  доказательств CASE-01.
                </p>
              </section>
              <footer>
                <span>CLASSIFICATION: АЛЬФА / А1</span>
                <span>CHECKSUM: 7E4C-A913-LOCAL</span>
              </footer>
            </article>
          )}
          <div className="report-actions">
            <TerminalButton>[P] PRINT SIM</TerminalButton>
            <TerminalButton>[D] EXPORT PDF SIM</TerminalButton>
            <TerminalButton>[A] ARCHIVE</TerminalButton>
            <TerminalButton>[S] SIGN LOCAL</TerminalButton>
          </div>
        </Panel>
      </div>
    </div>
  );
}
