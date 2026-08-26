// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MaterialEntry, MaterialReadChunk } from './BridgeMaterialClient';
import { originalRendition, type MaterialLibraryClient } from './materialLibrary';
import { materialPreviewLimits } from './MaterialPreviewReader';
import {
  openMaterialRendition,
  openMaterialSource,
  type MaterialSourceClient,
} from './MaterialSource';

const material = (byteSize: bigint): MaterialEntry => ({
  materialId: '018f0f1a-8000-7000-8000-000000000000',
  displayName: 'Фон.png',
  mimeType: 'image/png',
  byteSize,
  contentHash: '',
  createdAt: '2026-08-21T00:00:00.000Z',
});

function client(overrides: Partial<MaterialSourceClient> = {}): MaterialSourceClient {
  return {
    async *readChunks(): AsyncGenerator<MaterialReadChunk> {
      yield { data: new Uint8Array([1, 2, 3]) };
    },
    getPlaybackGrant: () =>
      Promise.resolve({ grantId: '018f0f1a-8000-7000-8000-00000000ffff', url: 'blob:grant' }),
    revokePlaybackGrant: () => Promise.resolve(true),
    ...overrides,
  };
}

const createdUrls: string[] = [];
const revokedUrls: string[] = [];

beforeEach(() => {
  createdUrls.length = 0;
  revokedUrls.length = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const url = `blob:object-${createdUrls.length.toString()}-${blob.size.toString()}`;
      createdUrls.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => void revokedUrls.push(url),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('opening a material as a playable source', () => {
  it('reads a material inside the bounded limit into a blob', async () => {
    const handle = openMaterialSource(client(), material(3n));
    const source = await handle.opened;

    expect(source.transport).toBe('BOUNDED_BLOB');
    expect(createdUrls).toEqual([source.url]);

    handle.release();
    expect(revokedUrls).toEqual([source.url]);
  });

  it('streams anything above the limit through a revocable grant instead', async () => {
    const revoked: string[] = [];
    const oversize = material(BigInt(materialPreviewLimits.binaryBytes) + 1n);
    const handle = openMaterialSource(
      client({
        revokePlaybackGrant: (grantId) => {
          revoked.push(grantId);
          return Promise.resolve(true);
        },
      }),
      oversize,
    );
    const source = await handle.opened;

    expect(source).toMatchObject({ transport: 'RANGE_GRANT', url: 'blob:grant' });
    // Reading 32MB+ into memory to paint a background is the thing this avoids.
    expect(createdUrls).toEqual([]);

    handle.release();
    expect(revoked).toEqual(['018f0f1a-8000-7000-8000-00000000ffff']);
  });

  it('releases a source that finished opening after the caller had given up', async () => {
    // The real caller is a React effect, which is routinely torn down while the
    // read is still in flight. Without this the object URL and the server-side
    // grant both outlive the screen that asked for them.
    const revoked: string[] = [];
    const handle = openMaterialSource(
      client({
        revokePlaybackGrant: (grantId) => {
          revoked.push(grantId);
          return Promise.resolve(true);
        },
      }),
      material(BigInt(materialPreviewLimits.binaryBytes) + 1n),
    );

    handle.release();
    await handle.opened.catch(() => undefined);

    expect(revoked).toEqual(['018f0f1a-8000-7000-8000-00000000ffff']);
  });

  it('is safe to release twice', async () => {
    const handle = openMaterialSource(client(), material(3n));
    const source = await handle.opened;
    handle.release();
    handle.release();
    expect(revokedUrls).toEqual([source.url]);
  });
});

describe('opening one named rendition of a material (R21)', () => {
  it('asks the library for the variant even when the material would fit in a blob', async () => {
    const asked: string[] = [];
    const handle = openMaterialRendition(renditionClient(asked), material(3n), {
      variant: '720p',
      label: '720P',
    });
    const source = await handle.opened;

    expect(asked).toEqual(['720p']);
    // The blob path streams the stored object, so taking it for a variant
    // would show the original and call it 720p.
    expect(createdUrls).toEqual([]);
    expect(source).toMatchObject({ transport: 'RANGE_GRANT', variant: '720p', rendered: true });
  });

  it('leaves the original on the transport its size chooses', async () => {
    const asked: string[] = [];
    const handle = openMaterialRendition(renditionClient(asked), material(3n), originalRendition);
    const source = await handle.opened;

    expect(asked).toEqual([]);
    expect(source.transport).toBe('BOUNDED_BLOB');
    expect(source.variant).toBe('');
  });

  it('hands the rendition grant back on release, including after the caller gave up', async () => {
    const revoked: string[] = [];
    const handle = openMaterialRendition(renditionClient([], revoked), material(3n), {
      variant: '480p',
      label: '480P',
    });

    handle.release();
    await handle.opened.catch(() => undefined);

    expect(revoked).toEqual(['grant-480p']);
  });
});

function renditionClient(asked: string[], revoked: string[] = []): MaterialLibraryClient {
  return {
    ...client(),
    origin: 'group-library',
    revokePlaybackGrant: (grantId: string) => {
      revoked.push(grantId);
      return Promise.resolve(false);
    },
    openRendition: (_material: MaterialEntry, rendition: { readonly variant: string }) => {
      asked.push(rendition.variant);
      return Promise.resolve({
        grantId: `grant-${rendition.variant}`,
        url: `https://s3.example.test/${rendition.variant}`,
        mimeType: 'image/png',
        variant: rendition.variant,
        rendered: true,
      });
    },
  } as unknown as MaterialLibraryClient;
}
