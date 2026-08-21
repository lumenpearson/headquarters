import {
  createAssetId,
  createSceneId,
  type AssetDefinition,
  type SceneDefinition,
} from '@gremuchaya/domain';

export const testMapAsset: AssetDefinition = {
  id: createAssetId('map-test-grid'),
  type: 'map',
  status: 'placeholder',
  location: { kind: 'static', url: '/assets/placeholders/map.svg' },
  expectedMimeType: 'image/svg+xml',
};

export const testScene: SceneDefinition = {
  id: createSceneId('s99-01'),
  episode: 99,
  scene: '1',
  shootDate: '2026-09-01',
  title: 'Тестовая сцена',
  location: 'HQ',
  sourceLevel: 'derived',
  description: 'Детерминированная fixture для unit и integration тестов.',
  screens: {
    'hwan-map': {
      module: 'map',
      payload: {
        mapAsset: 'map-test-grid',
        title: 'ТЕСТОВЫЙ КОНТУР',
        markers: [],
      },
    },
  },
  cues: [
    {
      id: 'show-map',
      label: 'Показать карту',
      action: {
        type: 'SET_MODULE',
        screenId: 'hwan-map',
        module: 'map',
        payload: {
          mapAsset: 'map-test-grid',
          title: 'ТЕСТОВЫЙ КОНТУР',
          markers: [],
        },
      },
    },
  ],
  requiredScreens: ['hwan-map'],
  optionalScreens: [],
  requiredAssetIds: [createAssetId('map-test-grid')],
  optionalAssetIds: [],
  notes: [],
};
