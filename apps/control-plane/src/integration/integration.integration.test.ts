import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import { Code, type HandlerContext } from '@connectrpc/connect';
import { integrationV1 } from '@gremuchaya/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { DurablePairedDeviceRuntime } from '../sync/durable-runtime.js';
import type { AuthenticatedDevice } from '../sync/runtime.js';

import {
  createIntegrationService,
  type GitHubIntegrationGateway,
  type GitHubIssueOutcome,
  type GitHubIssueRequest,
  type GitHubPullRequestOutcome,
  type GitHubPullRequestQuery,
  type GitHubPullRequestStatus,
  type GitHubTranslationPullRequest,
} from './service.js';
import { DurableIntegrationStore, type CredentialSealer } from './store.js';

/**
 * Real PostgreSQL proof for the integration store.
 *
 * Every scenario here is a property a scripted `SqlClient` cannot show. The
 * credential is unreadable because the sealer ran and the column holds its
 * output; exactly one worker claims a queued job because the row lock
 * serializes the two `UPDATE ... WHERE state = $old` statements and the loser
 * matches nothing; one retry enqueues one job because the receipt claim commits
 * before the statement that completes it; a second proposal for one key is
 * refused because migration 0008's unique index rejects it; the group's rows
 * vanish because the foreign keys cascade. None of that is visible in the
 * statement text.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const tokenPepper = 'integration-token-pepper-with-at-least-thirty-two-characters';

describeIntegration('durable integration store against real PostgreSQL', () => {
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
    'keeps a sealed GitHub credential out of every column of its own row',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const sealer = createAesSealer();
      const store = createStore(runtime, sealer);
      const secret = `ghs_${randomBytes(20).toString('hex')}`;

      const stored = await store.putInstallation({
        groupId: owner.groupId,
        actorDeviceId: owner.authenticated.device.id,
        installationId: uniqueInstallationId(),
        repository: 'gremuchaya/hq',
        credentials: secret,
      });

      const rows = await database.query({
        text: 'SELECT * FROM github_installations WHERE id = $1',
        values: [stored.id],
      });
      expect(rows).toHaveLength(1);
      // The whole row, every column, serialized: the credential is nowhere in
      // it. This is the assertion that would fail if a future change stored the
      // token in `repository`, in a metadata column, or unsealed.
      const serialized = JSON.stringify(rows[0]);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain('gremuchaya/hq');
      // It is sealed, not discarded: the port opens exactly what it wrote.
      expect(await store.openInstallationCredentials(owner.groupId)).toBe(secret);
    },
    networkTimeoutMs,
  );

  it(
    'leaves exactly one claimant when two workers claim one queued job',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const job = await store.enqueueJob({
        groupId: owner.groupId,
        actorDeviceId: owner.authenticated.device.id,
        provider: 'GITHUB',
        kind: 'CREATE_ISSUE',
        payload: { repository: 'gremuchaya/hq' },
      });

      const outcomes = await Promise.allSettled([
        store.transitionJob({
          groupId: owner.groupId,
          jobId: job.id,
          from: 'QUEUED',
          to: 'RUNNING',
        }),
        store.transitionJob({
          groupId: owner.groupId,
          jobId: job.id,
          from: 'QUEUED',
          to: 'RUNNING',
        }),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const refused = outcomes.find((outcome) => outcome.status === 'rejected');
      // The loser must learn it lost. A silent success would let two workers
      // both open an issue for one report.
      expect(refused?.status === 'rejected' ? refused.reason : undefined).toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'FAILED_PRECONDITION',
      });
      const stored = await database.query<{ state: string }>({
        text: 'SELECT state FROM integration_jobs WHERE id = $1',
        values: [job.id],
      });
      expect(stored[0]?.state).toBe('RUNNING');
    },
    networkTimeoutMs,
  );

  it(
    'enqueues one job however many times its request is retried',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const requestId = `enqueue-${uniqueSuffix()}`;
      const input = {
        groupId: owner.groupId,
        actorDeviceId: owner.authenticated.device.id,
        provider: 'GITHUB',
        kind: 'CREATE_ISSUE',
        payload: { repository: 'gremuchaya/hq' },
        mutation: { requestId },
      } as const;

      const first = await store.enqueueJob(input);
      const retry = await store.enqueueJob(input);

      expect(retry.id).toBe(first.id);
      const stored = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM integration_jobs WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(stored[0]?.n).toBe(1);
    },
    networkTimeoutMs,
  );

  it(
    'holds one proposal per group, locale and key, and the same key in another group',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const neighbour = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const translationKey = `overview.title.${uniqueSuffix()}`;

      await store.proposeTranslation({
        groupId: owner.groupId,
        actorDeviceId: owner.authenticated.device.id,
        locale: 'ru-RU',
        translationKey,
        sourceValue: 'Overview',
        proposedValue: 'Обзор',
        placeholders: ['{count}'],
      });

      // `translation_proposals_key_idx` from migration 0008 is what refuses
      // this, not any check this process performs.
      await expect(
        store.proposeTranslation({
          groupId: owner.groupId,
          actorDeviceId: owner.authenticated.device.id,
          locale: 'ru-RU',
          translationKey,
          sourceValue: 'Overview',
          proposedValue: 'Сводка',
        }),
      ).rejects.toMatchObject({ name: 'PairedDeviceRuntimeError', code: 'ALREADY_EXISTS' });

      // The index is scoped to the group, so another group states its own
      // wording for the same key without collision.
      const elsewhere = await store.proposeTranslation({
        groupId: neighbour.groupId,
        actorDeviceId: neighbour.authenticated.device.id,
        locale: 'ru-RU',
        translationKey,
        sourceValue: 'Overview',
        proposedValue: 'Сводка',
      });
      expect(elsewhere.groupId).toBe(neighbour.groupId);
      expect(elsewhere.placeholders).toEqual([]);
      expect(elsewhere.revision).toBe(1n);
    },
    networkTimeoutMs,
  );

  it(
    'refuses to re-open a proposal that reached a terminal status',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime);
      const proposal = await store.proposeTranslation({
        groupId: owner.groupId,
        actorDeviceId: owner.authenticated.device.id,
        locale: 'ru-RU',
        translationKey: `overview.title.${uniqueSuffix()}`,
        sourceValue: 'Overview',
        proposedValue: 'Обзор',
      });

      // Two reviewers rule on the same draft at the same instant. Only the row
      // lock stops the proposal from being both merged and rejected.
      const rulings = await Promise.allSettled([
        store.updateProposal({
          groupId: owner.groupId,
          actorDeviceId: owner.authenticated.device.id,
          proposalId: proposal.id,
          from: 'DRAFT',
          to: 'REJECTED',
        }),
        store.updateProposal({
          groupId: owner.groupId,
          actorDeviceId: owner.authenticated.device.id,
          proposalId: proposal.id,
          from: 'DRAFT',
          to: 'MERGED',
        }),
      ]);
      expect(rulings.filter((ruling) => ruling.status === 'fulfilled')).toHaveLength(1);

      const decided = await database.query<{ status: string; revision: string }>({
        text: 'SELECT status, revision::text AS revision FROM translation_proposals WHERE id = $1',
        values: [proposal.id],
      });
      expect(['MERGED', 'REJECTED']).toContain(decided[0]?.status);
      expect(decided[0]?.revision).toBe('2');

      // A caller still holding the draft view now asks for a declared
      // transition. The statement refuses it because the row is no longer a
      // draft, so the decision on record survives.
      await expect(
        store.updateProposal({
          groupId: owner.groupId,
          actorDeviceId: owner.authenticated.device.id,
          proposalId: proposal.id,
          from: 'DRAFT',
          to: 'PROPOSED',
        }),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'FAILED_PRECONDITION',
      });
      const unchanged = await database.query<{ status: string; revision: string }>({
        text: 'SELECT status, revision::text AS revision FROM translation_proposals WHERE id = $1',
        values: [proposal.id],
      });
      expect(unchanged[0]).toEqual(decided[0]);
    },
    networkTimeoutMs,
  );

  it(
    'refuses an enqueue from a viewer and writes nothing',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const viewer = await pairDevice(runtime, owner, 'VIEWER');
      const store = createStore(runtime);

      await expect(
        store.enqueueJob({
          groupId: owner.groupId,
          actorDeviceId: viewer.deviceId,
          provider: 'GITHUB',
          kind: 'CREATE_ISSUE',
          payload: { repository: 'gremuchaya/hq' },
        }),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'PERMISSION_DENIED',
      });
      const stored = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM integration_jobs WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(stored[0]?.n).toBe(0);
    },
    networkTimeoutMs,
  );

  it(
    'refuses an enqueue from a device revoked after its token was issued',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const editor = await pairDevice(runtime, owner);
      const store = createStore(runtime);
      await store.enqueueJob({
        groupId: owner.groupId,
        actorDeviceId: editor.deviceId,
        provider: 'GITHUB',
        kind: 'CREATE_ISSUE',
        payload: {},
      });

      await runtime.revokeDevice(owner.authenticated, owner.groupId, editor.deviceId);

      // The device's access token is untouched and still inside its lifetime.
      // Only the membership join inside the write refuses it.
      await expect(
        store.enqueueJob({
          groupId: owner.groupId,
          actorDeviceId: editor.deviceId,
          provider: 'GITHUB',
          kind: 'CREATE_ISSUE',
          payload: {},
        }),
      ).rejects.toMatchObject({
        name: 'PairedDeviceRuntimeError',
        code: 'PERMISSION_DENIED',
      });
      const stored = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM integration_jobs WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(stored[0]?.n).toBe(1);
    },
    networkTimeoutMs,
  );

  it(
    'removes a group’s jobs, installations and proposals when the group is deleted',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime, createAesSealer());
      await store.enqueueJob({
        groupId: owner.groupId,
        actorDeviceId: owner.authenticated.device.id,
        provider: 'GITHUB',
        kind: 'CREATE_ISSUE',
        payload: {},
      });
      await store.putInstallation({
        groupId: owner.groupId,
        actorDeviceId: owner.authenticated.device.id,
        installationId: uniqueInstallationId(),
        repository: 'gremuchaya/hq',
        credentials: `ghs_${randomBytes(12).toString('hex')}`,
      });
      await store.proposeTranslation({
        groupId: owner.groupId,
        actorDeviceId: owner.authenticated.device.id,
        locale: 'ru-RU',
        translationKey: `overview.title.${uniqueSuffix()}`,
        sourceValue: 'Overview',
        proposedValue: 'Обзор',
      });

      await database.query({ text: 'DELETE FROM groups WHERE id = $1', values: [owner.groupId] });

      const counts = await database.query<{
        jobs: number;
        installations: number;
        proposals: number;
      }>({
        text: `SELECT
                 (SELECT count(*)::int FROM integration_jobs WHERE group_id = $1) AS jobs,
                 (SELECT count(*)::int FROM github_installations WHERE group_id = $1)
                   AS installations,
                 (SELECT count(*)::int FROM translation_proposals WHERE group_id = $1)
                   AS proposals`,
        values: [owner.groupId],
      });
      expect(counts[0]).toEqual({ jobs: 0, installations: 0, proposals: 0 });
    },
    networkTimeoutMs,
  );

  it(
    'opens one GitHub issue however many times the request is retried',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime, createAesSealer());
      await registerInstallation(store, owner);
      const gateway = new RecordingGateway();
      const service = createIntegrationService({
        runtime,
        store,
        github: gateway,
        issueRepository: 'gremuchaya/hq',
      });

      const drafted = await callMethod(service.buildIssueDraft, 'buildIssueDraft')(
        create(integrationV1.BuildIssueDraftRequestSchema, {
          groupId: { value: owner.groupId },
          problem: 'Тактическая карта не рисует сектор',
          reproduction: 'Открыть /wall/1 и переключить слой',
          screenId: 'wall-1',
          viewport: '1920x1080',
        }),
        handlerContext(owner.accessToken),
      );
      expect(drafted.draft?.repository).toBe('gremuchaya/hq');
      expect(drafted.draft?.bodyMarkdown).toContain('## Reproduction');

      const requestId = `issue-${uniqueSuffix()}`;
      const issueRequest = create(integrationV1.CreateIssueRequestSchema, {
        context: { requestId },
        draft: drafted.draft,
        confirmed: true,
      });
      const first = await callMethod(service.createIssue, 'createIssue')(
        issueRequest,
        handlerContext(owner.accessToken),
      );
      const retry = await callMethod(service.createIssue, 'createIssue')(
        issueRequest,
        handlerContext(owner.accessToken),
      );

      // The retry is answered from the recorded job. Reaching GitHub a second
      // time would open a second issue for one report, which no client can undo.
      expect(gateway.issues).toHaveLength(1);
      expect(gateway.issues[0]?.credentials).toMatch(/^ghs_/u);
      expect(retry).toEqual(first);
      const jobs = await database.query<{ state: string; n: number }>({
        text: `SELECT max(state) AS state, count(*)::int AS n
               FROM integration_jobs WHERE group_id = $1`,
        values: [owner.groupId],
      });
      expect(jobs[0]).toEqual({ state: 'SUCCEEDED', n: 1 });
    },
    networkTimeoutMs,
  );

  it(
    'records a failed GitHub call on the job without quoting the credential',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime, createAesSealer());
      const secret = await registerInstallation(store, owner);
      // A transport failure that quotes the request it failed on is how a
      // bearer token reaches a log or a column. The job must record that the
      // call failed and nothing about what it carried.
      const gateway = new RecordingGateway(new Error(`401 Unauthorized for token ${secret}`));
      const service = createIntegrationService({
        runtime,
        store,
        github: gateway,
        issueRepository: 'gremuchaya/hq',
      });

      await expect(
        callMethod(service.createIssue, 'createIssue')(
          create(integrationV1.CreateIssueRequestSchema, {
            draft: { title: 'Карта пуста', bodyMarkdown: 'Сектор не отрисован' },
            confirmed: true,
          }),
          handlerContext(owner.accessToken),
        ),
      ).rejects.toMatchObject({ code: Code.Unavailable });

      const rows = await database.query({
        text: 'SELECT * FROM integration_jobs WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(rows).toHaveLength(1);
      const serialized = JSON.stringify(rows[0]);
      expect(serialized).toContain('FAILED');
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('401 Unauthorized');
    },
    networkTimeoutMs,
  );

  it(
    'sends nothing for an unconfirmed request or for a viewer',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime, createAesSealer());
      await registerInstallation(store, owner);
      const viewer = await pairDevice(runtime, owner, 'VIEWER');
      const gateway = new RecordingGateway();
      const service = createIntegrationService({
        runtime,
        store,
        github: gateway,
        issueRepository: 'gremuchaya/hq',
      });
      const draft = { title: 'Карта пуста', bodyMarkdown: 'Сектор не отрисован' };

      await expect(
        callMethod(service.createIssue, 'createIssue')(
          create(integrationV1.CreateIssueRequestSchema, { draft, confirmed: false }),
          handlerContext(owner.accessToken),
        ),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition });
      await expect(
        callMethod(service.createIssue, 'createIssue')(
          create(integrationV1.CreateIssueRequestSchema, { draft, confirmed: true }),
          handlerContext(viewer.accessToken),
        ),
      ).rejects.toMatchObject({ code: Code.PermissionDenied });

      expect(gateway.issues).toHaveLength(0);
      const jobs = await database.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM integration_jobs WHERE group_id = $1',
        values: [owner.groupId],
      });
      expect(jobs[0]?.n).toBe(0);
    },
    networkTimeoutMs,
  );

  it(
    'reports a configured provider as ready and an unconfigured one as not configured',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime, createAesSealer());
      const service = createIntegrationService({ runtime, store });
      const read = callMethod(service.getIntegrationStatus, 'getIntegrationStatus');

      const before = await read(
        create(integrationV1.GetIntegrationStatusRequestSchema, {
          groupId: { value: owner.groupId },
          provider: integrationV1.IntegrationProvider.GITHUB,
        }),
        handlerContext(owner.accessToken),
      );
      expect(before.status?.state).toBe(integrationV1.IntegrationState.NOT_CONFIGURED);

      await registerInstallation(store, owner);

      const after = await read(
        create(integrationV1.GetIntegrationStatusRequestSchema, {
          groupId: { value: owner.groupId },
          provider: integrationV1.IntegrationProvider.GITHUB,
        }),
        handlerContext(owner.accessToken),
      );
      expect(after.status?.state).toBe(integrationV1.IntegrationState.READY);
      expect(after.status?.accountLabel).toBe('gremuchaya/hq');
      // Nothing records what the installation granted, so the list stays empty
      // rather than asserting permissions nobody confirmed.
      expect(after.status?.grantedCapabilities).toEqual([]);

      const elsewhere = await read(
        create(integrationV1.GetIntegrationStatusRequestSchema, {
          groupId: { value: owner.groupId },
          provider: integrationV1.IntegrationProvider.VERCEL,
        }),
        handlerContext(owner.accessToken),
      );
      expect(elsewhere.status?.state).toBe(integrationV1.IntegrationState.NOT_CONFIGURED);
    },
    networkTimeoutMs,
  );

  it(
    'moves a proposal to review through the pull request it opened',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const store = createStore(runtime, createAesSealer());
      await registerInstallation(store, owner);
      const gateway = new RecordingGateway();
      const service = createIntegrationService({
        runtime,
        store,
        github: gateway,
        issueRepository: 'gremuchaya/hq',
      });

      const proposed = await callMethod(
        service.createTranslationProposal,
        'createTranslationProposal',
      )(
        create(integrationV1.CreateTranslationProposalRequestSchema, {
          proposal: {
            locale: 'ru-RU',
            key: `overview.title.${uniqueSuffix()}`,
            sourceValue: 'Overview',
            proposedValue: 'Обзор',
            placeholders: ['{count}'],
          },
        }),
        handlerContext(owner.accessToken),
      );
      expect(proposed.proposal?.revision?.number).toBe(1n);
      const proposalId = proposed.proposal?.id?.value ?? '';
      expect(proposalId).not.toBe('');

      const requestId = `pull-request-${uniqueSuffix()}`;
      const pullRequest = create(integrationV1.CreateTranslationPullRequestRequestSchema, {
        context: { requestId },
        proposalId: { value: proposalId },
        confirmed: true,
      });
      const opened = await callMethod(
        service.createTranslationPullRequest,
        'createTranslationPullRequest',
      )(pullRequest, handlerContext(owner.accessToken));
      expect(opened.pullRequestNumber).toBe(9n);
      expect(opened.draft).toBe(true);

      const reviewed = await database.query<{ status: string; url: string; revision: string }>({
        text: `SELECT status, pull_request_url AS url, revision::text AS revision
               FROM translation_proposals WHERE id = $1`,
        values: [proposalId],
      });
      // The proposal is under review only because a pull request exists, and
      // the row names the review it belongs to.
      expect(reviewed[0]?.status).toBe('PROPOSED');
      expect(reviewed[0]?.url).toBe(opened.url);
      expect(reviewed[0]?.revision).toBe('2');

      const status = await callMethod(service.getPullRequestStatus, 'getPullRequestStatus')(
        create(integrationV1.GetPullRequestStatusRequestSchema, {
          repository: 'gremuchaya/hq',
          pullRequestNumber: 9n,
        }),
        handlerContext(owner.accessToken),
      );
      expect(status.state).toBe(integrationV1.PullRequestState.OPEN);
    },
    networkTimeoutMs,
  );

  it(
    'builds a prefilled issue address that stays inside an address bar',
    async () => {
      const runtime = createRuntime();
      const owner = await bootstrapGroup(runtime);
      const service = createIntegrationService({ runtime, issueRepository: 'gremuchaya/hq' });

      const opened = await callMethod(service.openPrefilledIssue, 'openPrefilledIssue')(
        create(integrationV1.OpenPrefilledIssueRequestSchema, {
          draft: {
            title: 'Карта пуста',
            // Cyrillic costs nine bytes per character once encoded, which is
            // exactly the case a raw length check would let through. The emoji
            // is the other case: cutting between its two UTF-16 units left a
            // lone surrogate, and encoding one throws inside the loop that was
            // meant to shorten the body.
            bodyMarkdown: `Сектор не отрисован 🛰. `.repeat(2000),
            labels: ['hq'],
            repository: 'gremuchaya/hq',
          },
        }),
        handlerContext(owner.accessToken),
      );

      const url = opened.url ?? '';
      expect(url.startsWith('https://github.com/gremuchaya/hq/issues/new')).toBe(true);
      expect(url.length).toBeLessThanOrEqual(8000);
      expect(decodeURIComponent(url)).toContain('truncated');
    },
    networkTimeoutMs,
  );

  async function registerInstallation(
    store: DurableIntegrationStore,
    owner: { readonly groupId: string; readonly authenticated: AuthenticatedDevice },
  ): Promise<string> {
    const secret = `ghs_${randomBytes(20).toString('hex')}`;
    await store.putInstallation({
      groupId: owner.groupId,
      actorDeviceId: owner.authenticated.device.id,
      installationId: uniqueInstallationId(),
      repository: 'gremuchaya/hq',
      credentials: secret,
    });
    return secret;
  }

  function createRuntime(): DurablePairedDeviceRuntime {
    return new DurablePairedDeviceRuntime({ database, tokenPepper });
  }

  function createStore(
    runtime: DurablePairedDeviceRuntime,
    sealer?: CredentialSealer,
  ): DurableIntegrationStore {
    return new DurableIntegrationStore({
      database,
      receipts: runtime.receiptGuard,
      ...(sealer === undefined ? {} : { credentialSealer: sealer }),
    });
  }

  async function bootstrapGroup(runtime: DurablePairedDeviceRuntime): Promise<{
    readonly groupId: string;
    readonly accessToken: string;
    readonly authenticated: AuthenticatedDevice;
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
    return {
      groupId: created.group.id,
      accessToken: created.session.accessToken,
      authenticated: await runtime.authenticateAccessToken(created.session.accessToken),
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

/**
 * Authenticated encryption with the key held in this closure, which is the
 * whole point of the port: the store is handed the ability to seal and open
 * and never the material that does it.
 */
function createAesSealer(): CredentialSealer {
  const key = randomBytes(32);
  return {
    seal(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Uint8Array.from(Buffer.concat([iv, cipher.getAuthTag(), body]));
    },
    open(sealed) {
      const bytes = Buffer.from(sealed);
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    },
  };
}

/** `github_installations.installation_id` is UNIQUE across the whole table. */
function uniqueInstallationId(): bigint {
  return BigInt(`0x${randomBytes(6).toString('hex')}`);
}

function uniqueSuffix(): string {
  return randomBytes(8).toString('hex');
}

/**
 * The handler surface these methods touch: one request header and an abort
 * signal. Building a full `HandlerContext` would assert nothing more.
 */
function handlerContext(accessToken: string): HandlerContext {
  return {
    requestHeader: new Headers({ authorization: `Bearer ${accessToken}` }),
    signal: new AbortController().signal,
  } as unknown as HandlerContext;
}

/**
 * `createIntegrationService` returns a `Partial`, so a method this suite calls
 * has to be asserted present rather than assumed: one silently missing would
 * otherwise look like a passing test.
 */
function callMethod<Method>(method: Method | undefined, name: string): Method {
  if (method === undefined) throw new Error(`IntegrationService.${name} is not implemented`);
  return method;
}

/** Stands in for GitHub. It records what it was asked and never leaves the process. */
class RecordingGateway implements GitHubIntegrationGateway {
  readonly issues: GitHubIssueRequest[] = [];
  readonly #failure: Error | undefined;

  constructor(failure?: Error) {
    this.#failure = failure;
  }

  createIssue(request: GitHubIssueRequest): GitHubIssueOutcome {
    this.issues.push(request);
    if (this.#failure !== undefined) throw this.#failure;
    return { url: `https://github.com/${request.repository}/issues/7`, issueNumber: 7n };
  }

  createPullRequest(request: GitHubTranslationPullRequest): GitHubPullRequestOutcome {
    if (this.#failure !== undefined) throw this.#failure;
    return {
      url: `https://github.com/${request.repository}/pull/9`,
      pullRequestNumber: 9n,
      draft: true,
    };
  }

  readPullRequest(query: GitHubPullRequestQuery): GitHubPullRequestStatus {
    if (this.#failure !== undefined) throw this.#failure;
    return {
      state: 'OPEN',
      url: `https://github.com/${query.repository}/pull/${query.pullRequestNumber.toString()}`,
      updatedAt: new Date('2026-08-24T09:00:00.000Z'),
    };
  }
}
