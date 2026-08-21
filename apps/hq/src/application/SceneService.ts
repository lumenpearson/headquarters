import type {
  CueAction,
  RuntimeSnapshotState,
  SceneDefinition,
  SceneId,
  ScenePreflight,
  ScreenBusPort,
} from '@gremuchaya/domain';

import type { AssetResolverPort, SceneRepositoryPort, SchedulerPort } from './ports';
import type { RuntimeState, RuntimeStatePort } from './runtimeState';
import { applyCueAction, initializeSceneState } from './sceneState';

export class SceneService {
  private loadedScene: SceneDefinition | null = null;
  private preloadController: AbortController | null = null;
  private readonly scheduledCueCleanup = new Set<() => void>();

  constructor(
    private readonly scenes: SceneRepositoryPort,
    private readonly assets: AssetResolverPort,
    private readonly state: RuntimeStatePort,
    private readonly bus: ScreenBusPort,
    private readonly scheduler: SchedulerPort,
  ) {}

  async loadScene(sceneId: SceneId): Promise<SceneDefinition> {
    this.cancelScheduledCues();
    this.preloadController?.abort();

    const scene = await this.scenes.getById(sceneId);
    if (scene === null) {
      throw new Error(`Scene not found: ${sceneId}`);
    }

    this.loadedScene = scene;
    const nextState = initializeSceneState(this.state.getSnapshot(), scene);
    this.state.commit(nextState);
    this.bus.publish({ type: 'SCENE_LOADED', state: toRuntimeSnapshot(nextState) });
    return scene;
  }

  async preloadScene(sceneId: SceneId): Promise<void> {
    const scene =
      this.loadedScene?.id === sceneId ? this.loadedScene : await this.scenes.getById(sceneId);
    if (scene === null) {
      throw new Error(`Scene not found: ${sceneId}`);
    }

    this.preloadController?.abort();
    this.preloadController = new AbortController();
    const allAssets = [...scene.requiredAssetIds, ...scene.optionalAssetIds];
    const current = this.state.getSnapshot();
    this.state.commit({
      ...current,
      scene: {
        ...current.scene,
        status: 'preloading',
        preload: { ready: 0, total: allAssets.length, failed: 0 },
      },
    });

    const result = await this.assets.preload(allAssets, this.preloadController.signal);
    const afterPreload = this.state.getSnapshot();
    this.state.commit({
      ...afterPreload,
      scene: {
        ...afterPreload.scene,
        status: result.failed.length === 0 ? 'ready' : 'failed',
        preload: {
          ready: result.ready.length,
          total: allAssets.length,
          failed: result.failed.length,
        },
      },
    });
  }

  async runScenePreflight(): Promise<ScenePreflight> {
    const scene = this.requireLoadedScene();
    const state = this.state.getSnapshot();
    const missingAssets = scene.requiredAssetIds.filter(
      (assetId) => this.assets.getDefinition(assetId)?.status === 'missing',
    );
    const offlineScreens = scene.requiredScreens.filter(
      (screenId) => state.connections.byId[screenId].status === 'offline',
    );
    const warnings = scene.optionalScreens
      .filter((screenId) => state.connections.byId[screenId].status === 'offline')
      .map((screenId) => `Optional screen offline: ${screenId}`);
    const preflight: ScenePreflight = {
      ready: missingAssets.length === 0 && offlineScreens.length === 0,
      missingAssets,
      offlineScreens,
      warnings,
    };
    this.state.commit({ ...state, scene: { ...state.scene, preflight } });
    return preflight;
  }

  executeCue(cueIndex: number): void {
    const scene = this.requireLoadedScene();
    const cue = scene.cues[cueIndex];
    if (cue === undefined) {
      throw new Error(`Cue index ${cueIndex} is outside scene ${scene.id}`);
    }

    const current = this.state.getSnapshot();
    const applied = applyCueAction(current, cue.action);
    const nextState: RuntimeState = {
      ...applied,
      scene: { ...applied.scene, activeCueIndex: cueIndex, status: 'running' },
    };
    this.state.commit(nextState);
    this.bus.publish({ type: 'CUE', action: cue.action, cueIndex });
    this.scheduleTransientCleanup(cue.action);
  }

  nextCue(): void {
    const nextIndex = this.state.getSnapshot().scene.activeCueIndex + 1;
    const scene = this.requireLoadedScene();
    if (nextIndex < scene.cues.length) {
      this.executeCue(nextIndex);
    }
  }

  previousCue(): void {
    const scene = this.requireLoadedScene();
    const targetIndex = Math.max(-1, this.state.getSnapshot().scene.activeCueIndex - 1);
    let rebuilt = initializeSceneState(this.state.getSnapshot(), scene);
    for (let index = 0; index <= targetIndex; index += 1) {
      const cue = scene.cues[index];
      if (cue !== undefined) {
        rebuilt = applyCueAction(rebuilt, cue.action);
      }
    }
    rebuilt = {
      ...rebuilt,
      scene: {
        ...rebuilt.scene,
        activeCueIndex: targetIndex,
        status: targetIndex === -1 ? 'ready' : 'running',
      },
    };
    this.state.commit(rebuilt);
    this.bus.publish({ type: 'RESET', state: toRuntimeSnapshot(rebuilt) });
  }

  resetScene(): void {
    const scene = this.requireLoadedScene();
    this.cancelScheduledCues();
    const nextState = initializeSceneState(this.state.getSnapshot(), scene);
    this.state.commit(nextState);
    this.bus.publish({ type: 'RESET', state: toRuntimeSnapshot(nextState) });
  }

  applyEmergencyBlackout(enabled: boolean): void {
    const nextState = applyCueAction(this.state.getSnapshot(), {
      type: 'SET_BLACKOUT',
      enabled,
    });
    this.state.commit(nextState);
    this.bus.publish({ type: 'BLACKOUT', enabled });
  }

  applyFreeze(enabled: boolean): void {
    const nextState = applyCueAction(this.state.getSnapshot(), { type: 'FREEZE', enabled });
    this.state.commit(nextState);
    this.bus.publish({ type: 'FREEZE', enabled });
  }

  private requireLoadedScene(): SceneDefinition {
    if (this.loadedScene === null) {
      throw new Error('No scene is loaded');
    }
    return this.loadedScene;
  }

  private scheduleTransientCleanup(action: CueAction): void {
    if (action.type !== 'SHOW_GLITCH') {
      return;
    }

    const cancel = this.scheduler.schedule(() => {
      const current = this.state.getSnapshot();
      const screen = current.screens.byId[action.screenId];
      const nextState: RuntimeState = {
        ...current,
        screens: {
          byId: {
            ...current.screens.byId,
            [action.screenId]: { ...screen, glitch: 0, revision: screen.revision + 1 },
          },
        },
      };
      this.state.commit(nextState);
      this.scheduledCueCleanup.delete(cancel);
    }, action.durationMs);
    this.scheduledCueCleanup.add(cancel);
  }

  private cancelScheduledCues(): void {
    for (const cancel of this.scheduledCueCleanup) {
      cancel();
    }
    this.scheduledCueCleanup.clear();
  }
}

function toRuntimeSnapshot(state: RuntimeState): RuntimeSnapshotState {
  return {
    activeSceneId: state.scene.activeSceneId,
    activeCueIndex: state.scene.activeCueIndex,
    screens: state.screens.byId,
    wallPreset: state.operator.wallPreset,
    operatorNote: state.operator.note,
  };
}
