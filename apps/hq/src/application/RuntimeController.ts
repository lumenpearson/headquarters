import {
  createSceneId,
  createVirtualPath,
  type Disposable,
  type ExplorerNode,
  type FileSourceEvent,
  type ModulePreset,
  type SceneDefinition,
  type SceneId,
  type ScreenBusPort,
  type ScreenId,
  type VirtualPath,
} from '@gremuchaya/domain';

import { sceneRepository } from '@/config/scenes';
import { createScreenBus } from '@/infrastructure/tauri/createScreenBus';
import {
  TauriDisplayGateway,
  type NativeMonitor,
  type NativeWindowResult,
} from '@/infrastructure/tauri/TauriDisplayGateway';
import { StaticAssetResolver } from '@/infrastructure/assets/StaticAssetResolver';
import {
  loadRuntimeConfiguration,
  type RuntimeConfiguration,
} from '@/infrastructure/config/RuntimeConfigLoader';
import { BrowserDirectorySource } from '@/infrastructure/explorer/BrowserDirectorySource';
import { BridgeFileSource } from '@/infrastructure/explorer/BridgeFileSource';
import { EmulatedFileSource } from '@/infrastructure/explorer/EmulatedFileSource';
import { TauriFileSource } from '@/infrastructure/explorer/TauriFileSource';
import { LocalSnapshotPersistence } from '@/infrastructure/persistence/LocalSnapshotPersistence';
import { appStore, runtimeStatePort } from '@/state/appStore';

import { ExplorerService } from './ExplorerService';
import { SceneService } from './SceneService';
import { SnapshotService } from './SnapshotService';
import { applyCueAction } from './sceneState';

/**
 * How long file-change events are collected before the explorer re-lists.
 *
 * A single save produces a burst -- the Windows watcher reports the temporary
 * file, the rename and the metadata write as separate events -- and one listing
 * per event would put three round trips through the native layer on screen for
 * one operator action.
 */
const explorerRefreshDebounceMs = 180;

/** Matches `BridgeFileSource#id`; kept as a constant so `connections.bridgeStatus`
 * reads the one source that name identifies rather than a string repeated by hand. */
const bridgeSourceId = 'file-bridge';

/**
 * `connections.bridgeStatus`'s display contract: reachable (`'online'`, even
 * with an empty listing) or not, decided from `ExplorerService.list`'s own
 * per-source verdict for {@link bridgeSourceId} rather than a second probe.
 * `'connecting'` and `'incompatible'` are declared on the slice for a richer
 * signal (health/version negotiation) nothing produces yet; this never writes
 * either.
 */
function bridgeStatusFromSourceStatus(
  status: 'online' | 'offline' | 'empty' | undefined,
): 'online' | 'offline' {
  return status === 'offline' || status === undefined ? 'offline' : 'online';
}

/**
 * `connections.lastFilesystemEvent`'s display contract: the kind and path a
 * `FileSourceEvent` carries, in the vocabulary the domain already uses for
 * it -- the same choice `VirtualExplorer` makes for `sourceStatuses`, which
 * prints `online`/`offline`/`empty` untranslated rather than inventing a
 * second, Russian vocabulary for the same three words.
 */
function formatFilesystemEvent(event: FileSourceEvent): string {
  return `${event.type} ${event.sourceId} ${event.path}`;
}

export class RuntimeController {
  readonly bus: ScreenBusPort;
  readonly sceneService: SceneService;
  readonly explorerService: ExplorerService;
  readonly browserDirectory: BrowserDirectorySource;
  readonly displays: TauriDisplayGateway;
  readonly snapshotService: SnapshotService;
  readonly #unsubscribeBus: () => void;
  #explorerWatch: Disposable | null = null;
  #explorerRefreshTimer: number | null = null;

  private constructor(readonly config: RuntimeConfiguration) {
    this.bus = createScreenBus();
    this.browserDirectory = new BrowserDirectorySource();
    this.displays = new TauriDisplayGateway();
    this.explorerService = new ExplorerService([
      new EmulatedFileSource(config.emulatedRoots),
      this.browserDirectory,
      new BridgeFileSource(config.project.bridgeUrl),
      new TauriFileSource(),
    ]);
    this.sceneService = new SceneService(
      sceneRepository,
      new StaticAssetResolver(config.assets),
      runtimeStatePort,
      this.bus,
      {
        now: () => Date.now(),
        schedule: (callback, delayMs) => {
          const timeoutId = window.setTimeout(callback, delayMs);
          return () => window.clearTimeout(timeoutId);
        },
      },
    );
    this.snapshotService = new SnapshotService(new LocalSnapshotPersistence(), runtimeStatePort);
    this.#unsubscribeBus = this.bus.subscribe((message) => {
      if (message.payload.type === 'REQUEST_CURRENT_STATE') {
        const current = appStore.getState();
        this.bus.publish({
          type: 'CURRENT_STATE',
          state: {
            activeSceneId: current.scene.activeSceneId,
            activeCueIndex: current.scene.activeCueIndex,
            screens: current.screens.byId,
            wallPreset: current.operator.wallPreset,
            operatorNote: current.operator.note,
          },
        });
      } else if (message.payload.type === 'PONG') {
        const heartbeat = message.payload.heartbeat;
        const current = appStore.getState();
        current.replaceRuntimeState({
          ...current,
          connections: {
            ...current.connections,
            byId: {
              ...current.connections.byId,
              [heartbeat.screenId]: {
                screenId: heartbeat.screenId,
                status: 'online',
                lastHeartbeatAt: heartbeat.receivedAt,
                latencyMs: Math.max(0, Date.now() - message.issuedAt),
              },
            },
          },
        });
      }
    });
  }

  static async create(signal?: AbortSignal): Promise<RuntimeController> {
    const config = await loadRuntimeConfiguration(signal);
    const controller = new RuntimeController(config);
    const current = appStore.getState();
    current.replaceRuntimeState({
      ...current,
      operator: {
        ...current.operator,
        fixedTime: config.project.fixedClock,
        wallPreset: config.project.defaultWallPreset,
        isProductionLocked: config.project.runtimeMode === 'production',
        isRehearsalMode: config.project.runtimeMode === 'rehearsal',
      },
    });
    await controller.navigate(createVirtualPath('/'));
    if (config.project.defaultSceneId !== undefined) {
      await controller.loadScene(config.project.defaultSceneId);
    }
    await controller.refreshSnapshots();
    return controller;
  }

  async loadScene(sceneId: SceneId | string): Promise<SceneDefinition> {
    const normalized = createSceneId(sceneId);
    const scene = await this.sceneService.loadScene(normalized);
    await this.sceneService.preloadScene(normalized);
    await this.sceneService.runScenePreflight();
    return scene;
  }

  getScene(sceneId: SceneId | string): Promise<SceneDefinition | null> {
    return sceneRepository.find(sceneId);
  }

  async navigate(path: VirtualPath | string): Promise<void> {
    const normalized = createVirtualPath(path);
    const before = appStore.getState();
    before.replaceRuntimeState({
      ...before,
      explorer: { ...before.explorer, activePath: normalized, loading: true, errorCode: null },
    });
    try {
      const view = await this.explorerService.list(normalized);
      const current = appStore.getState();
      current.replaceRuntimeState({
        ...current,
        explorer: {
          ...current.explorer,
          activePath: normalized,
          nodes: view.nodes,
          collisions: view.collisions,
          sourceStatuses: view.sourceStatuses,
          selectedNodeId: null,
          loading: false,
          errorCode: null,
        },
        connections: {
          ...current.connections,
          bridgeStatus: bridgeStatusFromSourceStatus(view.sourceStatuses[bridgeSourceId]),
        },
      });
    } catch (error: unknown) {
      const current = appStore.getState();
      current.replaceRuntimeState({
        ...current,
        explorer: {
          ...current.explorer,
          loading: false,
          errorCode: error instanceof Error ? error.message : 'EXPLORER_ERROR',
        },
      });
    }
    await this.#watchActivePath(normalized);
  }

  /**
   * Moves every capable source's watch to the directory the operator is
   * looking at.
   *
   * One watch at a time on purpose: a native or bridge watcher is recursive,
   * so a watcher per visited directory would report the same change several
   * times over, and the explorer only ever shows one path. There is no
   * availability check and no late-arrival guard here because
   * `ExplorerService.watch` covers both: a source with nothing to watch (no
   * Tauri runtime -- the case on every call on the web build -- or an
   * unreachable bridge) is skipped rather than stopping the others, and a
   * source whose subscribe call resolves after this watch has already been
   * replaced disposes itself on arrival instead of leaking.
   */
  async #watchActivePath(path: VirtualPath): Promise<void> {
    this.#explorerWatch?.dispose();
    this.#explorerWatch = await this.explorerService.watch(path, (event) => {
      const current = appStore.getState();
      current.replaceRuntimeState({
        ...current,
        connections: {
          ...current.connections,
          lastFilesystemEvent: formatFilesystemEvent(event),
        },
      });
      this.#scheduleExplorerRefresh(path);
    });
  }

  #scheduleExplorerRefresh(path: VirtualPath): void {
    if (this.#explorerRefreshTimer !== null) window.clearTimeout(this.#explorerRefreshTimer);
    this.#explorerRefreshTimer = window.setTimeout(() => {
      this.#explorerRefreshTimer = null;
      void this.refreshExplorer(path);
    }, explorerRefreshDebounceMs);
  }

  /**
   * Re-lists a directory in place, without the loading flag or a new watch.
   *
   * `navigate` cannot be reused here: it would clear the selection under the
   * operator's cursor and tear down the very watch that asked for the refresh.
   */
  async refreshExplorer(path: VirtualPath): Promise<void> {
    if (appStore.getState().explorer.activePath !== path) return;
    try {
      const view = await this.explorerService.list(path);
      const current = appStore.getState();
      if (current.explorer.activePath !== path) return;
      current.replaceRuntimeState({
        ...current,
        explorer: {
          ...current.explorer,
          nodes: view.nodes,
          collisions: view.collisions,
          sourceStatuses: view.sourceStatuses,
        },
        connections: {
          ...current.connections,
          bridgeStatus: bridgeStatusFromSourceStatus(view.sourceStatuses[bridgeSourceId]),
        },
      });
    } catch {
      // A failed refresh leaves the last good listing on screen rather than
      // replacing a directory the operator is reading with an error.
    }
  }

  /** The displays the native shell reports; empty on the web build. */
  listMonitors(): Promise<readonly NativeMonitor[]> {
    return this.displays.listMonitors();
  }

  /**
   * Opens the managed window for every entry in `project.screenWindows`.
   *
   * Those entries have been parsed and validated by `projectConfigSchema` since
   * the config was written and acted on by nothing: the desktop shell could
   * open a screen window on a named monitor, and no caller ever asked it to.
   */
  async openConfiguredScreenWindows(): Promise<readonly NativeWindowResult[]> {
    const results: NativeWindowResult[] = [];
    for (const request of this.config.project.screenWindows) {
      results.push(
        await this.displays.openScreenWindow(
          request.screenId,
          request.monitorIndex,
          request.fullscreen,
        ),
      );
    }
    return results;
  }

  closeManagedWindows(): Promise<NativeWindowResult> {
    return this.displays.closeManagedWindows();
  }

  selectNode(nodeId: string | null): void {
    const current = appStore.getState();
    current.replaceRuntimeState({
      ...current,
      explorer: { ...current.explorer, selectedNodeId: nodeId },
    });
  }

  async openNode(node: ExplorerNode): Promise<void> {
    if (
      node.kind === 'real-directory' ||
      node.kind === 'emulated-directory' ||
      node.kind === 'mount'
    ) {
      await this.navigate(node.path);
      return;
    }
    const document = this.explorerService.toDocument(node);
    const current = appStore.getState();
    const nextZ =
      current.workspace.windows.reduce((maximum, window) => Math.max(maximum, window.zOrder), 0) +
      1;
    const existing = current.workspace.windows.find((window) => window.documentId === document.id);
    const windows =
      existing === undefined
        ? [
            ...current.workspace.windows,
            {
              id: `window:${document.id}`,
              documentId: document.id,
              title: document.title,
              kind: document.kind,
              bounds: {
                x: 110 + current.workspace.windows.length * 22,
                y: 86 + current.workspace.windows.length * 18,
                width: 720,
                height: 480,
              },
              state: 'normal' as const,
              zOrder: nextZ,
            },
          ]
        : current.workspace.windows.map((window) =>
            window.id === existing.id
              ? { ...window, state: 'normal' as const, zOrder: nextZ }
              : window,
          );
    current.replaceRuntimeState({
      ...current,
      workspace: {
        ...current.workspace,
        windows,
        documentsById: { ...current.workspace.documentsById, [document.id]: document },
        activeDocumentId: document.id,
      },
    });
  }

  sendNodeToScreen(node: ExplorerNode, screenId: ScreenId): void {
    const document = this.explorerService.toDocument(node);
    const preset = presetForDocument(document);
    const current = appStore.getState();
    const next = applyCueAction(current, {
      type: 'SET_MODULE',
      screenId,
      module: preset.module,
      payload: preset.payload,
    });
    current.replaceRuntimeState(next);
    this.bus.publish({
      type: 'CUE',
      cueIndex: current.scene.activeCueIndex,
      action: { type: 'SET_MODULE', screenId, module: preset.module, payload: preset.payload },
    });
  }

  setSection(section: ReturnType<typeof appStore.getState>['workspace']['activeSection']): void {
    const current = appStore.getState();
    current.replaceRuntimeState({
      ...current,
      workspace: { ...current.workspace, activeSection: section },
    });
  }

  setExplorerQuery(searchQuery: string): void {
    const current = appStore.getState();
    current.replaceRuntimeState({ ...current, explorer: { ...current.explorer, searchQuery } });
  }

  setExplorerOption<Key extends 'filter' | 'sortBy'>(
    key: Key,
    value: ReturnType<typeof appStore.getState>['explorer'][Key],
  ): void {
    const current = appStore.getState();
    current.replaceRuntimeState({ ...current, explorer: { ...current.explorer, [key]: value } });
  }

  toggleDeveloper(): void {
    const current = appStore.getState();
    current.replaceRuntimeState({
      ...current,
      developer: { ...current.developer, isUnlocked: !current.developer.isUnlocked },
    });
  }

  async saveSnapshot(name: string): Promise<void> {
    await this.snapshotService.save(name);
    await this.refreshSnapshots();
  }

  async restoreSnapshot(name: string): Promise<void> {
    const snapshot = (await this.snapshotService.list()).find(
      (candidate) => candidate.name === name,
    );
    if (snapshot === undefined) throw new Error(`Snapshot not found: ${name}`);
    this.snapshotService.restore(snapshot);
    this.bus.publish({
      type: 'RESET',
      state: {
        activeSceneId: snapshot.sceneId,
        activeCueIndex: snapshot.cueIndex,
        screens: snapshot.screens,
        wallPreset: snapshot.wallPreset,
        operatorNote: appStore.getState().operator.note,
      },
    });
  }

  async removeSnapshot(name: string): Promise<void> {
    await this.snapshotService.remove(name);
    await this.refreshSnapshots();
  }

  async refreshSnapshots(): Promise<void> {
    const snapshots = await this.snapshotService.list();
    const current = appStore.getState();
    current.replaceRuntimeState({ ...current, developer: { ...current.developer, snapshots } });
  }

  close(): void {
    if (this.#explorerRefreshTimer !== null) window.clearTimeout(this.#explorerRefreshTimer);
    this.#explorerRefreshTimer = null;
    // Disposing the merged watch releases every source behind it too --
    // `unwatch_directory` for the native OS handle, an aborted `Watch` stream
    // for the bridge -- and a reloaded window would otherwise leave one behind
    // for every navigation of the previous session.
    this.#explorerWatch?.dispose();
    this.#explorerWatch = null;
    this.#unsubscribeBus();
    this.bus.close();
  }
}

function presetForDocument(document: ReturnType<ExplorerService['toDocument']>): ModulePreset {
  switch (document.kind) {
    case 'person':
      return {
        module: 'dossier',
        payload: {
          entityId: document.entityId,
          displayName: document.title,
          status: 'ОТКРЫТО ИЗ EXPLORER',
          category: 'ОБЪЕКТ',
          summary: 'Материал виртуальной файловой системы.',
          facts: [],
          portraitAssetIds: [],
          relatedMaterials: ['ФАЙЛ', 'СВЯЗИ'],
        },
      };
    case 'vehicle':
      return {
        module: 'dossier',
        payload: {
          entityId: document.entityId,
          displayName: document.title,
          status: 'ТРАНСПОРТ',
          category: 'ОБЪЕКТ',
          summary: 'Карточка транспортного средства.',
          facts: [],
          portraitAssetIds: [],
          relatedMaterials: [],
        },
      };
    case 'image':
      return {
        module: 'photo-archive',
        payload: { title: document.title, assetIds: [document.assetId], selectedIndex: 0 },
      };
    case 'video':
      return {
        module: 'cctv',
        payload: {
          cameraId: 'EXPLORER',
          location: document.title,
          timestamp: 'LOCAL FILE',
          assetId: document.assetId,
          archive: true,
          muted: true,
          playing: true,
        },
      };
    case 'map':
      return {
        module: 'map',
        payload: {
          mapAsset: 'map-spb-kad-shushary',
          title: document.title,
          markers: [],
          readout: { object: document.presetId },
        },
      };
    case 'graph':
      return {
        module: 'graph',
        payload: { title: document.title, stage: document.graphId, nodes: [], edges: [] },
      };
    case 'text':
      return {
        module: 'system-tables',
        payload: { title: document.title, columns: ['МАТЕРИАЛ'], rows: [[document.body]] },
      };
    case 'metadata':
      return {
        module: 'explorer',
        payload: { path: document.node.path, selectedNodeId: document.node.id, takeover: true },
      };
  }
}
