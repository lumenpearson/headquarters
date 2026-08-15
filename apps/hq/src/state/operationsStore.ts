'use client';

import type {
  Alert,
  AnalyticalInsight,
  Attachment,
  Camera,
  CaseFile,
  CommunicationChannel,
  OperationalObject,
  OpsEvent,
  OpsReport,
  OpsTask,
  Person,
  Sector,
  Sensor,
  SystemNode,
  TacticalRoute,
} from '@gremuchaya/domain';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';

import { operationsSeed } from '../data/operationsSeed';

export type OperationsRoute =
  | 'overview'
  | 'objects'
  | 'object-detail'
  | 'cases'
  | 'case-detail'
  | 'map'
  | 'video'
  | 'cameras'
  | 'video-archive'
  | 'communications'
  | 'files'
  | 'archive'
  | 'analytics'
  | 'reports'
  | 'search'
  | 'settings'
  | 'system'
  | 'ui-gallery';

export type DrawerKind =
  'alert' | 'event' | 'task' | 'camera' | 'route' | 'channel' | 'file' | 'insight';
export type MapLayer =
  | 'friendly'
  | 'hostile'
  | 'neutral'
  | 'infrastructure'
  | 'restricted'
  | 'tasks'
  | 'routes'
  | 'alerts'
  | 'communications'
  | 'sensors';

export interface OpsAuditEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly action: string;
  readonly entityId: string;
  readonly operator: string;
}

export interface ProductionSnapshot {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly route: OperationsRoute;
  readonly selectedObjectId: string;
  readonly selectedCameraId: string;
  readonly selectedCaseId: string;
  readonly mapCenter: readonly [number, number];
  readonly mapZoom: number;
  readonly mapLayers: Readonly<Record<MapLayer, boolean>>;
  readonly activeAlertIds: readonly string[];
  readonly preset: string;
  readonly simulationPaused: boolean;
  readonly fixedTime: string;
}

interface OperationsUiState {
  readonly route: OperationsRoute;
  readonly selectedObjectId: string;
  readonly selectedCameraId: string;
  readonly selectedCaseId: string;
  readonly selectedFileId: string;
  readonly selectedRouteId: string;
  readonly selectedChannelId: string;
  readonly drawer: { readonly kind: DrawerKind; readonly id: string } | null;
  readonly searchQuery: string;
  readonly globalFilter: string;
  readonly mapCenter: readonly [number, number];
  readonly mapZoom: number;
  readonly mapLayers: Readonly<Record<MapLayer, boolean>>;
  readonly videoPlaying: boolean;
  readonly videoLive: boolean;
  readonly videoPosition: number;
  readonly ptz: {
    readonly pan: number;
    readonly tilt: number;
    readonly zoom: number;
    readonly speed: number;
  };
  readonly filesView: 'list' | 'grid';
  readonly fileKindFilter: string;
  readonly analyticsFilter: string;
  readonly navCompact: boolean;
  readonly productionPanelOpen: boolean;
}

interface ProductionState {
  readonly paused: boolean;
  readonly preset: string;
  readonly cameraSafe: boolean;
  readonly animations: boolean;
  readonly cursorMode: 'visible' | 'auto' | 'hidden';
  readonly clockMode: 'real' | 'fixed';
  readonly fixedTime: string;
  readonly clockSpeed: 0.5 | 1 | 2 | 5;
  readonly screenId: string;
  readonly autoDemo: boolean;
  readonly snapshots: readonly ProductionSnapshot[];
}

interface OperationsMetrics {
  readonly cpu: number;
  readonly ram: number;
  readonly storage: number;
  readonly gpu: number;
  readonly networkIn: number;
  readonly networkOut: number;
  readonly readiness: number;
  readonly simulationStep: number;
}

export interface OperationsState {
  readonly operation: typeof operationsSeed.operation;
  readonly sectors: Readonly<Record<string, Sector>>;
  readonly objects: Readonly<Record<string, OperationalObject>>;
  readonly people: Readonly<Record<string, Person>>;
  readonly cameras: Readonly<Record<string, Camera>>;
  readonly cases: Readonly<Record<string, CaseFile>>;
  readonly attachments: Readonly<Record<string, Attachment>>;
  readonly events: readonly OpsEvent[];
  readonly alerts: Readonly<Record<string, Alert>>;
  readonly tasks: Readonly<Record<string, OpsTask>>;
  readonly routes: Readonly<Record<string, TacticalRoute>>;
  readonly channels: Readonly<Record<string, CommunicationChannel>>;
  readonly sensors: Readonly<Record<string, Sensor>>;
  readonly systemNodes: Readonly<Record<string, SystemNode>>;
  readonly insights: Readonly<Record<string, AnalyticalInsight>>;
  readonly reports: Readonly<Record<string, OpsReport>>;
  readonly ui: OperationsUiState;
  readonly production: ProductionState;
  readonly metrics: OperationsMetrics;
  readonly audit: readonly OpsAuditEntry[];
  readonly setRoute: (route: OperationsRoute) => void;
  readonly selectObject: (id: string) => void;
  readonly selectCamera: (id: string) => void;
  readonly selectCase: (id: string) => void;
  readonly selectFile: (id: string) => void;
  readonly selectRoute: (id: string) => void;
  readonly selectChannel: (id: string) => void;
  readonly openDrawer: (kind: DrawerKind, id: string) => void;
  readonly closeDrawer: () => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setGlobalFilter: (filter: string) => void;
  readonly setMapView: (center: readonly [number, number], zoom: number) => void;
  readonly toggleMapLayer: (layer: MapLayer) => void;
  readonly acknowledgeAlert: (id: string) => void;
  readonly completeTask: (id: string) => void;
  readonly toggleVideo: () => void;
  readonly setVideoPosition: (position: number) => void;
  readonly setVideoLive: (live: boolean) => void;
  readonly adjustPtz: (axis: 'pan' | 'tilt' | 'zoom', delta: number) => void;
  readonly setPtzSpeed: (speed: number) => void;
  readonly setFilesView: (view: 'list' | 'grid') => void;
  readonly setFileKindFilter: (filter: string) => void;
  readonly setAnalyticsFilter: (filter: string) => void;
  readonly toggleNavCompact: () => void;
  readonly toggleProductionPanel: (force?: boolean) => void;
  readonly setProductionOption: <Key extends keyof Omit<ProductionState, 'snapshots'>>(
    key: Key,
    value: ProductionState[Key],
  ) => void;
  readonly applyPreset: (preset: string) => void;
  readonly saveSnapshot: (name: string) => void;
  readonly restoreSnapshot: (id: string) => void;
  readonly resetWorld: () => void;
  readonly simulationTick: () => void;
}

const persistedStateKey = 'gremuchaya-hq:operations:v3';
const snapshotStateKey = 'gremuchaya-hq:production-snapshots:v3';
const channelName = 'gremuchaya-hq:operations-bus:v3';

const mapLayers: Readonly<Record<MapLayer, boolean>> = {
  friendly: true,
  hostile: true,
  neutral: true,
  infrastructure: true,
  restricted: true,
  tasks: true,
  routes: true,
  alerts: true,
  communications: false,
  sensors: true,
};

function keyed<Value extends { readonly id: string }>(
  values: readonly Value[],
): Readonly<Record<string, Value>> {
  return Object.fromEntries(values.map((value) => [value.id, value])) as Readonly<
    Record<string, Value>
  >;
}

function createBaseState() {
  return {
    operation: operationsSeed.operation,
    sectors: keyed(operationsSeed.sectors),
    objects: keyed(operationsSeed.objects),
    people: keyed(operationsSeed.people),
    cameras: keyed(operationsSeed.cameras),
    cases: keyed(operationsSeed.cases),
    attachments: keyed(operationsSeed.attachments),
    events: operationsSeed.events,
    alerts: keyed(operationsSeed.alerts),
    tasks: keyed(operationsSeed.tasks),
    routes: keyed(operationsSeed.routes),
    channels: keyed(operationsSeed.channels),
    sensors: keyed(operationsSeed.sensors),
    systemNodes: keyed(operationsSeed.systemNodes),
    insights: keyed(operationsSeed.insights),
    reports: keyed(operationsSeed.reports),
    ui: {
      route: 'overview' as const,
      selectedObjectId: 'K-17',
      selectedCameraId: 'K-17',
      selectedCaseId: 'CASE-01',
      selectedFileId: 'FILE-01',
      selectedRouteId: 'RT-01',
      selectedChannelId: 'CH-03',
      drawer: null,
      searchQuery: '',
      globalFilter: 'all',
      mapCenter: [55.7558, 37.6173] as const,
      mapZoom: 12,
      mapLayers,
      videoPlaying: true,
      videoLive: true,
      videoPosition: 82,
      ptz: { pan: 0, tilt: 0, zoom: 1, speed: 45 },
      filesView: 'list' as const,
      fileKindFilter: 'all',
      analyticsFilter: 'all',
      navCompact: false,
      productionPanelOpen: false,
    },
    production: {
      paused: false,
      preset: 'ACTIVE_OPERATION',
      cameraSafe: false,
      animations: true,
      cursorMode: 'visible' as const,
      clockMode: 'fixed' as const,
      fixedTime: '07:42:15',
      clockSpeed: 1 as const,
      screenId: 'MON-01',
      autoDemo: false,
      snapshots: [] as readonly ProductionSnapshot[],
    },
    metrics: {
      cpu: 43,
      ram: 68,
      storage: 72,
      gpu: 31,
      networkIn: 284,
      networkOut: 118,
      readiness: 87,
      simulationStep: 0,
    },
    audit: [
      {
        id: 'AUD-001',
        timestamp: new Date('2026-09-12T04:42:15.000Z').toISOString(),
        action: 'СЕССИЯ ОПЕРАТОРА ОТКРЫТА',
        entityId: 'OP-GS-042',
        operator: 'ОП-01',
      },
    ] as readonly OpsAuditEntry[],
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function auditEntry(action: string, entityId: string): OpsAuditEntry {
  return {
    id: `AUD-${Date.now()}-${entityId}`,
    timestamp: new Date().toISOString(),
    action,
    entityId,
    operator: 'ОП-01',
  };
}

export const operationsStore = createStore<OperationsState>()((set, get) => ({
  ...createBaseState(),
  setRoute: (route) => set((state) => ({ ui: { ...state.ui, route } })),
  selectObject: (selectedObjectId) =>
    set((state) => ({
      ui: { ...state.ui, selectedObjectId },
      audit: [auditEntry('ОТКРЫТА КАРТОЧКА ОБЪЕКТА', selectedObjectId), ...state.audit].slice(
        0,
        100,
      ),
    })),
  selectCamera: (selectedCameraId) =>
    set((state) => ({
      ui: { ...state.ui, selectedCameraId },
      audit: [auditEntry('ВЫБРАН ВИДЕОКАНАЛ', selectedCameraId), ...state.audit].slice(0, 100),
    })),
  selectCase: (selectedCaseId) =>
    set((state) => ({
      ui: { ...state.ui, selectedCaseId },
      audit: [auditEntry('ОТКРЫТО ДЕЛО', selectedCaseId), ...state.audit].slice(0, 100),
    })),
  selectFile: (selectedFileId) =>
    set((state) => ({
      ui: { ...state.ui, selectedFileId },
      audit: [auditEntry('ОТКРЫТ МАТЕРИАЛ', selectedFileId), ...state.audit].slice(0, 100),
    })),
  selectRoute: (selectedRouteId) =>
    set((state) => ({
      ui: { ...state.ui, selectedRouteId },
      audit: [auditEntry('ВЫБРАН МАРШРУТ', selectedRouteId), ...state.audit].slice(0, 100),
    })),
  selectChannel: (selectedChannelId) =>
    set((state) => ({ ui: { ...state.ui, selectedChannelId } })),
  openDrawer: (kind, id) => set((state) => ({ ui: { ...state.ui, drawer: { kind, id } } })),
  closeDrawer: () => set((state) => ({ ui: { ...state.ui, drawer: null } })),
  setSearchQuery: (searchQuery) => set((state) => ({ ui: { ...state.ui, searchQuery } })),
  setGlobalFilter: (globalFilter) => set((state) => ({ ui: { ...state.ui, globalFilter } })),
  setMapView: (mapCenter, mapZoom) =>
    set((state) => ({ ui: { ...state.ui, mapCenter, mapZoom: clamp(mapZoom, 1, 19) } })),
  toggleMapLayer: (layer) =>
    set((state) => ({
      ui: {
        ...state.ui,
        mapLayers: { ...state.ui.mapLayers, [layer]: !state.ui.mapLayers[layer] },
      },
    })),
  acknowledgeAlert: (id) =>
    set((state) => {
      const alert = state.alerts[id];
      if (alert === undefined || alert.lifecycle === 'RESOLVED') return state;
      return {
        alerts: { ...state.alerts, [id]: { ...alert, lifecycle: 'ACKNOWLEDGED' } },
        audit: [auditEntry('ТРЕВОГА ПОДТВЕРЖДЕНА', id), ...state.audit].slice(0, 100),
      };
    }),
  completeTask: (id) =>
    set((state) => {
      const task = state.tasks[id];
      if (task === undefined) return state;
      return {
        tasks: { ...state.tasks, [id]: { ...task, status: 'completed', progress: 100 } },
        audit: [auditEntry('ЗАДАЧА ЗАВЕРШЕНА', id), ...state.audit].slice(0, 100),
      };
    }),
  toggleVideo: () =>
    set((state) => ({ ui: { ...state.ui, videoPlaying: !state.ui.videoPlaying } })),
  setVideoPosition: (videoPosition) =>
    set((state) => ({
      ui: { ...state.ui, videoPosition: clamp(videoPosition, 0, 100) },
    })),
  setVideoLive: (videoLive) =>
    set((state) => ({
      ui: { ...state.ui, videoLive, videoPosition: videoLive ? 100 : state.ui.videoPosition },
    })),
  adjustPtz: (axis, delta) =>
    set((state) => ({
      ui: {
        ...state.ui,
        ptz: {
          ...state.ui.ptz,
          [axis]: clamp(
            state.ui.ptz[axis] + delta,
            axis === 'zoom' ? 1 : -100,
            axis === 'zoom' ? 3 : 100,
          ),
        },
      },
    })),
  setPtzSpeed: (speed) =>
    set((state) => ({ ui: { ...state.ui, ptz: { ...state.ui.ptz, speed } } })),
  setFilesView: (filesView) => set((state) => ({ ui: { ...state.ui, filesView } })),
  setFileKindFilter: (fileKindFilter) => set((state) => ({ ui: { ...state.ui, fileKindFilter } })),
  setAnalyticsFilter: (analyticsFilter) =>
    set((state) => ({ ui: { ...state.ui, analyticsFilter } })),
  toggleNavCompact: () =>
    set((state) => ({ ui: { ...state.ui, navCompact: !state.ui.navCompact } })),
  toggleProductionPanel: (force) =>
    set((state) => ({
      ui: { ...state.ui, productionPanelOpen: force ?? !state.ui.productionPanelOpen },
    })),
  setProductionOption: (key, value) =>
    set((state) => ({ production: { ...state.production, [key]: value } })),
  applyPreset: (preset) =>
    set((state) => {
      const critical = preset === 'CRITICAL' || preset === 'ALERT';
      return {
        production: { ...state.production, preset, paused: preset === 'CLEAN_IDLE' },
        ui: {
          ...state.ui,
          selectedObjectId:
            preset === 'MAP_TRACKING' || critical ? 'K-17' : state.ui.selectedObjectId,
          selectedCameraId:
            preset === 'VIDEO_FOCUS' || critical ? 'K-17' : state.ui.selectedCameraId,
          globalFilter: critical ? 'critical' : 'all',
        },
        audit: [auditEntry('ПРИМЕНЁН ПРЕСЕТ', preset), ...state.audit].slice(0, 100),
      };
    }),
  saveSnapshot: (name) => {
    const state = get();
    const snapshot: ProductionSnapshot = {
      id: `SNAP-${Date.now()}`,
      name,
      createdAt: new Date().toISOString(),
      route: state.ui.route,
      selectedObjectId: state.ui.selectedObjectId,
      selectedCameraId: state.ui.selectedCameraId,
      selectedCaseId: state.ui.selectedCaseId,
      mapCenter: state.ui.mapCenter,
      mapZoom: state.ui.mapZoom,
      mapLayers: state.ui.mapLayers,
      activeAlertIds: Object.values(state.alerts)
        .filter((alert) => alert.lifecycle !== 'RESOLVED')
        .map((alert) => alert.id),
      preset: state.production.preset,
      simulationPaused: state.production.paused,
      fixedTime: state.production.fixedTime,
    };
    const snapshots = [snapshot, ...state.production.snapshots].slice(0, 20);
    if (typeof window !== 'undefined')
      localStorage.setItem(snapshotStateKey, JSON.stringify(snapshots));
    set({
      production: { ...state.production, snapshots },
      audit: [auditEntry('СОХРАНЕНО СОСТОЯНИЕ СЦЕНЫ', snapshot.id), ...state.audit].slice(0, 100),
    });
  },
  restoreSnapshot: (id) =>
    set((state) => {
      const snapshot = state.production.snapshots.find((candidate) => candidate.id === id);
      if (snapshot === undefined) return state;
      return {
        ui: {
          ...state.ui,
          route: snapshot.route,
          selectedObjectId: snapshot.selectedObjectId,
          selectedCameraId: snapshot.selectedCameraId,
          selectedCaseId: snapshot.selectedCaseId,
          mapCenter: snapshot.mapCenter,
          mapZoom: snapshot.mapZoom,
          mapLayers: snapshot.mapLayers,
        },
        production: {
          ...state.production,
          preset: snapshot.preset,
          paused: snapshot.simulationPaused,
          fixedTime: snapshot.fixedTime,
        },
        audit: [auditEntry('ВОССТАНОВЛЕНО СОСТОЯНИЕ СЦЕНЫ', id), ...state.audit].slice(0, 100),
      };
    }),
  resetWorld: () => {
    const base = createBaseState();
    set({ ...base, production: { ...base.production, snapshots: get().production.snapshots } });
  },
  simulationTick: () =>
    set((state) => {
      if (state.production.paused) return state;
      const step = state.metrics.simulationStep + 1;
      const drift = (seed: number, amplitude: number) =>
        ((step * seed) % (amplitude * 2 + 1)) - amplitude;
      const systemNodes = Object.fromEntries(
        Object.values(state.systemNodes).map((node, index) => [
          node.id,
          {
            ...node,
            load: clamp(node.load + drift(index + 3, 2), 8, 96),
            temperature: clamp(node.temperature + drift(index + 5, 1), 30, 78),
          },
        ]),
      );
      const channels = Object.fromEntries(
        Object.values(state.channels).map((channel, index) => [
          channel.id,
          {
            ...channel,
            load: clamp(channel.load + drift(index + 7, 3), 4, 99),
            latency: clamp(channel.latency + drift(index + 2, 2), 5, 210),
            signal: clamp(channel.signal + drift(index + 11, 2), 8, 100),
          },
        ]),
      );
      const objects = { ...state.objects };
      const tracked = objects['K-17'];
      if (tracked !== undefined) {
        objects['K-17'] = {
          ...tracked,
          position: {
            ...tracked.position,
            x: clamp(tracked.position.x + drift(3, 1) * 0.32, 4, 96),
            y: clamp(tracked.position.y + drift(5, 1) * 0.24, 4, 96),
          },
          lastSeenAt: new Date().toISOString(),
        };
      }
      const generatedEvent: OpsEvent | null =
        step % 3 === 0
          ? {
              id: `EV-LIVE-${step}`,
              type: 'object.updated',
              timestamp: new Date().toISOString(),
              severity: step % 9 === 0 ? 'warning' : 'normal',
              source: 'SIMULATION',
              title: `K-17: ТЕЛЕМЕТРИЯ ОБНОВЛЕНА / TICK ${step}`,
              description: 'Детерминированное обновление локального оперативного мира.',
              linkedObjectIds: ['K-17'],
              linkedCaseIds: ['CASE-01'],
              linkedCameraId: 'K-17',
              coordinates: objects['K-17']?.position ?? null,
              status: 'ACTIVE',
            }
          : null;
      return {
        systemNodes,
        channels,
        objects,
        events:
          generatedEvent === null ? state.events : [generatedEvent, ...state.events].slice(0, 160),
        metrics: {
          cpu: clamp(state.metrics.cpu + drift(5, 3), 12, 94),
          ram: clamp(state.metrics.ram + drift(7, 2), 24, 92),
          storage: state.metrics.storage,
          gpu: clamp(state.metrics.gpu + drift(11, 4), 8, 89),
          networkIn: clamp(state.metrics.networkIn + drift(13, 18), 80, 620),
          networkOut: clamp(state.metrics.networkOut + drift(17, 11), 40, 410),
          readiness: clamp(state.metrics.readiness + drift(19, 1), 71, 96),
          simulationStep: step,
        },
      };
    }),
}));

export function useOperationsStore<Selection>(
  selector: (state: OperationsState) => Selection,
): Selection {
  return useStore(operationsStore, useShallow(selector));
}

interface PersistedOperationsState {
  readonly version: 3;
  readonly ui: OperationsUiState;
  readonly production: Omit<ProductionState, 'snapshots'>;
  readonly alerts: Readonly<Record<string, Alert>>;
  readonly tasks: Readonly<Record<string, OpsTask>>;
  readonly audit: readonly OpsAuditEntry[];
}

function persistedSnapshot(state: OperationsState): PersistedOperationsState {
  const { snapshots: _snapshots, ...production } = state.production;
  return {
    version: 3,
    ui: state.ui,
    production,
    alerts: state.alerts,
    tasks: state.tasks,
    audit: state.audit,
  };
}

export function initializeOperationsClient(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  try {
    const stored = localStorage.getItem(persistedStateKey);
    const snapshotsRaw = localStorage.getItem(snapshotStateKey);
    if (stored !== null) {
      const parsed = JSON.parse(stored) as Partial<PersistedOperationsState>;
      if (parsed.version === 3 && parsed.ui !== undefined && parsed.production !== undefined) {
        operationsStore.setState((state) => ({
          ui: { ...state.ui, ...parsed.ui, productionPanelOpen: false, drawer: null },
          production: { ...state.production, ...parsed.production },
          alerts: parsed.alerts ?? state.alerts,
          tasks: parsed.tasks ?? state.tasks,
          audit: parsed.audit ?? state.audit,
        }));
      }
    }
    if (snapshotsRaw !== null) {
      const snapshots = JSON.parse(snapshotsRaw) as readonly ProductionSnapshot[];
      operationsStore.setState((state) => ({ production: { ...state.production, snapshots } }));
    }
  } catch {
    localStorage.removeItem(persistedStateKey);
  }

  const broadcast =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(channelName);
  let applyingRemote = false;
  if (broadcast !== null) {
    broadcast.onmessage = (event: MessageEvent<PersistedOperationsState>) => {
      if (event.data.version !== 3) return;
      applyingRemote = true;
      operationsStore.setState((state) => ({
        ui: {
          ...state.ui,
          ...event.data.ui,
          productionPanelOpen: state.ui.productionPanelOpen,
          drawer: state.ui.drawer,
        },
        production: { ...state.production, ...event.data.production },
        alerts: event.data.alerts,
        tasks: event.data.tasks,
        audit: event.data.audit,
      }));
      applyingRemote = false;
    };
  }
  const unsubscribe = operationsStore.subscribe((state) => {
    const snapshot = persistedSnapshot(state);
    localStorage.setItem(persistedStateKey, JSON.stringify(snapshot));
    if (!applyingRemote) broadcast?.postMessage(snapshot);
  });
  return () => {
    unsubscribe();
    broadcast?.close();
  };
}
