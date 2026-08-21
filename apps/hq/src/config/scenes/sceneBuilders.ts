import {
  parseSceneDefinition,
  type ModulePresetConfig,
  type SceneDefinitionInput,
} from '@gremuchaya/config';
import type { SceneCue, SceneDefinition, ScreenId } from '@gremuchaya/domain';

interface MapPresetOptions {
  readonly assetId: string;
  readonly title: string;
  readonly markerLabel?: string;
  readonly address?: string;
  readonly speed?: string;
  readonly signal?: string;
  readonly x?: number;
  readonly y?: number;
}

interface SatellitePresetOptions {
  readonly assetId: string;
  readonly mode: 'ACQUIRE' | 'ZOOM' | 'TRACK' | 'DEGRADED' | 'LOST';
  readonly targetLabel?: string;
  readonly zoom?: number;
  readonly quality?: number;
  readonly lossStage?: 'clean' | 'light' | 'heavy' | 'lost';
}

interface CctvPresetOptions {
  readonly assetId: string;
  readonly cameraId: string;
  readonly location: string;
  readonly timestamp?: string;
  readonly archive?: boolean;
  readonly mosaic?: readonly string[];
}

export function defineScene(input: SceneDefinitionInput): SceneDefinition {
  return parseSceneDefinition(input);
}

export function setModuleCue(
  id: string,
  label: string,
  screenId: ScreenId,
  preset: ModulePresetConfig,
): SceneCue {
  return {
    id,
    label,
    action: {
      type: 'SET_MODULE',
      screenId,
      module: preset.module,
      payload: preset.payload,
    },
  };
}

export function patchCue(
  id: string,
  label: string,
  screenId: ScreenId,
  payload: Readonly<Record<string, unknown>>,
): SceneCue {
  return { id, label, action: { type: 'PATCH_MODULE', screenId, payload } };
}

export function blackoutCue(id: string, label: string, enabled: boolean): SceneCue {
  return { id, label, action: { type: 'SET_BLACKOUT', enabled } };
}

export function idlePreset(title = 'ОПЕРАТИВНЫЙ КОНТУР'): ModulePresetConfig {
  return { module: 'idle', payload: { preset: 'hq-default', title } };
}

export function mapPreset(options: MapPresetOptions): ModulePresetConfig {
  return {
    module: 'map',
    payload: {
      mapAsset: options.assetId,
      title: options.title,
      markers: [
        {
          id: 'object-01',
          x: options.x ?? 0.52,
          y: options.y ?? 0.48,
          label: options.markerLabel ?? 'ОБЪЕКТ 01',
          active: true,
          pulse: true,
        },
      ],
      readout: {
        object: options.markerLabel ?? 'ОБЪЕКТ 01',
        speed: options.speed ?? '0 КМ/Ч',
        signal: options.signal ?? 'УСТОЙЧИВЫЙ',
        ...(options.address === undefined ? {} : { address: options.address }),
      },
    },
  };
}

export function satellitePreset(options: SatellitePresetOptions): ModulePresetConfig {
  return {
    module: 'satellite',
    payload: {
      assetId: options.assetId,
      mode: options.mode,
      monochrome: true,
      zoom: options.zoom ?? 1,
      target: { x: 0.51, y: 0.47, label: options.targetLabel ?? 'ОБЪЕКТ 01' },
      coordinates: '59.8124 / 30.3917',
      signalQuality: options.quality ?? 92,
      sensorLabel: 'OPTICAL / LOCAL',
      lossStage: options.lossStage ?? 'clean',
    },
  };
}

export function cctvPreset(options: CctvPresetOptions): ModulePresetConfig {
  return {
    module: 'cctv',
    payload: {
      cameraId: options.cameraId,
      location: options.location,
      timestamp: options.timestamp ?? '14.09.2026 14:17:32',
      assetId: options.assetId,
      archive: options.archive ?? false,
      muted: true,
      playing: true,
      ...(options.mosaic === undefined ? {} : { mosaic: [...options.mosaic], selectedCamera: 0 }),
    },
  };
}

export function dossierPreset(
  entityId: string,
  displayName: string,
  options?: {
    readonly status?: string;
    readonly category?: string;
    readonly summary?: string;
    readonly facts?: readonly string[];
    readonly assets?: readonly string[];
  },
): ModulePresetConfig {
  return {
    module: 'dossier',
    payload: {
      entityId,
      displayName,
      status: options?.status ?? 'МАТЕРИАЛЫ ПРОВЕРЕНЫ',
      category: options?.category ?? 'ОБЪЕКТ',
      summary: options?.summary ?? 'Оперативная карточка. Данные сверены с материалами проекта.',
      facts: [...(options?.facts ?? [])],
      portraitAssetIds: [...(options?.assets ?? [])],
      relatedMaterials: ['ФОТО', 'СВЯЗИ', 'СОБЫТИЯ'],
    },
  };
}

export function osintPreset(
  query: string,
  stage: 'SEARCH' | 'RESULTS' | 'PROFILE' | 'PHOTO' | 'SELECT',
  assetIds: readonly string[],
): ModulePresetConfig {
  return {
    module: 'osint',
    payload: {
      query,
      stage,
      title: 'ПОИСК В ОТКРЫТЫХ ИСТОЧНИКАХ',
      profileName: query,
      assetIds: [...assetIds],
      results: assetIds.map((assetId, index) => ({
        id: `result-${index + 1}`,
        title: `МАТЕРИАЛ ${String(index + 1).padStart(2, '0')}`,
        metadata: 'АРХИВ / ОТКРЫТЫЙ ИСТОЧНИК',
        assetId,
      })),
    },
  };
}

export function facePreset(
  state: 'IDLE' | 'DETECT' | 'COMPARE' | 'MATCH' | 'NO_MATCH',
  candidateName: string,
  sourceAssetId: string,
  archiveAssetId: string,
  similarity?: number,
): ModulePresetConfig {
  return {
    module: 'face-recognition',
    payload: {
      state,
      sourceAssetId,
      archiveAssetId,
      candidateName,
      ...(similarity === undefined ? {} : { similarity }),
      sourceBox: { x: 0.31, y: 0.2, width: 0.22, height: 0.36 },
    },
  };
}

export function vehiclePreset(assetId: string, activeLabel: string): ModulePresetConfig {
  return {
    module: 'vehicle-recognition',
    payload: {
      assetId,
      title: 'РАСПОЗНАВАНИЕ ТРАНСПОРТА',
      vehicles: [
        {
          id: 'vehicle-03',
          label: 'ОБЪЕКТ 03',
          class: 'СЕДАН',
          direction: 'ЮГО-ВОСТОК',
          timestamp: '14:17:39',
          active: false,
          x: 0.18,
          y: 0.45,
          width: 0.14,
          height: 0.18,
        },
        {
          id: 'vehicle-07',
          label: activeLabel,
          class: 'ВНЕДОРОЖНИК',
          direction: 'СЕВЕР',
          timestamp: '14:17:42',
          active: true,
          x: 0.58,
          y: 0.38,
          width: 0.18,
          height: 0.2,
        },
      ],
    },
  };
}

export function commsPreset(
  target: string,
  status: 'RINGING' | 'CONNECTING' | 'CONNECTED' | 'ENDED',
): ModulePresetConfig {
  return {
    module: 'comms',
    payload: {
      target,
      source: 'НЕ ОПРЕДЕЛЁН',
      status,
      intercept: true,
      hops: [
        { label: 'NODE-03', x: 0.17, y: 0.63 },
        { label: 'NODE-11', x: 0.46, y: 0.39 },
        { label: 'TARGET', x: 0.76, y: 0.54 },
      ],
    },
  };
}

export function graphPreset(expanded: boolean): ModulePresetConfig {
  const nodes = [
    { id: 'phone-01', label: '+7 ••• 0142', kind: 'phone' as const, x: 0.2, y: 0.52, active: true },
    { id: 'person-01', label: 'ОБЪЕКТ 01', kind: 'person' as const, x: 0.46, y: 0.25 },
    { id: 'phone-02', label: '+7 ••• 7811', kind: 'phone' as const, x: 0.72, y: 0.48 },
    { id: 'location-01', label: 'УЗЕЛ 04', kind: 'location' as const, x: 0.45, y: 0.76 },
  ];
  const expandedNodes = expanded
    ? [
        ...nodes,
        { id: 'phone-03', label: '+7 ••• 2207', kind: 'phone' as const, x: 0.12, y: 0.18 },
        { id: 'person-02', label: 'ОБЪЕКТ 04', kind: 'person' as const, x: 0.84, y: 0.22 },
        { id: 'vehicle-01', label: 'ТРАНСПОРТ 07', kind: 'vehicle' as const, x: 0.82, y: 0.76 },
        { id: 'phone-04', label: '+7 ••• 9910', kind: 'phone' as const, x: 0.25, y: 0.84 },
      ]
    : nodes;
  return {
    module: 'graph',
    payload: {
      title: 'СХЕМА ТЕЛЕФОННЫХ СВЯЗЕЙ',
      stage: expanded ? 'РАСШИРЕННАЯ ВЫБОРКА' : 'ПЕРВИЧНАЯ ВЫБОРКА',
      nodes: expandedNodes,
      edges: expandedNodes.slice(1).map((node, index) => ({
        from: index % 2 === 0 ? 'phone-01' : 'person-01',
        to: node.id,
        weight: index + 1,
        active: index < 3,
      })),
    },
  };
}

export function photoArchivePreset(
  title: string,
  assetIds: readonly string[],
  selectedIndex = 0,
  comparison = false,
): ModulePresetConfig {
  return {
    module: 'photo-archive',
    payload: { title, assetIds: [...assetIds], selectedIndex, comparison },
  };
}

export function newsPreset(title: string, assetId?: string): ModulePresetConfig {
  return {
    module: 'news',
    payload: {
      title,
      mode: 'LIVE',
      lowerThird: 'ОПЕРАТИВНАЯ ИНФОРМАЦИЯ',
      ...(assetId === undefined ? {} : { assetId }),
    },
  };
}

export function interrogationPreset(assetId: string, room = 'КОМНАТА 07'): ModulePresetConfig {
  return {
    module: 'interrogation',
    payload: {
      room,
      assetId,
      timestamp: '19.09.2026 14:32:17',
      playing: true,
      audioChannel: 'MIC-02',
    },
  };
}

export function audioPreset(recording = true): ModulePresetConfig {
  return {
    module: 'audio',
    payload: {
      channels: [
        {
          id: 'mic-01',
          label: 'ROOM / L',
          level: 0.58,
          waveform: [0.1, 0.4, -0.2, 0.7, -0.5, 0.2],
        },
        {
          id: 'mic-02',
          label: 'ROOM / R',
          level: 0.42,
          waveform: [-0.2, 0.2, 0.5, -0.3, 0.4, 0.1],
        },
      ],
      timestamp: '14:32:17:12',
      recording,
    },
  };
}

export function securityPreset(
  status: 'ONLINE' | 'LINK DISABLED' | 'RECONNECTING',
): ModulePresetConfig {
  return {
    module: 'security',
    payload: {
      cameraId: 'CAM HQ-01',
      status,
      assetId: 'cctv-hq-internal',
      ...(status === 'RECONNECTING' ? { attempt: 1 } : {}),
    },
  };
}

export function systemTablePreset(title: string): ModulePresetConfig {
  return {
    module: 'system-tables',
    payload: {
      title,
      columns: ['ВРЕМЯ', 'УЗЕЛ', 'СОСТОЯНИЕ', 'КАНАЛ'],
      rows: [
        ['14:32:11', 'CH-04', 'ВИДЕОКАНАЛ ПРИНЯТ', '03'],
        ['14:32:14', 'NODE-17', 'СИНХРОНИЗАЦИЯ', '07'],
        ['14:32:18', 'ARCH-02', 'ПОИСК ЗАВЕРШЁН', '02'],
        ['14:32:21', 'LINK-05', 'СИГНАЛ УСТОЙЧИВЫЙ', '05'],
      ],
    },
  };
}

export function printPreset(
  status: 'QUEUED' | 'SENDING' | 'PRINTING' | 'PRINTED' | 'FAILED',
): ModulePresetConfig {
  const progressByStatus = { QUEUED: 0, SENDING: 28, PRINTING: 72, PRINTED: 100, FAILED: 0 };
  return {
    module: 'print',
    payload: {
      jobId: 'JOB 031',
      documentLabel: 'PHOTO / ОБУХОВ',
      status,
      progress: progressByStatus[status],
    },
  };
}

export function explorerPreset(path: string): ModulePresetConfig {
  return { module: 'explorer', payload: { path, takeover: false } };
}
