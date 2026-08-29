import { create } from '@bufbuild/protobuf';
import type { HandlerContext } from '@connectrpc/connect';
import { materialV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from '../db/database.js';
import type { PairedDeviceLifecycle } from '../sync/lifecycle.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import { createMaterialService, type StorageGrantIssuer } from './service.js';
import {
  DurableMaterialStore,
  multipartUploadPlan,
  planUploadParts,
  type BeginUploadInput,
  type UploadPartPlan,
} from './store.js';

/**
 * The order correction C48 mandates: the issuer declares its part plan, and only
 * then does the store plan parts.
 *
 * The trap this closes is silent. An issuer that signs one address for the whole
 * object, handed a five-part plan, receives five PUTs to that one address; each
 * overwrites the last; the finished object is the final slice carrying the
 * declared hash of the whole file. No status code says so. These tests hold the
 * order in place from three sides: the planner itself, the store that calls it,
 * and the service that reads the declaration off the issuer.
 */

const groupId = '018b2a02-0000-7000-8000-0000000000a1';
const deviceId = '018b2a02-0000-7000-8000-0000000000a2';
const contentHash = 'a'.repeat(64);
const now = new Date('2026-08-29T09:00:00.000Z');
const wholeObjectPlan: UploadPartPlan = {
  mode: 'whole-object',
  maxObjectBytes: 32n * 1024n * 1024n,
};

describe('upload part planning', () => {
  it('splits by chunk for a multipart issuer', () => {
    const parts = planUploadParts(20n, 8, multipartUploadPlan);

    expect(parts).toEqual([
      { partNumber: 1, offset: 0n, length: 8n },
      { partNumber: 2, offset: 8n, length: 8n },
      { partNumber: 3, offset: 16n, length: 4n },
    ]);
  });

  it('plans exactly one part covering the object when the issuer declines descriptors', () => {
    const parts = planUploadParts(20n, 8, wholeObjectPlan);

    expect(parts).toEqual([{ partNumber: 1, offset: 0n, length: 20n }]);
  });

  it('refuses an object above the single-request ceiling instead of splitting it', () => {
    expect(() =>
      planUploadParts(33n * 1024n * 1024n, 8 * 1024 * 1024, wholeObjectPlan),
    ).toThrowError(/single upload request/u);
  });

  it('defaults to multipart, which is what every issuer that predates the plan wants', () => {
    expect(planUploadParts(20n, 8)).toHaveLength(3);
  });
});

describe('durable material store part plan', () => {
  it('reserves one upload part row for a whole-object plan', async () => {
    const database = new ScriptedSqlClient([[beginRow()]]);
    const store = new DurableMaterialStore({ database, now: () => now });

    await store.beginUpload(authenticated(), beginInput({ partPlan: wholeObjectPlan }));

    const statement = requireStatement(database.queries[0]);
    expect(statement.values?.[19]).toBe(
      JSON.stringify([{ part_number: 1, offset_bytes: '0', byte_length: '20971520' }]),
    );
  });

  it('reserves the chunked plan when the issuer wants multipart', async () => {
    const database = new ScriptedSqlClient([[beginRow()]]);
    const store = new DurableMaterialStore({ database, now: () => now });

    await store.beginUpload(authenticated(), beginInput({ partPlan: multipartUploadPlan }));

    const statement = requireStatement(database.queries[0]);
    const parts: unknown = JSON.parse(String(statement.values?.[19]));
    expect(Array.isArray(parts) ? parts.length : 0).toBeGreaterThan(1);
  });

  it('writes nothing when the object is above the whole-object ceiling', async () => {
    const database = new ScriptedSqlClient([[beginRow()]]);
    const store = new DurableMaterialStore({ database, now: () => now });

    await expect(
      store.beginUpload(
        authenticated(),
        beginInput({
          partPlan: { mode: 'whole-object', maxObjectBytes: 1024n },
          totalSize: 20n * 1024n * 1024n,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    // The refusal precedes the statement, so no material row, no reserved
    // object and no session survives it.
    expect(database.queries).toHaveLength(0);
  });
});

describe('material service part plan resolution', () => {
  it('asks the issuer for its plan before the store plans anything', async () => {
    const store = new RecordingStore();
    const service = createMaterialService({
      runtime: fakeRuntime(),
      store: store as unknown as DurableMaterialStore,
      storage: wholeObjectIssuer(),
    });

    await service.beginUpload?.(beginRequest(), handlerContext());

    expect(store.inputs[0]?.partPlan).toEqual({
      mode: 'whole-object',
      maxObjectBytes: 32n * 1024n * 1024n,
    });
  });

  it('reads an issuer that declares nothing as multipart, which is what it always was', async () => {
    const store = new RecordingStore();
    // Destructured away rather than set to undefined: exactOptionalPropertyTypes
    // distinguishes an absent optional property from one holding undefined.
    const { uploadPartPlan: _uploadPartPlan, ...issuerWithoutPlan } = wholeObjectIssuer();
    const service = createMaterialService({
      runtime: fakeRuntime(),
      store: store as unknown as DurableMaterialStore,
      storage: issuerWithoutPlan,
    });

    await service.beginUpload?.(beginRequest(), handlerContext());

    expect(store.inputs[0]?.partPlan).toEqual(multipartUploadPlan);
  });
});

function beginInput(overrides: Partial<BeginUploadInput> = {}): BeginUploadInput {
  return {
    groupId,
    displayName: 'Съёмка',
    originalFileName: 'take.mp4',
    category: 'VIDEO',
    mimeType: 'video/mp4',
    totalSize: 20n * 1024n * 1024n,
    contentHash,
    ...overrides,
  };
}

function beginRequest(): materialV1.BeginUploadRequest {
  return create(materialV1.BeginUploadRequestSchema, {
    groupId: { value: groupId },
    displayName: 'Съёмка',
    originalFileName: 'take.mp4',
    category: materialV1.MaterialCategory.VIDEO,
    mimeType: 'video/mp4',
    totalSize: 20n * 1024n * 1024n,
    contentHash,
  });
}

function authenticated(): AuthenticatedDevice {
  return {
    group: { id: groupId },
    device: { id: deviceId },
  } as unknown as AuthenticatedDevice;
}

function fakeRuntime(): PairedDeviceLifecycle {
  return {
    authenticateAccessToken: () => Promise.resolve(authenticated()),
  } as unknown as PairedDeviceLifecycle;
}

function handlerContext(): HandlerContext {
  return {
    requestHeader: new Headers({ authorization: 'Bearer access-token' }),
    signal: new AbortController().signal,
  } as unknown as HandlerContext;
}

/** A whole-object issuer, exactly as the Vercel Blob one declares itself. */
function wholeObjectIssuer(): StorageGrantIssuer {
  return {
    uploadPartPlan: { mode: 'whole-object', maxObjectBytes: 32n * 1024n * 1024n },
    createMultipartUpload: () => ({ remoteUploadId: 'whole-object' }),
    issueUploadPart: () => ({
      url: 'https://blob.invalid/materials/object',
      expiresAt: new Date(now.getTime() + 600_000),
    }),
    completeMultipartUpload: () => undefined,
    abortMultipartUpload: () => undefined,
    verifyObject: () => ({ outcome: 'verified' }),
    issueDownload: () => ({ url: 'https://blob.invalid/x', expiresAt: now }),
    issuePreview: () => ({ url: 'https://blob.invalid/x', expiresAt: now }),
  };
}

class RecordingStore {
  readonly inputs: BeginUploadInput[] = [];

  beginUpload(_authenticated: AuthenticatedDevice, input: BeginUploadInput) {
    this.inputs.push(input);
    return Promise.resolve({
      material: { id: 'material', revision: 1n },
      session: {
        id: 'session',
        state: 'PENDING',
        totalSize: 20n * 1024n * 1024n,
        receivedSize: 0n,
        chunkSize: 8 * 1024 * 1024,
        maxConcurrency: 4,
        expiresAt: now,
        createdAt: now,
        updatedAt: now,
      },
      parts: [],
      storageKey: 'materials/group/hash',
      deduplicated: true,
    } as never);
  }
}

function beginRow(): Record<string, unknown> {
  return {
    receipt_claimed: true,
    editor_active: true,
    deduplicated: false,
    storage_key: `materials/${groupId}/${contentHash}`,
    material: {
      id: '018b2a02-0000-7000-8000-0000000000d1',
      group_id: groupId,
      display_name: 'Съёмка',
      category: 'VIDEO',
      mime_type: 'video/mp4',
      byte_size: '20971520',
      content_hash: contentHash,
      status: 'UPLOADING',
      current_version_id: null,
      metadata: {},
      tags: [],
      revision: '1',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    session: {
      id: '018b2a02-0000-7000-8000-0000000000e1',
      group_id: groupId,
      material_id: '018b2a02-0000-7000-8000-0000000000d1',
      version_id: null,
      state: 'PENDING',
      total_size: '20971520',
      received_size: '0',
      chunk_size: 8 * 1024 * 1024,
      max_concurrency: 4,
      storage_upload_id: null,
      expires_at: now.toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    parts: [],
  };
}

function requireStatement(statement: SqlStatement | undefined): SqlStatement {
  if (statement === undefined) throw new Error('Expected the store to issue a statement');
  return statement;
}

class ScriptedSqlClient implements SqlClient {
  readonly queries: SqlStatement[] = [];
  readonly #responses: Array<Record<string, unknown>[]>;

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

  transaction(): Promise<void> {
    return Promise.resolve();
  }
}
