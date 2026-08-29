import { getSettingDefinition } from '@gremuchaya/settings-schema';

/** The operator's Russian reading of each `materials.defaultCategory` enum value. */
export const materialCategoryLabels: Readonly<Record<string, string>> = {
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
 * The categories a picker offers are the ones the definition itself allows,
 * not a second list of the same twelve names. A category added to the schema
 * would otherwise be selectable in the settings catalogue and missing from a
 * dialog that is supposed to honour it; this way it appears at once, under its
 * identifier until someone gives it a Russian label.
 *
 * Shared between the import dialog and the material lifecycle panel, which
 * both offer the same choice at two different moments -- what a new file is,
 * and what an existing one becomes.
 */
export const materialCategoryOptions: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> = (() => {
  const editor = getSettingDefinition('materials.defaultCategory')?.editor;
  const values = editor?.kind === 'enum' ? editor.options : [];
  return values.map((value) => ({
    value,
    label: materialCategoryLabels[value] ?? value.toUpperCase(),
  }));
})();
