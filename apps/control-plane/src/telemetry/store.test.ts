import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from '../db/database.js';
import { MutationReceiptGuard } from '../sync/receipt-guard.js';

import { DurableSimulationProfileStore } from './store.js';

/**
 * Structural proof for the simulation-profile adapter.
 *
 * A scripted `SqlClient` records the statements the store issues and answers
 * them from a list. That shows exactly three things: the shape of each
 * statement, what is bound into it, and how a row is decoded. It shows nothing
 * about whether `FOR UPDATE` actually serializes two writers, whether the
 * unique index actually refuses a second profile of one name, or whether a
 * retry actually takes one revision — nothing here executes SQL. Those belong
 * to `telemetry.integration.test.ts`, which runs against a live PostgreSQL and
 * proves the properties this suite can only assert the intent of.
 */
const pepper = 'test-telemetry-pepper-with-at-least-thirty-two-characters';
const groupId = '018b2a02-0000-7000-8000-000000000001';
const deviceId = '018b2a02-0000-7000-8000-000000000002';
const profileId = '018b2a02-0000-7000-8000-000000000003';
const otherGroupId = '018b2a02-0000-7000-8000-000000000009';
const now = new Date('2026-08-24T09:00:00.000Z');

describe('durable simulation profile adapter', () => {
  it('creates a profile and its first version in one parameterized statement', async () => {
    const database = new ScriptedSqlClient([[{ writer_authorized: true, profile: profileRow() }]]);

    const created = await createStore(database).create({
      groupId,
      deviceId,
      profileId,
      name: 'Ночная смена',
      presetKind: 'CUSTOM',
      sources: [],
      profile: body('Ночная смена'),
    });

    expect(created).toMatchObject({ id: profileId, groupId, revision: 1n });
    expect(created.profile).toEqual(body('Ночная смена'));
    // The Neon HTTP driver has no interactive transaction, so a mutation that
    // needed one would be a defect rather than a slower path.
    expect(database.transactions).toHaveLength(0);
    expect(database.queries).toHaveLength(1);

    const statement = requireStatement(database.queries, 0);
    expect(statement.text).toContain('authorized_writer AS MATERIALIZED');
    expect(statement.text).toContain("membership.role IN ('EDITOR', 'ADMIN')");
    expect(statement.text).toContain('FOR UPDATE OF membership');
    // Migration 0008's unique index is the conflict target, and the conflict
    // does nothing: a create must not overwrite the profile already standing
    // under that name.
    expect(statement.text).toContain('ON CONFLICT (group_id, name) DO NOTHING');
    expect(statement.text).toContain('INSERT INTO simulation_versions');
    expect(statement.text).toContain('SELECT gen_random_uuid(), written.id, written.revision');
    expect(statement.values).toEqual([
      groupId,
      deviceId,
      now,
      null,
      null,
      profileId,
      'Ночная смена',
      'CUSTOM',
      JSON.stringify(body('Ночная смена')),
      // A profile with no channels declares no data source, and the empty
      // declaration is bound all the same: it is what retires whatever the
      // profile named before, so omitting it would leave a registry describing
      // a profile that no longer exists.
      '[]',
    ]);
  });

  it('refuses a create from a device that is not an active editor', async () => {
    const database = new ScriptedSqlClient([[{ writer_authorized: false, profile: null }]]);

    await expect(
      createStore(database).create({
        groupId,
        deviceId,
        profileId,
        name: 'Ночная смена',
        presetKind: 'CUSTOM',
        sources: [],
        profile: body('Ночная смена'),
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
  });

  it('reports a taken name as a conflict rather than as an overwrite', async () => {
    const database = new ScriptedSqlClient([[{ writer_authorized: true, profile: null }]]);

    await expect(
      createStore(database).create({
        groupId,
        deviceId,
        profileId,
        name: 'Ночная смена',
        presetKind: 'CUSTOM',
        sources: [],
        profile: body('Ночная смена'),
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ALREADY_EXISTS' });
  });

  it('locks the profile it updates and bumps its revision in the same statement', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          writer_authorized: true,
          target_present: true,
          target_revision: '1',
          profile: profileRow({ revision: '2' }),
        },
      ],
    ]);

    const updated = await createStore(database).update({
      groupId,
      deviceId,
      profileId,
      name: 'Ночная смена',
      presetKind: 'CUSTOM',
      sources: [],
      profile: body('Ночная смена'),
      expectedRevision: 1n,
    });

    expect(updated.revision).toBe(2n);
    const statement = requireStatement(database.queries, 0);
    expect(statement.text).toContain('target AS MATERIALIZED');
    expect(statement.text).toContain('FOR UPDATE OF stored');
    expect(statement.text).toContain('revision = stored.revision + 1');
    expect(statement.text).toContain('($10::bigint IS NULL OR target.revision = $10::bigint)');
    expect(requireValues(statement)[9]).toBe('1');
  });

  it('tells a missing profile apart from one that moved past the expected revision', async () => {
    const missing = new ScriptedSqlClient([
      [{ writer_authorized: true, target_present: false, target_revision: null, profile: null }],
    ]);
    await expect(
      createStore(missing).update({
        groupId,
        deviceId,
        profileId,
        name: 'Ночная смена',
        presetKind: 'CUSTOM',
        sources: [],
        profile: body('Ночная смена'),
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'NOT_FOUND' });

    const moved = new ScriptedSqlClient([
      [{ writer_authorized: true, target_present: true, target_revision: '5', profile: null }],
    ]);
    await expect(
      createStore(moved).update({
        groupId,
        deviceId,
        profileId,
        name: 'Ночная смена',
        presetKind: 'CUSTOM',
        sources: [],
        profile: body('Ночная смена'),
        expectedRevision: 1n,
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ABORTED' });
  });

  it('upserts the preset profile on the group-and-name index', async () => {
    const database = new ScriptedSqlClient([
      [{ writer_authorized: true, profile: profileRow({ revision: '3' }) }],
    ]);

    const applied = await createStore(database).applyPreset({
      groupId,
      deviceId,
      profileId,
      name: 'preset:NETWORK_ATTACK',
      presetKind: 'NETWORK_ATTACK',
      sources: [],
      profile: body('preset:NETWORK_ATTACK'),
    });

    expect(applied.revision).toBe(3n);
    const statement = requireStatement(database.queries, 0);
    // Applying one preset twice is one profile at two revisions, so here the
    // same index that refuses a duplicate name drives an update instead.
    expect(statement.text).toContain('ON CONFLICT (group_id, name) DO UPDATE');
    expect(statement.text).toContain('revision = simulation_profiles.revision + 1');
    expect(statement.values).toContain('NETWORK_ATTACK');
  });

  it('edits the stored body in place when the simulation clock is re-timed', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          writer_authorized: true,
          target_present: true,
          target_revision: '1',
          profile: profileRow({ revision: '2' }),
        },
      ],
    ]);

    await createStore(database).setTimeScale({ groupId, deviceId, profileId, timeScale: 2.5 });

    const statement = requireStatement(database.queries, 0);
    // Reading the body out to edit it and writing it back would discard a
    // concurrent update, so the scale is written by the statement itself.
    expect(statement.text).toContain(
      "jsonb_set(stored.profile, '{timeScale}', to_jsonb($7::double precision))",
    );
    expect(requireValues(statement)[6]).toBe(2.5);
  });

  it('deletes a profile without writing a version for the row it removed', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          writer_authorized: true,
          target_present: true,
          profile: { id: profileId, group_id: groupId, revision: '4' },
        },
      ],
    ]);

    const removed = await createStore(database).delete({ groupId, deviceId, profileId });

    expect(removed).toEqual({ profileId, revision: 4n });
    const statement = requireStatement(database.queries, 0);
    expect(statement.text).toContain('DELETE FROM simulation_profiles AS stored');
    // `simulation_versions.profile_id` cascades, so a version written here
    // would be deleted by the same statement that wrote it.
    expect(statement.text).not.toContain('INSERT INTO simulation_versions');
    expect(statement.text).toContain('resource_id = removed.id');
  });

  it('claims a receipt under the simulation scopes before it writes', async () => {
    const written = new ScriptedSqlClient([
      [{ receipt_claimed: 'req' }],
      [{ receipt_claimed: true, writer_authorized: true, profile: profileRow() }],
    ]);

    await createStore(written).create({
      groupId,
      deviceId,
      profileId,
      name: 'Ночная смена',
      presetKind: 'CUSTOM',
      sources: [],
      profile: body('Ночная смена'),
      mutation: { requestId: 'req-create' },
    });

    expect(requireStatement(written.queries, 0).text).toContain('INSERT INTO mutation_receipts');
    expect(requireStatement(written.queries, 0).values).toContain('PUT_SIMULATION_PROFILE');
    const mutation = requireStatement(written.queries, 1);
    expect(mutation.text).toContain('locked_receipt AS MATERIALIZED');
    expect(mutation.text).toContain('CROSS JOIN mutation_gate');
    expect(mutation.text).toContain('resource_id = written.id');
    expect(requireValues(mutation)[3]).toBe('PUT_SIMULATION_PROFILE');

    const removal = new ScriptedSqlClient([
      [{ receipt_claimed: 'req' }],
      [
        {
          receipt_claimed: true,
          writer_authorized: true,
          target_present: true,
          profile: { id: profileId, group_id: groupId, revision: '4' },
        },
      ],
    ]);
    await createStore(removal).delete({
      groupId,
      deviceId,
      profileId,
      mutation: { requestId: 'req-delete' },
    });
    expect(requireStatement(removal.queries, 0).values).toContain('DELETE_SIMULATION_PROFILE');
  });

  it('answers a refused claim with the version the original write produced', async () => {
    const database = new ScriptedSqlClient([
      [],
      [
        {
          receipt_fingerprint: undefined,
          receipt_completed_at: now,
          receipt_group_id: groupId,
          receipt_resource_id: profileId,
          receipt_revision: '7',
        },
      ],
      [
        {
          member_active: true,
          version: {
            profile_id: profileId,
            revision: '7',
            profile: body('Ночная смена'),
            actor_device_id: deviceId,
            created_at: now.toISOString(),
          },
        },
      ],
    ]);
    database.setReceiptFingerprint(
      await fingerprintFor((store) =>
        store.create({
          groupId,
          deviceId,
          profileId,
          name: 'Ночная смена',
          presetKind: 'CUSTOM',
          sources: [],
          profile: body('Ночная смена'),
          mutation: { requestId: 'req-create' },
        }),
      ),
    );

    const replayed = await createStore(database).create({
      groupId,
      deviceId,
      profileId,
      name: 'Ночная смена',
      presetKind: 'CUSTOM',
      sources: [],
      profile: body('Ночная смена'),
      mutation: { requestId: 'req-create' },
    });

    // The write itself is never issued a second time; the recorded revision is
    // read back out of the version table instead.
    expect(database.queries).toHaveLength(3);
    expect(database.queries.some((query) => query.text.includes('written AS'))).toBe(false);
    expect(requireStatement(database.queries, 2).text).toContain(
      'FROM simulation_versions AS version',
    );
    expect(replayed).toMatchObject({ id: profileId, revision: 7n });
    expect(replayed.profile).toEqual(body('Ночная смена'));
  });

  it('refuses a recorded write that belongs to another group', async () => {
    const database = new ScriptedSqlClient([
      [],
      [
        {
          receipt_fingerprint: undefined,
          receipt_completed_at: now,
          receipt_group_id: otherGroupId,
          receipt_resource_id: profileId,
          receipt_revision: '7',
        },
      ],
    ]);
    database.setReceiptFingerprint(
      await fingerprintFor((store) =>
        store.delete({ groupId, deviceId, profileId, mutation: { requestId: 'req-delete' } }),
      ),
    );

    await expect(
      createStore(database).update({
        groupId,
        deviceId,
        profileId,
        name: 'Ночная смена',
        presetKind: 'CUSTOM',
        sources: [],
        profile: body('Ночная смена'),
        mutation: { requestId: 'req-delete' },
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ALREADY_EXISTS' });
  });

  it('pages profiles by name and identifier together', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          member_active: true,
          approximate_total: '2',
          items: [
            { ...profileRow(), name: 'Ночная смена' },
            { ...profileRow({ id: otherGroupId }), name: 'Штормовая' },
          ],
        },
      ],
    ]);

    const page = await createStore(database).list({ groupId, deviceId, pageSize: 1, cursor: '' });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.approximateTotal).toBe(2n);
    // One row beyond the page is fetched so `has_more` is a fact rather than a
    // second count that could disagree with the page it describes.
    expect(requireValues(requireStatement(database.queries, 0))[4]).toBe(2);
    const decoded = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')) as {
      name: string;
      id: string;
    };
    expect(decoded).toEqual({ name: 'Ночная смена', id: profileId });
    expect(requireStatement(database.queries, 0).text).toContain('ORDER BY name ASC, id ASC');
  });

  it('refuses to list or read history for a device that is no longer a member', async () => {
    const listing = new ScriptedSqlClient([
      [{ member_active: false, approximate_total: '0', items: [] }],
    ]);
    await expect(
      createStore(listing).list({ groupId, deviceId, pageSize: 10, cursor: '' }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });

    const history = new ScriptedSqlClient([[{ member_active: false, version: null }]]);
    await expect(
      createStore(history).readVersion({ groupId, deviceId, profileId, revision: 1n }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
  });

  it('reads one stored version without touching another row', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          member_active: true,
          version: {
            profile_id: profileId,
            revision: '3',
            profile: body('Ночная смена'),
            actor_device_id: deviceId,
            created_at: now.toISOString(),
          },
        },
      ],
    ]);

    const version = await createStore(database).readVersion({
      groupId,
      deviceId,
      profileId,
      revision: 3n,
    });

    expect(version).toEqual({
      profileId,
      revision: 3n,
      profile: body('Ночная смена'),
      actorDeviceId: deviceId,
      createdAt: now,
    });
    expect(database.queries).toHaveLength(1);
    expect(requireStatement(database.queries, 0).values).toContain('3');
  });

  it('rejects a page cursor it did not issue', async () => {
    const database = new ScriptedSqlClient([[]]);
    await expect(
      createStore(database).list({ groupId, deviceId, pageSize: 10, cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'INVALID_ARGUMENT' });
    expect(database.queries).toHaveLength(0);
  });
});

/**
 * A receipt fingerprint is an HMAC the guard computes internally, so a scripted
 * "already completed" row can only be built once that value is known. Running
 * the call against a client that answers nothing surfaces the claim statement,
 * whose fourth parameter is the fingerprint. This keeps the test honest: it
 * asserts the store accepts its own fingerprint, never a hardcoded stand-in.
 */
async function fingerprintFor(
  call: (store: DurableSimulationProfileStore) => Promise<unknown>,
): Promise<unknown> {
  const probe = new ScriptedSqlClient([[]]);
  await call(createStore(probe)).catch(() => undefined);
  return requireStatement(probe.queries, 0).values?.[3];
}

/**
 * Indexing a recorded statement list is unchecked under `noUncheckedIndexedAccess`, and a
 * silently `undefined` statement would turn a missing query into a vacuously passing
 * assertion. Failing loudly here keeps "the store issued this statement" a real claim.
 */
function requireStatement(statements: readonly SqlStatement[], index: number): SqlStatement {
  const statement = statements[index];
  if (statement === undefined) {
    throw new Error(`No statement was issued at index ${String(index)}`);
  }
  return statement;
}

/** Positional assertions need the bound-parameter list itself, not an optional view of it. */
function requireValues(statement: SqlStatement): readonly unknown[] {
  const values = statement.values;
  if (values === undefined) {
    throw new Error('Expected the statement to bind parameters');
  }
  return values;
}

function createStore(database: SqlClient): DurableSimulationProfileStore {
  return new DurableSimulationProfileStore({
    database,
    receipts: new MutationReceiptGuard({
      database,
      hashReceipt: (payload) => createHmac('sha256', pepper).update(payload).digest('base64url'),
      tokenHashVersion: 'v1',
      receiptLifetimeMs: 60_000,
      now: () => now,
    }),
    now: () => now,
  });
}

function body(name: string): Record<string, unknown> {
  return {
    groupId: { value: groupId },
    name,
    presetKind: 'SIMULATION_PRESET_KIND_CUSTOM',
    periodSeconds: 300,
    updateIntervalMs: 1000,
    timeScale: 1,
  };
}

function profileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: profileId,
    group_id: groupId,
    profile: body('Ночная смена'),
    revision: '1',
    updated_at: now.toISOString(),
    ...overrides,
  };
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

  setReceiptFingerprint(fingerprint: unknown): void {
    for (const response of this.#responses) {
      for (const row of response) {
        if ('receipt_fingerprint' in row) {
          (row as { receipt_fingerprint: unknown }).receipt_fingerprint = fingerprint;
        }
      }
    }
  }
}
