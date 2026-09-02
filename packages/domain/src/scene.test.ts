import { describe, expect, it } from 'vitest';

import { createSceneId } from './ids.js';
import {
  countSceneMissingLocalizedText,
  sceneLocalizedTextValues,
  type SceneDefinition,
} from './scene.js';

function buildScene(overrides: Partial<SceneDefinition> = {}): SceneDefinition {
  return {
    id: createSceneId('s02-44'),
    episode: 2,
    scene: '44',
    shootDate: '2026-09-13',
    title: 'Липатов на мосту',
    location: 'HQ',
    sourceLevel: 'kpp',
    description: 'Красная точка проходит мост.',
    screens: {},
    cues: [
      { id: 'map', label: 'Показать карту', action: { type: 'SET_BLACKOUT', enabled: true } },
      { id: 'end', label: { ru: 'Конец', en: 'End' }, action: { type: 'FREEZE', enabled: false } },
    ],
    requiredScreens: [],
    optionalScreens: [],
    requiredAssetIds: [],
    optionalAssetIds: [],
    notes: ['Заметка для оператора'],
    ...overrides,
  };
}

describe('sceneLocalizedTextValues', () => {
  it('collects title, description, notes and cue labels in a fixed order', () => {
    const scene = buildScene();
    expect(sceneLocalizedTextValues(scene)).toEqual([
      'Липатов на мосту',
      'Красная точка проходит мост.',
      'Заметка для оператора',
      'Показать карту',
      { ru: 'Конец', en: 'End' },
    ]);
  });
});

describe('countSceneMissingLocalizedText', () => {
  it('counts every value still missing the requested locale', () => {
    const scene = buildScene();
    // title, description, the note and the bare-string cue label are all
    // unmarked prose -- four values missing 'en'; the fifth cue label
    // already carries an 'en' key.
    expect(countSceneMissingLocalizedText(scene, 'en', 'ru')).toBe(4);
    expect(countSceneMissingLocalizedText(scene, 'ru', 'ru')).toBe(0);
  });

  it('reports zero once every value carries the requested locale', () => {
    const scene = buildScene({
      title: { ru: 'Липатов на мосту', en: 'Lipatov on the bridge' },
      description: { ru: 'Красная точка проходит мост.', en: 'The red dot crosses the bridge.' },
      notes: [{ ru: 'Заметка для оператора', en: 'Note for the operator' }],
      cues: [
        {
          id: 'map',
          label: { ru: 'Показать карту', en: 'Show the map' },
          action: { type: 'SET_BLACKOUT', enabled: true },
        },
      ],
    });
    expect(countSceneMissingLocalizedText(scene, 'en', 'ru')).toBe(0);
  });
});
