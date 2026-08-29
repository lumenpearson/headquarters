import { create } from '@bufbuild/protobuf';
import { Code, type HandlerContext } from '@connectrpc/connect';
import { integrationV1 } from '@gremuchaya/protocol';
import { describe, expect, it } from 'vitest';

import { PairedDeviceRuntime } from '../sync/runtime.js';

import { createIntegrationService, type GitHubIntegrationGateway } from './service.js';
import type {
  GitHubInstallation,
  IntegrationJob,
  IntegrationStore,
  IntegrationStatusRecord,
  TranslationProposalRecord,
} from './store.js';

/**
 * The three refusals that stand between a client and the group's GitHub
 * credential.
 *
 * They cannot be shown against the live database: two of them are about what
 * reaches an outbound call and what the caller is told when it fails, and the
 * third is about an irreversible side effect that must not happen at all. What
 * the live suite proves is the storage underneath them.
 */
const tokenPepper = 'integration-service-token-pepper-with-thirty-two-characters';
const installedRepository = 'gremuchaya/headquarters';

describe('IntegrationService and the group credential', () => {
  it('refuses a repository the group never installed, before any call is made', async () => {
    const reached: string[] = [];
    const { service, headers } = await serviceWith({
      gateway: gatewayThat(() => {
        reached.push('createIssue');
        return { url: 'https://example.invalid/1', issueNumber: 1n };
      }),
    });

    await expect(
      service.createIssue?.(
        create(integrationV1.CreateIssueRequestSchema, {
          draft: { repository: 'someone-else/private', title: 'Report', bodyMarkdown: 'x' },
          confirmed: true,
        }),
        headers,
      ),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    // The credential is scoped to the installation's repository; a request that
    // named another was spending the group's authority somewhere it never
    // granted.
    expect(reached).toEqual([]);
  });

  it('replaces whatever the gateway says with a message of its own', async () => {
    const { service, headers } = await serviceWith({
      gateway: gatewayThat(() => {
        // A transport error quotes the request it failed on, headers included,
        // and the installation credential travels in a header.
        throw new Error('POST /repos failed: authorization: Bearer ghp_secret_value');
      }),
    });

    // The handler may answer synchronously, so the call is wrapped rather than
    // assumed to be a promise before its rejection is captured.
    const failure = await Promise.resolve(
      service.createIssue?.(
        create(integrationV1.CreateIssueRequestSchema, {
          draft: { repository: installedRepository, title: 'Report', bodyMarkdown: 'x' },
          confirmed: true,
        }),
        headers,
      ),
    ).catch((error: unknown) => error);

    expect(String(failure)).not.toContain('ghp_secret_value');
    expect(String(failure)).toContain('The GitHub request did not complete');
  });

  it('does not open a pull request for a proposal that is already settled', async () => {
    const reached: string[] = [];
    const { service, headers } = await serviceWith({
      proposalStatus: 'MERGED',
      gateway: gatewayThat(() => {
        reached.push('createPullRequest');
        return { url: 'https://example.invalid/pr/1', pullRequestNumber: 1n, draft: false };
      }),
    });

    await expect(
      service.createTranslationPullRequest?.(
        create(integrationV1.CreateTranslationPullRequestRequestSchema, {
          proposalId: { value: 'proposal-01' },
          confirmed: true,
        }),
        headers,
      ),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    // The guarded update afterwards is what makes the transition safe under
    // concurrency; it cannot take back a pull request GitHub has already opened.
    expect(reached).toEqual([]);
  });
});

async function serviceWith(options: {
  readonly gateway: GitHubIntegrationGateway;
  readonly proposalStatus?: TranslationProposalRecord['status'];
}) {
  const runtime = new PairedDeviceRuntime({ tokenPepper });
  const created = runtime.createGroup({
    name: 'Integration group',
    initialDevice: {
      name: 'Primary',
      publicKey: 'ed25519:integration',
      platform: 'windows',
      applicationVersion: '0.1.0',
    },
  });
  const service = createIntegrationService({
    runtime,
    store: scriptedStore(created.group.id, options.proposalStatus ?? 'DRAFT'),
    github: options.gateway,
    issueRepository: installedRepository,
  });
  return { service, headers: handlerContext(created.session.accessToken) };
}

function gatewayThat(
  respond: () => { url: string; issueNumber?: bigint; pullRequestNumber?: bigint; draft?: boolean },
): GitHubIntegrationGateway {
  return {
    createIssue: () => {
      const outcome = respond();
      return { url: outcome.url, issueNumber: outcome.issueNumber ?? 1n };
    },
    createPullRequest: () => {
      const outcome = respond();
      return {
        url: outcome.url,
        pullRequestNumber: outcome.pullRequestNumber ?? 1n,
        draft: outcome.draft ?? false,
      };
    },
    readPullRequest: () => {
      respond();
      return { state: 'OPEN', url: 'https://example.invalid/pr/1', updatedAt: new Date(0) };
    },
  };
}

function scriptedStore(
  groupId: string,
  proposalStatus: TranslationProposalRecord['status'],
): IntegrationStore {
  const installation: GitHubInstallation = {
    id: 'installation-01',
    groupId,
    installationId: 1n,
    repository: installedRepository,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const job: IntegrationJob = {
    id: 'job-01',
    groupId,
    provider: 'GITHUB',
    kind: 'CREATE_ISSUE',
    state: 'QUEUED',
    payload: {},
    result: undefined,
    correlationId: '',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const proposal: TranslationProposalRecord = {
    id: 'proposal-01',
    groupId,
    locale: 'en',
    translationKey: 'overview.title',
    sourceValue: 'Сводка',
    proposedValue: 'Overview',
    englishReference: 'Overview',
    placeholders: [],
    transliteration: 'Svodka',
    pullRequestUrl: '',
    revision: 1n,
    status: proposalStatus,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  return {
    enqueueJob: () => Promise.resolve(job),
    transitionJob: () => Promise.resolve({ ...job, state: 'RUNNING' }),
    readJob: () => Promise.resolve(job),
    putInstallation: () => Promise.resolve(installation),
    readInstallation: () => Promise.resolve(installation),
    openInstallationCredentials: () => Promise.resolve('ghp_secret_value'),
    proposeTranslation: () => Promise.resolve(proposal),
    updateProposal: () => Promise.resolve(proposal),
    readProposal: () => Promise.resolve(proposal),
    readStatus: () =>
      Promise.resolve({
        provider: 'GITHUB',
        configured: true,
        accountLabel: '',
        latestJobKind: 'CREATE_ISSUE',
        latestJobState: 'QUEUED',
        checkedAt: new Date(0),
      } satisfies IntegrationStatusRecord),
  };
}

function handlerContext(accessToken: string): HandlerContext {
  const headers = new Headers();
  headers.set('authorization', `Bearer ${accessToken}`);
  return {
    requestHeader: headers,
    signal: new AbortController().signal,
  } as unknown as HandlerContext;
}
