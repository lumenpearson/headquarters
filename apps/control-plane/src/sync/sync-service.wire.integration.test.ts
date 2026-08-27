import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createClient, type Client } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { SyncService, syncV1 } from '@gremuchaya/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ControlPlaneAuthConfig } from '../config.js';
import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { startControlPlane } from '../server.js';

/**
 * The whole `SyncService` contract over the wire it actually ships on.
 *
 * The runtime and store suites prove each mutation against the database; this
 * one proves that a client speaking binary gRPC-Web reaches them — that the
 * handlers are registered, that the bearer header is read, that a
 * `PairedDeviceRuntimeError` becomes the Connect code the client checks for,
 * and that a server-streaming method streams. None of that is observable from
 * inside the process.
 *
 * Opt-in on `HQ_CONTROL_PLANE_TEST_DATABASE_URL`, like every suite that writes.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const bootstrapSecret = 'wire-bootstrap-secret-with-at-least-thirty-two-characters';
const tokenPepper = 'wire-token-pepper-with-at-least-thirty-two-characters';

describeIntegration('SyncService over binary gRPC-Web against real PostgreSQL', () => {
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
    'serves the whole group lifecycle, presence, publication and stream to one client',
    async () => {
      const { sync, close } = await startWireClient();
      closeControlPlane = close;

      const created = await sync.createGroup(
        {
          name: 'Штаб',
          initialDevice: device('Primary workstation', 'ed25519:wire-primary'),
        },
        { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
      );
      const groupId = required(created.group?.id?.value, 'group id');
      const adminToken = required(created.session?.accessToken, 'admin access token');
      const adminHeaders = { authorization: `Bearer ${adminToken}` };

      const renamed = await sync.updateGroup(
        { groupId: { value: groupId }, name: 'Оперативный штаб' },
        { headers: adminHeaders },
      );
      expect(renamed.group?.name).toBe('Оперативный штаб');

      const opened = await sync.setAuthorityMode(
        { groupId: { value: groupId }, mode: syncV1.AuthorityMode.MULTI_AUTHORITY },
        { headers: adminHeaders },
      );
      expect(opened.group?.authorityMode).toBe(syncV1.AuthorityMode.MULTI_AUTHORITY);

      const grant = await sync.createPairingCode(
        { groupId: { value: groupId }, role: syncV1.DeviceRole.EDITOR },
        { headers: adminHeaders },
      );
      const paired = await sync.pairDevice({
        pairingCode: required(grant.pairingCode?.code, 'pairing code'),
        deviceName: 'Analyst laptop',
        publicKey: 'ed25519:wire-analyst',
        platform: 'windows',
        applicationVersion: '0.1.0',
      });
      const editorId = required(paired.device?.id?.value, 'editor device id');
      const editorHeaders = {
        authorization: `Bearer ${required(paired.session?.accessToken, 'editor token')}`,
      };

      const promoted = await sync.setDeviceRole(
        {
          groupId: { value: groupId },
          deviceId: { value: editorId },
          role: syncV1.DeviceRole.ADMIN,
        },
        { headers: adminHeaders },
      );
      expect(promoted.device?.role).toBe(syncV1.DeviceRole.ADMIN);

      const led = await sync.setLeader(
        { groupId: { value: groupId }, deviceId: { value: editorId } },
        { headers: adminHeaders },
      );
      expect(led.group?.leaderDeviceId?.value).toBe(editorId);

      await sync.joinGroup({ groupId: { value: groupId } }, { headers: editorHeaders });
      const presence = await sync.getPresence(
        { groupId: { value: groupId } },
        { headers: adminHeaders },
      );
      expect(presence.devices.map((entry) => entry.deviceId?.value)).toEqual([editorId]);
      expect(presence.devices[0]?.status).toBe(syncV1.DeviceStatus.ONLINE);

      const command = await sync.publishSessionCommand(
        {
          groupId: { value: groupId },
          command: {
            action: syncV1.SessionCommandAction.SEEK,
            target: 'video:primary',
            positionSeconds: 42.5,
          },
        },
        { headers: editorHeaders },
      );
      // Sequence six, not one: every group mutation above published its own
      // event first — rename, authority mode, role change, leader change and
      // the join's presence update. That the administrative RPCs land in the
      // same log as the publications is what makes a group's history one
      // ordered story rather than two.
      expect(command.command?.sequence).toBe(6n);
      expect(command.command?.issuedByDeviceId?.value).toBe(editorId);

      const documentId = crypto.randomUUID();
      const published = await sync.publishDocumentDelta(
        {
          groupId: { value: groupId },
          documentId: { value: documentId },
          documentType: syncV1.SynchronizedDocumentType.LAYOUT,
          delta: Uint8Array.from([1, 2, 3]),
          stateVector: Uint8Array.from([9]),
          hybridLogicalClock: 77n,
        },
        { headers: editorHeaders },
      );
      expect(published.sequence).toBe(7n);

      const snapshot = await sync.getDocumentSnapshot(
        { groupId: { value: groupId }, documentId: { value: documentId } },
        { headers: adminHeaders },
      );
      expect(snapshot.sequence).toBe(7n);
      expect(snapshot.documentType).toBe(syncV1.SynchronizedDocumentType.LAYOUT);

      const streamed: bigint[] = [];
      // A watch never ends on its own, so the caller owns its end. The abort is
      // what lets the handler's `finally` unsubscribe; leaving the stream open
      // leaks a listener for the life of the process.
      const watching = new AbortController();
      for await (const response of sync.watchGroup(
        { groupId: { value: groupId }, afterSequence: 0n },
        { headers: adminHeaders, signal: watching.signal },
      )) {
        if (response.event !== undefined) streamed.push(response.event.sequence);
        if (streamed.length === 7) break;
      }
      watching.abort();
      expect(streamed).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);

      const clock = await sync.timeSync(
        { groupId: { value: groupId }, clientSendMonotonicMs: 12n },
        { headers: adminHeaders },
      );
      expect(clock.clientSendMonotonicMs).toBe(12n);
      const receive = required(clock.serverReceiveTime?.seconds, 'server receive time');
      const send = required(clock.serverSendTime?.seconds, 'server send time');
      expect(send >= receive).toBe(true);

      const left = await sync.leaveGroup(
        { groupId: { value: groupId } },
        { headers: editorHeaders },
      );
      expect(left.result?.resourceId?.value).toBe(editorId);
      const afterLeaving = await sync.getPresence(
        { groupId: { value: groupId } },
        { headers: adminHeaders },
      );
      expect(afterLeaving.devices[0]?.status).toBe(syncV1.DeviceStatus.OFFLINE);
    },
    networkTimeoutMs,
  );

  it(
    'adds nothing to the durable log however often a device asks who is present',
    async () => {
      const { sync, close } = await startWireClient();
      closeControlPlane = close;

      const created = await sync.createGroup(
        {
          name: 'Штаб-3',
          initialDevice: device('Primary workstation', 'ed25519:wire-primary-3'),
        },
        { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
      );
      const groupId = required(created.group?.id?.value, 'group id');
      const adminHeaders = {
        authorization: `Bearer ${required(created.session?.accessToken, 'admin token')}`,
      };
      await sync.joinGroup({ groupId: { value: groupId } }, { headers: adminHeaders });
      const afterJoining = await countEvents(groupId);

      for (let poll = 0; poll < 10; poll += 1) {
        const presence = await sync.getPresence(
          { groupId: { value: groupId } },
          { headers: adminHeaders },
        );
        expect(presence.devices[0]?.deviceId?.value).toBe(created.device?.id?.value);
      }

      // Ten polls, and `sync_events` holds exactly what the join left there.
      // Renewing liveness through a second `JoinGroup` would have written ten
      // more rows and spent ten more sequence numbers, and a client polls every
      // fifteen seconds for as long as it is open — this count is what says the
      // renewal took the other road. Counted in the table rather than argued
      // from the code: an event appended anywhere on this path would show up
      // here.
      expect(await countEvents(groupId)).toBe(afterJoining);
      expect(afterJoining).toBe(1);
    },
    networkTimeoutMs,
  );

  it(
    'writes one log row when a device is revoked, and drops it from the device list',
    async () => {
      const { sync, close } = await startWireClient();
      closeControlPlane = close;

      const created = await sync.createGroup(
        {
          name: 'Штаб-4',
          initialDevice: device('Primary workstation', 'ed25519:wire-primary-4'),
        },
        { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
      );
      const groupId = required(created.group?.id?.value, 'group id');
      const adminId = required(created.device?.id?.value, 'admin device id');
      const adminHeaders = {
        authorization: `Bearer ${required(created.session?.accessToken, 'admin token')}`,
      };
      const grant = await sync.createPairingCode(
        { groupId: { value: groupId }, role: syncV1.DeviceRole.EDITOR },
        { headers: adminHeaders },
      );
      const paired = await sync.pairDevice({
        pairingCode: required(grant.pairingCode?.code, 'pairing code'),
        deviceName: 'Analyst laptop',
        publicKey: 'ed25519:wire-analyst-4',
        platform: 'windows',
        applicationVersion: '0.1.0',
      });
      const editorId = required(paired.device?.id?.value, 'editor device id');
      const editorHeaders = {
        authorization: `Bearer ${required(paired.session?.accessToken, 'editor token')}`,
      };
      await sync.joinGroup({ groupId: { value: groupId } }, { headers: editorHeaders });
      const beforeRevoke = await countEvents(groupId);

      const revoked = await sync.revokeDevice(
        { groupId: { value: groupId }, deviceId: { value: editorId } },
        { headers: adminHeaders },
      );

      // Counted in the table, not argued from the code: exactly one row more
      // than the revocation found. Until this handler published, the count did
      // not move at all, and a neighbour learned of a revoked device only from
      // whatever `ListDevices` it happened to make next.
      expect(await countEvents(groupId)).toBe(beforeRevoke + 1);
      const page = await sync.readGroupEvents(
        { groupId: { value: groupId }, afterSequence: 0n },
        { headers: adminHeaders },
      );
      expect(page.events).toHaveLength(beforeRevoke + 1);
      const event = page.events.at(-1);
      expect(event?.kind).toBe(syncV1.GroupEventKind.DEVICE_UPDATED);
      expect(event?.device?.id?.value).toBe(editorId);
      expect(event?.device?.status).toBe(syncV1.DeviceStatus.REVOKED);
      // The revision the mutation produced, so a session that already applied
      // the revocation from the answer to its own call ignores this copy, and a
      // session that has not applied it takes it.
      expect(event?.group?.revision?.number).toBe(revoked.result?.revision?.number);

      // The two paths agree on the device and differ on how long they show it:
      // the log says "this one is revoked" once, and the list stops carrying
      // the row at all.
      const devices = await sync.listDevices(
        { groupId: { value: groupId } },
        { headers: adminHeaders },
      );
      expect(devices.devices.map((entry) => entry.id?.value)).toEqual([adminId]);
      const presence = await sync.getPresence(
        { groupId: { value: groupId } },
        { headers: adminHeaders },
      );
      expect(presence.devices.map((entry) => entry.deviceId?.value)).toEqual([]);
    },
    networkTimeoutMs,
  );

  it(
    'answers a retried revoke from its receipt and revises the group once',
    async () => {
      const { sync, close } = await startWireClient();
      closeControlPlane = close;

      const created = await sync.createGroup(
        {
          name: 'Штаб-5',
          initialDevice: device('Primary workstation', 'ed25519:wire-primary-5'),
        },
        { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
      );
      const groupId = required(created.group?.id?.value, 'group id');
      const adminHeaders = {
        authorization: `Bearer ${required(created.session?.accessToken, 'admin token')}`,
      };
      const grant = await sync.createPairingCode(
        { groupId: { value: groupId }, role: syncV1.DeviceRole.EDITOR },
        { headers: adminHeaders },
      );
      const paired = await sync.pairDevice({
        pairingCode: required(grant.pairingCode?.code, 'pairing code'),
        deviceName: 'Analyst laptop',
        publicKey: 'ed25519:wire-analyst-5',
        platform: 'windows',
        applicationVersion: '0.1.0',
      });
      const editorId = required(paired.device?.id?.value, 'editor device id');
      const requestId = `revoke-${crypto.randomUUID()}`;
      const beforeRevoke = await countEvents(groupId);

      const first = await sync.revokeDevice(
        { context: { requestId }, groupId: { value: groupId }, deviceId: { value: editorId } },
        { headers: adminHeaders },
      );
      const retry = await sync.revokeDevice(
        { context: { requestId }, groupId: { value: groupId }, deviceId: { value: editorId } },
        { headers: adminHeaders },
      );

      // The receipt is what makes the mutation once-only: the group is revised
      // once however often the call is retried, and the retry is answered with
      // the revision its own request produced rather than whatever the group
      // has drifted to.
      expect(retry.result?.revision?.number).toBe(first.result?.revision?.number);
      const revisions = await database.query<{ revision: string }>({
        text: 'SELECT revision::text AS revision FROM groups WHERE id = $1',
        values: [groupId],
      });
      expect(revisions[0]?.revision).toBe(String(first.result?.revision?.number));

      // The publication is an epilogue and runs once per call, so a retry does
      // append a second copy of the same snapshot. It carries the same
      // revision, which is the field a subscriber drops a repeat by, so the
      // duplicate changes no state anywhere. Measured rather than claimed as
      // desirable: `UpdateGroup`, `SetLeader`, `SetAuthorityMode` and
      // `SetDeviceRole` all publish this way, and making an epilogue skip a
      // replay is one change for the five of them, not one for this handler.
      expect(await countEvents(groupId)).toBe(beforeRevoke + 2);
      const page = await sync.readGroupEvents(
        { groupId: { value: groupId }, afterSequence: BigInt(beforeRevoke) },
        { headers: adminHeaders },
      );
      expect(page.events.map((event) => [event.kind, event.group?.revision?.number])).toEqual([
        [syncV1.GroupEventKind.DEVICE_UPDATED, first.result?.revision?.number],
        [syncV1.GroupEventKind.DEVICE_UPDATED, first.result?.revision?.number],
      ]);
    },
    networkTimeoutMs,
  );

  it(
    'refuses a viewer publication and a foreign group with the codes a client checks for',
    async () => {
      const { sync, close } = await startWireClient();
      closeControlPlane = close;

      const created = await sync.createGroup(
        {
          name: 'Штаб-2',
          initialDevice: device('Primary workstation', 'ed25519:wire-primary-2'),
        },
        { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
      );
      const groupId = required(created.group?.id?.value, 'group id');
      const adminHeaders = {
        authorization: `Bearer ${required(created.session?.accessToken, 'admin token')}`,
      };
      const grant = await sync.createPairingCode(
        { groupId: { value: groupId }, role: syncV1.DeviceRole.VIEWER },
        { headers: adminHeaders },
      );
      const viewer = await sync.pairDevice({
        pairingCode: required(grant.pairingCode?.code, 'pairing code'),
        deviceName: 'Observer',
        publicKey: 'ed25519:wire-observer',
        platform: 'windows',
        applicationVersion: '0.1.0',
      });
      const viewerHeaders = {
        authorization: `Bearer ${required(viewer.session?.accessToken, 'viewer token')}`,
      };

      await expect(
        sync.publishSessionCommand(
          {
            groupId: { value: groupId },
            command: { action: syncV1.SessionCommandAction.PLAY, target: 'video:primary' },
          },
          { headers: viewerHeaders },
        ),
      ).rejects.toMatchObject({ code: 7 });

      await expect(
        sync.getPresence({ groupId: { value: crypto.randomUUID() } }, { headers: viewerHeaders }),
      ).rejects.toMatchObject({ code: 7 });

      await expect(sync.getPresence({ groupId: { value: groupId } })).rejects.toMatchObject({
        code: 16,
      });
    },
    networkTimeoutMs,
  );

  async function countEvents(groupId: string): Promise<number> {
    const rows = await database.query<{ n: number }>({
      text: 'SELECT count(*)::int AS n FROM sync_events WHERE group_id = $1',
      values: [groupId],
    });
    return rows[0]?.n ?? -1;
  }

  async function startWireClient(): Promise<{
    readonly sync: Client<typeof SyncService>;
    readonly close: () => Promise<void>;
  }> {
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
    const address = running.server.address() as AddressInfo;
    const transport = createGrpcWebTransport({
      baseUrl: `http://127.0.0.1:${address.port}`,
      useBinaryFormat: true,
    });
    return { sync: createClient(SyncService, transport), close: running.close };
  }
});

function authConfig(): ControlPlaneAuthConfig {
  return {
    tokenHashVersion: 'v1',
    accessTokenLifetimeMs: 900_000,
    refreshTokenLifetimeMs: 2_592_000_000,
    pairingCodeLifetimeMs: 600_000,
    hashCredential: (kind, credential) =>
      createHmac('sha256', tokenPepper).update(`v1 ${kind} ${credential}`).digest('base64url'),
    verifyBootstrapSecret: (candidate) => candidate === bootstrapSecret,
  };
}

function device(name: string, publicKey: string) {
  return { name, publicKey, platform: 'windows', applicationVersion: '0.1.0' };
}

function required<Value>(value: Value | undefined, field: string): Value {
  if (value === undefined) throw new Error(`Expected ${field} in the response.`);
  return value;
}
