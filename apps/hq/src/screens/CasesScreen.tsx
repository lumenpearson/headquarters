'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TerminalButton, TerminalInput, TerminalSelect } from '@gremuchaya/ui/primitives';

import { compareText, dateTimeFormat, foldCase } from '@/application/localization/intl';
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

/**
 * The storage tree's folder names, and the project path they hang under, are
 * the film's own fiction -- the production's in-universe archive, not chrome
 * this catalogue is the source of. They stay written in Russian exactly as
 * the fiction has them, in both locales; see `LocalizedText` in
 * `@gremuchaya/domain` for where that population is meant to be translated.
 */
const folders = [
  ['01_Досье', 20],
  ['02_Операции', 12],
  ['03_Перехваты', 38],
  ['04_Финансы', 16],
  ['05_Техника', 24],
  ['06_Логистика', 18],
  ['07_Кадры', 20],
  ['08_Аналитика', 31],
] as const;

type CaseStatusFilter = 'all' | 'ACTIVE' | 'IN_PROGRESS' | 'RESTRICTED' | 'ARCHIVED';

type CaseSortKey = 'code' | 'title' | 'createdAt' | 'priority';

/** `field.name` already carries the case title's column, `field.created` and `field.priority` the other two. */
const caseSortColumnLabelIds: Readonly<Record<CaseSortKey, MessageId>> = {
  code: 'cases.columnCode',
  title: 'field.name',
  createdAt: 'field.created',
  priority: 'field.priority',
};

const caseSortColumns = [
  'code',
  'title',
  'createdAt',
  'priority',
] as const satisfies readonly CaseSortKey[];

/** `nav.archive` already carries "АРХИВ" / "ARCHIVE" for the archived status option. */
const caseStatusLabelIds: Readonly<Record<CaseStatusFilter, MessageId>> = {
  all: 'cases.statusAll',
  ACTIVE: 'cases.statusActive',
  IN_PROGRESS: 'cases.statusInProgress',
  RESTRICTED: 'cases.statusRestricted',
  ARCHIVED: 'nav.archive',
};

const caseStatusFilters = [
  'all',
  'ACTIVE',
  'IN_PROGRESS',
  'RESTRICTED',
  'ARCHIVED',
] as const satisfies readonly CaseStatusFilter[];

export function CasesScreen({ detailId }: { readonly detailId?: string }) {
  const translate = useTranslate();
  const router = useRouter();
  const state = useOperationsStore((value) => value);
  useContextMenuAction('record.open', (subject) => {
    if (subject !== undefined) router.push(`/cases/${subject}`);
  });
  useContextMenuAction('record.select', (subject) => {
    if (subject !== undefined) state.selectCase(subject);
  });
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CaseStatusFilter>('all');
  const [sortKey, setSortKey] = useState<CaseSortKey>('priority');
  const [descending, setDescending] = useState(true);
  const [selectedFolder, setSelectedFolder] = useState('01_Досье');
  const activeId = detailId ?? state.ui.selectedCaseId;
  const selectedCase = state.cases[activeId] ?? Object.values(state.cases)[0];
  const selectedPerson =
    selectedCase === undefined ? undefined : state.people[selectedCase.subjectPersonId];
  // Memoised because the tiles depend on it: a fresh array on every render
  // would rebuild every panel on every keystroke in the registry filter.
  const selectedFiles = useMemo(
    () =>
      selectedCase === undefined
        ? []
        : selectedCase.attachmentIds.flatMap((id) =>
            state.attachments[id] === undefined ? [] : [state.attachments[id]],
          ),
    [selectedCase, state.attachments],
  );
  const pageSize = useTablePageSize();
  const allCases = useMemo(() => Object.values(state.cases), [state.cases]);
  const normalizedQuery = foldCase(query.trim());
  const caseStatusOptions = useMemo(
    () =>
      caseStatusFilters.map((value) => ({ value, label: translate(caseStatusLabelIds[value]) })),
    [translate],
  );
  // The question is the status filter plus the search text: either one
  // narrows the registry, and without this the operator kept whatever page
  // the previous filter had left them on.
  const { page: casePage, goToPage } = useRecordPage(
    allCases,
    {
      pageSize,
      filters: [
        (caseFile) => statusFilter === 'all' || caseFile.status === statusFilter,
        (caseFile) =>
          normalizedQuery === '' ||
          foldCase(`${caseFile.code} ${caseFile.title} ${caseFile.tags.join(' ')}`).includes(
            normalizedQuery,
          ),
      ],
      comparator: (left, right) => {
        const a = left[sortKey];
        const b = right[sortKey];
        const result =
          typeof a === 'number' && typeof b === 'number'
            ? a - b
            : compareText(String(a), String(b));
        return descending ? -result : result;
      },
    },
    `${statusFilter}:${normalizedQuery}`,
  );
  const cases = casePage.items;

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
        title: translate('cases.treeTitle'),
        category: 'navigation',
        descriptor: {
          id: 'tree',
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
            title={translate('cases.treeTitle')}
            eyebrow={translate('cases.treeEyebrow')}
            className="case-tree-panel"
          >
            <div className="case-tree">
              <TerminalButton className="is-root">[-] КОРНЕВОЙ КАТАЛОГ</TerminalButton>
              <TerminalButton className="is-branch">└─ [-] 01_ПРОЕКТЫ</TerminalButton>
              <TerminalButton className="is-branch level-2">└─ [-] П_ГРЕМУЧАЯ_СМЕСЬ</TerminalButton>
              {folders.map(([folder, count]) => (
                <TerminalButton
                  key={folder}
                  className={`level-3 ${selectedFolder === folder ? 'is-selected' : ''}`}
                  onClick={() => setSelectedFolder(folder)}
                >
                  ├─ [{selectedFolder === folder ? '■' : ' '}] <span>{folder}</span>
                  <b>{count}</b>
                </TerminalButton>
              ))}
              {['02_АКТИВЫ', '03_РЕГИОНЫ', '04_АРХИВ_УДАЛЕННЫЙ', '05_РЕЗЕРВ'].map((folder) => (
                <TerminalButton key={folder} className="is-branch">
                  ├─ [+] {folder}
                </TerminalButton>
              ))}
            </div>
            <footer>PATH: /01_ПРОЕКТЫ/П_ГРЕМУЧАЯ_СМЕСЬ/{selectedFolder}</footer>
          </Panel>
        ),
      },
      {
        title: translate('cases.registryTitle'),
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
            title={translate('cases.registryTitle')}
            eyebrow={translate('cases.registryEyebrow', {
              folder: selectedFolder,
              count: casePage.total,
            })}
            className="case-registry"
          >
            <div className="ops-filterbar">
              <label>
                <span>/</span>
                <TerminalInput
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label={translate('cases.searchAriaLabel')}
                  placeholder={translate('cases.searchPlaceholder')}
                />
              </label>
              <TerminalSelect
                value={statusFilter}
                options={caseStatusOptions}
                onValueChange={setStatusFilter}
                label={translate('cases.statusSelectLabel')}
              />
              <TerminalButton onClick={() => setDescending((value) => !value)}>
                {translate('cases.sortLabel', { arrow: descending ? '↓' : '↑' })}
              </TerminalButton>
            </div>
            {cases.length === 0 ? (
              <EmptyState>{translate('cases.noCasesFound')}</EmptyState>
            ) : (
              <div className="ops-table-wrap">
                <table className="ops-table cases-table">
                  <thead>
                    <tr>
                      <th>{translate('field.type')}</th>
                      {caseSortColumns.map((column) => (
                        <th key={column}>
                          <TerminalButton onClick={() => setSortKey(column)}>
                            {translate(caseSortColumnLabelIds[column])}{' '}
                            {sortKey === column ? (descending ? '▼' : '▲') : ''}
                          </TerminalButton>
                        </th>
                      ))}
                      <th>{translate('field.status')}</th>
                      <th>{translate('field.source')}</th>
                      <th>{translate('cases.columnDossier')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cases.map((caseFile) => (
                      <tr
                        key={caseFile.id}
                        className={caseFile.id === selectedCase?.id ? 'is-selected' : ''}
                        data-interactive="true"
                        data-context-menu="record"
                        data-context-subject={caseFile.id}
                        onClick={() => state.selectCase(caseFile.id)}
                        onDoubleClick={() => router.push(`/cases/${caseFile.id}`)}
                      >
                        <td>[CASE]</td>
                        <td>{caseFile.code}</td>
                        <td>
                          <EditableContent field="case.title" entityId={caseFile.id}>
                            {caseFile.title}
                          </EditableContent>
                        </td>
                        <td>
                          <EditableContent field="case.createdAt" entityId={caseFile.id}>
                            {dateTimeFormat({ dateStyle: 'short' }).format(
                              new Date(caseFile.createdAt),
                            )}
                          </EditableContent>
                        </td>
                        <td>P{caseFile.priority}</td>
                        <td>
                          <StatusBadge status={caseFile.status} />
                        </td>
                        <td>{caseFile.source}</td>
                        <td>{caseFile.dossierCode}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <RecordPagination
              page={casePage}
              onPage={goToPage}
              label={translate('cases.paginationLabel')}
            >
              <span>{translate('registry.selectedFooter', { id: selectedCase?.id ?? '—' })}</span>
            </RecordPagination>
          </Panel>
        ),
      },
      {
        title: translate('cases.dossierTitle'),
        category: 'detail',
        descriptor: {
          id: 'dossier',
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
            title={translate('cases.dossierTitle')}
            eyebrow={selectedCase?.dossierCode ?? translate('registry.noSelection')}
            className="dossier-panel"
          >
            {selectedCase === undefined || selectedPerson === undefined ? (
              <EmptyState>{translate('cases.noDossierSelected')}</EmptyState>
            ) : (
              <>
                <header className="dossier-header">
                  <div className="dossier-photo">
                    <span>{translate('cases.personMarker', { id: selectedPerson.id })}</span>
                    <i />
                  </div>
                  <div>
                    <strong>{selectedPerson.fullName}</strong>
                    <span>{selectedPerson.aliases.join(', ')}</span>
                    <StatusBadge status={selectedPerson.status} />
                  </div>
                  <b>
                    {translate('field.risk')}
                    <br />
                    <strong>{selectedPerson.riskScore}</strong>
                  </b>
                </header>
                <dl className="ops-definition-list">
                  <div>
                    <dt>{translate('field.birthDate')}</dt>
                    <dd>
                      <EditableContent field="person.birthDate" entityId={selectedPerson.id}>
                        {selectedPerson.birthDate}
                      </EditableContent>
                    </dd>
                  </div>
                  <div>
                    <dt>{translate('field.citizenship')}</dt>
                    <dd>{selectedPerson.citizenship}</dd>
                  </div>
                  <div>
                    <dt>{translate('field.role')}</dt>
                    <dd>{selectedPerson.role}</dd>
                  </div>
                  <div>
                    <dt>{translate('field.document')}</dt>
                    <dd>{selectedPerson.documentCode}</dd>
                  </div>
                  <div>
                    <dt>{translate('field.case')}</dt>
                    <dd>{selectedCase.code}</dd>
                  </div>
                  <div>
                    <dt>{translate('field.priority')}</dt>
                    <dd>P{selectedCase.priority}</dd>
                  </div>
                </dl>
                <section className="dossier-addresses">
                  <h3>{translate('cases.addressesHeading')}</h3>
                  {selectedPerson.addresses.map((address) => (
                    <TerminalButton key={address} onClick={() => router.push('/map')}>
                      <span>{address}</span>
                      <b>{translate('cases.mapMarker')}</b>
                    </TerminalButton>
                  ))}
                </section>
                <section className="dossier-tags">
                  <h3>{translate('field.tags')}</h3>
                  {selectedPerson.tags.map((tag) => (
                    <TerminalButton key={tag} onClick={() => setQuery(tag)}>
                      [{tag}]
                    </TerminalButton>
                  ))}
                </section>
                <section className="dossier-files">
                  <h3>{translate('cases.attachedMaterialsHeading')}</h3>
                  <div>
                    {selectedFiles.map((file) => (
                      <TerminalButton
                        key={file.id}
                        onDoubleClick={() => state.openDrawer('file', file.id)}
                        onClick={() => state.selectFile(file.id)}
                      >
                        <i>[{file.kind.toUpperCase()}]</i>
                        <span>
                          <strong>{file.title}</strong>
                          <small>
                            {file.id} / {file.sizeLabel}
                          </small>
                        </span>
                      </TerminalButton>
                    ))}
                  </div>
                </section>
                <footer>
                  <TerminalButton onClick={() => router.push(`/cases/${selectedCase.id}`)}>
                    {translate('cases.openFullCardButton')}
                  </TerminalButton>
                  <TerminalButton
                    onClick={() => state.openDrawer('file', selectedFiles[0]?.id ?? 'FILE-01')}
                  >
                    {translate('cases.fileViewerButton')}
                  </TerminalButton>
                </footer>
              </>
            )}
          </Panel>
        ),
      },
    ],
    [
      caseStatusOptions,
      casePage,
      cases,
      descending,
      goToPage,
      query,
      selectedCase,
      selectedFiles,
      selectedFolder,
      selectedPerson,
      sortKey,
      state,
      statusFilter,
      router,
      translate,
    ],
  );

  return (
    <div className="ops-screen cases-screen">
      <header className="ops-screen__title">
        <div>
          <span>{translate('cases.headerEyebrow')}</span>
          <h1>{translate('cases.headerTitle')}</h1>
        </div>
        <div className="case-summary">
          <span>
            <small>{translate('cases.registryCountLabel')}</small>
            <strong>{Object.keys(state.cases).length}</strong>
          </span>
          <span>
            <small>{translate('cases.restrictedCountLabel')}</small>
            <strong>
              {Object.values(state.cases).filter((item) => item.status === 'RESTRICTED').length}
            </strong>
          </span>
          <span>
            <small>{translate('field.materials')}</small>
            <strong>{Object.keys(state.attachments).length}</strong>
          </span>
        </div>
      </header>
      <TileGrid tiles={tiles} columns={12} className="cases-layout" screen="cases" />
    </div>
  );
}
