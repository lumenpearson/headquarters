import {
  createInitialScreenState,
  type screenIds,
  type CueAction,
  type ModulePreset,
  type SceneDefinition,
  type ScreenId,
  type ScreenState,
} from '@gremuchaya/domain';

import type { RuntimeState } from './runtimeState';

export function initializeSceneState(state: RuntimeState, scene: SceneDefinition): RuntimeState {
  const screens = mapScreens((_screen, screenId) => {
    const initial = createInitialScreenState(screenId);
    const preset = scene.screens[screenId];
    return preset === undefined ? initial : applyModulePreset(initial, preset);
  });

  return {
    ...state,
    scene: {
      activeSceneId: scene.id,
      activeCueIndex: -1,
      status: 'ready',
      preload: { ready: 0, total: scene.requiredAssetIds.length, failed: 0 },
      preflight: null,
    },
    screens: { byId: screens },
    operator: {
      ...state.operator,
      note: '',
    },
  };
}

export function applyCueAction(state: RuntimeState, action: CueAction): RuntimeState {
  switch (action.type) {
    case 'SET_MODULE':
      return updateScreen(state, action.screenId, (screen) =>
        screen.frozen
          ? screen
          : {
              ...screen,
              module: action.module,
              payload: action.payload,
              blackout: false,
              standby: false,
              revision: screen.revision + 1,
            },
      );
    case 'PATCH_MODULE':
      return updateScreen(state, action.screenId, (screen) =>
        screen.frozen
          ? screen
          : {
              ...screen,
              payload: { ...screen.payload, ...action.payload },
              revision: screen.revision + 1,
            },
      );
    case 'PLAY_MEDIA':
      return updateScreen(state, action.screenId, (screen) =>
        screen.frozen
          ? screen
          : {
              ...screen,
              payload: {
                ...screen.payload,
                assetId: action.assetId,
                playing: true,
                loop: action.loop,
              },
              revision: screen.revision + 1,
            },
      );
    case 'PAUSE_MEDIA':
      return updateScreen(state, action.screenId, (screen) => ({
        ...screen,
        payload: { ...screen.payload, playing: false },
        revision: screen.revision + 1,
      }));
    case 'SET_WALL_PRESET':
      return { ...state, operator: { ...state.operator, wallPreset: action.wallId } };
    case 'SET_BLACKOUT':
      return updateTargetScreens(state, action.screenId, (screen) => ({
        ...screen,
        blackout: action.enabled,
        standby: action.enabled ? false : screen.standby,
        revision: screen.revision + 1,
      }));
    case 'SET_STANDBY':
      return updateTargetScreens(state, action.screenId, (screen) => ({
        ...screen,
        standby: action.enabled,
        blackout: action.enabled ? false : screen.blackout,
        revision: screen.revision + 1,
      }));
    case 'SHOW_GLITCH':
      return updateScreen(state, action.screenId, (screen) => ({
        ...screen,
        glitch: action.strength,
        revision: screen.revision + 1,
      }));
    case 'FREEZE':
      return updateTargetScreens(state, action.screenId, (screen) => ({
        ...screen,
        frozen: action.enabled,
        revision: screen.revision + 1,
      }));
    case 'SET_OPERATOR_NOTE':
      return { ...state, operator: { ...state.operator, note: action.text } };
    case 'EXPLORER_NAVIGATE':
      return {
        ...state,
        explorer: { ...state.explorer, activePath: action.path, selectedNodeId: null },
        workspace: { ...state.workspace, activeSection: 'files' },
      };
    case 'EXPLORER_OPEN':
      return { ...state, explorer: { ...state.explorer, selectedNodeId: action.nodeId } };
    case 'WORKSPACE_FOCUS':
      return { ...state, workspace: { ...state.workspace, activeDocumentId: action.documentId } };
    case 'APPLY_INFORMATION_PRESET':
      return updateScreen(state, action.screenId, (screen) => ({
        ...screen,
        payload: { ...screen.payload, presetId: action.presetId },
        revision: screen.revision + 1,
      }));
    case 'SEND_DOCUMENT_TO_SCREEN':
      return updateScreen(state, action.screenId, (screen) => ({
        ...screen,
        module: 'explorer',
        payload: { documentId: action.documentId, takeover: true },
        blackout: false,
        standby: false,
        revision: screen.revision + 1,
      }));
  }
}

function applyModulePreset(screen: ScreenState, preset: ModulePreset): ScreenState {
  return {
    ...screen,
    module: preset.module,
    payload: preset.payload,
    revision: screen.revision + 1,
  };
}

function updateTargetScreens(
  state: RuntimeState,
  screenId: ScreenId | undefined,
  update: (screen: ScreenState) => ScreenState,
): RuntimeState {
  if (screenId !== undefined) {
    return updateScreen(state, screenId, update);
  }

  return {
    ...state,
    screens: { byId: mapScreens(update, state.screens.byId) },
  };
}

function updateScreen(
  state: RuntimeState,
  screenId: ScreenId,
  update: (screen: ScreenState) => ScreenState,
): RuntimeState {
  return {
    ...state,
    screens: {
      byId: {
        ...state.screens.byId,
        [screenId]: update(state.screens.byId[screenId]),
      },
    },
  };
}

function mapScreens(
  update: (screen: ScreenState, screenId: ScreenId) => ScreenState,
  screens?: Readonly<Record<ScreenId, ScreenState>>,
): Record<ScreenId, ScreenState> {
  const current = screens ?? createEmptyScreens();
  return {
    'hwan-main': update(current['hwan-main'], 'hwan-main'),
    'hwan-map': update(current['hwan-map'], 'hwan-map'),
    'hwan-comms': update(current['hwan-comms'], 'hwan-comms'),
    'wall-center': update(current['wall-center'], 'wall-center'),
    'wall-left': update(current['wall-left'], 'wall-left'),
    'wall-right': update(current['wall-right'], 'wall-right'),
    'kirillov-desk': update(current['kirillov-desk'], 'kirillov-desk'),
    'interrogation-video': update(current['interrogation-video'], 'interrogation-video'),
    'interrogation-audio': update(current['interrogation-audio'], 'interrogation-audio'),
  } satisfies Record<(typeof screenIds)[number], ScreenState>;
}

function createEmptyScreens(): Record<ScreenId, ScreenState> {
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
  };
}
