import { randomBytes, randomUUID } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import type { HandlerContext } from '@connectrpc/connect';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { materialV1 } from '@gremuchaya/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadControlPlaneConfig, type ControlPlaneStorageConfig } from '../config.js';
import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { createS3GrantIssuer } from '../storage/s3-grant-issuer.js';
import { emptyPayloadHash } from '../storage/sigv4.js';
import { DurablePairedDeviceRuntime } from '../sync/durable-runtime.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import { createMaterialService } from './service.js';
import { DurableMaterialStore, storageKeyFor } from './store.js';

/**
 * `MaterialService` over a live bucket and a live database at once.
 *
 * `material.integration.test.ts` proves the database half against PostgreSQL
 * with a stand-in bucket, and `storage/s3-grant-issuer.live.integration.test.ts`
 * proves the bucket half against MinIO with no database. Neither can show the
 * shape the plan called unproven: `BeginUpload` planning parts a real store
 * accepts, a client `PUT` returning an etag the completion sends back,
 * `CompleteUpload` assembling the object *and* then reading it back before the
 * version is recorded, and `GetDownloadGrant` serving the bytes that went in.
 * That whole line is what this suite runs.
 *
 * Opt-in through `HQ_CONTROL_PLANE_TEST_DATABASE_URL` *and*
 * `HQ_CONTROL_PLANE_TEST_STORAGE_*`; destructive in both, creating and dropping
 * its own database and its own bucket. No connection string is committed.
 *
 * The chunk size is 5 MiB rather than the deployment default of 8, because S3
 * and MinIO refuse a non-final part below 5 MiB and the suite wants two parts
 * without moving 9 MiB to get them.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const liveStorage = liveTestStorage();
const describeLive =
  testDatabaseUrl === undefined || liveStorage === undefined ? describe.skip : describe;
const networkTimeoutMs = 180_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';
const uploadChunkSize = 5 * 1024 * 1024;

interface LiveStorageSettings {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: string;
}

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

describeLive('material upload lifecycle against a live bucket and live PostgreSQL', () => {
  const settings = liveStorage ?? ({} as LiveStorageSettings);
  const pool = new DisposableDatabasePool(testDatabaseUrl ?? '');
  const bucket = `hqtest-material-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const writtenKeys: string[] = [];
  let database: SqlClient;
  let storage: ControlPlaneStorageConfig;

  beforeAll(async () => {
    database = await pool.create();
    await runMigrations(database);
    storage = storageConfig();
    const created = await signedCall(storage, 'PUT', bucketUrl(storage));
    expect(created.status, await created.text()).toBe(200);
  }, networkTimeoutMs);

  afterAll(async () => {
    for (const key of writtenKeys) {
      await signedCall(storage, 'DELETE', objectUrl(storage, key)).catch(() => undefined);
    }
    await signedCall(storage, 'DELETE', bucketUrl(storage)).catch(() => undefined);
    await pool.dropAll();
  }, networkTimeoutMs);

  it(
    'carries a file from BeginUpload through client PUTs to a download grant that serves it back',
    async () => {
      const owner = await bootstrapGroup();
      const service = materialService();
      const context = handlerContext(owner.accessToken);
      const payload = deterministicPayload(uploadChunkSize + 4096, 7);
      const contentHash = bytesToHex(blake3(payload));
      const storageKey = storageKeyFor(owner.groupId, contentHash);
      writtenKeys.push(storageKey);

      const begun = await service.beginUpload?.(
        beginRequest(owner.groupId, contentHash, BigInt(payload.byteLength)),
        context,
      );
      // Two parts, because a real store's multipart minimum is what the chunk
      // size was chosen against, and both grants address the live bucket.
      const grants = partGrants(begun?.parts);
      expect(grants).toHaveLength(2);
      expect(begun?.deduplicated).toBe(false);
      for (const grant of grants) {
        expect(grant.uploadUrl).toContain(settings.endpoint);
        expect(grant.uploadUrl).not.toContain(settings.secretAccessKey);
      }

      const completedParts: CompletedPart[] = [];
      for (const grant of grants) {
        const slice = payload.subarray(grant.offset, grant.offset + grant.length);
        const uploaded = await fetch(grant.uploadUrl, { method: 'PUT', body: requestBody(slice) });
        expect(uploaded.status, await uploaded.text()).toBe(200);
        completedParts.push({
          partNumber: grant.partNumber,
          etag: uploaded.headers.get('etag') ?? '',
          checksum: '',
        });
      }

      const completed = await service.completeUpload?.(
        create(materialV1.CompleteUploadRequestSchema, {
          context: { requestId: `complete-${randomBytes(8).toString('hex')}` },
          uploadId: { value: begun?.session?.id?.value ?? '' },
          contentHash,
          parts: completedParts,
        }),
        context,
      );
      expect(completed?.material?.status).toBe(materialV1.MaterialStatus.READY);
      expect(completed?.version?.contentHash).toBe(contentHash);

      // The object really is in the bucket, at the key the content hash names.
      const stored = await signedCall(storage, 'GET', objectUrl(storage, storageKey));
      expect(stored.status).toBe(200);
      expect(bytesToHex(blake3(new Uint8Array(await stored.arrayBuffer())))).toBe(contentHash);

      // And the download grant hands the same bytes to a client that holds no
      // credential of its own.
      const download = await service.getDownloadGrant?.(
        create(materialV1.GetDownloadGrantRequestSchema, {
          materialId: { value: completed?.material?.id?.value ?? '' },
        }),
        context,
      );
      const served = await fetch(download?.grant?.url ?? '');
      expect(served.status).toBe(200);
      expect(served.headers.get('content-disposition')).toBe('attachment');
      const bytes = new Uint8Array(await served.arrayBuffer());
      expect(bytes.byteLength).toBe(payload.byteLength);
      expect(bytesToHex(blake3(bytes))).toBe(contentHash);
      expect(download?.grant?.contentHash).toBe(contentHash);
      expect(download?.grant?.byteSize).toBe(BigInt(payload.byteLength));
    },
    networkTimeoutMs,
  );

  it(
    'refuses to record a version when the uploaded bytes are not the content the client declared',
    async () => {
      const owner = await bootstrapGroup();
      const service = materialService();
      const context = handlerContext(owner.accessToken);
      const declared = deterministicPayload(65_536, 11);
      const substituted = deterministicPayload(65_536, 12);
      const contentHash = bytesToHex(blake3(declared));
      const storageKey = storageKeyFor(owner.groupId, contentHash);
      writtenKeys.push(storageKey);
      expect(substituted.byteLength).toBe(declared.byteLength);

      const begun = await service.beginUpload?.(
        beginRequest(owner.groupId, contentHash, BigInt(declared.byteLength)),
        context,
      );
      const grant = partGrants(begun?.parts)[0];
      expect(grant).toBeDefined();
      // The dishonest client: it declared one file's digest and sends another
      // file of exactly the same length, so nothing but a re-derived digest can
      // tell the difference.
      const uploaded = await fetch(grant?.uploadUrl ?? '', {
        method: 'PUT',
        body: requestBody(substituted),
      });
      expect(uploaded.status).toBe(200);

      const uploadId = begun?.session?.id?.value ?? '';
      await expect(
        Promise.resolve(
          service.completeUpload?.(
            create(materialV1.CompleteUploadRequestSchema, {
              context: { requestId: `complete-${randomBytes(8).toString('hex')}` },
              uploadId: { value: uploadId },
              contentHash,
              parts: [
                {
                  partNumber: grant?.partNumber ?? 1,
                  etag: uploaded.headers.get('etag') ?? '',
                  checksum: '',
                },
              ],
            }),
            context,
          ),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('does not match the content this material reserved'),
      });

      // The refusal is what keeps the library honest: no version row, no READY
      // material, and no `material_objects` reference a later deduplicated
      // upload of the same hash could land on.
      const rows = await database.query<{
        status: string;
        versions: number;
        session_state: string;
      }>({
        text: `SELECT material.status,
                      (SELECT count(*)::int FROM material_versions WHERE material_id = material.id) AS versions,
                      (SELECT state FROM upload_sessions WHERE id = $2) AS session_state
               FROM materials AS material
               WHERE material.group_id = $1 AND material.content_hash = $3`,
        values: [owner.groupId, uploadId, contentHash],
      });
      expect(rows[0]?.status).not.toBe('READY');
      expect(rows[0]?.versions).toBe(0);
      expect(rows[0]?.session_state).not.toBe('COMPLETED');
    },
    networkTimeoutMs,
  );

  it(
    'cancels an upload and takes the bucket multipart upload down with it',
    async () => {
      const owner = await bootstrapGroup();
      const service = materialService();
      const context = handlerContext(owner.accessToken);
      const payload = deterministicPayload(65_536, 23);
      const contentHash = bytesToHex(blake3(payload));
      const storageKey = storageKeyFor(owner.groupId, contentHash);

      const begun = await service.beginUpload?.(
        beginRequest(owner.groupId, contentHash, BigInt(payload.byteLength)),
        context,
      );
      const uploaded = await fetch(partGrants(begun?.parts)[0]?.uploadUrl ?? '', {
        method: 'PUT',
        body: requestBody(payload),
      });
      expect(uploaded.status).toBe(200);

      await service.cancelUpload?.(
        create(materialV1.CancelUploadRequestSchema, {
          context: { requestId: `cancel-${randomBytes(8).toString('hex')}` },
          uploadId: { value: begun?.session?.id?.value ?? '' },
        }),
        context,
      );

      // Nothing was assembled, so the key holds no object: an abort that only
      // updated the database would leave the part data behind in the store.
      const missing = await signedCall(storage, 'GET', objectUrl(storage, storageKey));
      expect(missing.status).toBe(404);
      const session = await database.query<{ state: string }>({
        text: 'SELECT state FROM upload_sessions WHERE id = $1',
        values: [begun?.session?.id?.value ?? ''],
      });
      expect(session[0]?.state).toBe('CANCELLED');
    },
    networkTimeoutMs,
  );

  function materialService() {
    const runtime = new DurablePairedDeviceRuntime({ database, tokenPepper });
    return createMaterialService({
      runtime,
      store: new DurableMaterialStore({
        database,
        receipts: runtime.receiptGuard,
        uploadChunkSize,
      }),
      storage: createS3GrantIssuer(storage),
    });
  }

  function beginRequest(groupId: string, contentHash: string, totalSize: bigint) {
    return create(materialV1.BeginUploadRequestSchema, {
      context: { requestId: `begin-${randomBytes(8).toString('hex')}` },
      groupId: { value: groupId },
      materialId: { value: randomUUID() },
      displayName: 'Съёмка',
      originalFileName: 'take.bin',
      category: materialV1.MaterialCategory.VIDEO,
      mimeType: 'application/octet-stream',
      totalSize,
      contentHash,
    });
  }

  async function bootstrapGroup(): Promise<{
    readonly groupId: string;
    readonly accessToken: string;
    readonly authenticated: AuthenticatedDevice;
  }> {
    const runtime = new DurablePairedDeviceRuntime({ database, tokenPepper });
    const created = await runtime.createGroup({
      name: `Terminal ${randomBytes(8).toString('hex')}`,
      initialDevice: {
        name: 'HQ primary',
        publicKey: `ed25519:${randomBytes(8).toString('hex')}`,
        platform: 'windows',
        applicationVersion: '0.1.0',
      },
    });
    return {
      groupId: created.group.id,
      accessToken: created.session.accessToken,
      authenticated: await runtime.authenticateAccessToken(created.session.accessToken),
    };
  }

  function storageConfig(): ControlPlaneStorageConfig {
    const parsed = loadControlPlaneConfig({
      HQ_CONTROL_PLANE_STORAGE_ENDPOINT: settings.endpoint,
      HQ_CONTROL_PLANE_STORAGE_REGION: settings.region,
      HQ_CONTROL_PLANE_STORAGE_BUCKET: bucket,
      HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID: settings.accessKeyId,
      HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY: settings.secretAccessKey,
      HQ_CONTROL_PLANE_STORAGE_FORCE_PATH_STYLE: settings.forcePathStyle,
    }).storage;
    if (parsed === undefined) throw new Error('storage configuration expected');
    return parsed;
  }
});

/** The two fields the material handlers read; the rest of the context is unused. */
function handlerContext(accessToken: string): HandlerContext {
  return {
    requestHeader: new Headers({ authorization: `Bearer ${accessToken}` }),
    signal: new AbortController().signal,
  } as unknown as HandlerContext;
}

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

interface CompletedPart {
  readonly partNumber: number;
  readonly etag: string;
  readonly checksum: string;
}

interface PartGrant {
  readonly partNumber: number;
  readonly offset: number;
  readonly length: number;
  readonly uploadUrl: string;
}

/**
 * A handler returns a message *initializer*, in which every field is optional,
 * so the grants are narrowed once here rather than defended against at each
 * use. A missing field would fail the assertions that follow either way.
 */
function partGrants(
  parts:
    | readonly Partial<{ partNumber: number; offset: bigint; length: bigint; uploadUrl: string }>[]
    | undefined,
): readonly PartGrant[] {
  return (parts ?? []).map((grant) => ({
    partNumber: grant.partNumber ?? 0,
    offset: Number(grant.offset ?? 0n),
    length: Number(grant.length ?? 0n),
    uploadUrl: grant.uploadUrl ?? '',
  }));
}

/** `fetch` takes an `ArrayBuffer`, not a view over one. */
function requestBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** Deterministic bytes; `seed` is what makes two payloads of one length differ. */
function deterministicPayload(byteLength: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    bytes[index] = (index * 31 + seed) & 0xff;
  }
  return bytes;
}
