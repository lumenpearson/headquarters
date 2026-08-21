import {
  createInitialScreenState,
  createSceneId,
  type screenIds,
  type ScreenId,
  type ScreenState,
} from '@gremuchaya/domain';
import { describe, expect, it } from 'vitest';

import { createInitialRuntimeState } from './runtimeState';
import { applyCueAction, initializeSceneState } from './sceneState';

describe('scene application state', () => {
  it('initializes every screen and applies only configured scene presets', () => {
    const runtime = createInitialRuntimeState(createScreens());
    const initialized = initializeSceneState(runtime, {
      id: createSceneId('s02-44'),
      episode: 2,
      scene: '44',
      shootDate: '2026-09-13',
      title: 'Мост',
      location: 'HQ',
      sourceLevel: 'kpp',
      description: 'Тест загрузки состояния.',
      screens: {
        'hwan-map': { module: 'map', payload: { title: 'МАРШРУТ', markers: [] } },
      },
      cues: [],
      requiredScreens: ['hwan-map'],
      optionalScreens: [],
      requiredAssetIds: [],
      optionalAssetIds: [],
      notes: [],
    });

    expect(initialized.screens.byId['hwan-map'].module).toBe('map');
    expect(initialized.screens.byId['wall-center'].module).toBe('idle');
    expect(initialized.scene.activeCueIndex).toBe(-1);
  });

  it('keeps frozen story screens unchanged while blackout remains immediate', () => {
    const runtime = createInitialRuntimeState(createScreens());
    const frozen = applyCueAction(runtime, { type: 'FREEZE', screenId: 'hwan-map', enabled: true });
    const ignored = applyCueAction(frozen, {
      type: 'SET_MODULE',
      screenId: 'hwan-map',
      module: 'satellite',
      payload: { mode: 'TRACK' },
    });
    const blackedOut = applyCueAction(ignored, {
      type: 'SET_BLACKOUT',
      screenId: 'hwan-map',
      enabled: true,
    });

    expect(ignored.screens.byId['hwan-map'].module).toBe('idle');
    expect(blackedOut.screens.byId['hwan-map'].blackout).toBe(true);
  });

  it('merges a patch without replacing unrelated module payload fields', () => {
    const runtime = createInitialRuntimeState(createScreens());
    const initial = applyCueAction(runtime, {
      type: 'SET_MODULE',
      screenId: 'hwan-comms',
      module: 'comms',
      payload: { target: 'РОГОЖИН', status: 'RINGING' },
    });
    const connected = applyCueAction(initial, {
      type: 'PATCH_MODULE',
      screenId: 'hwan-comms',
      payload: { status: 'CONNECTED' },
    });

    expect(connected.screens.byId['hwan-comms'].payload).toEqual({
      target: 'РОГОЖИН',
      status: 'CONNECTED',
    });
  });
});

function createScreens(): Record<ScreenId, ScreenState> {
  const create = (screenId: ScreenId) => createInitialScreenState(screenId);
  return {
    'hwan-main': create('hwan-main'),
    'hwan-map': create('hwan-map'),
    'hwan-comms': create('hwan-comms'),
    'wall-center': create('wall-center'),
    'wall-left': create('wall-left'),
    'wall-right': create('wall-right'),
    'kirillov-desk': create('kirillov-desk'),
    'interrogation-video': create('interrogation-video'),
    'interrogation-audio': create('interrogation-audio'),
  } satisfies Record<(typeof screenIds)[number], ScreenState>;
}
