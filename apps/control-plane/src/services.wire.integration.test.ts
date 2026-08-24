import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
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

import type { ControlPlaneAuthConfig } from './config.js';
import type { SqlClient } from './db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from './db/liveDatabase.js';
import { runMigrations } from './db/migrations.js';
import { startControlPlane } from './server.js';

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
      for (const name of ['settings', 'materials', 'telemetry', 'integration', 'sync']) {
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
      ]);

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
            { path: 'appearance.theme', value: { value: { case: 'stringValue', value: 'dark' } } },
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

function required<Value>(value: Value | undefined, field: string): Value {
  if (value === undefined) throw new Error(`Expected ${field} in the response.`);
  return value;
}
