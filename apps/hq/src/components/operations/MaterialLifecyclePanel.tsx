'use client';

import { useEffect, useState } from 'react';
import {
  TerminalAlertDialog,
  TerminalButton,
  TerminalInput,
  TerminalSelect,
} from '@gremuchaya/ui/primitives';

import { dateTimeFormat } from '@/application/localization/intl';
import { useTranslate } from '@/application/localization/locale';
import { formatBytes } from '@/application/materials/importedMaterials';
import {
  importPhaseLabel,
  materialCategoryOptions,
} from '@/application/materials/materialCategories';
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
  const translate = useTranslate();
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
      setStatus(translate('materialLifecycle.metadataUpdated'));
    } catch (error: unknown) {
      setStatus(messageFromLifecycleError(translate, error));
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
      setStatus(translate('materialLifecycle.versionUploaded'));
    } catch (error: unknown) {
      setStatus(messageFromLifecycleError(translate, error));
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
      setStatus(messageFromLifecycleError(translate, error));
    }
  };

  return (
    <div className="material-lifecycle-panel">
      <header>
        <span>
          {translate('materialLifecycle.header', { id: material.materialId.slice(0, 8) })}
        </span>
      </header>
      <label className="material-lifecycle-panel__field">
        <span>{translate('field.name')}</span>
        <TerminalInput
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          aria-label={translate('materialLifecycle.nameInputLabel')}
          disabled={saving}
        />
      </label>
      <label className="material-lifecycle-panel__field">
        <span>{translate('field.category')}</span>
        <TerminalSelect
          value={chosenCategory}
          options={materialCategoryOptions()}
          onValueChange={setChosenCategory}
          label={translate('materialLifecycle.categorySelectLabel')}
          disabled={saving}
        />
      </label>
      <div className="material-lifecycle-panel__actions">
        <TerminalButton size="small" onClick={() => void saveMetadata()} disabled={saving}>
          {translate('materialLifecycle.saveButton')}
        </TerminalButton>
        <TerminalAlertDialog
          trigger={
            <TerminalButton size="small" tone="critical">
              {translate('materialLifecycle.trashButton')}
            </TerminalButton>
          }
          title={translate('materialLifecycle.trashConfirmTitle')}
          description={translate('materialLifecycle.trashConfirmDescription')}
          confirmLabel={translate('materialLifecycle.trashButton')}
          onConfirm={() => void trash()}
        />
      </div>
      <label className="material-lifecycle-panel__field">
        <span>{translate('materialLifecycle.newVersionFieldLabel')}</span>
        <TerminalInput
          type="file"
          disabled={uploadingVersion}
          aria-label={translate('materialLifecycle.uploadVersionLabel')}
          onChange={(event) => {
            void uploadVersion(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
      </label>
      {versionProgress ? (
        <p className="material-lifecycle-panel__progress">
          {importPhaseLabel(versionProgress.phase)} / {versionProgress.fileName}
        </p>
      ) : null}
      {status.length > 0 ? (
        <p className="material-lifecycle-panel__status" role="status">
          {status}
        </p>
      ) : null}
      <div className="material-lifecycle-panel__versions">
        <span>{translate('materialLifecycle.versionsHeader', { count: versions.length })}</span>
        {versions.length === 0 ? (
          <EmptyState>{translate('materialLifecycle.noVersions')}</EmptyState>
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

function messageFromLifecycleError(
  translate: ReturnType<typeof useTranslate>,
  error: unknown,
): string {
  if (error instanceof Error)
    return translate('materialLifecycle.errorPrefix', { message: error.message });
  return translate('materialLifecycle.errorPrefix', {
    message: translate('materialLifecycle.unknownError'),
  });
}
