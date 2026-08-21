import type { MaterialEntry } from '../materials/BridgeMaterialClient';

export const cameraMaterialAssignmentsStorageKey = 'hq.camera-material-assignments.v1';
export const demoCameraMaterialOption = '__demo_video__';

export type CameraMaterialAssignments = Readonly<Record<string, string>>;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Camera-like channels are presentation fixtures. This registry persists only
 * an opaque material id, never a File, Blob URL or device/absolute path. The
 * actual Blob or playback-grant URL is owned by the client screen for the
 * short time it is playing a selected source.
 */
export function readCameraMaterialAssignments(storage: StorageLike): CameraMaterialAssignments {
  try {
    return normalizeCameraMaterialAssignments(
      JSON.parse(storage.getItem(cameraMaterialAssignmentsStorageKey) ?? '{}'),
    );
  } catch {
    return {};
  }
}

export function writeCameraMaterialAssignments(
  storage: StorageLike,
  assignments: CameraMaterialAssignments,
): void {
  storage.setItem(
    cameraMaterialAssignmentsStorageKey,
    JSON.stringify(normalizeCameraMaterialAssignments(assignments)),
  );
}

export function setCameraMaterialAssignment(
  assignments: CameraMaterialAssignments,
  cameraId: string,
  materialId: string | null,
): CameraMaterialAssignments {
  const next = { ...normalizeCameraMaterialAssignments(assignments) };
  if (!validCameraId(cameraId)) return next;
  if (materialId === null || materialId === demoCameraMaterialOption) {
    delete next[cameraId];
    return next;
  }
  if (validMaterialId(materialId)) next[cameraId] = materialId;
  return next;
}

export function isAssignableCameraMaterial(material: MaterialEntry): boolean {
  return (
    material.mimeType.toLocaleLowerCase('en-US').startsWith('video/') &&
    material.byteSize > 0n &&
    material.byteSize <= BigInt(Number.MAX_SAFE_INTEGER)
  );
}

export function normalizeCameraMaterialAssignments(value: unknown): CameraMaterialAssignments {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = Object.entries(value).flatMap(([cameraId, materialId]) =>
    validCameraId(cameraId) && typeof materialId === 'string' && validMaterialId(materialId)
      ? [[cameraId, materialId] as const]
      : [],
  );
  return Object.fromEntries(
    normalized.sort(([left], [right]) => left.localeCompare(right, 'en-US')),
  );
}

function validCameraId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function validMaterialId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
