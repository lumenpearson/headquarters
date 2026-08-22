'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TerminalButton, TerminalInput, TerminalSelect } from '@gremuchaya/ui/primitives';

import { useRecordPage } from '@/application/records/useRecordPage';
import { useTablePageSize } from '@/application/records/useTablePageSize';
import { EmptyState, Panel, StatusBadge } from '@/components/operations/OpsUi';
import { RecordPagination } from '@/components/operations/RecordPagination';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { useContextMenuAction } from '@/components/contextMenus/ContextMenuRuntime';
import { useOperationsStore } from '@/state/operationsStore';

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

const caseStatusOptions = [
  { value: 'all', label: 'ВСЕ СТАТУСЫ' },
  { value: 'ACTIVE', label: 'АКТИВЕН' },
  { value: 'IN_PROGRESS', label: 'В РАБОТЕ' },
  { value: 'RESTRICTED', label: 'ОГРАНИЧЕН' },
  { value: 'ARCHIVED', label: 'АРХИВ' },
] as const satisfies ReadonlyArray<{
  readonly value: CaseStatusFilter;
  readonly label: string;
}>;

export function CasesScreen({ detailId }: { readonly detailId?: string }) {
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
  const [sortKey, setSortKey] = useState<'code' | 'title' | 'createdAt' | 'priority'>('priority');
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
  const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU');
  const { page: casePage, goToPage } = useRecordPage(allCases, {
    pageSize,
    filters: [
      (caseFile) => statusFilter === 'all' || caseFile.status === statusFilter,
      (caseFile) =>
        normalizedQuery === '' ||
        `${caseFile.code} ${caseFile.title} ${caseFile.tags.join(' ')}`
          .toLocaleLowerCase('ru-RU')
          .includes(normalizedQuery),
    ],
    comparator: (left, right) => {
      const a = left[sortKey];
      const b = right[sortKey];
      const result =
        typeof a === 'number' && typeof b === 'number'
          ? a - b
          : String(a).localeCompare(String(b), 'ru-RU');
      return descending ? -result : result;
    },
  });
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
        title: 'СТРУКТУРА ХРАНИЛИЩА',
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
            title="СТРУКТУРА ХРАНИЛИЩА"
            eyebrow="CASE TREE / LOCAL"
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
        title: 'РЕЕСТР ДЕЛ',
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
            title="РЕЕСТР ДЕЛ"
            eyebrow={`${selectedFolder} / ${casePage.total} RECORDS`}
            className="case-registry"
          >
            <div className="ops-filterbar">
              <label>
                <span>/</span>
                <TerminalInput
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label="Поиск по реестру дел"
                  placeholder="ПОИСК ПО РЕЕСТРУ"
                />
              </label>
              <TerminalSelect
                value={statusFilter}
                options={caseStatusOptions}
                onValueChange={setStatusFilter}
                label="Статус дела"
              />
              <TerminalButton onClick={() => setDescending((value) => !value)}>
                [{descending ? '↓' : '↑'}] SORT
              </TerminalButton>
            </div>
            {cases.length === 0 ? (
              <EmptyState>ДЕЛА НЕ ОБНАРУЖЕНЫ</EmptyState>
            ) : (
              <div className="ops-table-wrap">
                <table className="ops-table cases-table">
                  <thead>
                    <tr>
                      <th>ТИП</th>
                      {(['code', 'title', 'createdAt', 'priority'] as const).map((column) => (
                        <th key={column}>
                          <TerminalButton onClick={() => setSortKey(column)}>
                            {column.toUpperCase()}{' '}
                            {sortKey === column ? (descending ? '▼' : '▲') : ''}
                          </TerminalButton>
                        </th>
                      ))}
                      <th>СТАТУС</th>
                      <th>ИСТОЧНИК</th>
                      <th>ДОСЬЕ</th>
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
                        <td>{caseFile.title}</td>
                        <td>{new Date(caseFile.createdAt).toLocaleDateString('ru-RU')}</td>
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
            <RecordPagination page={casePage} onPage={goToPage} label="Страницы реестра дел">
              <span>SELECTED: {selectedCase?.id ?? '—'}</span>
            </RecordPagination>
          </Panel>
        ),
      },
      {
        title: 'КАРТОЧКА ДОСЬЕ',
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
            title="КАРТОЧКА ДОСЬЕ"
            eyebrow={selectedCase?.dossierCode ?? 'NO SELECTION'}
            className="dossier-panel"
          >
            {selectedCase === undefined || selectedPerson === undefined ? (
              <EmptyState>ДОСЬЕ НЕ ВЫБРАНО</EmptyState>
            ) : (
              <>
                <header className="dossier-header">
                  <div className="dossier-photo">
                    <span>[ PERSON / {selectedPerson.id} ]</span>
                    <i />
                  </div>
                  <div>
                    <strong>{selectedPerson.fullName}</strong>
                    <span>{selectedPerson.aliases.join(', ')}</span>
                    <StatusBadge status={selectedPerson.status} />
                  </div>
                  <b>
                    RISK
                    <br />
                    <strong>{selectedPerson.riskScore}</strong>
                  </b>
                </header>
                <dl className="ops-definition-list">
                  <div>
                    <dt>ДАТА РОЖДЕНИЯ</dt>
                    <dd>{selectedPerson.birthDate}</dd>
                  </div>
                  <div>
                    <dt>ГРАЖДАНСТВО</dt>
                    <dd>{selectedPerson.citizenship}</dd>
                  </div>
                  <div>
                    <dt>РОЛЬ</dt>
                    <dd>{selectedPerson.role}</dd>
                  </div>
                  <div>
                    <dt>ДОКУМЕНТ</dt>
                    <dd>{selectedPerson.documentCode}</dd>
                  </div>
                  <div>
                    <dt>ДЕЛО</dt>
                    <dd>{selectedCase.code}</dd>
                  </div>
                  <div>
                    <dt>ПРИОРИТЕТ</dt>
                    <dd>P{selectedCase.priority}</dd>
                  </div>
                </dl>
                <section className="dossier-addresses">
                  <h3>АДРЕСА</h3>
                  {selectedPerson.addresses.map((address) => (
                    <TerminalButton key={address} onClick={() => router.push('/map')}>
                      <span>{address}</span>
                      <b>[MAP]</b>
                    </TerminalButton>
                  ))}
                </section>
                <section className="dossier-tags">
                  <h3>ТЕГИ</h3>
                  {selectedPerson.tags.map((tag) => (
                    <TerminalButton key={tag} onClick={() => setQuery(tag)}>
                      [{tag}]
                    </TerminalButton>
                  ))}
                </section>
                <section className="dossier-files">
                  <h3>ПРИКРЕПЛЁННЫЕ МАТЕРИАЛЫ</h3>
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
                    [ENTER] ОТКРЫТЬ ПОЛНУЮ КАРТОЧКУ
                  </TerminalButton>
                  <TerminalButton
                    onClick={() => state.openDrawer('file', selectedFiles[0]?.id ?? 'FILE-01')}
                  >
                    [V] FILE VIEWER
                  </TerminalButton>
                </footer>
              </>
            )}
          </Panel>
        ),
      },
    ],
    [
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
    ],
  );

  return (
    <div className="ops-screen cases-screen">
      <header className="ops-screen__title">
        <div>
          <span>REGISTRY / DOSSIER / LOCAL</span>
          <h1>ДЕЛА И ДОСЬЕ</h1>
        </div>
        <div className="case-summary">
          <span>
            <small>РЕЕСТР</small>
            <strong>{Object.keys(state.cases).length}</strong>
          </span>
          <span>
            <small>ОГРАНИЧЕНО</small>
            <strong>
              {Object.values(state.cases).filter((item) => item.status === 'RESTRICTED').length}
            </strong>
          </span>
          <span>
            <small>МАТЕРИАЛЫ</small>
            <strong>{Object.keys(state.attachments).length}</strong>
          </span>
        </div>
      </header>
      <TileGrid tiles={tiles} columns={12} className="cases-layout" screen="cases" />
    </div>
  );
}
