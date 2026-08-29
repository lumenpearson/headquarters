'use client';

import { useEffect, useState } from 'react';
import {
  TerminalAlertDialog,
  TerminalButton,
  TerminalInput,
  TerminalSelect,
} from '@gremuchaya/ui/primitives';

import { dateTimeFormat } from '@/application/localization/intl';
import { formatBytes } from '@/application/materials/importedMaterials';
import { materialCategoryOptions } from '@/application/materials/materialCategories';
import type {
  MaterialEntry,
  MaterialImportProgress,
} from '@/infrastructure/materials/BridgeMaterialClient';
import type {
  MaterialLifecycleClient,
  MaterialVersionEntry,
} from '@/infrastructure/materials/materialLibrary';

import { EmptyState } from './OpsUi';

const stampParts = { dateStyle: 'short', timeStyle: 'medium' } as const;

export interface MaterialLifecyclePanelProps {
  readonly lifecycle: MaterialLifecycleClient;
  readonly material: MaterialEntry;
  /** The operator's last-declared category for this material, from the import record. */
  readonly category: string;
  readonly onUpdated: (material: MaterialEntry, category: string) => void;
  readonly onTrashed: (materialId: string) => void;
}

/**
 * Everything a group-library material can do beyond import and playback
 * (R1, R2): rename/re-categorize, replace its bytes with a new version, read
 * the version history, and move it to the group's trash.
 *
 * The loopback bridge has none of this -- `FileBridgeService` names no RPC for
 * any of it -- so this panel only ever renders behind
 * `isMaterialLifecycleClient`, and its one collaborator is the interface, not
 * the concrete control-plane client.
 */
export function MaterialLifecyclePanel({
  lifecycle,
  material,
  category,
  onUpdated,
  onTrashed,
}: MaterialLifecyclePanelProps) {
  /*
   * `FilesScreen` keys this panel by `material.materialId`, so a new
   * selection remounts it rather than leaving these fields to be reset by an
   * effect -- the initializer below is the whole reset.
   */
  const [displayName, setDisplayName] = useState(material.displayName);
  const [chosenCategory, setChosenCategory] = useState(category);
  const [versions, setVersions] = useState<readonly MaterialVersionEntry[]>([]);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingVersion, setUploadingVersion] = useState(false);
  const [versionProgress, setVersionProgress] = useState<MaterialImportProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    void lifecycle
      .listVersions(material.materialId)
      .then((page) => {
        if (!cancelled) setVersions(page.versions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lifecycle, material.materialId]);

  const saveMetadata = async () => {
    setSaving(true);
    setStatus('');
    try {
      const updated = await lifecycle.updateMetadata(material.materialId, {
        displayName,
        category: chosenCategory,
        metadata: {},
        tags: [],
      });
      onUpdated(updated, chosenCategory);
      setStatus('МЕТАДАННЫЕ ОБНОВЛЕНЫ');
    } catch (error: unknown) {
      setStatus(messageFromLifecycleError(error));
    } finally {
      setSaving(false);
    }
  };

  const uploadVersion = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (file === undefined || uploadingVersion) return;
    setUploadingVersion(true);
    setStatus('');
    try {
      const result = await lifecycle.createVersion(material.materialId, file, setVersionProgress);
      onUpdated(result.material, chosenCategory);
      const page = await lifecycle.listVersions(material.materialId);
      setVersions(page.versions);
      setStatus('НОВАЯ ВЕРСИЯ ЗАГРУЖЕНА');
    } catch (error: unknown) {
      setStatus(messageFromLifecycleError(error));
    } finally {
      setUploadingVersion(false);
      setVersionProgress(null);
    }
  };

  const trash = async () => {
    setStatus('');
    try {
      await lifecycle.moveToTrash(material.materialId);
      onTrashed(material.materialId);
    } catch (error: unknown) {
      setStatus(messageFromLifecycleError(error));
    }
  };

  return (
    <div className="material-lifecycle-panel">
      <header>
        <span>УПРАВЛЕНИЕ МАТЕРИАЛОМ / {material.materialId.slice(0, 8)}</span>
      </header>
      <label className="material-lifecycle-panel__field">
        <span>НАЗВАНИЕ</span>
        <TerminalInput
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          aria-label="Название материала"
          disabled={saving}
        />
      </label>
      <label className="material-lifecycle-panel__field">
        <span>КАТЕГОРИЯ</span>
        <TerminalSelect
          value={chosenCategory}
          options={materialCategoryOptions}
          onValueChange={setChosenCategory}
          label="Категория материала"
          disabled={saving}
        />
      </label>
      <div className="material-lifecycle-panel__actions">
        <TerminalButton size="small" onClick={() => void saveMetadata()} disabled={saving}>
          [S] СОХРАНИТЬ
        </TerminalButton>
        <TerminalAlertDialog
          trigger={
            <TerminalButton size="small" tone="critical">
              [T] В КОРЗИНУ
            </TerminalButton>
          }
          title="ПЕРЕМЕСТИТЬ МАТЕРИАЛ В КОРЗИНУ?"
          description="Материал уйдёт в корзину группы. До полного удаления его можно восстановить из вкладки КОРЗИНА."
          confirmLabel="[T] В КОРЗИНУ"
          onConfirm={() => void trash()}
        />
      </div>
      <label className="material-lifecycle-panel__field">
        <span>НОВАЯ ВЕРСИЯ</span>
        <TerminalInput
          type="file"
          disabled={uploadingVersion}
          aria-label="Загрузить новую версию материала"
          onChange={(event) => {
            void uploadVersion(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
      </label>
      {versionProgress ? (
        <p className="material-lifecycle-panel__progress">
          {versionProgress.phase.toUpperCase()} / {versionProgress.fileName}
        </p>
      ) : null}
      {status.length > 0 ? (
        <p className="material-lifecycle-panel__status" role="status">
          {status}
        </p>
      ) : null}
      <div className="material-lifecycle-panel__versions">
        <span>ВЕРСИИ / {versions.length}</span>
        {versions.length === 0 ? (
          <EmptyState>ИСТОРИЯ ВЕРСИЙ ОТСУТСТВУЕТ</EmptyState>
        ) : (
          <ul>
            {versions.map((version) => (
              <li key={version.versionId}>
                <strong>#{version.sequence}</strong>
                <span>{version.originalFileName || material.displayName}</span>
                <small>
                  {formatBytes(version.byteSize)} /{' '}
                  {version.createdAt
                    ? dateTimeFormat(stampParts).format(new Date(version.createdAt))
                    : '—'}
                </small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function messageFromLifecycleError(error: unknown): string {
  if (error instanceof Error) return `ОШИБКА: ${error.message}`;
  return 'ОШИБКА: НЕИЗВЕСТНАЯ ОШИБКА ОПЕРАЦИИ';
}
