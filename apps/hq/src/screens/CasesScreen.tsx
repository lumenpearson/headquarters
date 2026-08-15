'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TerminalButton, TerminalInput, TerminalSelect } from '@gremuchaya/ui/primitives';

import { EmptyState, Panel, StatusBadge } from '@/components/operations/OpsUi';
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
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CaseStatusFilter>('all');
  const [sortKey, setSortKey] = useState<'code' | 'title' | 'createdAt' | 'priority'>('priority');
  const [descending, setDescending] = useState(true);
  const [selectedFolder, setSelectedFolder] = useState('01_Досье');
  const activeId = detailId ?? state.ui.selectedCaseId;
  const selectedCase = state.cases[activeId] ?? Object.values(state.cases)[0];
  const selectedPerson =
    selectedCase === undefined ? undefined : state.people[selectedCase.subjectPersonId];
  const selectedFiles =
    selectedCase === undefined
      ? []
      : selectedCase.attachmentIds.flatMap((id) =>
          state.attachments[id] === undefined ? [] : [state.attachments[id]],
        );
  const cases = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU');
    return Object.values(state.cases)
      .filter((caseFile) => statusFilter === 'all' || caseFile.status === statusFilter)
      .filter(
        (caseFile) =>
          normalizedQuery === '' ||
          `${caseFile.code} ${caseFile.title} ${caseFile.tags.join(' ')}`
            .toLocaleLowerCase('ru-RU')
            .includes(normalizedQuery),
      )
      .sort((left, right) => {
        const a = left[sortKey];
        const b = right[sortKey];
        const result =
          typeof a === 'number' && typeof b === 'number'
            ? a - b
            : String(a).localeCompare(String(b), 'ru-RU');
        return descending ? -result : result;
      });
  }, [descending, query, sortKey, state.cases, statusFilter]);

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
      <div className="cases-layout">
        <Panel title="СТРУКТУРА ХРАНИЛИЩА" eyebrow="CASE TREE / LOCAL" className="case-tree-panel">
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

        <Panel
          title="РЕЕСТР ДЕЛ"
          eyebrow={`${selectedFolder} / ${cases.length} RECORDS`}
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
          <footer className="registry-pagination">
            <span>СТРАНИЦА 01 / 02</span>
            <TerminalButton>[◀] PREV</TerminalButton>
            <TerminalButton className="is-active">01</TerminalButton>
            <TerminalButton>02</TerminalButton>
            <TerminalButton>NEXT [▶]</TerminalButton>
            <span>SELECTED: {selectedCase?.id ?? '—'}</span>
          </footer>
        </Panel>

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
      </div>
    </div>
  );
}
