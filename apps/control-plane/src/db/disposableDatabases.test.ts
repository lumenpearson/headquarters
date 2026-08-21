import { describe, expect, it } from 'vitest';

import type { SqlClient, SqlStatement } from './database.js';
import {
  describesSameDatabase,
  disposableDatabaseCreatedAtMs,
  disposableDatabaseName,
  isStaleDisposableDatabase,
  sweepDisposableDatabases,
} from './disposableDatabases.js';

const hour = 3_600_000;
const now = 1_700_000_000_000;

function recordingClient(names: readonly string[]): {
  readonly client: SqlClient;
  readonly statements: readonly SqlStatement[];
} {
  const statements: SqlStatement[] = [];
  const client: SqlClient = {
    query: async (statement) => {
      statements.push(statement);
      return statement.text.includes('pg_database') ? names.map((datname) => ({ datname })) : [];
    },
    transaction: async () => undefined,
  };
  return { client, statements };
}

describe('disposable database names', () => {
  it('round-trips the creation instant it encodes', () => {
    expect(disposableDatabaseCreatedAtMs(disposableDatabaseName(now, 'abc123'))).toBe(now);
  });

  it('treats a name from before this scheme as stale', () => {
    // The real orphan this work removed. `tvluzt` happens to be valid base 36
    // -- it parses as 1970-01-21 -- so nothing but the segment count and the
    // instant floor stops it from passing for a name this scheme produced.
    expect(disposableDatabaseCreatedAtMs('hqtest_tvluzt')).toBeUndefined();
    expect(isStaleDisposableDatabase('hqtest_tvluzt', now, hour)).toBe(true);
  });

  it('refuses an instant that predates the scheme even in the right shape', () => {
    const impossible = `hqtest_${(1_000_000_000).toString(36)}_abc123`;
    expect(disposableDatabaseCreatedAtMs(impossible)).toBeUndefined();
    expect(isStaleDisposableDatabase(impossible, now, hour)).toBe(true);
  });

  it('keeps a database a concurrent run could still be using', () => {
    expect(
      isStaleDisposableDatabase(disposableDatabaseName(now - 60_000, 'abc123'), now, hour),
    ).toBe(false);
  });

  it('never claims a database that is not ours', () => {
    expect(isStaleDisposableDatabase('neondb', now, hour)).toBe(false);
    expect(isStaleDisposableDatabase('hq_scratch', now, hour)).toBe(false);
  });
});

describe('sweepDisposableDatabases', () => {
  it('drops only the stale ones and forces the pooled connections off', async () => {
    const stale = disposableDatabaseName(now - 2 * hour, 'aaaaaaaa');
    const fresh = disposableDatabaseName(now - 60_000, 'bbbbbbbb');
    const { client, statements } = recordingClient([stale, fresh, 'hqtest_tvluzt']);

    const result = await sweepDisposableDatabases(client, now, hour);

    expect(result.dropped).toEqual([stale, 'hqtest_tvluzt']);
    expect(result.kept).toEqual([fresh]);
    // `starts_with`, not LIKE: the underscore in `hqtest_` is a LIKE wildcard.
    expect(statements[0]?.text).toContain('starts_with(datname, $1)');
    expect(statements[0]?.values).toEqual(['hqtest_']);
    expect(statements.slice(1).map((statement) => statement.text)).toEqual([
      `DROP DATABASE IF EXISTS ${stale} WITH (FORCE)`,
      'DROP DATABASE IF EXISTS hqtest_tvluzt WITH (FORCE)',
    ]);
  });

  it('issues no DROP when nothing is stale', async () => {
    const { client, statements } = recordingClient([
      disposableDatabaseName(now - 1000, 'cccccccc'),
    ]);

    const result = await sweepDisposableDatabases(client, now, hour);

    expect(result.dropped).toEqual([]);
    expect(statements).toHaveLength(1);
  });
});

describe('describesSameDatabase', () => {
  it('sees through query-string and case differences', () => {
    expect(
      describesSameDatabase(
        'postgresql://role:password@ep-hq.neon.tech/headquarters?sslmode=require',
        'postgresql://other:key@EP-HQ.neon.tech/headquarters',
      ),
    ).toBe(true);
  });

  it('separates two databases on one host', () => {
    expect(
      describesSameDatabase(
        'postgresql://role:password@ep-hq.neon.tech/neondb?sslmode=require',
        'postgresql://role:password@ep-hq.neon.tech/hq_scratch?sslmode=require',
      ),
    ).toBe(false);
  });
});
