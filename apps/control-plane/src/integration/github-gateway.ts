import { createHash } from 'node:crypto';

import type { ControlPlaneGitHubConfig } from '../config.js';
import type { Awaitable } from '../sync/lifecycle.js';

import type {
  GitHubIntegrationGateway,
  GitHubIssueOutcome,
  GitHubIssueRequest,
  GitHubPullRequestOutcome,
  GitHubPullRequestQuery,
  GitHubPullRequestStatus,
  GitHubTranslationPullRequest,
} from './service.js';

/**
 * The GitHub REST implementation of {@link GitHubIntegrationGateway}.
 *
 * It is written directly against the documented REST v3 endpoints over `fetch`
 * rather than over Octokit: the four calls this package makes are plain JSON
 * requests, and an SDK would add a dependency, a retry policy this control
 * plane does not want to inherit, and a second place a credential is held.
 *
 * The gateway holds no credential of its own. Every method is handed the one it
 * must spend by `createIntegrationService`, which opens it — the group's own
 * installation credential, or this deployment's — in the function about to make
 * the call, exactly as the S3 issuer is handed a signature rather than a key.
 * The token is placed in an `Authorization` header and nowhere else: not in a
 * URL, not in a returned value, and not in the text of an error, so a failure
 * that is logged or handed to `runJob` cannot carry it. The service replaces
 * the message anyway; this is the second of the two guards, not the only one.
 *
 * What a scripted server can prove is which request each method sends and how
 * each documented answer is read. What it cannot prove is that github.com
 * accepts them — that needs a real token, which this repository does not hold
 * (`docs/release/known-limitations.md`).
 */

/** The subset of a Fetch response this gateway reads, so a test need not build a whole one. */
export interface GitHubFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface GitHubFetchRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type GitHubFetch = (
  url: string,
  request: GitHubFetchRequest,
) => Awaitable<GitHubFetchResponse>;

export interface GitHubRestGatewayOptions {
  /** Defaults to `globalThis.fetch`; injected so every call is testable. */
  readonly fetch?: GitHubFetch;
}

export type GitHubGatewayFactory = (
  config: ControlPlaneGitHubConfig,
  options?: GitHubRestGatewayOptions,
) => GitHubIntegrationGateway;

export class GitHubBackendError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    detail: string,
  ) {
    // GitHub's error body echoes the message and the documentation URL. It
    // never carries the request's own headers, which is where the credential
    // is, and the URL is not included here at all.
    super(`GitHub ${operation} failed with status ${status.toString()}: ${detail}`);
    this.name = 'GitHubBackendError';
  }
}

/** The API version header GitHub documents for REST v3 requests. */
const apiVersion = '2022-11-28';
const userAgent = 'gremuchaya-control-plane';
const acceptHeader = 'application/vnd.github+json';
/** `owner/name`, re-checked here because this value becomes part of a URL path. */
const repositoryPattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

export const createGitHubRestGateway: GitHubGatewayFactory = (config, options = {}) => {
  const doFetch = options.fetch ?? defaultFetch;

  /**
   * One request, and its status and body read back whatever they say.
   *
   * It does not decide what a status means: two of the six calls treat a
   * particular failure as success — a branch that already exists, a file that
   * is not there yet — and folding that into the transport would make both read
   * as errors the caller had to unpick.
   */
  async function call(
    method: string,
    path: string,
    credentials: string,
    body: unknown,
  ): Promise<{ readonly status: number; readonly ok: boolean; readonly text: string }> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const response = await doFetch(`${config.apiBaseUrl}${path}`, {
      method,
      headers: {
        accept: acceptHeader,
        'x-github-api-version': apiVersion,
        'user-agent': userAgent,
        authorization: `Bearer ${credentials}`,
        ...(serialized === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(serialized === undefined ? {} : { body: serialized }),
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  }

  async function requireOk(
    operation: string,
    method: string,
    path: string,
    credentials: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await call(method, path, credentials, body);
    if (!response.ok) {
      throw new GitHubBackendError(operation, response.status, boundedDetail(response.text));
    }
    const document = readObject(response.text);
    if (document === undefined) {
      throw new GitHubBackendError(operation, response.status, 'response carried no JSON object');
    }
    return document;
  }

  /**
   * Opens the branch a translation pull request is raised from.
   *
   * A pull request needs a commit, a commit needs a branch, and a branch needs
   * the base commit it starts at — so the sequence is fixed by the API rather
   * than chosen here. The branch name is derived from the proposal itself, so
   * a retry that reached GitHub once already lands on the same name instead of
   * scattering near-identical branches across the repository.
   */
  async function openBranch(
    repository: string,
    branch: string,
    credentials: string,
  ): Promise<string> {
    const details = await requireOk(
      'GetRepository',
      'GET',
      `/repos/${repository}`,
      credentials,
      undefined,
    );
    const base = requireText(details.default_branch, 'default_branch', 'GetRepository');
    const reference = await requireOk(
      'GetBaseRef',
      'GET',
      `/repos/${repository}/git/ref/heads/${encodeURIComponent(base)}`,
      credentials,
      undefined,
    );
    const sha = requireText(nested(reference.object)?.sha, 'object.sha', 'GetBaseRef');

    const created = await call('POST', `/repos/${repository}/git/refs`, credentials, {
      ref: `refs/heads/${branch}`,
      sha,
    });
    // 422 with `Reference already exists` is the retry case: the branch this
    // proposal derives is the one a previous attempt cut from the same base,
    // and re-cutting it is neither possible nor needed.
    if (!created.ok && !(created.status === 422 && /already exists/iu.test(created.text))) {
      throw new GitHubBackendError('CreateRef', created.status, boundedDetail(created.text));
    }
    return base;
  }

  return {
    async createIssue(request: GitHubIssueRequest): Promise<GitHubIssueOutcome> {
      const repository = requireRepository(request.repository);
      const issue = await requireOk(
        'CreateIssue',
        'POST',
        `/repos/${repository}/issues`,
        request.credentials,
        {
          title: request.title,
          body: request.bodyMarkdown,
          ...(request.labels.length === 0 ? {} : { labels: [...request.labels] }),
        },
      );
      return {
        url: requireText(issue.html_url, 'html_url', 'CreateIssue'),
        issueNumber: requireCount(issue.number, 'number', 'CreateIssue'),
      };
    },

    async createPullRequest(
      request: GitHubTranslationPullRequest,
    ): Promise<GitHubPullRequestOutcome> {
      const repository = requireRepository(request.repository);
      const branch = branchName(request);
      const base = await openBranch(repository, branch, request.credentials);
      const path = translationPath(config.translationPathTemplate, request);

      // A file that already exists on the branch must be updated by its blob
      // sha; sending none is how the Contents API is told the file is new, and
      // sending none for a file that exists is refused with 422. The read is
      // scoped to the branch, so a file present on the base and absent here is
      // correctly treated as new.
      const existing = await call(
        'GET',
        `/repos/${repository}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
        request.credentials,
        undefined,
      );
      if (!existing.ok && existing.status !== 404) {
        throw new GitHubBackendError('GetContents', existing.status, boundedDetail(existing.text));
      }
      const existingSha = existing.ok ? readObject(existing.text)?.sha : undefined;

      await requireOk(
        'PutContents',
        'PUT',
        `/repos/${repository}/contents/${encodePath(path)}`,
        request.credentials,
        {
          message: `Propose ${request.locale} translation for ${request.translationKey}`,
          content: Buffer.from(proposalDocument(request), 'utf8').toString('base64'),
          branch,
          ...(typeof existingSha === 'string' && existingSha.length > 0
            ? { sha: existingSha }
            : {}),
        },
      );

      const pull = await requireOk(
        'CreatePullRequest',
        'POST',
        `/repos/${repository}/pulls`,
        request.credentials,
        {
          title: `Translate ${request.translationKey} into ${request.locale}`,
          head: branch,
          base,
          body: pullRequestBody(request),
          // A draft, because a translation nobody reviewed is a proposal and
          // not a change: the operator who typed it is not the person who
          // decides the wording ships.
          draft: true,
        },
      );
      return {
        url: requireText(pull.html_url, 'html_url', 'CreatePullRequest'),
        pullRequestNumber: requireCount(pull.number, 'number', 'CreatePullRequest'),
        draft: pull.draft === true,
      };
    },

    async readPullRequest(query: GitHubPullRequestQuery): Promise<GitHubPullRequestStatus> {
      const repository = requireRepository(query.repository);
      const pull = await requireOk(
        'GetPullRequest',
        'GET',
        `/repos/${repository}/pulls/${query.pullRequestNumber.toString()}`,
        query.credentials,
        undefined,
      );
      // GitHub's own `state` is `open` or `closed` and says nothing about a
      // merge; a merged pull request is closed. Reading `merged` first is what
      // keeps a merged proposal from being reported as rejected.
      const merged = pull.merged === true || typeof pull.merged_at === 'string';
      const state: GitHubPullRequestStatus['state'] = merged
        ? 'MERGED'
        : pull.state === 'closed'
          ? 'CLOSED'
          : 'OPEN';
      return {
        state,
        url: requireText(pull.html_url, 'html_url', 'GetPullRequest'),
        updatedAt: requireInstant(pull.updated_at, 'updated_at', 'GetPullRequest'),
      };
    },
  };
};

/**
 * The branch a proposal opens from.
 *
 * Deterministic in the proposal's own content, so the same proposal retried
 * addresses the same branch. The digest is a disambiguator rather than a
 * secret: two proposals whose keys sanitize to the same slug would otherwise
 * share a branch and the second would append its file to the first's pull
 * request.
 */
function branchName(request: GitHubTranslationPullRequest): string {
  const digest = createHash('sha256')
    .update(`${request.locale} ${request.translationKey} ${request.proposedValue}`)
    .digest('hex')
    .slice(0, 12);
  return `hq/translation/${slug(request.locale)}/${slug(request.translationKey)}-${digest}`;
}

/**
 * Reduces a value to what both a git ref and a path segment accept.
 *
 * A translation key is `<area>.<name>` in this project, but the gateway cannot
 * assume that of a key an operator typed: anything outside the allowed set
 * becomes a dash, and an empty result becomes `key`, so no input can produce a
 * ref git refuses or a path segment that escapes its directory. A run of two or
 * more dots or dashes collapses to one dash, which is what keeps a key of
 * `nav/../map` from committing a `..` inside the path it builds; the single dot
 * of `nav.map` survives, because that is the shape the keys actually have.
 */
function slug(value: string): string {
  const reduced = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/[-.]{2,}/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, 60);
  return reduced.length === 0 ? 'key' : reduced;
}

function translationPath(template: string, request: GitHubTranslationPullRequest): string {
  return template
    .replaceAll('{locale}', slug(request.locale))
    .replaceAll('{key}', slug(request.translationKey));
}

/** Each segment encoded on its own, so a slash in the template stays a slash. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * What the branch commits.
 *
 * A record of the proposal rather than an edit to a catalogue: this control
 * plane does not know the target repository's message format, and a commit
 * that rewrote a file it had guessed the shape of would be a worse answer than
 * a reviewable statement of what was proposed. The document is sorted and
 * newline-terminated so two proposals of the same value produce the same blob.
 */
function proposalDocument(request: GitHubTranslationPullRequest): string {
  return `${JSON.stringify(
    {
      key: request.translationKey,
      locale: request.locale,
      proposedValue: request.proposedValue,
      sourceValue: request.sourceValue,
    },
    undefined,
    2,
  )}\n`;
}

function pullRequestBody(request: GitHubTranslationPullRequest): string {
  return [
    '## Translation proposal',
    '',
    `- Locale: \`${request.locale}\``,
    `- Key: \`${request.translationKey}\``,
    '',
    '### Source',
    '',
    request.sourceValue.length === 0 ? '_(none recorded)_' : request.sourceValue,
    '',
    '### Proposed',
    '',
    request.proposedValue,
  ].join('\n');
}

/**
 * The last check before a repository becomes part of a URL path.
 *
 * `createIntegrationService` refuses a repository the group did not install and
 * `loadControlPlaneConfig` refuses one that is not `owner/name`, so nothing
 * should reach here malformed. It is checked again because this is the function
 * that builds the path: a future caller that skipped both would otherwise send
 * the credential wherever the value pointed.
 */
function requireRepository(value: string): string {
  if (!repositoryPattern.test(value)) {
    throw new GitHubBackendError(
      'Request',
      400,
      'repository must be owner/name; refused before any request was sent',
    );
  }
  return value;
}

/** A nested JSON object, or `undefined` where the field is absent or not one. */
function nested(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return nested(parsed);
  } catch {
    return undefined;
  }
}

function requireText(value: unknown, field: string, operation: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitHubBackendError(operation, 200, `response carried no ${field}`);
  }
  return value;
}

/**
 * An issue or pull request number, as `uint64` on the wire. JSON gives it as a
 * `number`, so a non-integer or negative value is refused rather than turned
 * into a `BigInt` that would throw somewhere further away.
 */
function requireCount(value: unknown, field: string, operation: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubBackendError(operation, 200, `response carried no ${field}`);
  }
  return BigInt(value);
}

function requireInstant(value: unknown, field: string, operation: string): Date {
  if (typeof value !== 'string') {
    throw new GitHubBackendError(operation, 200, `response carried no ${field}`);
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new GitHubBackendError(operation, 200, `response carried an unreadable ${field}`);
  }
  return instant;
}

/** GitHub error bodies are small, but a proxy's is not; a bounded slice diagnoses either. */
function boundedDetail(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return 'empty response body';
  return collapsed.length > 300 ? `${collapsed.slice(0, 297)}...` : collapsed;
}

const defaultFetch: GitHubFetch = async (url, request) => {
  const response = await fetch(url, {
    method: request.method,
    headers: { ...request.headers },
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};
