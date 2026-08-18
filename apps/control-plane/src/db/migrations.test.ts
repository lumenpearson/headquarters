import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from './database.js';
import { checksumFor, migrations, runMigrations } from './migrations.js';

describe('control-plane migrations', () => {
  it('creates production tables inside one advisory-locked transaction per immutable migration', async () => {
    const transactions: SqlStatement[][] = [];
    const database: SqlClient = {
      query: async () => [],
      transaction: async (statements) => {
        transactions.push([...statements]);
      },
    };

    await expect(runMigrations(database)).resolves.toEqual({
      applied: [
        '0001_control_plane_foundation',
        '0002_paired_device_authentication',
        '0003_paired_device_replay_and_group_integrity',
      ],
      skipped: [],
    });

    expect(transactions).toHaveLength(4);
    const foundation = transactions[1].map((statement) => statement.text).join('\n');
    const authentication = transactions[2].map((statement) => statement.text).join('\n');
    const replayAndIntegrity = transactions[3].map((statement) => statement.text).join('\n');
    expect(transactions[1][0]).toMatchObject({ text: 'SELECT pg_advisory_xact_lock($1)' });
    expect(transactions[2][0]).toMatchObject({ text: 'SELECT pg_advisory_xact_lock($1)' });
    expect(transactions[3][0]).toMatchObject({ text: 'SELECT pg_advisory_xact_lock($1)' });
    for (const table of [
      'groups',
      'devices',
      'materials',
      'material_versions',
      'upload_sessions',
      'settings_documents',
      'layout_documents',
      'sync_events',
      'history_events',
      'simulation_profiles',
      'github_installations',
      'translation_proposals',
    ]) {
      expect(foundation).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(foundation).toContain('INSERT INTO hq_schema_migrations');
    expect(authentication).toContain('device_access_tokens');
    expect(authentication).toContain('device_refresh_token_history');
    expect(authentication).toContain('pairing_codes_active_group_expiry_idx');
    expect(authentication).toContain('device_sessions_active_device_group_idx');
    expect(authentication).toContain('INSERT INTO hq_schema_migrations');
    for (const column of [
      'refresh_previous_token_hash',
      'refresh_previous_hash_version',
      'refresh_previous_expires_at',
      'refresh_previous_retired_at',
    ]) {
      expect(replayAndIntegrity).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const constraint of [
      'device_sessions_group_membership_fk',
      'pairing_codes_creator_membership_fk',
      'groups_leader_membership_fk',
    ]) {
      expect(replayAndIntegrity).toContain(`ADD CONSTRAINT ${constraint}`);
      expect(replayAndIntegrity).toContain(`VALIDATE CONSTRAINT ${constraint}`);
    }
    expect(replayAndIntegrity).toContain('DEFERRABLE INITIALLY DEFERRED NOT VALID');
    expect(replayAndIntegrity).toContain('device_sessions_previous_refresh_hash_unique');
    expect(replayAndIntegrity).toContain('device_sessions_previous_refresh_expiry_idx');
    expect(replayAndIntegrity).toContain('INSERT INTO hq_schema_migrations');
  });

  it('appends auth state without persisting raw credentials or changing foundation checksum content', async () => {
    expect(migrations.map((migration) => migration.id)).toEqual([
      '0001_control_plane_foundation',
      '0002_paired_device_authentication',
      '0003_paired_device_replay_and_group_integrity',
    ]);
    const authenticationSql = migrations[1].statements
      .map((statement) => statement.text)
      .join('\n');

    expect(authenticationSql).toContain('token_hash');
    expect(migrations[0].statements.map((statement) => statement.text).join('\\n')).toContain(
      'refresh_token_hash',
    );
    expect(authenticationSql).toContain('hash_version');
    expect(authenticationSql).not.toMatch(/\baccess_token\s+text\b/u);
    expect(authenticationSql).not.toMatch(/\brefresh_token\s+text\b/u);
    expect(authenticationSql).not.toMatch(/\bpairing_code\s+text\b/u);

    const transactions: SqlStatement[][] = [];
    const database: SqlClient = {
      query: async () => [{ id: migrations[0].id, checksum: checksumFor(migrations[0]) }],
      transaction: async (statements) => {
        transactions.push([...statements]);
      },
    };

    await expect(runMigrations(database)).resolves.toEqual({
      applied: [
        '0002_paired_device_authentication',
        '0003_paired_device_replay_and_group_integrity',
      ],
      skipped: ['0001_control_plane_foundation'],
    });
    expect(transactions).toHaveLength(3);
  });

  it('rejects changed migration content after its checksum has been recorded', async () => {
    const migration = migrations[0];
    const database: SqlClient = {
      query: async () => [{ id: migration.id, checksum: `${checksumFor(migration)}-drift` }],
      transaction: async () => undefined,
    };

    await expect(runMigrations(database)).rejects.toThrow(
      'Migration checksum drift detected for 0001_control_plane_foundation',
    );
  });
});
