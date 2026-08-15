'use client';

import { useMemo, useState } from 'react';
import { TerminalButton, TerminalInput, TerminalSelect } from '@gremuchaya/ui/primitives';

import { EmptyState, Panel, StatusBadge } from '@/components/operations/OpsUi';
import { useOperationsStore } from '@/state/operationsStore';

type FileSort = 'title' | 'createdAt' | 'kind' | 'sizeLabel';

const fileSortOptions = [
  { value: 'createdAt', label: 'ДАТА' },
  { value: 'title', label: 'НАЗВАНИЕ' },
  { value: 'kind', label: 'ТИП' },
  { value: 'sizeLabel', label: 'РАЗМЕР' },
] as const satisfies ReadonlyArray<{ readonly value: FileSort; readonly label: string }>;

export function FilesScreen({ archive }: { readonly archive: boolean }) {
  const state = useOperationsStore((value) => value);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<FileSort>('createdAt');
  const selected = state.attachments[state.ui.selectedFileId];
  const files = useMemo(
    () =>
      Object.values(state.attachments)
        .filter((file) =>
          archive ? file.status === 'ARCHIVED' || file.createdAt < '2026-09-12' : true,
        )
        .filter(
          (file) => state.ui.fileKindFilter === 'all' || file.kind === state.ui.fileKindFilter,
        )
        .filter((file) =>
          `${file.id} ${file.title} ${file.tags.join(' ')} ${file.source}`
            .toLocaleLowerCase('ru-RU')
            .includes(query.toLocaleLowerCase('ru-RU')),
        )
        .sort((left, right) => String(left[sort]).localeCompare(String(right[sort]), 'ru-RU')),
    [archive, query, sort, state.attachments, state.ui.fileKindFilter],
  );

  return (
    <div className="ops-screen files-screen">
      <header className="ops-screen__title">
        <div>
          <span>{archive ? 'HISTORICAL MATERIALS' : 'LOCAL EVIDENCE STORE'} / READ ONLY</span>
          <h1>{archive ? 'АРХИВНЫЕ МАТЕРИАЛЫ' : 'ФАЙЛЫ И МАТЕРИАЛЫ'}</h1>
        </div>
        <div className="files-summary">
          <span>
            <small>FILES</small>
            <strong>{files.length}</strong>
          </span>
          <span>
            <small>STORAGE</small>
            <strong>72%</strong>
          </span>
          <span>
            <small>INTEGRITY</small>
            <strong>OK</strong>
          </span>
        </div>
      </header>
      <div className="files-layout">
        <Panel title="КАТЕГОРИИ" eyebrow="FILTER / INDEX" className="file-categories">
          <TerminalButton
            className={state.ui.fileKindFilter === 'all' ? 'is-active' : ''}
            onClick={() => state.setFileKindFilter('all')}
          >
            <i>[*]</i>
            <span>ВСЕ МАТЕРИАЛЫ</span>
            <b>{Object.keys(state.attachments).length}</b>
          </TerminalButton>
          {['image', 'video', 'audio', 'document', 'report', 'map', 'data'].map((kind) => (
            <TerminalButton
              key={kind}
              className={state.ui.fileKindFilter === kind ? 'is-active' : ''}
              onClick={() => state.setFileKindFilter(kind)}
            >
              <i>[{kind.slice(0, 3).toUpperCase()}]</i>
              <span>{kind.toUpperCase()}</span>
              <b>{Object.values(state.attachments).filter((file) => file.kind === kind).length}</b>
            </TerminalButton>
          ))}
        </Panel>
        <Panel
          title={archive ? 'АРХИВНЫЙ ИНДЕКС' : 'МАТЕРИАЛЫ'}
          eyebrow={`${files.length} RECORDS / LOCAL`}
          className="file-registry"
        >
          <div className="ops-filterbar">
            <TerminalButton
              onClick={() => state.setFilesView('list')}
              className={state.ui.filesView === 'list' ? 'is-active' : ''}
            >
              [L] LIST
            </TerminalButton>
            <TerminalButton
              onClick={() => state.setFilesView('grid')}
              className={state.ui.filesView === 'grid' ? 'is-active' : ''}
            >
              [G] GRID
            </TerminalButton>
            <label>
              <span>/</span>
              <TerminalInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Поиск материалов"
                placeholder="ПОИСК ПО ID / ТЕГАМ / ИСТОЧНИКУ"
              />
            </label>
            <TerminalSelect
              value={sort}
              options={fileSortOptions}
              onValueChange={setSort}
              label="Сортировка материалов"
            />
          </div>
          {files.length === 0 ? (
            <EmptyState>АРХИВНЫЕ МАТЕРИАЛЫ ОТСУТСТВУЮТ</EmptyState>
          ) : state.ui.filesView === 'list' ? (
            <table className="ops-table files-table">
              <thead>
                <tr>
                  <th>TYPE</th>
                  <th>ID / NAME</th>
                  <th>STATUS</th>
                  <th>DATE</th>
                  <th>SOURCE</th>
                  <th>ACCESS</th>
                  <th>SIZE</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr
                    key={file.id}
                    className={file.id === selected?.id ? 'is-selected' : ''}
                    onClick={() => state.selectFile(file.id)}
                    onDoubleClick={() => state.openDrawer('file', file.id)}
                  >
                    <td>[{file.kind.slice(0, 3).toUpperCase()}]</td>
                    <td>
                      <strong>{file.id}</strong>
                      <small>{file.title}</small>
                    </td>
                    <td>
                      <StatusBadge status={file.status} />
                    </td>
                    <td>{new Date(file.createdAt).toLocaleString('ru-RU')}</td>
                    <td>{file.source}</td>
                    <td>{file.classification}</td>
                    <td>{file.sizeLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="file-card-grid">
              {files.map((file) => (
                <TerminalButton
                  key={file.id}
                  className={file.id === selected?.id ? 'is-selected' : ''}
                  onClick={() => state.selectFile(file.id)}
                  onDoubleClick={() => state.openDrawer('file', file.id)}
                >
                  <div className={`file-card-preview file-card-preview--${file.kind}`}>
                    <i>[{file.kind.toUpperCase()}]</i>
                    <span>{file.id}</span>
                  </div>
                  <strong>{file.title}</strong>
                  <small>
                    {file.source} / {file.sizeLabel}
                  </small>
                </TerminalButton>
              ))}
            </div>
          )}
        </Panel>
        <Panel
          title="ПРЕДПРОСМОТР"
          eyebrow={selected?.id ?? 'NO SELECTION'}
          className="file-preview-panel"
        >
          {selected === undefined ? (
            <EmptyState>МАТЕРИАЛ НЕ ВЫБРАН</EmptyState>
          ) : (
            <>
              <div className={`ops-file-preview ops-file-preview--${selected.kind}`}>
                <div className="file-preview-grid" />
                <i>[{selected.kind.toUpperCase()}]</i>
                <strong>{selected.preview}</strong>
                <span>LOCAL / VERIFIED / {selected.classification}</span>
              </div>
              <header>
                <div>
                  <strong>{selected.title}</strong>
                  <span>{selected.id}</span>
                </div>
                <StatusBadge status={selected.status} />
              </header>
              <dl className="ops-definition-list">
                <div>
                  <dt>ДАТА</dt>
                  <dd>{new Date(selected.createdAt).toLocaleString('ru-RU')}</dd>
                </div>
                <div>
                  <dt>ИСТОЧНИК</dt>
                  <dd>{selected.source}</dd>
                </div>
                <div>
                  <dt>РАЗМЕР</dt>
                  <dd>{selected.sizeLabel}</dd>
                </div>
                <div>
                  <dt>ТЕГИ</dt>
                  <dd>{selected.tags.join(', ')}</dd>
                </div>
                <div>
                  <dt>ДЕЛА</dt>
                  <dd>{selected.linkedCaseIds.join(', ')}</dd>
                </div>
                <div>
                  <dt>ОБЪЕКТЫ</dt>
                  <dd>{selected.linkedObjectIds.join(', ')}</dd>
                </div>
              </dl>
              <footer>
                <TerminalButton onClick={() => state.openDrawer('file', selected.id)}>
                  [ENTER] FILE VIEWER
                </TerminalButton>
                <TerminalButton>[+] ADD TO CASE</TerminalButton>
                <TerminalButton>[P] PRINT SIM</TerminalButton>
                <TerminalButton>[D] DOWNLOAD SIM</TerminalButton>
              </footer>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
