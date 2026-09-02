import { randomBytes, randomUUID } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import type { HandlerContext } from '@connectrpc/connect';
import { materialV1 } from '@gremuchaya/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import {
  createMaterialService,
  type StorageGrantIssuer,
  type StorageMultipartCompletion,
  type StorageMultipartTarget,
  type StorageObjectVerification,
  type StoragePreviewRequest,
  type StorageUploadPartRequest,
} from '../material/service.js';
import { DurableMaterialStore, storageKeyFor } from '../material/store.js';
import { DurablePairedDeviceRuntime } from '../sync/durable-runtime.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import { DurableConversionStore } from './store.js';

/**
 * Real PostgreSQL proof for the conversion queue.
 *
 * Every scenario here turns on something only an engine can demonstrate, and
 * `store.test.ts` deliberately proves none of them. That two sequential claims
 * take two different rows is `FOR UPDATE ... SKIP LOCKED` executing, not a
 * string in a statement. That queueing twice queues once is a unique index
 * rejecting a row. That a stale worker's completion changes nothing is the
 * attempt fence failing to match a row the re-claim already moved. That an
 * expired lease returns a job is a timestamp comparison inside the claim.
 *
 * Opt-in through `HQ_CONTROL_PLANE_TEST_DATABASE_URL`; the suite creates and
 * drops its own database and is destructive by design. No connection string is
 * committed.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';

describeIntegration('conversion queue against real PostgreSQL', () => {
  const pool = new DisposableDatabasePool(testDatabaseUrl ?? '');
  let database: SqlClient;

  beforeAll(async () => {
    const swept = await pool.sweep();
    if (swept.dropped.length > 0) {
      process.stderr.write(`Swept abandoned test databases: ${swept.dropped.join(', ')}\n`);
    }
    database = await pool.create();
    await runMigrations(database);
  }, networkTimeoutMs);

  // A worker serves every group this control plane holds, so `claimNextJob`
  // has no group filter and a scenario would otherwise claim the leftovers of
  // the one before it. The scoping belongs to the fixture, not to the query.
  beforeEach(async () => {
    await database.query({ text: 'DELETE FROM material_renditions' });
    await database.query({ text: 'DELETE FROM conversion_jobs' });
  });

  afterAll(async () => {
    await pool.dropAll();
  }, networkTimeoutMs);

  it(
    'queues the whole declared ladder when an upload completes, and nothing for a type with no ladder',
    async () => {
      const owner = await bootstrapGroup();

      const video = await uploadMaterial(owner, 'video/mp4');
      expect(await jobKinds(video.versionId)).toEqual(['1080p', '480p', '720p']);
      expect(await jobStates(video.versionId)).toEqual(['PENDING', 'PENDING', 'PENDING']);

      const archive = await uploadMaterial(owner, 'application/zip');
      expect(await jobKinds(archive.versionId)).toEqual([]);
    },
    networkTimeoutMs,
  );

  /*
   * Both producers run: the upload completion queues the ladder, and any
   * preview grant that finds nothing built queues the rung it was asked for.
   * Without `UNIQUE (version_id, kind)` the second would add three more rows
   * and three more ffmpeg processes for one output.
   */
  it(
    'queues a rung once however many times it is asked for',
    async () => {
      const owner = await bootstrapGroup();
      const video = await uploadMaterial(owner, 'video/mp4');
      const conversions = conversionStore();

      await conversions.enqueueRenditions(owner.authenticated, video.materialId, video.versionId, [
        '720p',
        '720p',
        '480p',
      ]);
      const again = await conversions.enqueueRenditions(
        owner.authenticated,
        video.materialId,
        video.versionId,
        ['720p'],
      );

      expect(again.queued).toEqual([]);
      expect(await jobKinds(video.versionId)).toEqual(['1080p', '480p', '720p']);
    },
    networkTimeoutMs,
  );

  it(
    'hands one job to one claimer and never the same row twice while its lease is live',
    async () => {
      const owner = await bootstrapGroup();
      const video = await uploadMaterial(owner, 'video/mp4');
      const conversions = conversionStore();

      const first = await conversions.claimNextJob();
      const second = await conversions.claimNextJob();
      const third = await conversions.claimNextJob();
      const fourth = await conversions.claimNextJob();

      const claimed = [first, second, third].map((claim) => claim?.variant).sort();
      expect(claimed).toEqual(['1080p', '480p', '720p']);
      // The fourth call finds three live leases and nothing else queued.
      expect(fourth).toBeUndefined();
      expect(first?.attempt).toBe(1);
      expect(first?.sourceStorageKey).toBe(storageKeyFor(owner.groupId, video.contentHash));
      expect(first?.sourceMimeType).toBe('video/mp4');
      expect(await jobStates(video.versionId)).toEqual(['RUNNING', 'RUNNING', 'RUNNING']);
    },
    networkTimeoutMs,
  );

  it(
    'returns a job whose lease expired, at a higher attempt',
    async () => {
      const owner = await bootstrapGroup();
      const video = await uploadMaterial(owner, 'video/mp4');
      // A lease measured in milliseconds is a worker that has already died by
      // the time the next claim runs.
      const shortLease = conversionStore({ leaseMs: 1 });

      const first = await shortLease.claimNextJob();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const reclaimed = await shortLease.claimNextJob();
      const reclaimedAgain = [reclaimed];
      while (reclaimedAgain.at(-1)?.variant !== first?.variant) {
        const next = await shortLease.claimNextJob();
        if (next === undefined) break;
        reclaimedAgain.push(next);
      }

      const takenOver = reclaimedAgain.find((claim) => claim?.variant === first?.variant);
      expect(takenOver?.jobId).toBe(first?.jobId);
      expect(takenOver?.attempt).toBe(2);
      expect(await jobKinds(video.versionId)).toHaveLength(3);
    },
    networkTimeoutMs,
  );

  /*
   * The fence. A worker whose lease expired mid-render must not overwrite the
   * rendition the worker that took the job over has just recorded -- a
   * read-then-write claim, or a completion matched on the job id alone, would
   * let exactly that happen.
   */
  it(
    'lets the live claim complete and makes the taken-over one a no-op',
    async () => {
      const owner = await bootstrapGroup();
      const video = await uploadMaterial(owner, 'video/mp4');
      const shortLease = conversionStore({ leaseMs: 1 });

      const stale = await shortLease.claimNextJob();
      expect(stale).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 25));
      let live = await shortLease.claimNextJob();
      while (live !== undefined && live.jobId !== stale?.jobId) {
        live = await shortLease.claimNextJob();
      }
      expect(live?.attempt).toBe(2);

      const liveCompleted = await shortLease.completeJob(
        live ?? throwMissing(),
        rendition(owner.groupId, video.contentHash, '720p', 1280, 720),
      );
      const staleCompleted = await shortLease.completeJob(
        stale ?? throwMissing(),
        rendition(owner.groupId, video.contentHash, '720p', 4, 4),
      );

      expect(liveCompleted).toBe(true);
      expect(staleCompleted).toBe(false);
      const stored = await database.query<{ width: number; height: number }>({
        text: 'SELECT width, height FROM material_renditions WHERE version_id = $1',
        values: [video.versionId],
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.width).toBe(1280);
    },
    networkTimeoutMs,
  );

  it(
    'records a bounded failure detail and returns the job until the attempt ceiling',
    async () => {
      const owner = await bootstrapGroup();
      await uploadMaterial(owner, 'video/mp4');
      const conversions = conversionStore({ maxAttempts: 2 });

      const first = await conversions.claimNextJob();
      const firstState = await conversions.failJob(
        first ?? throwMissing(),
        `${'noise '.repeat(200)}Invalid data found when processing input`,
      );
      expect(firstState).toBe('PENDING');

      let second = await conversions.claimNextJob();
      while (second !== undefined && second.jobId !== first?.jobId) {
        second = await conversions.claimNextJob();
      }
      expect(second?.attempt).toBe(2);
      expect(await conversions.failJob(second ?? throwMissing(), 'Invalid data found')).toBe(
        'FAILED',
      );

      const row = await database.query<{ state: string; detail: string; attempt: number }>({
        text: 'SELECT state, detail, attempt FROM conversion_jobs WHERE id = $1',
        values: [first?.jobId ?? ''],
      });
      expect(row[0]?.state).toBe('FAILED');
      expect(row[0]?.detail).toBe('Invalid data found');
      // The ceiling is what stops the retry, and a FAILED job is not claimable.
      const remaining: string[] = [];
      for (let taken = 0; taken < 6; taken += 1) {
        const claim = await conversions.claimNextJob();
        if (claim === undefined) break;
        remaining.push(claim.jobId);
      }
      expect(remaining).not.toContain(first?.jobId);
    },
    networkTimeoutMs,
  );

  it(
    'bounds a long failure detail before it reaches the row',
    async () => {
      const owner = await bootstrapGroup();
      await uploadMaterial(owner, 'video/mp4');
      const conversions = conversionStore();
      const claim = await conversions.claimNextJob();

      await conversions.failJob(claim ?? throwMissing(), 'x'.repeat(4000));

      const row = await database.query<{ detail: string }>({
        text: 'SELECT detail FROM conversion_jobs WHERE id = $1',
        values: [claim?.jobId ?? ''],
      });
      expect(row[0]?.detail).toHaveLength(500);
    },
    networkTimeoutMs,
  );

  it(
    'does not claim a job whose material was moved to the trash',
    async () => {
      const owner = await bootstrapGroup();
      const video = await uploadMaterial(owner, 'video/mp4');
      const service = materialService();
      await service.moveToTrash?.(
        create(materialV1.MoveToTrashRequestSchema, {
          context: { requestId: `trash-${randomBytes(8).toString('hex')}` },
          materialId: { value: video.materialId },
        }),
        handlerContext(owner.accessToken),
      );

      await expect(conversionStore().claimNextJob()).resolves.toBeUndefined();
      // The rows are still there: trashing is reversible, so the work waits
      // rather than being discarded.
      expect(await jobKinds(video.versionId)).toHaveLength(3);
    },
    networkTimeoutMs,
  );

  /*
   * The whole point of the pipeline, end to end through the RPC: before a
   * rendition exists the grant is the original object and says so by carrying
   * the original's MIME type and no dimensions; after one exists the grant
   * addresses the rendition's own key.
   */
  it(
    'signs the original before a rendition exists and the rendition key after',
    async () => {
      const owner = await bootstrapGroup();
      const video = await uploadMaterial(owner, 'video/mp4');
      const service = materialService();
      const context = handlerContext(owner.accessToken);
      const originalKey = storageKeyFor(owner.groupId, video.contentHash);

      const before = await service.getPreviewGrant?.(
        create(materialV1.GetPreviewGrantRequestSchema, {
          materialId: { value: video.materialId },
          variant: '720p',
        }),
        context,
      );
      expect(before?.grant?.url).toContain(originalKey);
      expect(before?.grant?.mimeType).toBe('video/mp4');
      expect(before?.grant?.width).toBe(0);

      const conversions = conversionStore();
      let claim = await conversions.claimNextJob();
      while (claim !== undefined && claim.variant !== '720p') {
        claim = await conversions.claimNextJob();
      }
      await conversions.completeJob(
        claim ?? throwMissing(),
        rendition(owner.groupId, video.contentHash, '720p', 1280, 720),
      );

      const after = await service.getPreviewGrant?.(
        create(materialV1.GetPreviewGrantRequestSchema, {
          materialId: { value: video.materialId },
          variant: '720p',
        }),
        context,
      );
      expect(after?.grant?.url).toContain(
        `renditions/${owner.groupId}/${video.contentHash}/720p.mp4`,
      );
      expect(after?.grant?.url).not.toContain(originalKey);
      expect(after?.grant?.width).toBe(1280);
      expect(after?.grant?.height).toBe(720);

      // A variant with no rendition still answers, with the original.
      const other = await service.getPreviewGrant?.(
        create(materialV1.GetPreviewGrantRequestSchema, {
          materialId: { value: video.materialId },
          variant: '480p',
        }),
        context,
      );
      expect(other?.grant?.url).toContain(originalKey);
    },
    networkTimeoutMs,
  );

  /*
   * The demand-driven producer, and its bound. A library uploaded before this
   * pipeline existed has no queued ladder at all; opening its menu is what
   * fills the queue. A variant that is not a rung must queue nothing, or a
   * read RPC would be a way to create unbounded rows.
   */
  it(
    'queues a ladder rung a preview asked for, and nothing for a variant that is not one',
    async () => {
      const owner = await bootstrapGroup();
      const video = await uploadMaterial(owner, 'video/mp4');
      await database.query({
        text: 'DELETE FROM conversion_jobs WHERE version_id = $1',
        values: [video.versionId],
      });
      const service = materialService();
      const context = handlerContext(owner.accessToken);

      await service.getPreviewGrant?.(
        create(materialV1.GetPreviewGrantRequestSchema, {
          materialId: { value: video.materialId },
          variant: '480p',
        }),
        context,
      );
      expect(await jobKinds(video.versionId)).toEqual(['480p']);

      for (const variant of ['4k', 'h-264@4-5-mbps', '', 'thumbnail']) {
        await service.getPreviewGrant?.(
          create(materialV1.GetPreviewGrantRequestSchema, {
            materialId: { value: video.materialId },
            variant,
          }),
          context,
        );
      }
      expect(await jobKinds(video.versionId)).toEqual(['480p']);
    },
    networkTimeoutMs,
  );

  it(
    'refuses to queue anything for a revoked membership',
    async () => {
      const owner = await bootstrapGroup();
      const video = await uploadMaterial(owner, 'video/mp4');
      await database.query({
        text: 'UPDATE group_memberships SET revoked_at = now() WHERE device_id = $1',
        values: [owner.authenticated.device.id],
      });

      await expect(
        conversionStore().enqueueRenditions(
          owner.authenticated,
          video.materialId,
          video.versionId,
          ['720p'],
        ),
      ).rejects.toMatchObject({
        message: 'The authenticated device is no longer an active member of the group.',
      });
    },
    networkTimeoutMs,
  );

  it(
    'does not read another group s rendition through its own membership',
    async () => {
      const owner = await bootstrapGroup();
      const stranger = await bootstrapGroup();
      const video = await uploadMaterial(owner, 'video/mp4');
      const conversions = conversionStore();
      const claim = await conversions.claimNextJob();
      await conversions.completeJob(
        claim ?? throwMissing(),
        rendition(owner.groupId, video.contentHash, claim?.variant ?? '720p', 1920, 1080),
      );

      await expect(
        conversions.readRendition(
          stranger.authenticated,
          video.materialId,
          video.versionId,
          claim?.variant ?? '720p',
        ),
      ).resolves.toBeUndefined();
      await expect(
        conversions.readRendition(
          owner.authenticated,
          video.materialId,
          video.versionId,
          claim?.variant ?? '720p',
        ),
      ).resolves.toMatchObject({ width: 1920, height: 1080 });
    },
    networkTimeoutMs,
  );

  function conversionStore(
    options: { readonly leaseMs?: number; readonly maxAttempts?: number } = {},
  ): DurableConversionStore {
    return new DurableConversionStore({
      database,
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    });
  }

  function materialService() {
    const runtime = new DurablePairedDeviceRuntime({ database, tokenPepper });
    return createMaterialService({
      runtime,
      store: new DurableMaterialStore({ database, receipts: runtime.receiptGuard }),
      renditions: conversionStore(),
      storage: scriptedIssuer(),
    });
  }

  async function uploadMaterial(
    owner: BootstrappedGroup,
    mimeType: string,
  ): Promise<{
    readonly materialId: string;
    readonly versionId: string;
    readonly contentHash: string;
  }> {
    const service = materialService();
    const context = handlerContext(owner.accessToken);
    const contentHash = randomBytes(32).toString('hex');
    const begun = await service.beginUpload?.(
      create(materialV1.BeginUploadRequestSchema, {
        context: { requestId: `begin-${randomBytes(8).toString('hex')}` },
        groupId: { value: owner.groupId },
        materialId: { value: randomUUID() },
        displayName: 'Съёмка',
        originalFileName: 'take.mov',
        category: materialV1.MaterialCategory.VIDEO,
        mimeType,
        totalSize: 1_048_576n,
        contentHash,
      }),
      context,
    );
    const completed = await service.completeUpload?.(
      create(materialV1.CompleteUploadRequestSchema, {
        context: { requestId: `complete-${randomBytes(8).toString('hex')}` },
        uploadId: { value: begun?.session?.id?.value ?? '' },
        contentHash,
        parts: [{ partNumber: 1, etag: '"etag-1"', checksum: '' }],
      }),
      context,
    );
    return {
      materialId: completed?.material?.id?.value ?? '',
      versionId: completed?.version?.id?.value ?? '',
      contentHash,
    };
  }

  async function jobKinds(versionId: string): Promise<readonly string[]> {
    const rows = await database.query<{ kind: string }>({
      text: 'SELECT kind FROM conversion_jobs WHERE version_id = $1 ORDER BY kind',
      values: [versionId],
    });
    return rows.map((row) => row.kind);
  }

  async function jobStates(versionId: string): Promise<readonly string[]> {
    const rows = await database.query<{ state: string }>({
      text: 'SELECT state FROM conversion_jobs WHERE version_id = $1 ORDER BY kind',
      values: [versionId],
    });
    return rows.map((row) => row.state);
  }

  async function bootstrapGroup(): Promise<BootstrappedGroup> {
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
});

interface BootstrappedGroup {
  readonly groupId: string;
  readonly accessToken: string;
  readonly authenticated: AuthenticatedDevice;
}

function rendition(
  groupId: string,
  contentHash: string,
  variant: string,
  width: number,
  height: number,
) {
  return {
    storageKey: `renditions/${groupId}/${contentHash}/${variant}.mp4`,
    mimeType: 'video/mp4',
    byteSize: 4_096n,
    width,
    height,
  };
}

function throwMissing(): never {
  throw new Error('expected a claimed conversion job');
}

/**
 * A bucket that answers without existing. This suite is about the queue, not
 * about object storage; the bytes side is proved against MinIO in
 * `conversion.live.integration.test.ts`.
 */
function scriptedIssuer(): StorageGrantIssuer {
  const expiresAt = new Date('2030-01-01T00:00:00.000Z');
  return {
    createMultipartUpload: (target: StorageMultipartTarget) =>
      Promise.resolve({ remoteUploadId: `remote-${target.storageKey}` }),
    issueUploadPart: (request: StorageUploadPartRequest) => ({
      url: `https://storage.invalid/${request.storageKey}?partNumber=${request.partNumber.toString()}`,
      expiresAt,
    }),
    completeMultipartUpload: (_completion: StorageMultipartCompletion) => Promise.resolve(),
    abortMultipartUpload: () => Promise.resolve(),
    verifyObject: (): Promise<StorageObjectVerification> =>
      Promise.resolve({ outcome: 'verified' }),
    issueDownload: (request) => ({
      url: `https://storage.invalid/${request.storageKey}`,
      expiresAt,
    }),
    issuePreview: (request: StoragePreviewRequest) => ({
      url: `https://storage.invalid/${request.storageKey}?variant=${request.variant}`,
      expiresAt,
      mimeType: request.mimeType,
    }),
  };
}

/** The two fields the material handlers read; the rest of the context is unused. */
function handlerContext(accessToken: string): HandlerContext {
  return {
    requestHeader: new Headers({ authorization: `Bearer ${accessToken}` }),
    signal: new AbortController().signal,
  } as unknown as HandlerContext;
}
