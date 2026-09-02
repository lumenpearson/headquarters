import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { DurablePairedDeviceRuntime } from '../sync/durable-runtime.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import { DurableSettingsStore, type SettingsPatchOperationInput } from './store.js';

/**
 * Real PostgreSQL proof for the settings documents, versions and history.
 *
 * Every scenario here is a property a scripted `SqlClient` cannot show: two
 * writers serializing on the document row, a receipt refusing a second
 * execution, `UNIQUE (document_id, revision)` actually rejecting a duplicate,
 * `settings_documents`' own CHECK actually rejecting a scope that has no home,
 * and a group deletion actually taking its documents, versions and history with
 * it. The offline suite shows the SQL that intends those properties and nothing
 * about whether they hold.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';
const schemaVersion = '2026.1';

describeIntegration('durable settings storage against real PostgreSQL', () => {
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
    'gives two concurrent draft patches consecutive revisions with no gap and no duplicate',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const second = await pairDevice(runtime, owner);
      const secondActor = { groupId: owner.groupId, deviceId: second.deviceId };

      const seeded = await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: 'seed',
      });
      expect(seeded.revision).toBe(1n);

      // Two devices patch the same draft at the same instant. Only the row lock
      // the upsert takes stops both from reading revision 1 and both writing 2.
      const outcomes = await Promise.all([
        store.applyDraftPatch({
          actor: owner.actor,
          scope: owner.scope,
          operations: [setting('appearance.density', 'compact')],
          schemaVersion,
          correlationId: 'race-a',
        }),
        store.applyDraftPatch({
          actor: secondActor,
          scope: owner.scope,
          operations: [setting('appearance.accent', 'amber')],
          schemaVersion,
          correlationId: 'race-b',
        }),
      ]);

      const revisions = outcomes.map((outcome) => outcome.revision).sort();
      expect(revisions).toEqual([2n, 3n]);

      const counted = await database.query<{ total: number; distinct_revisions: number }>({
        text: `SELECT count(*)::int AS total, count(DISTINCT revision)::int AS distinct_revisions
               FROM settings_versions WHERE document_id = $1`,
        values: [seeded.id],
      });
      expect(counted[0]?.total).toBe(3);
      expect(counted[0]?.distinct_revisions).toBe(counted[0]?.total);

      // Both patches survived: serialization means the later writer merged onto
      // the earlier one rather than overwriting it.
      const stored = await database.query<{ values: Record<string, unknown> }>({
        text: `SELECT document -> 'values' AS values FROM settings_documents WHERE id = $1`,
        values: [seeded.id],
      });
      expect(Object.keys(stored[0]?.values ?? {}).sort()).toEqual([
        'appearance.accent',
        'appearance.density',
        'appearance.theme',
      ]);
    },
    networkTimeoutMs,
  );

  it(
    'bumps the revision once however many times one request identifier is retried',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const requestId = `apply-${uniqueSuffix()}`;
      const operations = [setting('appearance.theme', 'dark')];

      const first = await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations,
        schemaVersion,
        correlationId: 'apply-once',
        mutation: { requestId },
      });
      const retry = await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations,
        schemaVersion,
        correlationId: 'apply-once',
        mutation: { requestId },
      });

      expect(retry.revision).toBe(first.revision);
      const stored = await database.query<{ revision: string; versions: number }>({
        text: `SELECT
                 document.revision::text AS revision,
                 (SELECT count(*)::int FROM settings_versions WHERE document_id = document.id) AS versions
               FROM settings_documents AS document WHERE document.id = $1`,
        values: [first.id],
      });
      expect(BigInt(stored[0]?.revision ?? '0')).toBe(first.revision);
      expect(stored[0]?.versions).toBe(1);
    },
    networkTimeoutMs,
  );

  it(
    'refuses one request identifier reused for a different patch',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const requestId = `apply-${uniqueSuffix()}`;

      await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: '',
        mutation: { requestId },
      });

      await expect(
        store.applyDraftPatch({
          actor: owner.actor,
          scope: owner.scope,
          operations: [setting('appearance.theme', 'light')],
          schemaVersion,
          correlationId: '',
          mutation: { requestId },
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ALREADY_EXISTS' });
    },
    networkTimeoutMs,
  );

  it(
    'publishes a draft into exactly one effective document and one new version row',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);

      await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: '',
      });
      const published = await store.publishDraft({
        actor: owner.actor,
        scope: owner.scope,
        schemaVersion,
        correlationId: 'publish-once',
      });

      expect(published.draft).toBe(false);
      expect(published.values).toEqual({ 'appearance.theme': { stringValue: 'dark' } });

      const rows = await database.query<{ scope_type: string; versions: number }>({
        text: `SELECT document.scope_type,
                      (SELECT count(*)::int FROM settings_versions WHERE document_id = document.id) AS versions
               FROM settings_documents AS document
               WHERE document.group_id = $1
               ORDER BY document.scope_type`,
        values: [owner.groupId],
      });
      // The draft row is gone, and only the effective document remains.
      expect(rows.map((row) => row.scope_type)).toEqual(['GROUP']);
      expect(rows[0]?.versions).toBe(1);

      const effectiveOnly = await store.readDocuments({
        actor: owner.actor,
        scopes: [owner.scope],
        includeDraft: true,
      });
      expect(effectiveOnly).toHaveLength(1);
      expect(effectiveOnly[0]?.draft).toBe(false);
    },
    networkTimeoutMs,
  );

  it(
    'empties a document on reset and records a history row that says so',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);

      await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark'), setting('audio.volume', 'loud')],
        schemaVersion,
        correlationId: '',
      });
      await store.publishDraft({
        actor: owner.actor,
        scope: owner.scope,
        schemaVersion,
        correlationId: '',
      });

      const reset = await store.reset({
        actor: owner.actor,
        scope: owner.scope,
        mode: 'ALL',
        target: '',
        schemaVersion,
        correlationId: 'reset-all',
      });

      expect(reset.values).toEqual({});
      const stored = await database.query<{ values: Record<string, unknown> }>({
        text: `SELECT document -> 'values' AS values FROM settings_documents WHERE id = $1`,
        values: [reset.id],
      });
      expect(stored[0]?.values).toEqual({});

      const history = await database.query<{ operation: string; category: string }>({
        text: `SELECT operation, category FROM history_events
               WHERE group_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        values: [owner.groupId],
      });
      expect(history[0]?.operation).toBe('RESET_ALL');
      expect(history[0]?.category).toBe('*');
    },
    networkTimeoutMs,
  );

  it(
    'restores the values a named revision recorded',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);

      await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: '',
      });
      const published = await store.publishDraft({
        actor: owner.actor,
        scope: owner.scope,
        schemaVersion,
        correlationId: '',
      });
      await store.reset({
        actor: owner.actor,
        scope: owner.scope,
        mode: 'ALL',
        target: '',
        schemaVersion,
        correlationId: '',
      });

      const reverted = await store.revertVersion({
        actor: owner.actor,
        scope: owner.scope,
        targetRevision: published.revision,
        schemaVersion,
        correlationId: 'revert',
      });

      expect(reverted.values).toEqual({ 'appearance.theme': { stringValue: 'dark' } });
      expect(reverted.revision).toBe(published.revision + 2n);

      await expect(
        store.revertVersion({
          actor: owner.actor,
          scope: owner.scope,
          targetRevision: 9999n,
          schemaVersion,
          correlationId: '',
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'NOT_FOUND' });
    },
    networkTimeoutMs,
  );

  it(
    'removes a group’s settings documents, versions and history when the group is deleted',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);

      const draft = await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: '',
      });
      await store.publishDraft({
        actor: owner.actor,
        scope: owner.scope,
        schemaVersion,
        correlationId: '',
      });
      const before = await database.query<{ documents: number; versions: number; history: number }>(
        {
          text: `SELECT
                   (SELECT count(*)::int FROM settings_documents WHERE group_id = $1) AS documents,
                   (SELECT count(*)::int FROM settings_versions AS version
                    JOIN settings_documents AS document ON document.id = version.document_id
                    WHERE document.group_id = $1) AS versions,
                   (SELECT count(*)::int FROM history_events WHERE group_id = $1) AS history`,
          values: [owner.groupId],
        },
      );
      expect(before[0]?.documents).toBeGreaterThan(0);
      expect(before[0]?.history).toBeGreaterThan(0);

      await database.query({ text: 'DELETE FROM groups WHERE id = $1', values: [owner.groupId] });

      const after = await database.query<{ documents: number; versions: number; history: number }>({
        text: `SELECT
                 (SELECT count(*)::int FROM settings_documents WHERE group_id = $1) AS documents,
                 (SELECT count(*)::int FROM settings_versions WHERE document_id = $2) AS versions,
                 (SELECT count(*)::int FROM history_events WHERE group_id = $1) AS history`,
        values: [owner.groupId, draft.id],
      });
      expect(after[0]).toEqual({ documents: 0, versions: 0, history: 0 });
    },
    networkTimeoutMs,
  );

  it(
    'refuses a device that is not an active member of the group it addresses',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const stranger = await bootstrapGroup(runtime);

      await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: '',
      });

      // The service refuses a mismatched scope before any statement runs, so
      // this addresses the store directly with an actor whose group is the
      // victim's and whose device is the stranger's. Only the membership join
      // inside the statement can refuse that.
      const forged = { groupId: owner.groupId, deviceId: stranger.actor.deviceId };
      await expect(
        store.applyDraftPatch({
          actor: forged,
          scope: owner.scope,
          operations: [setting('appearance.theme', 'light')],
          schemaVersion,
          correlationId: '',
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });

      expect(
        await store.readDocuments({ actor: forged, scopes: [owner.scope], includeDraft: true }),
      ).toEqual([]);

      const unchanged = await database.query<{ values: Record<string, unknown> }>({
        text: `SELECT document -> 'values' AS values FROM settings_documents
               WHERE group_id = $1 AND scope_type = 'GROUP_DRAFT'`,
        values: [owner.groupId],
      });
      expect(unchanged[0]?.values).toEqual({ 'appearance.theme': { stringValue: 'dark' } });
    },
    networkTimeoutMs,
  );

  it(
    'stops a revoked device from reading or writing settings it could reach a moment earlier',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const second = await pairDevice(runtime, owner);
      const secondActor = { groupId: owner.groupId, deviceId: second.deviceId };

      await store.applyDraftPatch({
        actor: secondActor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: '',
      });
      expect(
        await store.readDocuments({
          actor: secondActor,
          scopes: [owner.scope],
          includeDraft: true,
        }),
      ).toHaveLength(1);

      await runtime.revokeDevice(owner.authenticated, owner.groupId, second.deviceId);

      await expect(
        store.applyDraftPatch({
          actor: secondActor,
          scope: owner.scope,
          operations: [setting('appearance.theme', 'light')],
          schemaVersion,
          correlationId: '',
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
      expect(
        await store.readDocuments({
          actor: secondActor,
          scopes: [owner.scope],
          includeDraft: true,
        }),
      ).toEqual([]);
    },
    networkTimeoutMs,
  );

  it(
    'lets a viewer change its own device settings but not the group’s',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const viewer = await pairDevice(runtime, owner, 'VIEWER');
      const viewerActor = { groupId: owner.groupId, deviceId: viewer.deviceId };

      await expect(
        store.applyDraftPatch({
          actor: viewerActor,
          scope: owner.scope,
          operations: [setting('appearance.theme', 'dark')],
          schemaVersion,
          correlationId: '',
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });

      const own = await store.applyDraftPatch({
        actor: viewerActor,
        scope: { kind: 'DEVICE', resourceId: viewer.deviceId },
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: '',
      });
      expect(own.scope).toEqual({ kind: 'DEVICE', resourceId: viewer.deviceId });
    },
    networkTimeoutMs,
  );

  it(
    'pages a scope’s history newest first and continues from its own cursor',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);

      for (const value of ['one', 'two', 'three']) {
        await store.applyDraftPatch({
          actor: owner.actor,
          scope: owner.scope,
          operations: [setting('appearance.theme', value)],
          schemaVersion,
          correlationId: `history-${value}`,
        });
      }

      const first = await store.listHistory({
        actor: owner.actor,
        scope: owner.scope,
        pageSize: 2,
        cursor: '',
      });
      expect(first.entries).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(first.entries[0]?.revision).toBe(3n);
      expect(first.entries[0]?.operation).toBe('APPLY_DRAFT_PATCH');
      expect(first.entries[0]?.category).toBe('appearance');
      expect(first.entries[0]?.actorDeviceId).toBe(owner.actor.deviceId);

      const next = await store.listHistory({
        actor: owner.actor,
        scope: owner.scope,
        pageSize: 2,
        cursor: first.nextCursor,
      });
      expect(next.entries).toHaveLength(1);
      expect(next.entries[0]?.revision).toBe(1n);
      expect(next.hasMore).toBe(false);
    },
    networkTimeoutMs,
  );

  it(
    'carries a watcher forward on one monotonic watermark across publish cycles',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const watch = async (afterRevision: bigint) =>
        store.pollChanges({ actor: owner.actor, scope: owner.scope, afterRevision });

      expect(await watch(0n)).toEqual([]);

      // A draft is not a watched change: `after_revision` is one number on the
      // wire, and a draft row carries a counter of its own that restarts at 1
      // every time a publish deletes it. A watcher that had advanced past 1
      // would then be blind to every later draft for good.
      await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: 'watch-apply',
      });
      expect(await watch(0n)).toEqual([]);

      await store.publishDraft({
        actor: owner.actor,
        scope: owner.scope,
        schemaVersion,
        correlationId: 'watch-publish',
      });
      const first = await watch(0n);
      expect(first).toHaveLength(1);
      expect(first[0]?.operation).toBe('PUBLISH_DRAFT');
      expect(first[0]?.document.draft).toBe(false);
      const watermark = first[0]?.document.revision ?? 0n;

      // The watcher now carries its watermark forward, which is the only way
      // the property under test can fail: re-polling from zero every time would
      // pass even if the watermark never worked at all.
      expect(await watch(watermark)).toEqual([]);

      // A second publish cycle. The draft restarts at revision 1 below, and the
      // published document must still come back above the watcher's watermark.
      await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'light')],
        schemaVersion,
        correlationId: 'watch-apply-2',
      });
      await store.publishDraft({
        actor: owner.actor,
        scope: owner.scope,
        schemaVersion,
        correlationId: 'watch-publish-2',
      });
      const second = await watch(watermark);
      expect(second).toHaveLength(1);
      expect(second[0]?.operation).toBe('PUBLISH_DRAFT');
      expect(second[0]?.document.revision).toBeGreaterThan(watermark);
      expect(second[0]?.document.values).toMatchObject({
        'appearance.theme': { stringValue: 'light' },
      });
    },
    networkTimeoutMs,
  );

  it(
    'refuses a row for a scope that addresses neither a group nor a device',
    async () => {
      // This is the constraint the service's `INVALID_ARGUMENT` for LOCAL_DRAFT
      // and SESSION_PREVIEW is derived from: the table itself will not hold
      // such a row, so inventing a code path for one would only move the
      // failure later.
      await expect(
        database.query({
          text: `INSERT INTO settings_documents (
                   id, group_id, device_id, scope_type, schema_version, document, revision
                 )
                 VALUES (gen_random_uuid(), NULL, NULL, 'LOCAL_DRAFT', $1, '{}'::jsonb, 1)`,
          values: [schemaVersion],
        }),
      ).rejects.toThrow();
    },
    networkTimeoutMs,
  );

  it(
    'refuses a second version row at a revision the document already recorded',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const draft = await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: '',
      });

      // UNIQUE (document_id, revision) is the only thing standing between two
      // concurrent writers and one revision recorded twice. Proving it rejects
      // is what makes the concurrency scenario above meaningful.
      await expect(
        database.query({
          text: `INSERT INTO settings_versions (
                   id, document_id, revision, patch, correlation_id
                 )
                 VALUES (gen_random_uuid(), $1, $2, '{}'::jsonb, 'duplicate')`,
          values: [draft.id, draft.revision.toString()],
        }),
      ).rejects.toThrow();
    },
    networkTimeoutMs,
  );

  it(
    'refuses a device that names another group instead of quietly serving its own',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      const stranger = await bootstrapGroup(runtime);
      await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: '',
      });

      // Reading bound the requested group id straight into the statement and
      // proved only that the caller was active in its *own* group — which any
      // legitimate device is. Substituting the caller's own scope instead would
      // be worse than refusing: the client would believe it read what it asked
      // for.
      const foreignScope = { kind: 'GROUP', resourceId: owner.groupId } as const;
      await expect(
        store.readDocuments({
          actor: stranger.actor,
          scopes: [foreignScope],
          includeDraft: true,
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
      await expect(
        store.listHistory({ actor: stranger.actor, scope: foreignScope, pageSize: 10, cursor: '' }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
      await expect(
        store.pollChanges({ actor: stranger.actor, scope: foreignScope, afterRevision: 0n }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
      await expect(
        store.applyDraftPatch({
          actor: stranger.actor,
          scope: foreignScope,
          operations: [setting('appearance.theme', 'light')],
          schemaVersion,
          correlationId: '',
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });

      const untouched = await store.readDocuments({
        actor: owner.actor,
        scopes: [owner.scope],
        includeDraft: true,
      });
      expect(untouched[0]?.values).toMatchObject({
        'appearance.theme': { stringValue: 'dark' },
      });
    },
    networkTimeoutMs,
  );

  it(
    'keeps the schema a document was written under when a later patch declares another',
    async () => {
      const runtime = createRuntime();
      const store = createStore(runtime);
      const owner = await bootstrapGroup(runtime);
      await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'dark')],
        schemaVersion,
        correlationId: '',
      });

      // A client running an older build declares its own schema on every
      // request. Adopting it relabelled the group's document as that build's
      // schema, so the next reader could not tell which one the values were
      // written against.
      await store.applyDraftPatch({
        actor: owner.actor,
        scope: owner.scope,
        operations: [setting('appearance.theme', 'light')],
        schemaVersion: 'ancient-build',
        correlationId: '',
      });

      const stored = await database.query<{ schema_version: string }>({
        text: `SELECT schema_version FROM settings_documents
               WHERE group_id = $1 AND scope_type = 'GROUP_DRAFT'`,
        values: [owner.groupId],
      });
      expect(stored[0]?.schema_version).toBe(schemaVersion);
    },
    networkTimeoutMs,
  );

  function createRuntime(): DurablePairedDeviceRuntime {
    return new DurablePairedDeviceRuntime({ database, tokenPepper });
  }

  function createStore(runtime: DurablePairedDeviceRuntime): DurableSettingsStore {
    return new DurableSettingsStore({ database, receipts: runtime.receiptGuard });
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

function setting(path: string, value: string): SettingsPatchOperationInput {
  return { path, value: { stringValue: value }, remove: false };
}

function uniqueSuffix(): string {
  return randomBytes(8).toString('hex');
}
