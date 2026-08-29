import type { SqlClient } from '../db/database.js';
import { normalizePageSize as boundPageSize } from '../sync/paging.js';
import {
  isRecord,
  normalizeDatabaseError,
  readBigInt,
  readBoolean,
  readDate,
  readJsonArray,
  readJsonObject,
  readText,
  requireOneRow,
  sql,
} from '../sync/rows.js';
import { PairedDeviceRuntimeError } from '../sync/runtime.js';
import type { Page } from '../sync/runtime.js';

/**
 * The `telemetry_sources` / `telemetry_snapshots` / `telemetry_samples` adapter:
 * the measurement half of `TelemetryService`.
 *
 * Three RPCs read through it. `ListDataSources` reads the registry migration
 * 0011 declares, `GetTelemetrySnapshot` reads or records one snapshot, and
 * `StreamTelemetry` follows the snapshots by sequence. Nothing here computes a
 * reading: the arithmetic is `@gremuchaya/domain`'s, it lives in the service
 * beside the preview that shares it, and this module moves rows.
 *
 * Every read re-checks the acting device's membership in SQL rather than
 * trusting the caller, exactly as the simulation half does, and every read that
 * names a device re-checks that device's membership too. A group's telemetry is
 * as private as its documents: a valid access token for one group must not read
 * the readings of another, and a device revoked a second ago must not still be
 * addressable as a member of this one.
 *
 * The one write is one parameterized statement built from data-modifying CTEs.
 * It allocates the sequence, records the snapshot, writes its samples and
 * prunes the oldest in that statement, because the Neon HTTP driver has no
 * interactive transaction to hold them together and a snapshot row with no
 * samples under it is the single state this schema cannot describe.
 */

/** One row of the registry, as `ListDataSources` reports it. */
export interface TelemetrySourceRecord {
  readonly sourceKey: string;
  readonly name: string;
  /** The `DataSourceKind` enum name; `sources.ts` maps it back onto the wire. */
  readonly kind: string;
  readonly unit: string;
  readonly simulated: boolean;
  readonly labels: Readonly<Record<string, string>>;
}

/** A registry row together with what a capture needs in order to evaluate it. */
export interface TelemetryCaptureSource extends TelemetrySourceRecord {
  readonly channelIndex: number;
  /** The body of the profile that declared the source, as it stands now. */
  readonly profile: Record<string, unknown>;
  /**
   * When that profile was last written. It is the origin of the timeline the
   * capture evaluates, so every device of the group reading at one instant
   * computes one phase and therefore one reading.
   */
  readonly profileUpdatedAt: Date;
  /**
   * The reading this source carried in the previous snapshot, which is what a
   * channel's smoothing is applied against. Absent for a source declared since
   * that snapshot was taken.
   */
  readonly previousValue?: number;
}

/**
 * The identity of the newest snapshot a group holds.
 *
 * Its samples are not carried here: what a capture needs from the previous
 * snapshot is one reading per source, and those arrive on the sources
 * themselves. What a caller needs from the snapshot is when it was taken, which
 * is how it decides whether a fresh capture is due.
 */
export interface TelemetrySnapshotMark {
  readonly sequence: bigint;
  readonly capturedAt: Date;
}

export interface TelemetryCaptureContext {
  readonly sources: readonly TelemetryCaptureSource[];
  /** The newest snapshot the group holds; absent before the first capture. */
  readonly latest?: TelemetrySnapshotMark;
}

export interface TelemetrySampleRecord {
  readonly sourceKey: string;
  readonly value: number;
  readonly unit: string;
  /** The `TelemetrySeverity` enum name, stored as text and checked by migration 0011. */
  readonly severity: string;
  readonly observedAt: Date;
  readonly labels: Readonly<Record<string, string>>;
}

export interface TelemetrySnapshotRecord {
  readonly sequence: bigint;
  readonly capturedAt: Date;
  readonly samples: readonly TelemetrySampleRecord[];
}

/** The identity every call re-checks in SQL rather than trusting from the caller. */
export interface TelemetryReader {
  readonly groupId: string;
  readonly deviceId: string;
  /**
   * The device the request names, when it names one. It is validated as a
   * member of the same group and otherwise takes no part in the answer: every
   * source this schema holds is declared by a group's profile, so the reading
   * is a property of the group rather than of one machine.
   */
  readonly targetDeviceId?: string;
}

export interface ListTelemetrySourcesInput extends TelemetryReader {
  readonly pageSize: number;
  readonly cursor: string;
}

export interface ReadTelemetryCaptureInput extends TelemetryReader {
  /** When present, only these sources are read; when absent, all of the group's. */
  readonly sourceKeys?: readonly string[];
}

export interface RecordTelemetrySnapshotInput {
  readonly groupId: string;
  readonly deviceId: string;
  readonly capturedAt: Date;
  readonly samples: readonly Omit<TelemetrySampleRecord, 'observedAt'>[];
}

export interface ReadTelemetrySnapshotsInput extends ReadTelemetryCaptureInput {
  readonly afterSequence: bigint;
  readonly limit: number;
}

export interface DurableTelemetryMeasurementStoreOptions {
  readonly database: SqlClient;
  /**
   * How many snapshots a group keeps. A capture is triggered by a read, so an
   * unbounded history would let a stream left open overnight fill the database
   * with readings nothing will ask for again; a client that reconnects resumes
   * from its own sequence, and one that has fallen further behind than the
   * retention window is told by the gap rather than served a partial replay.
   */
  readonly retainedSnapshots?: number;
}

const defaultPageSize = 50;
const maxPageSize = 200;
/** Twelve minutes of one-second readings, which outlives any reconnect a shoot makes. */
const defaultRetainedSnapshots = 720;

/**
 * Who may read, re-asked in SQL.
 *
 * Reading is open to any active member, a viewer included, for the reason the
 * profile listing gives: telemetry describes what the wall shows, and a device
 * allowed to watch the wall is allowed to read what drives it.
 */
const activeMemberCte = `active_member AS (
           SELECT membership.group_id
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           WHERE membership.group_id = $1
             AND membership.device_id = $2
             AND membership.revoked_at IS NULL
             AND devices.status <> 'REVOKED'
         )`;

/**
 * The device the request names, checked against the same group.
 *
 * `$3` is NULL when the request named none, and the projection then reports the
 * target present without this CTE producing a row. A device from another group
 * produces no row and is refused, which is what keeps `device_id` from becoming
 * a way to ask whether an identifier exists elsewhere.
 */
const targetDeviceCte = `target_device AS (
           SELECT membership.device_id
           FROM group_memberships AS membership
           JOIN devices ON devices.id = membership.device_id
           CROSS JOIN active_member
           WHERE membership.group_id = active_member.group_id
             AND membership.device_id = $3::uuid
             AND membership.revoked_at IS NULL
             AND devices.status <> 'REVOKED'
         )`;

const readerProjection = `EXISTS (SELECT 1 FROM active_member) AS member_active,
           ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM target_device)) AS target_present`;

export class DurableTelemetryMeasurementStore {
  readonly #database: SqlClient;
  readonly #retainedSnapshots: number;

  constructor(options: DurableTelemetryMeasurementStoreOptions) {
    this.#database = options.database;
    this.#retainedSnapshots = options.retainedSnapshots ?? defaultRetainedSnapshots;
  }

  /**
   * The data sources of a group, by key.
   *
   * `DISTINCT ON (source.source_key)` collapses the case two profiles declare
   * one source, and the `ORDER BY` inside it makes the survivor the same row on
   * every call rather than whichever the planner reached first: a listing that
   * reported a different unit for one key between two pages would be a listing
   * a client cannot cache.
   */
  async listSources(input: ListTelemetrySourcesInput): Promise<Page<TelemetrySourceRecord>> {
    const pageSize = boundPageSize(input.pageSize, { defaultPageSize, maxPageSize });
    const cursor = decodeCursor(input.cursor);
    const rows = await this.query(
      sql(
        `WITH ${activeMemberCte},
         ${targetDeviceCte},
         all_sources AS MATERIALIZED (
           SELECT DISTINCT ON (source.source_key)
             source.source_key,
             source.name,
             source.kind,
             source.unit,
             source.simulated,
             source.labels
           FROM telemetry_sources AS source
           JOIN active_member ON active_member.group_id = source.group_id
           ORDER BY source.source_key ASC, source.profile_id ASC
         ),
         page AS (
           SELECT *
           FROM all_sources
           WHERE $4::text IS NULL OR source_key > $4::text
           ORDER BY source_key ASC
           LIMIT $5
         )
         SELECT
           ${readerProjection},
           (SELECT COUNT(*) FROM all_sources) AS approximate_total,
           COALESCE(
             jsonb_agg(to_jsonb(page) ORDER BY page.source_key ASC),
             '[]'::jsonb
           ) AS items
         FROM page`,
        [input.groupId, input.deviceId, input.targetDeviceId ?? null, cursor ?? null, pageSize + 1],
      ),
    );
    const row = this.readReaderRow(rows, 'Unable to list the telemetry data sources of the group.');
    const items = readJsonArray(row.items, 'items');
    const hasMore = items.length > pageSize;
    const visible = hasMore ? items.slice(0, pageSize) : items;
    const last = visible.at(-1);
    return {
      items: visible.map(toSourceRecord),
      nextCursor:
        hasMore && last !== undefined ? encodeCursor(readText(last.source_key, 'source_key')) : '',
      // Forward keyset cursors only, as in `listSimulationProfiles`, until the
      // shared `PageRequest` model gains an explicit direction field.
      previousCursor: '',
      hasMore,
      approximateTotal: readBigInt(row.approximate_total, 'approximate_total'),
    };
  }

  /**
   * Everything a capture needs, read in one statement.
   *
   * The registry, the declaring profile bodies, the newest snapshot and the
   * readings that snapshot carried all come back together because they have to
   * agree: computing a reading from one profile against a previous value taken
   * before another was published would smooth a curve towards a value no
   * channel ever produced.
   *
   * This read precedes the write it feeds, which is a read-then-write and is
   * safe here for one reason worth stating: nothing between them carries
   * authority. The write re-checks membership itself, allocates its own
   * sequence under the allocator's row lock, and is refused outright if the
   * device stopped being a member in between. The worst a concurrent profile
   * publish can do is make one snapshot describe the profile as it stood a
   * moment earlier, and the next capture corrects it.
   */
  async readCaptureContext(input: ReadTelemetryCaptureInput): Promise<TelemetryCaptureContext> {
    const rows = await this.query(
      sql(
        `WITH ${activeMemberCte},
         ${targetDeviceCte},
         sources AS MATERIALIZED (
           SELECT DISTINCT ON (source.source_key)
             source.source_key,
             source.name,
             source.kind,
             source.unit,
             source.simulated,
             source.labels,
             source.channel_index,
             stored.profile,
             stored.updated_at AS profile_updated_at
           FROM telemetry_sources AS source
           JOIN simulation_profiles AS stored ON stored.id = source.profile_id
           JOIN active_member ON active_member.group_id = source.group_id
           WHERE $4::jsonb IS NULL
             OR source.source_key IN (SELECT jsonb_array_elements_text($4::jsonb))
           ORDER BY source.source_key ASC, source.profile_id ASC
         ),
         latest AS (
           SELECT snapshot.sequence, snapshot.captured_at
           FROM telemetry_snapshots AS snapshot
           JOIN active_member ON active_member.group_id = snapshot.group_id
           ORDER BY snapshot.sequence DESC
           LIMIT 1
         ),
         previous AS (
           SELECT sample.source_key, sample.value
           FROM telemetry_samples AS sample
           JOIN latest ON latest.sequence = sample.sequence
           WHERE sample.group_id = $1
         )
         SELECT
           ${readerProjection},
           (SELECT to_jsonb(latest) FROM latest) AS latest,
           COALESCE(
             (SELECT jsonb_agg(to_jsonb(sources) ORDER BY sources.source_key ASC) FROM sources),
             '[]'::jsonb
           ) AS sources,
           COALESCE(
             (SELECT jsonb_object_agg(previous.source_key, previous.value) FROM previous),
             '{}'::jsonb
           ) AS previous`,
        [
          input.groupId,
          input.deviceId,
          input.targetDeviceId ?? null,
          encodeSourceKeys(input.sourceKeys),
        ],
      ),
    );
    const row = this.readReaderRow(rows, 'Unable to read the telemetry sources of the group.');
    const previous = readJsonObject(row.previous, 'previous');
    const latest =
      row.latest === null || row.latest === undefined
        ? undefined
        : readJsonObject(row.latest, 'latest');
    return {
      sources: readJsonArray(row.sources, 'sources').map((source) =>
        toCaptureSource(source, previous),
      ),
      ...(latest === undefined
        ? {}
        : {
            latest: {
              sequence: readBigInt(latest.sequence, 'sequence'),
              capturedAt: readDate(latest.captured_at, 'captured_at'),
            },
          }),
    };
  }

  /**
   * Records one snapshot: the allocation, the snapshot row, its samples and the
   * pruning of the oldest, in a single statement.
   *
   * The sequence comes from `telemetry_sample_sequences` rather than from
   * `MAX(sequence) + 1`, because two concurrent captures reading one maximum
   * would write it twice and the primary key would turn a lost snapshot into a
   * failed request. The upsert both claims the next number and takes the row
   * lock that serializes the claim.
   *
   * The membership lock is taken before the allocation, which is the house lock
   * order: group, membership, then whatever the mutation owns. Every capture of
   * a group serializes on the allocator anyway, so the membership lock adds no
   * contention that was not already there.
   *
   * Pruning is in the same statement and cannot reach the row just written: all
   * of a statement's data-modifying CTEs read one snapshot of the database, so
   * the `DELETE` never sees the `INSERT`'s row, and the retention bound keeps it
   * away from it in any case.
   */
  async record(input: RecordTelemetrySnapshotInput): Promise<TelemetrySnapshotRecord> {
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
           FOR UPDATE OF membership
         ),
         allocated AS (
           INSERT INTO telemetry_sample_sequences (group_id, last_sequence, updated_at)
           SELECT active_member.group_id, 1, $3 FROM active_member
           ON CONFLICT (group_id) DO UPDATE
             SET last_sequence = telemetry_sample_sequences.last_sequence + 1,
                 updated_at = EXCLUDED.updated_at
           RETURNING group_id, last_sequence
         ),
         recorded AS (
           INSERT INTO telemetry_snapshots (group_id, sequence, captured_at)
           SELECT allocated.group_id, allocated.last_sequence, $3 FROM allocated
           RETURNING group_id, sequence, captured_at
         ),
         written AS (
           INSERT INTO telemetry_samples (
             group_id, sequence, source_key, value, unit, severity, observed_at, labels
           )
           SELECT recorded.group_id, recorded.sequence, sample.source_key, sample.value,
                  sample.unit, sample.severity, $3, sample.labels
           FROM recorded
           CROSS JOIN jsonb_to_recordset($4::jsonb)
             AS sample(
               source_key text, value double precision, unit text,
               severity text, labels jsonb
             )
           RETURNING source_key, value, unit, severity, observed_at, labels
         ),
         pruned AS (
           DELETE FROM telemetry_snapshots AS old
           USING allocated
           WHERE old.group_id = allocated.group_id
             AND old.sequence <= allocated.last_sequence - $5::bigint
           RETURNING old.sequence
         )
         SELECT
           EXISTS (SELECT 1 FROM active_member) AS member_active,
           (SELECT to_jsonb(recorded) FROM recorded) AS snapshot,
           COALESCE(
             (SELECT jsonb_agg(to_jsonb(written) ORDER BY written.source_key ASC) FROM written),
             '[]'::jsonb
           ) AS samples,
           (SELECT COUNT(*) FROM pruned) AS pruned_count`,
        [
          input.groupId,
          input.deviceId,
          input.capturedAt,
          JSON.stringify(
            input.samples.map((sample) => ({
              source_key: sample.sourceKey,
              value: sample.value,
              unit: sample.unit,
              severity: sample.severity,
              labels: sample.labels,
            })),
          ),
          this.#retainedSnapshots.toString(),
        ],
      ),
    );
    const row = requireOneRow(rows, 'Unable to record the telemetry snapshot.');
    if (!readBoolean(row.member_active, 'member_active')) throw notAMember();
    if (row.snapshot === null || row.snapshot === undefined) {
      throw new PairedDeviceRuntimeError(
        'FAILED_PRECONDITION',
        'The telemetry snapshot could not be recorded.',
      );
    }
    const snapshot = readJsonObject(row.snapshot, 'snapshot');
    return {
      sequence: readBigInt(snapshot.sequence, 'sequence'),
      capturedAt: readDate(snapshot.captured_at, 'captured_at'),
      samples: readJsonArray(row.samples, 'samples').map(toSampleRecord),
    };
  }

  /**
   * The snapshots a group recorded after a sequence, oldest first.
   *
   * This is what makes `StreamTelemetry`'s `after_sequence` mean something: the
   * sequence is in the table rather than in a process, so a client that
   * reconnects resumes exactly where it stopped and a restarted control plane
   * answers the same as the one it replaced. The limit bounds one read, and the
   * caller drains a backlog by asking again from the sequence it reached.
   */
  async readAfter(input: ReadTelemetrySnapshotsInput): Promise<readonly TelemetrySnapshotRecord[]> {
    const rows = await this.query(
      sql(
        `WITH ${activeMemberCte},
         ${targetDeviceCte},
         page AS (
           SELECT snapshot.sequence, snapshot.captured_at
           FROM telemetry_snapshots AS snapshot
           JOIN active_member ON active_member.group_id = snapshot.group_id
           WHERE snapshot.sequence > $4::bigint
           ORDER BY snapshot.sequence ASC
           LIMIT $5
         )
         SELECT
           ${readerProjection},
           COALESCE(
             (
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'sequence', page.sequence,
                   'captured_at', page.captured_at,
                   'samples', COALESCE(
                     (
                       SELECT jsonb_agg(to_jsonb(sample) ORDER BY sample.source_key ASC)
                       FROM (
                         SELECT stored.source_key, stored.value, stored.unit,
                                stored.severity, stored.observed_at, stored.labels
                         FROM telemetry_samples AS stored
                         WHERE stored.group_id = $1
                           AND stored.sequence = page.sequence
                           AND (
                             $6::jsonb IS NULL
                             OR stored.source_key IN (SELECT jsonb_array_elements_text($6::jsonb))
                           )
                       ) AS sample
                     ),
                     '[]'::jsonb
                   )
                 ) ORDER BY page.sequence ASC
               )
               FROM page
             ),
             '[]'::jsonb
           ) AS snapshots`,
        [
          input.groupId,
          input.deviceId,
          input.targetDeviceId ?? null,
          input.afterSequence.toString(),
          input.limit,
          encodeSourceKeys(input.sourceKeys),
        ],
      ),
    );
    const row = this.readReaderRow(rows, 'Unable to read the telemetry snapshots of the group.');
    return readJsonArray(row.snapshots, 'snapshots').map((snapshot) => ({
      sequence: readBigInt(snapshot.sequence, 'sequence'),
      capturedAt: readDate(snapshot.captured_at, 'captured_at'),
      samples: readJsonArray(snapshot.samples, 'samples').map(toSampleRecord),
    }));
  }

  /**
   * The two refusals every read shares, kept apart.
   *
   * A device that is no longer a member and a device that names a stranger are
   * different mistakes, and a caller that conflated them would retry the one it
   * cannot fix. Neither message says whether the named device exists elsewhere.
   */
  private readReaderRow(
    rows: readonly Record<string, unknown>[],
    failure: string,
  ): Record<string, unknown> {
    const row = requireOneRow(rows, failure);
    if (!readBoolean(row.member_active, 'member_active')) throw notAMember();
    if (!readBoolean(row.target_present, 'target_present')) {
      throw new PairedDeviceRuntimeError(
        'NOT_FOUND',
        'The group has no active device with this identifier.',
      );
    }
    return row;
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

function toSourceRecord(row: Record<string, unknown>): TelemetrySourceRecord {
  return {
    sourceKey: readText(row.source_key, 'source_key'),
    name: readText(row.name, 'name'),
    kind: readText(row.kind, 'kind'),
    unit: typeof row.unit === 'string' ? row.unit : '',
    simulated: readBoolean(row.simulated, 'simulated'),
    labels: readLabels(row.labels),
  };
}

function toCaptureSource(
  row: Record<string, unknown>,
  previous: Record<string, unknown>,
): TelemetryCaptureSource {
  const sourceKey = readText(row.source_key, 'source_key');
  const previousValue = previous[sourceKey];
  return {
    ...toSourceRecord(row),
    channelIndex: readCount(row.channel_index, 'channel_index'),
    profile: readJsonObject(row.profile, 'profile'),
    profileUpdatedAt: readDate(row.profile_updated_at, 'profile_updated_at'),
    ...(typeof previousValue === 'number' && Number.isFinite(previousValue)
      ? { previousValue }
      : {}),
  };
}

function toSampleRecord(row: Record<string, unknown>): TelemetrySampleRecord {
  return {
    sourceKey: readText(row.source_key, 'source_key'),
    value: readNumber(row.value, 'value'),
    unit: typeof row.unit === 'string' ? row.unit : '',
    severity: readText(row.severity, 'severity'),
    observedAt: readDate(row.observed_at, 'observed_at'),
    labels: readLabels(row.labels),
  };
}

/**
 * `map<string, string>` on the wire, `jsonb` in the column. A value that is not
 * a string is dropped rather than stringified: a label whose value this process
 * invented reads exactly like one an operator set.
 */
function readLabels(value: unknown): Readonly<Record<string, string>> {
  if (value === null || value === undefined) return {};
  const decoded = readJsonObject(value, 'labels');
  const labels: Record<string, string> = {};
  for (const [key, entry] of Object.entries(decoded)) {
    if (typeof entry === 'string') labels[key] = entry;
  }
  return labels;
}

function readNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`The database returned an invalid ${field}.`);
}

function readCount(value: unknown, field: string): number {
  const count = readNumber(value, field);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`The database returned an invalid ${field}.`);
  }
  return count;
}

/**
 * The requested source keys as one jsonb parameter, or NULL for "all of them".
 *
 * `SqlParameter` carries no array type, and an empty filter and an absent one
 * mean different things: a request that named no source wants every source,
 * while a request that named some and matched none must not silently widen to
 * every source.
 */
function encodeSourceKeys(sourceKeys: readonly string[] | undefined): string | null {
  return sourceKeys === undefined ? null : JSON.stringify(sourceKeys);
}

function notAMember(): PairedDeviceRuntimeError {
  return new PairedDeviceRuntimeError(
    'PERMISSION_DENIED',
    'The authenticated device is no longer an active member of the group.',
  );
}

/**
 * A page boundary is the source key alone. `DISTINCT ON (source_key)` has
 * already made the key unique across the group's page, so nothing else can
 * settle a tie and nothing else is needed to.
 */
function encodeCursor(sourceKey: string): string {
  return Buffer.from(JSON.stringify({ sourceKey }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string | undefined {
  if (cursor.length === 0) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(decoded) || typeof decoded.sourceKey !== 'string') {
      throw new Error('invalid cursor payload');
    }
    if (decoded.sourceKey.length === 0) throw new Error('invalid cursor values');
    return decoded.sourceKey;
  } catch {
    throw new PairedDeviceRuntimeError('INVALID_ARGUMENT', 'The page cursor is invalid.');
  }
}
