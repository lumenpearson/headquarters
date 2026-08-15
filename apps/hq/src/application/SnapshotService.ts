import type { AppSnapshot } from '@gremuchaya/domain';

import type { SnapshotPersistencePort } from './ports';
import type { RuntimeStatePort } from './runtimeState';

export class SnapshotService {
  constructor(
    private readonly persistence: SnapshotPersistencePort,
    private readonly state: RuntimeStatePort,
  ) {}

  list(): Promise<readonly AppSnapshot[]> {
    return this.persistence.list();
  }

  async save(name: string): Promise<AppSnapshot> {
    const current = this.state.getSnapshot();
    const snapshot: AppSnapshot = {
      version: 1,
      name,
      createdAt: new Date().toISOString(),
      sceneId: current.scene.activeSceneId,
      cueIndex: current.scene.activeCueIndex,
      screens: current.screens.byId,
      explorer: {
        activePath: current.explorer.activePath,
        selectedNodeId: current.explorer.selectedNodeId,
        expandedNodeIds: current.explorer.expandedNodeIds,
        viewMode: current.explorer.viewMode,
        searchQuery: current.explorer.searchQuery,
      },
      workspace: {
        activeSection: current.workspace.activeSection,
        windows: current.workspace.windows,
        activeDocumentId: current.workspace.activeDocumentId,
      },
      clock: { mode: current.operator.clockMode, fixedTime: current.operator.fixedTime },
      wallPreset: current.operator.wallPreset,
      developerStateOverrides: current.developer.stateOverrides,
    };
    await this.persistence.save(snapshot);
    return snapshot;
  }

  restore(snapshot: AppSnapshot): void {
    const current = this.state.getSnapshot();
    this.state.commit({
      ...current,
      scene: {
        ...current.scene,
        activeSceneId: snapshot.sceneId,
        activeCueIndex: snapshot.cueIndex,
        status: snapshot.sceneId === null ? 'idle' : 'running',
      },
      screens: { byId: snapshot.screens },
      explorer: { ...current.explorer, ...snapshot.explorer },
      workspace: {
        ...current.workspace,
        activeSection: toSection(snapshot.workspace.activeSection),
        windows: snapshot.workspace.windows,
        activeDocumentId: snapshot.workspace.activeDocumentId,
      },
      operator: {
        ...current.operator,
        clockMode: snapshot.clock.mode,
        fixedTime: snapshot.clock.fixedTime,
        wallPreset: snapshot.wallPreset,
      },
      developer: {
        ...current.developer,
        stateOverrides: Object.fromEntries(
          Object.entries(snapshot.developerStateOverrides).map(([key, value]) => [
            key,
            isRecord(value) ? value : { value },
          ]),
        ),
      },
    });
  }

  remove(name: string): Promise<void> {
    return this.persistence.remove(name);
  }
}

function toSection(
  value: string,
): ReturnType<RuntimeStatePort['getSnapshot']>['workspace']['activeSection'] {
  const sections = [
    'overview',
    'objects',
    'cases',
    'map',
    'video',
    'comms',
    'files',
    'archive',
    'search',
  ] as const;
  return sections.find((section) => section === value) ?? 'overview';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
