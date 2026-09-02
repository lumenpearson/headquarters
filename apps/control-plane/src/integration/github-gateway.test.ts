import { describe, expect, it } from 'vitest';

import { loadControlPlaneConfig, type ControlPlaneGitHubConfig } from '../config.js';

import {
  GitHubBackendError,
  createGitHubRestGateway,
  type GitHubFetch,
  type GitHubFetchRequest,
} from './github-gateway.js';

/**
 * The gateway against a scripted GitHub.
 *
 * What a scripted server can prove: which URL, method, headers and body each
 * operation sends, in what order, how each documented answer is read, and that
 * neither a returned value nor an error ever carries the credential. What it
 * cannot prove is that github.com accepts the request — that needs a real
 * token, which this repository does not hold
 * (`docs/release/known-limitations.md`).
 */
const deploymentToken = 'ghp_deployment_token_that_must_not_leak_0001';
const groupCredential = 'ghs_group_installation_credential_0002';
const repository = 'gremuchaya/headquarters';

function config(overrides: Readonly<Record<string, string>> = {}): ControlPlaneGitHubConfig {
  const github = loadControlPlaneConfig({
    HQ_CONTROL_PLANE_GITHUB_TOKEN: deploymentToken,
    HQ_CONTROL_PLANE_GITHUB_REPOSITORY: repository,
    ...overrides,
  }).github;
  if (github === undefined) throw new Error('GitHub configuration expected');
  return github;
}

interface RecordedCall {
  readonly url: string;
  readonly request: GitHubFetchRequest;
}

function scriptedFetch(answers: readonly { readonly status: number; readonly body?: string }[]): {
  readonly fetch: GitHubFetch;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = [...answers];
  return {
    calls,
    fetch: (url, request) => {
      calls.push({ url, request });
      const answer = queue.shift();
      if (answer === undefined) throw new Error(`unexpected GitHub call: ${request.method} ${url}`);
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        text: () => Promise.resolve(answer.body ?? ''),
      };
    },
  };
}

/** The five answers a translation pull request needs, in the order it asks. */
const pullRequestScript = [
  { status: 200, body: JSON.stringify({ default_branch: 'main' }) },
  {
    status: 200,
    body: JSON.stringify({ object: { sha: 'basesha0000000000000000000000000000000a' } }),
  },
  { status: 201, body: JSON.stringify({ ref: 'refs/heads/x' }) },
  { status: 404, body: JSON.stringify({ message: 'Not Found' }) },
  { status: 201, body: JSON.stringify({ content: { path: 'x' } }) },
  {
    status: 201,
    body: JSON.stringify({
      html_url: `https://github.com/${repository}/pull/42`,
      number: 42,
      draft: true,
    }),
  },
] as const;

const proposal = {
  repository,
  locale: 'ru',
  translationKey: 'nav.map',
  sourceValue: 'Map',
  proposedValue: 'Карта',
  credentials: groupCredential,
};

describe('GitHub gateway: issues', () => {
  it('posts the draft to the repository and reads the issue back', async () => {
    const scripted = scriptedFetch([
      {
        status: 201,
        body: JSON.stringify({ html_url: `https://github.com/${repository}/issues/7`, number: 7 }),
      },
    ]);
    const gateway = createGitHubRestGateway(config(), { fetch: scripted.fetch });

    const outcome = await gateway.createIssue({
      repository,
      title: 'The map is blank',
      bodyMarkdown: '## Problem\n\nblank',
      labels: ['hq', 'report'],
      credentials: groupCredential,
    });

    expect(outcome).toEqual({
      url: `https://github.com/${repository}/issues/7`,
      issueNumber: 7n,
    });
    const call = scripted.calls[0];
    expect(call?.url).toBe(`https://api.github.com/repos/${repository}/issues`);
    expect(call?.request.method).toBe('POST');
    expect(JSON.parse(call?.request.body ?? '{}')).toEqual({
      title: 'The map is blank',
      body: '## Problem\n\nblank',
      labels: ['hq', 'report'],
    });
  });

  it('carries the credential it was handed, in the Authorization header and nowhere else', async () => {
    const scripted = scriptedFetch([
      {
        status: 201,
        body: JSON.stringify({ html_url: `https://github.com/${repository}/issues/7`, number: 7 }),
      },
    ]);
    const gateway = createGitHubRestGateway(config(), { fetch: scripted.fetch });

    await gateway.createIssue({
      repository,
      title: 'Report',
      bodyMarkdown: 'x',
      labels: [],
      credentials: groupCredential,
    });

    const call = scripted.calls[0];
    expect(call?.request.headers.authorization).toBe(`Bearer ${groupCredential}`);
    expect(call?.request.headers.accept).toBe('application/vnd.github+json');
    expect(call?.request.headers['x-github-api-version']).toBe('2022-11-28');
    // The gateway holds no credential of its own: the deployment token stays
    // in the configuration closure unless a caller opens it and hands it over.
    expect(JSON.stringify(call)).not.toContain(deploymentToken);
    expect(call?.url).not.toContain(groupCredential);
    expect(call?.request.body ?? '').not.toContain(groupCredential);
    // An empty label list is omitted rather than sent as [], which GitHub
    // reads as "remove every label".
    expect(JSON.parse(call?.request.body ?? '{}')).toEqual({ title: 'Report', body: 'x' });
  });

  it('reports a refusal by status and body, without the credential that was refused', async () => {
    const scripted = scriptedFetch([
      { status: 403, body: JSON.stringify({ message: 'Resource not accessible by integration' }) },
    ]);
    const gateway = createGitHubRestGateway(config(), { fetch: scripted.fetch });

    // The port allows a synchronous gateway, so the call is wrapped rather than
    // assumed to be a promise before its rejection is captured.
    const failure = await Promise.resolve(
      gateway.createIssue({
        repository,
        title: 'Report',
        bodyMarkdown: 'x',
        labels: [],
        credentials: groupCredential,
      }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubBackendError);
    expect(String(failure)).toContain('403');
    expect(String(failure)).toContain('Resource not accessible by integration');
    expect(String(failure)).not.toContain(groupCredential);
    expect(String(failure)).not.toContain(deploymentToken);
  });

  it('refuses a repository that is not owner/name before any request is sent', async () => {
    const scripted = scriptedFetch([]);
    const gateway = createGitHubRestGateway(config(), { fetch: scripted.fetch });

    await expect(
      gateway.createIssue({
        repository: 'a/b/../../elsewhere',
        title: 'Report',
        bodyMarkdown: 'x',
        labels: [],
        credentials: groupCredential,
      }),
    ).rejects.toBeInstanceOf(GitHubBackendError);
    // The point of the check is that the credential is not sent somewhere the
    // value steered it, so what matters is that nothing was sent at all.
    expect(scripted.calls).toEqual([]);
  });
});

describe('GitHub gateway: translation pull requests', () => {
  it('cuts a branch from the default one, commits the proposal and opens a draft', async () => {
    const scripted = scriptedFetch(pullRequestScript);
    const gateway = createGitHubRestGateway(config(), { fetch: scripted.fetch });

    const outcome = await gateway.createPullRequest(proposal);

    expect(outcome).toEqual({
      url: `https://github.com/${repository}/pull/42`,
      pullRequestNumber: 42n,
      draft: true,
    });
    expect(
      scripted.calls.map((call) => `${call.request.method} ${call.url.split('?')[0] ?? ''}`),
    ).toEqual([
      `GET https://api.github.com/repos/${repository}`,
      `GET https://api.github.com/repos/${repository}/git/ref/heads/main`,
      `POST https://api.github.com/repos/${repository}/git/refs`,
      `GET https://api.github.com/repos/${repository}/contents/translations/proposals/ru/nav.map.json`,
      `PUT https://api.github.com/repos/${repository}/contents/translations/proposals/ru/nav.map.json`,
      `POST https://api.github.com/repos/${repository}/pulls`,
    ]);

    const branch = JSON.parse(scripted.calls[2]?.request.body ?? '{}') as { ref?: string };
    expect(branch.ref).toMatch(/^refs\/heads\/hq\/translation\/ru\/nav\.map-[0-9a-f]{12}$/u);

    // The commit carries the proposal itself, base64 as the Contents API takes
    // it, and no `sha`: the file did not exist on the branch.
    const committed = JSON.parse(scripted.calls[4]?.request.body ?? '{}') as {
      content?: string;
      sha?: string;
      branch?: string;
    };
    expect(committed.sha).toBeUndefined();
    expect(committed.branch).toBe(branch.ref?.replace('refs/heads/', ''));
    expect(JSON.parse(Buffer.from(committed.content ?? '', 'base64').toString('utf8'))).toEqual({
      key: 'nav.map',
      locale: 'ru',
      proposedValue: 'Карта',
      sourceValue: 'Map',
    });

    const opened = JSON.parse(scripted.calls[5]?.request.body ?? '{}') as {
      base?: string;
      draft?: boolean;
      head?: string;
      body?: string;
    };
    expect(opened.base).toBe('main');
    expect(opened.draft).toBe(true);
    expect(opened.head).toBe(committed.branch);
    expect(opened.body).toContain('Карта');
  });

  it('derives the same branch for the same proposal and a different one for a different value', async () => {
    async function branchOf(proposedValue: string): Promise<string> {
      const scripted = scriptedFetch(pullRequestScript);
      const gateway = createGitHubRestGateway(config(), { fetch: scripted.fetch });
      await gateway.createPullRequest({ ...proposal, proposedValue });
      const created = JSON.parse(scripted.calls[2]?.request.body ?? '{}') as { ref?: string };
      return created.ref ?? '';
    }

    // A retry that already reached GitHub must land on the branch it cut, not
    // scatter near-identical ones across the repository.
    expect(await branchOf('Карта')).toBe(await branchOf('Карта'));
    expect(await branchOf('Карта')).not.toBe(await branchOf('Схема'));
  });

  it('updates a file the branch already carries by its blob sha', async () => {
    const scripted = scriptedFetch([
      pullRequestScript[0],
      pullRequestScript[1],
      // The branch is already there from an earlier attempt.
      { status: 422, body: JSON.stringify({ message: 'Reference already exists' }) },
      { status: 200, body: JSON.stringify({ sha: 'blobsha000000000000000000000000000000001' }) },
      pullRequestScript[4],
      pullRequestScript[5],
    ]);
    const gateway = createGitHubRestGateway(config(), { fetch: scripted.fetch });

    const outcome = await gateway.createPullRequest(proposal);

    expect(outcome.pullRequestNumber).toBe(42n);
    // Without the sha the Contents API refuses an update with 422, so a second
    // attempt at the same proposal could never commit.
    expect(JSON.parse(scripted.calls[4]?.request.body ?? '{}')).toMatchObject({
      sha: 'blobsha000000000000000000000000000000001',
    });
  });

  it('stops at a branch that could not be cut for any other reason', async () => {
    const scripted = scriptedFetch([
      pullRequestScript[0],
      pullRequestScript[1],
      { status: 403, body: JSON.stringify({ message: 'Resource not accessible by integration' }) },
    ]);
    const gateway = createGitHubRestGateway(config(), { fetch: scripted.fetch });

    await expect(gateway.createPullRequest(proposal)).rejects.toMatchObject({
      name: 'GitHubBackendError',
      status: 403,
    });
    // Nothing is committed and no pull request is opened after a refused ref.
    expect(scripted.calls).toHaveLength(3);
  });

  it('commits where the configured template says, with each segment reduced to a safe one', async () => {
    const scripted = scriptedFetch(pullRequestScript);
    const gateway = createGitHubRestGateway(
      config({ HQ_CONTROL_PLANE_GITHUB_TRANSLATION_PATH: 'i18n/{locale}/{key}.json' }),
      { fetch: scripted.fetch },
    );

    await gateway.createPullRequest({ ...proposal, translationKey: 'nav/../map settings' });

    expect(scripted.calls[4]?.url).toBe(
      `https://api.github.com/repos/${repository}/contents/i18n/ru/nav-map-settings.json`,
    );
  });
});

describe('GitHub gateway: pull-request status', () => {
  it('reads a merged pull request as merged rather than closed', async () => {
    const scripted = scriptedFetch([
      {
        status: 200,
        body: JSON.stringify({
          state: 'closed',
          merged: true,
          merged_at: '2026-08-26T11:00:00Z',
          html_url: `https://github.com/${repository}/pull/42`,
          updated_at: '2026-08-26T11:00:00Z',
        }),
      },
    ]);
    const gateway = createGitHubRestGateway(config(), { fetch: scripted.fetch });

    const status = await gateway.readPullRequest({
      repository,
      pullRequestNumber: 42n,
      credentials: groupCredential,
    });

    expect(status).toEqual({
      state: 'MERGED',
      url: `https://github.com/${repository}/pull/42`,
      updatedAt: new Date('2026-08-26T11:00:00Z'),
    });
    expect(scripted.calls[0]?.url).toBe(`https://api.github.com/repos/${repository}/pulls/42`);
  });

  it('separates an open pull request from one closed without a merge', async () => {
    async function stateOf(pull: Record<string, unknown>): Promise<string> {
      const scripted = scriptedFetch([
        {
          status: 200,
          body: JSON.stringify({
            html_url: `https://github.com/${repository}/pull/42`,
            updated_at: '2026-08-26T11:00:00Z',
            ...pull,
          }),
        },
      ]);
      const gateway = createGitHubRestGateway(config(), { fetch: scripted.fetch });
      const status = await gateway.readPullRequest({
        repository,
        pullRequestNumber: 42n,
        credentials: groupCredential,
      });
      return status.state;
    }

    expect(await stateOf({ state: 'open', merged: false })).toBe('OPEN');
    expect(await stateOf({ state: 'closed', merged: false, merged_at: null })).toBe('CLOSED');
  });

  it('refuses an answer that is missing the fields the response is made of', async () => {
    const scripted = scriptedFetch([
      { status: 200, body: JSON.stringify({ state: 'open', html_url: '' }) },
    ]);
    const gateway = createGitHubRestGateway(config(), { fetch: scripted.fetch });

    // Better a refusal than a status carrying an empty URL a client would draw
    // as a link to nowhere.
    await expect(
      gateway.readPullRequest({
        repository,
        pullRequestNumber: 42n,
        credentials: groupCredential,
      }),
    ).rejects.toBeInstanceOf(GitHubBackendError);
  });
});
