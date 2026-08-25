import { getSettingDefinition } from '@gremuchaya/settings-schema';

import type { MaterialEntry, MaterialReadChunk } from './BridgeMaterialClient';

export interface MaterialPreviewLimits {
  readonly textBytes: number;
  readonly binaryBytes: number;
}

function megabytesOf(id: string): number {
  const value = getSettingDefinition(id)?.defaultValue;
  return (typeof value === 'number' ? value : 0) * 1024 * 1024;
}

/**
 * The limits when nobody has said otherwise, read from the schema rather than
 * restated here.
 *
 * `materials.previewLimitMb` and `materials.textPreviewLimitMb` are what an
 * operator moves; these two literals used to be a second copy of their
 * defaults, and two copies of a default are two things to keep in step. This
 * module stays free of the Zustand runtime — the operator's values arrive as an
 * argument from a caller that has them.
 */
export const materialPreviewLimits: MaterialPreviewLimits = {
  textBytes: megabytesOf('materials.textPreviewLimitMb'),
  binaryBytes: megabytesOf('materials.previewLimitMb'),
};

export type MaterialPreviewMode =
  'image' | 'media' | 'media-stream' | 'pdf' | 'text' | 'unsupported' | 'oversize';

export interface MaterialChunkReader {
  readChunks(materialId: string, signal?: AbortSignal): AsyncIterable<MaterialReadChunk>;
}

export class MaterialPreviewLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterialPreviewLimitError';
  }
}

/**
 * Classifies local objects for safe, bounded in-app previews. This is not an
 * execution path: unsupported or oversized content remains metadata-only until
 * a dedicated, streaming viewer can handle it.
 */
export function previewModeForMaterial(
  material: MaterialEntry,
  limits: MaterialPreviewLimits = materialPreviewLimits,
): MaterialPreviewMode {
  const mimeType = material.mimeType.toLocaleLowerCase('en-US');
  if (mimeType.startsWith('image/')) {
    return material.byteSize <= BigInt(limits.binaryBytes) ? 'image' : 'oversize';
  }
  if (mimeType === 'application/pdf') {
    return material.byteSize <= BigInt(limits.binaryBytes) ? 'pdf' : 'oversize';
  }
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
    return material.byteSize <= BigInt(limits.binaryBytes) ? 'media' : 'media-stream';
  }
  if (isSafeTextMimeType(mimeType, material.displayName)) {
    return material.byteSize <= BigInt(limits.textBytes) ? 'text' : 'oversize';
  }
  return 'unsupported';
}

export async function readMaterialText(
  reader: MaterialChunkReader,
  material: MaterialEntry,
  signal?: AbortSignal,
  limits: MaterialPreviewLimits = materialPreviewLimits,
): Promise<string> {
  assertWithinLimit(material, limits.textBytes, 'text');
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let receivedBytes = 0;
  let text = '';
  for await (const chunk of reader.readChunks(material.materialId, signal)) {
    receivedBytes = addBoundedBytes(receivedBytes, chunk.data.byteLength, limits.textBytes);
    text += decoder.decode(chunk.data, { stream: true });
  }
  text += decoder.decode();
  assertExpectedLength(receivedBytes, material);
  return text;
}

export async function readMaterialBlob(
  reader: MaterialChunkReader,
  material: MaterialEntry,
  signal?: AbortSignal,
  limits: MaterialPreviewLimits = materialPreviewLimits,
): Promise<Blob> {
  assertWithinLimit(material, limits.binaryBytes, 'binary');
  const chunks: ArrayBuffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of reader.readChunks(material.materialId, signal)) {
    receivedBytes = addBoundedBytes(receivedBytes, chunk.data.byteLength, limits.binaryBytes);
    chunks.push(copyToArrayBuffer(chunk.data));
  }
  assertExpectedLength(receivedBytes, material);
  return new Blob(chunks, { type: material.mimeType || 'application/octet-stream' });
}

function assertWithinLimit(material: MaterialEntry, limit: number, kind: string): void {
  if (material.byteSize > BigInt(limit)) {
    throw new MaterialPreviewLimitError(
      `${kind.toLocaleUpperCase('en-US')} preview exceeds its ${formatMiB(limit)} bounded limit.`,
    );
  }
}

function addBoundedBytes(current: number, incoming: number, limit: number): number {
  const next = current + incoming;
  if (!Number.isSafeInteger(next) || next > limit) {
    throw new MaterialPreviewLimitError(
      `Preview stream exceeded its ${formatMiB(limit)} bounded limit.`,
    );
  }
  return next;
}

function assertExpectedLength(receivedBytes: number, material: MaterialEntry): void {
  if (BigInt(receivedBytes) !== material.byteSize) {
    throw new Error('Local mirror stream length differs from its material metadata.');
  }
}

function copyToArrayBuffer(chunk: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy.buffer;
}

function isSafeTextMimeType(mimeType: string, fileName: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if (
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/yaml'
  ) {
    return true;
  }
  return /\.(?:csv|json|md|markdown|txt|xml|ya?ml|log)$/iu.test(fileName);
}

function formatMiB(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}
