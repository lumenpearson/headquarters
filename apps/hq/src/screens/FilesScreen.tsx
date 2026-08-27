'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getSettingDefinition } from '@gremuchaya/settings-schema';
import {
  TerminalButton,
  TerminalDialog,
  TerminalInput,
  TerminalProgress,
  TerminalSelect,
} from '@gremuchaya/ui/primitives';

import { useActiveKeybinds } from '@/application/keybinds/activeScheme';
import { formatChord } from '@/application/keybinds/match';
import { compareText, dateTimeFormat, foldCase } from '@/application/localization/intl';
import { useKeybind } from '@/components/keybinds/KeybindRuntime';
import { EmptyState, Panel, StatusBadge } from '@/components/operations/OpsUi';
import { LocalMaterialPreview } from '@/components/operations/LocalMaterialPreview';
import type {
  MaterialEntry,
  MaterialImportProgress,
} from '@/infrastructure/materials/BridgeMaterialClient';
import { materialOriginLabel } from '@/infrastructure/materials/materialLibrary';
import { useMaterialLibrary } from '@/application/materials/useMaterialLibrary';
import {
  formatBytes,
  importedMaterialToAttachment,
  toImportedMaterial,
  toMaterialEntry,
} from '@/application/materials/importedMaterials';
import { useContextMenuAction } from '@/components/contextMenus/ContextMenuRuntime';
import { useBooleanSetting, useStringSetting } from '@/application/personalization/useSetting';
import { useRecordPage } from '@/application/records/useRecordPage';
import { useTablePageSize } from '@/application/records/useTablePageSize';
import { RecordPagination } from '@/components/operations/RecordPagination';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { useOperationsStore } from '@/state/operationsStore';

/**
 * What `toLocaleString()` with no options produced, said explicitly.
 *
 * The two stamps below used `new Date(...).toLocaleString('ru-RU')`, whose
 * shape is the implementation's choice rather than this screen's. Naming the
 * parts keeps the reading identical across the two locales' own conventions --
 * short date, seconds visible -- which is what a file's arrival time is for.
 */
const stampParts = { dateStyle: 'short', timeStyle: 'medium' } as const;

type FileSort = 'title' | 'createdAt' | 'kind' | 'sizeLabel';

const fileSortOptions = [
  { value: 'createdAt', label: 'ДАТА' },
  { value: 'title', label: 'НАЗВАНИЕ' },
  { value: 'kind', label: 'ТИП' },
  { value: 'sizeLabel', label: 'РАЗМЕР' },
] as const satisfies ReadonlyArray<{ readonly value: FileSort; readonly label: string }>;

const materialCategoryLabels: Readonly<Record<string, string>> = {
  video: 'ВИДЕО',
  camera: 'КАМЕРА',
  photo: 'ФОТО',
  audio: 'АУДИО',
  document: 'ДОКУМЕНТ',
  map: 'КАРТА',
  intercept: 'ПЕРЕХВАТ',
  dossier: 'ДОСЬЕ',
  report: 'РАПОРТ',
  archive: 'АРХИВ',
  technical: 'ТЕХНИЧЕСКОЕ',
  other: 'ПРОЧЕЕ',
};

/*
 * The categories the picker offers are the ones the definition itself allows,
 * not a second list of the same twelve names. A category added to the schema
 * would otherwise be selectable in the settings catalogue and missing from the
 * dialog that is supposed to honour it; this way it appears at once, under its
 * identifier until someone gives it a Russian label.
 */
const materialCategoryOptions: ReadonlyArray<{ readonly value: string; readonly label: string }> =
  (() => {
    const editor = getSettingDefinition('materials.defaultCategory')?.editor;
    const values = editor?.kind === 'enum' ? editor.options : [];
    return values.map((value) => ({
      value,
      label: materialCategoryLabels[value] ?? value.toUpperCase(),
    }));
  })();

export function FilesScreen({ archive }: { readonly archive: boolean }) {
  const state = useOperationsStore((value) => value);
  useContextMenuAction('record.open', (subject) => {
    if (subject !== undefined) state.openDrawer('file', subject);
  });
  useContextMenuAction('record.select', (subject) => {
    if (subject !== undefined) state.selectFile(subject);
  });
  const [query, setQuery] = useState('');
  /*
   * Seeded and re-seeded, not initialised: personalization hydrates from an
   * effect after the first render, so an initialiser would hold the factory
   * default for the life of the screen.
   */
  const configuredSort = useStringSetting('materials.defaultSort');
  const seededSort =
    (['createdAt', 'title', 'kind', 'sizeLabel'] as const).find(
      (candidate) => candidate === configuredSort,
    ) ?? 'createdAt';
  const [chosenSort, setChosenSort] = useState<FileSort | null>(null);
  const [sortSeededFrom, setSortSeededFrom] = useState<FileSort>(seededSort);
  if (sortSeededFrom !== seededSort) {
    setSortSeededFrom(seededSort);
    setChosenSort(null);
  }
  const sort = chosenSort ?? seededSort;
  const rememberImportCategory = useBooleanSetting('materials.rememberImportCategory');
  const [importOpen, setImportOpen] = useState(false);
  /*
   * The live listing of the selected library, which is the library's answer and
   * not this application's record. It exists only while the dialog is open --
   * what the registry shows comes from `materials.imported`, which outlives the
   * dialog, the screen and the session.
   */
  const [libraryMaterials, setLibraryMaterials] = useState<readonly MaterialEntry[]>([]);
  const [nextLibraryCursor, setNextLibraryCursor] = useState('');
  const [bridgeStatus, setBridgeStatus] = useState<'idle' | 'loading' | 'unavailable'>('idle');
  const [bridgeMessage, setBridgeMessage] = useState('');
  const [importProgress, setImportProgress] = useState<MaterialImportProgress | null>(null);
  const [importing, setImporting] = useState(false);
  /*
   * `materials.defaultCategory` decides what the import dialog offers before
   * the operator has said anything. It is applied each time the dialog opens
   * rather than only on mount, so changing it in the catalogue takes effect on
   * the next import instead of the next reload -- and so a category chosen for
   * one batch does not silently carry into the next.
   */
  const defaultCategory = useStringSetting('materials.defaultCategory');
  const [importCategory, setImportCategory] = useState(defaultCategory);
  const abortImport = useRef<AbortController | null>(null);
  const materialClient = useMaterialLibrary();
  const importedMaterials = useOperationsStore((value) => value.materials.imported);
  /*
   * The registry reads the store, not the dialog. An import used to reach the
   * table only while the hidden dialog was open and only for as long as that
   * screen was mounted; now the record is the store's and the table shows it
   * whether or not anyone has ever opened the importer.
   */
  const importedAttachments = useMemo(
    () => Object.values(importedMaterials).map(importedMaterialToAttachment),
    [importedMaterials],
  );
  const allFiles = useMemo(
    () => [...Object.values(state.attachments), ...importedAttachments],
    [importedAttachments, state.attachments],
  );
  const selected = allFiles.find((file) => file.id === state.ui.selectedFileId);
  const selectedImport = selected === undefined ? undefined : importedMaterials[selected.id];
  const selectedMaterial = useMemo(
    () => (selectedImport === undefined ? undefined : toMaterialEntry(selectedImport)),
    [selectedImport],
  );
  const pageSize = useTablePageSize();
  const normalizedQuery = foldCase(query);
  const { page: filePage, goToPage } = useRecordPage(allFiles, {
    pageSize,
    filters: [
      (file) => (archive ? file.status === 'ARCHIVED' || file.createdAt < '2026-09-12' : true),
      (file) => state.ui.fileKindFilter === 'all' || file.kind === state.ui.fileKindFilter,
      (file) =>
        foldCase(`${file.id} ${file.title} ${file.tags.join(' ')} ${file.source}`).includes(
          normalizedQuery,
        ),
    ],
    comparator: (left, right) => compareText(String(left[sort]), String(right[sort])),
  });
  const files = filePage.items;

  const openImportDialog = () => {
    setBridgeStatus('loading');
    setBridgeMessage('');
    // `materials.rememberImportCategory` keeps the last choice instead. The
    // default stays "reset", so a category chosen for one batch does not
    // silently carry into the next unless the operator asked for that.
    if (!rememberImportCategory) setImportCategory(defaultCategory);
    setImportOpen(true);
  };

  useKeybind('files.import', openImportDialog);

  /*
   * The chord printed on the dialog, taken from the collection now in force.
   *
   * It was written out as `[CTRL+SHIFT+ALT+S]`, which is the `terminal-default`
   * chord and nothing else: `vim-inspired` moves this gesture to Shift+R and
   * the accessibility collection to Ctrl+S, so under either the dialog named a
   * combination that would not open it. That is the defect
   * `application/keybinds/activeScheme.ts` names as its own reason for
   * existing, and the one `entryShortcut` fixed for the context menus (C35).
   * Uppercased because the eyebrow is machine register; the chord itself is
   * never spelled here.
   */
  const importKeybind = useActiveKeybinds().find((keybind) => keybind.id === 'files.import');
  const importChord =
    importKeybind === undefined ? '' : `[${formatChord(importKeybind.chord).toUpperCase()}] / `;

  useEffect(() => {
    if (!importOpen) return;
    let cancelled = false;
    void materialClient
      .list()
      .then((page) => {
        if (cancelled) return;
        setLibraryMaterials(page.materials);
        setNextLibraryCursor(page.nextCursor);
        setBridgeStatus('idle');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBridgeStatus('unavailable');
        setBridgeMessage(messageFromBridgeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [importOpen, materialClient]);

  const loadMoreLibraryMaterials = async () => {
    if (nextLibraryCursor.length === 0 || bridgeStatus === 'loading') return;
    setBridgeStatus('loading');
    try {
      const page = await materialClient.list(nextLibraryCursor);
      setLibraryMaterials((current) => [...current, ...page.materials]);
      setNextLibraryCursor(page.nextCursor);
      setBridgeStatus('idle');
    } catch (error: unknown) {
      setBridgeStatus('unavailable');
      setBridgeMessage(messageFromBridgeError(error));
    }
  };

  const importSelectedFiles = async (fileList: FileList | null) => {
    const filesToImport = Array.from(fileList ?? []);
    if (filesToImport.length === 0 || importing) return;
    const controller = new AbortController();
    abortImport.current = controller;
    setImporting(true);
    setBridgeMessage('');
    try {
      // The category is declared once for the batch: the control plane carries
      // it on `BeginUpload`, the bridge has no field for it, and either way the
      // store's record is what the rest of the application reads.
      const library = materialClient.withCategory(importCategory);
      for (const file of filesToImport) {
        const completed = await library.importFile(file, setImportProgress, controller.signal);
        setLibraryMaterials((current) => [
          completed.material,
          ...current.filter((entry) => entry.materialId !== completed.material.materialId),
        ]);
        state.recordImportedMaterial(
          toImportedMaterial(completed.material, {
            category: importCategory,
            origin: library.origin,
            importedAt: new Date().toISOString(),
          }),
        );
        state.selectFile(completed.material.materialId);
      }
      setBridgeMessage(
        `ЗАГРУЖЕНО: ${filesToImport.length} / ${materialOriginLabel(materialClient.origin)}`,
      );
      setBridgeStatus('idle');
    } catch (error: unknown) {
      setBridgeStatus('unavailable');
      setBridgeMessage(
        controller.signal.aborted ? 'ИМПОРТ ОТМЕНЁН ОПЕРАТОРОМ' : messageFromBridgeError(error),
      );
    } finally {
      abortImport.current = null;
      setImporting(false);
      setImportProgress(null);
    }
  };

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
        title: 'КАТЕГОРИИ',
        category: 'navigation',
        descriptor: {
          id: 'categories',
          priority: 80,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel title="КАТЕГОРИИ" eyebrow="FILTER / INDEX" className="file-categories">
            <TerminalButton
              className={state.ui.fileKindFilter === 'all' ? 'is-active' : ''}
              onClick={() => state.setFileKindFilter('all')}
            >
              <i>[*]</i>
              <span>ВСЕ МАТЕРИАЛЫ</span>
              <b>{allFiles.length}</b>
            </TerminalButton>
            {['image', 'video', 'audio', 'document', 'report', 'map', 'data'].map((kind) => (
              <TerminalButton
                key={kind}
                className={state.ui.fileKindFilter === kind ? 'is-active' : ''}
                onClick={() => state.setFileKindFilter(kind)}
              >
                <i>[{kind.slice(0, 3).toUpperCase()}]</i>
                <span>{kind.toUpperCase()}</span>
                <b>{allFiles.filter((file) => file.kind === kind).length}</b>
              </TerminalButton>
            ))}
          </Panel>
        ),
      },
      {
        title: 'РЕЕСТР ФАЙЛОВ',
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
            title={archive ? 'АРХИВНЫЙ ИНДЕКС' : 'МАТЕРИАЛЫ'}
            eyebrow={`${filePage.total} RECORDS / LOCAL`}
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
                onValueChange={setChosenSort}
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
                      data-interactive="true"
                      data-context-menu="record"
                      data-context-subject={file.id}
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
                      <td>{dateTimeFormat(stampParts).format(new Date(file.createdAt))}</td>
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
            <RecordPagination page={filePage} onPage={goToPage} label="Страницы реестра файлов">
              <span>SELECTED: {selected?.id ?? '—'}</span>
            </RecordPagination>
          </Panel>
        ),
      },
      {
        title: 'ПРЕДПРОСМОТР',
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
            title="ПРЕДПРОСМОТР"
            eyebrow={selected?.id ?? 'NO SELECTION'}
            className="file-preview-panel"
          >
            {selected === undefined ? (
              <EmptyState>МАТЕРИАЛ НЕ ВЫБРАН</EmptyState>
            ) : (
              <>
                {selectedMaterial ? (
                  <LocalMaterialPreview
                    key={selectedMaterial.materialId}
                    material={selectedMaterial}
                    client={materialClient}
                  />
                ) : (
                  <div className={`ops-file-preview ops-file-preview--${selected.kind}`}>
                    <div className="file-preview-grid" />
                    <i>[{selected.kind.toUpperCase()}]</i>
                    <strong>{selected.preview}</strong>
                    <span>LOCAL / VERIFIED / {selected.classification}</span>
                  </div>
                )}
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
                    <dd>{dateTimeFormat(stampParts).format(new Date(selected.createdAt))}</dd>
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
        ),
      },
    ],
    [
      allFiles,
      archive,
      filePage,
      files,
      goToPage,
      materialClient,
      query,
      selected,
      selectedMaterial,
      sort,
      state,
    ],
  );

  return (
    <>
      <div className="ops-screen files-screen">
        <header className="ops-screen__title">
          <div>
            <span>{archive ? 'HISTORICAL MATERIALS' : 'LOCAL EVIDENCE STORE'} / READ ONLY</span>
            <h1>{archive ? 'АРХИВНЫЕ МАТЕРИАЛЫ' : 'ФАЙЛЫ И МАТЕРИАЛЫ'}</h1>
          </div>
          <div className="files-summary">
            <span>
              <small>FILES</small>
              <strong>{filePage.total}</strong>
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
        <TileGrid tiles={tiles} columns={12} className="files-layout" screen="files" />
      </div>
      <TerminalDialog
        title={
          materialClient.origin === 'group-library'
            ? 'ИМПОРТ МАТЕРИАЛОВ В ГРУППУ'
            : 'ЛОКАЛЬНЫЙ ИМПОРТ МАТЕРИАЛОВ'
        }
        eyebrow={`${importChord}${materialClient.origin === 'group-library' ? 'CONTROL PLANE GRPC-WEB' : 'LOOPBACK GRPC-WEB'}`}
        description={
          materialClient.origin === 'group-library'
            ? 'Материалы уходят в библиотеку группы: control plane резервирует части, браузер пишет их прямо в объектное хранилище по подписанным адресам.'
            : 'Материалы пишутся только в локальный mirror. Группа не подключена либо этот control plane не объявляет коллаборатор materials.'
        }
        open={importOpen}
        onOpenChange={(open) => {
          if (!open && importing) abortImport.current?.abort();
          if (open) openImportDialog();
          else setImportOpen(false);
        }}
        className="material-import-dialog"
        footer={
          <>
            {importing ? (
              <TerminalButton tone="critical" onClick={() => abortImport.current?.abort()}>
                [ESC] CANCEL IMPORT
              </TerminalButton>
            ) : null}
            <TerminalButton tone="quiet" onClick={() => setImportOpen(false)}>
              CLOSE
            </TerminalButton>
          </>
        }
      >
        <div className="material-import-dialog__content">
          <label className="material-import-dialog__picker">
            <span>КАТЕГОРИЯ ИМПОРТА</span>
            <TerminalSelect
              value={importCategory}
              options={materialCategoryOptions}
              onValueChange={setImportCategory}
              label="Категория импортируемых материалов"
              disabled={importing}
            />
          </label>
          <label className="material-import-dialog__picker">
            <span>ВЫБРАТЬ ФАЙЛЫ / ВИДЕО / ФОТО / ДОКУМЕНТЫ</span>
            <TerminalInput
              type="file"
              multiple
              disabled={importing}
              aria-label="Выбрать материалы для локального импорта"
              onChange={(event) => {
                void importSelectedFiles(event.currentTarget.files);
                event.currentTarget.value = '';
              }}
            />
          </label>
          {importProgress ? (
            <TerminalProgress
              value={importProgress.receivedBytes}
              max={Math.max(1, importProgress.totalBytes)}
              label={`${importProgress.phase.toUpperCase()} / ${importProgress.fileName}`}
              tone="warning"
            />
          ) : null}
          <p
            className="material-import-dialog__status"
            data-state={bridgeStatus}
            role={bridgeStatus === 'unavailable' ? 'alert' : 'status'}
          >
            {bridgeMessage ||
              (bridgeStatus === 'loading'
                ? 'ЧТЕНИЕ ЛОКАЛЬНОГО MIRROR…'
                : 'READY / SELECT FILES TO START A BOUNDED BINARY TRANSFER')}
          </p>
          <div className="material-import-dialog__recent">
            <header>
              <span>
                {materialOriginLabel(materialClient.origin)} / {libraryMaterials.length} RECORDS
              </span>
              {nextLibraryCursor ? (
                <TerminalButton
                  size="small"
                  tone="quiet"
                  onClick={() => void loadMoreLibraryMaterials()}
                >
                  NEXT PAGE
                </TerminalButton>
              ) : null}
            </header>
            {libraryMaterials.length === 0 ? (
              <EmptyState>ИМПОРТИРОВАННЫЕ МАТЕРИАЛЫ ОТСУТСТВУЮТ</EmptyState>
            ) : (
              <ul>
                {libraryMaterials.map((material) => (
                  <li key={material.materialId}>
                    <strong>{material.displayName}</strong>
                    <span>
                      {material.mimeType || 'application/octet-stream'} /{' '}
                      {formatBytes(material.byteSize)}
                    </span>
                    <code>{material.contentHash.slice(0, 16)}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </TerminalDialog>
    </>
  );
}

function messageFromBridgeError(error: unknown): string {
  if (error instanceof Error) return `BRIDGE: ${error.message}`;
  return 'BRIDGE: НЕИЗВЕСТНАЯ ОШИБКА ЛОКАЛЬНОГО ИМПОРТА';
}
