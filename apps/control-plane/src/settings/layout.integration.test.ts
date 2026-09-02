import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { DurablePairedDeviceRuntime } from '../sync/durable-runtime.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import { DurableLayoutStore, type LayoutTilePlacementInput } from './layout-store.js';

/**
 * Real PostgreSQL proof for `layout_documents` and `layout_versions`.
 *
 * Both tables were created by migration 0001 and reached by no code at all
 * until `PutLayoutDocument` — correction C32. This suite is what makes "reached"
 * mean something: every scenario here is a property a scripted `SqlClient`
 * cannot show. Two writers serializing on the document row; the
 * expected-revision predicate actually refusing the later of two concurrent
 * puts; `UNIQUE (document_id, revision)` actually rejecting a duplicate version;
 * the two partial unique indexes actually holding a group's and a device's
 * arrangement of one screen apart; a receipt actually refusing a second
 * execution; and the group cascade actually taking both tables with it.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';

const mapTile: LayoutTilePlacementInput = {
  tileId: 'sector-map',
  column: 0,
  row: 0,
  columnSpan: 2,
  rowSpan: 2,
  hidden: false,
};

describeIntegration('durable layout storage against real PostgreSQL', () => {
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
    'gives two concurrent unconditional puts consecutive revisions over one document row',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const second = await pairDevice(runtime, owner);

      const outcomes = await Promise.all([
        store.putDocument({
          actor: owner.actor,
          scope: owner.scope,
          screenId: 'wall-1',
          tiles: [mapTile],
          expectedRevision: 0n,
          correlationId: 'race-a',
        }),
        store.putDocument({
          actor: { groupId: owner.groupId, deviceId: second.deviceId },
          scope: owner.scope,
          screenId: 'wall-1',
          tiles: [{ ...mapTile, column: 4 }],
          expectedRevision: 0n,
          correlationId: 'race-b',
        }),
      ]);

      expect(outcomes.map((outcome) => outcome.revision).sort()).toEqual([1n, 2n]);
      const documents = await database.query<{ total: number }>({
        text: `SELECT count(*)::int AS total FROM layout_documents
               WHERE group_id = $1 AND screen_id = 'wall-1'`,
        values: [owner.groupId],
      });
      expect(documents[0]?.total).toBe(1);
      const versions = await database.query<{ total: number; distinct_revisions: number }>({
        text: `SELECT count(*)::int AS total, count(DISTINCT revision)::int AS distinct_revisions
               FROM layout_versions WHERE document_id = $1`,
        values: [outcomes[0]?.id ?? ''],
      });
      // Two version rows at two revisions: the unique index is what makes both
      // writers unable to claim the same one.
      expect(versions[0]).toEqual({ total: 2, distinct_revisions: 2 });
    },
    networkTimeoutMs,
  );

  it(
    'refuses the later of two concurrent puts that name the same expected revision',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const second = await pairDevice(runtime, owner);

      const seeded = await store.putDocument({
        actor: owner.actor,
        scope: owner.scope,
        screenId: 'wall-2',
        tiles: [mapTile],
        expectedRevision: 0n,
        correlationId: 'seed',
      });
      expect(seeded.revision).toBe(1n);

      // Both devices read revision 1 and both edit it. Exactly one may win:
      // the loser's arrangement was composed against a screen that has moved.
      const results = await Promise.allSettled([
        store.putDocument({
          actor: owner.actor,
          scope: owner.scope,
          screenId: 'wall-2',
          tiles: [{ ...mapTile, column: 1 }],
          expectedRevision: 1n,
          correlationId: 'compare-a',
        }),
        store.putDocument({
          actor: { groupId: owner.groupId, deviceId: second.deviceId },
          scope: owner.scope,
          screenId: 'wall-2',
          tiles: [{ ...mapTile, column: 2 }],
          expectedRevision: 1n,
          correlationId: 'compare-b',
        }),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined).toMatchObject({
        code: 'ABORTED',
      });

      const stored = await store.readDocument({
        actor: owner.actor,
        scope: owner.scope,
        screenId: 'wall-2',
      });
      expect(stored?.revision).toBe(2n);
      // The stored arrangement is the winner's, not a merge of both and not the
      // loser's overwriting it.
      const winner = fulfilled[0]?.status === 'fulfilled' ? fulfilled[0].value : undefined;
      expect(stored?.tiles).toEqual(winner?.tiles);

      const versions = await database.query<{ total: number }>({
        text: 'SELECT count(*)::int AS total FROM layout_versions WHERE document_id = $1',
        values: [seeded.id],
      });
      // The refused put wrote no version row either: the whole mutation is one
      // statement, so nothing of it survives its own refusal.
      expect(versions[0]?.total).toBe(2);
    },
    networkTimeoutMs,
  );

  it(
    'keeps a group arrangement and a device arrangement of one screen in separate rows',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);

      const group = await store.putDocument({
        actor: owner.actor,
        scope: owner.scope,
        screenId: 'wall-3',
        tiles: [mapTile],
        expectedRevision: 0n,
        correlationId: 'group',
      });
      const device = await store.putDocument({
        actor: owner.actor,
        scope: { kind: 'DEVICE', resourceId: owner.actor.deviceId },
        screenId: 'wall-3',
        tiles: [{ ...mapTile, hidden: true }],
        expectedRevision: 0n,
        correlationId: 'device',
      });

      expect(group.id).not.toBe(device.id);
      const rows = await database.query<{
        group_id: string | null;
        device_id: string | null;
      }>({
        text: `SELECT group_id, device_id FROM layout_documents
               WHERE screen_id = 'wall-3' ORDER BY group_id NULLS LAST`,
        values: [],
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.group_id).toBe(owner.groupId);
      expect(rows[0]?.device_id).toBeNull();
      // A device layout writes no group id, so it sits in exactly one of the
      // two partial unique indexes.
      expect(rows[1]?.group_id).toBeNull();
      expect(rows[1]?.device_id).toBe(owner.actor.deviceId);

      const readBack = await store.readDocument({
        actor: owner.actor,
        scope: owner.scope,
        screenId: 'wall-3',
      });
      expect(readBack?.tiles).toEqual([mapTile]);
    },
    networkTimeoutMs,
  );

  it(
    'answers a retried put from its receipt instead of writing a second revision',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const mutation = { requestId: `put-${uniqueSuffix()}` };

      const first = await store.putDocument({
        actor: owner.actor,
        scope: owner.scope,
        screenId: 'wall-4',
        tiles: [mapTile],
        expectedRevision: 0n,
        correlationId: 'once',
        mutation,
      });
      const retried = await store.putDocument({
        actor: owner.actor,
        scope: owner.scope,
        screenId: 'wall-4',
        tiles: [mapTile],
        expectedRevision: 0n,
        correlationId: 'once',
        mutation,
      });

      expect(retried.revision).toBe(first.revision);
      expect(retried.tiles).toEqual(first.tiles);
      const versions = await database.query<{ total: number }>({
        text: 'SELECT count(*)::int AS total FROM layout_versions WHERE document_id = $1',
        values: [first.id],
      });
      expect(versions[0]?.total).toBe(1);
    },
    networkTimeoutMs,
  );

  it(
    'refuses a revoked device even though its access token is still live',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const second = await pairDevice(runtime, owner);
      const actor = { groupId: owner.groupId, deviceId: second.deviceId };

      const before = await store.putDocument({
        actor,
        scope: owner.scope,
        screenId: 'wall-5',
        tiles: [mapTile],
        expectedRevision: 0n,
        correlationId: 'before-revocation',
      });
      expect(before.revision).toBe(1n);

      await runtime.revokeDevice(owner.authenticated, owner.groupId, second.deviceId);

      // The token this device holds has not expired. The membership join inside
      // the statement is the only thing that refuses it.
      await expect(
        store.putDocument({
          actor,
          scope: owner.scope,
          screenId: 'wall-5',
          tiles: [{ ...mapTile, column: 3 }],
          expectedRevision: 1n,
          correlationId: 'after-revocation',
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(
        store.readDocument({ actor, scope: owner.scope, screenId: 'wall-5' }),
      ).resolves.toBeUndefined();
    },
    networkTimeoutMs,
  );

  it(
    'pages the version log newest first and takes both tables with the group',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);

      for (const column of [0, 1, 2]) {
        await store.putDocument({
          actor: owner.actor,
          scope: owner.scope,
          screenId: 'wall-6',
          tiles: [{ ...mapTile, column }],
          expectedRevision: 0n,
          correlationId: `put-${column.toString()}`,
        });
      }

      const first = await store.listHistory({
        actor: owner.actor,
        scope: owner.scope,
        screenId: 'wall-6',
        pageSize: 2,
        cursor: '',
      });
      expect(first.entries.map((entry) => entry.revision)).toEqual([3n, 2n]);
      expect(first.hasMore).toBe(true);
      expect(first.entries[0]?.tiles).toEqual([{ ...mapTile, column: 2 }]);
      expect(first.entries[0]?.actorDeviceId).toBe(owner.actor.deviceId);

      const next = await store.listHistory({
        actor: owner.actor,
        scope: owner.scope,
        screenId: 'wall-6',
        pageSize: 2,
        cursor: first.nextCursor,
      });
      expect(next.entries.map((entry) => entry.revision)).toEqual([1n]);
      expect(next.hasMore).toBe(false);

      await database.query({ text: 'DELETE FROM groups WHERE id = $1', values: [owner.groupId] });
      const remaining = await database.query<{ documents: number; versions: number }>({
        text: `SELECT
                 (SELECT count(*)::int FROM layout_documents WHERE group_id = $1) AS documents,
                 (SELECT count(*)::int FROM layout_versions AS version
                  JOIN layout_documents AS document ON document.id = version.document_id
                  WHERE document.group_id = $1) AS versions`,
        values: [owner.groupId],
      });
      expect(remaining[0]).toEqual({ documents: 0, versions: 0 });
    },
    networkTimeoutMs,
  );

  function createRuntime(): DurablePairedDeviceRuntime {
    return new DurablePairedDeviceRuntime({ database, tokenPepper });
  }

  function createStore(runtime: DurablePairedDeviceRuntime): DurableLayoutStore {
    return new DurableLayoutStore({ database, receipts: runtime.receiptGuard });
  }

  async function bootstrapGroup(runtime: DurablePairedDeviceRuntime): Promise<{
    readonly groupId: string;
    readonly authenticated: AuthenticatedDevice;
    readonly actor: { readonly groupId: string; readonly deviceId: string };
    readonly scope: { readonly kind: 'GROUP'; readonly resourceId: string };
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
    const authenticated = await runtime.authenticateAccessToken(created.session.accessToken);
    return {
      groupId: created.group.id,
      authenticated,
      actor: { groupId: created.group.id, deviceId: created.device.id },
      scope: { kind: 'GROUP', resourceId: created.group.id },
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
