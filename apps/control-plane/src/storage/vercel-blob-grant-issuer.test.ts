import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { blake3 } from '@noble/hashes/blake3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadControlPlaneConfig, type ControlPlaneBlobStorageConfig } from '../config.js';
import type { StorageGrantIssuer } from '../material/service.js';

import {
  createVercelBlobGrantIssuer,
  wholeObjectUploadId,
  VercelBlobContractError,
} from './vercel-blob-grant-issuer.js';

/**
 * The Vercel Blob issuer against a scripted Blob API.
 *
 * There is no Blob store and no read-write token in this repository, so nothing
 * here proves that Vercel accepts what this issuer produces. What it does prove
 * is everything that is this deployment's own responsibility: the whole-object
 * plan is declared and enforced, an upload grant carries a client token derived
 * from the deployment token and never the deployment token itself, a real PUT
 * to the address in the grant with the headers in the grant stores the bytes,
 * the read-back re-derives the digest over a real stream and fails closed on a
 * digest it cannot recompute, and an abort deletes the object with the server's
 * own credential.
 *
 * The servers are real `node:http` servers driven through real `fetch`: a
 * scripted response object could not show that the URL parses, that the headers
 * survive transport, or that the streamed read-back consumes the body.
 */

const readWriteToken = 'vercel_blob_rw_store01HQ_abcdefghijklmnopqrstuvwxyz012345';
const secretPart = 'abcdefghijklmnopqrstuvwxyz012345';
const storageKey = 'materials/018b2a02-0000-7000-8000-0000000000a1/' + 'b'.repeat(64);

describe('vercel blob grant issuer', () => {
  const objects = new Map<string, Buffer>();
  const deleted: string[][] = [];
  let api: ScriptedServer;
  let publicStore: ScriptedServer;
  let config: ControlPlaneBlobStorageConfig;
  let issuer: StorageGrantIssuer;

  beforeAll(async () => {
    api = await startServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/delete') {
        if (request.headers.authorization !== `Bearer ${readWriteToken}`) {
          response.writeHead(403).end('forbidden');
          return;
        }
        const body: unknown = JSON.parse((await readBody(request)).toString('utf8'));
        const urls = Array.isArray((body as { urls?: unknown }).urls)
          ? ((body as { urls: string[] }).urls satisfies string[])
          : [];
        deleted.push(urls);
        for (const url of urls) objects.delete(new URL(url).pathname);
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      if (request.method === 'PUT') {
        // The scripted store enforces what the documented endpoint enforces:
        // a client token, and the API version header.
        const authorization = request.headers.authorization ?? '';
        if (!authorization.startsWith('Bearer vercel_blob_client_')) {
          response.writeHead(401).end('unauthorized');
          return;
        }
        if (request.headers['x-api-version'] !== '7') {
          response.writeHead(400).end('missing api version');
          return;
        }
        objects.set(request.url ?? '', await readBody(request));
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      response.writeHead(405).end('method not allowed');
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

    // The configuration is parsed from the environment, so the token capture and
    // the token derivation under test are the production ones; only the two
    // origins are rewritten, because the parser refuses cleartext.
    const parsed = loadControlPlaneConfig({
      HQ_CONTROL_PLANE_BLOB_STORAGE_TOKEN: readWriteToken,
      HQ_CONTROL_PLANE_BLOB_STORAGE_PUBLIC_BASE_URL: 'https://store01hq.public.blob.invalid',
      HQ_CONTROL_PLANE_BLOB_STORAGE_MAX_OBJECT_BYTES: (32 * 1024 * 1024).toString(),
    }).blobStorage;
    if (parsed === undefined) throw new Error('Expected the blob storage group to be configured');
    config = { ...parsed, apiBaseUrl: api.origin, publicBaseUrl: publicStore.origin };
    issuer = createVercelBlobGrantIssuer(config);
  });

  afterAll(async () => {
    await api.close();
    await publicStore.close();
  });

  it('declares a whole-object plan carrying the configured ceiling', () => {
    expect(issuer.uploadPartPlan).toEqual({
      mode: 'whole-object',
      maxObjectBytes: 32n * 1024n * 1024n,
    });
  });

  it('opens no multipart upload and records a constant rather than a credential', () => {
    const handle = issuer.createMultipartUpload({ storageKey, mimeType: 'video/mp4' });

    expect(handle).toEqual({ remoteUploadId: wholeObjectUploadId });
    // The value reaches `upload_sessions.storage_upload_id`, which is durable.
    // A client token in that column would be a persisted raw credential.
    expect(wholeObjectUploadId).not.toContain('vercel_blob');
  });

  it('refuses to address any part but the first', () => {
    expect(() =>
      issuer.issueUploadPart({ remoteUploadId: wholeObjectUploadId, storageKey, partNumber: 2 }),
    ).toThrowError(VercelBlobContractError);
  });

  it('refuses a completion that names more than the one whole object', () => {
    expect(() =>
      issuer.completeMultipartUpload({
        storageKey,
        remoteUploadId: wholeObjectUploadId,
        parts: [
          { partNumber: 1, etag: 'a' },
          { partNumber: 2, etag: 'b' },
        ],
      }),
    ).toThrowError(VercelBlobContractError);
  });

  it('mints a client token bound to the object and never discloses the deployment token', async () => {
    const grant = await issuer.issueUploadPart({
      remoteUploadId: wholeObjectUploadId,
      storageKey,
      partNumber: 1,
    });
    const serialized = JSON.stringify(grant);
    const authorization = grant.requiredHeaders?.authorization ?? '';
    const token = authorization.replace('Bearer ', '');

    expect(grant.url).toBe(`${api.origin}/${storageKey}`);
    expect(token.startsWith(`vercel_blob_client_${config.storeId}_`)).toBe(true);
    // Neither the read-write token nor its secret half appears anywhere in what
    // the client is handed.
    expect(serialized).not.toContain(readWriteToken);
    expect(serialized).not.toContain(secretPart);

    const encoded = token.slice(`vercel_blob_client_${config.storeId}_`.length);
    const [signature, payload] = splitOnce(Buffer.from(encoded, 'base64').toString('utf8'), '.');
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    // The signature is over the payload under the deployment token, and the
    // payload binds the token to this object, this size ceiling and this
    // window — a grant for one material cannot be spent on another.
    expect(signature).toBe(createHmac('sha256', readWriteToken).update(payload).digest('hex'));
    expect(claims).toMatchObject({
      pathname: storageKey,
      maximumSizeInBytes: 32 * 1024 * 1024,
      addRandomSuffix: false,
    });
    expect((claims as { validUntil: number }).validUntil).toBe(grant.expiresAt.getTime());
  });

  it('stores the bytes a client PUTs to the grant and then verifies them', async () => {
    const grant = await issuer.issueUploadPart({
      remoteUploadId: wholeObjectUploadId,
      storageKey,
      partNumber: 1,
    });
    const body = Buffer.from('оперативный штаб', 'utf8');

    const upload = await fetch(grant.url, {
      method: 'PUT',
      headers: { ...(grant.requiredHeaders ?? {}) },
      body: new Uint8Array(body),
    });
    expect(upload.status).toBe(200);

    await expect(
      issuer.verifyObject({
        storageKey,
        contentHash: blake3Hex(body),
        byteSize: BigInt(body.byteLength),
      }),
    ).resolves.toEqual({ outcome: 'verified' });
    await expect(
      issuer.verifyObject({
        storageKey,
        contentHash: blake3Hex(body),
        byteSize: BigInt(body.byteLength) + 1n,
      }),
    ).resolves.toEqual({ outcome: 'size-mismatch', actualByteSize: BigInt(body.byteLength) });
    await expect(
      issuer.verifyObject({
        storageKey,
        contentHash: 'c'.repeat(64),
        byteSize: BigInt(body.byteLength),
      }),
    ).resolves.toEqual({ outcome: 'hash-mismatch' });
  });

  it('fails closed on a digest it cannot recompute, without spending the bytes', async () => {
    await expect(
      issuer.verifyObject({ storageKey, contentHash: 'not-a-digest', byteSize: 1n }),
    ).resolves.toEqual({ outcome: 'unverifiable-digest' });
  });

  it('reports a missing object rather than an error', async () => {
    await expect(
      issuer.verifyObject({
        storageKey: 'materials/absent/object',
        contentHash: 'd'.repeat(64),
        byteSize: 1n,
      }),
    ).resolves.toEqual({ outcome: 'missing' });
  });

  it('serves a download with the store download switch and a preview without it', async () => {
    const download = await issuer.issueDownload(objectRequest());
    const preview = await issuer.issuePreview({ ...objectRequest(), variant: 'ORIGINAL' });

    expect(download.url).toBe(`${publicStore.origin}/${storageKey}?download=1`);
    expect(preview.url).toBe(`${publicStore.origin}/${storageKey}`);
    expect(preview.mimeType).toBe('video/mp4');
  });

  it('deletes the object on abort with the deployment credential', async () => {
    const body = Buffer.from('to be abandoned', 'utf8');
    const grant = await issuer.issueUploadPart({
      remoteUploadId: wholeObjectUploadId,
      storageKey,
      partNumber: 1,
    });
    await fetch(grant.url, {
      method: 'PUT',
      headers: { ...(grant.requiredHeaders ?? {}) },
      body: new Uint8Array(body),
    });

    await issuer.abortMultipartUpload({ storageKey, remoteUploadId: wholeObjectUploadId });

    expect(deleted.at(-1)).toEqual([`${publicStore.origin}/${storageKey}`]);
    await expect(
      issuer.verifyObject({
        storageKey,
        contentHash: blake3Hex(body),
        byteSize: BigInt(body.byteLength),
      }),
    ).resolves.toEqual({ outcome: 'missing' });
  });

  function objectRequest() {
    return {
      materialId: 'material',
      versionId: 'version',
      storageKey,
      contentHash: 'e'.repeat(64),
      mimeType: 'video/mp4',
      byteSize: 16n,
    };
  }
});

function blake3Hex(body: Buffer): string {
  // The clients' own implementation, which is what makes agreement here mean
  // agreement there.
  return Buffer.from(blake3.create().update(new Uint8Array(body)).digest()).toString('hex');
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return index === -1 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)];
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
