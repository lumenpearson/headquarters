import type {
  AssetDefinition,
  AssetId,
  AssetLocation,
  AppSnapshot,
  PreloadResult,
  SceneDefinition,
  SceneId,
  SceneMetadata,
} from '@gremuchaya/domain';

export interface SceneRepositoryPort {
  listMetadata(): readonly SceneMetadata[];
  getById(sceneId: SceneId): Promise<SceneDefinition | null>;
}

export interface AssetResolverPort {
  resolve(assetId: AssetId): Promise<AssetLocation | null>;
  getDefinition(assetId: AssetId): AssetDefinition | null;
  preload(assetIds: readonly AssetId[], signal?: AbortSignal): Promise<PreloadResult>;
}

export interface SnapshotPersistencePort {
  list(): Promise<readonly AppSnapshot[]>;
  save(snapshot: AppSnapshot): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface SchedulerPort {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
