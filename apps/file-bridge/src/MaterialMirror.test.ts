import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BridgeConfig } from '@gremuchaya/config';
import { afterEach, describe, expect, it } from 'vitest';

import { MaterialMirror, MaterialMirrorError } from './MaterialMirror.js';

const abcBlake3 = '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85';

describe('local BLAKE3 material mirror', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('atomically finalizes a content-addressed import and deduplicates the second copy', async () => {
    root = await mkdtemp(join(tmpdir(), 'gremuchaya-materials-'));
    const mirror = new MaterialMirror(materialConfig(root));
    await mirror.initialize();

    const firstSession = await mirror.begin({
      mountId: 'materials',
      fileName: 'brief.txt',
      declaredMimeType: 'text/plain',
      totalSize: 3n,
      expectedBlake3: abcBlake3,
    });
    expect(firstSession).toMatchObject({ receivedSize: 0, state: 'PENDING', chunkSize: 65_536 });
    const appended = await mirror.append(
      firstSession.uploadId,
      0n,
      new TextEncoder().encode('abc'),
    );
    expect(appended).toMatchObject({ receivedSize: 3, state: 'UPLOADING' });
    const first = await mirror.complete(firstSession.uploadId);

    expect(first).toMatchObject({
      deduplicated: false,
      material: { displayName: 'brief.txt', contentHash: abcBlake3, byteSize: 3 },
    });
    const objectPath = join(root, '.hq', 'objects', 'blake3', '64', abcBlake3);
    await expect(stat(objectPath)).resolves.toMatchObject({ size: 3 });

    const secondSession = await mirror.begin({
      mountId: 'materials',
      fileName: 'brief-copy.txt',
      declaredMimeType: 'text/plain',
      totalSize: 3n,
      expectedBlake3: '',
    });
    await mirror.append(secondSession.uploadId, 0n, new TextEncoder().encode('abc'));
    const second = await mirror.complete(secondSession.uploadId);
    expect(second.deduplicated).toBe(true);
    expect(second.material.materialId).not.toBe(first.material.materialId);

    const page = await mirror.list('materials', 1, '');
    expect(page.materials).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const remaining = await mirror.list('materials', 1, page.nextCursor);
    expect(remaining.materials).toHaveLength(1);
    expect(remaining.nextCursor).toBe('');

    const resolved = await mirror.resolve('materials', first.material.materialId);
    expect(await readFile(resolved.path, 'utf8')).toBe('abc');
    expect(resolved.material).toEqual(first.material);
  });

  it('rejects out-of-order chunks and quarantines a completed hash mismatch', async () => {
    root = await mkdtemp(join(tmpdir(), 'gremuchaya-materials-'));
    const mirror = new MaterialMirror(materialConfig(root));
    await mirror.initialize();
    const session = await mirror.begin({
      mountId: 'materials',
      fileName: 'evidence.bin',
      declaredMimeType: 'application/octet-stream',
      totalSize: 3n,
      expectedBlake3: 'a'.repeat(64),
    });

    await expect(mirror.append(session.uploadId, 1n, new Uint8Array([1]))).rejects.toBeInstanceOf(
      MaterialMirrorError,
    );
    await mirror.append(session.uploadId, 0n, new TextEncoder().encode('abc'));
    await expect(mirror.complete(session.uploadId)).rejects.toThrow('BLAKE3 verification failed');
    await expect(
      stat(join(root, '.hq', 'quarantine', `${session.uploadId}.part`)),
    ).resolves.toMatchObject({ size: 3 });
    expect(mirror.status(session.uploadId).state).toBe('FAILED');
  });

  it('keeps imports disabled unless both bridge and import policy opt in', async () => {
    root = await mkdtemp(join(tmpdir(), 'gremuchaya-materials-'));
    const mirror = new MaterialMirror({
      ...materialConfig(root),
      readOnly: true,
      materialImport: { ...materialConfig(root).materialImport, enabled: false },
    });
    await expect(
      mirror.begin({
        mountId: 'materials',
        fileName: 'denied.txt',
        declaredMimeType: 'text/plain',
        totalSize: 0n,
        expectedBlake3: '',
      }),
    ).rejects.toThrow('Material imports are disabled');
  });
});

function materialConfig(root: string): BridgeConfig {
  return {
    version: 1,
    transport: 'grpc-web',
    port: 0,
    readOnly: false,
    allowedOrigins: ['http://127.0.0.1:3000'],
    mounts: [{ id: 'materials', label: 'ОБЩИЕ МАТЕРИАЛЫ', root, virtualPath: '/МАТЕРИАЛЫ' }],
    stableFile: { probeIntervalMs: 50, timeoutMs: 500 },
    watchDebounceMs: 25,
    materialImport: { enabled: true, maxFileBytes: 1024 * 1024, chunkSizeBytes: 65_536 },
  };
}
