import { createSceneId, type SceneDefinition, type SceneId } from '@gremuchaya/domain';

import { sceneMetadata } from './metadata';

type SceneGroupLoader = () => Promise<readonly SceneDefinition[]>;

const groupLoaders = {
  early: async () => (await import('./september09to12')).september09to12Scenes,
  september13: async () => (await import('./september13')).september13Scenes,
  september14: async () => (await import('./september14')).september14Scenes,
  late: async () => (await import('./september15to19')).september15to19Scenes,
} as const satisfies Readonly<Record<string, SceneGroupLoader>>;

function groupForDate(shootDate: string): keyof typeof groupLoaders {
  if (shootDate <= '2026-09-12') return 'early';
  if (shootDate === '2026-09-13') return 'september13';
  if (shootDate === '2026-09-14') return 'september14';
  return 'late';
}

export class SceneRepository {
  readonly metadata = sceneMetadata;
  readonly #cache = new Map<keyof typeof groupLoaders, Promise<readonly SceneDefinition[]>>();

  async find(sceneId: SceneId | string): Promise<SceneDefinition | null> {
    const normalizedSceneId = createSceneId(sceneId);
    const metadata = this.metadata.find((candidate) => candidate.id === normalizedSceneId);
    if (metadata === undefined) return null;
    const scenes = await this.#loadGroup(groupForDate(metadata.shootDate));
    return scenes.find((candidate) => candidate.id === normalizedSceneId) ?? null;
  }

  listMetadata() {
    return this.metadata;
  }

  getById(sceneId: SceneId): Promise<SceneDefinition | null> {
    return this.find(sceneId);
  }

  async all(): Promise<readonly SceneDefinition[]> {
    const groups = await Promise.all(
      (Object.keys(groupLoaders) as Array<keyof typeof groupLoaders>).map((group) =>
        this.#loadGroup(group),
      ),
    );
    return groups.flat();
  }

  #loadGroup(group: keyof typeof groupLoaders): Promise<readonly SceneDefinition[]> {
    const cached = this.#cache.get(group);
    if (cached !== undefined) return cached;
    const pending = groupLoaders[group]();
    this.#cache.set(group, pending);
    return pending;
  }
}

export const sceneRepository = new SceneRepository();
