import { getSettingDefinition } from '@gremuchaya/settings-schema';

import { t } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import type { MaterialImportProgress } from '@/infrastructure/materials/BridgeMaterialClient';

/**
 * `materials.defaultCategory`'s own twelve values, named here rather than
 * read back out of the schema's `oneOf` list: the table below is keyed by
 * this union, so a category the schema gains with no matching entry here is a
 * compile error instead of a picker that falls back to shouting the raw
 * identifier at the operator.
 */
const materialCategories = [
  'video',
  'camera',
  'photo',
  'audio',
  'document',
  'map',
  'intercept',
  'dossier',
  'report',
  'archive',
  'technical',
  'other',
] as const;

type MaterialCategory = (typeof materialCategories)[number];

function isMaterialCategory(value: string): value is MaterialCategory {
  return (materialCategories as readonly string[]).includes(value);
}

const materialCategoryMessageIds: Readonly<Record<MaterialCategory, MessageId>> = {
  video: 'materialCategory.video',
  camera: 'materialCategory.camera',
  photo: 'materialCategory.photo',
  audio: 'materialCategory.audio',
  document: 'materialCategory.document',
  map: 'materialCategory.map',
  intercept: 'materialCategory.intercept',
  dossier: 'materialCategory.dossier',
  report: 'materialCategory.report',
  archive: 'materialCategory.archive',
  technical: 'materialCategory.technical',
  other: 'materialCategory.other',
};

/**
 * The operator's reading of one `materials.defaultCategory` enum value, in
 * the locale now in force.
 *
 * Falls back to the bare identifier for a value the schema serves that this
 * table does not yet name -- the same defensive fallback the picker below
 * always had, kept for a category added to the schema before its Russian
 * label is written, rather than widened into a hole `CatalogEntry` could
 * catch: the schema's own enum values are read at runtime, not typed as this
 * module's union, so nothing here can promise the two never drift apart.
 */
export function materialCategoryLabel(value: string): string {
  return isMaterialCategory(value) ? t(materialCategoryMessageIds[value]) : value.toUpperCase();
}

/*
 * The categories a picker offers are the ones the definition itself allows,
 * not a second list of the same twelve names. A category added to the schema
 * would otherwise be selectable in the settings catalogue and missing from a
 * dialog that is supposed to honour it; this way it appears at once, under its
 * identifier until someone gives it a message.
 *
 * A function rather than a value computed once at import time: the label has
 * to follow `localization.locale`, and nothing re-evaluates a module-level
 * `const` when the operator switches it. Shared between the import dialog and
 * the material lifecycle panel, which both offer the same choice at two
 * different moments -- what a new file is, and what an existing one becomes --
 * and both call this once per render, the same way a `Record<Union,
 * MessageId>` table's own reader is called.
 */
export function materialCategoryOptions(): ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> {
  const editor = getSettingDefinition('materials.defaultCategory')?.editor;
  const values = editor?.kind === 'enum' ? editor.options : [];
  return values.map((value) => ({ value, label: materialCategoryLabel(value) }));
}

const importPhaseMessageIds: Readonly<Record<MaterialImportProgress['phase'], MessageId>> = {
  starting: 'media.importPhase.starting',
  hashing: 'media.importPhase.hashing',
  uploading: 'media.importPhase.uploading',
  verifying: 'media.importPhase.verifying',
  completed: 'media.importPhase.completed',
};

/**
 * The operator's reading of one `MaterialImportProgress['phase']` value, in
 * the locale now in force.
 *
 * Shared between `FilesScreen.tsx`'s import dialog and
 * `MaterialLifecyclePanel.tsx`'s version upload, which both drove this
 * five-phase progress readout with `phase.toUpperCase()` -- the union's own
 * English spelling, unconditionally, however `localization.locale` was set.
 */
export function importPhaseLabel(phase: MaterialImportProgress['phase']): string {
  return t(importPhaseMessageIds[phase]);
}
