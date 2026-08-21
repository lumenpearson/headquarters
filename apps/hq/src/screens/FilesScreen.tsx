'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, FileKind } from '@gremuchaya/domain';
import {
  TerminalButton,
  TerminalDialog,
  TerminalInput,
  TerminalProgress,
  TerminalSelect,
} from '@gremuchaya/ui/primitives';

import { useKeybind } from '@/components/keybinds/KeybindRuntime';
import { EmptyState, Panel, StatusBadge } from '@/components/operations/OpsUi';
import { LocalMaterialPreview } from '@/components/operations/LocalMaterialPreview';
import {
  BridgeMaterialClient,
  type MaterialEntry,
  type MaterialImportProgress,
} from '@/infrastructure/materials/BridgeMaterialClient';
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
  const [importOpen, setImportOpen] = useState(false);
  const [bridgeMaterials, setBridgeMaterials] = useState<readonly MaterialEntry[]>([]);
  const [nextBridgeCursor, setNextBridgeCursor] = useState('');
  const [bridgeStatus, setBridgeStatus] = useState<'idle' | 'loading' | 'unavailable'>('idle');
  const [bridgeMessage, setBridgeMessage] = useState('');
  const [importProgress, setImportProgress] = useState<MaterialImportProgress | null>(null);
  const [importing, setImporting] = useState(false);
  const abortImport = useRef<AbortController | null>(null);
  const materialClient = useMemo(() => new BridgeMaterialClient(), []);
  const localAttachments = useMemo(
    () => bridgeMaterials.map(materialToAttachment),
    [bridgeMaterials],
  );
  const allFiles = useMemo(
    () => [...Object.values(state.attachments), ...localAttachments],
    [localAttachments, state.attachments],
  );
  const selected = allFiles.find((file) => file.id === state.ui.selectedFileId);
  const selectedMaterial = bridgeMaterials.find((material) => material.materialId === selected?.id);
  const files = useMemo(
    () =>
      allFiles
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
    [allFiles, archive, query, sort, state.ui.fileKindFilter],
  );

  const openImportDialog = () => {
    setBridgeStatus('loading');
    setBridgeMessage('');
    setImportOpen(true);
  };

  useKeybind('files.import', openImportDialog);

  useEffect(() => {
    if (!importOpen) return;
    let cancelled = false;
    void materialClient
      .list()
      .then((page) => {
        if (cancelled) return;
        setBridgeMaterials(page.materials);
        setNextBridgeCursor(page.nextCursor);
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

  const loadMoreBridgeMaterials = async () => {
    if (nextBridgeCursor.length === 0 || bridgeStatus === 'loading') return;
    setBridgeStatus('loading');
    try {
      const page = await materialClient.list(nextBridgeCursor);
      setBridgeMaterials((current) => [...current, ...page.materials]);
      setNextBridgeCursor(page.nextCursor);
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
      for (const file of filesToImport) {
        const completed = await materialClient.importFile(
          file,
          setImportProgress,
          controller.signal,
        );
        setBridgeMaterials((current) => [
          completed.material,
          ...current.filter((entry) => entry.materialId !== completed.material.materialId),
        ]);
        state.selectFile(completed.material.materialId);
      }
      setBridgeMessage(`ЗАГРУЖЕНО: ${filesToImport.length} / LOCAL MIRROR`);
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
      <TerminalDialog
        title="ЛОКАЛЬНЫЙ ИМПОРТ МАТЕРИАЛОВ"
        eyebrow="[CTRL+SHIFT+ALT+S] / LOOPBACK GRPC-WEB"
        description="Материалы пишутся только в локальный mirror. Облачная синхронизация и удалённые grants ещё не активированы."
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
              <span>LOCAL MIRROR / {bridgeMaterials.length} RECORDS</span>
              {nextBridgeCursor ? (
                <TerminalButton
                  size="small"
                  tone="quiet"
                  onClick={() => void loadMoreBridgeMaterials()}
                >
                  NEXT PAGE
                </TerminalButton>
              ) : null}
            </header>
            {bridgeMaterials.length === 0 ? (
              <EmptyState>ЛОКАЛЬНЫЕ ИМПОРТИРОВАННЫЕ МАТЕРИАЛЫ ОТСУТСТВУЮТ</EmptyState>
            ) : (
              <ul>
                {bridgeMaterials.map((material) => (
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

function materialToAttachment(material: MaterialEntry): Attachment {
  return {
    id: material.materialId,
    title: material.displayName,
    kind: kindForMimeType(material.mimeType, material.displayName),
    status: 'READY',
    createdAt: material.createdAt,
    source: 'LOCAL MIRROR / GRPC-WEB',
    classification: 'АЛЬФА',
    tags: ['local-mirror', material.mimeType || 'application/octet-stream'],
    linkedCaseIds: [],
    linkedObjectIds: [],
    sizeLabel: formatBytes(material.byteSize),
    preview: `BLAKE3 ${material.contentHash.slice(0, 16)}`,
  };
}

function kindForMimeType(mimeType: string, fileName: string): FileKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('pdf') || mimeType.startsWith('text/')) return 'document';
  if (/\.(geojson|kml|kmz|gpx)$/iu.test(fileName)) return 'map';
  if (/\.(csv|json|xml|ya?ml)$/iu.test(fileName)) return 'data';
  return 'document';
}

function formatBytes(value: bigint): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'N/A';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function messageFromBridgeError(error: unknown): string {
  if (error instanceof Error) return `BRIDGE: ${error.message}`;
  return 'BRIDGE: НЕИЗВЕСТНАЯ ОШИБКА ЛОКАЛЬНОГО ИМПОРТА';
}
