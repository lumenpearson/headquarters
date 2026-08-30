import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ControlPlaneFailure, integrationV1 } from '@gremuchaya/protocol';
import type { IntegrationService } from '@gremuchaya/protocol';

import { controlPlaneFailure, withRuntimeErrors } from '../errors.js';

import type { Awaitable, PairedDeviceLifecycle } from '../sync/lifecycle.js';
import {
  MutationRequestIdError,
  normalizeRequestId,
  type MutationReceiptContext,
} from '../sync/receipts.js';
import { PairedDeviceRuntimeError, type AuthenticatedDevice } from '../sync/runtime.js';

import {
  type IntegrationJob,
  type IntegrationProviderName,
  type IntegrationStore,
  type TranslationProposalRecord,
} from './store.js';

/**
 * The outbound half of the integration surface.
 *
 * Nothing in this package speaks HTTP to GitHub. That is deliberate: an
 * outbound call needs a credential, a retry policy and a rate limit, and
 * putting them behind a port keeps the credential in the caller's closure —
 * the same discipline `CredentialSealer` applies to the credential at rest.
 * The store hands the plaintext to exactly one call site, which is the
 * function about to spend it.
 */
export interface GitHubIssueRequest {
  readonly repository: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly labels: readonly string[];
  readonly credentials: string;
}

export interface GitHubIssueOutcome {
  readonly url: string;
  readonly issueNumber: bigint;
}

export interface GitHubTranslationPullRequest {
  readonly repository: string;
  readonly locale: string;
  readonly translationKey: string;
  readonly sourceValue: string;
  readonly proposedValue: string;
  readonly credentials: string;
}

export interface GitHubPullRequestOutcome {
  readonly url: string;
  readonly pullRequestNumber: bigint;
  readonly draft: boolean;
}

export interface GitHubPullRequestQuery {
  readonly repository: string;
  readonly pullRequestNumber: bigint;
  readonly credentials: string;
}

export interface GitHubPullRequestStatus {
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly url: string;
  readonly updatedAt: Date;
}

export interface GitHubIntegrationGateway {
  createIssue(request: GitHubIssueRequest): Awaitable<GitHubIssueOutcome>;
  createPullRequest(request: GitHubTranslationPullRequest): Awaitable<GitHubPullRequestOutcome>;
  readPullRequest(query: GitHubPullRequestQuery): Awaitable<GitHubPullRequestStatus>;
}

export interface IntegrationServiceOptions {
  /** Authenticates the bearer token every group-scoped method carries. */
  readonly runtime: PairedDeviceLifecycle;
  /**
   * The remaining collaborators are optional so a control plane started
   * without a database, or without GitHub egress, still registers the service.
   * What is absent answers `unimplemented`, which a client already knows how to
   * read; it is never faked with an empty success.
   */
  readonly store?: IntegrationStore;
  readonly github?: GitHubIntegrationGateway;
  /** The repository a draft falls back to when the client names none. */
  readonly issueRepository?: string;
  /** Labels every issue this control plane opens carries. */
  readonly issueLabels?: readonly string[];
  readonly prefilledIssueLifetimeMs?: number;
  readonly now?: () => Date;
}

/**
 * A prefilled issue URL is a browser address, and both GitHub and the
 * intermediate proxies stop honouring one well before the theoretical limit.
 * The body is trimmed to fit rather than the request being refused: the
 * operator filing the report is standing on a set, and half a report they can
 * finish by hand beats an error they cannot act on.
 */
const maxPrefilledIssueUrlLength = 8000;
const truncationMarker = '\n\n_(truncated: open the issue and paste the rest)_';
const defaultPrefilledIssueLifetimeMs = 10 * 60 * 1000;
const maxIssueTitleLength = 200;
const maxAttachmentCount = 10;
const maxAttachmentBytes = 5 * 1024 * 1024;
/** `owner/name`, and nothing that could steer the URL somewhere else. */
const repositoryPattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

/**
 * ConnectRPC adapter for `IntegrationService`.
 *
 * Two of the seven methods never touch the database or the network:
 * `BuildIssueDraft` turns a report into markdown and `OpenPrefilledIssue`
 * turns that markdown into a URL the operator opens themselves. They exist so
 * a shoot with no GitHub credential — the normal case — can still file a
 * report, which is why they are implemented even where the gateway is absent.
 */
export function createIntegrationService(
  options: IntegrationServiceOptions,
): Partial<ServiceImpl<typeof IntegrationService>> {
  const now = options.now ?? ((): Date => new Date());
  const prefilledIssueLifetimeMs =
    options.prefilledIssueLifetimeMs ?? defaultPrefilledIssueLifetimeMs;

  return {
    async buildIssueDraft(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        assertAuthenticatedGroup(
          authenticated,
          requireResourceId(request.groupId?.value, 'group_id'),
        );
        assertAttachmentBudget(request.attachments);
        return {
          draft: {
            title: buildIssueTitle(request.problem, request.screenId),
            bodyMarkdown: buildIssueBody(request),
            labels: [...(options.issueLabels ?? [])],
            attachments: request.attachments.map((attachment) => ({
              name: attachment.name,
              mediaType: attachment.mediaType,
              content: attachment.content,
            })),
            repository: declaredRepository(options),
          },
        };
      });
    },

    async openPrefilledIssue(request, context) {
      return withRuntimeErrors(async () => {
        // Authenticated like every other method. It spends no credential and
        // writes nothing, but it composes an outbound address from client text,
        // and an unauthenticated endpoint that does that is a redirector anyone
        // can point at this control plane's name.
        await authenticate(options, context);
        const draft = request.draft;
        if (draft === undefined) {
          throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'draft must not be empty.');
        }
        const repository = resolveRepository(draft.repository, options);
        const issuedAt = now();
        return {
          url: buildPrefilledIssueUrl(repository, draft),
          // Advisory: nothing is stored, and GitHub honours the address for as
          // long as the operator keeps the tab. The instant is what tells a
          // client when to stop offering a stale report as if it were current.
          expiresAt: timestampFromDate(new Date(issuedAt.getTime() + prefilledIssueLifetimeMs)),
        };
      });
    },

    async createIssue(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        assertWriter(authenticated);
        assertConfirmed(request.confirmed, 'opening a GitHub issue');
        const draft = request.draft;
        if (draft === undefined) {
          throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'draft must not be empty.');
        }
        assertAttachmentBudget(draft.attachments);
        const store = requireStore(options);
        const gateway = requireGateway(options);
        const repository = await requireInstalledRepository(
          store,
          authenticated.group.id,
          draft.repository,
        );

        const job = await store.enqueueJob({
          groupId: authenticated.group.id,
          actorDeviceId: authenticated.device.id,
          provider: 'GITHUB',
          kind: 'CREATE_ISSUE',
          payload: { repository, title: draft.title },
          correlationId: request.context?.correlationId ?? '',
          ...toMutationReceiptInput(request.context?.requestId),
        });
        // A job that comes back in any state but `QUEUED` is the receipt
        // answering a retry: the first attempt already reached GitHub, and
        // asking again would open a second issue nobody requested.
        const replayed = replayedIssue(job);
        if (replayed !== undefined) return replayed;

        const credentials = await store.openInstallationCredentials(authenticated.group.id);
        await store.transitionJob({
          groupId: job.groupId,
          jobId: job.id,
          from: 'QUEUED',
          to: 'RUNNING',
        });
        const outcome = await runJob(store, job, () =>
          gateway.createIssue({
            repository,
            title: draft.title,
            bodyMarkdown: draft.bodyMarkdown,
            labels: draft.labels,
            credentials,
          }),
        );
        await store.transitionJob({
          groupId: job.groupId,
          jobId: job.id,
          from: 'RUNNING',
          to: 'SUCCEEDED',
          result: { url: outcome.url, issueNumber: outcome.issueNumber.toString() },
        });
        return { url: outcome.url, issueNumber: outcome.issueNumber };
      });
    },

    async createTranslationProposal(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        assertWriter(authenticated);
        const proposal = request.proposal;
        if (proposal === undefined) {
          throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'proposal must not be empty.');
        }
        const stored = await requireStore(options).proposeTranslation({
          groupId: authenticated.group.id,
          actorDeviceId: authenticated.device.id,
          locale: requireText(proposal.locale, 'proposal.locale'),
          translationKey: requireText(proposal.key, 'proposal.key'),
          sourceValue: proposal.sourceValue,
          proposedValue: requireText(proposal.proposedValue, 'proposal.proposed_value'),
          englishReference: proposal.englishReference,
          placeholders: proposal.placeholders,
          transliteration: proposal.transliteration,
          ...toMutationReceiptInput(request.context?.requestId),
        });
        return { proposal: toProtocolProposal(stored) };
      });
    },

    async createTranslationPullRequest(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        assertContextActor(authenticated, request.context?.actorDeviceId?.value);
        assertWriter(authenticated);
        assertConfirmed(request.confirmed, 'opening a translation pull request');
        const store = requireStore(options);
        const gateway = requireGateway(options);
        const repository = await requireInstalledRepository(store, authenticated.group.id, '');
        const proposalId = requireResourceId(request.proposalId?.value, 'proposal_id');
        const proposal = await store.readProposal(authenticated.group.id, proposalId);
        if (proposal === undefined) {
          throw new PairedDeviceRuntimeError(
            'NOT_FOUND',
            'The translation proposal does not exist in this group.',
          );
        }
        // Checked before the gateway is reached, not only by the guarded update
        // afterwards. The update is what makes the transition safe under
        // concurrency; this is what keeps a settled proposal from acquiring a
        // real pull request that the refusal can no longer take back.
        if (proposal.status === 'MERGED' || proposal.status === 'REJECTED') {
          throw new PairedDeviceRuntimeError(
            'FAILED_PRECONDITION',
            'A settled translation proposal cannot open another pull request.',
          );
        }
        if (proposal.pullRequestUrl !== undefined && proposal.pullRequestUrl.length > 0) {
          throw new PairedDeviceRuntimeError(
            'ALREADY_EXISTS',
            'This translation proposal already names an open pull request.',
          );
        }

        const job = await store.enqueueJob({
          groupId: authenticated.group.id,
          actorDeviceId: authenticated.device.id,
          provider: 'GITHUB',
          kind: 'CREATE_TRANSLATION_PULL_REQUEST',
          payload: { repository, proposalId, locale: proposal.locale },
          correlationId: request.context?.correlationId ?? '',
          ...toMutationReceiptInput(request.context?.requestId),
        });
        const replayed = replayedPullRequest(job);
        if (replayed !== undefined) return replayed;

        const credentials = await store.openInstallationCredentials(authenticated.group.id);
        await store.transitionJob({
          groupId: job.groupId,
          jobId: job.id,
          from: 'QUEUED',
          to: 'RUNNING',
        });
        const outcome = await runJob(store, job, () =>
          gateway.createPullRequest({
            repository,
            locale: proposal.locale,
            translationKey: proposal.translationKey,
            sourceValue: proposal.sourceValue,
            proposedValue: proposal.proposedValue,
            credentials,
          }),
        );
        await store.transitionJob({
          groupId: job.groupId,
          jobId: job.id,
          from: 'RUNNING',
          to: 'SUCCEEDED',
          result: {
            url: outcome.url,
            pullRequestNumber: outcome.pullRequestNumber.toString(),
            draft: outcome.draft,
          },
        });
        // The proposal is only now under review, and the URL is where that
        // review happens. Recording it in the same call keeps a proposal from
        // claiming a pull request that was never opened.
        await store.updateProposal({
          groupId: authenticated.group.id,
          actorDeviceId: authenticated.device.id,
          proposalId,
          from: proposal.status,
          to: 'PROPOSED',
          pullRequestUrl: outcome.url,
        });
        return {
          url: outcome.url,
          pullRequestNumber: outcome.pullRequestNumber,
          draft: outcome.draft,
        };
      });
    },

    async getIntegrationStatus(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        const groupId = requireResourceId(request.groupId?.value, 'group_id');
        assertAuthenticatedGroup(authenticated, groupId);
        const provider = toProviderName(request.provider);
        const status = await requireStore(options).readStatus(
          groupId,
          authenticated.device.id,
          provider,
        );
        return {
          status: {
            provider: request.provider,
            state: toIntegrationState(status),
            accountLabel: status.accountLabel,
            // Nothing records what a GitHub App installation actually granted,
            // so this stays empty rather than asserting permissions the
            // control plane has never seen confirmed.
            grantedCapabilities: [],
            checkedAt: timestampFromDate(status.checkedAt),
            detail: toIntegrationDetail(status),
          },
        };
      });
    },

    async getPullRequestStatus(request, context) {
      return withRuntimeErrors(async () => {
        const authenticated = await authenticate(options, context);
        const store = requireStore(options);
        const gateway = requireGateway(options);
        const repository = await requireInstalledRepository(
          store,
          authenticated.group.id,
          request.repository,
        );
        if (request.pullRequestNumber <= 0n) {
          throw new PairedDeviceRuntimeError(
            'INVALID_ARGUMENT',
            'pull_request_number must be a positive number.',
          );
        }
        const credentials = await store.openInstallationCredentials(authenticated.group.id);
        // Through the same seam as every other outbound call: this one used to
        // reach the gateway directly, so its errors arrived at the client
        // exactly as the transport wrote them.
        const status = await callGateway(() =>
          gateway.readPullRequest({
            repository,
            pullRequestNumber: request.pullRequestNumber,
            credentials,
          }),
        );
        return {
          state: toProtocolPullRequestState(status.state),
          url: status.url,
          updatedAt: timestampFromDate(status.updatedAt),
        };
      });
    },
  };
}

/**
 * Runs the outbound half of a job and records the outcome either way.
 *
 * The stored failure carries a fixed message rather than the gateway's own.
 * A transport error can quote the request it failed on, headers included, and
 * `integration_jobs.result` is read by anyone who can read the group's jobs —
 * a credential must not arrive there by way of an error string.
 */
async function runJob<T>(
  store: IntegrationStore,
  job: IntegrationJob,
  call: () => Awaitable<T>,
): Promise<T> {
  try {
    return await callGateway(call);
  } catch (error: unknown) {
    await store.transitionJob({
      groupId: job.groupId,
      jobId: job.id,
      from: 'RUNNING',
      to: 'FAILED',
      result: { message: `The ${job.kind} request did not complete.` },
    });
    throw error;
  }
}

/**
 * The only place an outbound call is made.
 *
 * Whatever the gateway throws is replaced, `ConnectError` included. A transport
 * error can quote the request it failed on, headers and all, and the
 * installation credential travels in a header — so passing one through because
 * it already carried a status code was the same disclosure as passing through
 * any other. The status a client can act on is preserved; the words are not.
 */
async function callGateway<T>(call: () => Awaitable<T>): Promise<T> {
  try {
    return await call();
  } catch (error: unknown) {
    // The upstream failure stays as `cause`: a GitHub client error can quote
    // the request URL, and this crosses to a browser.
    throw controlPlaneFailure(ControlPlaneFailure.INTEGRATION_GITHUB_UNREACHABLE, { cause: error });
  }
}

/**
 * The repository a group's credential may be spent against.
 *
 * The installation names exactly one repository, and the credential is scoped
 * to it. Taking the target from the request let any editor point the group's
 * GitHub credential at a repository the group never registered — a request the
 * client composes, spent with authority the client does not hold.
 */
async function requireInstalledRepository(
  store: IntegrationStore,
  groupId: string,
  requested: string,
): Promise<string> {
  const installation = await store.readInstallation(groupId);
  if (installation === undefined) {
    throw new PairedDeviceRuntimeError(
      'FAILED_PRECONDITION',
      'This group has no GitHub installation, so no repository can be reached on its behalf.',
    );
  }
  const asked = requested.trim();
  if (asked.length > 0 && asked !== installation.repository) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      "A request cannot name a repository other than the group's own installation.",
    );
  }
  return installation.repository;
}

function replayedIssue(job: IntegrationJob): { url: string; issueNumber: bigint } | undefined {
  if (job.state === 'QUEUED') return undefined;
  const result = requireCompletedJob(job);
  return {
    url: readResultText(result.url, 'url'),
    issueNumber: readResultNumber(result.issueNumber, 'issue_number'),
  };
}

function replayedPullRequest(
  job: IntegrationJob,
): { url: string; pullRequestNumber: bigint; draft: boolean } | undefined {
  if (job.state === 'QUEUED') return undefined;
  const result = requireCompletedJob(job);
  return {
    url: readResultText(result.url, 'url'),
    pullRequestNumber: readResultNumber(result.pullRequestNumber, 'pull_request_number'),
    draft: result.draft === true,
  };
}

function requireCompletedJob(job: IntegrationJob): Record<string, unknown> {
  if (job.state !== 'SUCCEEDED' || job.result === undefined) {
    throw new PairedDeviceRuntimeError(
      'FAILED_PRECONDITION',
      `The recorded integration job is ${job.state} and cannot answer this request.`,
    );
  }
  return job.result;
}

function readResultText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The recorded integration job result is missing ${field}.`);
  }
  return value;
}

function readResultNumber(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    throw new Error(`The recorded integration job result is missing ${field}.`);
  }
  return BigInt(value);
}

/**
 * The title is the one line an operator sees in a list of issues, so it is the
 * problem itself rather than a template. The screen is appended because two
 * reports of "the map is blank" from different screens are different bugs.
 */
function buildIssueTitle(problem: string, screenId: string): string {
  const firstLine = problem.split('\n', 1)[0]?.trim() ?? '';
  const subject = firstLine.length === 0 ? 'Interface report' : firstLine;
  const scoped = screenId.trim().length === 0 ? subject : `${subject} (${screenId.trim()})`;
  return scoped.length <= maxIssueTitleLength
    ? scoped
    : `${scoped.slice(0, maxIssueTitleLength - 1)}…`;
}

function buildIssueBody(request: integrationV1.BuildIssueDraftRequest): string {
  const sections: string[] = [];
  appendSection(sections, 'Problem', request.problem);
  appendSection(sections, 'Reproduction', request.reproduction);
  const context = [
    labelled('Element', request.elementId),
    labelled('Screen', request.screenId),
    labelled('Viewport', request.viewport),
    labelled('Theme', request.theme),
  ].filter((line) => line !== undefined);
  if (context.length > 0) sections.push(`## Context\n\n${context.join('\n')}`);
  const change = [
    labelled('Before', request.beforeValue),
    labelled('After', request.afterValue),
  ].filter((line) => line !== undefined);
  if (change.length > 0) sections.push(`## Change\n\n${change.join('\n')}`);
  if (request.patch.trim().length > 0) {
    sections.push(`## Patch\n\n\`\`\`diff\n${request.patch}\n\`\`\``);
  }
  if (request.attachments.length > 0) {
    // Named, not embedded: a URL cannot carry bytes, and an issue body that
    // pretended to hold a screenshot would send the operator looking for one
    // that was never uploaded.
    const listed = request.attachments.map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mediaType}, ${attachment.content.length.toString()} bytes)`,
    );
    sections.push(`## Attachments\n\n${listed.join('\n')}`);
  }
  return sections.join('\n\n');
}

function appendSection(sections: string[], heading: string, value: string): void {
  if (value.trim().length === 0) return;
  sections.push(`## ${heading}\n\n${value.trim()}`);
}

function labelled(name: string, value: string): string | undefined {
  return value.trim().length === 0 ? undefined : `- ${name}: \`${value.trim()}\``;
}

/**
 * Builds the address GitHub documents for a prefilled issue: `title`, `body`
 * and `labels` on `/issues/new`. The parameters are GitHub's own, not an
 * invention here, which is why they are spelled exactly as their documentation
 * spells them.
 */
function buildPrefilledIssueUrl(repository: string, draft: integrationV1.IssueDraft): string {
  const base = `https://github.com/${repository}/issues/new`;
  const parameters = new URLSearchParams();
  parameters.set('title', draft.title);
  if (draft.labels.length > 0) parameters.set('labels', draft.labels.join(','));
  // Measured against what is actually built. The budget used to be computed
  // with `encodeURIComponent` while the address was assembled by
  // `URLSearchParams`, which encodes a space as `+` and leaves several
  // characters alone — so a body that fitted the estimate could still overrun
  // the address that was sent.
  const withoutBody = `${base}?${parameters.toString()}`;
  const budget = maxPrefilledIssueUrlLength - withoutBody.length - '&body='.length;
  parameters.set('body', fitEncoded(draft.bodyMarkdown, budget));
  return `${base}?${parameters.toString()}`;
}

/** How long this value grows once `URLSearchParams` has encoded it. */
function encodedLength(value: string): number {
  return new URLSearchParams({ body: value }).toString().length - 'body='.length;
}

/**
 * Trims markdown until its encoded form fits the remaining budget.
 *
 * Cutting the raw string is not enough: one Cyrillic character becomes nine
 * encoded bytes, so a body that looks short can still overrun the address. The
 * cut is made on code points rather than UTF-16 units — slicing between a
 * surrogate pair produced a lone half, and encoding one throws `URIError`
 * inside the loop condition, so a report containing a single emoji crashed the
 * call rather than being shortened.
 */
function fitEncoded(body: string, budget: number): string {
  if (budget <= 0) return '';
  if (encodedLength(body) <= budget) return body;
  const marker = truncationMarker;
  const markerCost = encodedLength(marker);
  let kept = [...body];
  while (kept.length > 0 && encodedLength(kept.join('')) + markerCost > budget) {
    kept = kept.slice(0, Math.max(0, Math.floor(kept.length * 0.9) - 1));
  }
  return `${kept.join('')}${marker}`;
}

function assertAttachmentBudget(attachments: readonly integrationV1.IssueAttachment[]): void {
  if (attachments.length > maxAttachmentCount) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `A report carries at most ${maxAttachmentCount.toString()} attachments.`,
    );
  }
  const total = attachments.reduce((sum, attachment) => sum + attachment.content.length, 0);
  if (total > maxAttachmentBytes) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      `A report's attachments must total at most ${maxAttachmentBytes.toString()} bytes.`,
    );
  }
}

/**
 * Resolves and validates the repository a request names.
 *
 * The value is interpolated into a URL path, so anything but `owner/name` is
 * refused: a repository of `a/b/../../elsewhere` would produce an address
 * pointing somewhere the operator did not ask for.
 */
/**
 * The repository a draft is stamped with when the client names none.
 *
 * Building a draft must work on a machine that will never reach GitHub — that
 * is the ordinary case on a shoot — so an absent default is an empty field
 * here rather than a refusal. Sending anywhere still goes through
 * {@link resolveRepository}, which does refuse.
 */
function declaredRepository(options: IntegrationServiceOptions): string {
  const repository = options.issueRepository?.trim() ?? '';
  if (repository.length === 0) return '';
  if (!repositoryPattern.test(repository)) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      'This control plane declares a repository that is not owner/name.',
    );
  }
  return repository;
}

function resolveRepository(requested: string, options: IntegrationServiceOptions): string {
  const repository = (
    requested.trim().length > 0 ? requested : (options.issueRepository ?? '')
  ).trim();
  if (repository.length === 0) {
    throw new PairedDeviceRuntimeError(
      'INVALID_ARGUMENT',
      'No repository was supplied and this control plane declares no default.',
    );
  }
  if (!repositoryPattern.test(repository)) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'repository must be owner/name.');
  }
  return repository;
}

function toProtocolProposal(record: TranslationProposalRecord) {
  return {
    id: { value: record.id },
    locale: record.locale,
    key: record.translationKey,
    sourceValue: record.sourceValue,
    proposedValue: record.proposedValue,
    englishReference: record.englishReference,
    placeholders: [...record.placeholders],
    transliteration: record.transliteration,
    revision: {
      number: record.revision,
      etag: `translation-proposal-${record.id}-revision-${record.revision.toString()}`,
    },
  };
}

function toProviderName(provider: integrationV1.IntegrationProvider): IntegrationProviderName {
  if (provider === integrationV1.IntegrationProvider.GITHUB) return 'GITHUB';
  if (provider === integrationV1.IntegrationProvider.YANDEX_MAPS) return 'YANDEX_MAPS';
  if (provider === integrationV1.IntegrationProvider.VERCEL) return 'VERCEL';
  throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'provider must be a known integration.');
}

/**
 * The reported state is derived from this control plane's own rows and nothing
 * else. `READY` therefore means "configured, and the last thing we sent went
 * through", not "GitHub is up": no request is made here, so a stronger claim
 * would be one nobody checked.
 */
function toIntegrationState(status: {
  readonly configured: boolean;
  readonly latestJobState: string | undefined;
}): integrationV1.IntegrationState {
  if (!status.configured) return integrationV1.IntegrationState.NOT_CONFIGURED;
  if (status.latestJobState === 'FAILED') return integrationV1.IntegrationState.DEGRADED;
  return integrationV1.IntegrationState.READY;
}

function toIntegrationDetail(status: {
  readonly configured: boolean;
  readonly latestJobKind: string | undefined;
  readonly latestJobState: string | undefined;
}): string {
  if (!status.configured) return 'No installation is registered for this group.';
  if (status.latestJobState === undefined) return 'No request has been sent for this provider.';
  return `The last ${status.latestJobKind ?? 'request'} is ${status.latestJobState}.`;
}

function toProtocolPullRequestState(
  state: GitHubPullRequestStatus['state'],
): integrationV1.PullRequestState {
  if (state === 'OPEN') return integrationV1.PullRequestState.OPEN;
  if (state === 'MERGED') return integrationV1.PullRequestState.MERGED;
  return integrationV1.PullRequestState.CLOSED;
}

function authenticate(
  options: IntegrationServiceOptions,
  context: HandlerContext,
): Awaitable<AuthenticatedDevice> {
  return options.runtime.authenticateAccessToken(readBearerToken(context));
}

function readBearerToken(context: HandlerContext): string {
  const header = context.requestHeader.get('authorization');
  const match = header === null ? undefined : /^Bearer ([^\s]+)$/u.exec(header.trim());
  if (match?.[1] === undefined) {
    throw controlPlaneFailure(ControlPlaneFailure.BEARER_TOKEN_REQUIRED);
  }
  return match[1];
}

function requireStore(options: IntegrationServiceOptions): IntegrationStore {
  if (options.store === undefined) {
    throw controlPlaneFailure(ControlPlaneFailure.INTEGRATION_STORAGE_UNAVAILABLE);
  }
  return options.store;
}

function requireGateway(options: IntegrationServiceOptions): GitHubIntegrationGateway {
  if (options.github === undefined) {
    throw controlPlaneFailure(ControlPlaneFailure.INTEGRATION_GITHUB_UNAVAILABLE);
  }
  return options.github;
}

/**
 * A device's session names exactly one group, so a request for any other group
 * is refused before it can reach a statement.
 */
function assertAuthenticatedGroup(authenticated: AuthenticatedDevice, groupId: string): void {
  if (authenticated.group.id !== groupId) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'The authenticated device does not belong to the requested group.',
    );
  }
}

/**
 * The first of two checks. This one refuses a viewer before a statement runs;
 * the store repeats it in SQL, which is the one that holds when a device is
 * demoted between authentication and the write.
 */
function assertWriter(authenticated: AuthenticatedDevice): void {
  if (authenticated.role === 'VIEWER') {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'A viewer cannot raise integration work for the group.',
    );
  }
}

function assertContextActor(
  authenticated: AuthenticatedDevice,
  actorDeviceId: string | undefined,
): void {
  if (actorDeviceId === undefined || actorDeviceId.length === 0) return;
  if (actorDeviceId !== authenticated.device.id) {
    throw new PairedDeviceRuntimeError(
      'PERMISSION_DENIED',
      'The mutation context actor does not match the authenticated device.',
    );
  }
}

/**
 * Every method that sends something outside this machine requires an explicit
 * confirmation. An issue and a pull request are public and permanent, and a
 * misfired hotkey during a shoot must not be able to publish one.
 */
function assertConfirmed(confirmed: boolean, action: string): void {
  if (confirmed) return;
  throw new PairedDeviceRuntimeError(
    'FAILED_PRECONDITION',
    `${action} requires an explicit confirmation.`,
  );
}

function requireResourceId(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  return value.trim();
}

function requireText(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', `${field} must not be empty.`);
  }
  return value.trim();
}

/**
 * `request_id` is the only part of `MutationContext` that carries idempotency
 * meaning. `correlation_id` is response metadata and `issued_at` is a client
 * clock reading, so neither may take part in retry identity.
 */
function toMutationReceiptInput(requestId: string | undefined): {
  readonly mutation?: MutationReceiptContext;
} {
  try {
    const normalized = normalizeRequestId(requestId);
    return normalized === undefined ? {} : { mutation: { requestId: normalized } };
  } catch (error: unknown) {
    if (error instanceof MutationRequestIdError) {
      throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', error.message);
    }
    throw error;
  }
}

/**
 * Mirrors the mapping `sync/service.ts` applies to the same error type. It is
 * duplicated rather than shared because that module exports neither the mapper
 * nor the code table; a shared `sync/connect-errors.ts` would remove this copy.
 */
