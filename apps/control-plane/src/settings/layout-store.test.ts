import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from '../db/database.js';
import { MutationReceiptGuard } from '../sync/receipt-guard.js';
import { PairedDeviceRuntimeError } from '../sync/runtime.js';

import { DurableLayoutStore, type LayoutTilePlacementInput } from './layout-store.js';

/**
 * Offline proof of statement shape, parameter binding and decoding.
 *
 * A scripted `SqlClient` returns whatever it is told to and never runs
 * PostgreSQL, so nothing here observes the row lock, the expected-revision
 * predicate actually refusing a concurrent put, or `UNIQUE (document_id,
 * revision)` rejecting a duplicate version. Those are what
 * `layout.integration.test.ts` exists for. What this suite proves is that the
 * put is one statement, that the tiles and the screen id are bound values and
 * never statement text, that a group scope and a device scope reach different
 * partial unique indexes, and that a refused write becomes the right error
 * rather than a half-decoded document.
 */

const pepper = 'layout-test-token-pepper-with-at-least-thirty-two-characters';
const groupId = '018b2a02-0000-7000-8000-0000000000a1';
const deviceId = '018b2a02-0000-7000-8000-0000000000a2';
const otherGroupId = '018b2a02-0000-7000-8000-0000000000b1';
const documentId = '018b2a02-0000-7000-8000-0000000000c1';
const now = new Date('2026-08-29T09:00:00.000Z');
const actor = { groupId, deviceId };
const groupScope = { kind: 'GROUP', resourceId: groupId } as const;
const deviceScope = { kind: 'DEVICE', resourceId: deviceId } as const;
const tiles: readonly LayoutTilePlacementInput[] = [
  { tileId: 'sector-map', column: 0, row: 0, columnSpan: 2, rowSpan: 2, hidden: false },
  { tileId: 'comms', column: 2, row: 0, columnSpan: 1, rowSpan: 1, hidden: true },
];

describe('durable layout store', () => {
  it('writes the document and its version row in one parameterized statement', async () => {
    const database = new ScriptedSqlClient([[writtenRow()]]);
    const store = createStore(database);

    const document = await store.putDocument({
      actor,
      scope: groupScope,
      screenId: 'wall-1',
      tiles,
      expectedRevision: 0n,
      correlationId: 'corr-put',
    });

    expect(database.transactions).toHaveLength(0);
    expect(database.queries).toHaveLength(1);
    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain('authorized_actor AS MATERIALIZED');
    expect(statement.text).toContain('FOR UPDATE OF membership');
    expect(statement.text).toContain('INSERT INTO layout_documents');
    expect(statement.text).toContain('INSERT INTO layout_versions');
    expect(statement.text).toContain(
      'ON CONFLICT (group_id, screen_id) WHERE group_id IS NOT NULL AND device_id IS NULL',
    );
    expect(statement.text).toContain('revision = layout_documents.revision + 1');
    // The row identity comes from the membership CTE, never from a parameter:
    // that is what stops a caller from proving membership in one group while
    // addressing another group's screen.
    expect(statement.text).toContain('authorized_actor.group_id, NULL::uuid');
    // A layout is not a setting, and a layout row in `history_events` would
    // surface inside `ListSettingsHistory` as a settings change nobody made.
    expect(statement.text).not.toContain('history_events');
    // Every value the caller supplied travels as a bound parameter.
    expect(statement.text).not.toContain('wall-1');
    expect(statement.text).not.toContain('sector-map');
    expect(statement.values).toContain('wall-1');
    expect(statement.values).toContain(JSON.stringify(tiles));

    expect(document).toMatchObject({
      id: documentId,
      screenId: 'wall-1',
      revision: 1n,
      scope: { kind: 'GROUP', resourceId: groupId },
    });
    expect(document.tiles).toEqual(tiles);
  });

  it('addresses a device scope through its own partial unique index', async () => {
    const database = new ScriptedSqlClient([[writtenRow({ group_id: null, device_id: deviceId })]]);
    const store = createStore(database);

    const document = await store.putDocument({
      actor,
      scope: deviceScope,
      screenId: 'wall-1',
      tiles,
      expectedRevision: 0n,
      correlationId: 'corr-device',
    });

    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain(
      'ON CONFLICT (device_id, screen_id) WHERE device_id IS NOT NULL',
    );
    expect(statement.text).toContain('NULL::uuid, authorized_actor.device_id');
    // A device layout writes no group id, so it lands in exactly one of the two
    // partial indexes.
    expect(statement.text).toContain('existing.group_id IS NULL');
    expect(document.scope).toEqual({ kind: 'DEVICE', resourceId: deviceId });
  });

  it('carries the expected revision into both the insert guard and the conflict predicate', async () => {
    const database = new ScriptedSqlClient([[writtenRow({ revision: '8' })]]);
    const store = createStore(database);

    await store.putDocument({
      actor,
      scope: groupScope,
      screenId: 'wall-1',
      tiles,
      expectedRevision: 7n,
      correlationId: 'corr-compare',
    });

    const statement = requireStatement(database.queries[0]);
    // The insert branch may not mint revision 1 for a caller that believed it
    // was editing revision 7 ...
    expect(statement.text).toContain('WHERE $10::bigint = 0');
    // ... and the update branch is decided against the row the upsert locked,
    // which is what makes the comparison race-free.
    expect(statement.text).toContain('WHERE $10::bigint = 0 OR layout_documents.revision = $10');
    expect(statement.values?.[9]).toBe('7');
  });

  it('reports a put that wrote nothing as a conflict rather than as success', async () => {
    const database = new ScriptedSqlClient([
      [{ receipt_claimed: true, actor_active: true, id: null }],
    ]);
    const store = createStore(database);

    await expect(
      store.putDocument({
        actor,
        scope: groupScope,
        screenId: 'wall-1',
        tiles,
        expectedRevision: 3n,
        correlationId: 'corr-conflict',
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('reports an inactive or under-privileged actor without naming which', async () => {
    const database = new ScriptedSqlClient([
      [{ receipt_claimed: true, actor_active: false, id: null }],
    ]);
    const store = createStore(database);

    await expect(
      store.putDocument({
        actor,
        scope: groupScope,
        screenId: 'wall-1',
        tiles,
        expectedRevision: 0n,
        correlationId: 'corr-denied',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('requires the editorial roles for a group layout and admits any active role for a device one', async () => {
    const database = new ScriptedSqlClient([[writtenRow()], [writtenRow({ group_id: null })]]);
    const store = createStore(database);

    await store.putDocument({
      actor,
      scope: groupScope,
      screenId: 'wall-1',
      tiles,
      expectedRevision: 0n,
      correlationId: 'corr-group',
    });
    await store.putDocument({
      actor,
      scope: deviceScope,
      screenId: 'wall-1',
      tiles,
      expectedRevision: 0n,
      correlationId: 'corr-device',
    });

    expect(requireStatement(database.queries[0]).values?.[4]).toBe(
      JSON.stringify(['EDITOR', 'ADMIN']),
    );
    expect(requireStatement(database.queries[1]).values?.[4]).toBe(
      JSON.stringify(['VIEWER', 'EDITOR', 'ADMIN']),
    );
  });

  it('refuses a scope the session cannot address before any statement runs', async () => {
    const database = new ScriptedSqlClient([]);
    const store = createStore(database);

    await expect(
      store.putDocument({
        actor,
        scope: { kind: 'GROUP', resourceId: otherGroupId },
        screenId: 'wall-1',
        tiles,
        expectedRevision: 0n,
        correlationId: 'corr-foreign',
      }),
    ).rejects.toBeInstanceOf(PairedDeviceRuntimeError);
    expect(database.queries).toHaveLength(0);
  });

  it('refuses factory and theme scopes, which own no layout row', async () => {
    const database = new ScriptedSqlClient([]);
    const store = createStore(database);

    await expect(
      store.readDocument({ actor, scope: { kind: 'FACTORY' }, screenId: 'wall-1' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(database.queries).toHaveLength(0);
  });

  it('collapses a tile named twice and bounds what one document may carry', async () => {
    const database = new ScriptedSqlClient([[writtenRow()]]);
    const store = createStore(database);

    await store.putDocument({
      actor,
      scope: groupScope,
      screenId: 'wall-1',
      tiles: [
        { tileId: 'comms', column: 0, row: 0, columnSpan: 1, rowSpan: 1, hidden: false },
        { tileId: 'comms', column: 3, row: 1, columnSpan: 2, rowSpan: 2, hidden: false },
      ],
      expectedRevision: 0n,
      correlationId: 'corr-duplicate',
    });

    const statement = requireStatement(database.queries[0]);
    expect(statement.values?.[6]).toBe(
      JSON.stringify([
        { tileId: 'comms', column: 3, row: 1, columnSpan: 2, rowSpan: 2, hidden: false },
      ]),
    );

    await expect(
      store.putDocument({
        actor,
        scope: groupScope,
        screenId: 'wall-1',
        tiles: [{ tileId: 'comms', column: 0, row: 0, columnSpan: 0, rowSpan: 1, hidden: false }],
        expectedRevision: 0n,
        correlationId: 'corr-span',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('re-checks the reader membership in the read statement itself', async () => {
    const database = new ScriptedSqlClient([[storedRow()]]);
    const store = createStore(database);

    const document = await store.readDocument({ actor, scope: groupScope, screenId: 'wall-1' });

    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain('FROM group_memberships AS membership');
    expect(statement.text).toContain("devices.status <> 'REVOKED'");
    expect(document?.tiles).toEqual(tiles);
  });

  it('answers an unarranged screen with nothing rather than an error', async () => {
    const database = new ScriptedSqlClient([[]]);
    const store = createStore(database);

    await expect(
      store.readDocument({ actor, scope: groupScope, screenId: 'wall-9' }),
    ).resolves.toBeUndefined();
  });

  it('pages the history by revision keyset and asks for one row more than the page', async () => {
    const database = new ScriptedSqlClient([[versionRow('3'), versionRow('2'), versionRow('1')]]);
    const store = createStore(database);

    const page = await store.listHistory({
      actor,
      scope: groupScope,
      screenId: 'wall-1',
      pageSize: 2,
      cursor: '',
    });

    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain('FROM layout_versions AS version');
    expect(statement.text).toContain('ORDER BY version.revision DESC');
    expect(statement.values?.[6]).toBe(3);
    expect(page.entries.map((entry) => entry.revision)).toEqual([3n, 2n]);
    expect(page.hasMore).toBe(true);

    const next = await createStore(new ScriptedSqlClient([[]])).listHistory({
      actor,
      scope: groupScope,
      screenId: 'wall-1',
      pageSize: 2,
      cursor: page.nextCursor,
    });
    expect(next.entries).toEqual([]);
  });

  it('refuses a history cursor it did not issue', async () => {
    const database = new ScriptedSqlClient([[]]);
    const store = createStore(database);

    await expect(
      store.listHistory({
        actor,
        scope: groupScope,
        screenId: 'wall-1',
        pageSize: 2,
        cursor: Buffer.from('layout:; DROP TABLE layout_versions', 'utf8').toString('base64url'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(database.queries).toHaveLength(0);
  });
});

function createStore(database: SqlClient): DurableLayoutStore {
  return new DurableLayoutStore({
    database,
    receipts: new MutationReceiptGuard({
      database,
      hashReceipt: (payload) => createHmac('sha256', pepper).update(payload).digest('base64url'),
      tokenHashVersion: 'v1',
      receiptLifetimeMs: 24 * 60 * 60 * 1000,
      now: () => now,
    }),
    now: () => now,
  });
}

function writtenRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receipt_claimed: true,
    actor_active: true,
    ...storedRow(),
    ...overrides,
  };
}

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: documentId,
    group_id: groupId,
    device_id: null,
    screen_id: 'wall-1',
    layout: { tiles },
    revision: '1',
    updated_at: now,
    ...overrides,
  };
}

function versionRow(revision: string): Record<string, unknown> {
  return {
    revision,
    patch: { tiles },
    actor_device_id: deviceId,
    correlation_id: 'corr-put',
    created_at: now,
  };
}

function requireStatement(statement: SqlStatement | undefined): SqlStatement {
  if (statement === undefined) throw new Error('Expected the store to issue a statement');
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
