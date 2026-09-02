import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from '../db/database.js';
import { MutationReceiptGuard } from '../sync/receipt-guard.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import {
  DurableMaterialStore,
  decodeMaterialCursor,
  decodeVersionCursor,
  encodeMaterialCursor,
  encodeVersionCursor,
  planUploadParts,
  storageKeyFor,
  type MaterialRecord,
  type MaterialVersionRecord,
} from './store.js';

/**
 * Statement-shape proof for the material library.
 *
 * A scripted `SqlClient` records the text and the bound values of what the
 * store issues and answers with rows the store then has to decode. It can show
 * that every mutation is one parameterized statement, that no credential or
 * client value is interpolated into SQL, and that the CTEs which carry this
 * service's invariants are present.
 *
 * It cannot show that those invariants hold. Nothing here executes a CTE, takes
 * a row lock, or evaluates a CHECK constraint, so deduplication under a race,
 * the reference count refusing to go negative, and two concurrent versions
 * receiving consecutive sequences are all proved only by
 * `material.integration.test.ts` against a real engine.
 */
const pepper = 'material-token-pepper-with-at-least-thirty-two-characters';
const groupId = '018b2a02-0000-7000-8000-0000000000a1';
const deviceId = '018b2a02-0000-7000-8000-0000000000a2';
const materialId = '018b2a02-0000-7000-8000-0000000000b1';
const uploadId = '018b2a02-0000-7000-8000-0000000000c1';
const versionId = '018b2a02-0000-7000-8000-0000000000d1';
const contentHash = 'sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const now = new Date('2026-08-20T11:00:00.000Z');

describe('durable material store', () => {
  it('reserves content, creates the material and opens the upload in one statement', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          receipt_claimed: true,
          editor_active: true,
          deduplicated: false,
          storage_key: storageKeyFor(groupId, contentHash),
          material: materialRow(),
          session: sessionRow(),
          parts: [{ part_number: 1, offset_bytes: '0', byte_length: '1048576' }],
        },
      ],
    ]);
    const store = createStore(database);

    const begun = await store.beginUpload(authenticatedEditor(), beginUploadInput());

    expect(begun.deduplicated).toBe(false);
    expect(begun.material.id).toBe(materialId);
    expect(begun.material.byteSize).toBe(1_048_576n);
    expect(begun.session.state).toBe('PENDING');
    expect(begun.parts).toEqual([{ partNumber: 1, offset: 0n, length: 1_048_576n }]);
    expect(database.transactions).toHaveLength(0);
    expect(database.queries).toHaveLength(1);

    const statement = database.queries[0];
    expect(statement?.text).toContain('locked_object AS MATERIALIZED');
    expect(statement?.text).toContain('FOR UPDATE OF object');
    // The reference count is incremented by the same statement that creates the
    // material, never by a read followed by a write.
    expect(statement?.text).toContain('SET reference_count = material_objects.reference_count + 1');
    // current_version_id has no foreign key, so the pointer is written by the
    // INSERT that creates the material rather than by a follow-up UPDATE.
    expect(statement?.text).toContain('INSERT INTO materials');
    expect(statement?.text).not.toContain('UPDATE materials');
    expect(statement?.text).toContain('INSERT INTO material_versions');
    expect(statement?.text).toContain('INSERT INTO upload_sessions');
    expect(statement?.text).toContain('INSERT INTO upload_parts');
    expect(statement?.text).toContain("membership.role IN ('EDITOR', 'ADMIN')");
    expect(statement?.text).toContain("devices.status <> 'REVOKED'");
    // Nothing the caller supplied is interpolated into the statement text.
    expect(statement?.text).not.toContain(contentHash);
    expect(statement?.values).toContain(contentHash);
    expect(statement?.values).toContain(storageKeyFor(groupId, contentHash));
    expect(statement?.values).toContain('1048576');
  });

  it('answers a deduplicated upload with a ready material and no parts to send', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          receipt_claimed: true,
          editor_active: true,
          deduplicated: true,
          storage_key: storageKeyFor(groupId, contentHash),
          material: materialRow({ status: 'READY', current_version_id: versionId }),
          session: sessionRow({
            state: 'COMPLETED',
            received_size: '1048576',
            version_id: versionId,
          }),
          parts: [],
        },
      ],
    ]);
    const store = createStore(database);

    const begun = await store.beginUpload(authenticatedEditor(), beginUploadInput());

    expect(begun.deduplicated).toBe(true);
    expect(begun.parts).toEqual([]);
    expect(begun.material.status).toBe('READY');
    expect(begun.material.currentVersionId).toBe(versionId);
    expect(begun.session.state).toBe('COMPLETED');
  });

  it('refuses a material mutation from a device that is not an active editor', async () => {
    const database = new ScriptedSqlClient([
      [{ receipt_claimed: true, editor_active: false, deduplicated: false, parts: [] }],
    ]);
    const store = createStore(database);

    await expect(
      store.beginUpload(authenticatedEditor(), beginUploadInput()),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
  });

  it('writes the version and the pointer to it in the statement that completes an upload', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          receipt_claimed: true,
          editor_active: true,
          session_present: true,
          session_completable: true,
          content_verified: true,
          completed_part_count: '1',
          material: materialRow({ status: 'READY', current_version_id: versionId, revision: '2' }),
          existing_version: null,
          inserted_version: versionRow(),
        },
      ],
    ]);
    const store = createStore(database);

    const completed = await store.completeUpload(authenticatedEditor(), uploadId, contentHash, [
      { partNumber: 1, etag: 'etag-1', checksum: 'crc32c:1234' },
    ]);

    expect(completed.material.currentVersionId).toBe(completed.version.id);
    expect(completed.version.sequence).toBe(2n);
    expect(database.queries).toHaveLength(1);
    const statement = database.queries[0];
    expect(statement?.text).toContain('verified_material AS');
    expect(statement?.text).toContain('INSERT INTO material_versions');
    expect(statement?.text).toContain(
      'current_version_id = COALESCE(completable_session.version_id',
    );
    expect(statement?.text).toContain('FOR UPDATE OF material');
    expect(statement?.values).toContain(contentHash);
  });

  it('refuses a completion whose content hash is not the one the upload reserved', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          receipt_claimed: true,
          editor_active: true,
          session_present: true,
          session_completable: true,
          content_verified: false,
          completed_part_count: '0',
          material: null,
          existing_version: null,
          inserted_version: null,
        },
      ],
    ]);
    const store = createStore(database);

    await expect(
      store.completeUpload(authenticatedEditor(), uploadId, contentHash, []),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'FAILED_PRECONDITION' });
  });

  it('derives a new version sequence from the material revision rather than from MAX', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          receipt_claimed: true,
          editor_active: true,
          material_present: true,
          claimed_key: storageKeyFor(groupId, 'sha256:ffffffffffffffff'),
          material: materialRow({ revision: '3', content_hash: 'sha256:ffffffffffffffff' }),
          version: versionRow({ sequence: '3', content_hash: 'sha256:ffffffffffffffff' }),
          session: sessionRow({ version_id: versionId }),
          parts: [{ part_number: 1, offset_bytes: '0', byte_length: '64' }],
        },
      ],
    ]);
    const store = createStore(database);

    const created = await store.createMaterialVersion(authenticatedEditor(), {
      groupId,
      materialId,
      originalFileName: 'take-02.mp4',
      mimeType: 'video/mp4',
      totalSize: 64n,
      contentHash: 'sha256:ffffffffffffffff',
    });

    expect(created.version.sequence).toBe(3n);
    expect(created.material.revision).toBe(3n);
    const statement = database.queries[0];
    // The sequence comes from the row the UPDATE re-read, not from a MAX
    // subquery that a lock wait would leave stale.
    expect(statement?.text).toContain('revision = material.revision + 1');
    expect(statement?.text).toContain('$11, updated_material.id, updated_material.revision');
    expect(statement?.text).not.toContain('MAX(');
    // A new version claims its object and releases nothing: the version it
    // replaces is still listed and still restorable, so its bytes still have to
    // exist. Releasing here deleted content while the replacement was still
    // uploading.
    expect(statement?.text).toContain('claimed_object AS (');
    expect(statement?.text).not.toContain('released_object');
    expect(statement?.text).not.toContain('dropped_object');
    // Every write is gated on the same eligibility as the material update, so a
    // version begun against a trashed material cannot move a reference count
    // while leaving the material itself untouched.
    expect(statement?.text).toContain('eligible_material AS (');
  });

  it('releases a purged material’s object with two mutually exclusive branches', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          receipt_claimed: true,
          editor_active: true,
          material_present: true,
          material_purgeable: true,
          object_removed: true,
          material_id: materialId,
          revision: '4',
        },
      ],
    ]);
    const store = createStore(database);

    const purged = await store.purgeMaterial(
      authenticatedEditor(),
      groupId,
      materialId,
      materialId,
    );

    expect(purged).toEqual({ materialId, revision: 4n, objectRemoved: true });
    const statement = database.queries[0];
    expect(statement?.text).toContain('DELETE FROM materials');
    // One release per reference the material actually holds — a row per version
    // plus one for an upload still in flight — not one per material. Releasing
    // a single reference stranded every object a material's older versions
    // named.
    expect(statement?.text).toContain('held_references AS (');
    expect(statement?.text).toContain(
      'SET reference_count = object.reference_count - held_references.holds',
    );
    // The decrement never runs on the last holder; the delete does. Neither can
    // drive the column below zero, which is what the schema's own CHECK exists
    // to catch if this ever regressed.
    expect(statement?.text).toContain('locked_object.reference_count > held_references.holds');
    expect(statement?.text).toContain('locked_object.reference_count <= held_references.holds');
  });

  it('refuses a purge whose confirmation does not name the material, before any statement runs', async () => {
    const database = new ScriptedSqlClient([]);
    const store = createStore(database);

    await expect(
      store.purgeMaterial(authenticatedEditor(), groupId, materialId, 'yes'),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'INVALID_ARGUMENT' });
    expect(database.queries).toHaveLength(0);
  });

  it('claims a receipt before the mutation and completes it inside the same statement', async () => {
    const database = new ScriptedSqlClient([
      [{ receipt_claimed: 'claimed' }],
      [
        {
          receipt_claimed: true,
          editor_active: true,
          material_present: true,
          material: materialRow({ status: 'TRASHED', revision: '2' }),
        },
      ],
    ]);
    const store = createStore(database);

    const trashed = await store.moveToTrash(authenticatedEditor(), groupId, materialId, {
      requestId: 'trash-1',
    });

    expect(trashed.material.status).toBe('TRASHED');
    expect(database.queries).toHaveLength(2);
    expect(database.queries[0]?.text).toContain('INSERT INTO mutation_receipts');
    expect(database.queries[1]?.text).toContain('locked_receipt AS MATERIALIZED');
    expect(database.queries[1]?.text).toContain('UPDATE mutation_receipts AS receipt');
    expect(database.queries[1]?.values).toContain('TRASH_MATERIAL');
    // The raw request identifier is never bound; only its purpose-separated hash is.
    expect(database.queries[1]?.values).not.toContain('trash-1');
  });

  it('refuses a retried mutation when no receipt guard is configured', async () => {
    const database = new ScriptedSqlClient([]);
    const store = new DurableMaterialStore({ database, now: () => now });

    await expect(
      store.moveToTrash(authenticatedEditor(), groupId, materialId, { requestId: 'trash-1' }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'FAILED_PRECONDITION' });
    expect(database.queries).toHaveLength(0);
  });

  it('pages the library newest-changed first and hands back a keyset cursor', async () => {
    const first = materialRow({ id: materialId, updated_at: '2026-08-20T11:00:00.000Z' });
    const second = materialRow({
      id: '018b2a02-0000-7000-8000-0000000000b2',
      updated_at: '2026-08-20T10:00:00.000Z',
    });
    const database = new ScriptedSqlClient([
      [{ member_active: true, approximate_total: '2', items: [first, second] }],
    ]);
    const store = createStore(database);

    const page = await store.listMaterials(authenticatedEditor(), groupId, 1, '');

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.approximateTotal).toBe(2n);
    expect(decodeMaterialCursor(page.nextCursor)).toEqual({
      updatedAt: new Date('2026-08-20T11:00:00.000Z'),
      materialId,
    });
    const statement = database.queries[0];
    expect(statement?.text).toContain('ORDER BY matching.updated_at DESC, matching.id DESC');
    expect(statement?.values).toContain(false);
    expect(statement?.values).toContain(2);
  });

  it('refuses to read a group the caller no longer belongs to', async () => {
    const database = new ScriptedSqlClient([
      [{ member_active: false, approximate_total: '0', items: [] }],
    ]);
    const store = createStore(database);

    await expect(store.listMaterials(authenticatedEditor(), groupId, 0, '')).rejects.toMatchObject({
      name: 'PairedDeviceRuntimeError',
      code: 'PERMISSION_DENIED',
    });
  });

  it('keeps material and version cursors apart', () => {
    const material: MaterialRecord = {
      ...decodedMaterial(),
      updatedAt: new Date('2026-08-20T09:00:00.000Z'),
    };
    const version: MaterialVersionRecord = { ...decodedVersion(), sequence: 7n };

    expect(decodeMaterialCursor(encodeMaterialCursor(material))?.materialId).toBe(material.id);
    expect(decodeVersionCursor(encodeVersionCursor(version))).toBe(7n);
    // A cursor from the other listing carries the wrong keys and is rejected
    // rather than silently paging from the beginning.
    expect(() => decodeVersionCursor(encodeMaterialCursor(material))).toThrowError(
      /page cursor is invalid/u,
    );
    expect(() => decodeMaterialCursor(encodeVersionCursor(version))).toThrowError(
      /page cursor is invalid/u,
    );
    expect(decodeMaterialCursor('')).toBeUndefined();
    expect(decodeVersionCursor('')).toBeUndefined();
  });

  it('reads the change feed as a millisecond cursor over materials.updated_at', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          member_active: true,
          events: [
            {
              material_id: materialId,
              revision: '1',
              created_at: '2026-08-20T11:00:00.000Z',
              updated_at: '2026-08-20T11:00:00.000Z',
              trashed_at: null,
              sequence: '1787569200000',
            },
            {
              material_id: materialId,
              revision: '2',
              created_at: '2026-08-20T11:00:00.000Z',
              updated_at: '2026-08-20T11:00:05.000Z',
              trashed_at: '2026-08-20T11:00:05.000Z',
              sequence: '1787569205000',
            },
          ],
        },
      ],
    ]);
    const store = createStore(database);

    const events = await store.readMaterialEvents(authenticatedEditor(), groupId, 0n, 10);

    expect(events.map((event) => event.kind)).toEqual(['CREATED', 'TRASHED']);
    expect(events[1]?.sequence).toBe(1_787_569_205_000n);
    const statement = database.queries[0];
    expect(statement?.text).toContain('EXTRACT(EPOCH FROM material.updated_at)');
    expect(statement?.text).toContain('ORDER BY material.updated_at ASC, material.id ASC');
  });

  it('splits a declared size into parts and derives one storage key per group and hash', () => {
    expect(planUploadParts(10n, 4)).toEqual([
      { partNumber: 1, offset: 0n, length: 4n },
      { partNumber: 2, offset: 4n, length: 4n },
      { partNumber: 3, offset: 8n, length: 2n },
    ]);
    expect(planUploadParts(0n, 4)).toEqual([]);
    expect(storageKeyFor(groupId, contentHash)).toBe(`materials/${groupId}/${contentHash}`);
  });

  it('refuses a zero-byte upload before any statement is issued, on both paths that open one', async () => {
    const begin = new ScriptedSqlClient([]);
    await expect(
      createStore(begin).beginUpload(authenticatedEditor(), {
        ...beginUploadInput(),
        totalSize: 0n,
      }),
    ).rejects.toMatchObject({
      name: 'PairedDeviceRuntimeError',
      code: 'INVALID_ARGUMENT',
      message: 'total_size must be greater than zero; a material with no bytes cannot be stored.',
    });
    // Nothing reached the database: `planUploadParts` would have returned no
    // parts, so a material would have been created that no upload could ever
    // fill and that `CompleteUpload` would nonetheless mark READY.
    expect(begin.queries).toHaveLength(0);

    const version = new ScriptedSqlClient([]);
    await expect(
      createStore(version).createMaterialVersion(authenticatedEditor(), {
        groupId,
        materialId,
        originalFileName: 'take-02.mp4',
        mimeType: 'video/mp4',
        totalSize: 0n,
        contentHash,
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'INVALID_ARGUMENT' });
    expect(version.queries).toHaveLength(0);

    // A negative size is still refused, and one byte is still accepted: the
    // boundary moved from -1/0 to 0/1 and nowhere else.
    await expect(
      createStore(new ScriptedSqlClient([])).beginUpload(authenticatedEditor(), {
        ...beginUploadInput(),
        totalSize: -1n,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(planUploadParts(1n, 4)).toEqual([{ partNumber: 1, offset: 0n, length: 1n }]);
  });

  it('refuses a content hash that could address an object outside its own group', async () => {
    const database = new ScriptedSqlClient([]);
    const store = createStore(database);

    await expect(
      store.beginUpload(authenticatedEditor(), {
        ...beginUploadInput(),
        contentHash: '../../secrets/key',
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'INVALID_ARGUMENT' });
    expect(database.queries).toHaveLength(0);
  });
});

function createStore(database: SqlClient): DurableMaterialStore {
  let issued = 0;
  return new DurableMaterialStore({
    database,
    receipts: new MutationReceiptGuard({
      database,
      hashReceipt: (payload) => createHmac('sha256', pepper).update(payload).digest('base64url'),
      tokenHashVersion: 'v1',
      receiptLifetimeMs: 60_000,
      now: () => now,
    }),
    now: () => now,
    newId: () => {
      issued += 1;
      return `018b2a02-0000-7000-8000-00000000e0${issued.toString().padStart(2, '0')}`;
    },
  });
}

function beginUploadInput() {
  return {
    groupId,
    materialId,
    displayName: 'Оперативная съёмка',
    originalFileName: 'take-01.mp4',
    category: 'VIDEO' as const,
    mimeType: 'video/mp4',
    totalSize: 1_048_576n,
    contentHash,
  };
}

function authenticatedEditor(): AuthenticatedDevice {
  return {
    group: {
      id: groupId,
      name: 'Гремучая смесь',
      authorityMode: 'LEADER',
      leaderDeviceId: deviceId,
      revision: 1n,
      createdAt: now,
      updatedAt: now,
    },
    device: {
      id: deviceId,
      name: 'HQ primary',
      publicKey: 'ed25519:primary',
      role: 'EDITOR',
      status: 'ONLINE',
      platform: 'windows',
      applicationVersion: '0.1.0',
      createdAt: now,
      lastSeenAt: now,
    },
    role: 'EDITOR',
    sessionId: '018b2a02-0000-7000-8000-0000000000f1',
    accessTokenId: '018b2a02-0000-7000-8000-0000000000f2',
  };
}

function materialRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: materialId,
    group_id: groupId,
    display_name: 'Оперативная съёмка',
    category: 'VIDEO',
    mime_type: 'video/mp4',
    byte_size: '1048576',
    content_hash: contentHash,
    status: 'UPLOADING',
    current_version_id: null,
    metadata: {},
    tags: [],
    revision: '1',
    created_at: '2026-08-20T11:00:00.000Z',
    updated_at: '2026-08-20T11:00:00.000Z',
    trashed_at: null,
    ...overrides,
  };
}

function versionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: versionId,
    material_id: materialId,
    sequence: '2',
    content_hash: contentHash,
    mime_type: 'video/mp4',
    byte_size: '1048576',
    original_file_name: 'take-01.mp4',
    created_by_device_id: deviceId,
    created_at: '2026-08-20T11:00:00.000Z',
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uploadId,
    group_id: groupId,
    material_id: materialId,
    version_id: null,
    state: 'PENDING',
    total_size: '1048576',
    received_size: '0',
    chunk_size: 8_388_608,
    max_concurrency: 4,
    expires_at: '2026-08-21T11:00:00.000Z',
    ...overrides,
  };
}

function decodedMaterial(): MaterialRecord {
  return {
    id: materialId,
    groupId,
    displayName: 'Оперативная съёмка',
    category: 'VIDEO',
    mimeType: 'video/mp4',
    byteSize: 1_048_576n,
    contentHash,
    status: 'UPLOADING',
    currentVersionId: undefined,
    metadata: {},
    tags: [],
    revision: 1n,
    createdAt: now,
    updatedAt: now,
    trashedAt: undefined,
  };
}

function decodedVersion(): MaterialVersionRecord {
  return {
    id: versionId,
    materialId,
    sequence: 1n,
    contentHash,
    mimeType: 'video/mp4',
    byteSize: 1_048_576n,
    originalFileName: 'take-01.mp4',
    createdAt: now,
    createdByDeviceId: deviceId,
  };
}

class ScriptedSqlClient implements SqlClient {
  readonly queries: SqlStatement[] = [];
  readonly transactions: SqlStatement[][] = [];
  readonly #responses: Record<string, unknown>[][];

  constructor(responses: readonly (readonly Record<string, unknown>[])[]) {
    this.#responses = responses.map((response) => [...response]);
  }

  query<Row extends Record<string, unknown>>(statement: SqlStatement): Promise<readonly Row[]> {
    this.queries.push({
      text: statement.text,
      values: statement.values === undefined ? [] : [...statement.values],
    });
    return Promise.resolve((this.#responses.shift() ?? []) as readonly Row[]);
  }

  transaction(statements: readonly SqlStatement[]): Promise<void> {
    this.transactions.push([...statements]);
    return Promise.resolve();
  }
}

describe('durable material store: storage upload id', () => {
  it('attaches the bucket upload id in one statement gated on the column being empty', async () => {
    const database = new ScriptedSqlClient([[{ editor_active: true, attached: true }]]);
    const store = createStore(database);

    await store.attachStorageUploadId(authenticatedEditor(), uploadId, 'remote-upload-id');

    expect(database.transactions).toHaveLength(0);
    expect(database.queries).toHaveLength(1);
    const statement = database.queries[0];
    expect(statement?.text).toContain('UPDATE upload_sessions');
    expect(statement?.text).toContain('AND session.storage_upload_id IS NULL');
    expect(statement?.text).toContain("AND session.state IN ('PENDING', 'UPLOADING', 'VERIFYING')");
    expect(statement?.text).toContain("membership.role IN ('EDITOR', 'ADMIN')");
    // The bucket's identifier is a bound value, never interpolated.
    expect(statement?.text).not.toContain('remote-upload-id');
    expect(statement?.values).toContain('remote-upload-id');
    expect(statement?.values).toContain(uploadId);
  });

  it('refuses to attach a second id, and refuses a non-editor', async () => {
    const alreadyAttached = new ScriptedSqlClient([[{ editor_active: true, attached: false }]]);
    await expect(
      createStore(alreadyAttached).attachStorageUploadId(
        authenticatedEditor(),
        uploadId,
        'another',
      ),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'FAILED_PRECONDITION' });

    const viewer = new ScriptedSqlClient([[{ editor_active: false, attached: false }]]);
    await expect(
      createStore(viewer).attachStorageUploadId(authenticatedEditor(), uploadId, 'another'),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
  });

  it('reads the attached id back with the session and keeps it off a session without one', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          member_active: true,
          session: sessionRow({ storage_upload_id: 'remote-upload-id' }),
          completed_parts: [],
        },
      ],
      [{ member_active: true, session: sessionRow(), completed_parts: [] }],
    ]);
    const store = createStore(database);

    const attached = await store.getUploadStatus(authenticatedEditor(), uploadId);
    expect(attached.session.storageUploadId).toBe('remote-upload-id');
    const bare = await store.getUploadStatus(authenticatedEditor(), uploadId);
    expect('storageUploadId' in bare.session).toBe(false);
  });
});
