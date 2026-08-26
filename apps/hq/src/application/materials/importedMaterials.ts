import type { Attachment, FileKind } from '@gremuchaya/domain';

import type { MaterialEntry } from '@/infrastructure/materials/BridgeMaterialClient';
import {
  materialOriginLabel,
  type MaterialOrigin,
} from '@/infrastructure/materials/materialLibrary';
import type { ImportedMaterial } from '@/state/operationsStore';

/**
 * The two directions between a library entry and the record the store keeps.
 *
 * The store's record is what survives a reload, a screen change and a world
 * reset; the library entry is what an RPC or a grant needs. They differ in one
 * field on purpose -- `byteSize` is a `bigint` on the wire and a decimal string
 * in the store, because the persisted blob goes through `JSON.stringify`, which
 * throws on a `bigint` -- so the conversion lives here rather than being
 * open-coded at each of the three call sites that used to hold the bridge's
 * listing in React state.
 */
export function toImportedMaterial(
  material: MaterialEntry,
  detail: {
    readonly category: string;
    readonly origin: MaterialOrigin;
    readonly importedAt: string;
  },
): ImportedMaterial {
  return {
    materialId: material.materialId,
    displayName: material.displayName,
    mimeType: material.mimeType,
    byteSize: material.byteSize.toString(),
    contentHash: material.contentHash,
    createdAt: material.createdAt,
    category: detail.category,
    origin: detail.origin,
    importedAt: detail.importedAt,
  };
}

export function toMaterialEntry(imported: ImportedMaterial): MaterialEntry {
  return {
    materialId: imported.materialId,
    displayName: imported.displayName,
    mimeType: imported.mimeType,
    byteSize: BigInt(imported.byteSize),
    contentHash: imported.contentHash,
    createdAt: imported.createdAt,
  };
}

/**
 * The import as the file registry reads it.
 *
 * `category` is the operator's own reading of the content and rides as a tag,
 * which keeps it findable from the same box that searches ids and sources.
 * `source` names the library that holds the bytes, because "where did this go"
 * is the question an operator asks about an import and the registry is where
 * they ask it.
 */
export function importedMaterialToAttachment(imported: ImportedMaterial): Attachment {
  const mimeType = imported.mimeType || 'application/octet-stream';
  const origin: MaterialOrigin =
    imported.origin === 'group-library' ? 'group-library' : 'local-mirror';
  return {
    id: imported.materialId,
    title: imported.displayName,
    kind: kindForMimeType(imported.mimeType, imported.displayName),
    status: 'READY',
    createdAt: imported.createdAt,
    source: `${materialOriginLabel(origin)} / GRPC-WEB`,
    classification: 'АЛЬФА',
    tags:
      imported.category.length === 0 ? [origin, mimeType] : [origin, imported.category, mimeType],
    linkedCaseIds: [],
    linkedObjectIds: [],
    sizeLabel: formatBytes(BigInt(imported.byteSize)),
    preview: `BLAKE3 ${imported.contentHash.slice(0, 16)}`,
  };
}

export function kindForMimeType(mimeType: string, fileName: string): FileKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('pdf') || mimeType.startsWith('text/')) return 'document';
  if (/\.(geojson|kml|kmz|gpx)$/iu.test(fileName)) return 'map';
  if (/\.(csv|json|xml|ya?ml)$/iu.test(fileName)) return 'data';
  return 'document';
}

export function formatBytes(value: bigint): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'N/A';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
