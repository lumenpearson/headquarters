import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from '../db/database.js';
import { MutationReceiptGuard } from '../sync/receipt-guard.js';

import { DurableIntegrationStore, type CredentialSealer } from './store.js';

/**
 * Statement shape, parameter binding and decoding for the integration store.
 *
 * A scripted `SqlClient` returns whatever it is told to and never executes SQL,
 * so nothing here observes a lock, a race, a constraint or a cascade. It cannot:
 * `FOR UPDATE OF job` is a string to this suite. What it can prove is that the
 * statement issued carries those guards, that the credential never becomes a
 * parameter, and that a row decodes into the declared vocabulary. The
 * properties themselves are proved in `integration.integration.test.ts` against
 * a real PostgreSQL engine.
 */

const groupId = '018b2a02-0000-7000-8000-000000000001';
const deviceId = '018b2a02-0000-7000-8000-000000000002';
const jobId = '018b2a02-0000-7000-8000-000000000010';
const proposalId = '018b2a02-0000-7000-8000-000000000011';
const installationId = '018b2a02-0000-7000-8000-000000000012';
const now = new Date('2026-08-24T09:00:00.000Z');
const pepper = 'integration-test-pepper-with-at-least-thirty-two-characters';

describe('durable integration store', () => {
  it('enqueues a job behind a membership re-check in one parameterized statement', async () => {
    const database = new ScriptedSqlClient([[{ receipt_claimed: true, job: jobRow() }]]);
    const store = createStore(database);

    const job = await store.enqueueJob({
      groupId,
      actorDeviceId: deviceId,
      provider: 'GITHUB',
      kind: 'CREATE_ISSUE',
      payload: { repository: 'gremuchaya/hq' },
      correlationId: 'correlation-1',
    });

    expect(job).toMatchObject({ id: jobId, state: 'QUEUED', provider: 'GITHUB' });
    expect(job.payload).toEqual({ repository: 'gremuchaya/hq' });
    expect(job.result).toBeUndefined();
    expect(database.transactions).toHaveLength(0);
    expect(database.queries).toHaveLength(1);

    const statement = requireStatement(database, 0);
    expect(statement.text).toContain('authorized_actor AS MATERIALIZED');
    expect(statement.text).toContain('FOR UPDATE OF membership');
    expect(statement.text).toContain("devices.status <> 'REVOKED'");
    expect(statement.text).toContain('membership.revoked_at IS NULL');
    expect(statement.text).toContain('INSERT INTO integration_jobs AS job');
    // The role list travels as a bound parameter, so the accepted roles cannot
    // be widened by anything the caller sends.
    expect(statement.values).toContain(JSON.stringify(['EDITOR', 'ADMIN']));
    expect(statement.values).toContain('QUEUED');
    expect(statement.values).toContain(JSON.stringify({ repository: 'gremuchaya/hq' }));
    expect(statement.text).not.toContain('gremuchaya/hq');
  });

  it('refuses an enqueue that produced no row as a membership failure', async () => {
    const database = new ScriptedSqlClient([[{ receipt_claimed: true, job: null }]]);

    await expect(
      createStore(database).enqueueJob({
        groupId,
        actorDeviceId: deviceId,
        provider: 'GITHUB',
        kind: 'CREATE_ISSUE',
        payload: {},
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'PERMISSION_DENIED' });
  });

  it('claims a receipt before the mutation and completes it inside the same statement', async () => {
    const database = new ScriptedSqlClient([
      [{ receipt_claimed: 'request-hash' }],
      [{ receipt_claimed: true, job: jobRow() }],
    ]);
    const store = createStore(database);

    await store.enqueueJob({
      groupId,
      actorDeviceId: deviceId,
      provider: 'GITHUB',
      kind: 'CREATE_ISSUE',
      payload: {},
      mutation: { requestId: 'enqueue-1' },
    });

    expect(database.queries).toHaveLength(2);
    const claim = requireStatement(database, 0);
    expect(claim.text).toContain('INSERT INTO mutation_receipts');
    expect(claim.values).toContain('ENQUEUE_INTEGRATION_JOB');
    // The request identifier itself is hashed; the raw value must not reach a
    // column or a parameter.
    expect(claim.values).not.toContain('enqueue-1');
    const mutation = requireStatement(database, 1);
    expect(mutation.text).toContain('locked_receipt AS MATERIALIZED');
    expect(mutation.text).toContain('completed_receipt AS (');
    expect(mutation.text).toContain('resource_id = enqueued_job.id');
  });

  it('moves a job only from the state the caller declared', async () => {
    const database = new ScriptedSqlClient([
      [{ observed_state: 'QUEUED', job: jobRow({ state: 'RUNNING' }) }],
    ]);

    const moved = await createStore(database).transitionJob({
      groupId,
      jobId,
      from: 'QUEUED',
      to: 'RUNNING',
    });

    expect(moved.state).toBe('RUNNING');
    const statement = requireStatement(database, 0);
    expect(statement.text).toContain('locked_job AS MATERIALIZED');
    expect(statement.text).toContain('FOR UPDATE OF job');
    expect(statement.text).toContain('AND locked_job.state = $4');
    expect(statement.values?.[2]).toBe('RUNNING');
    expect(statement.values?.[3]).toBe('QUEUED');
  });

  it('reads a job that moved out from under it as a refused transition, not a lost write', async () => {
    const database = new ScriptedSqlClient([[{ observed_state: 'RUNNING', job: null }]]);

    await expect(
      createStore(database).transitionJob({ groupId, jobId, from: 'QUEUED', to: 'RUNNING' }),
    ).rejects.toMatchObject({
      name: 'PairedDeviceRuntimeError',
      code: 'FAILED_PRECONDITION',
      message: 'The integration job is RUNNING and cannot move to RUNNING.',
    });
  });

  it('separates a missing job from a refused transition', async () => {
    const database = new ScriptedSqlClient([[{ observed_state: null, job: null }]]);

    await expect(
      createStore(database).transitionJob({ groupId, jobId, from: 'QUEUED', to: 'RUNNING' }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'NOT_FOUND' });
  });

  it('refuses an undeclared job transition before it reaches the database', async () => {
    const database = new ScriptedSqlClient([]);

    await expect(
      createStore(database).transitionJob({
        groupId,
        jobId,
        from: 'SUCCEEDED',
        to: 'QUEUED',
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'INVALID_ARGUMENT' });
    expect(database.queries).toHaveLength(0);
  });

  it('refuses to store an installation when no credential sealer is configured', async () => {
    const database = new ScriptedSqlClient([]);
    const store = new DurableIntegrationStore({ database, now: () => now });

    await expect(
      store.putInstallation({
        groupId,
        actorDeviceId: deviceId,
        installationId: 42n,
        repository: 'gremuchaya/hq',
        credentials: 'ghs_never_stored',
      }),
    ).rejects.toMatchObject({
      name: 'PairedDeviceRuntimeError',
      code: 'FAILED_PRECONDITION',
      message: expect.stringContaining('credentialSealer') as unknown as string,
    });
    // Nothing was attempted: refusing after opening a statement would be a
    // plaintext token one bug away from a parameter list.
    expect(database.queries).toHaveLength(0);
  });

  it('binds the sealed credential and never the plaintext', async () => {
    const secret = 'ghs_scripted_secret_value';
    const database = new ScriptedSqlClient([
      [{ receipt_claimed: true, actor_authorized: true, installation: installationRow() }],
    ]);
    const store = createStore(database, reversingSealer());

    const stored = await store.putInstallation({
      groupId,
      actorDeviceId: deviceId,
      installationId: 42n,
      repository: 'gremuchaya/hq',
      credentials: secret,
    });

    expect(stored.installationId).toBe(42n);
    const statement = requireStatement(database, 0);
    expect(statement.text).toContain('INSERT INTO github_installations AS installation');
    expect(statement.text).toContain('ON CONFLICT (installation_id) DO UPDATE');
    expect(statement.text).toContain('WHERE installation.group_id = EXCLUDED.group_id');
    expect(statement.values).toContain(JSON.stringify(['ADMIN']));
    // The credential is in the statement only as sealed bytes, and the
    // projection never returns the column at all.
    expect(JSON.stringify(statement)).not.toContain(secret);
    expect(statement.text).not.toContain('RETURNING installation.encrypted_credentials');
    const sealed = statement.values?.[8];
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(sealed as Uint8Array).toString('utf8')).toBe([...secret].reverse().join(''));
  });

  it('opens a stored credential only when asked for it by name', async () => {
    const secret = 'ghs_scripted_secret_value';
    const sealed = Buffer.from([...secret].reverse().join(''), 'utf8');
    const database = new ScriptedSqlClient([[{ encrypted_credentials: Uint8Array.from(sealed) }]]);

    const opened = await createStore(database, reversingSealer()).openInstallationCredentials(
      groupId,
    );

    expect(opened).toBe(secret);
    expect(requireStatement(database, 0).text).toContain('encrypted_credentials');
  });

  it('proposes a translation with its placeholders bound as data', async () => {
    const database = new ScriptedSqlClient([[{ receipt_claimed: true, proposal: proposalRow() }]]);

    const proposal = await createStore(database).proposeTranslation({
      groupId,
      actorDeviceId: deviceId,
      locale: 'ru-RU',
      translationKey: 'overview.title',
      sourceValue: 'Overview',
      proposedValue: 'Обзор',
      placeholders: ['{count}'],
    });

    expect(proposal).toMatchObject({ id: proposalId, status: 'DRAFT', revision: 1n });
    expect(proposal.placeholders).toEqual(['{count}']);
    const statement = requireStatement(database, 0);
    expect(statement.text).toContain('INSERT INTO translation_proposals AS proposal');
    // No ON CONFLICT: migration 0008's unique index is what refuses a second
    // proposal for one key, and swallowing that would let two operators
    // overwrite each other silently.
    expect(statement.text).not.toContain('ON CONFLICT');
    expect(statement.text).toContain('ARRAY(SELECT jsonb_array_elements_text($12::jsonb))');
    expect(statement.values).toContain(JSON.stringify(['{count}']));
  });

  it('guards the append-only status inside the statement that writes it', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          receipt_claimed: true,
          actor_authorized: true,
          observed_status: 'DRAFT',
          proposal: proposalRow({ status: 'PROPOSED', revision: '2' }),
        },
      ],
    ]);

    const updated = await createStore(database).updateProposal({
      groupId,
      actorDeviceId: deviceId,
      proposalId,
      from: 'DRAFT',
      to: 'PROPOSED',
      pullRequestUrl: 'https://github.com/gremuchaya/hq/pull/7',
    });

    expect(updated).toMatchObject({ status: 'PROPOSED', revision: 2n });
    const statement = requireStatement(database, 0);
    expect(statement.text).toContain('locked_proposal AS MATERIALIZED');
    expect(statement.text).toContain('FOR UPDATE OF proposal');
    expect(statement.text).toContain('AND locked_proposal.status = $8');
    expect(statement.text).toContain(
      'AND locked_proposal.status NOT IN (SELECT jsonb_array_elements_text($11::jsonb))',
    );
    expect(statement.values).toContain(JSON.stringify(['MERGED', 'REJECTED']));
  });

  it('refuses to re-open a terminal proposal before it reaches the database', async () => {
    const database = new ScriptedSqlClient([]);

    await expect(
      createStore(database).updateProposal({
        groupId,
        actorDeviceId: deviceId,
        proposalId,
        from: 'MERGED',
        to: 'DRAFT',
      }),
    ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'INVALID_ARGUMENT' });
    expect(database.queries).toHaveLength(0);
  });

  it('reports a provider as degraded when its newest job failed', async () => {
    const database = new ScriptedSqlClient([
      [
        {
          repository: 'gremuchaya/hq',
          latest_job_kind: 'CREATE_ISSUE',
          latest_job_state: 'FAILED',
        },
      ],
    ]);

    const status = await createStore(database).readStatus(groupId, deviceId, 'GITHUB');

    expect(status).toMatchObject({
      provider: 'GITHUB',
      configured: true,
      accountLabel: 'gremuchaya/hq',
      latestJobState: 'FAILED',
    });
    expect(requireStatement(database, 0).text).toContain('active_member AS');
  });

  it('refuses a status read for a device with no active membership', async () => {
    const database = new ScriptedSqlClient([[]]);

    await expect(
      createStore(database).readStatus(groupId, deviceId, 'GITHUB'),
    ).rejects.toMatchObject({
      name: 'PairedDeviceRuntimeError',
      code: 'PERMISSION_DENIED',
    });
  });

  it('rejects a database row whose state is outside the declared vocabulary', async () => {
    const database = new ScriptedSqlClient([
      [{ receipt_claimed: true, job: jobRow({ state: 'PAUSED' }) }],
    ]);

    await expect(
      createStore(database).enqueueJob({
        groupId,
        actorDeviceId: deviceId,
        provider: 'GITHUB',
        kind: 'CREATE_ISSUE',
        payload: {},
      }),
      // A malformed row is a defect in this repository, not a client outcome,
      // so it stays a plain Error and never becomes a Connect status code.
    ).rejects.toThrowError(/unknown integration job state/u);
  });
});

function createStore(database: SqlClient, sealer?: CredentialSealer): DurableIntegrationStore {
  return new DurableIntegrationStore({
    database,
    receipts: new MutationReceiptGuard({
      database,
      hashReceipt: (payload) => createHmac('sha256', pepper).update(payload).digest('base64url'),
      tokenHashVersion: 'v1',
      receiptLifetimeMs: 86_400_000,
      now: () => now,
    }),
    now: () => now,
    ...(sealer === undefined ? {} : { credentialSealer: sealer }),
  });
}

/**
 * A deliberately transparent seal. It proves the store hands the plaintext to
 * the port and binds only what the port returned; a real deployment injects
 * authenticated encryption whose key never leaves its closure.
 */
function reversingSealer(): CredentialSealer {
  return {
    seal: (plaintext) => Uint8Array.from(Buffer.from([...plaintext].reverse().join(''), 'utf8')),
    open: (sealed) => [...Buffer.from(sealed).toString('utf8')].reverse().join(''),
  };
}

function jobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: jobId,
    group_id: groupId,
    provider: 'GITHUB',
    kind: 'CREATE_ISSUE',
    state: 'QUEUED',
    payload: { repository: 'gremuchaya/hq' },
    result: null,
    correlation_id: 'correlation-1',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

function installationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: installationId,
    group_id: groupId,
    installation_id: '42',
    repository: 'gremuchaya/hq',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

function proposalRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: proposalId,
    group_id: groupId,
    locale: 'ru-RU',
    translation_key: 'overview.title',
    source_value: 'Overview',
    proposed_value: 'Обзор',
    english_reference: 'Overview',
    placeholders: ['{count}'],
    transliteration: null,
    revision: '1',
    status: 'DRAFT',
    pull_request_url: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

function requireStatement(database: ScriptedSqlClient, index: number): SqlStatement {
  const statement = database.queries[index];
  if (statement === undefined) throw new Error(`No statement was issued at index ${String(index)}`);
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
