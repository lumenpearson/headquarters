import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from '../db/database.js';
import { PairedDeviceRuntimeError, type AuthenticatedDevice } from '../sync/runtime.js';

import { DurableConversionStore, boundedDetail, ladderVariantsFor } from './store.js';

/**
 * Statement-shape proof for the conversion queue.
 *
 * A scripted `SqlClient` records what the store issues and answers with rows it
 * then has to decode. It can show that every mutation is one parameterized
 * statement, that the locking and fencing clauses this queue's correctness
 * rests on are in the text, and that no value is interpolated into SQL.
 *
 * It cannot show that any of it works. Nothing here takes a row lock, skips a
 * locked row, or evaluates a unique index, so "two workers never take one job",
 * "a stale claim cannot overwrite a live one" and "queueing twice queues once"
 * are proved only by `conversion.integration.test.ts` and by the concurrency
 * scenario in `postgres.integration.test.ts`, against a real engine.
 */
const groupId = '018b2a02-0000-7000-8000-0000000000a1';
const deviceId = '018b2a02-0000-7000-8000-0000000000a2';
const materialId = '018b2a02-0000-7000-8000-0000000000b1';
const versionId = '018b2a02-0000-7000-8000-0000000000d1';
const jobId = '018b2a02-0000-7000-8000-0000000000e1';
const renditionId = '018b2a02-0000-7000-8000-0000000000e2';
const contentHash = '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a';
const now = new Date('2026-08-29T11:00:00.000Z');

describe('durable conversion store: producer', () => {
  it('queues the ladder in one statement, authorized by a membership join', async () => {
    const database = new ScriptedSqlClient([
      [{ member_active: true, version_present: true, queued: ['1080p', '480p', '720p'] }],
    ]);
    const store = createStore(database);

    const outcome = await store.enqueueRenditions(authenticated(), materialId, versionId, [
      '1080p',
      '720p',
      '480p',
    ]);

    expect(outcome.queued).toEqual(['1080p', '480p', '720p']);
    expect(database.transactions).toHaveLength(0);
    expect(database.queries).toHaveLength(1);
    const statement = database.queries[0];
    // Authorization is the join, not a separate check a later edit could omit.
    expect(statement?.text).toContain('JOIN active_member ON active_member.group_id');
    expect(statement?.text).toContain('AND membership.revoked_at IS NULL');
    expect(statement?.text).toContain("AND devices.status <> 'REVOKED'");
    // Work is never queued for content on its way out of the library.
    expect(statement?.text).toContain('AND material.trashed_at IS NULL');
    // Idempotence lives in the index, not in the caller's memory.
    expect(statement?.text).toContain('ON CONFLICT (version_id, kind) DO NOTHING');
    expect(statement?.text).toContain('INSERT INTO conversion_jobs');
  });

  it('carries every value as a bound parameter, interpolating none of them', async () => {
    const database = new ScriptedSqlClient([
      [{ member_active: true, version_present: true, queued: [] }],
    ]);
    const store = createStore(database);

    await store.enqueueRenditions(authenticated(), materialId, versionId, ['720p']);

    const statement = database.queries[0];
    expect(statement?.values).toEqual([
      groupId,
      deviceId,
      now,
      materialId,
      versionId,
      `{${renditionId}}`,
      '{"720p"}',
    ]);
    // The identifiers reach SQL only through $n; none of them appears in text.
    for (const value of [groupId, deviceId, materialId, versionId]) {
      expect(statement?.text).not.toContain(value);
    }
  });

  it('does not reach the database when there is nothing to queue', async () => {
    const database = new ScriptedSqlClient([]);
    const store = createStore(database);

    await expect(
      store.enqueueRenditions(authenticated(), materialId, versionId, ['', '   ']),
    ).resolves.toEqual({ queued: [] });
    expect(database.queries).toHaveLength(0);
  });

  it('refuses a revoked membership rather than queueing work for it', async () => {
    const database = new ScriptedSqlClient([
      [{ member_active: false, version_present: false, queued: [] }],
    ]);
    const store = createStore(database);

    await expect(
      store.enqueueRenditions(authenticated(), materialId, versionId, ['720p']),
    ).rejects.toBeInstanceOf(PairedDeviceRuntimeError);
  });

  it('reports a version it cannot reach as absent rather than as queued', async () => {
    const database = new ScriptedSqlClient([
      [{ member_active: true, version_present: false, queued: [] }],
    ]);
    const store = createStore(database);

    await expect(
      store.enqueueRenditions(authenticated(), materialId, versionId, ['720p']),
    ).rejects.toMatchObject({ message: 'The material version does not exist.' });
  });
});

describe('durable conversion store: claim', () => {
  it('claims one job with SKIP LOCKED and returns the source it must fetch', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          id: jobId,
          group_id: groupId,
          material_id: materialId,
          version_id: versionId,
          kind: '720p',
          attempt: 1,
          content_hash: contentHash,
          mime_type: 'video/mp4',
          byte_size: '104857600',
          storage_key: `materials/${groupId}/${contentHash}`,
        },
      ],
    ]);
    const store = createStore(database);

    const claim = await store.claimNextJob();

    expect(claim).toEqual({
      jobId,
      groupId,
      materialId,
      versionId,
      variant: '720p',
      attempt: 1,
      sourceStorageKey: `materials/${groupId}/${contentHash}`,
      sourceContentHash: contentHash,
      sourceMimeType: 'video/mp4',
      sourceByteSize: 104_857_600n,
    });
    const statement = database.queries[0];
    // Two workers polling at one instant must take two rows or one and none.
    expect(statement?.text).toContain('FOR UPDATE OF job SKIP LOCKED');
    expect(statement?.text).toContain('LIMIT 1');
    // The claim is the update: there is no read followed by a write.
    expect(statement?.text).toContain('UPDATE conversion_jobs AS job');
    expect(statement?.text).toContain('attempt = job.attempt + 1');
    expect(statement?.text).toContain("SET state = 'RUNNING'");
    // A lease that ran out is the only way a RUNNING job comes back.
    expect(statement?.text).toContain('job.lease_expires_at <= $1');
    expect(statement?.text).toContain('job.attempt < $3::int');
    // A job whose material is trashed or whose object is gone is not claimable.
    expect(statement?.text).toContain('WHERE material.trashed_at IS NULL');
    expect(statement?.text).toContain('JOIN material_objects AS object');
    expect(database.queries).toHaveLength(1);
  });

  it('sets a lease that expires exactly the configured span after the claim', async () => {
    const database = new ScriptedSqlClient([[]]);
    const store = createStore(database, { leaseMs: 90_000 });

    await store.claimNextJob();

    expect(database.queries[0]?.values).toEqual([now, new Date(now.getTime() + 90_000), 3]);
  });

  it('answers with nothing when no row was claimable', async () => {
    const store = createStore(new ScriptedSqlClient([[]]));
    await expect(store.claimNextJob()).resolves.toBeUndefined();
  });
});

describe('durable conversion store: completion and failure', () => {
  it('records the rendition and closes the job in one fenced statement', async () => {
    const database = new ScriptedSqlClient([[{ completed: true }]]);
    const store = createStore(database);

    const completed = await store.completeJob(claim(), {
      storageKey: `renditions/${groupId}/${contentHash}/720p.mp4`,
      mimeType: 'video/mp4',
      byteSize: 4_096n,
      width: 1280,
      height: 720,
    });

    expect(completed).toBe(true);
    expect(database.queries).toHaveLength(1);
    const statement = database.queries[0];
    // The attempt is the fence: a worker whose lease was taken over finds no
    // row and its completion changes nothing.
    expect(statement?.text).toContain('AND job.attempt = $2::int');
    expect(statement?.text).toContain("AND job.state = 'RUNNING'");
    expect(statement?.text).toContain('FOR UPDATE OF job');
    // Rendition and job state move together; the EXISTS reference is what
    // orders the two data-modifying CTEs.
    expect(statement?.text).toContain('INSERT INTO material_renditions');
    expect(statement?.text).toContain('ON CONFLICT (version_id, variant) DO UPDATE');
    expect(statement?.text).toContain('AND EXISTS (SELECT 1 FROM recorded)');
    expect(statement?.values?.[6]).toBe('4096');
  });

  it('reports a stale claim rather than overwriting a live worker s rendition', async () => {
    const store = createStore(new ScriptedSqlClient([[{ completed: false }]]));

    await expect(
      store.completeJob(claim(), {
        storageKey: 'renditions/x',
        mimeType: 'video/mp4',
        byteSize: 1n,
        width: 2,
        height: 2,
      }),
    ).resolves.toBe(false);
  });

  it('records the failure detail and lets the attempt ceiling decide the state', async () => {
    const database = new ScriptedSqlClient([[{ state: 'PENDING' }]]);
    const store = createStore(database);

    const state = await store.failJob(claim(), 'ffmpeg exited with 1: Invalid data found');

    expect(state).toBe('PENDING');
    const statement = database.queries[0];
    expect(statement?.text).toContain('WHEN locked_job.attempt >= $5::int');
    expect(statement?.values?.[3]).toBe('ffmpeg exited with 1: Invalid data found');
    expect(statement?.values?.[4]).toBe(3);
  });

  it('sends a failure a retry cannot change straight to FAILED', async () => {
    const database = new ScriptedSqlClient([[{ state: 'FAILED' }]]);
    const store = createStore(database);

    const state = await store.failJob(claim(), 'no rendition rung named 4k', true);

    expect(state).toBe('FAILED');
    // The ceiling drops to one, so `attempt >= 1` is always true.
    expect(database.queries[0]?.values?.[4]).toBe(1);
  });

  it('answers with nothing when the failing claim was already taken over', async () => {
    const store = createStore(new ScriptedSqlClient([[{ state: null }]]));
    await expect(store.failJob(claim(), 'anything')).resolves.toBeUndefined();
  });
});

describe('conversion detail bounding', () => {
  /*
   * The tail, not the head. ffmpeg prints its build configuration first and the
   * reason it stopped last, so keeping the first 500 characters would reliably
   * record the least useful part of every failure.
   */
  it('keeps the end of a long renderer message and bounds the row', () => {
    const detail = boundedDetail(`${'x'.repeat(900)} Invalid data found when processing input`);
    expect(detail).toHaveLength(500);
    expect(detail.startsWith('...')).toBe(true);
    expect(detail.endsWith('Invalid data found when processing input')).toBe(true);
  });

  it('collapses whitespace so a multi-line failure is one readable line', () => {
    expect(boundedDetail('first\n  second\t\tthird ')).toBe('first second third');
  });

  it('says so when the renderer said nothing', () => {
    expect(boundedDetail('   \n ')).toBe('the renderer reported no detail');
  });
});

describe('ladder variants', () => {
  it('names the rungs a version of that type should have', () => {
    expect(ladderVariantsFor('video/mp4')).toEqual(['1080p', '720p', '480p']);
    expect(ladderVariantsFor('application/zip')).toEqual([]);
  });
});

function createStore(
  database: SqlClient,
  options: { readonly leaseMs?: number } = {},
): DurableConversionStore {
  return new DurableConversionStore({
    database,
    now: () => now,
    newId: () => renditionId,
    maxAttempts: 3,
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
  });
}

function claim() {
  return {
    jobId,
    groupId,
    materialId,
    versionId,
    variant: '720p',
    attempt: 1,
    sourceStorageKey: `materials/${groupId}/${contentHash}`,
    sourceContentHash: contentHash,
    sourceMimeType: 'video/mp4',
    sourceByteSize: 1_024n,
  };
}

function authenticated(): AuthenticatedDevice {
  return {
    group: {
      id: groupId,
      name: 'Гремучая смесь',
      authorityMode: 'LEADER',
      leaderDeviceId: deviceId,
      revision: 1n,
      createdAt: now,
      updatedAt: now,
    },
    device: {
      id: deviceId,
      name: 'HQ primary',
      publicKey: 'ed25519:primary',
      role: 'EDITOR',
      status: 'ONLINE',
      platform: 'windows',
      applicationVersion: '0.1.0',
      createdAt: now,
      lastSeenAt: now,
    },
    role: 'EDITOR',
    sessionId: '018b2a02-0000-7000-8000-0000000000f1',
    accessTokenId: '018b2a02-0000-7000-8000-0000000000f2',
  };
}

class ScriptedSqlClient implements SqlClient {
  readonly queries: SqlStatement[] = [];
  readonly transactions: SqlStatement[][] = [];
  readonly #responses: Record<string, unknown>[][];

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

  transaction(statements: readonly SqlStatement[]): Promise<void> {
    this.transactions.push([...statements]);
    return Promise.resolve();
  }
}
