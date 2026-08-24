import type { SqlClient } from '../db/database.js';
import type { MutationReceiptClaim, MutationReceiptGuard } from '../sync/receipt-guard.js';
import type { FingerprintField, MutationReceiptContext, MutationScope } from '../sync/receipts.js';
import {
  normalizeDatabaseError,
  readBigInt,
  readBytes,
  readDate,
  readJsonObject,
  readOptionalText,
  readText,
  readTextArray,
  sql,
} from '../sync/rows.js';
import { PairedDeviceRuntimeError } from '../sync/runtime.js';

/**
 * The adapter behind `IntegrationService`: outbound work, the GitHub
 * credential at rest, and the translation proposals a shoot raises about its
 * own interface.
 *
 * Three tables meet here because all three describe the same thing from
 * different angles — what this control plane is allowed to do on someone
 * else's service, what it has already asked for, and what it is waiting to
 * hear back. Splitting them into three stores would give each its own copy of
 * the membership re-check and the receipt gate.
 *
 * None of the three columns that carry state has a CHECK constraint:
 * `integration_jobs.state`, `translation_proposals.status` and
 * `integration_jobs.kind` are free text in migration 0001, and migration 0008
 * did not add one. This module is therefore the only thing keeping those
 * columns to a declared vocabulary, which is why the vocabularies below are
 * exported constants rather than string literals scattered through the
 * statements.
 */

/** The declared job vocabulary. Nothing outside this set is ever written. */
export const integrationJobStates = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type IntegrationJobState = (typeof integrationJobStates)[number];

/**
 * The transitions a job may make.
 *
 * `SUCCEEDED`, `FAILED` and `CANCELLED` list nothing: a finished job is a
 * record of what this control plane already asked GitHub to do, and moving it
 * back into the queue would ask a second time. A worker that wants another
 * attempt enqueues another job.
 */
const integrationJobTransitions: Readonly<
  Record<IntegrationJobState, readonly IntegrationJobState[]>
> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

/** The declared job kinds. `kind` is free text, so this is its only definition. */
export const integrationJobKinds = ['CREATE_ISSUE', 'CREATE_TRANSLATION_PULL_REQUEST'] as const;
export type IntegrationJobKind = (typeof integrationJobKinds)[number];

/**
 * Provider names are stored as the protobuf enum member name rather than its
 * wire number, for the same reason `sync_events.kind` is: an operator reading
 * the table directly must be able to tell what a row means, and a bare number
 * from a newer client would be indistinguishable from an unset one.
 */
export const integrationProviders = ['GITHUB', 'YANDEX_MAPS', 'VERCEL'] as const;
export type IntegrationProviderName = (typeof integrationProviders)[number];

/** The declared proposal vocabulary. `translation_proposals.status` is free text. */
export const translationProposalStatuses = ['DRAFT', 'PROPOSED', 'MERGED', 'REJECTED'] as const;
export type TranslationProposalStatus = (typeof translationProposalStatuses)[number];

/**
 * A proposal's status is append-only past its last decision. `MERGED` and
 * `REJECTED` list no successor, so a proposal that reached either can never be
 * re-opened: the group has ruled on that string, and rewriting the ruling
 * would silently change what a reviewer approved.
 */
const translationProposalTransitions: Readonly<
  Record<TranslationProposalStatus, readonly TranslationProposalStatus[]>
> = {
  DRAFT: ['PROPOSED', 'REJECTED'],
  PROPOSED: ['DRAFT', 'MERGED', 'REJECTED'],
  MERGED: [],
  REJECTED: [],
};

const terminalTranslationProposalStatuses: readonly TranslationProposalStatus[] = [
  'MERGED',
  'REJECTED',
];

/**
 * The encryption seam for `github_installations.encrypted_credentials`.
 *
 * The column is `bytea` and `ControlPlaneConfig` carries no encryption key, so
 * there is nowhere in this package a key could legitimately come from. The
 * port keeps it in the caller's closure: this store receives the ability to
 * seal and open, never the material that does it, so the key is not a property
 * of the store, is not enumerable on it, and cannot reach a log line that
 * serializes it.
 *
 * `seal` must be authenticated encryption. A store that could only encrypt
 * would accept a tampered ciphertext and hand the result to GitHub as a
 * bearer credential.
 */
export interface CredentialSealer {
  seal(plaintext: string): Uint8Array;
  open(sealed: Uint8Array): string;
}

export interface IntegrationJob {
  readonly id: string;
  readonly groupId: string;
  readonly provider: IntegrationProviderName;
  readonly kind: IntegrationJobKind;
  readonly state: IntegrationJobState;
  readonly payload: Record<string, unknown>;
  readonly result: Record<string, unknown> | undefined;
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GitHubInstallation {
  readonly id: string;
  readonly groupId: string;
  readonly installationId: bigint;
  readonly repository: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TranslationProposalRecord {
  readonly id: string;
  readonly groupId: string;
  readonly locale: string;
  readonly translationKey: string;
  readonly sourceValue: string;
  readonly proposedValue: string;
  readonly englishReference: string;
  readonly placeholders: readonly string[];
  readonly transliteration: string;
  readonly revision: bigint;
  readonly status: TranslationProposalStatus;
  readonly pullRequestUrl: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What `GetIntegrationStatus` can answer from this control plane's own tables. */
export interface IntegrationStatusRecord {
  readonly provider: IntegrationProviderName;
  readonly configured: boolean;
  readonly accountLabel: string;
  readonly latestJobKind: IntegrationJobKind | undefined;
  readonly latestJobState: IntegrationJobState | undefined;
  readonly checkedAt: Date;
}

export interface EnqueueIntegrationJobInput {
  readonly groupId: string;
  readonly actorDeviceId: string;
  readonly provider: IntegrationProviderName;
  readonly kind: IntegrationJobKind;
  readonly payload: Record<string, unknown>;
  readonly correlationId?: string;
  readonly mutation?: MutationReceiptContext;
}

export interface TransitionIntegrationJobInput {
  readonly groupId: string;
  readonly jobId: string;
  readonly from: IntegrationJobState;
  readonly to: IntegrationJobState;
  readonly result?: Record<string, unknown>;
}

export interface PutGitHubInstallationInput {
  readonly groupId: string;
  readonly actorDeviceId: string;
  readonly installationId: bigint;
  readonly repository: string;
  /** The raw credential. It is sealed before it reaches a statement parameter. */
  readonly credentials: string;
  readonly mutation?: MutationReceiptContext;
}

export interface ProposeTranslationInput {
  readonly groupId: string;
  readonly actorDeviceId: string;
  readonly locale: string;
  readonly translationKey: string;
  readonly sourceValue: string;
  readonly proposedValue: string;
  readonly englishReference?: string;
  readonly placeholders?: readonly string[];
  readonly transliteration?: string;
  readonly mutation?: MutationReceiptContext;
}

export interface UpdateTranslationProposalInput {
  readonly groupId: string;
  readonly actorDeviceId: string;
  readonly proposalId: string;
  readonly from: TranslationProposalStatus;
  readonly to: TranslationProposalStatus;
  readonly pullRequestUrl?: string;
  readonly mutation?: MutationReceiptContext;
}

export interface IntegrationStore {
  enqueueJob(input: EnqueueIntegrationJobInput): Promise<IntegrationJob>;
  transitionJob(input: TransitionIntegrationJobInput): Promise<IntegrationJob>;
  readJob(groupId: string, jobId: string): Promise<IntegrationJob | undefined>;
  putInstallation(input: PutGitHubInstallationInput): Promise<GitHubInstallation>;
  readInstallation(groupId: string): Promise<GitHubInstallation | undefined>;
  openInstallationCredentials(groupId: string): Promise<string>;
  proposeTranslation(input: ProposeTranslationInput): Promise<TranslationProposalRecord>;
  updateProposal(input: UpdateTranslationProposalInput): Promise<TranslationProposalRecord>;
  readProposal(groupId: string, proposalId: string): Promise<TranslationProposalRecord | undefined>;
  readStatus(
    groupId: string,
    actorDeviceId: string,
    provider: IntegrationProviderName,
  ): Promise<IntegrationStatusRecord>;
}

export interface DurableIntegrationStoreOptions {
  readonly database: SqlClient;
  /**
   * Supplied when the store must answer retried mutations. Without it a
   * request that carries a request id is refused rather than performed a
   * second time under a different identity.
   */
  readonly receipts?: MutationReceiptGuard;
  /**
   * Supplied when this deployment may hold a GitHub credential. Without it
   * `putInstallation` refuses; it never falls back to storing the plaintext,
   * because a `bytea` column full of readable tokens is worse than a control
   * plane that cannot talk to GitHub.
   */
  readonly credentialSealer?: CredentialSealer;
  readonly now?: () => Date;
}

/**
 * The shared prologue of every mutation in this module.
 *
 * It is not `sync/group-mutations.ts`'s spine: that one locks the `groups` row
 * and bumps its revision, which is right for a mutation that changes the group
 * document and wrong for one that only enqueues work. Enqueueing a job behind
 * the group lock would make a burst of issue reports contend with renaming the
 * group, for no property either of them needs.
 *
 * Parameter positions are fixed so each mutation can add its own without
 * renumbering the prologue:
 *
 * - `$1` group id
 * - `$2` acting device id
 * - `$3` the mutation instant
 * - `$4` receipt scope, or NULL when the caller opted out of retries
 * - `$5` receipt request-id hash, or NULL
 * - `$6` the roles this mutation accepts, as a JSON array of strings
 * - `$7` onwards: whatever the mutation itself needs
 */
const integrationMutationPrologue = `WITH locked_receipt AS MATERIALIZED (
           -- The claim was committed by its own statement, so the row is
           -- visible here. FOR UPDATE holds it for the duration of this
           -- mutation, which serializes concurrent retries of one request
           -- identifier.
           SELECT receipt.request_id_hash
           FROM mutation_receipts AS receipt
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
             AND receipt.completed_at IS NULL
           FOR UPDATE OF receipt
         ),
         mutation_gate AS MATERIALIZED (
           SELECT 1 AS open FROM locked_receipt
           UNION ALL
           SELECT 1 AS open WHERE $5::text IS NULL
         ),
         authorized_actor AS MATERIALIZED (
           -- Authorization is re-checked here rather than trusted from the
           -- caller: an access token stays valid for its lifetime, so a device
           -- demoted or revoked a moment ago still presents a token this
           -- process accepted, and only the join refuses it.
           SELECT membership.group_id, membership.device_id, membership.role
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           CROSS JOIN mutation_gate
           WHERE membership.group_id = $1
             AND membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND membership.role IN (SELECT jsonb_array_elements_text($6::jsonb))
             AND devices.status <> 'REVOKED'
           FOR UPDATE OF membership
         )`;

const writerRoles = JSON.stringify(['EDITOR', 'ADMIN']);
const administratorRoles = JSON.stringify(['ADMIN']);

/**
 * The `integration_jobs`, `github_installations` and `translation_proposals`
 * adapter.
 *
 * Every mutation is one parameterized statement built from data-modifying
 * CTEs. The Neon HTTP driver has no interactive transaction — it cannot read a
 * row in the middle of one — so a read-then-write would let a revoked device
 * write anyway, let two workers claim the same queued job, and let two retries
 * of one request each enqueue their own.
 */
export class DurableIntegrationStore implements IntegrationStore {
  readonly #database: SqlClient;
  readonly #receipts: MutationReceiptGuard | undefined;
  readonly #sealer: CredentialSealer | undefined;
  readonly #now: () => Date;

  constructor(options: DurableIntegrationStoreOptions) {
    this.#database = options.database;
    this.#receipts = options.receipts;
    this.#sealer = options.credentialSealer;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Puts one unit of outbound work on the queue.
   *
   * The job is the durable record that the group asked for something to leave
   * this machine. It is written before any network call, so a control plane
   * that dies mid-request leaves evidence of what it was doing rather than a
   * silent gap.
   */
  async enqueueJob(input: EnqueueIntegrationJobInput): Promise<IntegrationJob> {
    const payload = JSON.stringify(input.payload);
    const correlationId = input.correlationId ?? '';
    const now = this.#now();
    const receipt = await this.claimReceipt('ENQUEUE_INTEGRATION_JOB', input.mutation, now, [
      ['group_id', input.groupId],
      ['actor_device_id', input.actorDeviceId],
      ['provider', input.provider],
      ['kind', input.kind],
      ['payload', payload],
    ]);
    if (receipt?.claimed === false) return this.replayJob(receipt);

    const rows = await this.query(
      sql(
        `${integrationMutationPrologue},
         enqueued_job AS (
           INSERT INTO integration_jobs AS job (
             id, group_id, provider, kind, state, payload, correlation_id, created_at, updated_at
           )
           SELECT
             gen_random_uuid(), authorized_actor.group_id, $7, $8, $9, $10::jsonb, $11, $3, $3
           FROM authorized_actor
           ${jobProjection}
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = enqueued_job.group_id,
               resource_id = enqueued_job.id,
               completed_at = $3
           FROM enqueued_job
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           (SELECT to_jsonb(enqueued_job) FROM enqueued_job) AS job`,
        [
          input.groupId,
          input.actorDeviceId,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          writerRoles,
          input.provider,
          input.kind,
          'QUEUED' satisfies IntegrationJobState,
          payload,
          correlationId,
        ],
      ),
    );
    const row = requireStatementRow(rows);
    if (receipt !== undefined && row.receipt_claimed !== true) return this.replayJob(receipt);
    const job = optionalRecord(row.job, 'job');
    if (job === undefined) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Only an active editor or administrator of the group can enqueue an integration job.',
      );
    }
    return toIntegrationJob(job);
  }

  /**
   * Moves a job between declared states, refusing anything else.
   *
   * The refusal lives in `WHERE locked_job.state = $4`, so a transition that
   * lost a race matches no row and changes nothing. That is the whole point of
   * the shape: two workers claiming one queued job both reach the `FOR UPDATE`,
   * the second one is re-evaluated against the row the first already moved, and
   * it observes `RUNNING` instead of `QUEUED`. Distinguishing that from a
   * missing job matters — a refused transition means someone else is doing the
   * work, and a missing job means the caller is asking about nothing.
   *
   * This is a server-side operation. No RPC in `IntegrationService` moves a
   * job, so there is no acting device to authorize; the caller is this control
   * plane's own worker, already inside the group's authorization.
   */
  async transitionJob(input: TransitionIntegrationJobInput): Promise<IntegrationJob> {
    assertDeclaredTransition(
      integrationJobTransitions,
      input.from,
      input.to,
      'integration job state',
    );
    const now = this.#now();
    const rows = await this.query(
      sql(
        `WITH locked_job AS MATERIALIZED (
           -- The lock is taken before the update so a loser of the race reads
           -- the state the winner left, not the snapshot it started from.
           SELECT job.id, job.group_id, job.state
           FROM integration_jobs AS job
           WHERE job.id = $1 AND job.group_id = $2
           FOR UPDATE OF job
         ),
         moved_job AS (
           UPDATE integration_jobs AS job
           SET state = $3,
               result = COALESCE($5::jsonb, job.result),
               updated_at = $6
           FROM locked_job
           WHERE job.id = locked_job.id
             AND locked_job.state = $4
           ${jobProjection}
         )
         SELECT
           (SELECT locked_job.state FROM locked_job) AS observed_state,
           (SELECT to_jsonb(moved_job) FROM moved_job) AS job`,
        [
          input.jobId,
          input.groupId,
          input.to,
          input.from,
          input.result === undefined ? null : JSON.stringify(input.result),
          now,
        ],
      ),
    );
    const row = requireStatementRow(rows);
    const observed = readOptionalText(row.observed_state);
    if (observed === undefined) {
      throw new PairedDeviceRuntimeError(
        'NOT_FOUND',
        'The integration job does not exist in this group.',
      );
    }
    const job = optionalRecord(row.job, 'job');
    if (job === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        `The integration job is ${observed} and cannot move to ${input.to}.`,
      );
    }
    return toIntegrationJob(job);
  }

  /** A server-side read, for the worker and for answering a retried enqueue. */
  async readJob(groupId: string, jobId: string): Promise<IntegrationJob | undefined> {
    const rows = await this.query(
      sql(
        `SELECT to_jsonb(job) AS job
         FROM (
           SELECT
             integration_job.id,
             integration_job.group_id,
             integration_job.provider,
             integration_job.kind,
             integration_job.state,
             integration_job.payload,
             integration_job.result,
             integration_job.correlation_id,
             integration_job.created_at,
             integration_job.updated_at
           FROM integration_jobs AS integration_job
           WHERE integration_job.id = $1 AND integration_job.group_id = $2
         ) AS job`,
        [jobId, groupId],
      ),
    );
    const record = optionalRecord(rows[0]?.job, 'job');
    return record === undefined ? undefined : toIntegrationJob(record);
  }

  /**
   * Records the GitHub credential a group's installation issued.
   *
   * The plaintext never becomes a statement parameter: it is sealed here and
   * only the sealed bytes are bound, so the credential is absent from the
   * driver's parameter list, from any statement log, and from the row. The
   * projection deliberately omits `encrypted_credentials` as well — a caller
   * that wants the credential asks for it by name through
   * {@link openInstallationCredentials}.
   */
  async putInstallation(input: PutGitHubInstallationInput): Promise<GitHubInstallation> {
    const sealed = this.requireSealer().seal(input.credentials);
    const now = this.#now();
    const receipt = await this.claimReceipt('PUT_GITHUB_INSTALLATION', input.mutation, now, [
      ['group_id', input.groupId],
      ['actor_device_id', input.actorDeviceId],
      ['installation_id', input.installationId.toString()],
      ['repository', input.repository],
    ]);
    if (receipt?.claimed === false) return this.replayInstallation(receipt);

    const rows = await this.query(
      sql(
        `${integrationMutationPrologue},
         stored_installation AS (
           INSERT INTO github_installations AS installation (
             id, group_id, installation_id, repository, encrypted_credentials,
             created_at, updated_at
           )
           SELECT
             gen_random_uuid(), authorized_actor.group_id, $7::bigint, $8, $9, $3, $3
           FROM authorized_actor
           ON CONFLICT (installation_id) DO UPDATE
             SET repository = EXCLUDED.repository,
                 encrypted_credentials = EXCLUDED.encrypted_credentials,
                 updated_at = EXCLUDED.updated_at
             -- An installation belongs to the group that first registered it.
             -- Without this guard a second group could present the same
             -- installation id and take over another group's credential, which
             -- the UNIQUE column alone does not prevent.
             WHERE installation.group_id = EXCLUDED.group_id
           ${installationProjection}
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = stored_installation.group_id,
               resource_id = stored_installation.id,
               completed_at = $3
           FROM stored_installation
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM authorized_actor) AS actor_authorized,
           (SELECT to_jsonb(stored_installation) FROM stored_installation) AS installation`,
        [
          input.groupId,
          input.actorDeviceId,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          administratorRoles,
          input.installationId.toString(),
          input.repository,
          sealed,
        ],
      ),
    );
    const row = requireStatementRow(rows);
    if (receipt !== undefined && row.receipt_claimed !== true) {
      return this.replayInstallation(receipt);
    }
    if (row.actor_authorized !== true) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Only an active administrator of the group can register a GitHub installation.',
      );
    }
    const installation = optionalRecord(row.installation, 'installation');
    if (installation === undefined) {
      throw new PairedDeviceRuntimeError(
        'ALREADY_EXISTS',
        'The GitHub installation is already registered to another group.',
      );
    }
    return toGitHubInstallation(installation);
  }

  /**
   * The group's installation, without its credential.
   *
   * Migration 0008 made `translation_proposals` addressable per group but left
   * `github_installations` unique only on `installation_id`, so a group can
   * hold more than one row. The most recently written one is the one this
   * control plane would use, so it is the one reported.
   */
  async readInstallation(groupId: string): Promise<GitHubInstallation | undefined> {
    const rows = await this.query(
      sql(
        `SELECT to_jsonb(installation) AS installation
         FROM (
           SELECT
             github_installation.id,
             github_installation.group_id,
             github_installation.installation_id::text AS installation_id,
             github_installation.repository,
             github_installation.created_at,
             github_installation.updated_at
           FROM github_installations AS github_installation
           WHERE github_installation.group_id = $1
           ORDER BY github_installation.updated_at DESC, github_installation.installation_id DESC
           LIMIT 1
         ) AS installation`,
        [groupId],
      ),
    );
    const record = optionalRecord(rows[0]?.installation, 'installation');
    return record === undefined ? undefined : toGitHubInstallation(record);
  }

  /**
   * Opens the sealed credential for one outbound call.
   *
   * It is a separate method from {@link readInstallation} so that reading an
   * installation for display cannot accidentally return a bearer token: the
   * only way to obtain the plaintext is to ask for it by name, in the same
   * function that is about to spend it.
   */
  async openInstallationCredentials(groupId: string): Promise<string> {
    const sealer = this.requireSealer();
    const rows = await this.query(
      sql(
        `SELECT github_installation.encrypted_credentials AS encrypted_credentials
         FROM github_installations AS github_installation
         WHERE github_installation.group_id = $1
         ORDER BY github_installation.updated_at DESC, github_installation.installation_id DESC
         LIMIT 1`,
        [groupId],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'This group has no GitHub installation, so no request can be made on its behalf.',
      );
    }
    return sealer.open(readBytes(row.encrypted_credentials, 'encrypted_credentials'));
  }

  /**
   * Records one proposed translation.
   *
   * The insert carries no `ON CONFLICT`: `translation_proposals_key_idx` from
   * migration 0008 makes one proposal per (group, locale, key), and letting the
   * index reject the second one is what keeps two operators from silently
   * overwriting each other's wording. The rejection surfaces as
   * `ALREADY_EXISTS` through `normalizeDatabaseError`.
   */
  async proposeTranslation(input: ProposeTranslationInput): Promise<TranslationProposalRecord> {
    const placeholders = JSON.stringify([...(input.placeholders ?? [])]);
    const now = this.#now();
    const receipt = await this.claimReceipt('PROPOSE_TRANSLATION', input.mutation, now, [
      ['group_id', input.groupId],
      ['actor_device_id', input.actorDeviceId],
      ['locale', input.locale],
      ['translation_key', input.translationKey],
      ['source_value', input.sourceValue],
      ['proposed_value', input.proposedValue],
    ]);
    if (receipt?.claimed === false) return this.replayProposal(receipt);

    const rows = await this.query(
      sql(
        `${integrationMutationPrologue},
         inserted_proposal AS (
           INSERT INTO translation_proposals AS proposal (
             id, group_id, locale, translation_key, source_value, proposed_value,
             english_reference, placeholders, transliteration, revision, status,
             created_at, updated_at
           )
           SELECT
             gen_random_uuid(), authorized_actor.group_id, $7, $8, $9, $10, $11,
             ARRAY(SELECT jsonb_array_elements_text($12::jsonb)), $13, 1, $14, $3, $3
           FROM authorized_actor
           ${proposalProjection}
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = inserted_proposal.group_id,
               resource_id = inserted_proposal.id,
               completed_at = $3
           FROM inserted_proposal
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           (SELECT to_jsonb(inserted_proposal) FROM inserted_proposal) AS proposal`,
        [
          input.groupId,
          input.actorDeviceId,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          writerRoles,
          input.locale,
          input.translationKey,
          input.sourceValue,
          input.proposedValue,
          input.englishReference ?? null,
          placeholders,
          input.transliteration ?? null,
          'DRAFT' satisfies TranslationProposalStatus,
        ],
      ),
    );
    const row = requireStatementRow(rows);
    if (receipt !== undefined && row.receipt_claimed !== true) return this.replayProposal(receipt);
    const proposal = optionalRecord(row.proposal, 'proposal');
    if (proposal === undefined) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Only an active editor or administrator of the group can propose a translation.',
      );
    }
    return toTranslationProposal(proposal);
  }

  /**
   * Moves a proposal's status and bumps its revision.
   *
   * Two guards sit in the same `WHERE` as the write. `locked_proposal.status =
   * $8` is the declared transition, refusing a caller whose view of the
   * proposal is stale. The explicit terminal test beside it is not redundant:
   * it states the append-only rule at the only place that can enforce it, so a
   * later transition table that mistakenly listed a successor for `MERGED`
   * would still fail here rather than quietly re-open a merged string.
   */
  async updateProposal(input: UpdateTranslationProposalInput): Promise<TranslationProposalRecord> {
    assertDeclaredTransition(
      translationProposalTransitions,
      input.from,
      input.to,
      'translation proposal status',
    );
    const now = this.#now();
    const receipt = await this.claimReceipt('UPDATE_TRANSLATION_PROPOSAL', input.mutation, now, [
      ['group_id', input.groupId],
      ['actor_device_id', input.actorDeviceId],
      ['proposal_id', input.proposalId],
      ['from', input.from],
      ['to', input.to],
    ]);
    if (receipt?.claimed === false) return this.replayProposal(receipt);

    const rows = await this.query(
      sql(
        `${integrationMutationPrologue},
         locked_proposal AS MATERIALIZED (
           SELECT proposal.id, proposal.status, proposal.revision
           FROM translation_proposals AS proposal
           JOIN authorized_actor ON authorized_actor.group_id = proposal.group_id
           WHERE proposal.id = $7
           FOR UPDATE OF proposal
         ),
         updated_proposal AS (
           UPDATE translation_proposals AS proposal
           SET status = $9,
               pull_request_url = COALESCE($10, proposal.pull_request_url),
               revision = proposal.revision + 1,
               updated_at = $3
           FROM locked_proposal
           WHERE proposal.id = locked_proposal.id
             AND locked_proposal.status = $8
             AND locked_proposal.status NOT IN (SELECT jsonb_array_elements_text($11::jsonb))
           ${proposalProjection}
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = updated_proposal.group_id,
               resource_id = updated_proposal.id,
               revision = updated_proposal.revision::bigint,
               completed_at = $3
           FROM updated_proposal
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM authorized_actor) AS actor_authorized,
           (SELECT locked_proposal.status FROM locked_proposal) AS observed_status,
           (SELECT to_jsonb(updated_proposal) FROM updated_proposal) AS proposal`,
        [
          input.groupId,
          input.actorDeviceId,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          writerRoles,
          input.proposalId,
          input.from,
          input.to,
          input.pullRequestUrl ?? null,
          JSON.stringify([...terminalTranslationProposalStatuses]),
        ],
      ),
    );
    const row = requireStatementRow(rows);
    if (receipt !== undefined && row.receipt_claimed !== true) return this.replayProposal(receipt);
    if (row.actor_authorized !== true) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Only an active editor or administrator of the group can update a translation proposal.',
      );
    }
    const observed = readOptionalText(row.observed_status);
    if (observed === undefined) {
      throw new PairedDeviceRuntimeError(
        'NOT_FOUND',
        'The translation proposal does not exist in this group.',
      );
    }
    const proposal = optionalRecord(row.proposal, 'proposal');
    if (proposal === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        `The translation proposal is ${observed} and cannot move to ${input.to}.`,
      );
    }
    return toTranslationProposal(proposal);
  }

  async readProposal(
    groupId: string,
    proposalId: string,
  ): Promise<TranslationProposalRecord | undefined> {
    const rows = await this.query(
      sql(
        `SELECT to_jsonb(proposal) AS proposal
         FROM (
           SELECT
             translation_proposal.id,
             translation_proposal.group_id,
             translation_proposal.locale,
             translation_proposal.translation_key,
             translation_proposal.source_value,
             translation_proposal.proposed_value,
             translation_proposal.english_reference,
             translation_proposal.placeholders,
             translation_proposal.transliteration,
             translation_proposal.revision::text AS revision,
             translation_proposal.status,
             translation_proposal.pull_request_url,
             translation_proposal.created_at,
             translation_proposal.updated_at
           FROM translation_proposals AS translation_proposal
           WHERE translation_proposal.id = $1 AND translation_proposal.group_id = $2
         ) AS proposal`,
        [proposalId, groupId],
      ),
    );
    const record = optionalRecord(rows[0]?.proposal, 'proposal');
    return record === undefined ? undefined : toTranslationProposal(record);
  }

  /**
   * What this control plane knows about one provider, from its own tables.
   *
   * It reports configuration and the newest job's outcome, and nothing about
   * the provider's own health: no request is made here, so claiming `READY`
   * would be claiming something this process has not checked. The membership
   * join is the same re-check the mutations use — status names a repository and
   * an account label, which a revoked device has no business reading.
   */
  async readStatus(
    groupId: string,
    actorDeviceId: string,
    provider: IntegrationProviderName,
  ): Promise<IntegrationStatusRecord> {
    const rows = await this.query(
      sql(
        `WITH active_member AS (
           SELECT membership.group_id
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           WHERE membership.group_id = $1
             AND membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND devices.status <> 'REVOKED'
         )
         SELECT
           installation.repository AS repository,
           job.kind AS latest_job_kind,
           job.state AS latest_job_state
         FROM active_member
         LEFT JOIN LATERAL (
           SELECT github_installation.repository
           FROM github_installations AS github_installation
           WHERE github_installation.group_id = active_member.group_id
             AND $3 = 'GITHUB'
           ORDER BY github_installation.updated_at DESC
           LIMIT 1
         ) AS installation ON true
         LEFT JOIN LATERAL (
           SELECT integration_job.kind, integration_job.state
           FROM integration_jobs AS integration_job
           WHERE integration_job.group_id = active_member.group_id
             AND integration_job.provider = $3
           ORDER BY integration_job.created_at DESC
           LIMIT 1
         ) AS job ON true`,
        [groupId, actorDeviceId, provider],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'Only an active member of the group can read its integration status.',
      );
    }
    const repository = readOptionalText(row.repository);
    const latestJobKind = readOptionalText(row.latest_job_kind);
    const latestJobState = readOptionalText(row.latest_job_state);
    return {
      provider,
      configured: repository !== undefined,
      accountLabel: repository ?? '',
      latestJobKind:
        latestJobKind === undefined ? undefined : readIntegrationJobKind(latestJobKind),
      latestJobState:
        latestJobState === undefined ? undefined : readIntegrationJobState(latestJobState),
      checkedAt: this.#now(),
    };
  }

  private async replayJob(receipt: MutationReceiptClaim): Promise<IntegrationJob> {
    const recorded = await this.resolveRecorded(receipt, 'integration job');
    const job = await this.readJob(recorded.groupId, recorded.resourceId);
    if (job === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded integration job no longer exists and cannot be replayed.',
      );
    }
    return job;
  }

  private async replayProposal(receipt: MutationReceiptClaim): Promise<TranslationProposalRecord> {
    const recorded = await this.resolveRecorded(receipt, 'translation proposal');
    const proposal = await this.readProposal(recorded.groupId, recorded.resourceId);
    if (proposal === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded translation proposal no longer exists and cannot be replayed.',
      );
    }
    return proposal;
  }

  private async replayInstallation(receipt: MutationReceiptClaim): Promise<GitHubInstallation> {
    const recorded = await this.resolveRecorded(receipt, 'GitHub installation');
    const installation = await this.readInstallation(recorded.groupId);
    if (installation === undefined || installation.id !== recorded.resourceId) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded GitHub installation no longer exists and cannot be replayed.',
      );
    }
    return installation;
  }

  /**
   * Reads the row a completed receipt names.
   *
   * Migration 0008's outcome check requires both `group_id` and `resource_id`
   * for every scope this store uses, so a completed receipt missing either is
   * a row no statement in this repository could have written, and answering a
   * retry from it would be a guess.
   */
  private async resolveRecorded(
    receipt: MutationReceiptClaim,
    subject: string,
  ): Promise<{ readonly groupId: string; readonly resourceId: string }> {
    const outcome = await this.requireGuard().resolveRefused(
      receipt,
      new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        `The ${subject} mutation did not complete.`,
      ),
    );
    if (outcome.groupId === undefined || outcome.resourceId === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        `The recorded ${subject} mutation is missing its resource identity and cannot be replayed.`,
      );
    }
    return { groupId: outcome.groupId, resourceId: outcome.resourceId };
  }

  private claimReceipt(
    scope: MutationScope,
    mutation: MutationReceiptContext | undefined,
    now: Date,
    fields: readonly FingerprintField[],
  ): Promise<MutationReceiptClaim | undefined> {
    if (mutation === undefined) return Promise.resolve(undefined);
    return this.requireGuard().claim(scope, mutation, now, fields);
  }

  private requireGuard(): MutationReceiptGuard {
    const guard = this.#receipts;
    if (guard === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'This control plane cannot answer retried integration mutations: no receipt guard is configured.',
      );
    }
    return guard;
  }

  private requireSealer(): CredentialSealer {
    const sealer = this.#sealer;
    if (sealer === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'This control plane cannot hold a GitHub credential: no credentialSealer is configured.',
      );
    }
    return sealer;
  }

  private async query(
    statement: ReturnType<typeof sql>,
  ): Promise<readonly Record<string, unknown>[]> {
    try {
      return await this.#database.query(statement);
    } catch (error: unknown) {
      throw normalizeDatabaseError(error);
    }
  }
}

/**
 * Every mutation projects its row through `to_jsonb`, and every `bigint` is
 * cast to text on the way in. `to_jsonb` of a `bigint` is a JSON number, and a
 * JSON number above 2^53 comes back from `JSON.parse` already rounded — the
 * revision that reached the client would then not be the revision in the row.
 */
const jobProjection = `RETURNING
             job.id,
             job.group_id,
             job.provider,
             job.kind,
             job.state,
             job.payload,
             job.result,
             job.correlation_id,
             job.created_at,
             job.updated_at`;

const installationProjection = `RETURNING
             installation.id,
             installation.group_id,
             installation.installation_id::text AS installation_id,
             installation.repository,
             installation.created_at,
             installation.updated_at`;

const proposalProjection = `RETURNING
             proposal.id,
             proposal.group_id,
             proposal.locale,
             proposal.translation_key,
             proposal.source_value,
             proposal.proposed_value,
             proposal.english_reference,
             proposal.placeholders,
             proposal.transliteration,
             proposal.revision::text AS revision,
             proposal.status,
             proposal.pull_request_url,
             proposal.created_at,
             proposal.updated_at`;

function toIntegrationJob(row: Record<string, unknown>): IntegrationJob {
  return {
    id: readText(row.id, 'integration_jobs.id'),
    groupId: readText(row.group_id, 'integration_jobs.group_id'),
    provider: readIntegrationProvider(readText(row.provider, 'integration_jobs.provider')),
    kind: readIntegrationJobKind(readText(row.kind, 'integration_jobs.kind')),
    state: readIntegrationJobState(readText(row.state, 'integration_jobs.state')),
    payload: readJsonObject(row.payload, 'integration_jobs.payload'),
    result:
      row.result === null || row.result === undefined
        ? undefined
        : readJsonObject(row.result, 'integration_jobs.result'),
    correlationId: readOptionalText(row.correlation_id) ?? '',
    createdAt: readDate(row.created_at, 'integration_jobs.created_at'),
    updatedAt: readDate(row.updated_at, 'integration_jobs.updated_at'),
  };
}

function toGitHubInstallation(row: Record<string, unknown>): GitHubInstallation {
  return {
    id: readText(row.id, 'github_installations.id'),
    groupId: readText(row.group_id, 'github_installations.group_id'),
    installationId: readBigInt(row.installation_id, 'github_installations.installation_id'),
    repository: readText(row.repository, 'github_installations.repository'),
    createdAt: readDate(row.created_at, 'github_installations.created_at'),
    updatedAt: readDate(row.updated_at, 'github_installations.updated_at'),
  };
}

function toTranslationProposal(row: Record<string, unknown>): TranslationProposalRecord {
  return {
    id: readText(row.id, 'translation_proposals.id'),
    groupId: readText(row.group_id, 'translation_proposals.group_id'),
    locale: readText(row.locale, 'translation_proposals.locale'),
    translationKey: readText(row.translation_key, 'translation_proposals.translation_key'),
    sourceValue: readText(row.source_value, 'translation_proposals.source_value'),
    proposedValue: readText(row.proposed_value, 'translation_proposals.proposed_value'),
    englishReference: readOptionalText(row.english_reference) ?? '',
    placeholders: readTextArray(row.placeholders, 'translation_proposals.placeholders'),
    transliteration: readOptionalText(row.transliteration) ?? '',
    revision: readBigInt(row.revision, 'translation_proposals.revision'),
    status: readTranslationProposalStatus(readText(row.status, 'translation_proposals.status')),
    pullRequestUrl: readOptionalText(row.pull_request_url) ?? '',
    createdAt: readDate(row.created_at, 'translation_proposals.created_at'),
    updatedAt: readDate(row.updated_at, 'translation_proposals.updated_at'),
  };
}

/**
 * A statement built to return exactly one row that returned none is a defect
 * in this module, not an outcome a client can cause, so it raises a plain
 * `Error` rather than a runtime error a Connect code could be derived from.
 */
function requireStatementRow(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  const row = rows[0];
  if (row === undefined) {
    throw new Error('An integration mutation returned no row where exactly one was expected.');
  }
  return row;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  return readJsonObject(value, field);
}

function readIntegrationProvider(value: string): IntegrationProviderName {
  const provider = integrationProviders.find((candidate) => candidate === value);
  if (provider === undefined) {
    throw new Error(`The database returned an unknown integration provider: ${value}`);
  }
  return provider;
}

function readIntegrationJobKind(value: string): IntegrationJobKind {
  const kind = integrationJobKinds.find((candidate) => candidate === value);
  if (kind === undefined) {
    throw new Error(`The database returned an unknown integration job kind: ${value}`);
  }
  return kind;
}

function readIntegrationJobState(value: string): IntegrationJobState {
  const state = integrationJobStates.find((candidate) => candidate === value);
  if (state === undefined) {
    throw new Error(`The database returned an unknown integration job state: ${value}`);
  }
  return state;
}

function readTranslationProposalStatus(value: string): TranslationProposalStatus {
  const status = translationProposalStatuses.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new Error(`The database returned an unknown translation proposal status: ${value}`);
  }
  return status;
}

/**
 * Refuses a transition the vocabulary does not declare, before any statement
 * runs. The database would accept it — neither column has a CHECK — so this is
 * the only place a typo becomes an error instead of a row nothing can read.
 */
function assertDeclaredTransition(
  transitions: Readonly<Record<string, readonly string[]>>,
  from: string,
  to: string,
  subject: string,
): void {
  const allowed = transitions[from];
  if (allowed !== undefined && allowed.includes(to)) return;
  throw new PairedDeviceRuntimeError(
    'INVALID_ARGUMENT',
    `${from} to ${to} is not a declared ${subject} transition.`,
  );
}
