/**
 * Timestamped notes an operator leaves on a material while previewing it --
 * the surface F9/R21 named as a bare gap: "no domain model, no store region,
 * no surface." There is no `MaterialAnnotation` RPC on the wire (`material.proto`
 * names sixteen RPCs and none of them is this), so an annotation is local to
 * this browser, not a group-shared record; that is a real limit, stated once
 * here rather than discovered by an operator switching machines.
 *
 * The persistence idiom mirrors `cameraMaterialAssignments.ts`: pure functions
 * over a `StorageLike`, read and written directly by the component that owns
 * the surface, the same shape `VideoScreen.tsx` already uses for a comparably
 * narrow, presentation-local registry.
 */

export const materialAnnotationsStorageKey = 'hq.material-annotations.v1';

/** How long a note may run. A note is a marker, not a transcript. */
const maxAnnotationTextLength = 500;

export interface MaterialAnnotation {
  readonly id: string;
  readonly materialId: string;
  readonly timestampSeconds: number;
  readonly text: string;
  readonly createdAt: string;
}

/** Every material's annotations, keyed by `materialId`. */
export type MaterialAnnotations = Readonly<Record<string, readonly MaterialAnnotation[]>>;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readMaterialAnnotations(storage: StorageLike): MaterialAnnotations {
  try {
    return normalizeMaterialAnnotations(
      JSON.parse(storage.getItem(materialAnnotationsStorageKey) ?? '{}'),
    );
  } catch {
    return {};
  }
}

export function writeMaterialAnnotations(
  storage: StorageLike,
  annotations: MaterialAnnotations,
): void {
  storage.setItem(
    materialAnnotationsStorageKey,
    JSON.stringify(normalizeMaterialAnnotations(annotations)),
  );
}

/** For a material with no annotations yet, so callers never branch on `undefined`. */
export function annotationsFor(
  annotations: MaterialAnnotations,
  materialId: string,
): readonly MaterialAnnotation[] {
  return annotations[materialId] ?? [];
}

export function addMaterialAnnotation(
  annotations: MaterialAnnotations,
  materialId: string,
  timestampSeconds: number,
  text: string,
  now: () => string = () => new Date().toISOString(),
  id: () => string = () => crypto.randomUUID(),
): MaterialAnnotations {
  const trimmed = text.trim().slice(0, maxAnnotationTextLength);
  if (trimmed.length === 0) return annotations;
  const entry: MaterialAnnotation = {
    id: id(),
    materialId,
    timestampSeconds: Number.isFinite(timestampSeconds) ? Math.max(0, timestampSeconds) : 0,
    text: trimmed,
    createdAt: now(),
  };
  const next = [...annotationsFor(annotations, materialId), entry].sort(
    (left, right) => left.timestampSeconds - right.timestampSeconds,
  );
  return { ...annotations, [materialId]: next };
}

export function removeMaterialAnnotation(
  annotations: MaterialAnnotations,
  materialId: string,
  annotationId: string,
): MaterialAnnotations {
  const remaining = annotationsFor(annotations, materialId).filter(
    (annotation) => annotation.id !== annotationId,
  );
  if (remaining.length === 0) {
    const { [materialId]: _removed, ...rest } = annotations;
    return rest;
  }
  return { ...annotations, [materialId]: remaining };
}

export function normalizeMaterialAnnotations(value: unknown): MaterialAnnotations {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = Object.entries(value).flatMap(([materialId, entries]) => {
    if (typeof materialId !== 'string' || materialId.length === 0) return [];
    if (!Array.isArray(entries)) return [];
    const validated = entries
      .filter((entry): entry is MaterialAnnotation => isValidAnnotation(entry, materialId))
      .sort((left, right) => left.timestampSeconds - right.timestampSeconds);
    return validated.length > 0 ? [[materialId, validated] as const] : [];
  });
  return Object.fromEntries(normalized);
}

function isValidAnnotation(value: unknown, materialId: string): value is MaterialAnnotation {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<MaterialAnnotation>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    candidate.materialId === materialId &&
    typeof candidate.timestampSeconds === 'number' &&
    Number.isFinite(candidate.timestampSeconds) &&
    typeof candidate.text === 'string' &&
    candidate.text.length > 0 &&
    typeof candidate.createdAt === 'string'
  );
}
