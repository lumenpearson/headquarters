import { materialV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import {
  assertRemoteGrantUrl,
  ControlPlaneMaterialClient,
  toCategoryEnum,
  type MaterialFetch,
  type MaterialRpcClient,
} from './ControlPlaneMaterialClient';
import { originalRendition } from './materialLibrary';

const storageOrigin = 'https://s3.example.test';
const groupId = '018f0f1a-8000-7000-8000-0000000000a0';
const deviceId = '018f0f1a-8000-7000-8000-0000000000b0';
const uploadId = '018f0f1a-8000-7000-8000-0000000000c0';
const materialId = '018f0f1a-8000-7000-8000-0000000000d0';
const contentHash = '6'.repeat(64);

const wireMaterial = {
  id: { value: materialId },
  displayName: 'camera-loop.mp4',
  mimeType: 'video/mp4',
  byteSize: 6n,
  contentHash,
  category: materialV1.MaterialCategory.VIDEO,
  status: materialV1.MaterialStatus.READY,
  createdAt: { seconds: 1_800_000_000n, nanos: 0 },
};

const material = {
  materialId,
  displayName: 'camera-loop.mp4',
  mimeType: 'video/mp4',
  byteSize: 6n,
  contentHash,
  createdAt: new Date(1_800_000_000_000).toISOString(),
};

describe('ControlPlaneMaterialClient upload sequence', () => {
  it('begins, writes every part to its own presigned address in order, then completes', async () => {
    const log: string[] = [];
    const puts: Array<{ readonly url: string; readonly size: number }> = [];
    const rpc = fakeRpc(log);
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fetchPart: recordingFetch(puts, ['"etag-1"', '"etag-2"']),
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
      category: 'video',
    });

    const result = await client.importFile(browserFile('camera-loop.mp4', 6));

    expect(log).toEqual(['beginUpload', 'getUploadStatus', 'completeUpload']);
    expect(puts.map((put) => put.url)).toEqual([
      `${storageOrigin}/bucket/key?part=1`,
      `${storageOrigin}/bucket/key?part=2`,
    ]);
    // The bytes each part carries are the range its grant reserved, not the
    // whole file twice.
    expect(puts.map((put) => put.size)).toEqual([4, 2]);
    // Ascending part number, and the quotes S3 wraps an etag in are stripped:
    // `CompleteMultipartUpload` assembles in the order the parts are named.
    expect(rpc.completedParts).toEqual([
      { partNumber: 1, etag: 'etag-1', checksum: '' },
      { partNumber: 2, etag: 'etag-2', checksum: '' },
    ]);
    expect(rpc.declaredCategory).toBe(materialV1.MaterialCategory.VIDEO);
    // One request id for the whole import, so a retried BeginUpload replays its
    // receipt instead of creating a second material.
    expect(rpc.requestIds).toEqual(['request-1', 'request-1']);
    expect(result).toEqual({ material, deduplicated: false });
  });

  it('reports each phase once, ending on completed', async () => {
    const phases: string[] = [];
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: fakeRpc([]).client,
      fetchPart: recordingFetch([], ['"a"', '"b"']),
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    await client.importFile(browserFile('camera-loop.mp4', 6), (progress) =>
      phases.push(progress.phase),
    );

    expect(phases).toEqual([
      'starting',
      'hashing',
      'uploading',
      'uploading',
      'verifying',
      'completed',
    ]);
  });

  it('does not re-send a part the server already accounts for', async () => {
    const log: string[] = [];
    const puts: Array<{ readonly url: string; readonly size: number }> = [];
    const rpc = fakeRpc(log, { completedParts: [1] });
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fetchPart: recordingFetch(puts, ['"etag-2"']),
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    await client.importFile(browserFile('camera-loop.mp4', 6));

    expect(puts.map((put) => put.url)).toEqual([`${storageOrigin}/bucket/key?part=2`]);
    expect(rpc.completedParts).toEqual([{ partNumber: 2, etag: 'etag-2', checksum: '' }]);
  });

  it('reads the material back rather than uploading when every part is already held', async () => {
    const log: string[] = [];
    const puts: Array<{ readonly url: string; readonly size: number }> = [];
    const rpc = fakeRpc(log, { completedParts: [1, 2] });
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fetchPart: recordingFetch(puts, []),
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    const result = await client.importFile(browserFile('camera-loop.mp4', 6));

    expect(puts).toEqual([]);
    // No completion either: the session that recorded those parts already ran
    // one, and a second would be refused for a session that is not open.
    expect(log).toEqual(['beginUpload', 'getUploadStatus', 'getMaterial']);
    expect(result).toEqual({ material, deduplicated: false });
  });

  it('uploads nothing and completes nothing when the group already holds the content', async () => {
    const log: string[] = [];
    const puts: Array<{ readonly url: string; readonly size: number }> = [];
    const rpc = fakeRpc(log, { deduplicated: true });
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fetchPart: recordingFetch(puts, []),
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    const result = await client.importFile(browserFile('camera-loop.mp4', 6));

    expect(puts).toEqual([]);
    expect(log).toEqual(['beginUpload', 'getMaterial']);
    expect(result.deduplicated).toBe(true);
  });

  it('cancels the upload when the bucket refuses a part, and does not complete it', async () => {
    const log: string[] = [];
    const rpc = fakeRpc(log);
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fetchPart: () => Promise.resolve({ ok: false, status: 503, headers: { get: () => null } }),
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    await expect(client.importFile(browserFile('camera-loop.mp4', 6))).rejects.toThrow(
      /refused part 1/u,
    );
    expect(log).toEqual(['beginUpload', 'getUploadStatus', 'cancelUpload']);
  });

  it('cancels the upload when the bucket exposes no ETag to this origin', async () => {
    const log: string[] = [];
    const rpc = fakeRpc(log);
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fetchPart: () => Promise.resolve({ ok: true, status: 200, headers: { get: () => null } }),
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    await expect(client.importFile(browserFile('camera-loop.mp4', 6))).rejects.toThrow(/ETag/u);
    expect(log).toEqual(['beginUpload', 'getUploadStatus', 'cancelUpload']);
  });

  it('refuses a part address outside the configured endpoint before writing to it', async () => {
    const log: string[] = [];
    const puts: Array<{ readonly url: string; readonly size: number }> = [];
    const rpc = fakeRpc(log, { partOrigin: 'https://attacker.test' });
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fetchPart: recordingFetch(puts, ['"etag-1"']),
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    await expect(client.importFile(browserFile('camera-loop.mp4', 6))).rejects.toThrow(
      /outside the configured object storage endpoint/u,
    );
    expect(puts).toEqual([]);
    expect(log).toEqual(['beginUpload', 'getUploadStatus', 'cancelUpload']);
  });
});

describe('the remote grant address validator', () => {
  it('admits the configured endpoint and the bucket one label below it', () => {
    expect(
      assertRemoteGrantUrl(`${storageOrigin}/bucket/key?X-Amz-Signature=aa`, storageOrigin),
    ).toBe(`${storageOrigin}/bucket/key?X-Amz-Signature=aa`);
    // Virtual-host addressing, which `s3-grant-issuer.ts` uses whenever
    // `forcePathStyle` is off. The client is told the endpoint and not which
    // style the deployment configured.
    expect(
      assertRemoteGrantUrl(
        'https://materials.s3.example.test/key?X-Amz-Signature=aa',
        storageOrigin,
      ),
    ).toBe('https://materials.s3.example.test/key?X-Amz-Signature=aa');
  });

  it('refuses a foreign host, a deeper host, credentials and a downgraded scheme', () => {
    expect(() => assertRemoteGrantUrl('https://attacker.test/key', storageOrigin)).toThrow(
      /outside the configured object storage endpoint/u,
    );
    // Two labels below the endpoint is not the bucket; it is a host the
    // endpoint's operator may not control.
    expect(() => assertRemoteGrantUrl('https://a.b.s3.example.test/key', storageOrigin)).toThrow(
      /outside the configured object storage endpoint/u,
    );
    // A bare `endsWith` on the endpoint's host would admit this: it is a host
    // someone else can register, and it ends with the endpoint's name.
    expect(() => assertRemoteGrantUrl('https://evils3.example.test/key', storageOrigin)).toThrow(
      /outside the configured object storage endpoint/u,
    );
    expect(() => assertRemoteGrantUrl('https://s3.example.test.evil/key', storageOrigin)).toThrow(
      /outside the configured object storage endpoint/u,
    );
    expect(() =>
      assertRemoteGrantUrl('https://user:secret@s3.example.test/key', storageOrigin),
    ).toThrow(/outside the configured object storage endpoint/u);
    expect(() => assertRemoteGrantUrl('http://s3.example.test/key', storageOrigin)).toThrow(
      /outside the configured object storage endpoint/u,
    );
  });

  it('refuses everything when no endpoint was configured, rather than trusting the answer', () => {
    expect(() => assertRemoteGrantUrl(`${storageOrigin}/bucket/key`, undefined)).toThrow(
      /NEXT_PUBLIC_HQ_MATERIAL_STORAGE_ORIGIN/u,
    );
    expect(() => assertRemoteGrantUrl(`${storageOrigin}/bucket/key`, '   ')).toThrow(
      /NEXT_PUBLIC_HQ_MATERIAL_STORAGE_ORIGIN/u,
    );
  });

  it('refuses an address that does not parse at all', () => {
    expect(() => assertRemoteGrantUrl('not-a-url', storageOrigin)).toThrow(/unparseable/u);
  });
});

describe('renditions', () => {
  it('asks for the variant it was given and reports the original when that is what came back', async () => {
    const asked: string[] = [];
    const rpc = fakeRpc([], { onPreviewVariant: (variant) => asked.push(variant) });
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    const source = await client.openRendition(material, { variant: '720p', label: '720P' });

    expect(asked).toEqual(['720p']);
    expect(source.variant).toBe('720p');
    // Every deployment here presigns the stored object for any variant, so the
    // grant reports the original's MIME type and no dimensions.
    expect(source.rendered).toBe(false);
  });

  it('reports a rendition when the grant describes something other than the stored object', async () => {
    const rpc = fakeRpc([], { previewWidth: 1280, previewHeight: 720 });
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    const source = await client.openRendition(material, { variant: '720p', label: '720P' });

    expect(source.rendered).toBe(true);
  });

  it('takes the original through the download grant, which needs no preview call', async () => {
    const log: string[] = [];
    const rpc = fakeRpc(log);
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    const source = await client.openRendition(material, originalRendition);

    expect(log).toEqual(['getDownloadGrant']);
    expect(source.rendered).toBe(false);
  });

  it('refuses a download grant whose metadata is not the selected material', async () => {
    const rpc = fakeRpc([], { downloadByteSize: 7n });
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    await expect(client.getPlaybackGrant(material)).rejects.toThrow(
      /differs from the selected material/u,
    );
  });

  it('reads a material by following its download grant, since the contract streams no bytes', async () => {
    const log: string[] = [];
    const requested: string[] = [];
    const rpc = fakeRpc(log);
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: rpc.client,
      fetchPart: (input, init) => {
        requested.push(`${init.method} ${input}`);
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: streamOf('abcdef'),
        });
      },
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    const chunks: string[] = [];
    for await (const chunk of client.readChunks(materialId)) {
      chunks.push(new TextDecoder().decode(chunk.data));
    }

    expect(log).toEqual(['getMaterial', 'getDownloadGrant']);
    expect(requested).toEqual([`GET ${storageOrigin}/bucket/key?X-Amz-Signature=aa`]);
    expect(chunks.join('')).toBe('abcdef');
  });

  it('refuses a download the bucket did not serve rather than yielding nothing', async () => {
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: fakeRpc([]).client,
      fetchPart: () =>
        Promise.resolve({ ok: false, status: 403, headers: { get: () => null }, body: null }),
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    await expect(async () => {
      for await (const _chunk of client.readChunks(materialId)) {
        // The first `next()` is where the refusal surfaces.
      }
    }).rejects.toThrow(/HTTP 403/u);
  });

  it('refuses a download or preview address outside the configured endpoint', async () => {
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: fakeRpc([], { grantOrigin: 'https://attacker.test' }).client,
      fileHasher: fakeHasher,
      mintRequestId: mintingIds(),
    });

    await expect(client.getPlaybackGrant(material)).rejects.toThrow(
      /outside the configured object storage endpoint/u,
    );
    await expect(
      client.openRendition(material, { variant: '720p', label: '720P' }),
    ).rejects.toThrow(/outside the configured object storage endpoint/u);
  });

  it('says a presigned address cannot be handed back', async () => {
    const client = new ControlPlaneMaterialClient({
      groupId,
      deviceId,
      storageOrigin,
      client: fakeRpc([]).client,
    });

    await expect(client.revokePlaybackGrant()).resolves.toBe(false);
  });
});

describe('category mapping', () => {
  it('maps the catalogue identifiers onto the wire enum, photo included', () => {
    expect(toCategoryEnum('photo')).toBe(materialV1.MaterialCategory.IMAGE);
    expect(toCategoryEnum('intercept')).toBe(materialV1.MaterialCategory.INTERCEPT);
    expect(toCategoryEnum('VIDEO')).toBe(materialV1.MaterialCategory.VIDEO);
    // A category the catalogue gains before this map does is `OTHER`, not a
    // refusal: an import must not fail because a label is new.
    expect(toCategoryEnum('nonexistent')).toBe(materialV1.MaterialCategory.OTHER);
  });
});

interface FakeRpcOptions {
  readonly completedParts?: readonly number[];
  readonly deduplicated?: boolean;
  readonly partOrigin?: string;
  /** Where the download and preview grants claim the object lives. */
  readonly grantOrigin?: string;
  readonly previewWidth?: number;
  readonly previewHeight?: number;
  readonly downloadByteSize?: bigint;
  readonly onPreviewVariant?: (variant: string) => void;
}

function fakeRpc(log: string[], options: FakeRpcOptions = {}) {
  const state = {
    completedParts: [] as readonly { partNumber: number; etag: string; checksum: string }[],
    requestIds: [] as string[],
    declaredCategory: materialV1.MaterialCategory.UNSPECIFIED as materialV1.MaterialCategory,
  };
  const partOrigin = options.partOrigin ?? storageOrigin;
  const grantOrigin = options.grantOrigin ?? storageOrigin;
  const client: MaterialRpcClient = {
    listMaterials: () => Promise.resolve({ materials: [wireMaterial], page: undefined }),
    getMaterial: () => {
      log.push('getMaterial');
      return Promise.resolve({ material: wireMaterial });
    },
    beginUpload: (request) => {
      log.push('beginUpload');
      state.requestIds.push(request.context.requestId);
      state.declaredCategory = request.category;
      return Promise.resolve({
        session: {
          id: { value: uploadId },
          materialId: { value: materialId },
          state: materialV1.UploadState.PENDING,
          totalSize: 6n,
          receivedSize: 0n,
          chunkSize: 4,
        },
        /*
         * Descending, deliberately. Nothing in the contract promises the
         * grants arrive in part order, and `CompleteMultipartUpload` assembles
         * the object in the order the parts are named -- so a client that
         * simply walked the response would have written a scrambled object.
         * The fake answers in the order that catches that.
         */
        parts:
          options.deduplicated === true
            ? []
            : [
                {
                  partNumber: 2,
                  offset: 4n,
                  length: 2n,
                  uploadUrl: `${partOrigin}/bucket/key?part=2`,
                  requiredHeaders: {},
                },
                {
                  partNumber: 1,
                  offset: 0n,
                  length: 4n,
                  uploadUrl: `${partOrigin}/bucket/key?part=1`,
                  requiredHeaders: {},
                },
              ],
        deduplicated: options.deduplicated ?? false,
      });
    },
    getUploadStatus: () => {
      log.push('getUploadStatus');
      return Promise.resolve({
        session: {
          id: { value: uploadId },
          materialId: { value: materialId },
          state: materialV1.UploadState.UPLOADING,
          totalSize: 6n,
          receivedSize: 0n,
          chunkSize: 4,
        },
        completedParts: options.completedParts ?? [],
      });
    },
    completeUpload: (request) => {
      log.push('completeUpload');
      state.requestIds.push(request.context.requestId);
      state.completedParts = request.parts.map((part) => ({ ...part }));
      return Promise.resolve({ material: wireMaterial });
    },
    cancelUpload: () => {
      log.push('cancelUpload');
      return Promise.resolve({});
    },
    getDownloadGrant: () => {
      log.push('getDownloadGrant');
      return Promise.resolve({
        grant: {
          url: `${grantOrigin}/bucket/key?X-Amz-Signature=aa`,
          contentHash,
          byteSize: options.downloadByteSize ?? 6n,
          expiresAt: { seconds: 1_800_000_060n, nanos: 0 },
        },
      });
    },
    getPreviewGrant: (request) => {
      log.push('getPreviewGrant');
      options.onPreviewVariant?.(request.variant);
      return Promise.resolve({
        grant: {
          url: `${grantOrigin}/bucket/key?X-Amz-Signature=bb`,
          mimeType: 'video/mp4',
          width: options.previewWidth ?? 0,
          height: options.previewHeight ?? 0,
          expiresAt: { seconds: 1_800_000_060n, nanos: 0 },
        },
      });
    },
  };
  return {
    client,
    get completedParts() {
      return state.completedParts;
    },
    get requestIds() {
      return state.requestIds;
    },
    get declaredCategory() {
      return state.declaredCategory;
    },
  };
}

function recordingFetch(
  puts: Array<{ readonly url: string; readonly size: number }>,
  etags: readonly string[],
): MaterialFetch {
  let index = 0;
  return (input, init) => {
    // A part upload without a body would be a part of nothing, so the absence
    // is recorded as such rather than defaulted away.
    puts.push({ url: input, size: init.body?.size ?? -1 });
    const etag = etags[index] ?? '"etag"';
    index += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
    });
  };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(bytes);
    },
  });
}

const fakeHasher = {
  hash(
    file: File,
    onProgress?: (progress: { processedBytes: number; totalBytes: number }) => void,
  ) {
    onProgress?.({ processedBytes: file.size, totalBytes: file.size });
    return Promise.resolve(contentHash);
  },
};

function mintingIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `request-${next}`;
  };
}

/**
 * A `File` with only what the client touches: a name, a size, a declared type
 * and `slice`. The real one is never available in a node test environment, and
 * the range each part carries is the one thing worth asserting on.
 */
function browserFile(name: string, size: number): File {
  return {
    name,
    size,
    type: 'video/mp4',
    slice: (start = 0, end = size) => ({ size: end - start }) as Blob,
  } as unknown as File;
}
