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
  OpsSeverity,
  OpsTask,
  Person,
  Sector,
  Sensor,
  SystemNode,
  TacticalRoute,
  TelemetrySeverityKind,
} from '@gremuchaya/domain';
import {
  applyDraftPatch,
  createFactorySnapshot,
  createSettingsDraft,
  createSettingsDraftCheckpoint,
  exportDraft,
  getSettingDefinition,
  importDraft,
  publishDraft,
  resetDraftAll,
  resetDraftCategory,
  restoreSettingsDraft,
} from '@gremuchaya/settings-schema';
import type {
  SettingCategory,
  SettingsDraft,
  SettingsPatch,
  SettingsSnapshot,
  SimulationChannelName,
} from '@gremuchaya/settings-schema';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';

import {
  patchContentOverrides,
  projectContentOverrides,
  sanitizeContentOverrides,
  type ContentOverrides,
  type ContentPatch,
} from '../application/edit/contentFields';
import { booleanSetting, numberSetting } from '../application/personalization/settingValue';
import {
  curvePhaseAt,
  deterministicOffset,
  readSimulationSettings,
  sessionMetricChannels,
  sessionMetricNames,
  simulateChannelReading,
  simulationChannelRanges,
  type ChannelReading,
  type SessionMetricName,
} from '../application/simulation/simulationCurves';
import {
  initialConnectionState,
  type ConnectionState,
  type ControlPlaneLinkState,
} from '../application/sync/connection';
import { withLinkPatch, withLinksIdle } from '../application/sync/controlPlaneLinks';
import { publishGroupSettings } from '../application/sync/groupSettingsBus';
import { publishLiveEdit } from '../infrastructure/browser/LiveEditBus';
import { operationsSeed } from '../data/operationsSeed';
import {
  createSettingsHistoryEntry,
  type ContentHistoryCheckpoint,
  type SettingsHistoryEntry,
  type SettingsHistoryEntryInput,
} from '../infrastructure/settings/SettingsHistoryLedger';

// The union is also needed at runtime: `localStorage` is a trust boundary, and
// a persisted route has to be checked against the real set before it is
// applied. Deriving the type from the value keeps the two from drifting.
export const operationsRoutes = [
  'overview',
  'objects',
  'object-detail',
  'cases',
  'case-detail',
  'map',
  'video',
  'cameras',
  'video-archive',
  'communications',
  'files',
  'archive',
  'analytics',
  'reports',
  'search',
  'settings',
  'system',
  'ui-gallery',
] as const;

export type OperationsRoute = (typeof operationsRoutes)[number];

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

/**
 * Edit-mode session state.
 *
 * Deliberately separate from `personalization`, which already owns the draft,
 * undo/redo stacks and history: edit mode is a lens over that draft, not a
 * second copy of it. Only what personalization has no place for lives here.
 *
 * Deliberately absent from `persistedSnapshot`. Reopening the application in
 * edit mode would be a surprise, and a stale selection would point at an
 * element that may no longer exist.
 */
interface EditModeState {
  readonly active: boolean;
  /** Empty string rather than undefined, matching the other selections here. */
  readonly selectedElementId: string;
  readonly dockEdge: EditDockEdge;
}

export type EditDockEdge = 'left' | 'right' | 'top' | 'bottom';

/**
 * Domain-content edits made from edit mode (R4).
 *
 * The overrides are the record; the world entities they name are the
 * projection every screen reads. Kept beside the world rather than inside
 * `personalization`, because a case's date is not a setting and does not
 * publish, export or reset with the settings draft -- it shares only the
 * ledger, the undo stack and the issue draft with them.
 *
 * Persisted, and applied again over the seed on the next launch: an edit is
 * the operator's decision about the content, and it outlives the session the
 * way a setting does.
 */
interface ContentEditState {
  readonly overrides: ContentOverrides;
}

/**
 * One material this operator imported, as the whole application sees it (R1, R2).
 *
 * Before this the record of an import lived in `FilesScreen`'s React state and
 * was rebuilt from the library each time the hidden dialog opened, so a
 * material imported five minutes ago was invisible to the registry, to the
 * video screen and to the next launch, and the operator's chosen category
 * survived only as a tag on a bridge object. This is the record; the library
 * still owns the bytes.
 *
 * `byteSize` is a decimal string and not a `bigint` on purpose. The slice is
 * persisted through `JSON.stringify`, which throws on a `bigint` rather than
 * dropping it, so one imported material would have taken the whole persisted
 * blob down with it. `toMaterialEntry` converts back at the seam that needs the
 * wire type.
 */
export interface ImportedMaterial {
  readonly materialId: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: string;
  readonly contentHash: string;
  readonly createdAt: string;
  /** The operator's reading of the content, from the import dialog. */
  readonly category: string;
  /** Which library holds the bytes: `local-mirror` or `group-library`. */
  readonly origin: string;
  readonly importedAt: string;
}

interface MaterialLibraryState {
  readonly imported: Readonly<Record<string, ImportedMaterial>>;
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
  /**
   * Milliseconds the run has actually spent, which is what the curves are read
   * at. Counted rather than derived from the step, because the cadence is a
   * setting and a run that changed it mid-session would otherwise jump.
   */
  readonly elapsedMs: number;
  /**
   * The moment the last tick was handed, or `null` before the first one.
   *
   * The store never asks a clock for it: `simulationTick` takes the moment as
   * an argument, so a test drives the same run the shell does and a preview
   * served by the control plane lands on the same phase.
   */
  readonly tickAt: number | null;
}

/**
 * The last {@link metricsHistoryDepth} readings of each session counter (R31).
 *
 * Every sparkline in the application drew a literal array with one live value
 * appended, because there was nowhere a series could come from. This is that
 * place. It is bounded by construction — each push slices to the depth — so a
 * session left open overnight holds the same seven arrays it held at launch.
 *
 * Never persisted and never broadcast, for the reason a timer handle is not:
 * it describes a run, and a run does not survive its window.
 */
export type MetricsHistory = Readonly<Record<SessionMetricName, readonly number[]>>;

/**
 * How many readings each series keeps.
 *
 * Sixty is one minute at the default `simulation.updateIntervalMs`, and a
 * sparkline 100 units wide cannot separate more than that anyway.
 */
export const metricsHistoryDepth = 60;

/**
 * How much simulated time passes between two generated events.
 *
 * Tied to the run's own clock rather than to the tick, so raising the sample
 * rate makes the series smoother without making the operational log noisier.
 */
const simulationEventIntervalMs = 15_000;

/** The four telemetry bands in order, so the worst of a set can be picked. */
const severityRank: Readonly<Record<TelemetrySeverityKind, number>> = {
  normal: 0,
  elevated: 1,
  degraded: 2,
  critical: 3,
};

/**
 * How a telemetry band reads in the operational log.
 *
 * The log's `info` means "not a reading at all", so the two lower bands both
 * arrive as `normal`. With no criticality curve drawn there is no criticality,
 * and every generated event is `normal` — which is the honest reading of an
 * empty curve, where the counter this replaced marked every ninth tick a
 * warning for no reason but its own arithmetic.
 */
const eventSeverities: Readonly<Record<TelemetrySeverityKind, OpsSeverity>> = {
  normal: 'normal',
  elevated: 'normal',
  degraded: 'warning',
  critical: 'critical',
};

interface PersonalizationState {
  readonly published: SettingsSnapshot;
  readonly draft: SettingsDraft;
  readonly history: readonly SettingsHistoryEntry[];
  readonly undoStack: readonly SettingsHistoryEntry[];
  readonly redoStack: readonly SettingsHistoryEntry[];
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
  /** What this operator has imported, whichever library took the bytes (R1, R2). */
  readonly materials: MaterialLibraryState;
  readonly production: ProductionState;
  readonly personalization: PersonalizationState;
  readonly edit: EditModeState;
  readonly content: ContentEditState;
  /**
   * The synchronization group this session is in, if any (R27). Owned by
   * `ControlPlaneSession`, which is the only writer; components read it.
   * Never persisted and never broadcast: see `connection.ts`.
   */
  readonly connection: ConnectionState;
  readonly metrics: OperationsMetrics;
  /** What every sparkline plots: the bounded series behind {@link metrics} (R31). */
  readonly metricsHistory: MetricsHistory;
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
  readonly setVideoPlaying: (playing: boolean) => void;
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
  readonly enterEditMode: () => void;
  readonly exitEditMode: () => void;
  readonly selectEditElement: (id: string) => void;
  readonly dockEditPanel: (edge: EditDockEdge) => void;
  readonly applyContentPatch: (patches: readonly ContentPatch[]) => void;
  readonly resetContentEdits: () => void;
  readonly applySettingsPatch: (patches: readonly SettingsPatch[]) => void;
  readonly resetSettingsCategory: (category: SettingCategory) => void;
  readonly resetAllSettings: () => void;
  readonly discardSettingsDraft: () => void;
  readonly publishSettingsDraft: () => void;
  readonly undoSettingsDraft: () => void;
  readonly redoSettingsDraft: () => void;
  readonly restoreSettingsHistoryEntry: (id: string) => void;
  readonly exportSettingsDraft: () => string;
  readonly importSettingsDraft: (serialized: string) => void;
  /**
   * Moves the connection to what the session service now knows. A partial
   * patch rather than one action per field: every transition is decided in
   * the service, and the store only records it.
   */
  readonly patchConnection: (patch: Partial<ConnectionState>) => void;
  /**
   * Replaces one control-plane link's fields, leaving every other link alone.
   *
   * A device may hold more than one link to one group, and both report at the
   * same time: the near plane's socket says `live` while the cloud plane's feed
   * says `polling`. A generic `patchConnection` would need every caller to
   * read the list, map it and write it back, which is the same reducer written
   * once per caller. It is written here instead, where reducers live.
   */
  readonly patchConnectionLink: (
    linkId: string,
    patch: Partial<Omit<ControlPlaneLinkState, 'linkId'>>,
  ) => void;
  /**
   * Puts every link back to carrying nothing, keeping the addresses on show.
   *
   * What a link is -- its address, its role and what its control plane can do --
   * outlives a session; the socket, the sequence and the resync count do not.
   */
  readonly idleConnectionLinks: () => void;
  /**
   * Records one finished import. Written by the import dialog and by nothing
   * else; re-importing the same content replaces the record rather than adding
   * a second, because both libraries are content-addressed and a repeat import
   * is the same material under a possibly different category.
   */
  readonly recordImportedMaterial: (material: ImportedMaterial) => void;
  /** Drops one record. The bytes are the library's business, not this slice's. */
  readonly forgetImportedMaterial: (materialId: string) => void;
  readonly resetWorld: () => void;
  /**
   * Advances the world to `nowMs`.
   *
   * The moment is an argument and not a `Date.now()` inside the reducer: the
   * curve phase, the generated event's timestamp and the tracked object's
   * `lastSeenAt` all come from it, so a run is a pure function of the moments
   * it was handed and the settings it read. `OperationsRuntime` is the one
   * caller that supplies a real clock.
   */
  readonly simulationTick: (nowMs: number) => void;
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

/**
 * The seven counters at rest, before a single reading has been taken.
 *
 * Named separately from the state they go into so the history can be seeded
 * from them rather than from a second copy of the same seven numbers. The first
 * entry of each series is the reading at t=0, which is a measurement of the
 * world as it starts and not an invented sample.
 */
const seedMetrics: Readonly<Record<SessionMetricName, number>> = {
  cpu: 43,
  ram: 68,
  storage: 72,
  gpu: 31,
  networkIn: 284,
  networkOut: 118,
  readiness: 87,
};

/**
 * One value per session counter, in the roster's own order.
 *
 * The order is not decoration: it is the order sample indices are handed out
 * in, and the scatter of every series depends on it. The cast is over a record
 * the loop has just filled for every name the roster declares.
 */
function byMetric<Value>(
  produce: (name: SessionMetricName) => Value,
): Readonly<Record<SessionMetricName, Value>> {
  const record: Partial<Record<SessionMetricName, Value>> = {};
  for (const name of sessionMetricNames) record[name] = produce(name);
  return record as Record<SessionMetricName, Value>;
}

function seedMetricsHistory(): MetricsHistory {
  return byMetric((name): readonly number[] => [seedMetrics[name]]);
}

/** Appends one reading, dropping the oldest once the buffer is full. */
function pushReading(series: readonly number[], reading: number): readonly number[] {
  return [...series, reading].slice(-metricsHistoryDepth);
}

function createBaseState() {
  const publishedSettings = createFactorySnapshot();
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
    materials: { imported: {} as Readonly<Record<string, ImportedMaterial>> },
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
    personalization: {
      published: publishedSettings,
      draft: createSettingsDraft(publishedSettings),
      history: [],
      undoStack: [],
      redoStack: [],
    },
    edit: {
      active: false,
      selectedElementId: '',
      // `as const` matches the idiom already used for filesView here:
      // createBaseState has no declared return type, so a bare literal widens
      // to string and stops satisfying EditDockEdge.
      dockEdge: 'right' as const,
    },
    content: { overrides: {} as ContentOverrides },
    connection: initialConnectionState,
    metrics: {
      ...seedMetrics,
      simulationStep: 0,
      elapsedMs: 0,
      tickAt: null as number | null,
    },
    metricsHistory: seedMetricsHistory(),
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

let settingsMillisecond = 0;
let settingsSequence = 0;

/** Four digits hold every entry one millisecond can realistically produce. */
const settingsSequenceWidth = 4;

/**
 * The sequence is what keeps two ids apart within one millisecond. The history
 * list keys its rows by id and `restoreSettingsHistoryEntry` finds an entry by
 * it, and a content reset followed by a restore lands in the same tick.
 *
 * It is zero-padded and restarted on each new millisecond because the id is
 * also the tie-break `querySettingsHistory` sorts by when two entries share an
 * `at`, and that comparison is `localeCompare` over the whole string. An
 * unpadded counter put `-10` before `-9`, so from the tenth entry of a
 * millisecond onward the ledger listed that millisecond in the wrong order.
 * Restarting keeps the counter inside its width instead of letting a long
 * session walk past it and reintroduce the same ordering fault at `-10000`.
 */
function settingsMetadata(prefix: string): { readonly id: string; readonly at: string } {
  const now = Date.now();
  if (now === settingsMillisecond) settingsSequence += 1;
  else {
    settingsMillisecond = now;
    settingsSequence = 0;
  }
  return {
    // One clock reading for both, so the instant the id names and the instant
    // the entry is sorted by cannot disagree across a millisecond boundary.
    id: `${prefix}-${now}-${String(settingsSequence).padStart(settingsSequenceWidth, '0')}`,
    at: new Date(now).toISOString(),
  };
}

function appendSettingsHistory(
  state: PersonalizationState,
  entry: SettingsHistoryEntryInput,
  options: { readonly reversible: boolean; readonly redoStack?: readonly SettingsHistoryEntry[] },
): PersonalizationState {
  const historyEntry = createSettingsHistoryEntry(entry);
  /*
   * Both depths are read from the draft being amended rather than through a
   * hook: this reducer runs inside the store, where a hook cannot go, and the
   * values it needs are in the state it was handed.
   */
  const historyDepth = numberSetting(state.draft.values, 'advanced.historyDepth');
  const undoDepth = numberSetting(state.draft.values, 'advanced.undoDepth');
  return {
    ...state,
    history: [historyEntry, ...state.history].slice(0, historyDepth),
    undoStack: options.reversible
      ? [...state.undoStack, historyEntry].slice(-undoDepth)
      : state.undoStack,
    redoStack: options.redoStack ?? (options.reversible ? [] : state.redoStack),
  };
}

/**
 * Moves the content overrides to `candidate` and projects the move onto the
 * world: what the store has to set, and what the ledger records about it.
 *
 * The candidate is sanitized here rather than by each caller, because three of
 * the callers carry a checkpoint out of the persisted blob -- undo, redo and
 * restore all replay `entry.content`, and the ledger is hydrated verbatim.
 * A settings checkpoint is re-validated on the same click by
 * `parseSettingsSnapshot`; a content checkpoint has to be, too, or a key from
 * an older build, a value past its validator or an entity that no longer
 * exists would reach the world, be persisted and be broadcast to peers.
 */
function contentTransition(
  state: OperationsState,
  candidate: unknown,
): { readonly patch: Partial<OperationsState>; readonly record: ContentHistoryCheckpoint } {
  const overrides = sanitizeContentOverrides(candidate);
  return {
    patch: {
      ...projectContentOverrides(state, state.content.overrides, overrides),
      content: { overrides },
    },
    record: { before: state.content.overrides, after: overrides },
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
  setVideoPlaying: (videoPlaying) => set((state) => ({ ui: { ...state.ui, videoPlaying } })),
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
  enterEditMode: () => set((state) => ({ edit: { ...state.edit, active: true } })),

  exitEditMode: () =>
    // The selection belongs to one editing pass and is dropped with it. The
    // dock edge is where the operator parked the panel, so it survives.
    set((state) => ({ edit: { ...state.edit, active: false, selectedElementId: '' } })),

  selectEditElement: (id) => set((state) => ({ edit: { ...state.edit, selectedElementId: id } })),

  dockEditPanel: (edge) => set((state) => ({ edit: { ...state.edit, dockEdge: edge } })),

  applyContentPatch: (patches) =>
    set((state) => {
      // Throws for an unknown field, an unseeded entity or a refused value,
      // as applyDraftPatch does for a setting; the updater then never returns
      // and the state is untouched.
      const { overrides, changedIds } = patchContentOverrides(state.content.overrides, patches);
      const content = contentTransition(state, overrides);
      const checkpoint = createSettingsDraftCheckpoint(state.personalization.draft);
      const personalization = appendSettingsHistory(
        state.personalization,
        {
          ...settingsMetadata('SET-HISTORY'),
          operation: 'patch',
          // The category the settings about what the shell shows already
          // use: both are about the information on screen, and the history
          // filter has one list of categories.
          category: 'information',
          changedIds,
          // No setting moves. The checkpoints are the draft as it stands, so
          // restoring this entry through the ledger touches only content.
          before: checkpoint,
          after: checkpoint,
          content: content.record,
        },
        { reversible: true },
      );
      return {
        ...content.patch,
        personalization,
        audit: [auditEntry('ИЗМЕНЕНО СОДЕРЖИМОЕ', changedIds.join(',')), ...state.audit].slice(
          0,
          100,
        ),
      };
    }),

  resetContentEdits: () =>
    set((state) => {
      const changedIds = Object.keys(state.content.overrides);
      if (changedIds.length === 0) return state;
      const content = contentTransition(state, {});
      const checkpoint = createSettingsDraftCheckpoint(state.personalization.draft);
      const personalization = appendSettingsHistory(
        state.personalization,
        {
          ...settingsMetadata('SET-HISTORY'),
          operation: 'reset-category',
          category: 'information',
          changedIds,
          before: checkpoint,
          after: checkpoint,
          content: content.record,
        },
        { reversible: true },
      );
      return {
        ...content.patch,
        personalization,
        audit: [auditEntry('СБРОШЕНО СОДЕРЖИМОЕ', 'ALL'), ...state.audit].slice(0, 100),
      };
    }),

  applySettingsPatch: (patches) => {
    set((state) => {
      const before = createSettingsDraftCheckpoint(state.personalization.draft);
      const draft = applyDraftPatch(state.personalization.draft, patches, settingsMetadata('SET'));
      const personalization = appendSettingsHistory(
        { ...state.personalization, draft },
        {
          ...settingsMetadata('SET-HISTORY'),
          operation: 'patch',
          category: getSettingDefinition(patches[0]?.id ?? '')?.category,
          changedIds: patches.map((patch) => patch.id),
          before,
          after: createSettingsDraftCheckpoint(draft),
        },
        { reversible: true },
      );
      return {
        personalization,
        audit: [
          auditEntry('ОБНОВЛЁН ЧЕРНОВИК НАСТРОЕК', patches.map((patch) => patch.id).join(',')),
          ...state.audit,
        ].slice(0, 100),
      };
    });
    // R27: the change reaches the other sessions of the group, and only them.
    // Outside `set` because sending is an effect and a Zustand updater has to
    // stay a pure function of the previous state -- and after it, so a patch
    // `applyDraftPatch` refused is never announced as applied. The opt-in that
    // decides whether anything travels is `advanced.liveEdit`, read by
    // `EditModeRuntime`, which connects a transport only while the group has
    // enabled it; with nothing connected this call does nothing at all.
    publishLiveEdit(patches);
    // R6, the group half: a group-scoped change is also what the group agreed,
    // and `SettingsService` is where that is recorded. `publishGroupSettings`
    // filters to the five group-scoped definitions and does nothing at all
    // without a session, so a local-only client makes no call.
    publishGroupSettings(patches);
  },
  resetSettingsCategory: (category) =>
    set((state) => {
      const before = createSettingsDraftCheckpoint(state.personalization.draft);
      const draft = resetDraftCategory(
        state.personalization.draft,
        category,
        settingsMetadata('SET-CATEGORY-RESET'),
      );
      const personalization = appendSettingsHistory(
        { ...state.personalization, draft },
        {
          ...settingsMetadata('SET-HISTORY'),
          operation: 'reset-category',
          category,
          changedIds: draft.history.at(-1)?.changedIds ?? [],
          before,
          after: createSettingsDraftCheckpoint(draft),
        },
        { reversible: true },
      );
      return {
        personalization,
        audit: [auditEntry('СБРОШЕНА КАТЕГОРИЯ НАСТРОЕК', category), ...state.audit].slice(0, 100),
      };
    }),
  resetAllSettings: () =>
    set((state) => {
      const before = createSettingsDraftCheckpoint(state.personalization.draft);
      const draft = resetDraftAll(state.personalization.draft, settingsMetadata('SET-ALL-RESET'));
      const personalization = appendSettingsHistory(
        { ...state.personalization, draft },
        {
          ...settingsMetadata('SET-HISTORY'),
          operation: 'reset-all',
          changedIds: draft.history.at(-1)?.changedIds ?? [],
          before,
          after: createSettingsDraftCheckpoint(draft),
        },
        { reversible: true },
      );
      return {
        personalization,
        audit: [auditEntry('СБРОШЕН ВЕСЬ ЧЕРНОВИК НАСТРОЕК', 'ALL'), ...state.audit].slice(0, 100),
      };
    }),
  discardSettingsDraft: () =>
    set((state) => {
      const before = createSettingsDraftCheckpoint(state.personalization.draft);
      const draft = createSettingsDraft(state.personalization.published);
      const personalization = appendSettingsHistory(
        { ...state.personalization, draft },
        {
          ...settingsMetadata('SET-HISTORY'),
          operation: 'discard',
          changedIds: before.changedIds,
          before,
          after: createSettingsDraftCheckpoint(draft),
        },
        { reversible: true },
      );
      return {
        personalization,
        audit: [auditEntry('ОТМЕНЁН ЧЕРНОВИК НАСТРОЕК', 'DRAFT'), ...state.audit].slice(0, 100),
      };
    }),
  publishSettingsDraft: () =>
    set((state) => {
      const before = createSettingsDraftCheckpoint(state.personalization.draft);
      const published = publishDraft(state.personalization.draft);
      const draft = createSettingsDraft(published);
      const personalization = appendSettingsHistory(
        { ...state.personalization, published, draft },
        {
          ...settingsMetadata('SET-HISTORY'),
          operation: 'publish',
          changedIds: before.changedIds,
          before,
          after: createSettingsDraftCheckpoint(draft),
          publishedRevision: published.revision,
        },
        { reversible: false, redoStack: [] },
      );
      return {
        personalization,
        audit: [
          auditEntry('ОПУБЛИКОВАНЫ НАСТРОЙКИ', String(published.revision)),
          ...state.audit,
        ].slice(0, 100),
      };
    }),
  undoSettingsDraft: () =>
    set((state) => {
      const entry = state.personalization.undoStack.at(-1);
      if (entry === undefined) return state;
      const before = createSettingsDraftCheckpoint(state.personalization.draft);
      // A content entry changed no setting, so the draft is left alone and
      // what it changed goes back through the projection that applied it.
      const draft =
        entry.content === undefined
          ? restoreSettingsDraft(
              state.personalization.draft,
              entry.before,
              settingsMetadata('SET-UNDO'),
            )
          : state.personalization.draft;
      const content =
        entry.content === undefined ? null : contentTransition(state, entry.content.before);
      const personalization = appendSettingsHistory(
        {
          ...state.personalization,
          draft,
          undoStack: state.personalization.undoStack.slice(0, -1),
        },
        {
          ...settingsMetadata('SET-HISTORY'),
          operation: 'undo',
          category: entry.category,
          changedIds: entry.changedIds,
          before,
          after: createSettingsDraftCheckpoint(draft),
          ...(content === null ? {} : { content: content.record }),
        },
        {
          reversible: false,
          redoStack: [...state.personalization.redoStack, entry].slice(
            -numberSetting(state.personalization.draft.values, 'advanced.undoDepth'),
          ),
        },
      );
      return {
        ...(content === null ? {} : content.patch),
        personalization,
        audit: [auditEntry('ОТМЕНЕНО ИЗМЕНЕНИЕ НАСТРОЕК', entry.id), ...state.audit].slice(0, 100),
      };
    }),
  redoSettingsDraft: () =>
    set((state) => {
      const entry = state.personalization.redoStack.at(-1);
      if (entry === undefined) return state;
      const before = createSettingsDraftCheckpoint(state.personalization.draft);
      const draft =
        entry.content === undefined
          ? restoreSettingsDraft(
              state.personalization.draft,
              entry.after,
              settingsMetadata('SET-REDO'),
            )
          : state.personalization.draft;
      const content =
        entry.content === undefined ? null : contentTransition(state, entry.content.after);
      const personalization = appendSettingsHistory(
        {
          ...state.personalization,
          draft,
          redoStack: state.personalization.redoStack.slice(0, -1),
        },
        {
          ...settingsMetadata('SET-HISTORY'),
          operation: 'redo',
          category: entry.category,
          changedIds: entry.changedIds,
          before,
          after: createSettingsDraftCheckpoint(draft),
          ...(content === null ? {} : { content: content.record }),
        },
        { reversible: true },
      );
      return {
        ...(content === null ? {} : content.patch),
        personalization,
        audit: [auditEntry('ПОВТОРЕНО ИЗМЕНЕНИЕ НАСТРОЕК', entry.id), ...state.audit].slice(0, 100),
      };
    }),
  restoreSettingsHistoryEntry: (id) =>
    set((state) => {
      const entry = state.personalization.history.find((candidate) => candidate.id === id);
      if (entry === undefined) return state;
      const before = createSettingsDraftCheckpoint(state.personalization.draft);
      const draft =
        entry.content === undefined
          ? restoreSettingsDraft(
              state.personalization.draft,
              entry.after,
              settingsMetadata('SET-RESTORE'),
            )
          : state.personalization.draft;
      const content =
        entry.content === undefined ? null : contentTransition(state, entry.content.after);
      const personalization = appendSettingsHistory(
        { ...state.personalization, draft },
        {
          ...settingsMetadata('SET-HISTORY'),
          operation: 'restore',
          category: entry.category,
          changedIds: entry.changedIds,
          before,
          after: createSettingsDraftCheckpoint(draft),
          ...(content === null ? {} : { content: content.record }),
        },
        { reversible: true },
      );
      return {
        ...(content === null ? {} : content.patch),
        personalization,
        audit: [
          auditEntry('СОСТОЯНИЕ ИЗ ИСТОРИИ ЗАГРУЖЕНО В DRAFT', entry.id),
          ...state.audit,
        ].slice(0, 100),
      };
    }),
  exportSettingsDraft: () => exportDraft(get().personalization.draft),
  importSettingsDraft: (serialized) =>
    set((state) => {
      const before = createSettingsDraftCheckpoint(state.personalization.draft);
      const draft = importDraft(
        state.personalization.draft,
        serialized,
        settingsMetadata('SET-IMPORT'),
      );
      const personalization = appendSettingsHistory(
        { ...state.personalization, draft },
        {
          ...settingsMetadata('SET-HISTORY'),
          operation: 'import',
          changedIds: draft.history.at(-1)?.changedIds ?? [],
          before,
          after: createSettingsDraftCheckpoint(draft),
        },
        { reversible: true },
      );
      return {
        personalization,
        audit: [auditEntry('ИМПОРТИРОВАН ЧЕРНОВИК НАСТРОЕК', 'DRAFT'), ...state.audit].slice(
          0,
          100,
        ),
      };
    }),
  patchConnection: (patch) => set((state) => ({ connection: { ...state.connection, ...patch } })),
  patchConnectionLink: (linkId, patch) =>
    set((state) => ({
      connection: {
        ...state.connection,
        links: withLinkPatch(state.connection.links, linkId, patch),
      },
    })),
  idleConnectionLinks: () =>
    set((state) => ({
      connection: { ...state.connection, links: withLinksIdle(state.connection.links) },
    })),
  recordImportedMaterial: (material) =>
    set((state) => ({
      materials: {
        imported: { ...state.materials.imported, [material.materialId]: material },
      },
      audit: [auditEntry('ИМПОРТИРОВАН МАТЕРИАЛ', material.materialId), ...state.audit].slice(
        0,
        100,
      ),
    })),
  forgetImportedMaterial: (materialId) =>
    set((state) => {
      if (state.materials.imported[materialId] === undefined) return state;
      const { [materialId]: _dropped, ...imported } = state.materials.imported;
      return { materials: { imported } };
    }),
  resetWorld: () => {
    const base = createBaseState();
    // The connection outlives a world reset the way the snapshots do: the
    // group this session is in is not part of the simulated world, and the
    // session service that owns the slice is not told about the reset.
    // Imported materials outlive it for the stronger reason: they are real
    // files the operator put somewhere, and a reset of the simulation must not
    // be the act that loses the record of where they went.
    set({
      ...base,
      production: { ...base.production, snapshots: get().production.snapshots },
      connection: get().connection,
      materials: get().materials,
    });
  },
  simulationTick: (nowMs) =>
    set((state) => {
      if (state.production.paused) return state;
      const settings = readSimulationSettings(state.personalization.draft.values);
      const previousAt = state.metrics.tickAt;
      /*
       * The interval a tick actually spent, capped at four of the intervals it
       * asked for. A throttled background tab and a resumed pause both hand
       * back a gap of minutes; spending it would carry the curve past
       * everything the operator was watching, so four intervals absorbs
       * ordinary timer jitter and nothing longer.
       */
      const interval =
        previousAt === null ? 0 : clamp(nowMs - previousAt, 0, settings.updateIntervalMs * 4);
      const elapsedMs = state.metrics.elapsedMs + interval;
      const step = state.metrics.simulationStep + 1;
      const phase = curvePhaseAt(settings, elapsedMs);

      const nodes = Object.values(state.systemNodes);
      const links = Object.values(state.channels);
      /*
       * How far apart two consecutive samples of one series sit in the noise
       * generator's index space. Every series scatters from the one seed, so
       * without an ordinal of its own each would take the same offset at the
       * same step and the whole world would move in lockstep. The two spare
       * ordinals at the end belong to the tracked object's two axes.
       */
      const stride = sessionMetricNames.length + nodes.length * 2 + links.length * 3 + 2;
      let ordinal = 0;
      /*
       * One reading, and the next ordinal. Rounded to whole units because every
       * counter in this world is whole -- a percentage, a millisecond, a
       * megabyte per second -- and every screen prints it unformatted.
       */
      const read = (channel: SimulationChannelName, previous: number): ChannelReading => {
        const reading = simulateChannelReading(
          settings,
          channel,
          simulationChannelRanges[channel],
          phase,
          step * stride + ordinal,
          previous,
        );
        ordinal += 1;
        return { value: Math.round(reading.value), severity: reading.severity };
      };

      let worst: TelemetrySeverityKind = 'normal';
      const sampledMetrics = byMetric((name) => {
        const reading = read(sessionMetricChannels[name], state.metrics[name]);
        if (severityRank[reading.severity] > severityRank[worst]) worst = reading.severity;
        return reading.value;
      });
      const metricsHistory = byMetric((name): readonly number[] =>
        pushReading(state.metricsHistory[name], sampledMetrics[name]),
      );

      const systemNodes = Object.fromEntries(
        nodes.map((node) => [
          node.id,
          {
            ...node,
            load: read('node-load', node.load).value,
            temperature: read('node-temperature', node.temperature).value,
          },
        ]),
      );
      const channels = Object.fromEntries(
        links.map((channel) => [
          channel.id,
          {
            ...channel,
            load: read('link-load', channel.load).value,
            latency: read('link-latency', channel.latency).value,
            signal: read('link-signal', channel.signal).value,
          },
        ]),
      );

      const objects = { ...state.objects };
      const tracked = objects['K-17'];
      if (tracked !== undefined) {
        /*
         * The roster has no channel for a position, and adding one would say a
         * coordinate is a telemetry reading. The walk keeps its own arithmetic
         * and answers to `simulation.seed` alone. Every other object stays
         * where the seed put it, as it did before this.
         */
        objects['K-17'] = {
          ...tracked,
          position: {
            ...tracked.position,
            x: clamp(
              tracked.position.x +
                deterministicOffset(settings.seed, step * stride + stride - 2) * 0.32,
              4,
              96,
            ),
            y: clamp(
              tracked.position.y +
                deterministicOffset(settings.seed, step * stride + stride - 1) * 0.24,
              4,
              96,
            ),
          },
          lastSeenAt: new Date(nowMs).toISOString(),
        };
      }

      /*
       * One event per interval of run time, not per third tick. The cadence is
       * a setting now, and an operator who asked for a smoother series should
       * not get a log three times as long with it.
       */
      const generatedEvent: OpsEvent | null =
        Math.floor(elapsedMs / simulationEventIntervalMs) >
        Math.floor(state.metrics.elapsedMs / simulationEventIntervalMs)
          ? {
              id: `EV-LIVE-${step}`,
              type: 'object.updated',
              timestamp: new Date(nowMs).toISOString(),
              severity: eventSeverities[worst],
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
          ...sampledMetrics,
          simulationStep: step,
          elapsedMs,
          tickAt: nowMs,
        },
        metricsHistory,
      };
    }),
}));

export function useOperationsStore<Selection>(
  selector: (state: OperationsState) => Selection,
): Selection {
  return useStore(operationsStore, useShallow(selector));
}

interface PersistedOperationsState {
  readonly version: 4 | 5;
  readonly ui: OperationsUiState;
  readonly production: Omit<ProductionState, 'snapshots'>;
  readonly alerts: Readonly<Record<string, Alert>>;
  readonly tasks: Readonly<Record<string, OpsTask>>;
  /** Absent when `privacy.persistAudit` is off; hydration falls back to the seed. */
  readonly audit?: readonly OpsAuditEntry[];
  /** Absent in a blob written before R4; hydration then applies no content edits. */
  readonly content?: ContentEditState;
  /** Absent in a blob written before F9; hydration then knows of no imports. */
  readonly materials?: MaterialLibraryState;
  readonly personalization: PersonalizationState;
}

function persistedSnapshot(state: OperationsState): PersistedOperationsState {
  const { snapshots: _snapshots, ...production } = state.production;
  return {
    version: 5,
    ui: state.ui,
    production,
    alerts: state.alerts,
    tasks: state.tasks,
    content: state.content,
    /*
     * Imports are written whatever `startup.restoreWorld` says, and read back
     * the same way. That setting governs what the simulation did -- alerts,
     * tasks, the trail -- and an imported file is not something the simulation
     * did. Losing the record on the next launch would leave bytes in a library
     * with nothing in the application pointing at them.
     */
    materials: state.materials,
    /*
     * `privacy.persistAudit` omits the key rather than writing an empty array:
     * an empty trail read back would look like a session that did nothing,
     * where an absent one is a session that chose not to keep a record. The
     * trail names what this operator opened, entry by entry.
     */
    ...(booleanSetting(state.personalization.draft.values, 'privacy.persistAudit')
      ? { audit: state.audit }
      : {}),
    personalization: state.personalization,
  };
}

/**
 * What one session tells the others.
 *
 * The same shape as the persisted blob minus personalization. Storage is
 * per-origin and every session on this machine reads it on load, which is what
 * makes a preference survive a restart; the broadcast is what makes another
 * session change *now*, and that is the act `advanced.liveEdit` exists to gate.
 *
 * Leaving personalization in here meant the gate governed nothing: a theme
 * changed on one screen reached every other one immediately, with the opt-in
 * off and no record of the change on the receiving side.
 */
function broadcastSnapshot(
  state: OperationsState,
): Omit<PersistedOperationsState, 'personalization'> {
  const { personalization: _personalization, ...world } = persistedSnapshot(state);
  return world;
}

function hydratePersonalization(
  persisted: PersonalizationState,
  fallback: PersonalizationState,
): PersonalizationState {
  return {
    published: persisted.published,
    draft: persisted.draft,
    history: persisted.history ?? fallback.history,
    undoStack: persisted.undoStack ?? fallback.undoStack,
    redoStack: persisted.redoStack ?? fallback.redoStack,
  };
}

/**
 * The imported-material record as it comes back from a blob or a peer.
 *
 * Both are trust boundaries: the key is editable in a browser's devtools and
 * the channel is open to every same-origin session. Every field is checked,
 * `byteSize` against the decimal form it is written in, so a hand-edited entry
 * cannot reach the registry as an attachment with a `NaN` size or a missing id.
 */
function isImportedMaterial(value: unknown): value is ImportedMaterial {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const byteSize = candidate['byteSize'];
  return (
    typeof candidate['materialId'] === 'string' &&
    candidate['materialId'].length > 0 &&
    typeof candidate['displayName'] === 'string' &&
    typeof candidate['mimeType'] === 'string' &&
    typeof byteSize === 'string' &&
    /^\d+$/u.test(byteSize) &&
    typeof candidate['contentHash'] === 'string' &&
    typeof candidate['createdAt'] === 'string' &&
    typeof candidate['category'] === 'string' &&
    typeof candidate['origin'] === 'string' &&
    typeof candidate['importedAt'] === 'string'
  );
}

function sanitizeImportedMaterials(value: unknown): MaterialLibraryState | undefined {
  const record = (value as MaterialLibraryState | undefined)?.imported;
  if (typeof record !== 'object' || record === null) return undefined;
  const imported: Record<string, ImportedMaterial> = {};
  for (const [materialId, entry] of Object.entries(record)) {
    // The key and the record have to agree: a blob whose key names one material
    // and whose body names another would put the registry and the library out
    // of step in a way no screen could notice.
    if (isImportedMaterial(entry) && entry.materialId === materialId) imported[materialId] = entry;
  }
  return { imported };
}

function isCoordinate(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === 'number')
  );
}

function isMapLayerRecord(value: unknown): value is Readonly<Record<MapLayer, boolean>> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  // `mapLayers` is the defaults object declared above; its keys are the union.
  return Object.keys(mapLayers).every((layer) => typeof candidate[layer] === 'boolean');
}

function isProductionSnapshot(value: unknown): value is ProductionSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const activeAlertIds = candidate['activeAlertIds'];
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['name'] === 'string' &&
    typeof candidate['createdAt'] === 'string' &&
    operationsRoutes.some((route) => route === candidate['route']) &&
    typeof candidate['selectedObjectId'] === 'string' &&
    typeof candidate['selectedCameraId'] === 'string' &&
    typeof candidate['selectedCaseId'] === 'string' &&
    isCoordinate(candidate['mapCenter']) &&
    typeof candidate['mapZoom'] === 'number' &&
    isMapLayerRecord(candidate['mapLayers']) &&
    Array.isArray(activeAlertIds) &&
    activeAlertIds.every((id) => typeof id === 'string') &&
    typeof candidate['preset'] === 'string' &&
    typeof candidate['simulationPaused'] === 'boolean' &&
    typeof candidate['fixedTime'] === 'string'
  );
}

function hydratePersistedState(): void {
  const stored = localStorage.getItem(persistedStateKey);
  if (stored === null) return;
  try {
    const parsed = JSON.parse(stored) as Partial<PersistedOperationsState>;
    const personalization = parsed.personalization;
    if (
      (parsed.version === 4 || parsed.version === 5) &&
      parsed.ui !== undefined &&
      parsed.production !== undefined &&
      personalization !== undefined
    ) {
      /*
       * `startup.restoreWorld` is read from the blob being hydrated, not from
       * the store: the values it needs are not in the store yet at this point,
       * so a reader that went through the store would answer with the factory
       * default on the launch that matters. `resolveSettingValue` is pure over
       * a values record, which is exactly what this call site has.
       */
      const restoreWorld = booleanSetting(
        personalization?.draft?.values ?? {},
        'startup.restoreWorld',
      );
      operationsStore.setState((state) => ({
        ui: { ...state.ui, ...parsed.ui, productionPanelOpen: false, drawer: null },
        production: { ...state.production, ...parsed.production },
        alerts: restoreWorld ? (parsed.alerts ?? state.alerts) : state.alerts,
        tasks: restoreWorld ? (parsed.tasks ?? state.tasks) : state.tasks,
        audit: restoreWorld ? (parsed.audit ?? state.audit) : state.audit,
        personalization: hydratePersonalization(personalization, state.personalization),
        materials: sanitizeImportedMaterials(parsed.materials) ?? state.materials,
        /*
         * Content edits come back regardless of `startup.restoreWorld`. That
         * setting names alerts, tasks and the audit trail -- what the session
         * did -- where a date the operator corrected is a decision, kept the
         * way a setting is. The blob is a trust boundary; `contentTransition`
         * sanitizes what it is handed, so a key from an older build or a
         * hand-edited value cannot reach the world through any of its callers.
         */
        ...contentTransition(state, parsed.content?.overrides).patch,
      }));
    }
  } catch {
    localStorage.removeItem(persistedStateKey);
  }
}

function hydratePersistedSnapshots(): void {
  const raw = localStorage.getItem(snapshotStateKey);
  if (raw === null) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(snapshotStateKey);
      return;
    }
    // The list used to be cast straight from `JSON.parse`, so anything at all
    // could enter the store through this key.
    const snapshots = parsed.filter(isProductionSnapshot);
    operationsStore.setState((state) => ({ production: { ...state.production, snapshots } }));
  } catch {
    // Each key recovers itself. One shared catch used to remove only
    // `persistedStateKey`, so a corrupt snapshot blob outlived every reload and
    // threw again on the next one.
    localStorage.removeItem(snapshotStateKey);
  }
}

export function initializeOperationsClient(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  hydratePersistedState();
  hydratePersistedSnapshots();

  /*
   * `advanced.worldSync` refuses the channel rather than filtering what crosses
   * it. A gate on `postMessage` alone would still leave this session applying
   * every other session's world, which is half a switch.
   */
  const worldSyncAllowed = booleanSetting(
    operationsStore.getState().personalization.draft.values,
    'advanced.worldSync',
  );
  const broadcast =
    typeof BroadcastChannel === 'undefined' || !worldSyncAllowed
      ? null
      : new BroadcastChannel(channelName);
  let applyingRemote = false;
  if (broadcast !== null) {
    broadcast.onmessage = (
      event: MessageEvent<Omit<PersistedOperationsState, 'personalization'>>,
    ) => {
      if (event.data.version !== 4 && event.data.version !== 5) return;
      // Timed playback is ordered by PlaybackSyncCoordinator. Applying these
      // transient fields from the general world snapshot would race the
      // scheduled epoch/sequence command and reintroduce timing drift.
      const {
        videoPlaying: _videoPlaying,
        videoLive: _videoLive,
        videoPosition: _videoPosition,
        ...remoteUi
      } = event.data.ui;
      applyingRemote = true;
      operationsStore.setState((state) => ({
        ui: {
          ...state.ui,
          ...remoteUi,
          productionPanelOpen: state.ui.productionPanelOpen,
          drawer: state.ui.drawer,
        },
        production: { ...state.production, ...event.data.production },
        alerts: event.data.alerts,
        tasks: event.data.tasks,
        // A peer that keeps no trail sends none; this session keeps its own
        // rather than adopting an emptiness the peer never meant to share.
        audit: event.data.audit ?? state.audit,
        // Imports travel with the world: two screens of one machine read the
        // same libraries, so a file imported on one is a file the other can
        // open. The same sanitizer as hydration, because the channel is open to
        // every same-origin session and is no more trusted than the blob.
        materials: sanitizeImportedMaterials(event.data.materials) ?? state.materials,
        // Content edits are world, not personalization: a date corrected on
        // one screen is the date on every screen of the group, which is what
        // `advanced.worldSync` -- the gate on this channel -- is for.
        //
        // Absent means the peer said nothing about content, the same reading
        // `audit` gets two lines up. A session on a build from before R4
        // broadcasts no `content` member at all, and taking that for "the
        // peer has none" made it erase the edits of a session on a newer
        // build -- and the erasure was then written to storage by the
        // subscriber below. An explicit `{ overrides: {} }` still clears: a
        // peer that reset its content said so, where an omission says nothing.
        ...(event.data.content === undefined
          ? {}
          : contentTransition(state, event.data.content.overrides).patch),
        // Personalization is deliberately not taken from the world snapshot.
        // `advanced.liveEdit` is the opt-in that decides whether a settings
        // change reaches the other sessions, and it defaults to off — but this
        // snapshot carried the whole personalization state to every same-origin
        // session on every store change, so the opt-in governed nothing and
        // "off" meant "off except through here". Live settings now travel only
        // through the gated live-edit channel.
      }));
      applyingRemote = false;
    };
  }
  const unsubscribe = operationsStore.subscribe((state) => {
    localStorage.setItem(persistedStateKey, JSON.stringify(persistedSnapshot(state)));
    if (!applyingRemote) broadcast?.postMessage(broadcastSnapshot(state));
  });
  return () => {
    unsubscribe();
    broadcast?.close();
  };
}
