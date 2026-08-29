import { randomBytes } from 'node:crypto';

import { syncV1 } from '@gremuchaya/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { DurableRealtimeEventStore } from '../realtime/eventStore.js';

import { DurablePairedDeviceRuntime } from './durable-runtime.js';
import { DurablePresenceStore } from './presence-store.js';
import type { AuthenticatedDevice, PairedGroup } from './runtime.js';

/**
 * Real PostgreSQL proof for the group administration, presence and publication
 * paths F6 added.
 *
 * Every guard here is a race, not a shape: the last administrator survives only
 * because two concurrent demotions serialize on the membership lock, and a
 * retried publication takes one sequence only because the receipt claim commits
 * before the statement that completes it. A scripted `SqlClient` shows the SQL
 * that intends those properties and nothing about whether they hold.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';

describeIntegration('durable group administration against real PostgreSQL', () => {
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
    'renames a group once however many times its request is retried',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const requestId = `rename-${uniqueSuffix()}`;

      const first = await runtime.updateGroup(owner.authenticated, owner.groupId, 'Штаб-1', {
        requestId,
      });
      const retry = await runtime.updateGroup(owner.authenticated, owner.groupId, 'Штаб-1', {
        requestId,
      });

      expect(first.group.name).toBe('Штаб-1');
      expect(retry.group.revision).toBe(first.group.revision);
      const stored = await database.query<{ name: string; revision: string }>({
        text: 'SELECT name, revision::text AS revision FROM groups WHERE id = $1',
        values: [owner.groupId],
      });
      expect(stored[0]?.name).toBe('Штаб-1');
      // The retry bumped nothing: the group is still at the revision the first
      // rename produced.
      expect(BigInt(stored[0]?.revision ?? '0')).toBe(first.group.revision);
    },
    networkTimeoutMs,
  );

  it(
    'reports exactly one of two racing copies of a request as the mutation that ran',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const requestId = `rename-race-${uniqueSuffix()}`;
      const rename = (): Promise<{ readonly replayed: boolean; readonly group: PairedGroup }> =>
        runtime.updateGroup(owner.authenticated, owner.groupId, 'Штаб-гонка', { requestId });

      // Two copies of one request in flight at once — what a client with a
      // timeout actually produces. Measured rather than assumed: the unique
      // index on `(scope, request_id_hash)` blocks the second claim until the
      // first has committed, and by the time it proceeds the mutation has
      // completed the receipt, so the loser is refused before it issues a
      // statement at all. The statement's own gate covers the narrower
      // interleaving where the second claim lands first; nothing here reaches
      // it. Either way exactly one of the two ran, and that is what the
      // announcement reads.
      const [first, second] = await Promise.all([rename(), rename()]);

      expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
      expect(second.group.revision).toBe(first.group.revision);
      const stored = await database.query<{ revision: string }>({
        text: 'SELECT revision::text AS revision FROM groups WHERE id = $1',
        values: [owner.groupId],
      });
      // One rename, one revision: the race changed nothing about how often the
      // group moved, only about which of the two calls moved it.
      expect(BigInt(stored[0]?.revision ?? '0')).toBe(first.group.revision);
    },
    networkTimeoutMs,
  );

  it(
    'refuses one request identifier reused for a different rename',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const requestId = `rename-${uniqueSuffix()}`;

      await runtime.updateGroup(owner.authenticated, owner.groupId, 'Штаб-1', { requestId });

      await expect(
        runtime.updateGroup(owner.authenticated, owner.groupId, 'Штаб-2', { requestId }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ALREADY_EXISTS' });
    },
    networkTimeoutMs,
  );

  it(
    'keeps one administrator when two concurrent demotions race',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const second = await pairDevice(runtime, owner);
      const promoted = await runtime.setDeviceRole(
        owner.authenticated,
        owner.groupId,
        second.deviceId,
        'ADMIN',
      );
      expect(promoted.device.role).toBe('ADMIN');
      const secondAuthenticated = await runtime.authenticateAccessToken(second.accessToken);

      // Each administrator tries to demote the other at the same instant. Only
      // the membership lock stops both from succeeding and leaving zero.
      const outcomes = await Promise.allSettled([
        runtime.setDeviceRole(owner.authenticated, owner.groupId, second.deviceId, 'VIEWER'),
        runtime.setDeviceRole(
          secondAuthenticated,
          owner.groupId,
          owner.authenticated.device.id,
          'VIEWER',
        ),
      ]);

      const admins = await database.query<{ n: number }>({
        text: `SELECT count(*)::int AS n FROM group_memberships
               WHERE group_id = $1 AND role = 'ADMIN' AND revoked_at IS NULL`,
        values: [owner.groupId],
      });
      expect(admins[0]?.n).toBe(1);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    },
    networkTimeoutMs,
  );

  it(
    'moves a group between multi-authority and leader authority',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);

      // `createGroup` starts a group under leader authority with its founding
      // device as leader, so the round trip has to begin by leaving it.
      const opened = await runtime.setAuthorityMode(
        owner.authenticated,
        owner.groupId,
        'MULTI_AUTHORITY',
      );
      expect(opened.group.authorityMode).toBe('MULTI_AUTHORITY');

      const closed = await runtime.setAuthorityMode(owner.authenticated, owner.groupId, 'LEADER');
      expect(closed.group.authorityMode).toBe('LEADER');
      expect(closed.group.leaderDeviceId).toBe(owner.authenticated.device.id);
      expect(closed.group.revision).toBe(opened.group.revision + 1n);
    },
    networkTimeoutMs,
  );

  it(
    'refuses leader authority while the named leader holds no active membership',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const second = await pairDevice(runtime, owner);
      await runtime.setDeviceRole(owner.authenticated, owner.groupId, second.deviceId, 'ADMIN');
      // `groups_leader_membership_fk` requires the membership row to exist but
      // says nothing about `revoked_at`, so this state is one the schema
      // permits even though no RPC produces it. The guard exists for exactly
      // that gap, and the only way to reach it is to write the row directly.
      await database.query({
        text: `UPDATE group_memberships SET revoked_at = now()
               WHERE group_id = $1 AND device_id = $2`,
        values: [owner.groupId, owner.authenticated.device.id],
      });
      const secondAuthenticated = await runtime.authenticateAccessToken(second.accessToken);
      await runtime.setAuthorityMode(secondAuthenticated, owner.groupId, 'MULTI_AUTHORITY');
      const before = await database.query<{ revision: string }>({
        text: 'SELECT revision::text AS revision FROM groups WHERE id = $1',
        values: [owner.groupId],
      });

      await expect(
        runtime.setAuthorityMode(secondAuthenticated, owner.groupId, 'LEADER'),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'FAILED_PRECONDITION',
      });
      const unchanged = await database.query<{ authority_mode: string; revision: string }>({
        text: 'SELECT authority_mode, revision::text AS revision FROM groups WHERE id = $1',
        values: [owner.groupId],
      });
      expect(unchanged[0]?.authority_mode).toBe('MULTI_AUTHORITY');
      // Nothing was written at all: a refused mutation must not consume a
      // revision either.
      expect(unchanged[0]?.revision).toBe(before[0]?.revision);
    },
    networkTimeoutMs,
  );

  it(
    'refuses leadership for a device that is not an active member',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const stranger = await bootstrapGroup(runtime);

      await expect(
        runtime.setLeader(owner.authenticated, owner.groupId, stranger.authenticated.device.id),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'FAILED_PRECONDITION',
      });
    },
    networkTimeoutMs,
  );

  it(
    'refuses demotion of the leader while the group runs on leader authority',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const second = await pairDevice(runtime, owner);
      await runtime.setDeviceRole(owner.authenticated, owner.groupId, second.deviceId, 'ADMIN');
      await runtime.setLeader(owner.authenticated, owner.groupId, second.deviceId);
      await runtime.setAuthorityMode(owner.authenticated, owner.groupId, 'LEADER');

      await expect(
        runtime.setDeviceRole(owner.authenticated, owner.groupId, second.deviceId, 'VIEWER'),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'FAILED_PRECONDITION',
      });
      const role = await database.query<{ role: string }>({
        text: 'SELECT role FROM group_memberships WHERE group_id = $1 AND device_id = $2',
        values: [owner.groupId, second.deviceId],
      });
      expect(role[0]?.role).toBe('ADMIN');
    },
    networkTimeoutMs,
  );

  it(
    'appends one event however many times a publication is retried',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const events = new DurableRealtimeEventStore({
        database,
        receipts: runtime.receiptGuard,
      });
      const requestId = `publish-${uniqueSuffix()}`;
      const documentId = crypto.randomUUID();

      const first = await events.appendAuthorized(
        {
          groupId: owner.groupId,
          actorDeviceId: owner.authenticated.device.id,
          kind: syncV1.GroupEventKind.DOCUMENT_DELTA,
          documentId,
          documentType: syncV1.SynchronizedDocumentType.LAYOUT,
          documentDelta: Uint8Array.from([1, 2, 3]),
          stateVector: Uint8Array.from([9]),
        },
        { requestId },
      );
      const retry = await events.appendAuthorized(
        {
          groupId: owner.groupId,
          actorDeviceId: owner.authenticated.device.id,
          kind: syncV1.GroupEventKind.DOCUMENT_DELTA,
          documentId,
          documentType: syncV1.SynchronizedDocumentType.LAYOUT,
          documentDelta: Uint8Array.from([1, 2, 3]),
          stateVector: Uint8Array.from([9]),
        },
        { requestId },
      );

      expect(retry.event.sequence).toBe(first.event.sequence);
      const stored = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM sync_events WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(stored[0]?.n).toBe(1);
      const snapshots = await database.query<{ n: number; document_type: string }>({
        text: `SELECT count(*)::int AS n, max(document_type) AS document_type
               FROM sync_snapshots WHERE group_id = $1`,
        values: [owner.groupId],
      });
      expect(snapshots[0]?.n).toBe(1);
      expect(snapshots[0]?.document_type).toBe('LAYOUT');
    },
    networkTimeoutMs,
  );

  it(
    'replays a publication with its author, its clock and its snapshot',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const events = new DurableRealtimeEventStore({ database });
      const documentId = crypto.randomUUID();

      await events.appendAuthorized({
        groupId: owner.groupId,
        actorDeviceId: owner.authenticated.device.id,
        kind: syncV1.GroupEventKind.DOCUMENT_DELTA,
        documentId,
        documentType: syncV1.SynchronizedDocumentType.SETTINGS,
        documentDelta: Uint8Array.from([7, 7, 7]),
        stateVector: Uint8Array.from([4, 2]),
        hybridLogicalClock: 1234n,
      });

      const replay = await events.replay({
        groupId: owner.groupId,
        afterSequence: 0n,
        limit: 10,
      });
      const event = replay.events[0];
      expect(event?.actorDeviceId?.value).toBe(owner.authenticated.device.id);
      expect(event?.hybridLogicalClock).toBe(1234n);
      expect(event?.documentId?.value).toBe(documentId);

      const snapshot = await events.readDocumentSnapshot(owner.groupId, documentId);
      expect(snapshot?.sequence).toBe(1n);
      expect(snapshot?.documentType).toBe(syncV1.SynchronizedDocumentType.SETTINGS);
      expect([...(snapshot?.stateVector ?? [])]).toEqual([4, 2]);
    },
    networkTimeoutMs,
  );

  it(
    'refuses a publication from a viewer and writes nothing',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const viewer = await pairDevice(runtime, owner, 'VIEWER');
      const events = new DurableRealtimeEventStore({
        database,
        receipts: runtime.receiptGuard,
      });

      await expect(
        events.appendAuthorized({
          groupId: owner.groupId,
          actorDeviceId: viewer.deviceId,
          kind: syncV1.GroupEventKind.SESSION_COMMAND,
        }),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'PERMISSION_DENIED',
      });
      const stored = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM sync_events WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(stored[0]?.n).toBe(0);
    },
    networkTimeoutMs,
  );

  it(
    'records presence only for active members and drops a revoked one from the list',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const second = await pairDevice(runtime, owner);
      const presence = new DurablePresenceStore({ database });

      await presence.record({
        groupId: owner.groupId,
        deviceId: owner.authenticated.device.id,
        status: 'ONLINE',
        activeScreen: '/overview',
      });
      await presence.record({
        groupId: owner.groupId,
        deviceId: second.deviceId,
        status: 'ONLINE',
      });
      expect(await presence.list(owner.groupId)).toHaveLength(2);

      await runtime.revokeDevice(owner.authenticated, owner.groupId, second.deviceId);

      const remaining = await presence.list(owner.groupId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.deviceId).toBe(owner.authenticated.device.id);
      expect(remaining[0]?.activeScreen).toBe('/overview');

      await expect(
        presence.record({
          groupId: owner.groupId,
          deviceId: second.deviceId,
          status: 'ONLINE',
        }),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'PERMISSION_DENIED',
      });
    },
    networkTimeoutMs,
  );

  it(
    'updates a reported screen in place, and reports nothing for a device the group no longer has',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const second = await pairDevice(runtime, owner);
      const presence = new DurablePresenceStore({ database });
      await presence.record({
        groupId: owner.groupId,
        deviceId: owner.authenticated.device.id,
        status: 'ONLINE',
        activeScreen: '/overview',
        latencyMs: 40,
      });
      await presence.record({
        groupId: owner.groupId,
        deviceId: second.deviceId,
        status: 'ONLINE',
        activeScreen: '/overview',
      });

      const reported = await presence.reportDetail({
        groupId: owner.groupId,
        deviceId: owner.authenticated.device.id,
        activeScreen: '/materials',
        selectedElement: 'case-12',
        clockOffsetMs: -34n,
        latencyMs: 11,
      });

      // The four columns the table has carried since the first migration, now
      // written by something other than a join, and read back from the row
      // rather than from the value the store returned.
      expect(reported).toMatchObject({
        activeScreen: '/materials',
        selectedElement: 'case-12',
        clockOffsetMs: -34n,
        latencyMs: 11,
      });
      const stored = await database.query<{
        status: string;
        active_screen: string;
        selected_element: string;
        clock_offset_ms: string;
        latency_ms: number;
      }>({
        text: `SELECT status, active_screen, selected_element,
                      clock_offset_ms::text AS clock_offset_ms, latency_ms
                 FROM presence_snapshots WHERE group_id = $1 AND device_id = $2`,
        values: [owner.groupId, owner.authenticated.device.id],
      });
      expect(stored[0]).toEqual({
        // Untouched by the report: joining and leaving are the only two things
        // that move it, and a report that could set it would be a third way
        // into the session.
        status: 'ONLINE',
        active_screen: '/materials',
        selected_element: 'case-12',
        clock_offset_ms: '-34',
        latency_ms: 11,
      });

      await runtime.revokeDevice(owner.authenticated, owner.groupId, second.deviceId);
      const afterRevocation = await presence.reportDetail({
        groupId: owner.groupId,
        deviceId: second.deviceId,
        activeScreen: '/materials',
        selectedElement: '',
        clockOffsetMs: 0n,
        latencyMs: 5,
      });

      // The membership join inside the statement is what refuses it, so the
      // check cannot be stale by the time the row is written; a revoked device
      // holding a token that outlived its membership updates nothing.
      expect(afterRevocation).toBeUndefined();
      const revokedRow = await database.query<{ active_screen: string }>({
        text: 'SELECT active_screen FROM presence_snapshots WHERE group_id = $1 AND device_id = $2',
        values: [owner.groupId, second.deviceId],
      });
      expect(revokedRow[0]?.active_screen).toBe('/overview');

      // And a device with no presence row at all gets none: the statement is an
      // `UPDATE`, so there is nothing for it to insert.
      const third = await pairDevice(runtime, owner);
      expect(
        await presence.reportDetail({
          groupId: owner.groupId,
          deviceId: third.deviceId,
          activeScreen: '/system',
          selectedElement: '',
          clockOffsetMs: 0n,
          latencyMs: 5,
        }),
      ).toBeUndefined();
      const rows = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM presence_snapshots WHERE group_id = $1 AND device_id = $2',
        values: [owner.groupId, third.deviceId],
      });
      expect(rows[0]?.n).toBe(0);
    },
    networkTimeoutMs,
  );

  it(
    'removes a group’s events, allocator and presence when the group is deleted',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const events = new DurableRealtimeEventStore({ database });
      const presence = new DurablePresenceStore({ database });
      await events.append({ groupId: owner.groupId, kind: syncV1.GroupEventKind.GROUP_UPDATED });
      await presence.record({
        groupId: owner.groupId,
        deviceId: owner.authenticated.device.id,
        status: 'ONLINE',
      });

      await database.query({ text: 'DELETE FROM groups WHERE id = $1', values: [owner.groupId] });

      const counts = await database.query<{ events: number; allocator: number; presence: number }>({
        text: `SELECT
                 (SELECT count(*)::int FROM sync_events WHERE group_id = $1) AS events,
                 (SELECT count(*)::int FROM group_event_sequences WHERE group_id = $1) AS allocator,
                 (SELECT count(*)::int FROM presence_snapshots WHERE group_id = $1) AS presence`,
        values: [owner.groupId],
      });
      expect(counts[0]).toEqual({ events: 0, allocator: 0, presence: 0 });
    },
    networkTimeoutMs,
  );

  function createRuntime(): DurablePairedDeviceRuntime {
    return new DurablePairedDeviceRuntime({ database, tokenPepper });
  }

  async function bootstrapGroup(runtime: DurablePairedDeviceRuntime): Promise<{
    readonly groupId: string;
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
      authenticated: await runtime.authenticateAccessToken(created.session.accessToken),
    };
  }

  async function pairDevice(
    runtime: DurablePairedDeviceRuntime,
    owner: { readonly groupId: string; readonly authenticated: AuthenticatedDevice },
    role: 'EDITOR' | 'VIEWER' = 'EDITOR',
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

function uniqueSuffix(): string {
  return randomBytes(8).toString('hex');
}
