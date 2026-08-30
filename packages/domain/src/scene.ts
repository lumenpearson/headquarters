import type { AssetId, ModuleId, SceneId, ScreenId } from './ids.js';
import { countMissingLocalizedText, type LocaleTag, type LocalizedText } from './localizedText.js';
import type { ModulePayload, ModulePreset, ScreenState } from './screen.js';
import type { VirtualPath } from './virtualPath.js';

export type SourceLevel = 'kpp' | 'script' | 'derived';
export type SceneLocation = 'HQ' | 'KIRILLOV' | 'INTERROGATION' | 'OTHER';

export type CueAction =
  | {
      readonly type: 'SET_MODULE';
      readonly screenId: ScreenId;
      readonly module: ModuleId;
      readonly payload: ModulePayload;
    }
  | {
      readonly type: 'PATCH_MODULE';
      readonly screenId: ScreenId;
      readonly payload: ModulePayload;
    }
  | {
      readonly type: 'PLAY_MEDIA';
      readonly screenId: ScreenId;
      readonly assetId: AssetId;
      readonly loop: boolean;
    }
  | { readonly type: 'PAUSE_MEDIA'; readonly screenId: ScreenId }
  | { readonly type: 'SET_WALL_PRESET'; readonly wallId: string }
  | {
      readonly type: 'SET_BLACKOUT';
      readonly screenId?: ScreenId | undefined;
      readonly enabled: boolean;
    }
  | {
      readonly type: 'SET_STANDBY';
      readonly screenId?: ScreenId | undefined;
      readonly enabled: boolean;
    }
  | {
      readonly type: 'SHOW_GLITCH';
      readonly screenId: ScreenId;
      readonly strength: number;
      readonly durationMs: number;
    }
  | { readonly type: 'FREEZE'; readonly screenId?: ScreenId | undefined; readonly enabled: boolean }
  | { readonly type: 'SET_OPERATOR_NOTE'; readonly text: string }
  | { readonly type: 'EXPLORER_NAVIGATE'; readonly path: VirtualPath }
  | { readonly type: 'EXPLORER_OPEN'; readonly nodeId: string }
  | { readonly type: 'WORKSPACE_FOCUS'; readonly documentId: string }
  | {
      readonly type: 'APPLY_INFORMATION_PRESET';
      readonly presetId: string;
      readonly screenId: ScreenId;
    }
  | {
      readonly type: 'SEND_DOCUMENT_TO_SCREEN';
      readonly documentId: string;
      readonly screenId: ScreenId;
    };

export interface SceneCue {
  readonly id: string;
  readonly label: LocalizedText;
  readonly atMs?: number | undefined;
  readonly action: CueAction;
}

export interface SceneDefinition {
  readonly id: SceneId;
  readonly episode: number;
  /**
   * The shooting script's own scene number (`'33'`, `'17/18'`). A slate
   * number, not prose: it reads the same in every locale, so it stays a
   * plain string rather than {@link LocalizedText}.
   */
  readonly scene: string;
  readonly shootDate: string;
  readonly title: LocalizedText;
  readonly location: SceneLocation;
  readonly sourceLevel: SourceLevel;
  readonly description: LocalizedText;
  readonly screens: Readonly<Partial<Record<ScreenId, ModulePreset>>>;
  readonly cues: readonly SceneCue[];
  readonly requiredScreens: readonly ScreenId[];
  readonly optionalScreens: readonly ScreenId[];
  readonly requiredAssetIds: readonly AssetId[];
  readonly optionalAssetIds: readonly AssetId[];
  readonly notes: readonly LocalizedText[];
}

/**
 * Every {@link LocalizedText} value a scene carries, in a fixed order
 * (title, description, notes, then cue labels in cue order) so a caller
 * counting or auditing them gets the same order on every run.
 */
export function sceneLocalizedTextValues(scene: SceneDefinition): readonly LocalizedText[] {
  return [scene.title, scene.description, ...scene.notes, ...scene.cues.map((cue) => cue.label)];
}

/**
 * How many of `scene`'s translatable strings lack `locale`, treating a bare
 * string as already written in `sourceLocale`. The `SceneDefinition`-shaped
 * convenience over {@link countMissingLocalizedText}.
 */
export function countSceneMissingLocalizedText(
  scene: SceneDefinition,
  locale: LocaleTag,
  sourceLocale: LocaleTag,
): number {
  return countMissingLocalizedText(sceneLocalizedTextValues(scene), locale, sourceLocale);
}

export interface SceneMetadata {
  readonly id: SceneId;
  readonly shootDate: string;
  readonly title: string;
  readonly episode: number;
  readonly scene: string;
}

export interface SceneRuntime {
  readonly activeSceneId: SceneId | null;
  readonly activeCueIndex: number;
  readonly status: 'idle' | 'preloading' | 'ready' | 'running' | 'failed';
  readonly startedAt: number | null;
}

export interface ScenePreflight {
  readonly ready: boolean;
  readonly missingAssets: readonly AssetId[];
  readonly offlineScreens: readonly ScreenId[];
  readonly warnings: readonly string[];
}

export interface PreloadResult {
  readonly ready: readonly AssetId[];
  readonly failed: readonly AssetId[];
}

export interface RuntimeSnapshotState {
  readonly activeSceneId: SceneId | null;
  readonly activeCueIndex: number;
  readonly screens: Readonly<Record<ScreenId, ScreenState>>;
  readonly wallPreset: string;
  readonly operatorNote: string;
}
