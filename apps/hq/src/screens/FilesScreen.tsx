'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TerminalAlertDialog,
  TerminalButton,
  TerminalDialog,
  TerminalInput,
  TerminalProgress,
  TerminalSelect,
} from '@gremuchaya/ui/primitives';

import type { FileKind } from '@gremuchaya/domain';

import { useActiveKeybinds } from '@/application/keybinds/activeScheme';
import { formatChord } from '@/application/keybinds/match';
import { compareText, dateTimeFormat, foldCase } from '@/application/localization/intl';
import { t, useTranslate } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import { useKeybind } from '@/components/keybinds/KeybindRuntime';
import { EmptyState, Panel, StatusBadge } from '@/components/operations/OpsUi';
import { LocalMaterialPreview } from '@/components/operations/LocalMaterialPreview';
import { MaterialLifecyclePanel } from '@/components/operations/MaterialLifecyclePanel';
import type {
  MaterialEntry,
  MaterialImportProgress,
} from '@/infrastructure/materials/BridgeMaterialClient';
import {
  isMaterialLifecycleClient,
  materialOriginLabel,
} from '@/infrastructure/materials/materialLibrary';
import { useMaterialLibrary } from '@/application/materials/useMaterialLibrary';
import { useMaterialLibraryEvents } from '@/application/materials/useMaterialLibraryEvents';
import {
  importPhaseLabel,
  materialCategoryOptions,
} from '@/application/materials/materialCategories';
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

const fileSortMessageIds = [
  { value: 'createdAt', id: 'files.sortDate' },
  { value: 'title', id: 'field.name' },
  { value: 'kind', id: 'field.type' },
  { value: 'sizeLabel', id: 'field.size' },
] as const satisfies ReadonlyArray<{ readonly value: FileSort; readonly id: MessageId }>;

const fileKindOrder = ['image', 'video', 'audio', 'document', 'report', 'map', 'data'] as const;

/**
 * The word an operator reads for a `FileKind` -- the categories tile's own
 * filter chips and the badge a table row or a card draws for its file, keyed
 * so a kind the domain package gains with no entry here is a compile error.
 * The three-letter glyph beside it (`file.kind.slice(0, 3).toUpperCase()`) is
 * left alone: a mechanical short code derived from the English identifier,
 * not a word this table exists to translate.
 */
const fileKindMessageIds: Readonly<Record<FileKind, MessageId>> = {
  image: 'field.kindImage',
  video: 'field.kindVideo',
  audio: 'field.kindAudio',
  document: 'field.document',
  report: 'field.kindReport',
  map: 'nav.map',
  data: 'files.kindData',
};

export function FilesScreen({ archive }: { readonly archive: boolean }) {
  const translate = useTranslate();
  // Memoized, not a plain `.map()`: `tiles` below reads this array and lists
  // `translate` itself in its own dependency array, so an unmemoized
  // reference recreated every render would ask `react-hooks/exhaustive-deps`
  // for a dependency array `tiles` could never satisfy without listing this
  // whole array by value.
  const fileSortOptions = useMemo(
    () => fileSortMessageIds.map(({ value, id }) => ({ value, label: translate(id) })),
    [translate],
  );
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
  const lifecycle = isMaterialLifecycleClient(materialClient) ? materialClient : null;
  /*
   * The dialog's own listing tab -- recent uploads or the group's trash.
   * `lifecycle` gates whether the second even exists: the loopback bridge
   * offers no `ListTrash`, so a screen on the mirror never sees the toggle.
   */
  const [dialogView, setDialogView] = useState<'recent' | 'trash'>('recent');
  /*
   * A selected library entry, previewed inline through the same
   * `LocalMaterialPreview` surface the registry uses -- bounded by the same
   * `materials.previewLimitMb`/`textPreviewLimitMb` limits, since neither the
   * dialog nor this state carries a limit of its own (t5-player-rework).
   */
  const [previewMaterial, setPreviewMaterial] = useState<MaterialEntry | null>(null);
  const [trashMaterials, setTrashMaterials] = useState<readonly MaterialEntry[]>([]);
  const [nextTrashCursor, setNextTrashCursor] = useState('');
  const [trashStatus, setTrashStatus] = useState<'idle' | 'loading' | 'unavailable'>('idle');
  const [trashMessage, setTrashMessage] = useState('');
  // The library's own change feed (R1's "notification of another device's
  // upload"), read only while the dialog is open and the library can offer it.
  const libraryEvents = useMaterialLibraryEvents(materialClient, importOpen);
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
  // The question is the category chip plus the search text: either one
  // narrows the registry, and without this the operator kept whatever page
  // the previous chip or word had left them on.
  const { page: filePage, goToPage } = useRecordPage(
    allFiles,
    {
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
    },
    `${state.ui.fileKindFilter}:${normalizedQuery}`,
  );
  const files = filePage.items;

  const openImportDialog = () => {
    setBridgeStatus('loading');
    setBridgeMessage('');
    setDialogView('recent');
    setPreviewMaterial(null);
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

  useEffect(() => {
    if (!importOpen || dialogView !== 'trash' || lifecycle === null) return;
    let cancelled = false;
    void lifecycle
      .listTrash()
      .then((page) => {
        if (cancelled) return;
        setTrashMaterials(page.materials);
        setNextTrashCursor(page.nextCursor);
        setTrashStatus('idle');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTrashStatus('unavailable');
        setTrashMessage(messageFromBridgeError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [importOpen, dialogView, lifecycle]);

  const loadMoreTrash = async () => {
    if (lifecycle === null || nextTrashCursor.length === 0 || trashStatus === 'loading') return;
    setTrashStatus('loading');
    try {
      const page = await lifecycle.listTrash(nextTrashCursor);
      setTrashMaterials((current) => [...current, ...page.materials]);
      setNextTrashCursor(page.nextCursor);
      setTrashStatus('idle');
    } catch (error: unknown) {
      setTrashStatus('unavailable');
      setTrashMessage(messageFromBridgeError(error));
    }
  };

  const restoreFromTrash = async (target: MaterialEntry) => {
    if (lifecycle === null) return;
    setTrashMessage('');
    try {
      await lifecycle.restoreMaterial(target.materialId);
      setTrashMaterials((current) =>
        current.filter((entry) => entry.materialId !== target.materialId),
      );
      setLibraryMaterials((current) => [
        target,
        ...current.filter((entry) => entry.materialId !== target.materialId),
      ]);
      /*
       * Trash forgot the store's record (`applyLifecycleTrash`), so without a
       * new one the restored material exists only in this dialog's own React
       * state -- invisible to the file browser until a reload. The original
       * category went down with the forgotten record and the wire carries no
       * category back, so the restored record re-enters under the default
       * category rather than an invented recollection.
       */
      state.recordImportedMaterial(
        toImportedMaterial(target, {
          category: defaultCategory,
          origin: materialClient.origin === 'group-library' ? 'group-library' : 'local-mirror',
          importedAt: new Date().toISOString(),
        }),
      );
      setTrashMessage(t('files.restoredMessage', { name: target.displayName }));
    } catch (error: unknown) {
      setTrashStatus('unavailable');
      setTrashMessage(messageFromBridgeError(error));
    }
  };

  const purgeFromTrash = async (target: MaterialEntry) => {
    if (lifecycle === null) return;
    setTrashMessage('');
    try {
      await lifecycle.purgeMaterial(target.materialId, target.materialId);
      setTrashMaterials((current) =>
        current.filter((entry) => entry.materialId !== target.materialId),
      );
      state.forgetImportedMaterial(target.materialId);
      setTrashMessage(t('files.purgedMessage', { name: target.displayName }));
    } catch (error: unknown) {
      setTrashStatus('unavailable');
      setTrashMessage(messageFromBridgeError(error));
    }
  };

  /*
   * What `MaterialLifecyclePanel` reports back after a rename or a new
   * version: the store's record for this material moves with it, the same
   * way `importSelectedFiles` writes the first version's record.
   */
  const applyLifecycleUpdate = useCallback(
    (updated: MaterialEntry, category: string) => {
      if (selectedImport === undefined) return;
      state.recordImportedMaterial(
        toImportedMaterial(updated, {
          category,
          origin: selectedImport.origin === 'group-library' ? 'group-library' : 'local-mirror',
          importedAt: selectedImport.importedAt,
        }),
      );
    },
    [selectedImport, state],
  );

  const applyLifecycleTrash = useCallback(
    (materialId: string) => {
      state.forgetImportedMaterial(materialId);
      setLibraryMaterials((current) => current.filter((entry) => entry.materialId !== materialId));
      if (state.ui.selectedFileId === materialId) state.selectFile('');
    },
    [state],
  );

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
        t('files.importedMessage', {
          count: filesToImport.length,
          origin: materialOriginLabel(materialClient.origin),
        }),
      );
      setBridgeStatus('idle');
    } catch (error: unknown) {
      setBridgeStatus('unavailable');
      setBridgeMessage(
        controller.signal.aborted ? t('files.importCancelled') : messageFromBridgeError(error),
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
        title: translate('files.categoriesTitle'),
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
          <Panel
            title={translate('files.categoriesTitle')}
            eyebrow={translate('files.categoriesEyebrow')}
            className="file-categories"
          >
            <TerminalButton
              className={state.ui.fileKindFilter === 'all' ? 'is-active' : ''}
              onClick={() => state.setFileKindFilter('all')}
            >
              <i>[*]</i>
              <span>{translate('files.allMaterials')}</span>
              <b>{allFiles.length}</b>
            </TerminalButton>
            {fileKindOrder.map((kind) => (
              <TerminalButton
                key={kind}
                className={state.ui.fileKindFilter === kind ? 'is-active' : ''}
                onClick={() => state.setFileKindFilter(kind)}
              >
                <i>[{kind.slice(0, 3).toUpperCase()}]</i>
                <span>{translate(fileKindMessageIds[kind])}</span>
                <b>{allFiles.filter((file) => file.kind === kind).length}</b>
              </TerminalButton>
            ))}
          </Panel>
        ),
      },
      {
        title: translate('files.registryTitle'),
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
            title={translate(archive ? 'files.archiveIndexTitle' : 'field.materials')}
            eyebrow={translate('files.registryEyebrow', { count: filePage.total })}
            className="file-registry"
          >
            <div className="ops-filterbar">
              <TerminalButton
                onClick={() => state.setFilesView('list')}
                className={state.ui.filesView === 'list' ? 'is-active' : ''}
              >
                {translate('files.listViewButton')}
              </TerminalButton>
              <TerminalButton
                onClick={() => state.setFilesView('grid')}
                className={state.ui.filesView === 'grid' ? 'is-active' : ''}
              >
                {translate('files.gridViewButton')}
              </TerminalButton>
              <label>
                <span>/</span>
                <TerminalInput
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  aria-label={translate('files.searchAriaLabel')}
                  placeholder={translate('files.searchPlaceholder')}
                />
              </label>
              <TerminalSelect
                value={sort}
                options={fileSortOptions}
                onValueChange={setChosenSort}
                label={translate('files.sortSelectLabel')}
              />
            </div>
            {files.length === 0 ? (
              <EmptyState>{translate('files.noArchiveMaterials')}</EmptyState>
            ) : state.ui.filesView === 'list' ? (
              <table className="ops-table files-table">
                <thead>
                  <tr>
                    <th>{translate('field.type')}</th>
                    <th>{translate('files.colIdName')}</th>
                    <th>{translate('field.status')}</th>
                    <th>{translate('files.sortDate')}</th>
                    <th>{translate('field.source')}</th>
                    <th>{translate('files.colAccess')}</th>
                    <th>{translate('field.size')}</th>
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
                      <i>[{translate(fileKindMessageIds[file.kind])}]</i>
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
            <RecordPagination
              page={filePage}
              onPage={goToPage}
              label={translate('files.paginationLabel')}
            >
              <span>{translate('registry.selectedFooter', { id: selected?.id ?? '—' })}</span>
            </RecordPagination>
          </Panel>
        ),
      },
      {
        title: translate('files.previewTitle'),
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
            title={translate('files.previewTitle')}
            eyebrow={selected?.id ?? translate('registry.noSelection')}
            className="file-preview-panel"
          >
            {selected === undefined ? (
              <EmptyState>{translate('files.noMaterialSelected')}</EmptyState>
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
                    <i>[{translate(fileKindMessageIds[selected.kind])}]</i>
                    <strong>{selected.preview}</strong>
                    <span>
                      {translate('files.localVerifiedPrefix')} {selected.classification}
                    </span>
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
                    <dt>{translate('files.sortDate')}</dt>
                    <dd>{dateTimeFormat(stampParts).format(new Date(selected.createdAt))}</dd>
                  </div>
                  <div>
                    <dt>{translate('field.source')}</dt>
                    <dd>{selected.source}</dd>
                  </div>
                  <div>
                    <dt>{translate('field.size')}</dt>
                    <dd>{selected.sizeLabel}</dd>
                  </div>
                  <div>
                    <dt>{translate('field.tags')}</dt>
                    <dd>{selected.tags.join(', ')}</dd>
                  </div>
                  <div>
                    <dt>{translate('field.cases')}</dt>
                    <dd>{selected.linkedCaseIds.join(', ')}</dd>
                  </div>
                  <div>
                    <dt>{translate('field.objects')}</dt>
                    <dd>{selected.linkedObjectIds.join(', ')}</dd>
                  </div>
                </dl>
                <footer>
                  <TerminalButton onClick={() => state.openDrawer('file', selected.id)}>
                    {translate('files.fileViewerButton')}
                  </TerminalButton>
                  <TerminalButton>{translate('media.addToCaseButton')}</TerminalButton>
                  <TerminalButton>{translate('files.printSimButton')}</TerminalButton>
                  <TerminalButton>{translate('files.downloadSimButton')}</TerminalButton>
                </footer>
                {lifecycle !== null &&
                selectedMaterial !== undefined &&
                selectedImport?.origin === 'group-library' ? (
                  <MaterialLifecyclePanel
                    key={selectedMaterial.materialId}
                    lifecycle={lifecycle}
                    material={selectedMaterial}
                    category={selectedImport.category}
                    onUpdated={applyLifecycleUpdate}
                    onTrashed={applyLifecycleTrash}
                  />
                ) : null}
              </>
            )}
          </Panel>
        ),
      },
    ],
    [
      allFiles,
      applyLifecycleTrash,
      applyLifecycleUpdate,
      archive,
      fileSortOptions,
      filePage,
      files,
      goToPage,
      lifecycle,
      materialClient,
      query,
      selected,
      selectedImport,
      selectedMaterial,
      sort,
      state,
      translate,
    ],
  );

  return (
    <>
      <div className="ops-screen files-screen">
        <header className="ops-screen__title">
          <div>
            <span>
              {translate(
                archive ? 'files.historicalMaterialsEyebrow' : 'files.localEvidenceStoreEyebrow',
              )}
            </span>
            <h1>{translate(archive ? 'files.archiveHeading' : 'files.filesHeading')}</h1>
          </div>
          <div className="files-summary">
            <span>
              <small>{translate('files.summaryFiles')}</small>
              <strong>{filePage.total}</strong>
            </span>
            <span>
              <small>{translate('files.summaryStorage')}</small>
              <strong>72%</strong>
            </span>
            <span>
              <small>{translate('video.dtIntegrity')}</small>
              <strong>{translate('files.integrityOk')}</strong>
            </span>
          </div>
        </header>
        <TileGrid tiles={tiles} columns={12} className="files-layout" screen="files" />
      </div>
      <TerminalDialog
        title={translate(
          materialClient.origin === 'group-library'
            ? 'files.groupImportTitle'
            : 'files.localImportTitle',
        )}
        eyebrow={`${importChord}${translate(
          materialClient.origin === 'group-library'
            ? 'files.controlPlaneEyebrow'
            : 'files.loopbackEyebrow',
        )}`}
        description={translate(
          materialClient.origin === 'group-library'
            ? 'files.groupImportDescription'
            : 'files.localImportDescription',
        )}
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
                {translate('files.cancelImportButton')}
              </TerminalButton>
            ) : null}
            <TerminalButton tone="quiet" onClick={() => setImportOpen(false)}>
              {translate('files.closeButton')}
            </TerminalButton>
          </>
        }
      >
        <div className="material-import-dialog__content">
          <label className="material-import-dialog__picker">
            <span>{translate('files.importCategoryFieldLabel')}</span>
            <TerminalSelect
              value={importCategory}
              options={materialCategoryOptions()}
              onValueChange={setImportCategory}
              label={translate('files.importCategorySelectLabel')}
              disabled={importing}
            />
          </label>
          <label className="material-import-dialog__picker">
            <span>{translate('files.selectFilesFieldLabel')}</span>
            <TerminalInput
              type="file"
              multiple
              disabled={importing}
              aria-label={translate('files.selectFilesAriaLabel')}
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
              label={`${importPhaseLabel(importProgress.phase)} / ${importProgress.fileName}`}
              tone="warning"
            />
          ) : null}
          <p
            className="material-import-dialog__status"
            data-state={bridgeStatus}
            role={bridgeStatus === 'unavailable' ? 'alert' : 'status'}
          >
            {bridgeMessage ||
              translate(bridgeStatus === 'loading' ? 'files.readingMirror' : 'files.readyToImport')}
          </p>
          {lifecycle !== null ? (
            <div className="material-import-dialog__view-toggle" role="tablist">
              <TerminalButton
                size="small"
                className={dialogView === 'recent' ? 'is-active' : ''}
                onClick={() => {
                  setPreviewMaterial(null);
                  setDialogView('recent');
                }}
              >
                {translate('files.recentTabLabel')}
              </TerminalButton>
              <TerminalButton
                size="small"
                className={dialogView === 'trash' ? 'is-active' : ''}
                onClick={() => {
                  setPreviewMaterial(null);
                  setTrashStatus('loading');
                  setTrashMessage('');
                  setDialogView('trash');
                }}
              >
                {translate('files.trashTabLabel')}
              </TerminalButton>
              {libraryEvents.length > 0 ? (
                <span className="material-import-dialog__events" role="status">
                  {translate('files.libraryEventsLabel', {
                    count: libraryEvents.length,
                    kind: libraryEvents[0]?.kind.toUpperCase() ?? '',
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
          {dialogView === 'trash' && lifecycle !== null ? (
            <div className="material-import-dialog__recent">
              <header>
                <span>{translate('files.groupTrashHeader', { count: trashMaterials.length })}</span>
                {nextTrashCursor ? (
                  <TerminalButton size="small" tone="quiet" onClick={() => void loadMoreTrash()}>
                    {translate('files.nextPageButton')}
                  </TerminalButton>
                ) : null}
              </header>
              {trashMaterials.length === 0 ? (
                <EmptyState>{translate('files.trashEmpty')}</EmptyState>
              ) : (
                <ul>
                  {trashMaterials.map((entry) => (
                    <li key={entry.materialId}>
                      <TerminalButton
                        tone="quiet"
                        className={`material-import-dialog__entry ${
                          previewMaterial?.materialId === entry.materialId ? 'is-active' : ''
                        }`}
                        // aria-current, not aria-pressed: clicking this row
                        // selects it as the previewed entry within the list --
                        // one current selection among many, not an
                        // independent per-row toggle state -- which is what
                        // aria-current names.
                        aria-current={previewMaterial?.materialId === entry.materialId}
                        onClick={() => setPreviewMaterial(entry)}
                      >
                        <strong>{entry.displayName}</strong>
                        <span>
                          {entry.mimeType || 'application/octet-stream'} /{' '}
                          {formatBytes(entry.byteSize)}
                        </span>
                        <code>{entry.contentHash.slice(0, 16)}</code>
                      </TerminalButton>
                      <div className="material-import-dialog__recent-actions">
                        <TerminalButton size="small" onClick={() => void restoreFromTrash(entry)}>
                          {translate('files.restoreButton')}
                        </TerminalButton>
                        <TerminalAlertDialog
                          trigger={
                            <TerminalButton size="small" tone="critical">
                              {translate('files.purgeButton')}
                            </TerminalButton>
                          }
                          title={translate('files.purgeConfirmTitle')}
                          description={translate('files.purgeConfirmDescription')}
                          confirmLabel={translate('files.purgeButton')}
                          onConfirm={() => void purgeFromTrash(entry)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {trashMessage.length > 0 ? (
                <p
                  className="material-import-dialog__status"
                  data-state={trashStatus}
                  role={trashStatus === 'unavailable' ? 'alert' : 'status'}
                >
                  {trashMessage}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="material-import-dialog__recent">
              <header>
                <span>
                  {translate('files.libraryHeader', {
                    origin: materialOriginLabel(materialClient.origin),
                    count: libraryMaterials.length,
                  })}
                </span>
                {nextLibraryCursor ? (
                  <TerminalButton
                    size="small"
                    tone="quiet"
                    onClick={() => void loadMoreLibraryMaterials()}
                  >
                    {translate('files.nextPageButton')}
                  </TerminalButton>
                ) : null}
              </header>
              {libraryMaterials.length === 0 ? (
                <EmptyState>{translate('files.noImportedMaterials')}</EmptyState>
              ) : (
                <ul>
                  {libraryMaterials.map((material) => (
                    <li key={material.materialId}>
                      <TerminalButton
                        tone="quiet"
                        className={`material-import-dialog__entry ${
                          previewMaterial?.materialId === material.materialId ? 'is-active' : ''
                        }`}
                        // aria-current, not aria-pressed: see the trash list's
                        // row above -- one current selection among many, not
                        // an independent per-row toggle state.
                        aria-current={previewMaterial?.materialId === material.materialId}
                        onClick={() => setPreviewMaterial(material)}
                      >
                        <strong>{material.displayName}</strong>
                        <span>
                          {material.mimeType || 'application/octet-stream'} /{' '}
                          {formatBytes(material.byteSize)}
                        </span>
                        <code>{material.contentHash.slice(0, 16)}</code>
                      </TerminalButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {previewMaterial !== null ? (
            <div className="material-import-dialog__preview">
              <header>
                <span>
                  {translate('files.previewTitle')} / {previewMaterial.displayName}
                </span>
                <TerminalButton size="small" tone="quiet" onClick={() => setPreviewMaterial(null)}>
                  {translate('files.closePreviewButton')}
                </TerminalButton>
              </header>
              <LocalMaterialPreview
                key={previewMaterial.materialId}
                material={previewMaterial}
                client={materialClient}
              />
            </div>
          ) : null}
        </div>
      </TerminalDialog>
    </>
  );
}

function messageFromBridgeError(error: unknown): string {
  if (error instanceof Error) return t('files.bridgeErrorPrefix', { message: error.message });
  return t('files.bridgeErrorPrefix', { message: t('files.bridgeUnknownError') });
}
