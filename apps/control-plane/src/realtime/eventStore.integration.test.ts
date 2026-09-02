import { randomBytes } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import { syncV1 } from '@gremuchaya/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { DurablePairedDeviceRuntime } from '../sync/durable-runtime.js';

import { DurableRealtimeEventStore } from './eventStore.js';
import { InProcessFanoutBus } from './fanout.js';
import { RealtimeHub } from './hub.js';

/**
 * Real PostgreSQL proof for the durable realtime event store.
 *
 * The store exists to answer one question a process `Map` could not: what does
 * a client that reconnects to a *different* control-plane process get back.
 * A scripted `SqlClient` cannot answer it either — it can show the shape of the
 * allocating statement but not that the statement's row lock actually
 * serializes two simultaneous publishes, which is the whole reason the
 * allocator is a table and not `MAX(sequence) + 1`.
 *
 * Opt-in on `HQ_CONTROL_PLANE_TEST_DATABASE_URL`, like every destructive suite
 * in this package.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';

describeIntegration('durable realtime event store against real PostgreSQL', () => {
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
    'answers a resume from a process that never held the events',
    async () => {
      const groupId = await bootstrapGroup();
      const writer = new DurableRealtimeEventStore({ database });

      await writer.append({ groupId, kind: syncV1.GroupEventKind.DOCUMENT_DELTA });
      await writer.append({
        groupId,
        kind: syncV1.GroupEventKind.SESSION_COMMAND,
        sessionCommand: create(syncV1.SessionCommandSchema, {
          action: syncV1.SessionCommandAction.SEEK,
          positionSeconds: 12.5,
          target: 'video:primary',
        }),
      });

      // A second store shares nothing with the first but the database. This is
      // the restarted control plane the in-memory history could not survive.
      const reader = new DurableRealtimeEventStore({ database });
      const replay = await reader.replay({ groupId, afterSequence: 0n, limit: 100 });

      expect(replay.events.map((event) => event.sequence)).toEqual([1n, 2n]);
      expect(replay.earliestSequence).toBe(1n);
      const [, second] = replay.events;
      expect(second?.kind).toBe(syncV1.GroupEventKind.SESSION_COMMAND);
      expect(second?.sessionCommand?.positionSeconds).toBe(12.5);
      expect(second?.sessionCommand?.target).toBe('video:primary');
      expect(second?.occurredAt).toBeDefined();
    },
    networkTimeoutMs,
  );

  it(
    'allocates one gapless sequence per group under simultaneous publishes',
    async () => {
      const groupId = await bootstrapGroup();
      const store = new DurableRealtimeEventStore({ database });

      const concurrency = 12;
      const appended = await Promise.all(
        Array.from({ length: concurrency }, () =>
          store.append({ groupId, kind: syncV1.GroupEventKind.DOCUMENT_DELTA }),
        ),
      );

      const sequences = appended.map((event) => event.sequence).sort((a, b) => (a < b ? -1 : 1));
      expect(sequences).toEqual(
        Array.from({ length: concurrency }, (_unused, index) => BigInt(index + 1)),
      );

      const stored = await database.query<{ n: number; distinct_n: number }>({
        text: `SELECT count(*)::int AS n, count(DISTINCT sequence)::int AS distinct_n
               FROM sync_events WHERE group_id = $1`,
        values: [groupId],
      });
      expect(stored[0]?.n).toBe(concurrency);
      expect(stored[0]?.distinct_n).toBe(concurrency);
    },
    networkTimeoutMs,
  );

  it(
    'prunes past its retention window and reports the edge a resume falls off',
    async () => {
      const groupId = await bootstrapGroup();
      const store = new DurableRealtimeEventStore({ database, historyLimit: 3 });

      for (let index = 0; index < 6; index += 1) {
        await store.append({ groupId, kind: syncV1.GroupEventKind.DOCUMENT_DELTA });
      }

      const replay = await store.replay({ groupId, afterSequence: 0n, limit: 100 });
      expect(replay.earliestSequence).toBe(4n);
      expect(replay.events.map((event) => event.sequence)).toEqual([4n, 5n, 6n]);

      const rows = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM sync_events WHERE group_id = $1',
        values: [groupId],
      });
      expect(rows[0]?.n).toBe(3);
    },
    networkTimeoutMs,
  );

  it(
    'keeps one group out of another group’s replay and allocator',
    async () => {
      const first = await bootstrapGroup();
      const second = await bootstrapGroup();
      const store = new DurableRealtimeEventStore({ database });

      await store.append({ groupId: first, kind: syncV1.GroupEventKind.DOCUMENT_DELTA });
      await store.append({ groupId: first, kind: syncV1.GroupEventKind.DOCUMENT_DELTA });
      const other = await store.append({
        groupId: second,
        kind: syncV1.GroupEventKind.PRESENCE_UPDATED,
      });

      expect(other.sequence).toBe(1n);
      const replay = await store.replay({ groupId: second, afterSequence: 0n, limit: 100 });
      expect(replay.events).toHaveLength(1);
      expect(replay.events[0]?.kind).toBe(syncV1.GroupEventKind.PRESENCE_UPDATED);
    },
    networkTimeoutMs,
  );

  it(
    'delivers a durable publication live to a subscriber and again on reconnect',
    async () => {
      const groupId = await bootstrapGroup();
      const hub = new RealtimeHub({ store: new DurableRealtimeEventStore({ database }) });
      const live: bigint[] = [];
      const unsubscribe = await hub.subscribe({
        groupId,
        afterSequence: 0n,
        connectionId: 'connection-live',
        send: (frame) => {
          if (frame.payload.case === 'groupEvent' && frame.payload.value.event !== undefined) {
            live.push(frame.payload.value.event.sequence);
          }
        },
      });

      await hub.publish({ groupId, kind: syncV1.GroupEventKind.GROUP_UPDATED });
      unsubscribe();

      const replayed: bigint[] = [];
      await hub.subscribe({
        groupId,
        afterSequence: 0n,
        connectionId: 'connection-reconnect',
        send: (frame) => {
          if (frame.payload.case === 'groupEvent' && frame.payload.value.event !== undefined) {
            replayed.push(frame.payload.value.event.sequence);
          }
        },
      });

      expect(live).toEqual([1n]);
      expect(replayed).toEqual([1n]);
    },
    networkTimeoutMs,
  );

  it(
    'pushes one process’s publication to the other process’s socket over the carrier',
    async () => {
      const groupId = await bootstrapGroup();
      // Two hubs, two stores, one database, one channel. This is the two
      // replicas `compose.yaml` refused to allow: before the carrier existed
      // the second hub's socket saw nothing the first hub published, and
      // `deploy.replicas: 1` was the only thing keeping that from happening in
      // production.
      const bus = new InProcessFanoutBus();
      const publisher = new RealtimeHub({
        store: new DurableRealtimeEventStore({ database }),
        fanout: bus.join('process-a'),
      });
      const subscriber = new RealtimeHub({
        store: new DurableRealtimeEventStore({ database }),
        fanout: bus.join('process-b'),
      });

      const received: bigint[] = [];
      await subscriber.subscribe({
        groupId,
        afterSequence: 0n,
        connectionId: 'connection-on-the-other-process',
        send: (frame) => {
          if (frame.payload.case === 'groupEvent' && frame.payload.value.event !== undefined) {
            received.push(frame.payload.value.event.sequence);
          }
        },
      });

      await publisher.publish({
        groupId,
        kind: syncV1.GroupEventKind.SESSION_COMMAND,
        sessionCommand: create(syncV1.SessionCommandSchema, {
          action: syncV1.SessionCommandAction.PLAY,
          target: 'video:primary',
        }),
      });
      await publisher.publish({ groupId, kind: syncV1.GroupEventKind.GROUP_UPDATED });
      await subscriber.whenFanoutIdle();

      // Delivered in the order the allocator assigned, and once each: the
      // announcement carries only a sequence, so what the socket received is
      // what `sync_events` holds and nothing the channel invented.
      expect(received).toEqual([1n, 2n]);

      const rows = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM sync_events WHERE group_id = $1',
        values: [groupId],
      });
      expect(rows[0]?.n).toBe(2);

      await Promise.all([publisher.close(), subscriber.close()]);
    },
    networkTimeoutMs,
  );

  it(
    'serves a group only to the process that holds a socket for it',
    async () => {
      const watched = await bootstrapGroup();
      const unwatched = await bootstrapGroup();
      const bus = new InProcessFanoutBus();
      const publisher = new RealtimeHub({
        store: new DurableRealtimeEventStore({ database }),
        fanout: bus.join('process-a'),
      });
      const subscriber = new RealtimeHub({
        store: new DurableRealtimeEventStore({ database }),
        fanout: bus.join('process-b'),
      });

      const received: bigint[] = [];
      await subscriber.subscribe({
        groupId: watched,
        afterSequence: 0n,
        connectionId: 'connection-on-the-other-process',
        send: (frame) => {
          if (frame.payload.case === 'groupEvent' && frame.payload.value.event !== undefined) {
            received.push(frame.payload.value.event.sequence);
          }
        },
      });

      // One deployment-wide channel means every process hears about every
      // group. Nothing may cross from a group this process has no audience for.
      await publisher.publish({ groupId: unwatched, kind: syncV1.GroupEventKind.GROUP_UPDATED });
      await publisher.publish({ groupId: watched, kind: syncV1.GroupEventKind.GROUP_UPDATED });
      await subscriber.whenFanoutIdle();

      expect(received).toEqual([1n]);

      await Promise.all([publisher.close(), subscriber.close()]);
    },
    networkTimeoutMs,
  );

  async function bootstrapGroup(): Promise<string> {
    const runtime = new DurablePairedDeviceRuntime({ database, tokenPepper });
    const created = await runtime.createGroup({
      name: `Realtime ${randomBytes(4).toString('hex')}`,
      initialDevice: {
        name: 'HQ primary',
        publicKey: `ed25519:${randomBytes(8).toString('hex')}`,
        platform: 'windows',
        applicationVersion: '0.1.0',
      },
    });
    return created.group.id;
  }
});
