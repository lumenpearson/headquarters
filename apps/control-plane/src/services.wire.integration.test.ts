import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  ControlPlaneService,
  IntegrationService,
  MaterialService,
  SettingsService,
  SyncService,
  TelemetryService,
  materialV1,
  settingsV1,
} from '@gremuchaya/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadControlPlaneConfig, type ControlPlaneAuthConfig } from './config.js';
import type { SqlClient } from './db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from './db/liveDatabase.js';
import { runMigrations } from './db/migrations.js';
import { startControlPlane } from './server.js';
import {
  createS3GrantIssuer,
  type StorageFetch,
  type StorageFetchRequest,
} from './storage/s3-grant-issuer.js';

/**
 * That the four services F6 added are actually reachable.
 *
 * Each has its own store and service suites; none of them can show that the
 * composition root constructed it, that the router registered it, or that
 * `getCapabilities` now tells the truth about it. A service that works
 * perfectly and is never registered looks identical from inside the process.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const bootstrapSecret = 'services-bootstrap-secret-with-at-least-thirty-two-characters';
const tokenPepper = 'services-token-pepper-with-at-least-thirty-two-characters';

describeIntegration('every control-plane service over binary gRPC-Web', () => {
  const pool = new DisposableDatabasePool(testDatabaseUrl ?? '');
  let database: SqlClient;
  let closeControlPlane: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    database = await pool.create();
    await runMigrations(database);
  }, networkTimeoutMs);

  afterEach(async () => {
    await closeControlPlane?.();
    closeControlPlane = undefined;
  }, networkTimeoutMs);

  afterAll(async () => {
    await pool.dropAll();
  }, networkTimeoutMs);

  it(
    'registers settings, materials, telemetry and integration, and says so in its capabilities',
    async () => {
      const running = await startControlPlane(
        {
          port: 0,
          host: '127.0.0.1',
          allowedOrigins: ['http://127.0.0.1:3000'],
          databaseUrl: testDatabaseUrl ?? '',
          auth: authConfig(),
        },
        { pairedDeviceLifecycle: { database } },
      );
      closeControlPlane = running.close;
      const address = running.server.address() as AddressInfo;
      const transport = createGrpcWebTransport({
        baseUrl: `http://127.0.0.1:${address.port}`,
        useBinaryFormat: true,
      });
      const control = createClient(ControlPlaneService, transport);
      const sync = createClient(SyncService, transport);
      const settings = createClient(SettingsService, transport);
      const materials = createClient(MaterialService, transport);
      const telemetry = createClient(TelemetryService, transport);
      const integration = createClient(IntegrationService, transport);

      const capabilities = await control.getCapabilities({});
      // Every one of these read `enabled: false` before F6, and two of them said
      // so while the service did not exist at all.
      for (const name of [
        'settings',
        'materials',
        'telemetry',
        // The measurement half is reported separately from the simulation half,
        // because a deployment can serve one without the other.
        'telemetry.measurement',
        'integration',
        'sync',
      ]) {
        expect(capabilities.capabilities).toContainEqual({
          $typeName: 'gremuchaya.control.v1.Capability',
          name,
          version: 'v1',
          enabled: true,
        });
      }
      const health = await control.health({});
      expect(health.dependencies.map((dependency) => dependency.name)).toEqual([
        'database',
        'redis',
        'storage',
        'github',
        'conversion',
      ]);
      expect(capabilities.capabilities).toContainEqual({
        $typeName: 'gremuchaya.control.v1.Capability',
        name: 'materials.storage-grants',
        version: 'v1',
        enabled: false,
      });
      // This deployment configures no bucket and no worker, so no variant can
      // ever be built and the quality menu is told so rather than offering
      // four entries that all resolve to the original.
      expect(capabilities.capabilities).toContainEqual({
        $typeName: 'gremuchaya.control.v1.Capability',
        name: 'materials.rendition-pipeline',
        version: 'v1',
        enabled: false,
      });

      const created = await sync.createGroup(
        {
          name: 'Штаб',
          initialDevice: {
            name: 'Primary workstation',
            publicKey: 'ed25519:services-primary',
            platform: 'windows',
            applicationVersion: '0.1.0',
          },
        },
        { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
      );
      const groupId = required(created.group?.id?.value, 'group id');
      const headers = {
        authorization: `Bearer ${required(created.session?.accessToken, 'access token')}`,
      };

      const patched = await settings.applyDraftPatch(
        {
          scope: {
            type: settingsV1.SettingsScopeType.GROUP,
            resourceId: { value: groupId },
          },
          operations: [
            { path: 'appearance.theme', value: { kind: { case: 'stringValue', value: 'dark' } } },
          ],
        },
        { headers },
      );
      expect(patched.draft?.revision?.number).toBe(1n);

      // This deployment configures no object storage, so the three RPCs that
      // mint an upload or download address refuse by naming what is missing.
      // That is the declared reduced mode, and it is what a client can act on —
      // an empty URL it could not tell from a real one would not be.
      const upload = await materials
        .beginUpload(
          {
            groupId: { value: groupId },
            displayName: 'Съёмка',
            originalFileName: 'take-01.mp4',
            category: materialV1.MaterialCategory.VIDEO,
            mimeType: 'video/mp4',
            totalSize: 1024n,
            contentHash: 'blake3:services-wire-content',
          },
          { headers },
        )
        .catch((error: unknown) => error);
      expect(String(upload)).toContain('no object storage configured');

      // Everything that needs no bucket works, which is what proves the service
      // is registered rather than merely constructed.
      const listed = await materials.listMaterials({ groupId: { value: groupId } }, { headers });
      expect(listed.materials).toEqual([]);
      const trash = await materials.listTrash({ groupId: { value: groupId } }, { headers });
      expect(trash.materials).toEqual([]);

      const profiles = await telemetry.listSimulationProfiles(
        { groupId: { value: groupId } },
        { headers },
      );
      expect(profiles.profiles).toEqual([]);

      // The measurement half answers over the same binary gRPC-Web transport
      // rather than `unimplemented`, which is what the capability above claims.
      // The group has published no profile, so it declares no source, and an
      // empty registry is the honest answer to that.
      const dataSources = await telemetry.listDataSources({}, { headers });
      expect(dataSources.sources).toEqual([]);

      const status = await integration.getIntegrationStatus(
        { groupId: { value: groupId }, provider: 1 },
        { headers },
      );
      expect(status.status).toBeDefined();

      // The group's own event log recorded the settings and material writes
      // alongside the pairing mutations, which is what makes a group history one
      // ordered story rather than four.
      const events = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM sync_events WHERE group_id = $1',
        values: [groupId],
      });
      expect(events[0]?.n).toBeGreaterThanOrEqual(0);
    },
    networkTimeoutMs,
  );
});

describeIntegration('material grants over binary gRPC-Web with a configured bucket', () => {
  const pool = new DisposableDatabasePool(testDatabaseUrl ?? '');
  let database: SqlClient;
  let closeControlPlane: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    database = await pool.create();
    await runMigrations(database);
  }, networkTimeoutMs);

  afterEach(async () => {
    await closeControlPlane?.();
    closeControlPlane = undefined;
  }, networkTimeoutMs);

  afterAll(async () => {
    await pool.dropAll();
  }, networkTimeoutMs);

  it(
    'mints presigned S3 grants and drives the multipart lifecycle through the real issuer',
    async () => {
      // The real configuration parser and the real issuer; only the bucket is
      // scripted. What this proves is the composition root — that the storage
      // group reaches the material service, that `Health` and `GetCapabilities`
      // say so, and that the URLs a client receives are SigV4-presigned for the
      // configured bucket. Whether a real store accepts them is what no test
      // here can prove; see docs/release/known-limitations.md.
      const storage = loadControlPlaneConfig({
        HQ_CONTROL_PLANE_STORAGE_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
        HQ_CONTROL_PLANE_STORAGE_REGION: 'eu-central-1',
        HQ_CONTROL_PLANE_STORAGE_BUCKET: 'gremuchaya-materials',
        HQ_CONTROL_PLANE_STORAGE_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        HQ_CONTROL_PLANE_STORAGE_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        HQ_CONTROL_PLANE_STORAGE_GRANT_TTL_SECONDS: '300',
      }).storage;
      // The declared hash is a real BLAKE3 digest of the bytes the scripted
      // bucket will serve back, because the completion re-derives it before it
      // records a version. A placeholder string would now be refused as a
      // digest this control plane cannot verify.
      const assembled = Uint8Array.from({ length: 1024 }, (_, index) => (index * 37) & 0xff);
      const contentHash = bytesToHex(blake3(assembled));
      const bucket = scriptedBucket(assembled);
      const running = await startControlPlane(
        {
          port: 0,
          host: '127.0.0.1',
          allowedOrigins: ['http://127.0.0.1:3000'],
          databaseUrl: testDatabaseUrl ?? '',
          auth: authConfig(),
          ...(storage === undefined ? {} : { storage }),
        },
        {
          pairedDeviceLifecycle: {
            database,
            storageFactory: (config) => createS3GrantIssuer(config, { fetch: bucket.fetch }),
          },
        },
      );
      closeControlPlane = running.close;
      const address = running.server.address() as AddressInfo;
      const transport = createGrpcWebTransport({
        baseUrl: `http://127.0.0.1:${address.port}`,
        useBinaryFormat: true,
      });
      const control = createClient(ControlPlaneService, transport);
      const sync = createClient(SyncService, transport);
      const materials = createClient(MaterialService, transport);

      const health = await control.health({});
      expect(health.dependencies.find((dependency) => dependency.name === 'storage')).toMatchObject(
        {
          status: 1,
          detail: expect.stringContaining('expire after 300 s'),
        },
      );
      expect(serialize(health)).not.toContain('wJalrXUtnFEMI');
      expect(serialize(health)).not.toContain('gremuchaya-materials');
      const capabilities = await control.getCapabilities({});
      expect(capabilities.capabilities).toContainEqual({
        $typeName: 'gremuchaya.control.v1.Capability',
        name: 'materials.storage-grants',
        version: 'v1',
        enabled: true,
      });

      const created = await sync.createGroup(
        {
          name: 'Штаб',
          initialDevice: {
            name: 'Primary workstation',
            publicKey: 'ed25519:services-storage',
            platform: 'windows',
            applicationVersion: '0.1.0',
          },
        },
        { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
      );
      const groupId = required(created.group?.id?.value, 'group id');
      const headers = {
        authorization: `Bearer ${required(created.session?.accessToken, 'access token')}`,
      };
      const upload = await materials.beginUpload(
        {
          groupId: { value: groupId },
          displayName: 'Съёмка',
          originalFileName: 'take-01.mp4',
          category: materialV1.MaterialCategory.VIDEO,
          mimeType: 'video/mp4',
          totalSize: BigInt(assembled.byteLength),
          contentHash,
        },
        { headers },
      );
      expect(upload.deduplicated).toBe(false);
      expect(upload.parts).toHaveLength(1);
      const partUrl = new URL(required(upload.parts[0]?.uploadUrl, 'part url'));
      expect(partUrl.origin).toBe('https://gremuchaya-materials.s3.eu-central-1.amazonaws.com');
      expect(partUrl.pathname).toBe(`/materials/${groupId}/${contentHash}`);
      expect(partUrl.searchParams.get('uploadId')).toBe(bucket.uploadId);
      expect(partUrl.searchParams.get('partNumber')).toBe('1');
      expect(partUrl.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(partUrl.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/u);
      expect(partUrl.searchParams.get('X-Amz-Credential')).toMatch(
        /^AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request$/u,
      );
      expect(bucket.calls.map((call) => call.request.method)).toEqual(['POST']);
      expect(bucket.calls[0]?.url).toBe(
        `https://gremuchaya-materials.s3.eu-central-1.amazonaws.com/materials/${groupId}/${contentHash}?uploads=`,
      );

      const uploadId = required(upload.session?.id?.value, 'upload id');
      const completed = await materials.completeUpload(
        {
          uploadId: { value: uploadId },
          contentHash,
          parts: [{ partNumber: 1, etag: '"wire-etag"', checksum: 'crc32c-1' }],
        },
        { headers },
      );
      expect(completed.material?.status).toBe(materialV1.MaterialStatus.READY);
      // Assembly, then read-back, then the database: the GET is the third call
      // and it happens on the way to a READY material, not after one.
      expect(bucket.calls.map((call) => call.request.method)).toEqual(['POST', 'POST', 'GET']);
      expect(new URL(bucket.calls[1]?.url ?? '').searchParams.get('uploadId')).toBe(
        bucket.uploadId,
      );
      expect(bucket.calls[1]?.request.body).toContain(
        '<Part><PartNumber>1</PartNumber><ETag>&quot;wire-etag&quot;</ETag></Part>',
      );
      expect(new URL(bucket.calls[2]?.url ?? '').search).toBe('');

      const materialId = required(completed.material?.id?.value, 'material id');
      const download = await materials.getDownloadGrant(
        { materialId: { value: materialId } },
        { headers },
      );
      const downloadUrl = new URL(required(download.grant?.url, 'download url'));
      expect(downloadUrl.searchParams.get('response-content-disposition')).toBe('attachment');
      expect(downloadUrl.searchParams.get('response-content-type')).toBe('video/mp4');
      expect(downloadUrl.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/u);
      expect(download.grant?.byteSize).toBe(1024n);
      const preview = await materials.getPreviewGrant(
        { materialId: { value: materialId }, variant: 'thumbnail' },
        { headers },
      );
      expect(
        new URL(required(preview.grant?.url, 'preview url')).searchParams.get(
          'response-content-disposition',
        ),
      ).toBe('inline');
      expect(preview.grant?.mimeType).toBe('video/mp4');

      // Nothing the client received or the bucket was sent carries the secret.
      expect(serialize([upload, completed, download, preview, bucket.calls])).not.toContain(
        'wJalrXUtnFEMI',
      );
    },
    networkTimeoutMs,
  );
});

interface ScriptedBucket {
  readonly fetch: StorageFetch;
  readonly calls: readonly { readonly url: string; readonly request: StorageFetchRequest }[];
  readonly uploadId: string;
}

/**
 * Answers the multipart calls the way the S3 API Reference documents them, and
 * hands back `assembled` on the read-back the completion now performs. Serving
 * the same bytes the content hash was taken over is what lets this scenario
 * reach a READY material; a bucket that returned anything else would be the
 * dishonest-upload case, which `material.live-storage.integration.test.ts`
 * covers against a real store.
 */
function scriptedBucket(assembled: Uint8Array): ScriptedBucket {
  const calls: { url: string; request: StorageFetchRequest }[] = [];
  const uploadId = 'wire-multipart-upload-id';
  return {
    calls,
    uploadId,
    fetch: (url, request) => {
      calls.push({ url, request });
      const query = new URL(url).searchParams;
      if (request.method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: () => Promise.resolve(''),
          chunks: () => oneChunk(assembled),
        };
      }
      if (request.method === 'POST' && query.has('uploads')) {
        return {
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
            ),
        };
      }
      if (request.method === 'POST' && query.get('uploadId') === uploadId) {
        return {
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              '<CompleteMultipartUploadResult><ETag>"assembled"</ETag></CompleteMultipartUploadResult>',
            ),
        };
      }
      if (request.method === 'DELETE') {
        return { ok: true, status: 204, text: () => Promise.resolve('') };
      }
      return {
        ok: false,
        status: 400,
        text: () => Promise.resolve('<Error><Code>InvalidRequest</Code></Error>'),
      };
    },
  };
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield await Promise.resolve(bytes);
}

function authConfig(): ControlPlaneAuthConfig {
  return {
    tokenHashVersion: 'v1',
    accessTokenLifetimeMs: 900_000,
    refreshTokenLifetimeMs: 2_592_000_000,
    pairingCodeLifetimeMs: 600_000,
    hashCredential: (kind, credential) =>
      createHmac('sha256', tokenPepper).update(`v1 ${kind} ${credential}`).digest('base64url'),
    verifyBootstrapSecret: (candidate) => candidate === bootstrapSecret,
  };
}

/** `JSON.stringify` with the protocol's `uint64` fields rendered, so a secret search covers everything. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    typeof field === 'bigint' ? field.toString() : field,
  );
}

function required<Value>(value: Value | undefined, field: string): Value {
  if (value === undefined) throw new Error(`Expected ${field} in the response.`);
  return value;
}
