import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Code, createClient, type Client } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { SyncService, syncV1 } from '@gremuchaya/protocol';
import type { realtimeV1 } from '@gremuchaya/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ControlPlaneAuthConfig } from '../config.js';
import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { DurableRealtimeEventStore } from '../realtime/eventStore.js';
import { RealtimeHub } from '../realtime/hub.js';
import { resyncRequiredReason } from '../realtime/replayDecision.js';
import { startControlPlane } from '../server.js';

/**
 * Real PostgreSQL proof for `ReadGroupEvents`, the polling half of the group
 * log.
 *
 * Nothing here can be shown against a scripted `SqlClient`. Whether a page is
 * ordered and gapless is a property of the statement the store issues; whether
 * `has_more` is true is a property of what the table still holds after the page
 * ends; and whether the poll and the socket agree about a cursor that fell off
 * the retention window is a property of one log read twice, once through each
 * transport. The suite runs the real router over binary gRPC-Web for the same
 * reason: a handler that works and is never registered looks identical from
 * inside the process.
 *
 * Opt-in on `HQ_CONTROL_PLANE_TEST_DATABASE_URL`, like every destructive suite
 * in this package.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const bootstrapSecret = 'read-events-bootstrap-secret-with-at-least-thirty-two-characters';
const tokenPepper = 'read-events-token-pepper-with-at-least-thirty-two-characters';

describeIntegration('ReadGroupEvents against real PostgreSQL', () => {
  const pool = new DisposableDatabasePool(testDatabaseUrl ?? '');
  let database: SqlClient;
  let sync: Client<typeof SyncService>;
  let closeControlPlane: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    database = await pool.create();
    await runMigrations(database);
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
    sync = createClient(
      SyncService,
      createGrpcWebTransport({
        baseUrl: `http://127.0.0.1:${address.port}`,
        useBinaryFormat: true,
      }),
    );
  }, networkTimeoutMs);

  afterAll(async () => {
    await closeControlPlane?.();
    await pool.dropAll();
  }, networkTimeoutMs);

  it(
    'pages the log in ascending order and says whether anything follows',
    async () => {
      const owner = await bootstrapGroup('paging');
      await publishDeltas(owner, 5);

      const first = await readPage(owner, 0n, 2);
      const second = await readPage(owner, sequenceOf(first).at(-1) ?? 0n, 2);
      const third = await readPage(owner, sequenceOf(second).at(-1) ?? 0n, 2);

      expect(sequenceOf(first)).toEqual([1n, 2n]);
      expect(sequenceOf(second)).toEqual([3n, 4n]);
      // The last page is short, so nothing follows it and it must not claim
      // otherwise: a client that trusts `has_more` on a short page polls
      // forever.
      expect(sequenceOf(third)).toEqual([5n]);
      expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
      expect([first.resyncRequired, second.resyncRequired, third.resyncRequired]).toEqual([
        false,
        false,
        false,
      ]);
      expect([
        first.earliestAvailableSequence,
        second.earliestAvailableSequence,
        third.earliestAvailableSequence,
      ]).toEqual([1n, 1n, 1n]);

      const walked = [...sequenceOf(first), ...sequenceOf(second), ...sequenceOf(third)];
      expect(walked).toEqual([1n, 2n, 3n, 4n, 5n]);
      expect(
        walked.every((value, index) => index === 0 || value === (walked[index - 1] ?? 0n) + 1n),
      ).toBe(true);
    },
    networkTimeoutMs,
  );

  it(
    'reports no more when the last page is exactly as long as the limit',
    async () => {
      const owner = await bootstrapGroup('exact-page');
      await publishDeltas(owner, 4);

      const full = await readPage(owner, 2n, 2);

      // Four events, a cursor at two, a limit of two: the page comes back full
      // and is still the last one. `has_more` derived from the page length
      // alone would say `true` here and send the client round again.
      expect(sequenceOf(full)).toEqual([3n, 4n]);
      expect(full.hasMore).toBe(false);
    },
    networkTimeoutMs,
  );

  it(
    'answers an exhausted cursor with an empty page that claims no retention edge',
    async () => {
      const owner = await bootstrapGroup('exhausted');
      await publishDeltas(owner, 2);

      const exhausted = await readPage(owner, 2n, 10);

      expect(exhausted.events).toEqual([]);
      expect(exhausted.hasMore).toBe(false);
      expect(exhausted.resyncRequired).toBe(false);
      // Zero is not a sequence the allocator can ever hand out, so it reads as
      // "no edge reported" rather than as a claim about the log. Answering with
      // a real-looking number here would tell a current client its history
      // starts somewhere it does not.
      expect(exhausted.earliestAvailableSequence).toBe(0n);
    },
    networkTimeoutMs,
  );

  it(
    'answers a trimmed log with the same verdict and the same edge as the hub',
    async () => {
      const owner = await bootstrapGroup('trimmed');
      await publishDeltas(owner, 6);
      // The retention window moved past the first three events. This is what
      // pruning leaves behind, written directly so the test does not have to
      // publish five hundred events to reach the default limit.
      await database.query({
        text: 'DELETE FROM sync_events WHERE group_id = $1 AND sequence <= 3',
        values: [owner.groupId],
      });

      const stale = await readPage(owner, 0n, 10);
      const hubFrames = await subscribeThroughHub(owner.groupId, 0n);

      expect(stale.resyncRequired).toBe(true);
      expect(stale.events).toEqual([]);
      expect(stale.hasMore).toBe(false);
      expect(stale.earliestAvailableSequence).toBe(4n);
      // The socket reached the same verdict from the same rows: same edge, and
      // a `ResyncRequired` frame instead of a page. One rule, two transports.
      const resync = hubFrames.find((frame) => frame.payload.case === 'resyncRequired');
      expect(resync?.payload.case).toBe('resyncRequired');
      expect(resync?.payload.value).toMatchObject({
        requestedAfterSequence: 0n,
        earliestAvailableSequence: stale.earliestAvailableSequence,
        reason: resyncRequiredReason,
      });
      expect(hubFrames.some((frame) => frame.payload.case === 'groupEvent')).toBe(false);

      // One step inside the gap is still a gap: event 3 is gone, so a caller
      // that holds 2 cannot be caught up by any page. This pins the near side
      // of the boundary against a live log, the way the edge test pins the far
      // one.
      const justInside = await readPage(owner, 2n, 10);
      expect(justInside.resyncRequired).toBe(true);
      expect(justInside.earliestAvailableSequence).toBe(4n);

      // The same stale cursor over the streaming RPC, which turns the frame
      // into a code rather than a field.
      await expect(
        collectWatch(
          sync.watchGroup(
            { groupId: resourceId(owner.groupId), afterSequence: 0n },
            {
              headers: owner.headers,
            },
          ),
        ),
      ).rejects.toMatchObject({ code: Code.OutOfRange });
    },
    networkTimeoutMs,
  );

  it(
    'still serves a cursor sitting exactly on the retention edge, as the hub does',
    async () => {
      const owner = await bootstrapGroup('edge');
      await publishDeltas(owner, 6);
      await database.query({
        text: 'DELETE FROM sync_events WHERE group_id = $1 AND sequence <= 3',
        values: [owner.groupId],
      });

      // The caller holds 3 and wants everything above it. Event 4 is the oldest
      // retained one, so nothing between the cursor and the log was lost.
      const edge = await readPage(owner, 3n, 10);
      const hubFrames = await subscribeThroughHub(owner.groupId, 3n);

      expect(edge.resyncRequired).toBe(false);
      expect(sequenceOf(edge)).toEqual([4n, 5n, 6n]);
      expect(edge.earliestAvailableSequence).toBe(4n);
      expect(hubFrames.some((frame) => frame.payload.case === 'resyncRequired')).toBe(false);
      expect(
        hubFrames.flatMap((frame) =>
          frame.payload.case === 'groupEvent' && frame.payload.value.event !== undefined
            ? [frame.payload.value.event.sequence]
            : [],
        ),
      ).toEqual([4n, 5n, 6n]);
    },
    networkTimeoutMs,
  );

  it(
    'reads only for a device of the group, and for a viewer of it',
    async () => {
      const owner = await bootstrapGroup('authority');
      const other = await bootstrapGroup('authority-other');
      await publishDeltas(owner, 2);

      // A session names exactly one group. A valid token for another group is
      // the case that must not read this log.
      await expect(
        sync.readGroupEvents(
          { groupId: resourceId(owner.groupId), afterSequence: 0n, limit: 10 },
          { headers: other.headers },
        ),
      ).rejects.toMatchObject({ code: Code.PermissionDenied });

      await expect(
        sync.readGroupEvents({ groupId: resourceId(owner.groupId), afterSequence: 0n, limit: 10 }),
      ).rejects.toMatchObject({ code: Code.Unauthenticated });

      // Reading the log is not publishing to it: a viewer follows the group.
      const viewer = await pairDevice(owner, syncV1.DeviceRole.VIEWER);
      const read = await sync.readGroupEvents(
        { groupId: resourceId(owner.groupId), afterSequence: 0n, limit: 10 },
        { headers: viewer.headers },
      );
      expect(sequenceOf(read)).toEqual([1n, 2n]);
    },
    networkTimeoutMs,
  );

  it(
    'refuses a limit past the ceiling the replay already applies and reads zero as the default',
    async () => {
      const owner = await bootstrapGroup('limits');
      await publishDeltas(owner, 3);

      await expect(
        sync.readGroupEvents(
          { groupId: resourceId(owner.groupId), afterSequence: 0n, limit: 513 },
          { headers: owner.headers },
        ),
      ).rejects.toMatchObject({
        code: Code.InvalidArgument,
        message: expect.stringContaining('limit must be between 1 and 512'),
      });

      // Zero is the proto3 default for a client that expressed no preference,
      // so it means the server default rather than an empty page.
      const defaulted = await readPage(owner, 0n, 0);
      expect(sequenceOf(defaulted)).toEqual([1n, 2n, 3n]);
      expect(defaulted.hasMore).toBe(false);
    },
    networkTimeoutMs,
  );

  it(
    'keeps one group out of another group’s page',
    async () => {
      const first = await bootstrapGroup('isolation-first');
      const second = await bootstrapGroup('isolation-second');
      await publishDeltas(first, 3);
      await publishDeltas(second, 1);

      const page = await readPage(second, 0n, 10);

      expect(sequenceOf(page)).toEqual([1n]);
      expect(page.hasMore).toBe(false);
    },
    networkTimeoutMs,
  );

  interface Caller {
    readonly groupId: string;
    readonly headers: Record<string, string>;
  }

  async function bootstrapGroup(label: string): Promise<Caller> {
    const created = await sync.createGroup(
      {
        name: `Штаб ${label}`,
        initialDevice: {
          name: 'HQ primary',
          publicKey: `ed25519:${label}-${randomUUID()}`,
          platform: 'windows',
          applicationVersion: '0.1.0',
        },
      },
      { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
    );
    return {
      groupId: required(created.group?.id?.value, 'group id'),
      headers: { authorization: `Bearer ${required(created.session?.accessToken, 'token')}` },
    };
  }

  async function pairDevice(owner: Caller, role: syncV1.DeviceRole): Promise<Caller> {
    const grant = await sync.createPairingCode(
      {
        groupId: resourceId(owner.groupId),
        role,
        context: { requestId: `pair-${randomUUID()}` },
      },
      { headers: owner.headers },
    );
    const paired = await sync.pairDevice({
      pairingCode: required(grant.pairingCode?.code, 'pairing code'),
      deviceName: 'Follower',
      publicKey: `ed25519:follower-${randomUUID()}`,
      platform: 'windows',
      applicationVersion: '0.1.0',
      context: { requestId: `pair-device-${randomUUID()}` },
    });
    return {
      groupId: owner.groupId,
      headers: { authorization: `Bearer ${required(paired.session?.accessToken, 'token')}` },
    };
  }

  async function publishDeltas(caller: Caller, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await sync.publishDocumentDelta(
        {
          groupId: resourceId(caller.groupId),
          documentId: resourceId(randomUUID()),
          documentType: syncV1.SynchronizedDocumentType.LAYOUT,
          delta: Uint8Array.from([index + 1]),
          stateVector: Uint8Array.from([index + 1]),
          hybridLogicalClock: BigInt(index + 1),
          context: { requestId: `delta-${randomUUID()}` },
        },
        { headers: caller.headers },
      );
    }
  }

  function readPage(
    caller: Caller,
    afterSequence: bigint,
    limit: number,
  ): Promise<syncV1.ReadGroupEventsResponse> {
    return sync.readGroupEvents(
      { groupId: resourceId(caller.groupId), afterSequence, limit },
      { headers: caller.headers },
    );
  }

  /**
   * The socket's answer to the same resume, read off the same database.
   *
   * The streaming RPC turns a `ResyncRequired` frame into a status code and
   * drops the edge it carried, so the frame has to be observed where the hub
   * emits it. The store is a second instance over the same rows, which is
   * exactly the situation the comparison is about.
   */
  async function subscribeThroughHub(
    groupId: string,
    afterSequence: bigint,
  ): Promise<readonly realtimeV1.RealtimeServerFrame[]> {
    const hub = new RealtimeHub({ store: new DurableRealtimeEventStore({ database }) });
    const frames: realtimeV1.RealtimeServerFrame[] = [];
    const unsubscribe = await hub.subscribe({
      groupId,
      afterSequence,
      connectionId: `compare-${randomUUID()}`,
      send: (frame) => frames.push(frame),
    });
    unsubscribe();
    return frames;
  }
});

async function collectWatch(
  stream: AsyncIterable<syncV1.WatchGroupResponse>,
): Promise<readonly bigint[]> {
  const sequences: bigint[] = [];
  for await (const response of stream) {
    if (response.event !== undefined) sequences.push(response.event.sequence);
  }
  return sequences;
}

function sequenceOf(page: syncV1.ReadGroupEventsResponse): readonly bigint[] {
  return page.events.map((event) => event.sequence);
}

function resourceId(value: string) {
  return { value };
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

function required<Value>(value: Value | undefined, field: string): Value {
  if (value === undefined) throw new Error(`Expected ${field} in the response.`);
  return value;
}
