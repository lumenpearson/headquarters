import { describe, expect, it } from 'vitest';

import { parseSceneDefinition, sceneDefinitionSchema } from './sceneSchemas.js';

const validScene = {
  id: 's02-44',
  episode: 2,
  scene: '44',
  shootDate: '2026-09-13',
  title: 'Липатов на мосту',
  location: 'HQ',
  sourceLevel: 'kpp',
  description: 'Красная точка проходит мост, затем включается оптический канал.',
  screens: {
    'hwan-map': {
      module: 'map',
      payload: {
        mapAsset: 'map-pedestrian-bridge',
        title: 'СОПРОВОЖДЕНИЕ ОБЪЕКТА',
        markers: [],
      },
    },
  },
  cues: [
    {
      id: 'map',
      label: 'Показать карту',
      action: {
        type: 'SET_MODULE',
        screenId: 'hwan-map',
        module: 'map',
        payload: {
          mapAsset: 'map-pedestrian-bridge',
          title: 'СОПРОВОЖДЕНИЕ ОБЪЕКТА',
          markers: [],
        },
      },
    },
  ],
  requiredScreens: ['hwan-map'],
  optionalScreens: [],
  requiredAssetIds: ['map-pedestrian-bridge'],
  optionalAssetIds: [],
  notes: [],
};

describe('scene schema', () => {
  it('parses a strict scene boundary into branded domain identifiers', () => {
    const scene = parseSceneDefinition(validScene);
    expect(scene.id).toBe('s02-44');
    expect(scene.requiredAssetIds).toEqual(['map-pedestrian-bridge']);
  });

  it('rejects a module payload that does not match its module schema', () => {
    const result = sceneDefinitionSchema.safeParse({
      ...validScene,
      screens: {
        'hwan-map': { module: 'map', payload: { title: 'Нет карты', markers: [] } },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate cue ids', () => {
    const result = sceneDefinitionSchema.safeParse({
      ...validScene,
      cues: [validScene.cues[0], validScene.cues[0]],
    });
    expect(result.success).toBe(false);
  });
});
