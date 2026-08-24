import { createHmac } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect';
import { settingsV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from '../db/database.js';
import { MutationReceiptGuard } from '../sync/receipt-guard.js';
import type { PairedDeviceLifecycle } from '../sync/lifecycle.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import { createSettingsService } from './service.js';
import { DurableSettingsStore, type SettingsPatchOperationInput } from './store.js';

/**
 * Offline proof of statement shape, parameter binding and decoding.
 *
 * A scripted `SqlClient` returns whatever it is told to and never runs
 * PostgreSQL, so nothing here observes a lock, a race, a constraint rejecting a
 * duplicate revision, or a cascade. Those are the properties
 * `settings.integration.test.ts` exists for. What this suite can prove is that
 * every mutation is one statement, that no value is ever inlined into its text,
 * that a draft lands under the draft `scope_type`, and that a refused row is
 * turned into the right error rather than into a half-decoded document.
 */

const pepper = 'settings-test-token-pepper-with-at-least-thirty-two-characters';
const groupId = '018b2a02-0000-7000-8000-0000000000a1';
const deviceId = '018b2a02-0000-7000-8000-0000000000a2';
const otherGroupId = '018b2a02-0000-7000-8000-0000000000b1';
const documentId = '018b2a02-0000-7000-8000-0000000000c1';
const now = new Date('2026-08-24T09:00:00.000Z');
const actor = { groupId, deviceId };
const groupScope = { kind: 'GROUP', resourceId: groupId } as const;
const deviceScope = { kind: 'DEVICE', resourceId: deviceId } as const;
const themePatch: readonly SettingsPatchOperationInput[] = [
  { path: 'appearance.theme', value: { stringValue: 'dark' }, remove: false },
];

describe('durable settings store', () => {
  it('writes a draft, its version and its history row in one parameterized statement', async () => {
    const database = new ScriptedSqlClient([[writtenRow()]]);
    const store = createStore(database);

    const draft = await store.applyDraftPatch({
      actor,
      scope: groupScope,
      operations: themePatch,
      schemaVersion: '2026.1',
      correlationId: 'corr-apply',
    });

    expect(database.transactions).toHaveLength(0);
    expect(database.queries).toHaveLength(1);
    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain('authorized_actor AS MATERIALIZED');
    expect(statement.text).toContain('FOR UPDATE OF membership');
    expect(statement.text).toContain('INSERT INTO settings_documents');
    expect(statement.text).toContain(
      'ON CONFLICT (scope_type, group_id) WHERE group_id IS NOT NULL AND device_id IS NULL',
    );
    expect(statement.text).toContain('revision = settings_documents.revision + 1');
    expect(statement.text).toContain('INSERT INTO settings_versions');
    expect(statement.text).toContain('INSERT INTO history_events');
    // The row identity comes from the membership CTE, never from a parameter:
    // that is what stops a caller from proving membership in one group while
    // addressing another group's document.
    expect(statement.text).toContain('authorized_actor.group_id, NULL::uuid');
    expect(statement.values).toContain('GROUP_DRAFT');
    expect(statement.values).toContain('APPLY_DRAFT_PATCH');
    expect(statement.values).toContain('2026.1');
    expect(statement.values).toContain(JSON.stringify(themePatch));
    // The setting path travels as a bound value, never as statement text.
    expect(statement.text).not.toContain('appearance.theme');

    expect(draft).toMatchObject({
      id: documentId,
      draft: true,
      revision: 1n,
      scope: { kind: 'GROUP', resourceId: groupId },
    });
    expect(draft.values).toEqual({ 'appearance.theme': { stringValue: 'dark' } });
  });

  it('addresses a device scope through its own partial unique index', async () => {
    const database = new ScriptedSqlClient([
      [writtenRow({ scope_type: 'DEVICE_DRAFT', group_id: null, device_id: deviceId })],
    ]);
    const store = createStore(database);

    const draft = await store.applyDraftPatch({
      actor,
      scope: deviceScope,
      operations: themePatch,
      schemaVersion: '2026.1',
      correlationId: '',
    });

    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain(
      'ON CONFLICT (scope_type, device_id) WHERE device_id IS NOT NULL AND group_id IS NULL',
    );
    expect(statement.text).toContain('NULL::uuid, authorized_actor.device_id');
    // A device's own personalization is not an editorial act, so a viewer may
    // change it; the membership join still has to match.
    expect(statement.values).toContain(JSON.stringify(['VIEWER', 'EDITOR', 'ADMIN']));
    expect(draft.scope).toEqual({ kind: 'DEVICE', resourceId: deviceId });
  });

  it('binds group-scoped writes to the editorial roles', async () => {
    const database = new ScriptedSqlClient([[writtenRow()]]);
    const store = createStore(database);

    await store.applyDraftPatch({
      actor,
      scope: groupScope,
      operations: themePatch,
      schemaVersion: '2026.1',
      correlationId: '',
    });

    expect(requireStatement(database.queries[0]).values).toContain(
      JSON.stringify(['EDITOR', 'ADMIN']),
    );
  });

  it('refuses to write a factory or theme scope and issues no statement', async () => {
    const database = new ScriptedSqlClient([]);
    const store = createStore(database);

    await expect(
      store.applyDraftPatch({
        actor,
        scope: { kind: 'FACTORY' },
        operations: themePatch,
        schemaVersion: '2026.1',
        correlationId: '',
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
    expect(database.queries).toHaveLength(0);
  });

  it('publishes the draft and removes it in the same statement', async () => {
    const database = new ScriptedSqlClient([[writtenRow({ scope_type: 'GROUP', revision: '4' })]]);
    const store = createStore(database);

    const published = await store.publishDraft({
      actor,
      scope: groupScope,
      schemaVersion: '2026.1',
      correlationId: 'corr-publish',
    });

    expect(database.queries).toHaveLength(1);
    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain('published_draft AS MATERIALIZED');
    expect(statement.text).toContain('FOR UPDATE OF draft');
    expect(statement.text).toContain('DELETE FROM settings_documents AS draft');
    expect(statement.text).toContain('INSERT INTO settings_versions');
    expect(statement.values).toContain('GROUP_DRAFT');
    expect(statement.values).toContain('PUBLISH_DRAFT');
    expect(published).toMatchObject({ draft: false, revision: 4n });
  });

  it('reports a scope with no draft as NOT_FOUND rather than as an empty publish', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          receipt_claimed: true,
          actor_active: true,
          source_present: false,
          id: null,
        },
      ],
    ]);
    const store = createStore(database);

    await expect(
      store.publishDraft({ actor, scope: groupScope, schemaVersion: '2026.1', correlationId: '' }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'NOT_FOUND' });
  });

  it('refuses a mutation whose actor is no longer an active member', async () => {
    const database = new ScriptedSqlClient([
      [{ receipt_claimed: true, actor_active: false, source_present: false, id: null }],
    ]);
    const store = createStore(database);

    await expect(
      store.applyDraftPatch({
        actor,
        scope: groupScope,
        operations: themePatch,
        schemaVersion: '2026.1',
        correlationId: '',
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
  });

  it('collapses a repeated path so the value aggregate cannot fail on a duplicate key', async () => {
    const database = new ScriptedSqlClient([[writtenRow()]]);
    const store = createStore(database);

    await store.applyDraftPatch({
      actor,
      scope: groupScope,
      operations: [
        { path: 'appearance.theme', value: { stringValue: 'light' }, remove: false },
        { path: 'appearance.theme', value: { stringValue: 'dark' }, remove: false },
      ],
      schemaVersion: '2026.1',
      correlationId: '',
    });

    const statement = requireStatement(database.queries[0]);
    expect(statement.values).toContain(
      JSON.stringify([{ path: 'appearance.theme', value: { stringValue: 'dark' }, remove: false }]),
    );
  });

  it('rejects a patch operation that neither sets nor removes a value', async () => {
    const database = new ScriptedSqlClient([]);
    const store = createStore(database);

    await expect(
      store.applyDraftPatch({
        actor,
        scope: groupScope,
        operations: [{ path: 'appearance.theme', remove: false }],
        schemaVersion: '2026.1',
        correlationId: '',
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'INVALID_ARGUMENT' });
    expect(database.queries).toHaveLength(0);
  });

  it('empties a document with a literal map and records the operation that did it', async () => {
    const database = new ScriptedSqlClient([
      [writtenRow({ scope_type: 'GROUP', revision: '9', document: { values: {} } })],
    ]);
    const store = createStore(database);

    const reset = await store.reset({
      actor,
      scope: groupScope,
      mode: 'ALL',
      target: '',
      schemaVersion: '2026.1',
      correlationId: '',
    });

    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain("jsonb_build_object('values', '{}'::jsonb)");
    expect(statement.values).toContain('RESET_ALL');
    // A reset spans every category, so the history row records that rather than
    // naming one arbitrary member.
    expect(statement.values).toContain('*');
    expect(reset.values).toEqual({});
  });

  it('removes one category by its path prefix and one element by its exact path', async () => {
    const database = new ScriptedSqlClient([
      [writtenRow({ scope_type: 'GROUP' })],
      [writtenRow({ scope_type: 'GROUP' })],
    ]);
    const store = createStore(database);

    await store.reset({
      actor,
      scope: groupScope,
      mode: 'CATEGORY',
      target: 'appearance',
      schemaVersion: '2026.1',
      correlationId: '',
    });
    await store.reset({
      actor,
      scope: groupScope,
      mode: 'ELEMENT',
      target: 'appearance.theme',
      schemaVersion: '2026.1',
      correlationId: '',
    });

    expect(requireStatement(database.queries[0]).text).toContain(
      "split_part(kept.key, '.', 1) <> $15",
    );
    expect(requireStatement(database.queries[0]).values).toContain('appearance');
    expect(requireStatement(database.queries[1]).text).toContain('kept.key <> $15');
    expect(requireStatement(database.queries[1]).values).toContain('appearance.theme');
  });

  it('restores a revision from the values its version row recorded', async () => {
    const database = new ScriptedSqlClient([[writtenRow({ scope_type: 'GROUP', revision: '7' })]]);
    const store = createStore(database);

    await store.revertVersion({
      actor,
      scope: groupScope,
      targetRevision: 3n,
      schemaVersion: '2026.1',
      correlationId: '',
    });

    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain('reverted_source AS MATERIALIZED');
    expect(statement.text).toContain("COALESCE(version.patch -> 'values', '{}'::jsonb)");
    // The revision travels as text so a bigint never passes through a double.
    expect(statement.values).toContain('3');
  });

  it('asks for every requested scope, and each scope’s draft, in one statement', async () => {
    const database = new ScriptedSqlClient([[]]);
    const store = createStore(database);

    await store.readDocuments({
      actor,
      scopes: [{ kind: 'FACTORY' }, { kind: 'THEME' }, groupScope, deviceScope],
      includeDraft: true,
    });

    expect(database.queries).toHaveLength(1);
    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain('jsonb_array_elements($3::jsonb)');
    expect(statement.text).toContain('FROM group_memberships AS membership');
    const wanted = JSON.parse(String(statement.values?.[2])) as { scope_type: string }[];
    expect(wanted.map((entry) => entry.scope_type)).toEqual([
      'FACTORY',
      'THEME',
      'GROUP',
      'GROUP_DRAFT',
      'DEVICE',
      'DEVICE_DRAFT',
    ]);
  });

  it('pages history by keyset and asks for one row beyond the page', async () => {
    const database = new ScriptedSqlClient([
      [historyRow({ id: '018b2a02-0000-7000-8000-0000000000d1' })],
      [
        historyRow({ id: '018b2a02-0000-7000-8000-0000000000d1' }),
        historyRow({ id: '018b2a02-0000-7000-8000-0000000000d2' }),
      ],
    ]);
    const store = createStore(database);

    const first = await store.listHistory({ actor, scope: groupScope, pageSize: 1, cursor: '' });
    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain('(event.occurred_at, event.id) < ($4::timestamptz, $5::uuid)');
    expect(statement.text).toContain('ORDER BY event.occurred_at DESC, event.id DESC');
    expect(statement.values).toContain(2);
    expect(first.hasMore).toBe(false);
    expect(first.nextCursor).toBe('');
    expect(first.entries[0]).toMatchObject({
      operation: 'APPLY_DRAFT_PATCH',
      category: 'appearance',
      revision: 5n,
    });

    const paged = await store.listHistory({ actor, scope: groupScope, pageSize: 1, cursor: '' });
    expect(paged.hasMore).toBe(true);
    expect(paged.nextCursor).not.toBe('');

    const continued = await store.listHistory({
      actor,
      scope: groupScope,
      pageSize: 1,
      cursor: paged.nextCursor,
    });
    expect(continued.entries).toHaveLength(0);
    const cursoredStatement = requireStatement(database.queries[2]);
    expect(cursoredStatement.values?.[3]).toBeInstanceOf(Date);
    expect(cursoredStatement.values?.[4]).toBe('018b2a02-0000-7000-8000-0000000000d1');
  });

  it('rejects a history cursor this service did not issue', async () => {
    const database = new ScriptedSqlClient([[]]);
    const store = createStore(database);

    await expect(
      store.listHistory({ actor, scope: groupScope, pageSize: 10, cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'INVALID_ARGUMENT' });
  });

  it('polls a scope’s published document above the caller’s revision', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          ...writtenRow({ scope_type: 'GROUP', revision: '12' }),
          operation: 'PUBLISH_DRAFT',
          correlation_id: 'corr-publish',
        },
      ],
    ]);
    const store = createStore(database);

    const changes = await store.pollChanges({ actor, scope: groupScope, afterRevision: 11n });

    const statement = requireStatement(database.queries[0]);
    expect(statement.text).toContain('document.revision > $6::bigint');
    expect(statement.text).toContain('LEFT JOIN settings_versions AS version');
    // The published document alone: a draft row carries a counter that restarts
    // at 1 after every publish, so a single wire watermark cannot span both.
    expect(statement.values).toContain(JSON.stringify(['GROUP']));
    expect(changes[0]).toMatchObject({ operation: 'PUBLISH_DRAFT', correlationId: 'corr-publish' });
    expect(changes[0]?.document.revision).toBe(12n);
  });

  it('answers a retried patch from the receipt instead of mutating a second time', async () => {
    const database = new ScriptedSqlClient([
      // The claim is refused: a completed receipt already owns the identity.
      [],
      [
        {
          receipt_fingerprint: undefined,
          receipt_completed_at: now,
          receipt_group_id: groupId,
          receipt_resource_id: documentId,
          receipt_revision: '3',
        },
      ],
      [
        {
          id: documentId,
          group_id: groupId,
          device_id: null,
          scope_type: 'GROUP_DRAFT',
          schema_version: '2026.1',
          document: { values: { 'appearance.theme': { stringValue: 'dark' } } },
          revision: '3',
          updated_at: now,
        },
      ],
    ]);
    database.setReceiptFingerprint(await fingerprintForRetriedPatch());
    const store = createStore(database);

    const replayed = await store.applyDraftPatch({
      actor,
      scope: groupScope,
      operations: themePatch,
      schemaVersion: '2026.1',
      correlationId: '',
      mutation: { requestId: 'req-apply-retry' },
    });

    expect(database.queries).toHaveLength(3);
    expect(
      database.queries.some((statement) =>
        statement.text.includes('INSERT INTO settings_documents'),
      ),
    ).toBe(false);
    expect(replayed.revision).toBe(3n);
  });

  it('refuses one request identifier reused for a different patch', async () => {
    const database = new ScriptedSqlClient([
      [],
      [
        {
          receipt_fingerprint: 'a-different-requests-fingerprint',
          receipt_completed_at: now,
          receipt_group_id: groupId,
          receipt_resource_id: documentId,
          receipt_revision: '3',
        },
      ],
    ]);
    const store = createStore(database);

    await expect(
      store.applyDraftPatch({
        actor,
        scope: groupScope,
        operations: themePatch,
        schemaVersion: '2026.1',
        correlationId: '',
        mutation: { requestId: 'req-apply-retry' },
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ALREADY_EXISTS' });
  });

  it('leaves the receipt gate open when the caller supplies no request id', async () => {
    const database = new ScriptedSqlClient([[writtenRow()]]);
    const store = createStore(database);

    await store.applyDraftPatch({
      actor,
      scope: groupScope,
      operations: themePatch,
      schemaVersion: '2026.1',
      correlationId: '',
    });

    expect(database.queries).toHaveLength(1);
    const statement = requireStatement(database.queries[0]);
    expect(statement.text).not.toContain('INSERT INTO mutation_receipts');
    expect(statement.text).toContain('SELECT 1 AS open WHERE $2::text IS NULL');
    expect(statement.values?.slice(0, 2)).toEqual([null, null]);
  });
});

/**
 * The scope rules the service applies before any statement runs. They are pure
 * request logic, so they are provable without a database at all — and they are
 * the first of the two places a cross-group request is refused.
 */
describe('settings scope resolution', () => {
  it('refuses LOCAL_DRAFT and SESSION_PREVIEW by naming why they have no server row', async () => {
    const service = createSettingsService({
      runtime: stubLifecycle(),
      store: createStore(new ScriptedSqlClient([])),
    });
    const applyDraftPatch = requireHandler(service.applyDraftPatch);

    for (const type of [
      settingsV1.SettingsScopeType.LOCAL_DRAFT,
      settingsV1.SettingsScopeType.SESSION_PREVIEW,
    ]) {
      const failure = await failureOf(() =>
        applyDraftPatch(
          create(settingsV1.ApplyDraftPatchRequestSchema, {
            scope: { type, resourceId: { value: groupId } },
            operations: [
              { path: 'appearance.theme', value: { kind: { case: 'stringValue', value: 'dark' } } },
            ],
          }),
          handlerContext(),
        ),
      );
      expect(failure).toBeInstanceOf(ConnectError);
      expect((failure as ConnectError).code).toBe(Code.InvalidArgument);
      expect((failure as ConnectError).message).toContain('never leave the machine');
    }
  });

  it('refuses a group scope the authenticated session does not name', async () => {
    const service = createSettingsService({
      runtime: stubLifecycle(),
      store: createStore(new ScriptedSqlClient([])),
    });
    const applyDraftPatch = requireHandler(service.applyDraftPatch);

    const failure = await failureOf(() =>
      applyDraftPatch(
        create(settingsV1.ApplyDraftPatchRequestSchema, {
          scope: {
            type: settingsV1.SettingsScopeType.GROUP,
            resourceId: { value: otherGroupId },
          },
          operations: [
            { path: 'appearance.theme', value: { kind: { case: 'stringValue', value: 'dark' } } },
          ],
        }),
        handlerContext(),
      ),
    );
    expect((failure as ConnectError).code).toBe(Code.PermissionDenied);
  });

  it('refuses to write a factory scope over RPC', async () => {
    const service = createSettingsService({
      runtime: stubLifecycle(),
      store: createStore(new ScriptedSqlClient([])),
    });
    const resetAll = requireHandler(service.resetAll);

    const failure = await failureOf(() =>
      resetAll(
        create(settingsV1.ResetAllRequestSchema, {
          scope: { type: settingsV1.SettingsScopeType.FACTORY },
          confirmation: '',
        }),
        handlerContext(),
      ),
    );
    expect((failure as ConnectError).code).toBe(Code.PermissionDenied);
  });

  it('requires the reset confirmation to repeat the scope identifier', async () => {
    const service = createSettingsService({
      runtime: stubLifecycle(),
      store: createStore(new ScriptedSqlClient([])),
    });
    const resetAll = requireHandler(service.resetAll);

    const failure = await failureOf(() =>
      resetAll(
        create(settingsV1.ResetAllRequestSchema, {
          scope: {
            type: settingsV1.SettingsScopeType.GROUP,
            resourceId: { value: groupId },
          },
          confirmation: 'yes',
        }),
        handlerContext(),
      ),
    );
    expect((failure as ConnectError).code).toBe(Code.InvalidArgument);
  });

  it('answers unimplemented rather than an empty success without durable storage', async () => {
    const service = createSettingsService({ runtime: stubLifecycle() });
    const getEffectiveSettings = requireHandler(service.getEffectiveSettings);

    const failure = await failureOf(() =>
      getEffectiveSettings(
        create(settingsV1.GetEffectiveSettingsRequestSchema, {}),
        handlerContext(),
      ),
    );
    expect((failure as ConnectError).code).toBe(Code.Unimplemented);
  });
});

function createStore(database: SqlClient): DurableSettingsStore {
  return new DurableSettingsStore({
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

/**
 * A receipt fingerprint is an HMAC the store computes internally, so a scripted
 * "already completed" row can only be built once that value is known. Replaying
 * the identical call against a probe database recovers it, which keeps the test
 * asserting that the store accepts its own fingerprint rather than a stand-in.
 */
async function fingerprintForRetriedPatch(): Promise<unknown> {
  const probe = new ScriptedSqlClient([[]]);
  await createStore(probe)
    .applyDraftPatch({
      actor,
      scope: groupScope,
      operations: themePatch,
      schemaVersion: '2026.1',
      correlationId: '',
      mutation: { requestId: 'req-apply-retry' },
    })
    .catch(() => undefined);
  return probe.queries[0]?.values?.[3];
}

function writtenRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receipt_claimed: true,
    actor_active: true,
    source_present: true,
    id: documentId,
    group_id: groupId,
    device_id: null,
    scope_type: 'GROUP_DRAFT',
    schema_version: '2026.1',
    document: { values: { 'appearance.theme': { stringValue: 'dark' } } },
    revision: '1',
    updated_at: now,
    ...overrides,
  };
}

function historyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: documentId,
    scope: 'GROUP',
    category: 'appearance',
    element_id: 'appearance.theme',
    operation: 'APPLY_DRAFT_PATCH',
    patch: [{ path: 'appearance.theme', value: { stringValue: 'dark' }, remove: false }],
    revision: '5',
    device_id: deviceId,
    correlation_id: 'corr-apply',
    occurred_at: now,
    ...overrides,
  };
}

function requireStatement(statement: SqlStatement | undefined): SqlStatement {
  if (statement === undefined) throw new Error('Expected the store to issue a statement');
  return statement;
}

/** A handler may answer synchronously, so its failure is captured rather than awaited as a rejection. */
async function failureOf(call: () => unknown): Promise<unknown> {
  try {
    await call();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

function requireHandler<Handler>(handler: Handler | undefined): Handler {
  if (handler === undefined) throw new Error('Expected the service to implement this RPC');
  return handler;
}

function handlerContext(): HandlerContext {
  return {
    requestHeader: new Headers({ authorization: 'Bearer hq_access_settings' }),
    signal: new AbortController().signal,
  } as unknown as HandlerContext;
}

function authenticatedDevice(): AuthenticatedDevice {
  return {
    group: {
      id: groupId,
      name: 'Штаб',
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
      role: 'ADMIN',
      status: 'ONLINE',
      platform: 'windows',
      applicationVersion: '0.1.0',
      createdAt: now,
      lastSeenAt: now,
    },
    role: 'ADMIN',
    sessionId: '018b2a02-0000-7000-8000-0000000000e1',
    accessTokenId: '018b2a02-0000-7000-8000-0000000000e2',
  };
}

/** Only `authenticateAccessToken` is reachable from this service. */
function stubLifecycle(): PairedDeviceLifecycle {
  const unreachable = (): never => {
    throw new Error('The settings service must not call the pairing lifecycle');
  };
  return {
    authenticateAccessToken: () => authenticatedDevice(),
    createGroup: unreachable,
    createPairingCode: unreachable,
    pairDevice: unreachable,
    refreshDeviceSession: unreachable,
    listDevices: unreachable,
    revokeDevice: unreachable,
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
