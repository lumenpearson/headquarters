import { randomBytes } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import type { HandlerContext } from '@connectrpc/connect';
import { materialV1 } from '@gremuchaya/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { DurablePairedDeviceRuntime } from '../sync/durable-runtime.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import { createMaterialService, type StorageGrantIssuer } from './service.js';
import { DurableMaterialStore, type BeginUploadOutcome } from './store.js';

/**
 * Real PostgreSQL proof for the material library.
 *
 * Every scenario here turns on something only an engine can demonstrate.
 * Deduplication is a row count and a reference count observed after two
 * uploads, not a branch in TypeScript. `materials.current_version_id` has no
 * foreign key, so the only way to know the pointer resolves is to join it.
 * Consecutive version sequences exist because two statements serialize on a row
 * lock, and `UNIQUE (material_id, sequence)` is standing by to reject them if
 * they do not. A scripted `SqlClient` can show the SQL that intends all of
 * this and nothing about whether it holds.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';

describeIntegration('durable material library against real PostgreSQL', () => {
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

  afterAll(async () => {
    await pool.dropAll();
  }, networkTimeoutMs);

  it(
    'stores one object for two materials that declare the same content',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const contentHash = uniqueContentHash();

      const first = await beginUpload(store, owner, contentHash, 'Съёмка A');
      const second = await beginUpload(store, owner, contentHash, 'Съёмка B');

      expect(first.deduplicated).toBe(false);
      expect(first.parts.length).toBeGreaterThan(0);
      // The second upload has nothing to send: the group already holds the
      // bytes, so it receives a ready material and no part grants at all.
      expect(second.deduplicated).toBe(true);
      expect(second.parts).toEqual([]);
      expect(second.material.status).toBe('READY');
      expect(second.material.currentVersionId).toBeDefined();

      const objects = await database.query<{ n: number; reference_count: number }>({
        text: `SELECT count(*)::int AS n, max(reference_count)::int AS reference_count
               FROM material_objects WHERE group_id = $1 AND content_hash = $2`,
        values: [owner.groupId, contentHash],
      });
      expect(objects[0]).toEqual({ n: 1, reference_count: 2 });

      const materials = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM materials WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(materials[0]?.n).toBe(2);
    },
    networkTimeoutMs,
  );

  it(
    'leaves current_version_id resolving to the version the completion wrote',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const contentHash = uniqueContentHash();
      const begun = await beginUpload(store, owner, contentHash, 'Съёмка');

      const completed = await store.completeUpload(
        owner.authenticated,
        begun.session.id,
        contentHash,
        begun.parts.map((part) => ({
          partNumber: part.partNumber,
          etag: `etag-${part.partNumber.toString()}`,
          checksum: `crc32c-${part.partNumber.toString()}`,
        })),
      );

      expect(completed.material.status).toBe('READY');
      expect(completed.material.currentVersionId).toBe(completed.version.id);

      // The schema cannot express this: current_version_id has no foreign key,
      // because one would cycle with material_versions.material_id. The join is
      // the only thing that can say the pointer is not dangling.
      const resolved = await database.query<{ version_id: string; sequence: string }>({
        text: `SELECT version.id AS version_id, version.sequence::text AS sequence
               FROM materials AS material
               JOIN material_versions AS version ON version.id = material.current_version_id
               WHERE material.id = $1`,
        values: [begun.material.id],
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.version_id).toBe(completed.version.id);
      expect(resolved[0]?.sequence).toBe(completed.version.sequence.toString());

      const session = await database.query<{ state: string; version_id: string }>({
        text: 'SELECT state, version_id FROM upload_sessions WHERE id = $1',
        values: [begun.session.id],
      });
      expect(session[0]?.state).toBe('COMPLETED');
      expect(session[0]?.version_id).toBe(completed.version.id);
    },
    networkTimeoutMs,
  );

  it(
    'creates one version however many times a completion is retried',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const contentHash = uniqueContentHash();
      const begun = await beginUpload(store, owner, contentHash, 'Съёмка');
      const requestId = `complete-${uniqueSuffix()}`;
      const parts = begun.parts.map((part) => ({
        partNumber: part.partNumber,
        etag: `etag-${part.partNumber.toString()}`,
        checksum: `crc32c-${part.partNumber.toString()}`,
      }));

      const first = await store.completeUpload(
        owner.authenticated,
        begun.session.id,
        contentHash,
        parts,
        { requestId },
      );
      const retry = await store.completeUpload(
        owner.authenticated,
        begun.session.id,
        contentHash,
        parts,
        { requestId },
      );

      expect(retry.version.id).toBe(first.version.id);
      expect(retry.material.revision).toBe(first.material.revision);
      const versions = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM material_versions WHERE material_id = $1',
        values: [begun.material.id],
      });
      expect(versions[0]?.n).toBe(1);
      const revision = await database.query<{ revision: string }>({
        text: 'SELECT revision::text AS revision FROM materials WHERE id = $1',
        values: [begun.material.id],
      });
      // A retry consumed no second revision either.
      expect(BigInt(revision[0]?.revision ?? '0')).toBe(first.material.revision);
    },
    networkTimeoutMs,
  );

  it(
    'drops a shared object only when the last material that named it is purged',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const contentHash = uniqueContentHash();
      const first = await beginUpload(store, owner, contentHash, 'Съёмка A');
      const second = await beginUpload(store, owner, contentHash, 'Съёмка B');

      // A live material cannot be purged; the trash is the only route to it.
      await expect(
        store.purgeMaterial(
          owner.authenticated,
          owner.groupId,
          first.material.id,
          first.material.id,
        ),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'FAILED_PRECONDITION',
      });

      await store.moveToTrash(owner.authenticated, owner.groupId, first.material.id);
      const purgedFirst = await store.purgeMaterial(
        owner.authenticated,
        owner.groupId,
        first.material.id,
        first.material.id,
      );
      expect(purgedFirst.objectRemoved).toBe(false);

      const afterFirst = await database.query<{ n: number; reference_count: number }>({
        text: `SELECT count(*)::int AS n, max(reference_count)::int AS reference_count
               FROM material_objects WHERE group_id = $1 AND content_hash = $2`,
        values: [owner.groupId, contentHash],
      });
      expect(afterFirst[0]).toEqual({ n: 1, reference_count: 1 });

      await store.moveToTrash(owner.authenticated, owner.groupId, second.material.id);
      const purgedSecond = await store.purgeMaterial(
        owner.authenticated,
        owner.groupId,
        second.material.id,
        second.material.id,
      );
      expect(purgedSecond.objectRemoved).toBe(true);

      const afterSecond = await database.query<{ n: number }>({
        text: `SELECT count(*)::int AS n
               FROM material_objects WHERE group_id = $1 AND content_hash = $2`,
        values: [owner.groupId, contentHash],
      });
      expect(afterSecond[0]?.n).toBe(0);
      // The count reached zero by deletion, never by a negative decrement the
      // column's own CHECK would have refused.
      const negative = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM material_objects WHERE reference_count < 0',
      });
      expect(negative[0]?.n).toBe(0);
    },
    networkTimeoutMs,
  );

  it(
    'gives two concurrent versions consecutive sequences with no duplicate',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const contentHash = uniqueContentHash();
      const begun = await beginUpload(store, owner, contentHash, 'Съёмка');
      const completed = await store.completeUpload(
        owner.authenticated,
        begun.session.id,
        contentHash,
        begun.parts.map((part) => ({
          partNumber: part.partNumber,
          etag: `etag-${part.partNumber.toString()}`,
          checksum: `crc32c-${part.partNumber.toString()}`,
        })),
      );

      // Both requests re-declare the content the material already holds, so the
      // only thing they contend over is the sequence. Nothing but the material
      // row lock keeps them from computing the same one, and
      // UNIQUE (material_id, sequence) is what would reject them if it did not.
      const outcomes = await Promise.all([
        store.createMaterialVersion(owner.authenticated, {
          groupId: owner.groupId,
          materialId: begun.material.id,
          originalFileName: 'take-02.mp4',
          mimeType: 'video/mp4',
          totalSize: 2048n,
          contentHash,
        }),
        store.createMaterialVersion(owner.authenticated, {
          groupId: owner.groupId,
          materialId: begun.material.id,
          originalFileName: 'take-03.mp4',
          mimeType: 'video/mp4',
          totalSize: 4096n,
          contentHash,
        }),
      ]);

      const sequences = outcomes.map((outcome) => outcome.version.sequence).sort();
      expect(sequences[1]).toBe((sequences[0] ?? 0n) + 1n);
      expect(sequences[0]).toBeGreaterThan(completed.version.sequence);

      const stored = await database.query<{ total: number; distinct_sequences: number }>({
        text: `SELECT count(*)::int AS total, count(DISTINCT sequence)::int AS distinct_sequences
               FROM material_versions WHERE material_id = $1`,
        values: [begun.material.id],
      });
      expect(stored[0]).toEqual({ total: 3, distinct_sequences: 3 });
    },
    networkTimeoutMs,
  );

  it(
    'refuses a viewer’s mutation and a revoked device’s read, and hides another group’s material',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const material = await beginUpload(store, owner, uniqueContentHash(), 'Съёмка');
      const viewer = await pairDevice(runtime, owner, 'VIEWER');
      const viewerAuthenticated = await runtime.authenticateAccessToken(viewer.accessToken);

      await expect(
        store.beginUpload(viewerAuthenticated, {
          groupId: owner.groupId,
          displayName: 'Чужая съёмка',
          originalFileName: 'take.mp4',
          category: 'VIDEO',
          mimeType: 'video/mp4',
          totalSize: 1024n,
          contentHash: uniqueContentHash(),
        }),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'PERMISSION_DENIED',
      });
      await expect(
        store.moveToTrash(viewerAuthenticated, owner.groupId, material.material.id),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'PERMISSION_DENIED',
      });
      // A viewer may still look at what the group holds.
      expect(
        (await store.listMaterials(viewerAuthenticated, owner.groupId, 0, '')).items,
      ).toHaveLength(1);

      // The token stays valid for its lifetime; only the membership check inside
      // the statement stops a revoked device from reading a moment later.
      const editor = await pairDevice(runtime, owner, 'EDITOR');
      const editorAuthenticated = await runtime.authenticateAccessToken(editor.accessToken);
      await runtime.revokeDevice(owner.authenticated, owner.groupId, editor.deviceId);
      await expect(
        store.listMaterials(editorAuthenticated, owner.groupId, 0, ''),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'PERMISSION_DENIED',
      });

      const stranger = await bootstrapGroup(runtime);
      await expect(
        store.getMaterial(stranger.authenticated, material.material.id),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'NOT_FOUND' });

      const written = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM materials WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(written[0]?.n).toBe(1);
    },
    networkTimeoutMs,
  );

  it(
    'removes a group’s materials, versions, tags, objects and uploads when the group is deleted',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const contentHash = uniqueContentHash();
      const begun = await beginUpload(store, owner, contentHash, 'Съёмка');
      await store.completeUpload(
        owner.authenticated,
        begun.session.id,
        contentHash,
        begun.parts.map((part) => ({
          partNumber: part.partNumber,
          etag: `etag-${part.partNumber.toString()}`,
          checksum: `crc32c-${part.partNumber.toString()}`,
        })),
      );
      const tagged = await store.updateMaterialMetadata(owner.authenticated, {
        groupId: owner.groupId,
        materialId: begun.material.id,
        displayName: 'Съёмка, помеченная',
        category: 'VIDEO',
        metadata: { operator: 'Тихонов' },
        tags: ['срочно', 'сектор-3'],
      });
      expect(tagged.material.tags).toEqual(['сектор-3', 'срочно']);
      const links = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM material_tag_links WHERE material_id = $1',
        values: [begun.material.id],
      });
      // The composite foreign key would have rejected the link if the tag
      // vocabulary row were not written by the same statement.
      expect(links[0]?.n).toBe(2);

      await database.query({ text: 'DELETE FROM groups WHERE id = $1', values: [owner.groupId] });

      const counts = await database.query<{
        materials: number;
        versions: number;
        tags: number;
        links: number;
        objects: number;
        sessions: number;
        parts: number;
      }>({
        text: `SELECT
                 (SELECT count(*)::int FROM materials WHERE group_id = $1) AS materials,
                 (SELECT count(*)::int FROM material_versions WHERE material_id = $2) AS versions,
                 (SELECT count(*)::int FROM material_tags WHERE group_id = $1) AS tags,
                 (SELECT count(*)::int FROM material_tag_links WHERE material_id = $2) AS links,
                 (SELECT count(*)::int FROM material_objects WHERE group_id = $1) AS objects,
                 (SELECT count(*)::int FROM upload_sessions WHERE group_id = $1) AS sessions,
                 (SELECT count(*)::int FROM upload_parts WHERE upload_id = $3) AS parts`,
        values: [owner.groupId, begun.material.id, begun.session.id],
      });
      expect(counts[0]).toEqual({
        materials: 0,
        versions: 0,
        tags: 0,
        links: 0,
        objects: 0,
        sessions: 0,
        parts: 0,
      });
    },
    networkTimeoutMs,
  );

  it(
    'reports library changes above a millisecond cursor taken from the database clock',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const created = await beginUpload(store, owner, uniqueContentHash(), 'Съёмка');

      const all = await store.readMaterialEvents(owner.authenticated, owner.groupId, 0n, 10);
      expect(all).toHaveLength(1);
      expect(all[0]?.kind).toBe('CREATED');

      await store.moveToTrash(owner.authenticated, owner.groupId, created.material.id);
      const after = await store.readMaterialEvents(
        owner.authenticated,
        owner.groupId,
        (all[0]?.sequence ?? 0n) + 1n,
        10,
      );
      expect(after).toHaveLength(1);
      expect(after[0]?.kind).toBe('TRASHED');
      expect(after[0]?.revision).toBe(2n);
    },
    networkTimeoutMs,
  );

  it(
    'refuses to start an upload while no object storage is configured, and writes nothing',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const unconfigured = createMaterialService({ runtime, store });
      const request = create(materialV1.BeginUploadRequestSchema, {
        groupId: { value: owner.groupId },
        displayName: 'Съёмка',
        originalFileName: 'take.mp4',
        category: materialV1.MaterialCategory.VIDEO,
        mimeType: 'video/mp4',
        totalSize: 1024n,
        contentHash: uniqueContentHash(),
      });

      await expect(
        Promise.resolve(unconfigured.beginUpload?.(request, handlerContext(owner.accessToken))),
      ).rejects.toMatchObject({ message: expect.stringContaining('object storage') });

      const nothing = await database.query<{ materials: number; objects: number }>({
        text: `SELECT
                 (SELECT count(*)::int FROM materials WHERE group_id = $1) AS materials,
                 (SELECT count(*)::int FROM material_objects WHERE group_id = $1) AS objects`,
        values: [owner.groupId],
      });
      expect(nothing[0]).toEqual({ materials: 0, objects: 0 });

      const configured = createMaterialService({ runtime, store, storage: testStorageIssuer() });
      const started = await configured.beginUpload?.(request, handlerContext(owner.accessToken));
      expect(started?.deduplicated).toBe(false);
      expect(started?.parts?.[0]?.uploadUrl).toContain('https://storage.invalid/');

      const written = await database.query<{ materials: number; objects: number }>({
        text: `SELECT
                 (SELECT count(*)::int FROM materials WHERE group_id = $1) AS materials,
                 (SELECT count(*)::int FROM material_objects WHERE group_id = $1) AS objects`,
        values: [owner.groupId],
      });
      expect(written[0]).toEqual({ materials: 1, objects: 1 });
    },
    networkTimeoutMs,
  );

  it(
    'keeps a replaced version’s content alive and releases every hold on purge',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const firstHash = uniqueContentHash();
      const secondHash = uniqueContentHash();
      const begun = await beginUpload(store, owner, firstHash, 'Съёмка');
      await store.completeUpload(
        owner.authenticated,
        begun.session.id,
        firstHash,
        begun.parts.map((part) => ({
          partNumber: part.partNumber,
          etag: `etag-${part.partNumber.toString()}`,
          checksum: `crc32c-${part.partNumber.toString()}`,
        })),
      );

      await store.createMaterialVersion(owner.authenticated, {
        groupId: owner.groupId,
        materialId: begun.material.id,
        originalFileName: 'take-02.mp4',
        mimeType: 'video/mp4',
        totalSize: 2048n,
        contentHash: secondHash,
      });

      // A reference is held by a version row, not by whichever content the
      // material currently points at. Releasing the old object here deleted the
      // bytes of a version that is still listed and still restorable — and did
      // it while the replacement was still uploading.
      const afterReplacement = await database.query<{ content_hash: string; n: number }>({
        text: `SELECT content_hash, reference_count::int AS n
               FROM material_objects WHERE group_id = $1 AND content_hash = ANY($2::text[])
               ORDER BY content_hash`,
        values: [owner.groupId, [firstHash, secondHash].sort()],
      });
      expect(afterReplacement).toHaveLength(2);
      expect(afterReplacement.every((row) => row.n === 1)).toBe(true);

      await store.moveToTrash(owner.authenticated, owner.groupId, begun.material.id);
      await store.purgeMaterial(
        owner.authenticated,
        owner.groupId,
        begun.material.id,
        begun.material.id,
      );

      // Both holds released, not one: a purge that released a single reference
      // stranded every object the material's older versions named, and nothing
      // ever names them again.
      const afterPurge = await database.query<{ n: number }>({
        text: `SELECT count(*)::int AS n FROM material_objects
               WHERE group_id = $1 AND content_hash = ANY($2::text[])`,
        values: [owner.groupId, [firstHash, secondHash].sort()],
      });
      expect(afterPurge[0]?.n).toBe(0);
    },
    networkTimeoutMs,
  );

  it(
    'leaves a trashed material’s reference counts alone when a version is begun against it',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const contentHash = uniqueContentHash();
      const otherHash = uniqueContentHash();
      const begun = await beginUpload(store, owner, contentHash, 'Съёмка');
      await store.moveToTrash(owner.authenticated, owner.groupId, begun.material.id);

      await expect(
        store.createMaterialVersion(owner.authenticated, {
          groupId: owner.groupId,
          materialId: begun.material.id,
          originalFileName: 'take-02.mp4',
          mimeType: 'video/mp4',
          totalSize: 2048n,
          contentHash: otherHash,
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError' });

      // The object bookkeeping used to be gated on the unfiltered material
      // lock, so a refused version still moved reference counts and claimed an
      // object nothing would ever release.
      const objects = await database.query<{ n: number }>({
        text: `SELECT count(*)::int AS n FROM material_objects
               WHERE group_id = $1 AND content_hash = $2`,
        values: [owner.groupId, otherHash],
      });
      expect(objects[0]?.n).toBe(0);
      const original = await database.query<{ n: number }>({
        text: `SELECT reference_count::int AS n FROM material_objects
               WHERE group_id = $1 AND content_hash = $2`,
        values: [owner.groupId, contentHash],
      });
      expect(original[0]?.n).toBe(1);
    },
    networkTimeoutMs,
  );

  function createRuntime(): DurablePairedDeviceRuntime {
    return new DurablePairedDeviceRuntime({ database, tokenPepper });
  }

  function createStore(runtime: DurablePairedDeviceRuntime): DurableMaterialStore {
    return new DurableMaterialStore({ database, receipts: runtime.receiptGuard });
  }

  function beginUpload(
    store: DurableMaterialStore,
    owner: BootstrappedGroup,
    contentHash: string,
    displayName: string,
  ): Promise<BeginUploadOutcome> {
    return store.beginUpload(owner.authenticated, {
      groupId: owner.groupId,
      displayName,
      originalFileName: `${displayName}.mp4`,
      category: 'VIDEO',
      mimeType: 'video/mp4',
      totalSize: 1024n,
      contentHash,
    });
  }

  async function bootstrapGroup(runtime: DurablePairedDeviceRuntime): Promise<BootstrappedGroup> {
    const created = await runtime.createGroup({
      name: `Terminal ${uniqueSuffix()}`,
      initialDevice: {
        name: 'HQ primary',
        publicKey: `ed25519:${uniqueSuffix()}`,
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

  async function pairDevice(
    runtime: DurablePairedDeviceRuntime,
    owner: BootstrappedGroup,
    role: 'EDITOR' | 'VIEWER',
  ): Promise<{ readonly deviceId: string; readonly accessToken: string }> {
    const grant = await runtime.createPairingCode(owner.authenticated, owner.groupId, role);
    const paired = await runtime.pairDevice({
      pairingCode: grant.code,
      name: 'HQ analyst',
      publicKey: `ed25519:${uniqueSuffix()}`,
      platform: 'windows',
      applicationVersion: '0.1.0',
    });
    return { deviceId: paired.device.id, accessToken: paired.session.accessToken };
  }
});

interface BootstrappedGroup {
  readonly groupId: string;
  readonly accessToken: string;
  readonly authenticated: AuthenticatedDevice;
}

/**
 * A deterministic stand-in for the bucket this deployment does not have. It
 * exists to prove the seam is wired, never to imply a real address: every URL
 * it returns is on the reserved `.invalid` domain.
 */
function testStorageIssuer(): StorageGrantIssuer {
  const expiresAt = new Date(Date.now() + 600_000);
  return {
    issueUploadPart: (request) => ({
      url: `https://storage.invalid/${request.storageKey}?part=${request.partNumber.toString()}`,
      expiresAt,
    }),
    issueDownload: (request) => ({
      url: `https://storage.invalid/${request.storageKey}`,
      expiresAt,
    }),
    issuePreview: (request) => ({
      url: `https://storage.invalid/${request.storageKey}?variant=${request.variant}`,
      expiresAt,
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

function uniqueSuffix(): string {
  return randomBytes(8).toString('hex');
}

function uniqueContentHash(): string {
  return `sha256:${randomBytes(16).toString('hex')}`;
}
