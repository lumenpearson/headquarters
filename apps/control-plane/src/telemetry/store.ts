import type { SqlClient } from '../db/database.js';
import type { MutationReceiptClaim, MutationReceiptGuard } from '../sync/receipt-guard.js';
import { requireOutcomeField } from '../sync/receipt-guard.js';
import type { FingerprintField, MutationReceiptContext, MutationScope } from '../sync/receipts.js';
import {
  isRecord,
  normalizeDatabaseError,
  readBigInt,
  readBoolean,
  readDate,
  readJsonArray,
  readJsonObject,
  readOptionalText,
  readText,
  requireOneRow,
  sql,
} from '../sync/rows.js';
import { PairedDeviceRuntimeError } from '../sync/runtime.js';
import type { Page } from '../sync/runtime.js';

/**
 * The `simulation_profiles` / `simulation_versions` adapter.
 *
 * A simulation profile is the only telemetry state this schema holds, and it is
 * held twice: `simulation_profiles` carries the profile a group is running now,
 * `simulation_versions` carries every profile the group has ever run. The
 * second table has no `patch` column, so a version is not a step that has to be
 * replayed on top of the versions before it — it is the whole profile. One row
 * is enough to reconstruct what was published at that revision, which is what
 * turns reverting into a read of one row followed by an ordinary write.
 *
 * Three fields of the published message are server-owned and therefore live in
 * columns rather than in the stored body: the profile's identifier, its
 * revision, and the instant it was written. Everything a client authored — its
 * group, name, preset kind, channels and timing — stays in the `profile` jsonb
 * exactly as it arrived. `simulation_versions` has no `group_id`, `name` or
 * `preset_kind` column of its own, so a version row whose body dropped those
 * fields could not be read back on its own; keeping the authored body whole is
 * what makes a version standalone.
 *
 * Every mutation is one parameterized statement built from data-modifying CTEs.
 * The Neon HTTP driver has no interactive transaction, so a read-then-write
 * would let two concurrent updates read one revision and write it twice, and
 * would let a device revoked between the read and the write publish anyway.
 */

/** A profile as stored: the authored body plus the three server-owned facts. */
export interface SimulationProfileRecord {
  readonly id: string;
  readonly groupId: string;
  /** The authored profile body, without identifier, revision or updated-at. */
  readonly profile: Record<string, unknown>;
  readonly revision: bigint;
  readonly updatedAt: Date;
}

/** One row of `simulation_versions`: a complete profile as it was published. */
export interface SimulationProfileVersion {
  readonly profileId: string;
  readonly revision: bigint;
  readonly profile: Record<string, unknown>;
  /** Absent once the device that wrote it is gone; the version outlives it. */
  readonly actorDeviceId: string | undefined;
  readonly createdAt: Date;
}

/** The identity every call re-checks in SQL rather than trusting from the caller. */
export interface SimulationActor {
  readonly groupId: string;
  readonly deviceId: string;
}

export interface ListSimulationProfilesInput extends SimulationActor {
  readonly pageSize: number;
  readonly cursor: string;
}

export interface CreateSimulationProfileInput extends SimulationActor {
  /** Allocated by the caller, so a retry's fingerprint does not depend on it. */
  readonly profileId: string;
  readonly name: string;
  readonly presetKind: string;
  readonly profile: Record<string, unknown>;
  readonly mutation?: MutationReceiptContext;
}

export interface UpdateSimulationProfileInput extends SimulationActor {
  readonly profileId: string;
  readonly name: string;
  readonly presetKind: string;
  readonly profile: Record<string, unknown>;
  /** When present, the write applies only while the profile still holds it. */
  readonly expectedRevision?: bigint;
  readonly mutation?: MutationReceiptContext;
}

export interface ApplySimulationPresetInput extends SimulationActor {
  readonly profileId: string;
  readonly name: string;
  readonly presetKind: string;
  readonly profile: Record<string, unknown>;
  readonly mutation?: MutationReceiptContext;
}

export interface SetSimulationTimeScaleInput extends SimulationActor {
  readonly profileId: string;
  readonly timeScale: number;
  readonly mutation?: MutationReceiptContext;
}

export interface DeleteSimulationProfileInput extends SimulationActor {
  readonly profileId: string;
  readonly mutation?: MutationReceiptContext;
}

export interface ReadSimulationVersionInput extends SimulationActor {
  readonly profileId: string;
  readonly revision: bigint;
}

/** What a delete leaves behind: the identity and the revision it removed. */
export interface DeletedSimulationProfile {
  readonly profileId: string;
  readonly revision: bigint;
}

export interface DurableSimulationProfileStoreOptions {
  readonly database: SqlClient;
  /** The runtime's own guard, so one request identifier means one thing everywhere. */
  readonly receipts: MutationReceiptGuard;
  readonly now?: () => Date;
}

const putScope: MutationScope = 'PUT_SIMULATION_PROFILE';
const deleteScope: MutationScope = 'DELETE_SIMULATION_PROFILE';
const defaultPageSize = 50;
const maxPageSize = 100;

/**
 * Locks the receipt and the acting membership.
 *
 * Parameter positions are fixed so a mutation can add its own without
 * renumbering the spine: `$1` group id, `$2` acting device id, `$3` the
 * mutation instant, `$4` receipt scope or NULL, `$5` receipt request-id hash or
 * NULL, `$6` onwards whatever the mutation itself needs.
 *
 * `mutation_gate` is what makes a caller that opted out of retries behave
 * identically to one whose claim is still live: with `$5` NULL the gate opens
 * unconditionally, and with a claim it opens only while that claim is
 * uncompleted. Only an active `EDITOR` or `ADMIN` reaches `authorized_writer`,
 * and that membership is locked because the same statement goes on to change
 * state belonging to the group.
 */
const writeMutationPrologue = `WITH locked_receipt AS MATERIALIZED (
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
         authorized_writer AS MATERIALIZED (
           SELECT membership.group_id, membership.device_id
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           CROSS JOIN mutation_gate
           WHERE membership.group_id = $1
             AND membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND membership.role IN ('EDITOR', 'ADMIN')
             AND devices.status <> 'REVOKED'
           FOR UPDATE OF membership
         )`;

/**
 * Locks the profile the mutation names.
 *
 * Two concurrent writes to one profile serialize here: the second waits for the
 * first to commit and then re-reads the row, so it derives its revision from
 * what the first wrote rather than from the value both started with. Without
 * the lock both would compute the same next revision and the unique index on
 * `(profile_id, revision)` would turn a lost update into a failed one.
 */
const lockedTargetProfile = `,
         target AS MATERIALIZED (
           SELECT stored.id, stored.group_id, stored.revision
           FROM simulation_profiles AS stored
           JOIN authorized_writer ON authorized_writer.group_id = stored.group_id
           WHERE stored.id = $6
           FOR UPDATE OF stored
         )`;

/**
 * Records the revision the profile now holds and completes the receipt.
 *
 * The version row and the profile row are written by one statement at one
 * revision. Splitting them would allow a revision with no history behind it,
 * which is the single state a table of complete profiles cannot describe.
 */
const writeMutationEpilogue = `,
         recorded_version AS (
           INSERT INTO simulation_versions (
             id, profile_id, revision, profile, actor_device_id, created_at
           )
           SELECT gen_random_uuid(), written.id, written.revision, written.profile, $2, $3
           FROM written
           RETURNING revision
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = written.group_id,
               resource_id = written.id,
               revision = written.revision,
               completed_at = $3
           FROM written
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )`;

/**
 * Built from scalar subqueries so the statement yields a row even when the gate
 * is shut; the replay path reads `receipt_claimed` explicitly instead of
 * inferring a retry from an empty result.
 */
const writeMutationProjection = `SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM authorized_writer) AS writer_authorized,
           (SELECT to_jsonb(written) FROM written) AS profile`;

const targetedWriteProjection = `${writeMutationProjection},
           EXISTS (SELECT 1 FROM target) AS target_present,
           (SELECT target.revision FROM target) AS target_revision`;

export class DurableSimulationProfileStore {
  readonly #database: SqlClient;
  readonly #receipts: MutationReceiptGuard;
  readonly #now: () => Date;

  constructor(options: DurableSimulationProfileStoreOptions) {
    this.#database = options.database;
    this.#receipts = options.receipts;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Every profile of a group, by name.
   *
   * Reading is open to any active member, a viewer included: a profile
   * describes what the wall will show, and a device allowed to watch the wall
   * is allowed to read what drives it.
   */
  async list(input: ListSimulationProfilesInput): Promise<Page<SimulationProfileRecord>> {
    const pageSize = normalizePageSize(input.pageSize);
    const cursor = decodeCursor(input.cursor);
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
         ),
         all_profiles AS MATERIALIZED (
           SELECT
             stored.id,
             stored.group_id,
             stored.name,
             stored.profile,
             stored.revision,
             stored.updated_at
           FROM simulation_profiles AS stored
           JOIN active_member ON active_member.group_id = stored.group_id
         ),
         page AS (
           SELECT *
           FROM all_profiles
           WHERE $3::text IS NULL OR (name, id) > ($3::text, $4::uuid)
           ORDER BY name ASC, id ASC
           LIMIT $5
         )
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           (SELECT COUNT(*) FROM all_profiles) AS approximate_total,
           COALESCE(
             jsonb_agg(to_jsonb(page) ORDER BY page.name ASC, page.id ASC),
             '[]'::jsonb
           ) AS items
         FROM page`,
        [input.groupId, input.deviceId, cursor?.name ?? null, cursor?.id ?? null, pageSize + 1],
      ),
    );
    const row = requireOneRow(rows, 'Unable to list the simulation profiles of the group.');
    if (!readBoolean(row.member_active, 'member_active')) throw notAMember();
    const items = readJsonArray(row.items, 'items');
    const hasMore = items.length > pageSize;
    const visible = hasMore ? items.slice(0, pageSize) : items;
    const last = visible.at(-1);
    return {
      items: visible.map(toRecord),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : '',
      // Forward keyset cursors only, as in `listDevices`, until the shared
      // `PageRequest` model gains an explicit direction field.
      previousCursor: '',
      hasMore,
      approximateTotal: readBigInt(row.approximate_total, 'approximate_total'),
    };
  }

  /**
   * Adds a profile the group did not have.
   *
   * The conflict target is `simulation_profiles_group_name_idx`, and the
   * conflict does nothing: a create that quietly overwrote the profile already
   * standing under that name would discard another operator's work and report
   * success for it.
   */
  async create(input: CreateSimulationProfileInput): Promise<SimulationProfileRecord> {
    const now = this.#now();
    const receipt = await this.claim(putScope, input.mutation, now, [
      ['operation', 'create'],
      ['group_id', input.groupId],
      ['actor_device_id', input.deviceId],
      ['name', input.name],
      ['preset_kind', input.presetKind],
      ['profile', JSON.stringify(input.profile)],
    ]);
    if (receipt?.claimed === false) return this.replayPut(receipt, input);

    const rows = await this.query(
      sql(
        `${writeMutationPrologue},
         written AS (
           INSERT INTO simulation_profiles (
             id, group_id, name, preset_kind, profile, revision, updated_at
           )
           SELECT $6, authorized_writer.group_id, $7, $8, $9::jsonb, 1, $3
           FROM authorized_writer
           ON CONFLICT (group_id, name) DO NOTHING
           RETURNING id, group_id, profile, revision, updated_at
         )${writeMutationEpilogue}
         ${writeMutationProjection}`,
        [
          input.groupId,
          input.deviceId,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          input.profileId,
          input.name,
          input.presetKind,
          JSON.stringify(input.profile),
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to create the simulation profile.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayPut(receipt, input);
    }
    if (!readBoolean(row.writer_authorized, 'writer_authorized')) throw notAWriter();
    if (row.profile === null || row.profile === undefined) {
      throw new PairedDeviceRuntimeError(
        'ALREADY_EXISTS',
        'The group already has a simulation profile with this name.',
      );
    }
    return toRecord(readJsonObject(row.profile, 'profile'));
  }

  /**
   * Replaces a profile with a new one at the next revision.
   *
   * This is also how history is rewound: a caller reads an earlier version and
   * publishes its body back. Nothing is deleted and no revision is reused, so a
   * revert becomes one more entry in the same append-only history instead of a
   * hole in it.
   */
  async update(input: UpdateSimulationProfileInput): Promise<SimulationProfileRecord> {
    const now = this.#now();
    const receipt = await this.claim(putScope, input.mutation, now, [
      ['operation', 'update'],
      ['group_id', input.groupId],
      ['actor_device_id', input.deviceId],
      ['profile_id', input.profileId],
      ['name', input.name],
      ['preset_kind', input.presetKind],
      ['profile', JSON.stringify(input.profile)],
      ['expected_revision', input.expectedRevision?.toString() ?? ''],
    ]);
    if (receipt?.claimed === false) return this.replayPut(receipt, input);

    const rows = await this.query(
      sql(
        `${writeMutationPrologue}${lockedTargetProfile},
         written AS (
           UPDATE simulation_profiles AS stored
           SET name = $7,
               preset_kind = $8,
               profile = $9::jsonb,
               revision = stored.revision + 1,
               updated_at = $3
           FROM target
           WHERE stored.id = target.id
             AND ($10::bigint IS NULL OR target.revision = $10::bigint)
           RETURNING
             stored.id, stored.group_id, stored.profile, stored.revision, stored.updated_at
         )${writeMutationEpilogue}
         ${targetedWriteProjection}`,
        [
          input.groupId,
          input.deviceId,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          input.profileId,
          input.name,
          input.presetKind,
          JSON.stringify(input.profile),
          input.expectedRevision?.toString() ?? null,
        ],
      ),
    );
    return this.readTargetedWrite(rows, receipt, input, 'Unable to update the simulation profile.');
  }

  /**
   * Puts the group's profile for one preset in place.
   *
   * A preset is addressed by name rather than by identifier, because the
   * request names only a group and a preset. The conflict target is the same
   * unique index, and here the conflict updates: applying one preset twice is
   * one profile at two revisions, never two profiles.
   */
  async applyPreset(input: ApplySimulationPresetInput): Promise<SimulationProfileRecord> {
    const now = this.#now();
    const receipt = await this.claim(putScope, input.mutation, now, [
      ['operation', 'apply_preset'],
      ['group_id', input.groupId],
      ['actor_device_id', input.deviceId],
      ['name', input.name],
      ['preset_kind', input.presetKind],
    ]);
    if (receipt?.claimed === false) return this.replayPut(receipt, input);

    const rows = await this.query(
      sql(
        `${writeMutationPrologue},
         written AS (
           INSERT INTO simulation_profiles (
             id, group_id, name, preset_kind, profile, revision, updated_at
           )
           SELECT $6, authorized_writer.group_id, $7, $8, $9::jsonb, 1, $3
           FROM authorized_writer
           ON CONFLICT (group_id, name) DO UPDATE
             SET preset_kind = EXCLUDED.preset_kind,
                 profile = EXCLUDED.profile,
                 revision = simulation_profiles.revision + 1,
                 updated_at = EXCLUDED.updated_at
           RETURNING id, group_id, profile, revision, updated_at
         )${writeMutationEpilogue}
         ${writeMutationProjection}`,
        [
          input.groupId,
          input.deviceId,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          input.profileId,
          input.name,
          input.presetKind,
          JSON.stringify(input.profile),
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to apply the simulation preset.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayPut(receipt, input);
    }
    if (!readBoolean(row.writer_authorized, 'writer_authorized')) throw notAWriter();
    return toRecord(readJsonObject(row.profile, 'profile'));
  }

  /**
   * Changes how fast a profile's timeline runs.
   *
   * The scale goes into the stored body rather than into a column of its own,
   * because `time_scale` is a field of the published profile and the body is
   * what a version replays. `jsonb_set` keeps the change to one statement:
   * reading the body out to edit it and writing it back would discard whatever
   * a concurrent update wrote in between.
   */
  async setTimeScale(input: SetSimulationTimeScaleInput): Promise<SimulationProfileRecord> {
    const now = this.#now();
    const receipt = await this.claim(putScope, input.mutation, now, [
      ['operation', 'set_time_scale'],
      ['group_id', input.groupId],
      ['actor_device_id', input.deviceId],
      ['profile_id', input.profileId],
      ['time_scale', input.timeScale.toString()],
    ]);
    if (receipt?.claimed === false) return this.replayPut(receipt, input);

    const rows = await this.query(
      sql(
        `${writeMutationPrologue}${lockedTargetProfile},
         written AS (
           UPDATE simulation_profiles AS stored
           SET profile = jsonb_set(stored.profile, '{timeScale}', to_jsonb($7::double precision)),
               revision = stored.revision + 1,
               updated_at = $3
           FROM target
           WHERE stored.id = target.id
           RETURNING
             stored.id, stored.group_id, stored.profile, stored.revision, stored.updated_at
         )${writeMutationEpilogue}
         ${targetedWriteProjection}`,
        [
          input.groupId,
          input.deviceId,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          input.profileId,
          input.timeScale,
        ],
      ),
    );
    return this.readTargetedWrite(
      rows,
      receipt,
      input,
      'Unable to change the simulation clock of the profile.',
    );
  }

  /**
   * Removes a profile and, by cascade, the whole of its history.
   *
   * This is the one mutation that writes no version row: a version belongs to a
   * profile and `simulation_versions.profile_id` cascades, so the row it would
   * hang from is gone by the time it could be written. The receipt keeps the
   * revision the profile held, so a retry answers with the state the caller's
   * own mutation removed rather than reporting a profile that never existed.
   */
  async delete(input: DeleteSimulationProfileInput): Promise<DeletedSimulationProfile> {
    const now = this.#now();
    const receipt = await this.claim(deleteScope, input.mutation, now, [
      ['group_id', input.groupId],
      ['actor_device_id', input.deviceId],
      ['profile_id', input.profileId],
    ]);
    if (receipt?.claimed === false) return this.replayDelete(receipt);

    const rows = await this.query(
      sql(
        `${writeMutationPrologue}${lockedTargetProfile},
         removed AS (
           DELETE FROM simulation_profiles AS stored
           USING target
           WHERE stored.id = target.id
           RETURNING stored.id, stored.group_id, stored.revision
         ),
         completed_receipt AS (
           UPDATE mutation_receipts AS receipt
           SET group_id = removed.group_id,
               resource_id = removed.id,
               revision = removed.revision,
               completed_at = $3
           FROM removed
           WHERE receipt.scope = $4
             AND receipt.request_id_hash = $5
           RETURNING receipt.request_id_hash
         )
         SELECT
           EXISTS (SELECT 1 FROM mutation_gate) AS receipt_claimed,
           EXISTS (SELECT 1 FROM authorized_writer) AS writer_authorized,
           EXISTS (SELECT 1 FROM target) AS target_present,
           (SELECT to_jsonb(removed) FROM removed) AS profile`,
        [
          input.groupId,
          input.deviceId,
          now,
          receipt?.scope ?? null,
          receipt?.requestIdHash ?? null,
          input.profileId,
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to delete the simulation profile.');
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayDelete(receipt);
    }
    if (!readBoolean(row.writer_authorized, 'writer_authorized')) throw notAWriter();
    if (!readBoolean(row.target_present, 'target_present')) throw noSuchProfile();
    const removed = readJsonObject(row.profile, 'profile');
    return {
      profileId: readText(removed.id, 'id'),
      revision: readBigInt(removed.revision, 'revision'),
    };
  }

  /**
   * One stored profile, exactly as it was published at that revision.
   *
   * Nothing outside the row is consulted, which is the property the table's
   * shape buys: a version carries the whole profile, so history can be read at
   * any point without walking the versions before it.
   */
  async readVersion(input: ReadSimulationVersionInput): Promise<SimulationProfileVersion> {
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
         ),
         found AS (
           SELECT
             version.profile_id,
             version.revision,
             version.profile,
             version.actor_device_id,
             version.created_at
           FROM simulation_versions AS version
           JOIN simulation_profiles AS stored ON stored.id = version.profile_id
           JOIN active_member ON active_member.group_id = stored.group_id
           WHERE version.profile_id = $3
             AND version.revision = $4
         )
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           (SELECT to_jsonb(found) FROM found) AS version`,
        [input.groupId, input.deviceId, input.profileId, input.revision.toString()],
      ),
    );
    const row = requireOneRow(rows, 'Unable to read the simulation profile version.');
    if (!readBoolean(row.member_active, 'member_active')) throw notAMember();
    if (row.version === null || row.version === undefined) {
      throw new PairedDeviceRuntimeError(
        'NOT_FOUND',
        'The simulation profile has no version at the requested revision.',
      );
    }
    const version = readJsonObject(row.version, 'version');
    return {
      profileId: readText(version.profile_id, 'profile_id'),
      revision: readBigInt(version.revision, 'revision'),
      profile: readJsonObject(version.profile, 'profile'),
      actorDeviceId: readOptionalText(version.actor_device_id),
      createdAt: readDate(version.created_at, 'created_at'),
    };
  }

  /**
   * Reads a projection that carries a locked target.
   *
   * The three refusals stay apart rather than collapsing into one: a caller who
   * may not write, a profile that is not there, and a profile that has moved
   * past the revision the caller expected each leave the caller something
   * different to do next.
   */
  private async readTargetedWrite(
    rows: readonly Record<string, unknown>[],
    receipt: MutationReceiptClaim | undefined,
    actor: SimulationActor,
    failure: string,
  ): Promise<SimulationProfileRecord> {
    const row = requireOneRow(rows, failure);
    if (receipt !== undefined && !readBoolean(row.receipt_claimed, 'receipt_claimed')) {
      return this.replayPut(receipt, actor);
    }
    if (!readBoolean(row.writer_authorized, 'writer_authorized')) throw notAWriter();
    if (!readBoolean(row.target_present, 'target_present')) throw noSuchProfile();
    if (row.profile === null || row.profile === undefined) {
      throw new PairedDeviceRuntimeError(
        'ABORTED',
        'The simulation profile is no longer at the revision this mutation required. ' +
          'Read it again and retry.',
      );
    }
    return toRecord(readJsonObject(row.profile, 'profile'));
  }

  /**
   * Answers a retried write with the profile the original wrote.
   *
   * The recorded revision is read back out of `simulation_versions` rather than
   * off the profile row, so a retry arriving after someone else has written
   * revision N+1 still answers with revision N — the state the caller's own
   * mutation produced. A receipt records identity and never authority, so the
   * read re-checks membership like any other.
   */
  private async replayPut(
    receipt: MutationReceiptClaim,
    actor: SimulationActor,
  ): Promise<SimulationProfileRecord> {
    const outcome = await this.#receipts.resolveRefused(
      receipt,
      new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The simulation profile could not be written.',
      ),
    );
    const groupId = requireOutcomeField(outcome.groupId, 'group_id');
    const profileId = requireOutcomeField(outcome.resourceId, 'resource_id');
    if (outcome.revision === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded simulation write is missing its revision and cannot be replayed.',
      );
    }
    if (groupId !== actor.groupId) {
      throw new PairedDeviceRuntimeError(
        'PERMISSION_DENIED',
        'The recorded simulation write belongs to another group.',
      );
    }
    const version = await this.readVersion({
      groupId,
      deviceId: actor.deviceId,
      profileId,
      revision: outcome.revision,
    });
    return {
      id: version.profileId,
      groupId,
      profile: version.profile,
      revision: version.revision,
      // The version row was written by the same statement as the profile row,
      // so the instant it records is that revision's updated-at.
      updatedAt: version.createdAt,
    };
  }

  private async replayDelete(receipt: MutationReceiptClaim): Promise<DeletedSimulationProfile> {
    const outcome = await this.#receipts.resolveRefused(
      receipt,
      new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The simulation profile could not be deleted.',
      ),
    );
    const profileId = requireOutcomeField(outcome.resourceId, 'resource_id');
    if (outcome.revision === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The recorded simulation delete is missing its revision and cannot be replayed.',
      );
    }
    return { profileId, revision: outcome.revision };
  }

  private claim(
    scope: MutationScope,
    mutation: MutationReceiptContext | undefined,
    now: Date,
    fields: readonly FingerprintField[],
  ): Promise<MutationReceiptClaim | undefined> {
    return this.#receipts.claim(scope, mutation, now, fields);
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

function toRecord(row: Record<string, unknown>): SimulationProfileRecord {
  return {
    id: readText(row.id, 'id'),
    groupId: readText(row.group_id, 'group_id'),
    profile: readJsonObject(row.profile, 'profile'),
    revision: readBigInt(row.revision, 'revision'),
    updatedAt: readDate(row.updated_at, 'updated_at'),
  };
}

function notAMember(): PairedDeviceRuntimeError {
  return new PairedDeviceRuntimeError(
    'PERMISSION_DENIED',
    'The authenticated device is no longer an active member of the group.',
  );
}

function notAWriter(): PairedDeviceRuntimeError {
  return new PairedDeviceRuntimeError(
    'PERMISSION_DENIED',
    'Only an active group editor or administrator can write a simulation profile.',
  );
}

function noSuchProfile(): PairedDeviceRuntimeError {
  return new PairedDeviceRuntimeError(
    'NOT_FOUND',
    'The group has no simulation profile with this identifier.',
  );
}

function normalizePageSize(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return defaultPageSize;
  return Math.min(Math.floor(requested), maxPageSize);
}

/**
 * A page boundary is a name and an identifier together. The group's unique
 * index already keeps names distinct, and the identifier settles the one case
 * the index cannot: a profile renamed across the boundary between two pages,
 * which a name alone would either skip or repeat.
 */
function encodeCursor(row: Record<string, unknown>): string {
  return Buffer.from(
    JSON.stringify({ name: readText(row.name, 'name'), id: readText(row.id, 'id') }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string): { readonly name: string; readonly id: string } | undefined {
  if (cursor.length === 0) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(decoded) || typeof decoded.name !== 'string' || typeof decoded.id !== 'string') {
      throw new Error('invalid cursor payload');
    }
    if (decoded.id.length === 0) throw new Error('invalid cursor values');
    return { name: decoded.name, id: decoded.id };
  } catch {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'The page cursor is invalid.');
  }
}
