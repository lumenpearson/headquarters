import { describe, expect, it } from 'vitest';

import {
  BridgeMaterialClient,
  normalizePlaybackGrantUrl,
  type MaterialImportProgress,
} from './BridgeMaterialClient';

const abc = new TextEncoder().encode('abc');
const importedMaterial = {
  materialId: '018f0f1a-8000-7000-8000-000000000000',
  displayName: 'brief.txt',
  mimeType: 'text/plain',
  byteSize: 3n,
  contentHash: 'a'.repeat(64),
  createdAt: '2026-08-16T00:00:00.000Z',
};
const playbackMaterial = {
  ...importedMaterial,
  materialId: '018f0f1a-8000-7000-8000-000000000001',
  displayName: 'camera-loop.mp4',
  mimeType: 'video/mp4',
  byteSize: 64n * 1024n * 1024n,
};
const playbackGrantId = '018f0f1a-8000-7000-8000-000000000002';

describe('BridgeMaterialClient', () => {
  it('splits a browser stream into bridge-sized binary chunks and reports its phases', async () => {
    const calls: Array<{ readonly offset: bigint; readonly data: Uint8Array }> = [];
    const progress: MaterialImportProgress[] = [];
    let expectedBlake3 = '';
    const client = new BridgeMaterialClient(
      'http://unused.test',
      'materials',
      {
        async beginMaterialImport(request) {
          expectedBlake3 = request.expectedBlake3;
          return { session: session('import-1', 0n, 2) };
        },
        async uploadMaterialChunk(request) {
          calls.push({ offset: request.offset, data: request.data });
          return {
            session: session(request.uploadId, request.offset + BigInt(request.data.byteLength), 2),
          };
        },
        async getMaterialImportStatus() {
          return { session: session('import-1', 0n, 2) };
        },
        async completeMaterialImport() {
          return {
            material: importedMaterial,
            deduplicated: false,
          };
        },
        async cancelMaterialImport() {
          return { session: session('import-1', 0n, 2) };
        },
        async listImportedMaterials() {
          return { materials: [], nextCursor: '' };
        },
        async *readImportedMaterial() {
          yield { data: new TextEncoder().encode('streamed'), material: importedMaterial };
        },
        async getMaterialPlaybackGrant() {
          return {
            grant: {
              grantId: playbackGrantId,
              url: `http://127.0.0.1:4177/v1/material-playback/${playbackGrantId}/${'b'.repeat(64)}`,
              expiresAtMs: 1_800_000_000_000n,
              mimeType: playbackMaterial.mimeType,
              byteSize: playbackMaterial.byteSize,
            },
          };
        },
        async revokeMaterialPlaybackGrant() {
          return { revoked: true };
        },
      },
      {
        async hash(file, onProgress) {
          onProgress?.({ processedBytes: file.size, totalBytes: file.size });
          return '6'.repeat(64);
        },
      },
    );

    const result = await client.importFile(browserFile('brief.txt', abc), (event) =>
      progress.push(event),
    );

    expect(calls.map((call) => [call.offset, new TextDecoder().decode(call.data)])).toEqual([
      [0n, 'ab'],
      [2n, 'c'],
    ]);
    expect(progress.map((event) => event.phase)).toEqual([
      'starting',
      'hashing',
      'uploading',
      'uploading',
      'verifying',
      'completed',
    ]);
    expect(result.material.displayName).toBe('brief.txt');
    expect(expectedBlake3).toBe('6'.repeat(64));

    const streamed: Uint8Array[] = [];
    for await (const chunk of client.readChunks(result.material.materialId))
      streamed.push(chunk.data);
    expect(new TextDecoder().decode(joinChunks(streamed))).toBe('streamed');

    const grant = await client.getPlaybackGrant(playbackMaterial);
    expect(grant.url).toContain(`/v1/material-playback/${playbackGrantId}/`);
    await expect(client.revokePlaybackGrant(grant.grantId)).resolves.toBe(true);
  });

  it('rejects playback URLs that are not exact opaque loopback capabilities', () => {
    expect(() =>
      normalizePlaybackGrantUrl(
        `https://example.test/v1/material-playback/${playbackGrantId}/${'b'.repeat(64)}`,
        playbackGrantId,
      ),
    ).toThrow(/unsafe material playback URL/u);
    expect(() =>
      normalizePlaybackGrantUrl(
        `http://127.0.0.1:4177/v1/material-playback/${playbackGrantId}/${'b'.repeat(64)}?path=C%3A%5Csecret`,
        playbackGrantId,
      ),
    ).toThrow(/unsafe material playback URL/u);
  });
});

function session(uploadId: string, receivedSize: bigint, chunkSize: number) {
  return {
    uploadId,
    totalSize: 3n,
    receivedSize,
    chunkSize,
    state: 'UPLOADING',
  };
}

function browserFile(name: string, bytes: Uint8Array): File {
  return {
    name,
    size: bytes.byteLength,
    type: 'text/plain',
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
  } as File;
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const value = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}
