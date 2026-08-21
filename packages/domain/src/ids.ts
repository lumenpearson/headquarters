const sceneIdPattern = /^s\d{2}-\d{1,3}[a-z]?$/u;
/*
 * The shape the material bridge issues: a UUID whose version nibble is 1..8
 * and whose variant nibble is 8..b. Deliberately stricter than "looks like a
 * UUID" -- the nil UUID and other well-formed-but-impossible values are not
 * identifiers this system ever hands out, and accepting them would let a
 * cleared field read as a real reference.
 */
const materialIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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

export type MaterialId = string & { readonly __brand: 'MaterialId' };
export type SceneId = string & { readonly __brand: 'SceneId' };
export type AssetId = string & { readonly __brand: 'AssetId' };
export type EntityId = string & { readonly __brand: 'EntityId' };

/**
 * Guards a material reference wherever one crosses a boundary: a persisted
 * assignment, a schema-validated setting, a playback-sync command.
 *
 * One implementation on purpose. This pattern previously existed three times
 * over -- in the bridge client, the camera assignments registry and the
 * playback sync coordinator -- which is three chances for them to disagree
 * about what a valid reference is.
 */
export function isMaterialId(value: string): value is MaterialId {
  return materialIdPattern.test(value);
}

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
