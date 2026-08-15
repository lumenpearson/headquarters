import {
  createVirtualPath,
  type screenIds,
  type AppSnapshot,
  type ExplorerCollision,
  type ExplorerNode,
  type ModuleId,
  type SceneId,
  type ScenePreflight,
  type ScreenConnection,
  type ScreenId,
  type ScreenState,
  type VirtualPath,
  type WorkspaceDocument,
  type WorkspaceWindow,
} from '@gremuchaya/domain';

export interface SceneSliceState {
  readonly activeSceneId: SceneId | null;
  readonly activeCueIndex: number;
  readonly status: 'idle' | 'preloading' | 'ready' | 'running' | 'failed';
  readonly preload: {
    readonly ready: number;
    readonly total: number;
    readonly failed: number;
  };
  readonly preflight: ScenePreflight | null;
}

export interface ScreensSliceState {
  readonly byId: Readonly<Record<ScreenId, ScreenState>>;
}

export interface OperatorSliceState {
  readonly clockMode: 'real' | 'fixed' | 'scene';
  readonly fixedTime: string;
  readonly wallPreset: string;
  readonly note: string;
  readonly isProductionLocked: boolean;
  readonly isRehearsalMode: boolean;
  readonly isAudioArmed: boolean;
}

export interface WorkspaceSliceState {
  readonly activeSection:
    'overview' | 'objects' | 'cases' | 'map' | 'video' | 'comms' | 'files' | 'archive' | 'search';
  readonly windows: readonly WorkspaceWindow[];
  readonly documentsById: Readonly<Record<string, WorkspaceDocument>>;
  readonly activeDocumentId: string | null;
  readonly commandPaletteOpen: boolean;
}

export interface ExplorerSliceState {
  readonly activePath: VirtualPath;
  readonly selectedNodeId: string | null;
  readonly expandedNodeIds: readonly string[];
  readonly viewMode: 'list' | 'grid';
  readonly searchQuery: string;
  readonly filter: 'all' | 'documents' | 'images' | 'video';
  readonly sortBy: 'name' | 'modifiedAt' | 'size' | 'kind';
  readonly sortDirection: 'asc' | 'desc';
  readonly nodes: readonly ExplorerNode[];
  readonly collisions: readonly ExplorerCollision[];
  readonly sourceStatuses: Readonly<
    Record<string, 'online' | 'offline' | 'permission-required' | 'empty'>
  >;
  readonly loading: boolean;
  readonly errorCode: string | null;
}

export interface SimulationFlags {
  readonly signalLoss: boolean;
  readonly bridgeOffline: boolean;
  readonly missingAsset: boolean;
  readonly slowLoad: boolean;
  readonly cctvFreeze: boolean;
  readonly emptyFolder: boolean;
  readonly invalidConfig: boolean;
}

export interface DeveloperChange {
  readonly id: string;
  readonly at: number;
  readonly key: string;
  readonly previousValue: unknown;
}

export interface DeveloperSliceState {
  readonly isUnlocked: boolean;
  readonly activeSection:
    | 'states'
    | 'scenes'
    | 'screens'
    | 'data'
    | 'files'
    | 'media'
    | 'simulation'
    | 'bridge'
    | 'snapshots'
    | 'diagnostics';
  readonly stateOverrides: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly entityOverrides: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly simulation: SimulationFlags;
  readonly snapshots: readonly AppSnapshot[];
  readonly undoStack: readonly DeveloperChange[];
  readonly lastErrors: readonly string[];
}

export interface ConnectionsSliceState {
  readonly byId: Readonly<Record<ScreenId, ScreenConnection>>;
  readonly busStatus: 'online' | 'fallback' | 'offline';
  readonly bridgeStatus: 'online' | 'connecting' | 'offline' | 'incompatible';
  readonly lastFilesystemEvent: string | null;
}

export interface RuntimeState {
  readonly scene: SceneSliceState;
  readonly screens: ScreensSliceState;
  readonly operator: OperatorSliceState;
  readonly workspace: WorkspaceSliceState;
  readonly explorer: ExplorerSliceState;
  readonly developer: DeveloperSliceState;
  readonly connections: ConnectionsSliceState;
}

export interface RuntimeStatePort {
  getSnapshot(): RuntimeState;
  commit(nextState: RuntimeState): void;
}

export function createInitialRuntimeState(
  initialScreens: Readonly<Record<ScreenId, ScreenState>>,
): RuntimeState {
  return {
    scene: {
      activeSceneId: null,
      activeCueIndex: -1,
      status: 'idle',
      preload: { ready: 0, total: 0, failed: 0 },
      preflight: null,
    },
    screens: { byId: initialScreens },
    operator: {
      clockMode: 'fixed',
      fixedTime: '14:32:17',
      wallPreset: 'hq-default',
      note: '',
      isProductionLocked: false,
      isRehearsalMode: false,
      isAudioArmed: false,
    },
    workspace: {
      activeSection: 'overview',
      windows: [],
      documentsById: {},
      activeDocumentId: null,
      commandPaletteOpen: false,
    },
    explorer: {
      activePath: createVirtualPath('/'),
      selectedNodeId: null,
      expandedNodeIds: [],
      viewMode: 'list',
      searchQuery: '',
      filter: 'all',
      sortBy: 'name',
      sortDirection: 'asc',
      nodes: [],
      collisions: [],
      sourceStatuses: { emulated: 'online', static: 'online' },
      loading: false,
      errorCode: null,
    },
    developer: {
      isUnlocked: false,
      activeSection: 'states',
      stateOverrides: {},
      entityOverrides: {},
      simulation: {
        signalLoss: false,
        bridgeOffline: false,
        missingAsset: false,
        slowLoad: false,
        cctvFreeze: false,
        emptyFolder: false,
        invalidConfig: false,
      },
      snapshots: [],
      undoStack: [],
      lastErrors: [],
    },
    connections: {
      byId: createInitialConnections(),
      busStatus: 'online',
      bridgeStatus: 'offline',
      lastFilesystemEvent: null,
    },
  };
}

export function selectOwnScreen(state: RuntimeState, screenId: ScreenId): ScreenState {
  return state.screens.byId[screenId];
}

export function selectActiveModule(state: RuntimeState, screenId: ScreenId): ModuleId {
  return state.screens.byId[screenId].module;
}

function createInitialConnections(): Record<ScreenId, ScreenConnection> {
  const connection = (screenId: ScreenId): ScreenConnection => ({
    screenId,
    status: 'offline',
    lastHeartbeatAt: null,
    latencyMs: null,
  });

  return {
    'hwan-main': connection('hwan-main'),
    'hwan-map': connection('hwan-map'),
    'hwan-comms': connection('hwan-comms'),
    'wall-center': connection('wall-center'),
    'wall-left': connection('wall-left'),
    'wall-right': connection('wall-right'),
    'kirillov-desk': connection('kirillov-desk'),
    'interrogation-video': connection('interrogation-video'),
    'interrogation-audio': connection('interrogation-audio'),
  } satisfies Record<(typeof screenIds)[number], ScreenConnection>;
}
