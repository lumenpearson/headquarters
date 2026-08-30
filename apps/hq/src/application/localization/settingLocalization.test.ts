import { getSettingDefinition } from '@gremuchaya/settings-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import { localizedEnumOptionLabel, localizedSettingDescription } from './settingLocalization';

function definitionOrThrow(id: string) {
  const definition = getSettingDefinition(id);
  if (definition === undefined) throw new Error(`${id} is not declared`);
  return definition;
}

describe('setting description localization', () => {
  it('translates a description this pass authored', () => {
    const definition = definitionOrThrow('general.localOnly');

    expect(localizedSettingDescription(definition, 'ru')).toBe(
      'Клиент остаётся работоспособным без группы.',
    );
    expect(localizedSettingDescription(definition, 'en')).toBe(
      'Keep this client usable without a group.',
    );
  });

  it('translates popups.overlayBlur', () => {
    const definition = definitionOrThrow('popups.overlayBlur');

    expect(localizedSettingDescription(definition, 'ru')).toBe(
      'Размытие фона за диалогом, шторкой или панелью, в пикселях; 0 отключает его.',
    );
    expect(localizedSettingDescription(definition, 'en')).toBe(definition.description);
  });

  it('falls back to the schema English for a definition nobody has translated yet', () => {
    // `styles.cornerLength` carries no `settingDescription.*` entry: this is
    // the documented fallback, not the bracketed missing-id marker the main
    // catalogue would render, because leaving the schema's own words standing
    // is this lookup's designed behaviour for an id it has not covered.
    const definition = definitionOrThrow('styles.cornerLength');

    expect(localizedSettingDescription(definition, 'ru')).toBe(definition.description);
    expect(localizedSettingDescription(definition, 'ru')).not.toMatch(/^⟦/u);
  });
});

describe('setting enum option localization', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('spells dateTime.mode as full words, not the status-line markers', () => {
    const definition = definitionOrThrow('dateTime.mode');
    if (definition.editor.kind !== 'enum') throw new Error('dateTime.mode is not an enum');

    // Full words, deliberately not `dateTimeModeLabel`'s 4-character markers:
    // a dropdown is not paying for characters the way the status line is.
    expect(localizedEnumOptionLabel(definition, 'operation', 'ru')).toBe('ОПЕРАТИВНОЕ');
    expect(localizedEnumOptionLabel(definition, 'system', 'ru')).toBe('СИСТЕМНОЕ');
    expect(localizedEnumOptionLabel(definition, 'utc', 'ru')).toBe('UTC');

    expect(localizedEnumOptionLabel(definition, 'operation', 'en')).toBe('OPERATION');
    // UTC is the uppercase fallback: the same word in every locale.
    expect(localizedEnumOptionLabel(definition, 'utc', 'en')).toBe('UTC');
  });

  it('reuses the tile presentation labels for tiles.presentation', () => {
    const definition = definitionOrThrow('tiles.presentation');
    if (definition.editor.kind !== 'enum') throw new Error('tiles.presentation is not an enum');

    expect(localizedEnumOptionLabel(definition, 'auto', 'ru')).toBe('КАК У ГРУППЫ');
    expect(localizedEnumOptionLabel(definition, 'compact', 'ru')).toBe('КОМПАКТНЫЙ ВИД');
  });

  it('uppercases the bare option for an enum setting no table covers', () => {
    const definition = definitionOrThrow('layout.density');
    if (definition.editor.kind !== 'enum') throw new Error('layout.density is not an enum');

    expect(localizedEnumOptionLabel(definition, 'mainframe', 'ru')).toBe('MAINFRAME');
  });
});
