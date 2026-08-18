import { describe, expect, it, vi } from 'vitest';

import type { SqlClient, SqlStatement, SqlTransactionResults } from './database.js';
import { migrations, runMigrations } from './migrations.js';

interface MigrationOutcomeRow extends Record<string, unknown> {
  readonly id: string;
  readonly applied: boolean;
}

function resultsFor(
  statements: readonly SqlStatement[],
  outcomes: readonly MigrationOutcomeRow[],
): SqlTransactionResults {
  return statements.map((_, index) => (index === statements.length - 1 ? [...outcomes] : []));
}

describe('control-plane migrations', () => {
  it('takes the advisory lock before creating or reading the migration ledger', async () => {
    const transactions: SqlStatement[][] = [];
    const query = vi.fn();
    const database: SqlClient = {
      query: async () => {
        query();
        return [];
      },
      transaction: async (statements) => {
        transactions.push([...statements]);
        return resultsFor(
          statements,
          migrations.map((migration) => ({ id: migration.id, applied: true })),
        );
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

    expect(transactions).toHaveLength(1);
    const transaction = transactions[0];
    const foundation = transaction[3].text;
    const authentication = transaction[4].text;
    const replayAndIntegrity = transaction[5].text;

    expect(transaction[0]).toMatchObject({ text: 'SELECT pg_advisory_xact_lock($1)' });
    expect(transaction[1].text).toContain('CREATE TABLE IF NOT EXISTS hq_schema_migrations');
    expect(transaction[2].text).toContain('CREATE TEMPORARY TABLE hq_migration_run_outcomes');
    expect(transaction.at(-1)?.text).toBe(
      'SELECT id, applied FROM hq_migration_run_outcomes ORDER BY ordinal',
    );
    expect(query).not.toHaveBeenCalled();

    for (const lockedMigration of [foundation, authentication, replayAndIntegrity]) {
      expect(lockedMigration).toMatch(/^DO \$hq_migration\$/u);
      expect(lockedMigration).toContain('SELECT checksum\n  INTO recorded_checksum');
      expect(lockedMigration).toContain('FROM hq_schema_migrations');
      expect(lockedMigration).toContain('INSERT INTO hq_migration_run_outcomes');
      expect(
        transaction.indexOf(transaction.find((statement) => statement.text === lockedMigration)!),
      ).toBeGreaterThan(0);
    }

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

  it('returns precise applied and skipped IDs from the locked transaction outcome query', async () => {
    expect(migrations.map((migration) => migration.id)).toEqual([
      '0001_control_plane_foundation',
      '0002_paired_device_authentication',
      '0003_paired_device_replay_and_group_integrity',
    ]);
    const authenticationSql = migrations[1].statements
      .map((statement) => statement.text)
      .join('\n');

    expect(authenticationSql).toContain('token_hash');
    expect(migrations[0].statements.map((statement) => statement.text).join('\n')).toContain(
      'refresh_token_hash',
    );
    expect(authenticationSql).toContain('hash_version');
    expect(authenticationSql).not.toMatch(/\baccess_token\s+text\b/u);
    expect(authenticationSql).not.toMatch(/\brefresh_token\s+text\b/u);
    expect(authenticationSql).not.toMatch(/\bpairing_code\s+text\b/u);

    const transactions: SqlStatement[][] = [];
    const database: SqlClient = {
      query: async () => {
        throw new Error('Migration state must not be read outside the locked transaction');
      },
      transaction: async (statements) => {
        transactions.push([...statements]);
        return resultsFor(statements, [
          { id: migrations[0].id, applied: false },
          { id: migrations[1].id, applied: true },
          { id: migrations[2].id, applied: true },
        ]);
      },
    };

    await expect(runMigrations(database)).resolves.toEqual({
      applied: [
        '0002_paired_device_authentication',
        '0003_paired_device_replay_and_group_integrity',
      ],
      skipped: ['0001_control_plane_foundation'],
    });
    expect(transactions).toHaveLength(1);
  });

  it('makes a queued second runner acquire the lock before it rechecks the ledger', async () => {
    const database = new SerializedMigrationDatabase();

    const first = runMigrations(database);
    await database.waitForFirstRunnerChecks();

    const second = runMigrations(database);
    await database.waitForSecondRunnerLockAttempt();
    expect(database.events).toContain('run-2:wait-lock');
    expect(database.events).not.toContain('run-2:acquired-lock');
    expect(database.events).not.toContain('run-2:recheck:0001_control_plane_foundation');

    database.releaseFirstRunner();

    await expect(first).resolves.toEqual({
      applied: migrations.map((migration) => migration.id),
      skipped: [],
    });
    await expect(second).resolves.toEqual({
      applied: [],
      skipped: migrations.map((migration) => migration.id),
    });

    const secondLock = database.events.indexOf('run-2:acquired-lock');
    const secondRecheck = database.events.indexOf('run-2:recheck:0001_control_plane_foundation');
    expect(secondLock).toBeGreaterThanOrEqual(0);
    expect(secondRecheck).toBeGreaterThan(secondLock);
  });

  it('preserves immutable checksum drift rejection inside the locked migration block', async () => {
    const migration = migrations[0];
    const database: SqlClient = {
      query: async () => {
        throw new Error('Migration state must not be read outside the locked transaction');
      },
      transaction: async (statements) => {
        expect(statements[0]).toMatchObject({ text: 'SELECT pg_advisory_xact_lock($1)' });
        expect(statements[3].text).toContain(
          `Migration checksum drift detected for ${migration.id}`,
        );
        throw new Error(`Migration checksum drift detected for ${migration.id}`);
      },
    };

    await expect(runMigrations(database)).rejects.toThrow(
      'Migration checksum drift detected for 0001_control_plane_foundation',
    );
  });

  it('rejects a SQL adapter that cannot return the outcome query rows', async () => {
    const database: SqlClient = {
      query: async () => [],
      transaction: async () => undefined,
    };

    await expect(runMigrations(database)).rejects.toThrow(
      'Migration runner requires SQL transaction results',
    );
  });
});

class SerializedMigrationDatabase implements SqlClient {
  readonly events: string[] = [];

  readonly #checksByFirstRunner = deferred<void>();
  readonly #secondRunnerLockAttempt = deferred<void>();
  readonly #releaseFirstRunner = deferred<void>();
  readonly #checksums = new Map<string, string>();
  #transactionCount = 0;
  #lockTail: Promise<void> = Promise.resolve();

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(): Promise<
    readonly Row[]
  > {
    throw new Error('Migration state must not be read outside the locked transaction');
  }

  async transaction(statements: readonly SqlStatement[]): Promise<SqlTransactionResults> {
    const runner = ++this.#transactionCount;
    const releaseLock = await this.acquireLock(runner);

    try {
      const outcomes = statements
        .filter((statement) => statement.text.startsWith('DO $hq_migration$'))
        .map((statement) => this.recheckLockedMigration(runner, statement));

      if (runner === 1) {
        this.#checksByFirstRunner.resolve();
        await this.#releaseFirstRunner.promise;
      }

      return resultsFor(statements, outcomes);
    } finally {
      releaseLock();
    }
  }

  async waitForFirstRunnerChecks(): Promise<void> {
    await this.#checksByFirstRunner.promise;
  }

  async waitForSecondRunnerLockAttempt(): Promise<void> {
    await this.#secondRunnerLockAttempt.promise;
  }

  releaseFirstRunner(): void {
    this.#releaseFirstRunner.resolve();
  }

  private async acquireLock(runner: number): Promise<() => void> {
    const previous = this.#lockTail;
    let releaseCurrent!: () => void;
    this.#lockTail = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    this.events.push(`run-${runner}:wait-lock`);
    if (runner === 2) this.#secondRunnerLockAttempt.resolve();
    await previous;
    this.events.push(`run-${runner}:acquired-lock`);

    return releaseCurrent;
  }

  private recheckLockedMigration(runner: number, statement: SqlStatement): MigrationOutcomeRow {
    const id = statement.text.match(/WHERE id = '([^']+)'/u)?.[1];
    const checksum = statement.text.match(/recorded_checksum <> '([^']+)'/u)?.[1];
    if (id === undefined || checksum === undefined) {
      throw new Error('Expected a locked migration ledger recheck statement');
    }

    this.events.push(`run-${runner}:recheck:${id}`);
    const existingChecksum = this.#checksums.get(id);
    if (existingChecksum !== undefined && existingChecksum !== checksum) {
      throw new Error(`Migration checksum drift detected for ${id}`);
    }

    if (existingChecksum !== undefined) return { id, applied: false };

    this.#checksums.set(id, checksum);
    return { id, applied: true };
  }
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
} {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}
