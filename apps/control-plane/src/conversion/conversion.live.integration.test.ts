import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { createMaterialService } from '../material/service.js';
import { DurableMaterialStore, storageKeyFor } from '../material/store.js';
import { createS3GrantIssuer } from '../storage/s3-grant-issuer.js';
import { createS3ObjectStore } from '../storage/s3-object-store.js';
import { emptyPayloadHash } from '../storage/sigv4.js';
import { DurablePairedDeviceRuntime } from '../sync/durable-runtime.js';

import { createFfmpegRenditionRenderer } from './renderer.js';
import { DurableConversionStore } from './store.js';
import { MaterialConversionWorker } from './worker.js';

/**
 * The whole pipeline, against everything real at once.
 *
 * A live PostgreSQL holds the queue, a live S3-compatible bucket holds the
 * bytes, and a real ffmpeg does the work. This is the only place that can
 * settle the claim the release notes carried for months -- "every preview
 * variant is the original object, because no conversion pipeline renders
 * another" -- because settling it means fetching a preview grant and observing
 * that the bytes it serves are neither the same length nor the same digest as
 * the object that was uploaded.
 *
 * The media fixture is generated here by ffmpeg itself: two seconds of colour
 * bars and a 440 Hz sine, encoded to H.264/AAC in a temporary directory that
 * is removed afterwards. Nothing binary is committed, and the fixture is
 * deterministic in shape -- 1280x720, 25 fps -- which is what the no-upscale
 * assertion below reads.
 *
 * Opt-in through `HQ_CONTROL_PLANE_TEST_DATABASE_URL`, the
 * `HQ_CONTROL_PLANE_TEST_STORAGE_*` group and
 * `HQ_CONTROL_PLANE_TEST_FFMPEG_PATH`. Destructive in the first two: it creates
 * and drops its own database and its own bucket. No connection string and no
 * credential is committed.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const liveStorage = liveTestStorage();
const ffmpegPath = process.env.HQ_CONTROL_PLANE_TEST_FFMPEG_PATH;
const ffprobePath = process.env.HQ_CONTROL_PLANE_TEST_FFPROBE_PATH ?? 'ffprobe';
const describeLive =
  testDatabaseUrl === undefined || liveStorage === undefined || ffmpegPath === undefined
    ? describe.skip
    : describe;
const networkTimeoutMs = 300_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';

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

describeLive('rendition pipeline against live PostgreSQL, a live bucket and real ffmpeg', () => {
  const settings = liveStorage ?? ({} as LiveStorageSettings);
  const pool = new DisposableDatabasePool(testDatabaseUrl ?? '');
  const bucket = `hqtest-rendition-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const writtenKeys: string[] = [];
  let database: SqlClient;
  let storage: ControlPlaneStorageConfig;
  let workDirectory = '';
  let sourceBytes = new Uint8Array();

  beforeAll(async () => {
    database = await pool.create();
    await runMigrations(database);
    storage = storageConfig();
    const created = await signedCall(storage, 'PUT', bucketUrl(storage));
    expect(created.status, await created.text()).toBe(200);

    workDirectory = await mkdtemp(join(tmpdir(), 'hq-rendition-live-'));
    sourceBytes = await generateFixture(join(workDirectory, 'source.mp4'));
    // A real, decodable take: colour bars and a sine, not random bytes. The
    // pipeline's whole point is that ffmpeg reads it.
    expect(sourceBytes.byteLength).toBeGreaterThan(4096);
  }, networkTimeoutMs);

  afterAll(async () => {
    for (const key of writtenKeys) {
      await signedCall(storage, 'DELETE', objectUrl(storage, key)).catch(() => undefined);
    }
    await signedCall(storage, 'DELETE', bucketUrl(storage)).catch(() => undefined);
    await pool.dropAll();
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
  }, networkTimeoutMs);

  it(
    'renders the queued ladder and serves a preview variant that is not the original',
    async () => {
      const owner = await bootstrapGroup();
      const context = handlerContext(owner.accessToken);
      const service = materialService();
      const contentHash = bytesToHex(blake3(sourceBytes));
      const sourceKey = storageKeyFor(owner.groupId, contentHash);
      writtenKeys.push(sourceKey);

      const uploaded = await uploadSource(service, context, owner.groupId, contentHash);
      // The upload completion is the first producer: the whole declared ladder
      // is queued before anyone opens a menu.
      expect(await jobKinds(uploaded.versionId)).toEqual(['1080p', '480p', '720p']);

      const outcomes = await worker().runUntilIdle();

      expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
        'completed',
        'completed',
        'completed',
      ]);
      const renditions = await database.query<{
        variant: string;
        width: number;
        height: number;
        byte_size: string;
        storage_key: string;
        mime_type: string;
      }>({
        text: `SELECT variant, width, height, byte_size::text AS byte_size, storage_key, mime_type
               FROM material_renditions WHERE version_id = $1
               -- The variant breaks the tie, because the no-upscale rule makes
               -- 1080p and 720p the same height for a 720-tall source.
               ORDER BY height DESC, variant`,
        values: [uploaded.versionId],
      });
      for (const rendition of renditions) writtenKeys.push(rendition.storage_key);

      expect(renditions.map((rendition) => rendition.variant)).toEqual(['1080p', '720p', '480p']);
      // The no-upscale rule, measured rather than declared: a 720-tall source
      // asked for 1080p produces a 720-tall object, and the row says 720.
      expect(renditions[0]?.height).toBe(720);
      expect(renditions[1]?.height).toBe(720);
      expect(renditions[2]?.height).toBe(480);
      expect(renditions[2]?.width).toBe(854);
      expect(renditions.every((rendition) => rendition.mime_type === 'video/mp4')).toBe(true);

      // Every rendition really is in the bucket, at the key the row names.
      for (const rendition of renditions) {
        const stored = await signedCall(storage, 'GET', objectUrl(storage, rendition.storage_key));
        expect(stored.status, rendition.storage_key).toBe(200);
        const bytes = new Uint8Array(await stored.arrayBuffer());
        expect(BigInt(bytes.byteLength)).toBe(BigInt(rendition.byte_size));
      }

      // And the grant serves those bytes to a client holding no credential.
      // This is the claim the release notes carried: a preview variant that is
      // not the original object under another name.
      const preview = await service.getPreviewGrant?.(
        create(materialV1.GetPreviewGrantRequestSchema, {
          materialId: { value: uploaded.materialId },
          variant: '480p',
        }),
        context,
      );
      expect(preview?.grant?.height).toBe(480);
      expect(preview?.grant?.width).toBe(854);
      expect(preview?.grant?.url).toContain(`renditions/${owner.groupId}/${contentHash}/480p.mp4`);
      const served = await fetch(preview?.grant?.url ?? '');
      expect(served.status).toBe(200);
      expect(served.headers.get('content-disposition')).toBe('inline');
      const previewBytes = new Uint8Array(await served.arrayBuffer());
      expect(previewBytes.byteLength).toBeLessThan(sourceBytes.byteLength);
      expect(bytesToHex(blake3(previewBytes))).not.toBe(contentHash);

      // The original is still reachable, unchanged, under the empty variant.
      const original = await service.getPreviewGrant?.(
        create(materialV1.GetPreviewGrantRequestSchema, {
          materialId: { value: uploaded.materialId },
          variant: '',
        }),
        context,
      );
      const originalServed = await fetch(original?.grant?.url ?? '');
      expect(bytesToHex(blake3(new Uint8Array(await originalServed.arrayBuffer())))).toBe(
        contentHash,
      );

      // Nothing is left on the control plane's disk.
      const jobs = await database.query<{ state: string; detail: string | null }>({
        text: 'SELECT state, detail FROM conversion_jobs WHERE version_id = $1',
        values: [uploaded.versionId],
      });
      expect(jobs.map((job) => job.state)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);
      expect(jobs.every((job) => job.detail === null)).toBe(true);
    },
    networkTimeoutMs,
  );

  /*
   * The honest-failure requirement, with a real ffmpeg producing the reason. A
   * file declared `video/mp4` that is not one queues a ladder, and each rung
   * fails with the tail of what ffmpeg said about it -- not a generic message
   * and not silence.
   */
  it(
    'records the ffmpeg failure tail on a job whose source is not decodable',
    async () => {
      const owner = await bootstrapGroup();
      const context = handlerContext(owner.accessToken);
      const service = materialService();
      const bytes = new TextEncoder().encode('this declares itself a video and is not one');
      const contentHash = bytesToHex(blake3(bytes));
      writtenKeys.push(storageKeyFor(owner.groupId, contentHash));

      const uploaded = await uploadSource(service, context, owner.groupId, contentHash, bytes);
      const outcomes = await worker().runUntilIdle();

      expect(outcomes.every((outcome) => outcome.outcome === 'failed')).toBe(true);
      // Three rungs, each retried to the default ceiling of three attempts:
      // a decode failure could have been a truncated download, so the job goes
      // back to PENDING until the ceiling and only then stays FAILED. A drain
      // takes those retries immediately; the production loop spaces them by its
      // poll interval.
      expect(outcomes).toHaveLength(9);
      const jobs = await database.query<{ state: string; detail: string; attempt: number }>({
        text: 'SELECT state, detail, attempt FROM conversion_jobs WHERE version_id = $1',
        values: [uploaded.versionId],
      });
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job.state).toBe('FAILED');
        expect(job.attempt).toBe(3);
        // The reason a real ffmpeg gave, not a generic message and not silence.
        expect(job.detail).toContain('ffmpeg exited with 1');
        expect(job.detail).toContain('Invalid data found when processing input');
        // The bound holds against whatever ffmpeg actually printed.
        expect(job.detail.length).toBeLessThanOrEqual(500);
      }
      // No rendition row and no rendition object: a failed conversion leaves
      // the variant unbuilt rather than half-built.
      const renditions = await database.query({
        text: 'SELECT 1 FROM material_renditions WHERE version_id = $1',
        values: [uploaded.versionId],
      });
      expect(renditions).toHaveLength(0);
      // The preview still answers, with the original: a library whose
      // conversions fail is a library that serves what it has.
      const preview = await service.getPreviewGrant?.(
        create(materialV1.GetPreviewGrantRequestSchema, {
          materialId: { value: uploaded.materialId },
          variant: '720p',
        }),
        context,
      );
      expect(preview?.grant?.url).toContain(storageKeyFor(owner.groupId, contentHash));
      expect(preview?.grant?.width).toBe(0);
    },
    networkTimeoutMs,
  );

  function worker(): MaterialConversionWorker {
    return new MaterialConversionWorker({
      store: new DurableConversionStore({ database }),
      objects: createS3ObjectStore(storage),
      renderer: createFfmpegRenditionRenderer({
        ffmpegPath: ffmpegPath ?? 'ffmpeg',
        ffprobePath,
        timeoutMs: 120_000,
      }),
      workDirectory,
    });
  }

  function materialService() {
    const runtime = new DurablePairedDeviceRuntime({ database, tokenPepper });
    return createMaterialService({
      runtime,
      store: new DurableMaterialStore({ database, receipts: runtime.receiptGuard }),
      renditions: new DurableConversionStore({ database }),
      storage: createS3GrantIssuer(storage),
    });
  }

  async function uploadSource(
    service: ReturnType<typeof materialService>,
    context: HandlerContext,
    groupId: string,
    contentHash: string,
    bytes: Uint8Array = sourceBytes,
  ): Promise<{ readonly materialId: string; readonly versionId: string }> {
    const begun = await service.beginUpload?.(
      create(materialV1.BeginUploadRequestSchema, {
        context: { requestId: `begin-${randomBytes(8).toString('hex')}` },
        groupId: { value: groupId },
        materialId: { value: randomUUID() },
        displayName: 'Съёмка',
        originalFileName: 'take.mp4',
        category: materialV1.MaterialCategory.VIDEO,
        mimeType: 'video/mp4',
        totalSize: BigInt(bytes.byteLength),
        contentHash,
      }),
      context,
    );
    const grant = begun?.parts?.[0];
    const put = await fetch(grant?.uploadUrl ?? '', {
      method: 'PUT',
      body: requestBody(bytes),
    });
    expect(put.status, await put.text()).toBe(200);
    const completed = await service.completeUpload?.(
      create(materialV1.CompleteUploadRequestSchema, {
        context: { requestId: `complete-${randomBytes(8).toString('hex')}` },
        uploadId: { value: begun?.session?.id?.value ?? '' },
        contentHash,
        parts: [
          {
            partNumber: grant?.partNumber ?? 1,
            etag: put.headers.get('etag') ?? '',
            checksum: '',
          },
        ],
      }),
      context,
    );
    return {
      materialId: completed?.material?.id?.value ?? '',
      versionId: completed?.version?.id?.value ?? '',
    };
  }

  async function jobKinds(versionId: string): Promise<readonly string[]> {
    const rows = await database.query<{ kind: string }>({
      text: 'SELECT kind FROM conversion_jobs WHERE version_id = $1 ORDER BY kind',
      values: [versionId],
    });
    return rows.map((row) => row.kind);
  }

  async function bootstrapGroup(): Promise<{
    readonly groupId: string;
    readonly accessToken: string;
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
    return { groupId: created.group.id, accessToken: created.session.accessToken };
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

/**
 * Two seconds of colour bars and a 440 Hz sine, encoded by the same ffmpeg the
 * worker runs. Generated rather than committed: a repository that carries a
 * media file carries it forever, and `lavfi` produces the same picture on every
 * machine.
 */
async function generateFixture(path: string): Promise<Uint8Array<ArrayBuffer>> {
  await runFfmpeg([
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=1280x720:rate=25:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    path,
  ]);
  const { size } = await stat(path);
  if (size === 0) throw new Error('ffmpeg produced no fixture');
  // Copied into a plain `ArrayBuffer`: `readFile` answers a Buffer over a
  // pooled allocation, which the strict `Uint8Array<ArrayBuffer>` this suite
  // passes to `fetch` and to blake3 is not.
  const buffer = await readFile(path);
  const bytes = new Uint8Array(new ArrayBuffer(buffer.byteLength));
  bytes.set(buffer);
  return bytes;
}

function runFfmpeg(args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      ffmpegPath ?? 'ffmpeg',
      [...args],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error === null) resolve();
        else reject(new Error(`fixture generation failed: ${stderr}`));
      },
    );
  });
}

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

/** `fetch` takes an `ArrayBuffer`, not a view over one. */
function requestBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
