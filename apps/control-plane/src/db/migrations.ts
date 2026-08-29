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

/**
 * A pairing code is a delegated capability of the exact session and access
 * token that created it, not merely of the issuing device. Recording that
 * credential identity lets redemption fail closed the instant either one is
 * retired by refresh rotation, replay revocation, or explicit device revoke,
 * instead of trusting continued device membership alone. Both columns stay
 * nullable so a code issued before this migration has no matching session or
 * access-token row and is therefore rejected by the redemption join rather
 * than being granted an inferred, device-only authority.
 */
const pairedDevicePairingIssuerBinding: Migration = {
  id: '0004_paired_device_pairing_issuer_binding',
  statements: [
    sql(
      'ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS created_by_session_id uuid REFERENCES device_sessions(id)',
    ),
    sql(
      'ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS created_by_access_token_id uuid REFERENCES device_access_tokens(id)',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS pairing_codes_issuer_access_token_idx ON pairing_codes (created_by_access_token_id) WHERE consumed_at IS NULL AND revoked_at IS NULL',
    ),
  ],
};

/**
 * Durable idempotency receipts for destructive lifecycle mutations.
 *
 * The table stores no response body. Pairing and refresh responses carry raw
 * bearer credentials, so persisting them would replace the project's
 * "credentials are never stored" property with "credentials are stored for the
 * receipt retention window". Only a purpose-separated hash of the request
 * identifier, an opaque fingerprint of the semantic request payload, and the
 * identity of the produced rows are recorded; a retry is answered by
 * re-issuing credentials for `session_id`.
 *
 * A row is inserted before its mutation runs and completed by the same
 * statement, so `completed_at IS NULL` means exactly one thing: the mutation
 * did not commit. Such a row is re-claimable by a later attempt, which is what
 * prevents a failed request from permanently burning its identifier. The
 * partial unique index is not needed — the primary key already makes
 * `(scope, request_id_hash)` the single idempotency identity.
 */
const mutationIdempotencyReceipts: Migration = {
  id: '0005_mutation_idempotency_receipts',
  statements: [
    sql(`CREATE TABLE IF NOT EXISTS mutation_receipts (
      scope text NOT NULL CHECK (scope IN ('PAIR_DEVICE', 'REFRESH_DEVICE_SESSION')),
      request_id_hash text NOT NULL,
      hash_version text NOT NULL,
      request_fingerprint text NOT NULL,
      group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
      device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
      session_id uuid REFERENCES device_sessions(id) ON DELETE CASCADE,
      claimed_at timestamptz NOT NULL,
      completed_at timestamptz,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (scope, request_id_hash),
      CHECK (expires_at > claimed_at),
      CHECK ((completed_at IS NULL) = (session_id IS NULL)),
      CHECK ((session_id IS NULL) = (device_id IS NULL)),
      CHECK ((session_id IS NULL) = (group_id IS NULL))
    )`),
    sql(
      'CREATE INDEX IF NOT EXISTS mutation_receipts_expiry_idx ON mutation_receipts (expires_at)',
    ),
    sql(
      'CREATE INDEX IF NOT EXISTS mutation_receipts_session_idx ON mutation_receipts (session_id) WHERE session_id IS NOT NULL',
    ),
  ],
};

/**
 * Extends receipts to the remaining destructive mutations.
 *
 * `0005` assumed every receipt produced a device session, because the two
 * mutations it covered both issued credentials. `CreatePairingCode` produces a
 * code and no session, and `RevokeDevice` produces a membership change and no
 * session, so those shape constraints have to go. They are replaced by one
 * scope-aware constraint that still refuses a half-recorded outcome — the
 * property that actually matters, since replay reads these columns.
 *
 * The old constraints are dropped by catalogue lookup rather than by name:
 * `0005` declared them inline, so their names are server-generated and a
 * hardcoded `mutation_receipts_check1` would be a guess about PostgreSQL's
 * numbering.
 *
 * `resource_hash` holds a pairing code's hash so a retry can revoke the code it
 * already minted instead of leaving a second live capability. It is a hash for
 * the same reason every other credential column is: the raw code is never
 * stored. `revision` records the group revision a revoke produced, so a replay
 * answers with the revision the caller's own mutation created rather than
 * whatever the group has drifted to since.
 */
const mutationReceiptsForRemainingMutations: Migration = {
  id: '0006_mutation_receipts_for_remaining_mutations',
  statements: [
    sql('ALTER TABLE mutation_receipts ADD COLUMN IF NOT EXISTS resource_hash text'),
    sql('ALTER TABLE mutation_receipts ADD COLUMN IF NOT EXISTS revision bigint'),
    sql(`DO $$
      DECLARE dropped_constraint text;
      BEGIN
        FOR dropped_constraint IN
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'mutation_receipts'::regclass
            AND contype = 'c'
        LOOP
          EXECUTE format(
            'ALTER TABLE mutation_receipts DROP CONSTRAINT %I', dropped_constraint
          );
        END LOOP;
      END $$`),
    sql(`ALTER TABLE mutation_receipts
      ADD CONSTRAINT mutation_receipts_scope_check
      CHECK (scope IN (
        'CREATE_GROUP',
        'CREATE_PAIRING_CODE',
        'PAIR_DEVICE',
        'REFRESH_DEVICE_SESSION',
        'REVOKE_DEVICE'
      ))`),
    sql(`ALTER TABLE mutation_receipts
      ADD CONSTRAINT mutation_receipts_expiry_check
      CHECK (expires_at > claimed_at)`),
    sql(`ALTER TABLE mutation_receipts
      ADD CONSTRAINT mutation_receipts_outcome_check
      CHECK (
        CASE
          -- An unfinished claim records no outcome at all, which is what makes
          -- a NULL completed_at mean exactly one thing to the replay path.
          WHEN completed_at IS NULL THEN
            group_id IS NULL
            AND device_id IS NULL
            AND session_id IS NULL
            AND resource_hash IS NULL
            AND revision IS NULL
          WHEN scope IN ('CREATE_GROUP', 'PAIR_DEVICE') THEN
            group_id IS NOT NULL AND device_id IS NOT NULL AND session_id IS NOT NULL
          WHEN scope = 'REFRESH_DEVICE_SESSION' THEN
            session_id IS NOT NULL
          WHEN scope = 'CREATE_PAIRING_CODE' THEN
            group_id IS NOT NULL AND resource_hash IS NOT NULL
          WHEN scope = 'REVOKE_DEVICE' THEN
            group_id IS NOT NULL AND device_id IS NOT NULL AND revision IS NOT NULL
          ELSE false
        END
      )`),
    sql(
      'CREATE INDEX IF NOT EXISTS mutation_receipts_resource_idx ON mutation_receipts (resource_hash) WHERE resource_hash IS NOT NULL',
    ),
  ],
};

/**
 * Gives group events a durable home and a server-owned sequence.
 *
 * Until this migration the realtime hub kept its replay history in a process
 * `Map`, so a restarted control plane answered every resume with an empty
 * history and a client could not tell a fresh server from a group with no
 * events. `sync_events` already existed and was written by nothing; the piece
 * it lacked was an allocator, because `MAX(sequence) + 1` over the same table
 * lets two concurrent publishes read the same maximum.
 *
 * `group_event_sequences` is that allocator. One upsert both claims the next
 * number and takes the row lock that serializes the claim, which keeps
 * allocation inside a single statement — the Neon HTTP driver offers no
 * interactive transaction to hold a lock across two.
 *
 * It is a table of its own rather than a column on `groups` so that publishing
 * an event does not contend with renaming a group or moving its leader.
 *
 * `mutation_receipts` grows `sequence` and eight scopes for the same reason the
 * five earlier scopes exist: each new mutation either changes what a device may
 * do or appends an event, and a retry that re-executes it cannot be undone by
 * the caller. `sequence` records what a publish allocated, so a replay answers
 * with the number the caller's own mutation produced instead of allocating a
 * second one.
 */
const groupEventSequencesAndRemainingScopes: Migration = {
  id: '0007_group_event_sequences_and_remaining_scopes',
  statements: [
    sql(`CREATE TABLE IF NOT EXISTS group_event_sequences (
      group_id uuid PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
      last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql('ALTER TABLE mutation_receipts ADD COLUMN IF NOT EXISTS sequence bigint'),
    sql('ALTER TABLE mutation_receipts DROP CONSTRAINT IF EXISTS mutation_receipts_scope_check'),
    sql('ALTER TABLE mutation_receipts DROP CONSTRAINT IF EXISTS mutation_receipts_outcome_check'),
    sql(`ALTER TABLE mutation_receipts
      ADD CONSTRAINT mutation_receipts_scope_check
      CHECK (scope IN (
        'CREATE_GROUP',
        'CREATE_PAIRING_CODE',
        'PAIR_DEVICE',
        'REFRESH_DEVICE_SESSION',
        'REVOKE_DEVICE',
        'UPDATE_GROUP',
        'JOIN_GROUP',
        'LEAVE_GROUP',
        'SET_DEVICE_ROLE',
        'SET_AUTHORITY_MODE',
        'SET_LEADER',
        'PUBLISH_DOCUMENT_DELTA',
        'PUBLISH_SESSION_COMMAND'
      ))`),
    sql(`ALTER TABLE mutation_receipts
      ADD CONSTRAINT mutation_receipts_outcome_check
      CHECK (
        CASE
          WHEN completed_at IS NULL THEN
            group_id IS NULL
            AND device_id IS NULL
            AND session_id IS NULL
            AND resource_hash IS NULL
            AND revision IS NULL
            AND sequence IS NULL
          WHEN scope IN ('CREATE_GROUP', 'PAIR_DEVICE') THEN
            group_id IS NOT NULL AND device_id IS NOT NULL AND session_id IS NOT NULL
          WHEN scope = 'REFRESH_DEVICE_SESSION' THEN
            session_id IS NOT NULL
          WHEN scope = 'CREATE_PAIRING_CODE' THEN
            group_id IS NOT NULL AND resource_hash IS NOT NULL
          WHEN scope IN ('REVOKE_DEVICE', 'SET_DEVICE_ROLE', 'JOIN_GROUP', 'LEAVE_GROUP') THEN
            group_id IS NOT NULL AND device_id IS NOT NULL AND revision IS NOT NULL
          WHEN scope IN ('UPDATE_GROUP', 'SET_AUTHORITY_MODE', 'SET_LEADER') THEN
            group_id IS NOT NULL AND revision IS NOT NULL
          WHEN scope IN ('PUBLISH_DOCUMENT_DELTA', 'PUBLISH_SESSION_COMMAND') THEN
            group_id IS NOT NULL AND sequence IS NOT NULL
          ELSE false
        END
      )`),
  ],
};

/**
 * Makes the documents the four F6 services own addressable, and gives their
 * mutations a receipt shape.
 *
 * Migration 0001 created `settings_documents`, `layout_documents`,
 * `simulation_profiles` and `translation_proposals` with a surrogate primary key
 * and nothing else. That is enough to insert rows and not enough to ever find
 * one again: "the settings document of this group" was not addressable, so an
 * upsert had no conflict target and two concurrent writers would each create
 * their own document.
 *
 * The uniqueness is expressed as partial indexes rather than one constraint
 * because `group_id` and `device_id` are independently nullable and NULLs do not
 * collide in a plain unique index — a single index over both would let a group
 * accumulate an unbounded number of "the group's document".
 *
 * `mutation_receipts` grows `resource_id` and one outcome shape for all four
 * services. Their mutations do not produce a device or a session, so the earlier
 * scope-specific columns cannot describe them; what every one of them does
 * produce is the identity of the row it wrote.
 */
const serviceDocumentsAndReceiptScopes: Migration = {
  id: '0008_service_documents_and_receipt_scopes',
  statements: [
    sql(`CREATE UNIQUE INDEX IF NOT EXISTS settings_documents_shared_scope_idx
      ON settings_documents (scope_type)
      WHERE group_id IS NULL AND device_id IS NULL`),
    sql(`CREATE UNIQUE INDEX IF NOT EXISTS settings_documents_group_scope_idx
      ON settings_documents (scope_type, group_id)
      WHERE group_id IS NOT NULL AND device_id IS NULL`),
    sql(`CREATE UNIQUE INDEX IF NOT EXISTS settings_documents_device_scope_idx
      ON settings_documents (scope_type, device_id)
      WHERE device_id IS NOT NULL AND group_id IS NULL`),
    sql(`CREATE UNIQUE INDEX IF NOT EXISTS settings_documents_group_device_scope_idx
      ON settings_documents (scope_type, group_id, device_id)
      WHERE group_id IS NOT NULL AND device_id IS NOT NULL`),
    sql(`CREATE UNIQUE INDEX IF NOT EXISTS layout_documents_group_screen_idx
      ON layout_documents (group_id, screen_id)
      WHERE group_id IS NOT NULL AND device_id IS NULL`),
    sql(`CREATE UNIQUE INDEX IF NOT EXISTS layout_documents_device_screen_idx
      ON layout_documents (device_id, screen_id)
      WHERE device_id IS NOT NULL`),
    sql(`CREATE UNIQUE INDEX IF NOT EXISTS simulation_profiles_group_name_idx
      ON simulation_profiles (group_id, name)`),
    sql(`CREATE UNIQUE INDEX IF NOT EXISTS translation_proposals_key_idx
      ON translation_proposals (group_id, locale, translation_key)`),
    sql(`CREATE INDEX IF NOT EXISTS conversion_jobs_lease_idx
      ON conversion_jobs (state, lease_expires_at)`),
    sql(`CREATE INDEX IF NOT EXISTS integration_jobs_group_state_idx
      ON integration_jobs (group_id, state, created_at DESC)`),
    sql(`CREATE INDEX IF NOT EXISTS material_tag_links_tag_idx
      ON material_tag_links (group_id, tag_value)`),
    sql(`CREATE INDEX IF NOT EXISTS upload_sessions_group_state_idx
      ON upload_sessions (group_id, state, expires_at)`),
    sql('ALTER TABLE mutation_receipts ADD COLUMN IF NOT EXISTS resource_id uuid'),
    sql('ALTER TABLE mutation_receipts DROP CONSTRAINT IF EXISTS mutation_receipts_scope_check'),
    sql('ALTER TABLE mutation_receipts DROP CONSTRAINT IF EXISTS mutation_receipts_outcome_check'),
    sql(`ALTER TABLE mutation_receipts
      ADD CONSTRAINT mutation_receipts_scope_check
      CHECK (scope IN (
        'CREATE_GROUP',
        'CREATE_PAIRING_CODE',
        'PAIR_DEVICE',
        'REFRESH_DEVICE_SESSION',
        'REVOKE_DEVICE',
        'UPDATE_GROUP',
        'JOIN_GROUP',
        'LEAVE_GROUP',
        'SET_DEVICE_ROLE',
        'SET_AUTHORITY_MODE',
        'SET_LEADER',
        'PUBLISH_DOCUMENT_DELTA',
        'PUBLISH_SESSION_COMMAND',
        'APPLY_SETTINGS_PATCH',
        'PUBLISH_SETTINGS_DRAFT',
        'DISCARD_SETTINGS_DRAFT',
        'RESET_SETTINGS',
        'IMPORT_SETTINGS',
        'REVERT_SETTINGS_VERSION',
        'BEGIN_MATERIAL_UPLOAD',
        'COMPLETE_MATERIAL_UPLOAD',
        'CANCEL_MATERIAL_UPLOAD',
        'CREATE_MATERIAL_VERSION',
        'UPDATE_MATERIAL_METADATA',
        'TRASH_MATERIAL',
        'RESTORE_MATERIAL',
        'PURGE_MATERIAL',
        'PUT_SIMULATION_PROFILE',
        'DELETE_SIMULATION_PROFILE',
        'ENQUEUE_INTEGRATION_JOB',
        'PUT_GITHUB_INSTALLATION',
        'PROPOSE_TRANSLATION',
        'UPDATE_TRANSLATION_PROPOSAL'
      ))`),
    sql(`ALTER TABLE mutation_receipts
      ADD CONSTRAINT mutation_receipts_outcome_check
      CHECK (
        CASE
          WHEN completed_at IS NULL THEN
            group_id IS NULL
            AND device_id IS NULL
            AND session_id IS NULL
            AND resource_hash IS NULL
            AND revision IS NULL
            AND sequence IS NULL
            AND resource_id IS NULL
          WHEN scope IN ('CREATE_GROUP', 'PAIR_DEVICE') THEN
            group_id IS NOT NULL AND device_id IS NOT NULL AND session_id IS NOT NULL
          WHEN scope = 'REFRESH_DEVICE_SESSION' THEN
            session_id IS NOT NULL
          WHEN scope = 'CREATE_PAIRING_CODE' THEN
            group_id IS NOT NULL AND resource_hash IS NOT NULL
          WHEN scope IN ('REVOKE_DEVICE', 'SET_DEVICE_ROLE', 'JOIN_GROUP', 'LEAVE_GROUP') THEN
            group_id IS NOT NULL AND device_id IS NOT NULL AND revision IS NOT NULL
          WHEN scope IN ('UPDATE_GROUP', 'SET_AUTHORITY_MODE', 'SET_LEADER') THEN
            group_id IS NOT NULL AND revision IS NOT NULL
          WHEN scope IN ('PUBLISH_DOCUMENT_DELTA', 'PUBLISH_SESSION_COMMAND') THEN
            group_id IS NOT NULL AND sequence IS NOT NULL
          -- Everything a service mutation produces is a row it can name. One
          -- shape covers all four services because none of them mints a
          -- credential, and a receipt that recorded no resource could not
          -- answer a retry at all.
          ELSE group_id IS NOT NULL AND resource_id IS NOT NULL
        END
      )`),
  ],
};

/**
 * A multipart upload against an S3-compatible object store is addressed by the
 * bucket's own upload id, minted by `CreateMultipartUpload` and required by
 * every `UploadPart`, `CompleteMultipartUpload` and `AbortMultipartUpload`.
 * That id has to survive between the `BeginUpload` that opens the upload and the
 * separate `CompleteUpload` or `CancelUpload` RPC that finishes it, so it lives
 * on the session row rather than in process memory a restart would lose. It is
 * nullable because a deduplicated upload never opens a multipart upload, and
 * because every session that predates this column has none.
 */
const uploadSessionStorageUploadId: Migration = {
  id: '0009_upload_session_storage_upload_id',
  statements: [sql('ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS storage_upload_id text')],
};

/**
 * The identity of this database, minted once and never again.
 *
 * A control plane deployed on a free Neon project can lose its database and be
 * handed another one at the same URL: the project is deleted and recreated,
 * migrations are run against a fresh branch, or the project is re-provisioned.
 * Nothing on the wire distinguished that from the database a device paired
 * against, so after a reset the operator re-paired into an empty group and the
 * client reconciled its local state against nothing. This row is what lets a
 * client refuse instead.
 *
 * `gen_random_uuid()` has been in core PostgreSQL since 13 and needs no
 * extension, so nothing here depends on `pgcrypto` being installable. The
 * identity is minted by the column DEFAULT of the single insert rather than by
 * this process, which keeps it a property of the database rather than of
 * whichever runner happened to reach it first.
 *
 * Both statements are idempotent, and the surrounding runner executes a
 * migration's body only when the ledger has no row for it. Re-running the
 * sequence therefore cannot mint a second identity -- not by re-executing the
 * body, and not by two runners racing for the advisory lock. That stability is
 * the property the whole reset detection rests on.
 */
const controlPlaneInstallation: Migration = {
  id: '0010_control_plane_installation',
  statements: [
    sql(`CREATE TABLE IF NOT EXISTS control_plane_installation (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      installation_id uuid NOT NULL DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`INSERT INTO control_plane_installation (singleton)
      VALUES (true)
      ON CONFLICT (singleton) DO NOTHING`),
  ],
};

/**
 * The measurement half of `TelemetryService`: a registry of data sources and a
 * store of the samples read from them.
 *
 * `ListDataSources`, `GetTelemetrySnapshot` and `StreamTelemetry` were left out
 * of the returned service object because migrations 0001 to 0010 declare
 * neither table, and guessing a shape inside a handler would have committed
 * this repository to that guess with no way back. These four tables are that
 * shape, written once and now immutable like every one before them.
 *
 * `telemetry_sources` is keyed by the profile that declares the source rather
 * than by the group. A source is a `SimulationChannel.source_id` of a published
 * `SimulationProfile`, so the profile is what brings it into existence and what
 * takes it away: `ON DELETE CASCADE` on `profile_id` is the whole of the
 * deregistration path, and there is no second one to forget. Keying by group
 * instead would make two profiles that name one source collide, and would leave
 * the row behind when the profile that owns it is deleted while another still
 * names it -- a registry that reports sources nothing drives. `ListDataSources`
 * therefore reads `DISTINCT ON (source_key)` over the group and picks the same
 * declaration every time, ordered by `profile_id`.
 *
 * `telemetry_snapshots` and `telemetry_samples` are split rather than flattened
 * because a snapshot is the unit the contract returns: one `captured_at` and
 * one sequence over many samples. Flattening would repeat both on every sample
 * and leave no row to hang a foreign key from, which is what makes pruning a
 * single `DELETE` on the parent instead of a join.
 *
 * The sequence is group-scoped and allocated by `telemetry_sample_sequences`,
 * the same allocator idiom `group_event_sequences` uses and for the same
 * reason: `MAX(sequence) + 1` over the samples themselves lets two concurrent
 * captures read one maximum and write it twice. One upsert both claims the next
 * number and takes the row lock that serializes the claim, which keeps
 * allocation inside a single statement -- the Neon HTTP driver offers no
 * interactive transaction to hold a lock across two.
 *
 * A group scope rather than a device scope is a statement about what these
 * readings are. Every source this schema can hold is declared by a group's
 * simulation profile, so the reading is a property of the group's own
 * configuration and not of any one machine's hardware; giving each device its
 * own timeline would make two screens of one shoot disagree on the number they
 * are both showing. `TelemetrySnapshot.device_id` is echoed from the request,
 * and `simulated` is true, so nothing on the wire claims a measurement that was
 * not taken.
 *
 * `severity` is checked against the five names of `TelemetrySeverity`. Adding a
 * sixth would need a migration after this one, which is the correct cost: a
 * severity the client cannot name is a severity no screen can draw.
 */
const telemetryDataSourcesAndSamples: Migration = {
  id: '0011_telemetry_data_sources_and_samples',
  statements: [
    sql(`CREATE TABLE IF NOT EXISTS telemetry_sources (
      profile_id uuid NOT NULL REFERENCES simulation_profiles(id) ON DELETE CASCADE,
      source_key text NOT NULL,
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      name text NOT NULL,
      kind text NOT NULL,
      unit text NOT NULL DEFAULT '',
      simulated boolean NOT NULL DEFAULT true,
      labels jsonb NOT NULL DEFAULT '{}'::jsonb,
      channel_index integer NOT NULL CHECK (channel_index >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (profile_id, source_key)
    )`),
    sql(`CREATE INDEX IF NOT EXISTS telemetry_sources_group_key_idx
      ON telemetry_sources (group_id, source_key, profile_id)`),
    sql(`CREATE TABLE IF NOT EXISTS telemetry_sample_sequences (
      group_id uuid PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
      last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    sql(`CREATE TABLE IF NOT EXISTS telemetry_snapshots (
      group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      sequence bigint NOT NULL CHECK (sequence > 0),
      captured_at timestamptz NOT NULL,
      PRIMARY KEY (group_id, sequence)
    )`),
    sql(`CREATE TABLE IF NOT EXISTS telemetry_samples (
      group_id uuid NOT NULL,
      sequence bigint NOT NULL,
      source_key text NOT NULL,
      value double precision NOT NULL,
      unit text NOT NULL DEFAULT '',
      severity text NOT NULL CHECK (
        severity IN ('UNSPECIFIED', 'NORMAL', 'ELEVATED', 'DEGRADED', 'CRITICAL')
      ),
      observed_at timestamptz NOT NULL,
      labels jsonb NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (group_id, sequence, source_key),
      FOREIGN KEY (group_id, sequence)
        REFERENCES telemetry_snapshots (group_id, sequence) ON DELETE CASCADE
    )`),
  ],
};

export const migrations: readonly Migration[] = [
  initialFoundation,
  pairedDeviceAuthentication,
  pairedDeviceReplayAndIntegrity,
  pairedDevicePairingIssuerBinding,
  mutationIdempotencyReceipts,
  mutationReceiptsForRemainingMutations,
  groupEventSequencesAndRemainingScopes,
  serviceDocumentsAndReceiptScopes,
  uploadSessionStorageUploadId,
  controlPlaneInstallation,
  telemetryDataSourcesAndSamples,
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
