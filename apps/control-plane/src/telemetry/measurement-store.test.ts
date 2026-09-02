import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from '../db/database.js';

import { DurableTelemetryMeasurementStore } from './measurement-store.js';

/**
 * Structural proof for the telemetry measurement adapter.
 *
 * A scripted `SqlClient` records the statements and answers them from a list.
 * That shows three things and no more: the shape of each statement, what is
 * bound into it, and how a row is decoded. It shows nothing about whether the
 * allocator really serializes two concurrent captures, whether the prune really
 * takes the samples with the snapshot, or whether the membership join really
 * eliminates a row — those are properties of an engine, and they are proved in
 * `telemetry.integration.test.ts` against a live PostgreSQL.
 *
 * What this suite is for is the change detector: a capture that acquired a
 * second statement, a read that lost its membership re-check, or a filter that
 * stopped being a bound parameter would pass every behavioural test written
 * against a group of one device and fail here.
 */
const groupId = '018b2a02-0000-7000-8000-000000000001';
const deviceId = '018b2a02-0000-7000-8000-000000000002';
const otherDeviceId = '018b2a02-0000-7000-8000-000000000003';
const capturedAt = new Date('2026-08-29T09:00:00.000Z');

describe('durable telemetry measurement adapter', () => {
  it('lists the group’s sources through one membership-checked statement', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          member_active: true,
          target_present: true,
          approximate_total: '2',
          items: [sourceRow()],
        },
      ],
    ]);

    const page = await new DurableTelemetryMeasurementStore({ database }).listSources({
      groupId,
      deviceId,
      pageSize: 10,
      cursor: '',
    });

    expect(page.items).toEqual([
      {
        sourceKey: 'cpu.total',
        name: 'cpu.total',
        kind: 'CPU',
        unit: '%',
        simulated: true,
        labels: { profile: 'Смена', preset: 'CUSTOM' },
      },
    ]);
    expect(page.approximateTotal).toBe(2n);
    expect(database.queries).toHaveLength(1);
    expect(database.transactions).toHaveLength(0);

    const statement = requireStatement(database.queries, 0);
    // Authority is re-asked in SQL on every read, never carried from the caller.
    expect(statement.text).toContain('active_member AS');
    expect(statement.text).toContain("devices.status <> 'REVOKED'");
    expect(statement.text).toContain(
      'JOIN active_member ON active_member.group_id = source.group_id',
    );
    // One row per key, and the same row on every call: the order inside
    // DISTINCT ON is what makes two pages agree about one source.
    expect(statement.text).toContain('DISTINCT ON (source.source_key)');
    expect(statement.text).toContain('ORDER BY source.source_key ASC, source.profile_id ASC');
    expect(statement.values).toEqual([groupId, deviceId, null, null, 11]);
  });

  it('refuses a reader whose membership the statement did not find', async () => {
    const database = new ScriptedSqlClient([[{ member_active: false, target_present: true }]]);

    await expect(
      new DurableTelemetryMeasurementStore({ database }).listSources({
        groupId,
        deviceId,
        pageSize: 10,
        cursor: '',
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
  });

  it('tells a device of another group apart from a reader that lost its membership', async () => {
    const database = new ScriptedSqlClient([[{ member_active: true, target_present: false }]]);

    await expect(
      new DurableTelemetryMeasurementStore({ database }).listSources({
        groupId,
        deviceId,
        targetDeviceId: otherDeviceId,
        pageSize: 10,
        cursor: '',
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'NOT_FOUND' });
  });

  it('reads the sources, the previous readings and the newest snapshot together', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          member_active: true,
          target_present: true,
          latest: { sequence: '7', captured_at: capturedAt.toISOString() },
          sources: [
            {
              ...sourceRow(),
              channel_index: 1,
              profile: {},
              profile_updated_at: capturedAt.toISOString(),
            },
          ],
          previous: { 'cpu.total': 41.5 },
        },
      ],
    ]);

    const context = await new DurableTelemetryMeasurementStore({ database }).readCaptureContext({
      groupId,
      deviceId,
      sourceKeys: ['cpu.total'],
    });

    expect(context.latest).toEqual({ sequence: 7n, capturedAt });
    expect(context.sources[0]).toMatchObject({
      sourceKey: 'cpu.total',
      channelIndex: 1,
      previousValue: 41.5,
    });
    // One statement, because a reading computed from one profile against a
    // previous value read before another was published would smooth towards a
    // number no channel produced.
    expect(database.queries).toHaveLength(1);
    const statement = requireStatement(database.queries, 0);
    expect(statement.text).toContain(
      'JOIN simulation_profiles AS stored ON stored.id = source.profile_id',
    );
    // The source filter is a bound jsonb parameter, never interpolated text.
    expect(statement.text).toContain('SELECT jsonb_array_elements_text($4::jsonb)');
    expect(statement.values).toEqual([groupId, deviceId, null, '["cpu.total"]']);
  });

  it('reads every source when the request names none, and none when it names an unknown one', async () => {
    const database = new ScriptedSqlClient([
      [{ member_active: true, target_present: true, latest: null, sources: [], previous: {} }],
      [{ member_active: true, target_present: true, latest: null, sources: [], previous: {} }],
    ]);
    const store = new DurableTelemetryMeasurementStore({ database });

    const all = await store.readCaptureContext({ groupId, deviceId });
    const named = await store.readCaptureContext({ groupId, deviceId, sourceKeys: ['nothing'] });

    expect(all.latest).toBeUndefined();
    expect(named.sources).toEqual([]);
    // NULL means "every source"; a JSON array means "these", and an unknown key
    // therefore narrows the answer to nothing instead of widening it to all.
    expect(requireStatement(database.queries, 0).values?.[3]).toBeNull();
    expect(requireStatement(database.queries, 1).values?.[3]).toBe('["nothing"]');
  });

  it('allocates, records, writes and prunes a capture in one statement', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          member_active: true,
          snapshot: { group_id: groupId, sequence: '3', captured_at: capturedAt.toISOString() },
          samples: [
            {
              source_key: 'cpu.total',
              value: 61.25,
              unit: '%',
              severity: 'ELEVATED',
              observed_at: capturedAt.toISOString(),
              labels: { profile: 'Смена' },
            },
          ],
          pruned_count: '0',
        },
      ],
    ]);

    const recorded = await new DurableTelemetryMeasurementStore({
      database,
      retainedSnapshots: 5,
    }).record({
      groupId,
      deviceId,
      capturedAt,
      samples: [
        {
          sourceKey: 'cpu.total',
          value: 61.25,
          unit: '%',
          severity: 'ELEVATED',
          labels: { profile: 'Смена' },
        },
      ],
    });

    expect(recorded.sequence).toBe(3n);
    expect(recorded.samples[0]).toMatchObject({ sourceKey: 'cpu.total', severity: 'ELEVATED' });
    // The Neon HTTP driver has no interactive transaction, so a capture split
    // across statements could leave a snapshot row with no samples under it.
    expect(database.queries).toHaveLength(1);
    expect(database.transactions).toHaveLength(0);

    const statement = requireStatement(database.queries, 0);
    expect(statement.text).toContain('FOR UPDATE OF membership');
    expect(statement.text).toContain('INSERT INTO telemetry_sample_sequences');
    expect(statement.text).toContain(
      'SET last_sequence = telemetry_sample_sequences.last_sequence + 1',
    );
    expect(statement.text).toContain('INSERT INTO telemetry_snapshots');
    expect(statement.text).toContain('INSERT INTO telemetry_samples');
    expect(statement.text).toContain('DELETE FROM telemetry_snapshots AS old');
    // The samples travel as one bound jsonb document, not as generated SQL.
    expect(statement.text).toContain('jsonb_to_recordset($4::jsonb)');
    expect(statement.values).toEqual([
      groupId,
      deviceId,
      capturedAt,
      '[{"source_key":"cpu.total","value":61.25,"unit":"%","severity":"ELEVATED","labels":{"profile":"Смена"}}]',
      '5',
    ]);
  });

  it('refuses a capture whose membership the statement did not find', async () => {
    const database = new ScriptedSqlClient([
      [{ member_active: false, snapshot: null, samples: [] }],
    ]);

    await expect(
      new DurableTelemetryMeasurementStore({ database }).record({
        groupId,
        deviceId,
        capturedAt,
        samples: [],
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
  });

  it('follows the snapshots after a sequence, bounded by the caller’s limit', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          member_active: true,
          target_present: true,
          snapshots: [
            {
              sequence: '8',
              captured_at: capturedAt.toISOString(),
              samples: [
                {
                  source_key: 'cpu.total',
                  value: 12,
                  unit: '%',
                  severity: 'NORMAL',
                  observed_at: capturedAt.toISOString(),
                  labels: {},
                },
              ],
            },
          ],
        },
      ],
    ]);

    const snapshots = await new DurableTelemetryMeasurementStore({ database }).readAfter({
      groupId,
      deviceId,
      afterSequence: 7n,
      limit: 64,
    });

    expect(snapshots).toEqual([
      {
        sequence: 8n,
        capturedAt,
        samples: [
          {
            sourceKey: 'cpu.total',
            value: 12,
            unit: '%',
            severity: 'NORMAL',
            observedAt: capturedAt,
            labels: {},
          },
        ],
      },
    ]);
    const statement = requireStatement(database.queries, 0);
    expect(statement.text).toContain('WHERE snapshot.sequence > $4::bigint');
    // `SqlParameter` carries no bigint, so the sequence crosses as text and is
    // cast in SQL rather than being narrowed through a double.
    expect(statement.values).toEqual([groupId, deviceId, null, '7', 64, null]);
  });

  it('rejects a page cursor it did not issue before it reaches the database', async () => {
    const database = new ScriptedSqlClient([[]]);

    await expect(
      new DurableTelemetryMeasurementStore({ database }).listSources({
        groupId,
        deviceId,
        pageSize: 10,
        cursor: 'not-a-cursor',
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'INVALID_ARGUMENT' });
    expect(database.queries).toHaveLength(0);
  });

  it('refuses a page size no listing will serve rather than quietly clamping it', async () => {
    const database = new ScriptedSqlClient([[]]);

    await expect(
      new DurableTelemetryMeasurementStore({ database }).listSources({
        groupId,
        deviceId,
        pageSize: 5_000,
        cursor: '',
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'INVALID_ARGUMENT' });
    expect(database.queries).toHaveLength(0);
  });
});

function sourceRow(): Record<string, unknown> {
  return {
    source_key: 'cpu.total',
    name: 'cpu.total',
    kind: 'CPU',
    unit: '%',
    simulated: true,
    labels: { profile: 'Смена', preset: 'CUSTOM' },
  };
}

/**
 * Indexing a recorded statement list is unchecked under `noUncheckedIndexedAccess`,
 * and a silently `undefined` statement would turn a missing query into a
 * vacuously passing assertion.
 */
function requireStatement(statements: readonly SqlStatement[], index: number): SqlStatement {
  const statement = statements[index];
  if (statement === undefined) {
    throw new Error(`No statement was issued at index ${String(index)}`);
  }
  return statement;
}

class ScriptedSqlClient implements SqlClient {
  readonly queries: SqlStatement[] = [];
  readonly transactions: SqlStatement[][] = [];
  readonly #responses: Array<Record<string, unknown>[]>;

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
