import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from './database.js';
import { checksumFor, migrations, runMigrations } from './migrations.js';

describe('control-plane migrations', () => {
  it('creates all production tables inside an advisory-locked transaction', async () => {
    const transactions: SqlStatement[][] = [];
    const database: SqlClient = {
      query: async () => [],
      transaction: async (statements) => {
        transactions.push([...statements]);
      },
    };

    await expect(runMigrations(database)).resolves.toEqual({
      applied: ['0001_control_plane_foundation'],
      skipped: [],
    });

    expect(transactions).toHaveLength(2);
    const foundation = transactions[1].map((statement) => statement.text).join('\n');
    expect(transactions[1][0]).toMatchObject({ text: 'SELECT pg_advisory_xact_lock($1)' });
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
