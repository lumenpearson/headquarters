import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadControlPlaneConfig, type ControlPlaneGitHubConfig } from '../config.js';

import { GitHubBackendError, createGitHubRestGateway } from './github-gateway.js';

/**
 * The gateway over its own `fetch`, against a GitHub answering on a socket.
 *
 * The scripted suite beside this one injects a `fetch` and proves what each
 * operation asks for. This one injects nothing: the default adapter builds the
 * request, a real HTTP server reads the method, the path, the headers and the
 * body off the wire, and the answer comes back as bytes. Without it the
 * adapter — the one piece the scripted suite replaces — would be the only part
 * of this gateway nothing exercised, and a header it dropped or a body it
 * failed to send would pass every test.
 *
 * It still is not github.com. A live call needs a real token, which this
 * repository does not hold; the limit is recorded in
 * `docs/release/known-limitations.md`.
 */
const token = 'ghp_wire_test_token_that_must_not_leak_0003';
const repository = 'gremuchaya/headquarters';

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
  readonly accept: string;
  readonly userAgent: string;
  readonly body: string;
}

let server: Server;
let received: RecordedRequest[] = [];
let github: ControlPlaneGitHubConfig;

/** The GitHub subset the six calls of this gateway address. */
function answer(request: RecordedRequest): { readonly status: number; readonly body: unknown } {
  const path = request.url.split('?')[0] ?? '';
  if (request.method === 'GET' && path === `/repos/${repository}`) {
    return { status: 200, body: { default_branch: 'main' } };
  }
  if (request.method === 'GET' && path === `/repos/${repository}/git/ref/heads/main`) {
    return { status: 200, body: { object: { sha: 'basesha00000000000000000000000000000001' } } };
  }
  if (request.method === 'POST' && path === `/repos/${repository}/git/refs`) {
    return { status: 201, body: { ref: (JSON.parse(request.body) as { ref: string }).ref } };
  }
  if (request.method === 'GET' && path.startsWith(`/repos/${repository}/contents/`)) {
    return { status: 404, body: { message: 'Not Found' } };
  }
  if (request.method === 'PUT' && path.startsWith(`/repos/${repository}/contents/`)) {
    return { status: 201, body: { content: { path } } };
  }
  if (request.method === 'POST' && path === `/repos/${repository}/pulls`) {
    return {
      status: 201,
      body: { html_url: `https://github.com/${repository}/pull/11`, number: 11, draft: true },
    };
  }
  if (request.method === 'POST' && path === `/repos/${repository}/issues`) {
    return {
      status: 201,
      body: { html_url: `https://github.com/${repository}/issues/5`, number: 5 },
    };
  }
  if (request.method === 'GET' && path === `/repos/${repository}/pulls/11`) {
    return {
      status: 200,
      body: {
        state: 'open',
        merged: false,
        html_url: `https://github.com/${repository}/pull/11`,
        updated_at: '2026-08-27T08:30:00Z',
      },
    };
  }
  return { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github' } };
}

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded: RecordedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization ?? '',
        accept: request.headers.accept ?? '',
        userAgent: request.headers['user-agent'] ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(recorded);
      const { status, body } = answer(recorded);
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const config = loadControlPlaneConfig({
    HQ_CONTROL_PLANE_GITHUB_TOKEN: token,
    HQ_CONTROL_PLANE_GITHUB_REPOSITORY: repository,
    HQ_CONTROL_PLANE_GITHUB_API_BASE_URL: `http://127.0.0.1:${port.toString()}`,
  }).github;
  if (config === undefined) throw new Error('GitHub configuration expected');
  github = config;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

describe('GitHub gateway over its own fetch', () => {
  it('opens an issue and the server reads the credential off the wire', async () => {
    received = [];
    const gateway = createGitHubRestGateway(github);

    const outcome = await gateway.createIssue({
      repository,
      title: 'The map is blank',
      bodyMarkdown: '## Problem\n\nblank',
      labels: ['hq'],
      credentials: github.openToken(),
    });

    expect(outcome).toEqual({
      url: `https://github.com/${repository}/issues/5`,
      issueNumber: 5n,
    });
    const request = received[0];
    // The adapter actually sent the headers and the body, rather than a
    // scripted double reporting that it would have.
    expect(request?.authorization).toBe(`Bearer ${token}`);
    expect(request?.accept).toBe('application/vnd.github+json');
    expect(request?.userAgent).toBe('gremuchaya-control-plane');
    expect(JSON.parse(request?.body ?? '{}')).toEqual({
      title: 'The map is blank',
      body: '## Problem\n\nblank',
      labels: ['hq'],
    });
  });

  it('carries a whole translation pull request across the socket', async () => {
    received = [];
    const gateway = createGitHubRestGateway(github);

    const outcome = await gateway.createPullRequest({
      repository,
      locale: 'ru',
      translationKey: 'nav.map',
      sourceValue: 'Map',
      proposedValue: 'Карта',
      credentials: github.openToken(),
    });

    expect(outcome).toEqual({
      url: `https://github.com/${repository}/pull/11`,
      pullRequestNumber: 11n,
      draft: true,
    });
    expect(
      received.map((request) => `${request.method} ${request.url.split('?')[0] ?? ''}`),
    ).toEqual([
      `GET /repos/${repository}`,
      `GET /repos/${repository}/git/ref/heads/main`,
      `POST /repos/${repository}/git/refs`,
      `GET /repos/${repository}/contents/translations/proposals/ru/nav.map.json`,
      `PUT /repos/${repository}/contents/translations/proposals/ru/nav.map.json`,
      `POST /repos/${repository}/pulls`,
    ]);
    // Non-ASCII survives the encoding: a Cyrillic proposal is what this
    // project's translations are made of.
    const committed = JSON.parse(received[4]?.body ?? '{}') as { content?: string };
    expect(Buffer.from(committed.content ?? '', 'base64').toString('utf8')).toContain('Карта');
  });

  it('reads an open pull request back and reports a real 404 by status', async () => {
    received = [];
    const gateway = createGitHubRestGateway(github);

    const status = await gateway.readPullRequest({
      repository,
      pullRequestNumber: 11n,
      credentials: github.openToken(),
    });
    expect(status).toEqual({
      state: 'OPEN',
      url: `https://github.com/${repository}/pull/11`,
      updatedAt: new Date('2026-08-27T08:30:00Z'),
    });

    const failure = await Promise.resolve(
      gateway.readPullRequest({
        repository,
        pullRequestNumber: 99n,
        credentials: github.openToken(),
      }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubBackendError);
    expect((failure as GitHubBackendError).status).toBe(404);
    expect(String(failure)).not.toContain(token);
  });
});
