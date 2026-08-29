import { createHash } from 'node:crypto';

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { loadControlPlaneConfig, type ControlPlaneStorageConfig } from '../config.js';

import {
  StorageBackendError,
  createS3GrantIssuer,
  type StorageFetch,
  type StorageFetchRequest,
} from './s3-grant-issuer.js';
import { emptyPayloadHash, sha256Hex } from './sigv4.js';

/**
 * The issuer against a scripted bucket.
 *
 * What a fake `fetch` can prove: which URL, method, headers and body each
 * multipart operation sends, how each documented S3 answer is read, and that
 * no response or error ever carries the secret. What it cannot prove is that a
 * real bucket accepts the request; that stays open until one exists (see
 * `docs/release/known-limitations.md`).
 */
const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const fixedNow = new Date('2026-08-25T10:00:00Z');
const storageKey = 'materials/018b2a02-0000-7000-8000-0000000000a1/sha256:0f1e2d3c';

function config(overrides: Readonly<Record<string, string>> = {}): ControlPlaneStorageConfig {
  const storage = loadControlPlaneConfig({
    HQ_CONTROL_PLANE_STORAGE_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
    HQ_CONTROL_PLANE_STORAGE_REGION: 'eu-central-1',
    HQ_CONTROL_PLANE_STORAGE_BUCKET: 'gremuchaya-materials',
    HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY: secretAccessKey,
    ...overrides,
  }).storage;
  if (storage === undefined) throw new Error('storage configuration expected');
  return storage;
}

interface RecordedCall {
  readonly url: string;
  readonly request: StorageFetchRequest;
}

function scriptedFetch(
  answers: readonly {
    readonly status: number;
    readonly body?: string;
    /** Supplied only where the scenario is an object read-back rather than XML. */
    readonly bytes?: readonly Uint8Array[];
  }[],
): {
  readonly fetch: StorageFetch;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = [...answers];
  return {
    calls,
    fetch: (url, request) => {
      calls.push({ url, request });
      const answer = queue.shift();
      if (answer === undefined) throw new Error('unexpected bucket call');
      const bytes = answer.bytes;
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        text: () => Promise.resolve(answer.body ?? ''),
        // Several chunks rather than one, so the incremental digest is proved
        // to be incremental: a single-chunk answer would pass even if the
        // issuer hashed only the last piece it saw.
        ...(bytes === undefined
          ? {}
          : {
              chunks: (): AsyncIterable<Uint8Array> => toAsyncIterable(bytes),
            }),
      };
    },
  };
}

describe('S3 grant issuer: presigned grants', () => {
  it('addresses a part by the bucket host, the encoded key and the remote upload id', async () => {
    const issuer = createS3GrantIssuer(config(), { now: () => fixedNow });

    const grant = await issuer.issueUploadPart({
      remoteUploadId: 'remote-1',
      storageKey,
      partNumber: 3,
    });
    const url = new URL(grant.url);

    expect(url.origin).toBe('https://gremuchaya-materials.s3.eu-central-1.amazonaws.com');
    // The content hash's colon is a path character, encoded once.
    expect(url.pathname).toBe('/materials/018b2a02-0000-7000-8000-0000000000a1/sha256%3A0f1e2d3c');
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('uploadId')).toBe('remote-1');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20260825/eu-central-1/s3/aws4_request',
    );
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260825T100000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/u);
    expect(grant.expiresAt).toEqual(new Date('2026-08-25T10:15:00Z'));
    expect(grant.url).not.toContain(secretAccessKey);
  });

  it('uses path-style addressing and the configured lifetime when told to', async () => {
    const issuer = createS3GrantIssuer(
      config({
        HQ_CONTROL_PLANE_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
        HQ_CONTROL_PLANE_STORAGE_FORCE_PATH_STYLE: 'true',
        HQ_CONTROL_PLANE_STORAGE_GRANT_TTL_SECONDS: '120',
      }),
      { now: () => fixedNow },
    );

    const grant = await issuer.issueUploadPart({
      remoteUploadId: 'remote-1',
      storageKey,
      partNumber: 1,
    });
    const url = new URL(grant.url);

    expect(url.origin).toBe('http://127.0.0.1:9000');
    expect(url.pathname).toBe(
      '/gremuchaya-materials/materials/018b2a02-0000-7000-8000-0000000000a1/sha256%3A0f1e2d3c',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(grant.expiresAt).toEqual(new Date('2026-08-25T10:02:00Z'));
  });

  it('signs the method into the grant, so a part URL cannot be replayed as a GET', async () => {
    const issuer = createS3GrantIssuer(config(), { now: () => fixedNow });
    const object = {
      materialId: 'm',
      versionId: 'v',
      storageKey,
      contentHash: 'sha256:0f1e2d3c',
      mimeType: 'video/mp4',
      byteSize: 1024n,
    };

    const download = new URL((await issuer.issueDownload(object)).url);
    const preview = await issuer.issuePreview({ ...object, variant: 'thumbnail' });
    const previewUrl = new URL(preview.url);

    expect(download.searchParams.get('response-content-disposition')).toBe('attachment');
    expect(download.searchParams.get('response-content-type')).toBe('video/mp4');
    expect(previewUrl.searchParams.get('response-content-disposition')).toBe('inline');
    expect(preview.mimeType).toBe('video/mp4');
    // Same key, same instant, different query and method: different signatures.
    expect(download.searchParams.get('X-Amz-Signature')).not.toBe(
      previewUrl.searchParams.get('X-Amz-Signature'),
    );
    const part = new URL(
      (await issuer.issueUploadPart({ remoteUploadId: 'remote-1', storageKey, partNumber: 1 })).url,
    );
    expect(part.searchParams.get('X-Amz-Signature')).not.toBe(
      download.searchParams.get('X-Amz-Signature'),
    );
  });
});

describe('S3 grant issuer: multipart lifecycle', () => {
  it('opens a multipart upload with a signed POST and reads the UploadId', async () => {
    const bucket = scriptedFetch([
      {
        status: 200,
        body:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          '<Bucket>gremuchaya-materials</Bucket><Key>materials/x</Key>' +
          '<UploadId>VXBsb2FkIElEIGZvciBlbHZpbmcncyBteS1tb3ZpZS5tMnRzIHVwbG9hZA</UploadId>' +
          '</InitiateMultipartUploadResult>',
      },
    ]);
    const issuer = createS3GrantIssuer(config(), { fetch: bucket.fetch, now: () => fixedNow });

    const handle = await issuer.createMultipartUpload({ storageKey, mimeType: 'video/mp4' });

    expect(handle.remoteUploadId).toBe(
      'VXBsb2FkIElEIGZvciBlbHZpbmcncyBteS1tb3ZpZS5tMnRzIHVwbG9hZA',
    );
    const call = bucket.calls[0];
    expect(call?.request.method).toBe('POST');
    expect(call?.url).toBe(
      'https://gremuchaya-materials.s3.eu-central-1.amazonaws.com/materials/018b2a02-0000-7000-8000-0000000000a1/sha256%3A0f1e2d3c?uploads=',
    );
    expect(call?.request.body).toBeUndefined();
    expect(call?.request.headers).toMatchObject({
      host: 'gremuchaya-materials.s3.eu-central-1.amazonaws.com',
      'content-type': 'video/mp4',
      'x-amz-date': '20260825T100000Z',
      'x-amz-content-sha256': emptyPayloadHash,
    });
    expect(call?.request.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260825\/eu-central-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u,
    );
    expect(JSON.stringify(call)).not.toContain(secretAccessKey);
  });

  it('refuses an opened upload the bucket did not name, and a bucket that refused', async () => {
    const noId = createS3GrantIssuer(config(), {
      fetch: scriptedFetch([{ status: 200, body: '<InitiateMultipartUploadResult/>' }]).fetch,
    });
    await expect(noId.createMultipartUpload({ storageKey, mimeType: 'video/mp4' })).rejects.toThrow(
      'response carried no UploadId',
    );

    const denied = createS3GrantIssuer(config(), {
      fetch: scriptedFetch([
        {
          status: 403,
          body: `<Error><Code>SignatureDoesNotMatch</Code><StringToSign>${secretAccessKey}</StringToSign></Error>`,
        },
      ]).fetch,
    });
    let error: unknown;
    try {
      await denied.createMultipartUpload({ storageKey, mimeType: 'video/mp4' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StorageBackendError);
    expect(String(error)).toContain('CreateMultipartUpload failed with status 403');
    expect(String(error)).toContain('SignatureDoesNotMatch');
    // The bucket's own body is bounded, never the secret: a store would not
    // know it, and this one only echoed what the test planted to prove the
    // detail is passed through as text, not interpreted.
    expect((error as StorageBackendError).status).toBe(403);
  });

  it('completes with the parts in order and the etags escaped, and reads a 200 <Error> as failure', async () => {
    const bucket = scriptedFetch([
      {
        status: 200,
        body: '<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>',
      },
      {
        status: 200,
        body: '<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>',
      },
    ]);
    const issuer = createS3GrantIssuer(config(), { fetch: bucket.fetch, now: () => fixedNow });
    const completion = {
      storageKey,
      remoteUploadId: 'remote-1',
      parts: [
        { partNumber: 2, etag: '"b"' },
        { partNumber: 1, etag: '"a&c"' },
      ],
    };

    await issuer.completeMultipartUpload(completion);
    const call = bucket.calls[0];
    expect(call?.request.method).toBe('POST');
    expect(new URL(call?.url ?? '').searchParams.get('uploadId')).toBe('remote-1');
    expect(call?.request.body).toBe(
      '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        '<Part><PartNumber>1</PartNumber><ETag>&quot;a&amp;c&quot;</ETag></Part>' +
        '<Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag></Part>' +
        '</CompleteMultipartUpload>',
    );
    expect(call?.request.headers['x-amz-content-sha256']).toBe(sha256Hex(call?.request.body ?? ''));
    expect(call?.request.headers['content-type']).toBe('application/xml');

    // S3 documents that CompleteMultipartUpload can answer 200 OK with an
    // Error element in the body; treating the status alone as success would
    // record a READY material over an object that was never assembled.
    await expect(issuer.completeMultipartUpload(completion)).rejects.toThrow(
      'CompleteMultipartUpload failed with status 200: <Error><Code>InternalError</Code>',
    );
  });

  it('treats NoSuchUpload as done when the assembled object exists, and as failure when it does not', async () => {
    const noSuchUpload = {
      status: 404,
      body: '<Error><Code>NoSuchUpload</Code><Message>The specified upload does not exist.</Message></Error>',
    };
    const completion = {
      storageKey,
      remoteUploadId: 'remote-1',
      parts: [{ partNumber: 1, etag: '"a"' }],
    };

    const assembled = scriptedFetch([noSuchUpload, { status: 200 }]);
    await expect(
      createS3GrantIssuer(config(), { fetch: assembled.fetch }).completeMultipartUpload(completion),
    ).resolves.toBeUndefined();
    expect(assembled.calls.map((call) => call.request.method)).toEqual(['POST', 'HEAD']);
    expect(new URL(assembled.calls[1]?.url ?? '').search).toBe('');

    const missing = scriptedFetch([noSuchUpload, { status: 404 }]);
    await expect(
      createS3GrantIssuer(config(), { fetch: missing.fetch }).completeMultipartUpload(completion),
    ).rejects.toThrow('CompleteMultipartUpload failed with status 404');
  });

  it('aborts with a signed DELETE and accepts an upload that is already gone', async () => {
    const bucket = scriptedFetch([
      { status: 204 },
      { status: 404, body: '<Error><Code>NoSuchUpload</Code></Error>' },
      { status: 500, body: '<Error><Code>InternalError</Code></Error>' },
    ]);
    const issuer = createS3GrantIssuer(config(), { fetch: bucket.fetch });
    const abort = { storageKey, remoteUploadId: 'remote-1' };

    await expect(issuer.abortMultipartUpload(abort)).resolves.toBeUndefined();
    await expect(issuer.abortMultipartUpload(abort)).resolves.toBeUndefined();
    await expect(issuer.abortMultipartUpload(abort)).rejects.toThrow(
      'AbortMultipartUpload failed with status 500',
    );
    expect(bucket.calls[0]?.request.method).toBe('DELETE');
    expect(new URL(bucket.calls[0]?.url ?? '').searchParams.get('uploadId')).toBe('remote-1');
  });
});

/**
 * The read-back that decides whether the assembled object is the content the
 * material declared. These scenarios drive the digest logic; whether a real
 * store hands back the bytes it was given is proved against MinIO in
 * `s3-grant-issuer.live.integration.test.ts`.
 */
describe('S3 grant issuer: object verification', () => {
  const payload = Buffer.from('гремучая смесь — кадр 17', 'utf8');
  const blake3Hex = bytesToHex(blake3(payload));
  const sha256Digest = createHash('sha256').update(payload).digest('hex');
  const halves = [
    new Uint8Array(payload.subarray(0, 7)),
    new Uint8Array(payload.subarray(7)),
  ] as const;

  it('signs a GET the server sends itself and accepts an object that hashes to the bare BLAKE3 digest', async () => {
    const bucket = scriptedFetch([{ status: 200, bytes: halves }]);
    const issuer = createS3GrantIssuer(config(), { fetch: bucket.fetch, now: () => fixedNow });

    const verification = await issuer.verifyObject({
      storageKey,
      contentHash: blake3Hex,
      byteSize: BigInt(payload.byteLength),
    });

    expect(verification).toEqual({ outcome: 'verified' });
    const call = bucket.calls[0];
    expect(call?.request.method).toBe('GET');
    // No query at all: the read-back addresses the object itself, not a grant,
    // so it carries neither a part number nor a response-content override.
    expect(new URL(call?.url ?? '').search).toBe('');
    expect(call?.request.headers['x-amz-content-sha256']).toBe(emptyPayloadHash);
    expect(call?.request.headers.authorization).toContain('AWS4-HMAC-SHA256 Credential=');
    // The read-back is a signed request, never a presigned URL: a URL that
    // hands out an object's bytes must not exist for this purpose.
    expect(call?.url).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(call)).not.toContain(secretAccessKey);
  });

  it('accepts the two explicit digest prefixes and refuses every other format', async () => {
    const prefixedBlake3 = await createS3GrantIssuer(config(), {
      fetch: scriptedFetch([{ status: 200, bytes: halves }]).fetch,
    }).verifyObject({
      storageKey,
      contentHash: `blake3:${blake3Hex}`,
      byteSize: BigInt(payload.byteLength),
    });
    expect(prefixedBlake3).toEqual({ outcome: 'verified' });

    const prefixedSha256 = await createS3GrantIssuer(config(), {
      fetch: scriptedFetch([{ status: 200, bytes: halves }]).fetch,
    }).verifyObject({
      storageKey,
      contentHash: `sha256:${sha256Digest}`,
      byteSize: BigInt(payload.byteLength),
    });
    expect(prefixedSha256).toEqual({ outcome: 'verified' });

    // `content_hash` is validated by the store as a storage-key-safe string,
    // which is far wider than a digest. Anything this issuer cannot recompute
    // is refused rather than waved through, and refused without a bucket call:
    // an unverifiable hash is decided before a byte is spent.
    for (const unverifiable of [
      'sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0',
      blake3Hex.toUpperCase(),
      `md5:${'0'.repeat(64)}`,
      blake3Hex.slice(0, 63),
    ]) {
      const bucket = scriptedFetch([]);
      const verification = await createS3GrantIssuer(config(), {
        fetch: bucket.fetch,
      }).verifyObject({
        storageKey,
        contentHash: unverifiable,
        byteSize: BigInt(payload.byteLength),
      });
      expect(verification).toEqual({ outcome: 'unverifiable-digest' });
      expect(bucket.calls).toHaveLength(0);
    }
  });

  it('reports a hash mismatch when the bytes are a different file of the same length', async () => {
    const impostor = Buffer.from(payload);
    impostor[0] = (impostor[0] ?? 0) ^ 0xff;
    const issuer = createS3GrantIssuer(config(), {
      fetch: scriptedFetch([{ status: 200, bytes: [new Uint8Array(impostor)] }]).fetch,
    });

    const verification = await issuer.verifyObject({
      storageKey,
      contentHash: blake3Hex,
      byteSize: BigInt(payload.byteLength),
    });

    expect(verification).toEqual({ outcome: 'hash-mismatch' });
  });

  it('reports a size mismatch, counting the bytes it streamed rather than a header', async () => {
    const issuer = createS3GrantIssuer(config(), {
      fetch: scriptedFetch([{ status: 200, bytes: [halves[0]] }]).fetch,
    });

    const verification = await issuer.verifyObject({
      storageKey,
      contentHash: blake3Hex,
      byteSize: BigInt(payload.byteLength),
    });

    expect(verification).toEqual({ outcome: 'size-mismatch', actualByteSize: 7n });
  });

  it('reports a missing object, and raises a backend error for any other refusal', async () => {
    const missing = createS3GrantIssuer(config(), {
      fetch: scriptedFetch([{ status: 404, body: '<Error><Code>NoSuchKey</Code></Error>' }]).fetch,
    });
    await expect(
      missing.verifyObject({ storageKey, contentHash: blake3Hex, byteSize: 24n }),
    ).resolves.toEqual({ outcome: 'missing' });

    const denied = createS3GrantIssuer(config(), {
      fetch: scriptedFetch([
        {
          status: 403,
          body: `<Error><Code>AccessDenied</Code><StringToSign>${secretAccessKey}</StringToSign></Error>`,
        },
      ]).fetch,
    });
    let error: unknown;
    try {
      await denied.verifyObject({ storageKey, contentHash: blake3Hex, byteSize: 24n });
    } catch (caught) {
      error = caught;
    }
    // A store that refuses the read is a backend failure, not a verdict about
    // the bytes: answering `hash-mismatch` there would blame the client for an
    // outage. It must be distinguishable, so it throws.
    expect(error).toBeInstanceOf(StorageBackendError);
    expect((error as StorageBackendError).status).toBe(403);
    expect(String(error)).toContain('GetObject failed with status 403');

    const bodiless = createS3GrantIssuer(config(), {
      fetch: scriptedFetch([{ status: 200 }]).fetch,
    });
    await expect(
      bodiless.verifyObject({ storageKey, contentHash: blake3Hex, byteSize: 24n }),
    ).rejects.toThrow('response carried no readable body');
  });
});

async function* toAsyncIterable(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield await Promise.resolve(chunk);
  }
}
