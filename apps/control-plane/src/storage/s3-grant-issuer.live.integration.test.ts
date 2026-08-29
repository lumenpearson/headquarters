import { randomBytes } from 'node:crypto';

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadControlPlaneConfig, type ControlPlaneStorageConfig } from '../config.js';
import { planUploadParts, storageKeyFor } from '../material/store.js';

import { createS3GrantIssuer } from './s3-grant-issuer.js';
import { emptyPayloadHash } from './sigv4.js';

/**
 * The object-storage path against a real S3-compatible store.
 *
 * Every other test in this directory drives a scripted bucket: it can show
 * which URL was signed and how a documented answer is read, and nothing about
 * whether a store accepts the signature, whether a client `PUT` to a part
 * grant returns the etag the completion then sends, whether
 * `CompleteMultipartUpload` assembles the object, or whether a download grant
 * serves the bytes. Those four steps were written and never run — the gap
 * `docs/release/known-limitations.md` recorded under "Object storage is
 * implemented and unproven against a live bucket".
 *
 * This suite runs them. It is opt-in through `HQ_CONTROL_PLANE_TEST_STORAGE_*`
 * so the default `pnpm test` run stays offline, and it is destructive by
 * design: it creates a bucket named after the instant it started, fills it, and
 * removes both the objects and the bucket afterwards. MinIO is the store it was
 * proved against — `docs/release/self-hosting.md` names it as a supported
 * candidate — and nothing here is specific to MinIO beyond path-style
 * addressing, which is configuration.
 *
 * The multipart sizes are not arbitrary: S3 and MinIO both refuse a
 * non-final part below 5 MiB, so a two-part upload has to spend a real 5 MiB
 * for the assembly step to mean anything.
 */
const liveStorage = liveTestStorage();
const describeLive = liveStorage === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const partSize = 5 * 1024 * 1024;
const tailSize = 4096;

interface LiveStorageSettings {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: string;
}

/**
 * Reads the store's address out of the environment, or answers `undefined` so
 * the suite skips. No default and no fallback: a connection string never enters
 * this repository, and a suite that silently pointed at something would be a
 * suite that could delete it.
 */
function liveTestStorage(): LiveStorageSettings | undefined {
  const endpoint = process.env.HQ_CONTROL_PLANE_TEST_STORAGE_ENDPOINT;
  const accessKeyId = process.env.HQ_CONTROL_PLANE_TEST_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.HQ_CONTROL_PLANE_TEST_STORAGE_SECRET_ACCESS_KEY;
  if (
    endpoint === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    endpoint.trim().length === 0
  ) {
    return undefined;
  }
  return {
    endpoint,
    region: process.env.HQ_CONTROL_PLANE_TEST_STORAGE_REGION ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
    forcePathStyle: process.env.HQ_CONTROL_PLANE_TEST_STORAGE_FORCE_PATH_STYLE ?? 'true',
  };
}

describeLive('S3 grant issuer against a live S3-compatible bucket', () => {
  const settings = liveStorage ?? ({} as LiveStorageSettings);
  const bucket = `hqtest-storage-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const groupId = `018b2a02-0000-7000-8000-${randomBytes(6).toString('hex')}`;

  let config: ControlPlaneStorageConfig;
  const writtenKeys: string[] = [];

  beforeAll(async () => {
    config = storageConfig(bucket);
    // Bucket creation is itself the first live SigV4 proof: a store that
    // disagreed with the signature would refuse here, before any grant exists.
    const created = await signedCall(config, 'PUT', bucketUrl(config));
    expect(created.status, await created.text()).toBe(200);
  }, networkTimeoutMs);

  afterAll(async () => {
    for (const key of writtenKeys) {
      await signedCall(config, 'DELETE', objectUrl(config, key)).catch(() => undefined);
    }
    await signedCall(config, 'DELETE', bucketUrl(config)).catch(() => undefined);
  }, networkTimeoutMs);

  it(
    'runs the whole upload lifecycle: part grants, client PUTs, assembly, verification and download',
    async () => {
      const issuer = createS3GrantIssuer(config);
      const payload = deterministicPayload(partSize + tailSize);
      const contentHash = bytesToHex(blake3(payload));
      const storageKey = storageKeyFor(groupId, contentHash);
      writtenKeys.push(storageKey);

      // 1. The control plane opens the multipart upload with its own credential.
      const handle = await issuer.createMultipartUpload({
        storageKey,
        mimeType: 'application/octet-stream',
      });
      expect(handle.remoteUploadId.length).toBeGreaterThan(0);

      // 2. It plans the parts exactly as `BeginUpload` does and presigns one
      //    URL per part. Nothing below this line holds the deployment secret.
      const parts = planUploadParts(BigInt(payload.byteLength), partSize);
      expect(parts.map((part) => part.length)).toEqual([BigInt(partSize), BigInt(tailSize)]);

      const completedParts: { readonly partNumber: number; readonly etag: string }[] = [];
      for (const part of parts) {
        const grant = await issuer.issueUploadPart({
          remoteUploadId: handle.remoteUploadId,
          storageKey,
          partNumber: part.partNumber,
        });
        expect(grant.url).not.toContain(settings.secretAccessKey);

        // 3. The client PUT. It is a bare `fetch` with no credential of its
        //    own, because that is the entire point of a presigned grant.
        const slice = payload.subarray(Number(part.offset), Number(part.offset + part.length));
        const uploaded = await fetch(grant.url, { method: 'PUT', body: requestBody(slice) });
        expect(uploaded.status, await uploaded.text()).toBe(200);
        const etag = uploaded.headers.get('etag');
        expect(etag).not.toBeNull();
        completedParts.push({ partNumber: part.partNumber, etag: etag ?? '' });
      }

      // 4. The etags travel back through the completion the client would send.
      await expect(
        issuer.completeMultipartUpload({
          storageKey,
          remoteUploadId: handle.remoteUploadId,
          parts: [...completedParts].reverse(),
        }),
      ).resolves.toBeUndefined();

      // 5. The assembled object is what the client declared: the read-back
      //    hashes 5 MiB + 4 KiB out of the store and gets the same BLAKE3.
      await expect(
        issuer.verifyObject({ storageKey, contentHash, byteSize: BigInt(payload.byteLength) }),
      ).resolves.toEqual({ outcome: 'verified' });

      // 6. The same read-back over a real object refuses a hash that is not
      //    its own, and notices a declared size the object does not have.
      await expect(
        issuer.verifyObject({
          storageKey,
          contentHash: bytesToHex(blake3(Buffer.from('a different file'))),
          byteSize: BigInt(payload.byteLength),
        }),
      ).resolves.toEqual({ outcome: 'hash-mismatch' });
      await expect(
        issuer.verifyObject({ storageKey, contentHash, byteSize: 12n }),
      ).resolves.toEqual({
        outcome: 'size-mismatch',
        actualByteSize: BigInt(payload.byteLength),
      });

      // 7. A download grant serves the bytes, as an attachment.
      const download = await issuer.issueDownload({
        materialId: 'm',
        versionId: 'v',
        storageKey,
        contentHash,
        mimeType: 'application/octet-stream',
        byteSize: BigInt(payload.byteLength),
      });
      const downloaded = await fetch(download.url);
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('content-disposition')).toBe('attachment');
      const served = new Uint8Array(await downloaded.arrayBuffer());
      expect(served.byteLength).toBe(payload.byteLength);
      expect(bytesToHex(blake3(served))).toBe(contentHash);

      // 8. A preview grant serves the same object inline, which is what the
      //    "every variant is the original" note in the contract means in the
      //    absence of a conversion pipeline.
      const preview = await issuer.issuePreview({
        materialId: 'm',
        versionId: 'v',
        storageKey,
        contentHash,
        mimeType: 'video/mp4',
        variant: 'thumbnail',
        byteSize: BigInt(payload.byteLength),
      });
      const previewed = await fetch(preview.url);
      expect(previewed.status).toBe(200);
      expect(previewed.headers.get('content-disposition')).toBe('inline');
      expect(previewed.headers.get('content-type')).toBe('video/mp4');
      expect(preview.mimeType).toBe('video/mp4');
    },
    networkTimeoutMs,
  );

  it(
    'aborts an upload so no object is assembled and the completion can no longer succeed',
    async () => {
      const issuer = createS3GrantIssuer(config);
      const payload = deterministicPayload(partSize);
      const contentHash = bytesToHex(blake3(payload));
      const storageKey = storageKeyFor(groupId, contentHash);

      const handle = await issuer.createMultipartUpload({
        storageKey,
        mimeType: 'application/octet-stream',
      });
      const grant = await issuer.issueUploadPart({
        remoteUploadId: handle.remoteUploadId,
        storageKey,
        partNumber: 1,
      });
      const uploaded = await fetch(grant.url, { method: 'PUT', body: requestBody(payload) });
      expect(uploaded.status).toBe(200);
      const etag = uploaded.headers.get('etag') ?? '';

      await expect(
        issuer.abortMultipartUpload({ storageKey, remoteUploadId: handle.remoteUploadId }),
      ).resolves.toBeUndefined();

      // The uploaded part is gone with the upload: nothing was assembled, so
      // the verification the completion would have run reports no object.
      await expect(
        issuer.verifyObject({ storageKey, contentHash, byteSize: BigInt(payload.byteLength) }),
      ).resolves.toEqual({ outcome: 'missing' });

      // A completion after the abort must fail rather than resurrect the
      // upload. The issuer's NoSuchUpload branch only forgives the case where
      // the object is already there, and here it is not.
      await expect(
        issuer.completeMultipartUpload({
          storageKey,
          remoteUploadId: handle.remoteUploadId,
          parts: [{ partNumber: 1, etag }],
        }),
      ).rejects.toThrow(/CompleteMultipartUpload failed/u);

      // Aborting twice is the state an abort asks for, so it stays quiet.
      await expect(
        issuer.abortMultipartUpload({ storageKey, remoteUploadId: handle.remoteUploadId }),
      ).resolves.toBeUndefined();
    },
    networkTimeoutMs,
  );

  it(
    'refuses a signature the store did not authorize',
    async () => {
      const wrongKey = createS3GrantIssuer(
        storageConfig(bucket, { secretAccessKey: 'not-the-deployment-secret-at-all' }),
      );

      await expect(
        wrongKey.createMultipartUpload({
          storageKey: storageKeyFor(groupId, 'f'.repeat(64)),
          mimeType: 'application/octet-stream',
        }),
      ).rejects.toThrow(/CreateMultipartUpload failed with status 403/u);
    },
    networkTimeoutMs,
  );

  function storageConfig(
    bucketName: string,
    overrides: { readonly secretAccessKey?: string } = {},
  ): ControlPlaneStorageConfig {
    const storage = loadControlPlaneConfig({
      HQ_CONTROL_PLANE_STORAGE_ENDPOINT: settings.endpoint,
      HQ_CONTROL_PLANE_STORAGE_REGION: settings.region,
      HQ_CONTROL_PLANE_STORAGE_BUCKET: bucketName,
      HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID: settings.accessKeyId,
      HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY:
        overrides.secretAccessKey ?? settings.secretAccessKey,
      HQ_CONTROL_PLANE_STORAGE_FORCE_PATH_STYLE: settings.forcePathStyle,
    }).storage;
    if (storage === undefined) throw new Error('storage configuration expected');
    return storage;
  }
});

/** Bucket-level administration the issuer has no business offering; only the test needs it. */
function bucketUrl(config: ControlPlaneStorageConfig): URL {
  return new URL(`${new URL(config.endpoint).origin}/${config.bucket}`);
}

function objectUrl(config: ControlPlaneStorageConfig, storageKey: string): URL {
  const encoded = storageKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return new URL(`${new URL(config.endpoint).origin}/${config.bucket}/${encoded}`);
}

function signedCall(
  config: ControlPlaneStorageConfig,
  method: string,
  url: URL,
): Promise<Response> {
  const headers = config.sign({
    method,
    url,
    payloadHash: emptyPayloadHash,
    signedAt: new Date(),
  });
  return fetch(url.toString(), { method, headers: { ...headers } });
}

/** `fetch` takes an `ArrayBuffer`, not a view over one. */
function requestBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * A payload large enough to be a real multipart upload and cheap enough to
 * build: a repeating counter, so the bytes are not compressible into a
 * degenerate digest and are the same on every run of the same size.
 */
function deterministicPayload(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 31 + (index >> 8)) & 0xff;
  }
  return bytes;
}
