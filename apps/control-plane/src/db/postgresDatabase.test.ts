import { describe, expect, it } from 'vitest';

import { createDatabase, sqlClientFactoryFor } from './database.js';
import { createPostgresSqlClient, postgresPoolDefaults } from './postgresDatabase.js';

/*
 * Offline properties of the TCP driver. What it does against a live engine --
 * the advisory lock's lifetime, rollback, the pool -- is proved in
 * `postgresDatabase.integration.test.ts` and by running the eight opt-in
 * PostgreSQL suites with HQ_CONTROL_PLANE_TEST_DATABASE_DRIVER=postgres. These
 * are the ones that must hold with no database in reach at all, which is
 * exactly the situation this driver exists for.
 *
 * Nothing here puts a driver error, a client or a pool inside `expect`. A
 * failing assertion prints what it received, `pg` attaches the failing client to
 * some of its errors, and a `pg.Client` carries the connection's password: an
 * assertion written the obvious way turns one red test into a credential in the
 * CI log. Assertions are made on values extracted from an error, never on the
 * error itself.
 */

// Port 1 is reserved and never listening, so this address is unreachable
// without depending on a network being absent. The password is a distinctive
// literal precisely so a test can prove it never comes back out.
const unreachablePassword = 'not-a-real-password-8bd41c7f';
const unreachableUrl = `postgresql://hq:${unreachablePassword}@127.0.0.1:1/hq_no_such_database`;

describe('TCP PostgreSQL driver', () => {
  it('opens no connection while it is being constructed', () => {
    // Not a stylistic point. Health and capability reporting are built on
    // construction being free: `LazyDatabase.configured` answers before anything
    // has been dialled, and a driver that connected here would make an
    // unreachable database a process that never finishes starting.
    expect(() => createPostgresSqlClient(unreachableUrl)).not.toThrow();
  });

  it('reports an unreachable database through the statement, not at startup', async () => {
    const client = createPostgresSqlClient(unreachableUrl, { connectionTimeoutMs: 5_000 });

    const outcome = await client
      .query({ text: 'SELECT 1' })
      .then(() => 'resolved', describeErrorKind);
    expect(outcome).toBe('Error');

    await client.close?.();
  });

  it('reports an unreachable database from a transaction as well', async () => {
    const client = createPostgresSqlClient(unreachableUrl, { connectionTimeoutMs: 5_000 });

    const outcome = await client
      .transaction([{ text: 'SELECT 1' }])
      .then(() => 'resolved', describeErrorKind);
    expect(outcome).toBe('Error');

    await client.close?.();
  });

  it('lets no error out still holding the connection that produced it', async () => {
    const client = createPostgresSqlClient(unreachableUrl, { connectionTimeoutMs: 5_000 });

    const fromQuery = await client.query({ text: 'SELECT 1' }).then(() => undefined, keep);
    const fromTransaction = await client
      .transaction([{ text: 'SELECT 1' }])
      .then(() => undefined, keep);

    // The property, stated as what a reporter or a logger would see: walk every
    // own property an error carries, as deep as it goes, and the password that
    // opened the connection is not in there.
    for (const error of [fromQuery, fromTransaction]) {
      expect(Object.getOwnPropertyNames(error ?? {})).not.toContain('client');
      expect(serializeOwnProperties(error).includes(unreachablePassword)).toBe(false);
    }

    await client.close?.();
  });

  it('leaves a lazy handle uninitialized until a statement is issued', async () => {
    const database = createDatabase(unreachableUrl, sqlClientFactoryFor('postgres'));

    expect(database.configured).toBe(true);
    expect(database.initialized).toBe(false);

    // Closing a handle that never ran a statement must not build a client in
    // order to close it: shutdown would then be the one path that dials.
    await database.close();
    expect(database.initialized).toBe(false);
  });

  it('resolves an unset driver to the one this package has always used', () => {
    expect(sqlClientFactoryFor(undefined)).toBe(sqlClientFactoryFor('neon'));
    expect(sqlClientFactoryFor('postgres')).toBe(createPostgresSqlClient);
  });

  it('bounds a statement inside a transaction far more loosely than a standalone one', () => {
    // `runMigrations` opens its transaction by waiting on pg_advisory_xact_lock
    // for another process's entire migration sequence. If the two bounds were
    // equal, a contended startup would fail instead of waiting.
    expect(postgresPoolDefaults.transactionStatementTimeoutMs).toBeGreaterThan(
      postgresPoolDefaults.queryTimeoutMs,
    );
  });
});

/** The constructor name alone, so a failed assertion prints a word, not an object. */
function describeErrorKind(reason: unknown): string {
  return reason instanceof Error ? 'Error' : typeof reason;
}

function keep(reason: unknown): unknown {
  return reason;
}

/**
 * Everything a reporter could reach from a value, flattened into one string.
 *
 * Deliberately not `JSON.stringify`: it skips non-enumerable properties, which
 * is where an `Error`'s own `message` and `stack` live, and it throws on a
 * cycle -- and a `pg.Client` is nothing but cycles.
 */
function serializeOwnProperties(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return String(value);
  if (seen.has(value)) return '';
  seen.add(value);
  return Object.getOwnPropertyNames(value)
    .map((name) => `${name}=${serializeOwnProperties(Reflect.get(value, name), seen)}`)
    .join('\n');
}
