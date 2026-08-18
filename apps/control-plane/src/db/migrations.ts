import { createHash } from 'node:crypto';

import type { SqlClient, SqlParameter, SqlStatement, SqlTransactionResults } from './database.js';

export interface Migration {
  readonly id: string;
  readonly statements: readonly SqlStatement[];
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

const migrationTable = 'hq_schema_migrations';
const migrationLockKey = 920_301_849;

const initialFoundation: Migration = {
  id: '0001_control_plane_foundation',
  statements: [
    sql(`CREATE TABLE IF NOT EXISTS groups (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      authority_mode text NOT NULL CHECK (authority_mode IN ('LEADER', 'MULTI_AUTHORITY')),
      leader_device_id uuid,
      revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`CREATE TABLE IF NOT EXISTS devices (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      public_key text NOT NULL UNIQUE,
      platform text NOT NULL,
      application_version text NOT NULL,
      status text NOT NULL CHECK (status IN ('OFFLINE', 'ONLINE', 'REVOKED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz
    )`),
    sql(`CREATE TABLE IF NOT EXISTS group_memberships (
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('VIEWER', 'EDITOR', 'ADMIN')),
      joined_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      PRIMARY KEY (group_id, device_id)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS pairing_codes (
      code_hash text PRIMARY KEY,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('VIEWER', 'EDITOR')),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_by_device_id uuid NOT NULL REFERENCES devices(id),
      created_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`CREATE TABLE IF NOT EXISTS device_sessions (
      id uuid PRIMARY KEY,
      device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      refresh_token_hash text NOT NULL UNIQUE,
      issued_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      last_seen_at timestamptz
    )`),
    sql(`CREATE TABLE IF NOT EXISTS presence_snapshots (
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      status text NOT NULL,
      active_screen text,
      selected_element text,
      clock_offset_ms bigint NOT NULL DEFAULT 0,
      latency_ms integer NOT NULL DEFAULT 0,
      observed_at timestamptz NOT NULL,
      PRIMARY KEY (group_id, device_id)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS material_objects (
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      content_hash text NOT NULL,
      byte_size bigint NOT NULL CHECK (byte_size >= 0),
      storage_key text NOT NULL UNIQUE,
      reference_count integer NOT NULL DEFAULT 0 CHECK (reference_count >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, content_hash)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS materials (
      id uuid PRIMARY KEY,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      display_name text NOT NULL,
      category text NOT NULL,
      mime_type text NOT NULL,
      byte_size bigint NOT NULL CHECK (byte_size >= 0),
      content_hash text NOT NULL,
      status text NOT NULL,
      current_version_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      trashed_at timestamptz,
      UNIQUE (group_id, id)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS material_versions (
      id uuid PRIMARY KEY,
      material_id uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      sequence bigint NOT NULL CHECK (sequence > 0),
      content_hash text NOT NULL,
      mime_type text NOT NULL,
      byte_size bigint NOT NULL CHECK (byte_size >= 0),
      original_file_name text NOT NULL,
      created_by_device_id uuid REFERENCES devices(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (material_id, sequence)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS material_tags (
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      value text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, value)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS material_tag_links (
      material_id uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      group_id uuid NOT NULL,
      tag_value text NOT NULL,
      PRIMARY KEY (material_id, tag_value),
      FOREIGN KEY (group_id, tag_value) REFERENCES material_tags(group_id, value) ON DELETE CASCADE
    )`),
    sql(`CREATE TABLE IF NOT EXISTS upload_sessions (
      id uuid PRIMARY KEY,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      material_id uuid REFERENCES materials(id) ON DELETE SET NULL,
      version_id uuid REFERENCES material_versions(id) ON DELETE SET NULL,
      state text NOT NULL,
      total_size bigint NOT NULL CHECK (total_size >= 0),
      received_size bigint NOT NULL DEFAULT 0 CHECK (received_size >= 0),
      chunk_size integer NOT NULL CHECK (chunk_size > 0),
      max_concurrency integer NOT NULL CHECK (max_concurrency > 0),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`CREATE TABLE IF NOT EXISTS upload_parts (
      upload_id uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
      part_number integer NOT NULL CHECK (part_number > 0),
      offset_bytes bigint NOT NULL CHECK (offset_bytes >= 0),
      byte_length bigint NOT NULL CHECK (byte_length >= 0),
      etag text,
      checksum text,
      completed_at timestamptz,
      PRIMARY KEY (upload_id, part_number)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS conversion_jobs (
      id uuid PRIMARY KEY,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      material_id uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      version_id uuid NOT NULL REFERENCES material_versions(id) ON DELETE CASCADE,
      kind text NOT NULL,
      state text NOT NULL,
      attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      lease_expires_at timestamptz,
      detail text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`CREATE TABLE IF NOT EXISTS settings_documents (
      id uuid PRIMARY KEY,
      group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
      device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
      scope_type text NOT NULL,
      schema_version text NOT NULL,
      document jsonb NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (group_id IS NOT NULL OR device_id IS NOT NULL OR scope_type IN ('FACTORY', 'THEME'))
    )`),
    sql(`CREATE TABLE IF NOT EXISTS settings_versions (
      id uuid PRIMARY KEY,
      document_id uuid NOT NULL REFERENCES settings_documents(id) ON DELETE CASCADE,
      revision bigint NOT NULL CHECK (revision > 0),
      patch jsonb NOT NULL,
      actor_device_id uuid REFERENCES devices(id),
      correlation_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (document_id, revision)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS layout_documents (
      id uuid PRIMARY KEY,
      group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
      device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
      screen_id text NOT NULL,
      layout jsonb NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`CREATE TABLE IF NOT EXISTS layout_versions (
      id uuid PRIMARY KEY,
      document_id uuid NOT NULL REFERENCES layout_documents(id) ON DELETE CASCADE,
      revision bigint NOT NULL CHECK (revision > 0),
      patch jsonb NOT NULL,
      actor_device_id uuid REFERENCES devices(id),
      correlation_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (document_id, revision)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS sync_snapshots (
      id uuid PRIMARY KEY,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      document_id uuid NOT NULL,
      document_type text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence >= 0),
      state_vector bytea NOT NULL,
      snapshot bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (group_id, document_id, sequence)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS sync_events (
      id uuid PRIMARY KEY,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      sequence bigint NOT NULL CHECK (sequence > 0),
      kind text NOT NULL,
      document_id uuid,
      payload bytea,
      hybrid_logical_clock bigint NOT NULL DEFAULT 0,
      actor_device_id uuid REFERENCES devices(id),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (group_id, sequence)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS history_events (
      id uuid PRIMARY KEY,
      group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
      device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
      scope text NOT NULL,
      category text NOT NULL,
      element_id text,
      screen_id text,
      tile_id text,
      operation text NOT NULL,
      before_value jsonb,
      after_value jsonb,
      patch jsonb,
      revision bigint,
      correlation_id text NOT NULL,
      origin text NOT NULL,
      issue_url text,
      pull_request_url text,
      occurred_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`CREATE TABLE IF NOT EXISTS simulation_profiles (
      id uuid PRIMARY KEY,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      name text NOT NULL,
      preset_kind text NOT NULL,
      profile jsonb NOT NULL,
      revision bigint NOT NULL CHECK (revision > 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`CREATE TABLE IF NOT EXISTS simulation_versions (
      id uuid PRIMARY KEY,
      profile_id uuid NOT NULL REFERENCES simulation_profiles(id) ON DELETE CASCADE,
      revision bigint NOT NULL CHECK (revision > 0),
      profile jsonb NOT NULL,
      actor_device_id uuid REFERENCES devices(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (profile_id, revision)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS github_installations (
      id uuid PRIMARY KEY,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      installation_id bigint NOT NULL UNIQUE,
      repository text NOT NULL,
      encrypted_credentials bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`CREATE TABLE IF NOT EXISTS translation_proposals (
      id uuid PRIMARY KEY,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      locale text NOT NULL,
      translation_key text NOT NULL,
      source_value text NOT NULL,
      proposed_value text NOT NULL,
      english_reference text,
      placeholders text[] NOT NULL DEFAULT ARRAY[]::text[],
      transliteration text,
      revision bigint NOT NULL CHECK (revision > 0),
      status text NOT NULL,
      pull_request_url text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`CREATE TABLE IF NOT EXISTS integration_jobs (
      id uuid PRIMARY KEY,
      group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
      provider text NOT NULL,
      kind text NOT NULL,
      state text NOT NULL,
      payload jsonb NOT NULL,
      result jsonb,
      correlation_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(
      'CREATE INDEX IF NOT EXISTS materials_group_updated_idx ON materials (group_id, updated_at DESC)',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS materials_group_status_idx ON materials (group_id, status, updated_at DESC)',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS material_versions_material_sequence_idx ON material_versions (material_id, sequence DESC)',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS history_events_group_occurred_idx ON history_events (group_id, occurred_at DESC)',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS history_events_device_occurred_idx ON history_events (device_id, occurred_at DESC)',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS sync_events_group_sequence_idx ON sync_events (group_id, sequence DESC)',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS conversion_jobs_lease_idx ON conversion_jobs (state, lease_expires_at)',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS pairing_codes_expires_idx ON pairing_codes (expires_at) WHERE consumed_at IS NULL',
    ),
  ],
};

/**
 * Authentication is additive to the immutable 0001 foundation. Every
 * credential-bearing column stores only a purpose-separated HMAC hash; the
 * server never persists raw pairing, access, or refresh values.
 */
const pairedDeviceAuthentication: Migration = {
  id: '0002_paired_device_authentication',
  statements: [
    sql(
      'ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS consumed_by_device_id uuid REFERENCES devices(id) ON DELETE SET NULL',
    ),
    sql('ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS revoked_at timestamptz'),
    sql(
      "ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS hash_version text NOT NULL DEFAULT 'v1'",
    ),
    sql(
      "ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS refresh_hash_version text NOT NULL DEFAULT 'v1'",
    ),
    sql('ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS refresh_rotated_at timestamptz'),
    sql('ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS revoked_reason text'),
    sql(`CREATE TABLE IF NOT EXISTS device_access_tokens (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      hash_version text NOT NULL,
      issued_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      last_seen_at timestamptz,
      revoked_at timestamptz,
      revoked_reason text,
      CHECK (expires_at > issued_at)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS device_refresh_token_history (
      token_hash text PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES device_sessions(id) ON DELETE CASCADE,
      hash_version text NOT NULL,
      issued_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      retired_at timestamptz NOT NULL DEFAULT now(),
      retired_reason text NOT NULL
        CHECK (retired_reason IN ('ROTATED', 'REVOKED', 'EXPIRED')),
      replay_detected_at timestamptz,
      CHECK (expires_at > issued_at)
    )`),
    sql(
      'CREATE INDEX IF NOT EXISTS pairing_codes_active_group_expiry_idx ON pairing_codes (group_id, expires_at) WHERE consumed_at IS NULL AND revoked_at IS NULL',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS device_sessions_active_device_group_idx ON device_sessions (device_id, group_id, expires_at) WHERE revoked_at IS NULL',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS device_access_tokens_active_session_idx ON device_access_tokens (session_id, expires_at) WHERE revoked_at IS NULL',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS device_access_tokens_expiry_idx ON device_access_tokens (expires_at) WHERE revoked_at IS NULL',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS device_refresh_token_history_session_idx ON device_refresh_token_history (session_id, expires_at DESC)',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS group_memberships_active_device_group_idx ON group_memberships (device_id, group_id) WHERE revoked_at IS NULL',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS group_memberships_active_group_role_idx ON group_memberships (group_id, role, device_id) WHERE revoked_at IS NULL',
    ),
  ],
};

/**
 * Refresh-token rotation keeps the immediately previous hash on the same
 * session row. Under PostgreSQL READ COMMITTED, this lets a request that
 * waited behind a concurrent rotation detect the old credential as a replay
 * instead of missing a newly-inserted history row in its original snapshot.
 *
 * The composite foreign keys make explicit the group/device relation already
 * assumed by lifecycle CTEs. They are deferrable because a bootstrap statement
 * creates the group, membership and session together.
 */
const pairedDeviceReplayAndIntegrity: Migration = {
  id: '0003_paired_device_replay_and_group_integrity',
  statements: [
    sql('ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS refresh_previous_token_hash text'),
    sql('ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS refresh_previous_hash_version text'),
    sql(
      'ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS refresh_previous_expires_at timestamptz',
    ),
    sql(
      'ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS refresh_previous_retired_at timestamptz',
    ),
    sql(`ALTER TABLE device_sessions
      ADD CONSTRAINT device_sessions_group_membership_fk
      FOREIGN KEY (group_id, device_id)
      REFERENCES group_memberships(group_id, device_id)
      DEFERRABLE INITIALLY DEFERRED NOT VALID`),
    sql(`ALTER TABLE pairing_codes
      ADD CONSTRAINT pairing_codes_creator_membership_fk
      FOREIGN KEY (group_id, created_by_device_id)
      REFERENCES group_memberships(group_id, device_id)
      DEFERRABLE INITIALLY DEFERRED NOT VALID`),
    sql(`ALTER TABLE groups
      ADD CONSTRAINT groups_leader_membership_fk
      FOREIGN KEY (id, leader_device_id)
      REFERENCES group_memberships(group_id, device_id)
      DEFERRABLE INITIALLY DEFERRED NOT VALID`),
    sql('ALTER TABLE device_sessions VALIDATE CONSTRAINT device_sessions_group_membership_fk'),
    sql('ALTER TABLE pairing_codes VALIDATE CONSTRAINT pairing_codes_creator_membership_fk'),
    sql('ALTER TABLE groups VALIDATE CONSTRAINT groups_leader_membership_fk'),
    sql(
      'CREATE UNIQUE INDEX IF NOT EXISTS device_sessions_previous_refresh_hash_unique ON device_sessions (refresh_previous_token_hash) WHERE refresh_previous_token_hash IS NOT NULL AND revoked_at IS NULL',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS device_sessions_previous_refresh_expiry_idx ON device_sessions (refresh_previous_expires_at) WHERE refresh_previous_token_hash IS NOT NULL AND revoked_at IS NULL',
    ),
  ],
};

export const migrations: readonly Migration[] = [
  initialFoundation,
  pairedDeviceAuthentication,
  pairedDeviceReplayAndIntegrity,
];

const migrationOutcomeTable = 'hq_migration_run_outcomes';

/**
 * Runs the whole immutable migration sequence as one non-interactive
 * PostgreSQL transaction. The advisory lock deliberately precedes both ledger
 * creation and every ledger lookup: a process that waits for another startup
 * must inspect the committed ledger again after it owns the lock, rather than
 * acting on a stale pre-lock snapshot.
 *
 * A transaction-local outcome table gives the existing `applied`/`skipped`
 * result API precise per-run semantics without a second, unlocked state read.
 */
export async function runMigrations(database: SqlClient): Promise<MigrationRunResult> {
  const statements = [
    sql('SELECT pg_advisory_xact_lock($1)', [migrationLockKey]),
    sql(`CREATE TABLE IF NOT EXISTS ${migrationTable} (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`CREATE TEMPORARY TABLE ${migrationOutcomeTable} (
      ordinal integer PRIMARY KEY,
      id text NOT NULL UNIQUE,
      applied boolean NOT NULL
    ) ON COMMIT DROP`),
    ...migrations.map((migration, ordinal) => lockedMigrationStatement(migration, ordinal)),
    sql(`SELECT id, applied FROM ${migrationOutcomeTable} ORDER BY ordinal`),
  ];

  const transactionResults = await database.transaction(statements);
  const outcomes = readMigrationOutcomes(transactionResults, statements.length - 1);
  const outcomeById = new Map(outcomes.map((outcome) => [outcome.id, outcome.applied]));
  if (
    outcomeById.size !== migrations.length ||
    migrations.some((migration) => outcomeById.has(migration.id) === false)
  ) {
    throw new Error('Migration transaction returned an incomplete outcome set');
  }

  return {
    applied: migrations
      .filter((migration) => outcomeById.get(migration.id) === true)
      .map((migration) => migration.id),
    skipped: migrations
      .filter((migration) => outcomeById.get(migration.id) === false)
      .map((migration) => migration.id),
  };
}

/**
 * PostgreSQL cannot parameterize a sequence of DDL statements inside the
 * non-interactive Neon transaction API. The migration source is repository
 * owned and has no parameters, so it is safely inlined into a PL/pgSQL block;
 * migration metadata remains quoted as SQL literals. The block reads and
 * writes the ledger only after the surrounding transaction owns the advisory
 * lock.
 */
function lockedMigrationStatement(migration: Migration, ordinal: number): SqlStatement {
  const checksum = checksumFor(migration);
  const body = migration.statements.map(inlineMigrationStatement).join('\n');
  const id = quoteSqlLiteral(migration.id);
  const expectedChecksum = quoteSqlLiteral(checksum);
  const driftMessage = quoteSqlLiteral(`Migration checksum drift detected for ${migration.id}`);

  return sql(`DO $hq_migration$
DECLARE
  recorded_checksum text;
BEGIN
  SELECT checksum
  INTO recorded_checksum
  FROM ${migrationTable}
  WHERE id = ${id};

  IF FOUND THEN
    IF recorded_checksum <> ${expectedChecksum} THEN
      RAISE EXCEPTION ${driftMessage};
    END IF;

    INSERT INTO ${migrationOutcomeTable} (ordinal, id, applied)
    VALUES (${ordinal}, ${id}, false);
  ELSE
${indentSql(body, 4)}
    INSERT INTO ${migrationTable} (id, checksum) VALUES (${id}, ${expectedChecksum});
    INSERT INTO ${migrationOutcomeTable} (ordinal, id, applied)
    VALUES (${ordinal}, ${id}, true);
  END IF;
END;
$hq_migration$;`);
}

function inlineMigrationStatement(statement: SqlStatement): string {
  if (statement.values !== undefined && statement.values.length > 0) {
    throw new Error('Immutable migrations must not contain bound SQL parameters');
  }

  const text = statement.text.trim();
  return text.endsWith(';') ? text : `${text};`;
}

function readMigrationOutcomes(
  transactionResults: SqlTransactionResults | void,
  outcomeStatementIndex: number,
): readonly MigrationOutcome[] {
  if (transactionResults === undefined) {
    throw new Error(
      'Migration runner requires SQL transaction results; update the database adapter to forward them',
    );
  }

  const rows = transactionResults[outcomeStatementIndex];
  if (rows === undefined) {
    throw new Error('Migration transaction did not return its outcome query result');
  }

  return rows.map((row) => {
    if (typeof row.id !== 'string' || typeof row.applied !== 'boolean') {
      throw new Error('Migration transaction returned an invalid outcome row');
    }

    return { id: row.id, applied: row.applied };
  });
}

interface MigrationOutcome {
  readonly id: string;
  readonly applied: boolean;
}

function indentSql(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${prefix}${line}`))
    .join('\n');
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function checksumFor(migration: Migration): string {
  return `sha256:${createHash('sha256')
    .update(migration.id)
    .update('\u0000')
    .update(migration.statements.map((statement) => statement.text.trim()).join('\u0000'))
    .digest('hex')}`;
}

function sql(text: string, values?: readonly SqlParameter[]): SqlStatement {
  return { text, ...(values === undefined ? {} : { values }) };
}
