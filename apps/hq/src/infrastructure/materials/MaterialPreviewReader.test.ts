import { describe, expect, it } from 'vitest';

import type { MaterialEntry, MaterialReadChunk } from './BridgeMaterialClient';
import {
  MaterialPreviewLimitError,
  previewModeForMaterial,
  readMaterialBlob,
  readMaterialText,
} from './MaterialPreviewReader';

describe('MaterialPreviewReader', () => {
  it('decodes trusted plain text from bounded bridge chunks', async () => {
    const material = entry({ mimeType: 'text/plain', byteSize: 5n });
    const reader = chunkReader([bytes('he'), bytes('llo')]);

    await expect(readMaterialText(reader, material)).resolves.toBe('hello');
    expect(previewModeForMaterial(material)).toBe('text');
  });

  it('builds only a bounded image blob after the stream matches its metadata', async () => {
    const material = entry({ mimeType: 'image/png', byteSize: 3n });
    const blob = await readMaterialBlob(chunkReader([bytes('a'), bytes('bc')]), material);

    await expect(blob.text()).resolves.toBe('abc');
    expect(blob.type).toBe('image/png');
    expect(previewModeForMaterial(material)).toBe('image');
    expect(previewModeForMaterial(entry({ mimeType: 'video/webm', byteSize: 3n }))).toBe('media');
    expect(
      previewModeForMaterial(entry({ mimeType: 'video/mp4', byteSize: 64n * 1024n * 1024n })),
    ).toBe('media-stream');
  });

  it('keeps oversized or unexpected material streams out of the preview surface', async () => {
    const metadataMismatch = entry({ mimeType: 'text/plain', byteSize: 3n });
    await expect(readMaterialText(chunkReader([bytes('four')]), metadataMismatch)).rejects.toThrow(
      'Local mirror stream length differs from its material metadata.',
    );

    const tooLarge = entry({ mimeType: 'application/pdf', byteSize: 33n * 1024n * 1024n });
    expect(previewModeForMaterial(tooLarge)).toBe('oversize');
    await expect(readMaterialBlob(chunkReader([]), tooLarge)).rejects.toBeInstanceOf(
      MaterialPreviewLimitError,
    );
  });
});

function entry(overrides: Pick<MaterialEntry, 'mimeType' | 'byteSize'>): MaterialEntry {
  return {
    materialId: '018f0f1a-8000-7000-8000-000000000000',
    displayName: 'evidence.txt',
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-16T00:00:00.000Z',
    ...overrides,
  };
}

function chunkReader(chunks: readonly Uint8Array[]) {
  return {
    async *readChunks(): AsyncGenerator<MaterialReadChunk> {
      for (const data of chunks) yield { data };
    },
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
