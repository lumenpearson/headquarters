const sceneIdPattern = /^s\d{2}-\d{1,3}[a-z]?$/u;
const assetIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const screenIds = [
  'hwan-main',
  'hwan-map',
  'hwan-comms',
  'wall-center',
  'wall-left',
  'wall-right',
  'kirillov-desk',
  'interrogation-video',
  'interrogation-audio',
] as const;

export type ScreenId = (typeof screenIds)[number];

export const moduleIds = [
  'idle',
  'map',
  'satellite',
  'cctv',
  'dossier',
  'osint',
  'face-recognition',
  'vehicle-recognition',
  'comms',
  'graph',
  'news',
  'access',
  'system-tables',
  'audio',
  'photo-archive',
  'interrogation',
  'security',
  'explorer',
  'print',
] as const;

export type ModuleId = (typeof moduleIds)[number];

export type SceneId = string & { readonly __brand: 'SceneId' };
export type AssetId = string & { readonly __brand: 'AssetId' };
export type EntityId = string & { readonly __brand: 'EntityId' };

export function isScreenId(value: string): value is ScreenId {
  return screenIds.some((screenId) => screenId === value);
}

export function isModuleId(value: string): value is ModuleId {
  return moduleIds.some((moduleId) => moduleId === value);
}

export function createSceneId(value: string): SceneId {
  if (!sceneIdPattern.test(value)) {
    throw new Error(`Invalid scene id: ${value}`);
  }

  return value as SceneId;
}

export function createAssetId(value: string): AssetId {
  if (!assetIdPattern.test(value)) {
    throw new Error(`Invalid asset id: ${value}`);
  }

  return value as AssetId;
}

export function createEntityId(value: string): EntityId {
  if (!assetIdPattern.test(value)) {
    throw new Error(`Invalid entity id: ${value}`);
  }

  return value as EntityId;
}
