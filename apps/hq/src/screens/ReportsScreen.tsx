'use client';

import { useMemo, useState } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { compareText, dateTimeFormat } from '@/application/localization/intl';
import { useTranslate } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import { useRecordPage } from '@/application/records/useRecordPage';
import { useTablePageSize } from '@/application/records/useTablePageSize';
import { EditableContent } from '@/components/edit/EditableContent';
import { EmptyState, Panel, StatusBadge } from '@/components/operations/OpsUi';
import { RecordPagination } from '@/components/operations/RecordPagination';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { useContextMenuAction } from '@/components/contextMenus/ContextMenuRuntime';
import { useOperationsStore } from '@/state/operationsStore';

/** What `toLocaleString()` printed, named rather than left implicit. */
const stampParts = { dateStyle: 'short', timeStyle: 'medium' } as const;

type ReportKindFilter =
  | 'all'
  | 'operation'
  | 'object'
  | 'sector'
  | 'incident'
  | 'communications'
  | 'video'
  | 'system'
  | 'analytics';

/** Keyed by the union rather than built with a template string, so a kind with no message is a compile error. */
const reportKindLabelIds: Readonly<Record<ReportKindFilter, MessageId>> = {
  all: 'reports.kindAll',
  operation: 'reports.kindOperation',
  object: 'reports.kindObject',
  sector: 'reports.kindSector',
  incident: 'reports.kindIncident',
  communications: 'reports.kindCommunications',
  video: 'reports.kindVideo',
  system: 'reports.kindSystem',
  analytics: 'reports.kindAnalytics',
};

const reportKindFilters = [
  'all',
  'operation',
  'object',
  'sector',
  'incident',
  'communications',
  'video',
  'system',
  'analytics',
] as const satisfies readonly ReportKindFilter[];

type ReportSortKey = 'id' | 'title' | 'kind' | 'createdAt';

/** Keyed by the union rather than built with a template string, so a column with no message is a compile error. */
const reportSortColumnLabelIds: Readonly<Record<Exclude<ReportSortKey, 'id'>, MessageId>> = {
  title: 'field.name',
  kind: 'field.type',
  createdAt: 'field.created',
};

const reportSortColumns = [
  'id',
  'title',
  'kind',
  'createdAt',
] as const satisfies readonly ReportSortKey[];

export function ReportsScreen() {
  const translate = useTranslate();
  const state = useOperationsStore((value) => value);
  const [kind, setKind] = useState<ReportKindFilter>('all');
  const [selectedId, setSelectedId] = useState('REP-01');
  // Only selection: this screen has no report card to open, so `record.open`
  // stays unclaimed and the menu draws it disabled rather than pretending.
  useContextMenuAction('record.select', (subject) => {
    if (subject !== undefined) setSelectedId(subject);
  });
  const pageSize = useTablePageSize();
  const [sortKey, setSortKey] = useState<ReportSortKey>('createdAt');
  const [descending, setDescending] = useState(true);
  const allReports = useMemo(() => Object.values(state.reports), [state.reports]);
  // The question is the report type: it is the only thing that narrows this
  // registry, and without this the operator kept whatever page the previous
  // type had left them on.
  const { page: reportPage, goToPage } = useRecordPage(
    allReports,
    {
      pageSize,
      filters: [(report) => kind === 'all' || report.kind === kind],
      comparator: (left, right) => {
        const result = compareText(String(left[sortKey]), String(right[sortKey]));
        return descending ? -result : result;
      },
    },
    kind,
  );
  const reports = reportPage.items;
  const selected = state.reports[selectedId] ?? reports[0];

  /*
   * Priority here expresses the arrangement, not the order tiles would be
   * given up in. On a master-detail screen the tiles total exactly twelve
   * columns, so every one of them is placed even in a single-row grid --
   * measured at 1024x768 through 2560x1440, nothing is ever displaced -- and
   * the drop order priority also encodes is unreachable. What the operator
   * does notice is the reading order, and the resolver places the highest
   * priority leftmost.
   */
  const tiles: readonly ScreenTile[] = useMemo(
    () => [
      {
        title: translate('reports.kindsTitle'),
        category: 'navigation',
        descriptor: {
          id: 'kinds',
          priority: 80,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel
            title={translate('reports.kindsTitle')}
            eyebrow={translate('reports.kindsEyebrow')}
            className="reports-kinds"
          >
            {reportKindFilters.map((item) => (
              <TerminalButton
                key={item}
                className={kind === item ? 'is-active' : ''}
                onClick={() => setKind(item)}
              >
                <i>[{item === 'all' ? '*' : item.slice(0, 3).toUpperCase()}]</i>
                <span>{translate(reportKindLabelIds[item])}</span>
                <b>
                  {item === 'all'
                    ? Object.keys(state.reports).length
                    : Object.values(state.reports).filter((report) => report.kind === item).length}
                </b>
              </TerminalButton>
            ))}
          </Panel>
        ),
      },
      {
        title: translate('reports.registryTitle'),
        category: 'records',
        descriptor: {
          id: 'registry',
          priority: 100,
          variants: [
            { presentation: 'full', columns: 6, rows: 1 },
            { presentation: 'compact', columns: 4, rows: 1 },
          ],
          canStretchHorizontally: true,
          canStretchVertically: true,
        },
        render: () => (
          <Panel
            title={translate('reports.registryTitle')}
            eyebrow={translate('reports.registryEyebrow', { count: reportPage.total })}
            className="reports-registry"
          >
            {reports.length === 0 ? (
              <EmptyState>{translate('reports.noReportsOfKind')}</EmptyState>
            ) : (
              <table className="ops-table">
                <thead>
                  <tr>
                    {reportSortColumns.map((column) => (
                      <th key={column}>
                        <TerminalButton
                          onClick={() => {
                            setDescending(
                              sortKey === column ? !descending : column === 'createdAt',
                            );
                            setSortKey(column);
                          }}
                        >
                          {column === 'id' ? 'ID' : translate(reportSortColumnLabelIds[column])}{' '}
                          {sortKey === column ? (descending ? '▼' : '▲') : ''}
                        </TerminalButton>
                      </th>
                    ))}
                    <th>{translate('field.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((report) => (
                    <tr
                      key={report.id}
                      className={selected?.id === report.id ? 'is-selected' : ''}
                      data-interactive="true"
                      data-context-menu="record"
                      data-context-subject={report.id}
                      onClick={() => setSelectedId(report.id)}
                    >
                      <td>{report.id}</td>
                      <td>
                        <strong>
                          <EditableContent field="report.title" entityId={report.id}>
                            {report.title}
                          </EditableContent>
                        </strong>
                      </td>
                      <td>{report.kind.toUpperCase()}</td>
                      <td>
                        <EditableContent field="report.createdAt" entityId={report.id}>
                          {dateTimeFormat(stampParts).format(new Date(report.createdAt))}
                        </EditableContent>
                      </td>
                      <td>
                        <StatusBadge status={report.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <RecordPagination
              page={reportPage}
              onPage={goToPage}
              label={translate('reports.paginationLabel')}
            >
              <span>{translate('registry.selectedFooter', { id: selected?.id ?? '—' })}</span>
            </RecordPagination>
          </Panel>
        ),
      },
      {
        title: translate('reports.previewTitle'),
        category: 'detail',
        descriptor: {
          id: 'preview',
          priority: 90,
          variants: [
            { presentation: 'full', columns: 4, rows: 1 },
            { presentation: 'compact', columns: 3, rows: 1 },
          ],
          canStretchHorizontally: true,
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel
            title={translate('reports.previewTitle')}
            eyebrow={selected?.id ?? translate('registry.noSelection')}
            className="report-preview"
          >
            {selected === undefined ? (
              <EmptyState>{translate('reports.noReportSelected')}</EmptyState>
            ) : (
              // The generated document below (letterhead, section headings, the
              // three paragraphs, the classification and checksum footer) is
              // the film's own report fiction, not chrome, and is left out of
              // the catalogue -- see the wave's report for the file:line list.
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
                    Продолжить наблюдение, сохранить активные маршруты и выполнить контрольную
                    сверку доказательств CASE-01.
                  </p>
                </section>
                <footer>
                  <span>CLASSIFICATION: АЛЬФА / А1</span>
                  <span>CHECKSUM: 7E4C-A913-LOCAL</span>
                </footer>
              </article>
            )}
            <div className="report-actions">
              <TerminalButton>{translate('reports.printSimButton')}</TerminalButton>
              <TerminalButton>{translate('reports.exportPdfButton')}</TerminalButton>
              <TerminalButton>{translate('reports.archiveButton')}</TerminalButton>
              <TerminalButton>{translate('reports.signLocalButton')}</TerminalButton>
            </div>
          </Panel>
        ),
      },
    ],
    [descending, goToPage, kind, reportPage, reports, selected, sortKey, state.reports, translate],
  );

  return (
    <div className="ops-screen reports-screen">
      <header className="ops-screen__title">
        <div>
          <span>{translate('reports.headerEyebrow')}</span>
          <h1>{translate('reports.headerTitle')}</h1>
        </div>
        <TerminalButton
          tone="primary"
          className="ops-action ops-action--primary"
          onClick={() => setSelectedId('REP-01')}
        >
          {translate('reports.generateSummaryButton')}
        </TerminalButton>
      </header>
      <TileGrid tiles={tiles} columns={12} className="reports-layout" screen="reports" />
    </div>
  );
}
