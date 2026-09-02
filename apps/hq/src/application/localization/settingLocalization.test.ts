import {
  getSettingDefinition,
  settingsDefinitions,
  type SettingDefinition,
} from '@gremuchaya/settings-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '@/state/operationsStore';

import { settingLabelMessages } from './catalog/settingLabelMessages';
import { settingOptionMessages } from './catalog/settingOptionMessages';
import { settingsMessages } from './catalog/settingsMessages';
import {
  localizedEnumOptionLabel,
  localizedSettingDescription,
  localizedSettingLabel,
  localizedSettingScope,
} from './settingLocalization';

function definitionOrThrow(id: string) {
  const definition = getSettingDefinition(id);
  if (definition === undefined) throw new Error(`${id} is not declared`);
  return definition;
}

/**
 * An id no schema will ever declare, standing in for "a definition this pass
 * has not caught up with" now that every real one is covered. Shaped as a
 * `SettingDefinition` by hand rather than fetched through
 * `getSettingDefinition`, the way `messages.test.ts` hands `resolveFromTables`
 * a small object literal instead of the real catalogue: it proves the
 * fallback path without needing a real definition that stays permanently
 * untranslated.
 */
const uncoveredDefinition: SettingDefinition = {
  id: 'fixture.neverCatalogued',
  category: 'advanced',
  defaultValue: true,
  scope: 'device',
  description: 'A fixture id, kept out of every catalogue module on purpose.',
  editor: { kind: 'enum', options: ['alpha', 'beta'] },
  validate: (value): value is boolean => typeof value === 'boolean',
};

describe('setting label localization', () => {
  it('translates a label this pass authored, in settingLabelMessages', () => {
    // Checked against the catalogue module directly rather than through
    // `localizedSettingLabel`: `settingLabelMessages.ts` carries no already-
    // wired id (every `settingLabel.*` entry is new), and `catalog/index.ts`
    // is out of this pass's scope, so `messagesFor` cannot see it yet -- the
    // module doc above explains why. The lookup itself is exercised by the
    // fallback test below and by `settingsMessages.ts`'s already-wired ids in
    // the description tests.
    expect(settingLabelMessages['settingLabel.diagnostics.verbosity']).toEqual({
      ru: 'ПОДРОБНОСТЬ ДИАГНОСТИКИ',
      en: 'DIAGNOSTIC VERBOSITY',
    });
  });

  it('falls back to the id-surgery reading for a definition no table covers', () => {
    expect(localizedSettingLabel(uncoveredDefinition, 'ru')).toBe('FIXTURE / NEVER CATALOGUED');
  });
});

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

  it('falls back to the schema English for a definition no table covers', () => {
    // The bracketed `⟦…⟧` marker is the main catalogue's designed behaviour
    // for a truly missing id; leaving the schema's own words standing is this
    // lookup's, for the same reason `localizedSettingLabel` keeps its own
    // fallback -- a definition with no translated line should read as
    // English, not as a marker that suggests the build is broken.
    expect(localizedSettingDescription(uncoveredDefinition, 'ru')).toBe(
      uncoveredDefinition.description,
    );
    expect(localizedSettingDescription(uncoveredDefinition, 'ru')).not.toMatch(/^⟦/u);
  });
});

describe('setting scope localization', () => {
  it('translates device and group', () => {
    expect(settingLabelMessages['settingScope.device']).toEqual({ ru: 'УСТРОЙСТВО', en: 'DEVICE' });
    expect(settingLabelMessages['settingScope.group']).toEqual({ ru: 'ГРУППА', en: 'GROUP' });
  });

  it('draws the scope word from the catalogue in each locale', () => {
    expect(localizedSettingScope('device', 'ru')).toBe('УСТРОЙСТВО');
    expect(localizedSettingScope('group', 'ru')).toBe('ГРУППА');
    expect(localizedSettingScope('device', 'en')).toBe('DEVICE');
    expect(localizedSettingScope('group', 'en')).toBe('GROUP');
  });

  it('still falls back to the bare word uppercased for a scope the catalogue does not carry', () => {
    // Both real scopes are catalogued, so the fallback is unreachable through
    // the type. It is asserted through a cast rather than by removing an entry
    // to reach it: the branch exists for a scope added to the schema before
    // its message is written, and that operator should read `PROJECT`, not an
    // empty cell.
    const unlisted = 'project' as Parameters<typeof localizedSettingScope>[0];
    expect(localizedSettingScope(unlisted, 'ru')).toBe('PROJECT');
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

  it('translates a representative option this pass authored, in settingOptionMessages', () => {
    expect(settingOptionMessages['settingOption.colors.accent.green']).toEqual({
      ru: 'ЗЕЛЁНЫЙ',
      en: 'GREEN',
    });
  });

  it('keeps a resolution, an aspect ratio and a playback rate as the uppercase fallback', () => {
    // Numbers and ratios read the same in every locale -- translating one into
    // a word was the one thing this pass was told not to do.
    const resolution = definitionOrThrow('performance.webcamResolution');
    if (resolution.editor.kind !== 'enum')
      throw new Error('performance.webcamResolution is not an enum');
    expect(localizedEnumOptionLabel(resolution, '1080p', 'ru')).toBe('1080P');

    const rate = definitionOrThrow('player.defaultRate');
    if (rate.editor.kind !== 'enum') throw new Error('player.defaultRate is not an enum');
    expect(localizedEnumOptionLabel(rate, '1.5', 'ru')).toBe('1.5');
  });

  it('uppercases the bare option for an enum setting no table covers', () => {
    expect(localizedEnumOptionLabel(uncoveredDefinition, 'alpha', 'ru')).toBe('ALPHA');
  });
});

/**
 * The totality this pass exists to deliver: every one of the 169 definitions
 * `packages/settings-schema` currently declares gets a label, a description
 * and -- where it is an enum -- a message for every option that is not one of
 * the eleven locale-independent values.
 *
 * Driven off `settingsDefinitions` itself rather than a fixture list, so a
 * definition added later without a translated line fails this test even
 * though `SettingId`'s own compile-time check (`settingLabelIds` and
 * `settingDescriptionIds` in `settingLocalization.ts`) already catches the
 * label and the description; the option table has no such static guarantee
 * (`SettingEditor.options` is a plain `readonly string[]`), so this is the
 * only thing that proves it.
 */
describe('setting catalogue totality', () => {
  // Two kinds of option read the same in every locale and so carry no entry:
  // a number or a ratio, and a proper noun. Translating either would put one
  // spelling in the table twice and claim a translation that does not exist.
  const localeIndependentOptions = new Set([
    'styles.iconSet.lucide',
    'styles.iconSet.hugeicons',
    'styles.iconSet.tabler',
    'performance.webcamResolution.1080p',
    'performance.webcamResolution.720p',
    'performance.webcamResolution.480p',
    'cameras.gridDensity.3x4',
    'cameras.gridDensity.3x3',
    'cameras.gridDensity.2x2',
    'player.defaultRate.0.5',
    'player.defaultRate.1',
    'player.defaultRate.1.5',
    'player.defaultRate.2',
    'dateTime.mode.utc',
  ]);

  it('gives every definition a label', () => {
    const missing = settingsDefinitions
      .map((definition) => definition.id)
      .filter((id) => !(`settingLabel.${id}` in settingLabelMessages));

    expect(missing).toEqual([]);
  });

  it('gives every definition exactly one description, never two', () => {
    const missing: string[] = [];
    const duplicated: string[] = [];
    for (const definition of settingsDefinitions) {
      const id = `settingDescription.${definition.id}`;
      const inLabelMessages = id in settingLabelMessages;
      const inSettingsMessages = id in settingsMessages;
      if (!inLabelMessages && !inSettingsMessages) missing.push(definition.id);
      if (inLabelMessages && inSettingsMessages) duplicated.push(definition.id);
    }

    expect(missing).toEqual([]);
    expect(duplicated).toEqual([]);
  });

  it('gives every enum option a message, unless it is locale-independent or tiles.presentation', () => {
    const unresolved: string[] = [];
    for (const definition of settingsDefinitions) {
      if (definition.editor.kind !== 'enum') continue;
      // `tiles.presentation` is drawn through `tilePresentationLabel`
      // (`tileLabels.ts`/`tileMessages.ts`), not a `settingOption.*` entry.
      if (definition.id === 'tiles.presentation') continue;
      for (const option of definition.editor.options) {
        const optionId = `${definition.id}.${option}`;
        if (localeIndependentOptions.has(optionId)) continue;
        const id = `settingOption.${optionId}`;
        const inOptionMessages = id in settingOptionMessages;
        const inSettingsMessages = id in settingsMessages;
        if (!inOptionMessages && !inSettingsMessages) unresolved.push(optionId);
      }
    }

    expect(unresolved).toEqual([]);
  });
});
