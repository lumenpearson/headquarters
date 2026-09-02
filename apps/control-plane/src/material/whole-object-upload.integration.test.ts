import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { create } from '@bufbuild/protobuf';
import type { HandlerContext } from '@connectrpc/connect';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { materialV1 } from '@gremuchaya/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadControlPlaneConfig } from '../config.js';
import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { createVercelBlobGrantIssuer } from '../storage/vercel-blob-grant-issuer.js';
import { DurablePairedDeviceRuntime } from '../sync/durable-runtime.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import { createMaterialService } from './service.js';
import { DurableMaterialStore, storageKeyFor } from './store.js';

/**
 * The whole-object upload path against live PostgreSQL and a scripted Blob API.
 *
 * This is where correction C48's mandated order stops being an assertion about
 * a JSON parameter and becomes a row count. The material is four chunk sizes
 * long; against the S3 issuer the store would reserve four parts. With the
 * Vercel Blob issuer declaring `whole-object`, `upload_parts` must hold exactly
 * one row covering the whole object — because four parts sent to the one
 * address the issuer can sign would each overwrite the last, and the stored
 * object would be the final quarter of the file carrying the declared hash of
 * all of it. The read-back at completion is what would notice, and this suite
 * runs that too.
 *
 * The database is live and disposable, opt-in through
 * `HQ_CONTROL_PLANE_TEST_DATABASE_URL`. The Blob API is scripted: no Blob store
 * or read-write token exists in this repository, so what is proved here is the
 * lifecycle this deployment drives, not that Vercel accepts it.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';
const readWriteToken = 'vercel_blob_rw_store01HQ_abcdefghijklmnopqrstuvwxyz012345';
/** Four times the store's default chunk size, so a multipart plan would be four parts. */
const objectBytes = 4 * 1024 * 1024;
const maxObjectBytes = 8 * 1024 * 1024;

describeIntegration('whole-object upload lifecycle against real PostgreSQL', () => {
  const pool = new DisposableDatabasePool(testDatabaseUrl ?? '');
  const objects = new Map<string, Buffer>();
  let database: SqlClient;
  let api: ScriptedServer;
  let publicStore: ScriptedServer;

  beforeAll(async () => {
    const swept = await pool.sweep();
    if (swept.dropped.length > 0) {
      process.stderr.write(`Swept abandoned test databases: ${swept.dropped.join(', ')}\n`);
    }
    database = await pool.create();
    await runMigrations(database);
    api = await startServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/delete') {
        const body: unknown = JSON.parse((await readBody(request)).toString('utf8'));
        const urls = Array.isArray((body as { urls?: unknown }).urls)
          ? (body as { urls: string[] }).urls
          : [];
        for (const url of urls) objects.delete(new URL(url).pathname);
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      if (request.method === 'PUT') {
        objects.set(request.url ?? '', await readBody(request));
        response.writeHead(200, { etag: `"${randomBytes(8).toString('hex')}"` }).end('{}');
        return;
      }
      response.writeHead(200).end('{}');
    });
    publicStore = await startServer((request, response) => {
      const stored = objects.get(request.url?.split('?')[0] ?? '');
      if (stored === undefined) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200).end(stored);
      return Promise.resolve();
    });
  }, networkTimeoutMs);

  afterAll(async () => {
    await pool.dropAll();
    await api.close();
    await publicStore.close();
  }, networkTimeoutMs);

  it(
    'reserves one part, stores the whole object and verifies it before the version exists',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const service = createService(runtime);
      const body = randomBytes(objectBytes);
      const contentHash = bytesToHex(blake3(new Uint8Array(body)));

      const begun = await service.beginUpload?.(
        beginRequest(owner.groupId, contentHash),
        handlerContext(owner.accessToken),
      );
      expect(begun?.parts).toHaveLength(1);
      expect(begun?.parts?.[0]?.length).toBe(BigInt(objectBytes));

      // The reservation is in the database, not only in the response: four part
      // rows here would mean four PUTs to one address.
      const reserved = await database.query<{ total: number; reserved: string }>({
        text: `SELECT count(*)::int AS total, COALESCE(sum(byte_length), 0)::text AS reserved
               FROM upload_parts WHERE upload_id = $1`,
        values: [begun?.session?.id?.value ?? ''],
      });
      expect(reserved[0]).toEqual({ total: 1, reserved: objectBytes.toString() });
      const session = await database.query<{ storage_upload_id: string | null }>({
        text: 'SELECT storage_upload_id FROM upload_sessions WHERE id = $1',
        values: [begun?.session?.id?.value ?? ''],
      });
      // The recorded upload id is the constant naming the absence of a
      // multipart upload, never the client token the grant carried.
      expect(session[0]?.storage_upload_id).toBe('vercel-blob-whole-object');
      expect(session[0]?.storage_upload_id).not.toContain('vercel_blob_client');

      const grant = begun?.parts?.[0];
      const upload = await fetch(grant?.uploadUrl ?? '', {
        method: 'PUT',
        headers: { ...(grant?.requiredHeaders ?? {}) },
        body: new Uint8Array(body),
      });
      expect(upload.status).toBe(200);

      const completed = await service.completeUpload?.(
        create(materialV1.CompleteUploadRequestSchema, {
          uploadId: { value: begun?.session?.id?.value ?? '' },
          contentHash,
          parts: [{ partNumber: 1, etag: upload.headers.get('etag') ?? '', checksum: contentHash }],
        }),
        handlerContext(owner.accessToken),
      );
      expect(completed?.material?.status).toBe(materialV1.MaterialStatus.READY);
      expect(completed?.version?.byteSize).toBe(BigInt(objectBytes));

      // The bytes the store holds are the bytes the material declares, read
      // back through the public origin exactly as `verifyObject` does.
      const stored = objects.get(`/${storageKeyFor(owner.groupId, contentHash)}`);
      expect(stored?.equals(body)).toBe(true);
    },
    networkTimeoutMs,
  );

  it(
    'refuses an object above the single-request ceiling and writes nothing',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const service = createService(runtime);
      const contentHash = bytesToHex(blake3(randomBytes(32)));

      await expect(
        Promise.resolve(
          service.beginUpload?.(
            beginRequest(owner.groupId, contentHash, BigInt(maxObjectBytes) + 1n),
            handlerContext(owner.accessToken),
          ),
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining('single upload request') });

      const nothing = await database.query<{
        materials: number;
        objects: number;
        sessions: number;
      }>({
        text: `SELECT
                 (SELECT count(*)::int FROM materials WHERE group_id = $1) AS materials,
                 (SELECT count(*)::int FROM material_objects WHERE group_id = $1) AS objects,
                 (SELECT count(*)::int FROM upload_sessions WHERE group_id = $1) AS sessions`,
        values: [owner.groupId],
      });
      expect(nothing[0]).toEqual({ materials: 0, objects: 0, sessions: 0 });
    },
    networkTimeoutMs,
  );

  it(
    'removes the stored object when the upload is cancelled',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const service = createService(runtime);
      const body = randomBytes(1024);
      const contentHash = bytesToHex(blake3(new Uint8Array(body)));

      const begun = await service.beginUpload?.(
        beginRequest(owner.groupId, contentHash, 1024n),
        handlerContext(owner.accessToken),
      );
      const grant = begun?.parts?.[0];
      await fetch(grant?.uploadUrl ?? '', {
        method: 'PUT',
        headers: { ...(grant?.requiredHeaders ?? {}) },
        body: new Uint8Array(body),
      });
      expect(objects.has(`/${storageKeyFor(owner.groupId, contentHash)}`)).toBe(true);

      await service.cancelUpload?.(
        create(materialV1.CancelUploadRequestSchema, {
          uploadId: { value: begun?.session?.id?.value ?? '' },
        }),
        handlerContext(owner.accessToken),
      );

      // A Blob store reclaims nothing on its own -- there is no multipart
      // upload for a lifecycle rule to expire -- so the abort has to delete the
      // object or the bytes stay forever.
      expect(objects.has(`/${storageKeyFor(owner.groupId, contentHash)}`)).toBe(false);
      const state = await database.query<{ state: string }>({
        text: 'SELECT state FROM upload_sessions WHERE id = $1',
        values: [begun?.session?.id?.value ?? ''],
      });
      expect(state[0]?.state).toBe('CANCELLED');
    },
    networkTimeoutMs,
  );

  function createRuntime(): DurablePairedDeviceRuntime {
    return new DurablePairedDeviceRuntime({ database, tokenPepper });
  }

  function createService(runtime: DurablePairedDeviceRuntime) {
    const parsed = loadControlPlaneConfig({
      HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN: readWriteToken,
      HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL: 'https://store01hq.public.blob.invalid',
      HQ_CONTROL_PLANE_BLOB_STORAGE_MAX_OBJECT_BYTES: maxObjectBytes.toString(),
    }).blobStorage;
    if (parsed === undefined) throw new Error('Expected the blob storage group to be configured');
    return createMaterialService({
      runtime,
      store: new DurableMaterialStore({
        database,
        receipts: runtime.receiptGuard,
        // A quarter of the object, so a multipart plan would be four parts and
        // the one-part outcome cannot be an accident of size.
        uploadChunkSize: objectBytes / 4,
      }),
      storage: createVercelBlobGrantIssuer({
        ...parsed,
        apiBaseUrl: api.origin,
        publicBaseUrl: publicStore.origin,
      }),
    });
  }

  async function bootstrapGroup(runtime: DurablePairedDeviceRuntime): Promise<{
    readonly groupId: string;
    readonly accessToken: string;
    readonly authenticated: AuthenticatedDevice;
  }> {
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
});

function beginRequest(
  groupId: string,
  contentHash: string,
  totalSize: bigint = BigInt(objectBytes),
): materialV1.BeginUploadRequest {
  return create(materialV1.BeginUploadRequestSchema, {
    groupId: { value: groupId },
    displayName: 'Съёмка',
    originalFileName: 'take.mp4',
    category: materialV1.MaterialCategory.VIDEO,
    mimeType: 'video/mp4',
    totalSize,
    contentHash,
  });
}

function handlerContext(accessToken: string): HandlerContext {
  return {
    requestHeader: new Headers({ authorization: `Bearer ${accessToken}` }),
    signal: new AbortController().signal,
  } as unknown as HandlerContext;
}

function uniqueSuffix(): string {
  return randomBytes(8).toString('hex');
}

interface ScriptedServer {
  readonly origin: string;
  close(): Promise<void>;
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<ScriptedServer> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        await handler(request, response);
      } catch {
        response.writeHead(500).end('scripted server failure');
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port.toString()}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
