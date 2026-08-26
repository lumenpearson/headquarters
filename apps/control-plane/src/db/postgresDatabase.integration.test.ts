import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SqlClient } from './database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from './liveDatabase.js';
import { migrations, runMigrations } from './migrations.js';
import { createPostgresSqlClient } from './postgresDatabase.js';

/**
 * The properties of the TCP driver that only a live engine can show.
 *
 * That the driver satisfies the same contract as the HTTP one is not proved
 * here and must not be: it is proved by running the eight existing opt-in
 * PostgreSQL suites with `HQ_CONTROL_PLANE_TEST_DATABASE_DRIVER=postgres`, which
 * executes the same durable adapters, the same CTEs and the same locking
 * against this driver. A second suite restating those scenarios would only
 * prove that it agrees with itself.
 *
 * What is here is what no existing suite can express, because the HTTP driver
 * has no pool and no interactive transaction to get wrong: that a
 * transaction-scoped advisory lock is held across every statement of the batch
 * and released at commit, that a failed batch rolls back, and that a connection
 * comes back to the pool on both paths. The first of those is the property
 * `runMigrations` rests on -- a connection returned to the pool before `COMMIT`
 * would stop serializing two concurrent first runs, and both would still report
 * success.
 *
 * Unlike the suites above, this one pins the driver rather than reading it from
 * the environment: it is about this adapter, so running it against the HTTP one
 * would prove nothing and fail confusingly.
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;

/** Per-database, so a disposable database of its own makes collision impossible. */
const advisoryLockProbeKey = 920_301_850;

describeIntegration('TCP PostgreSQL driver against a live engine', () => {
  const pool = new DisposableDatabasePool(testDatabaseUrl ?? '', createPostgresSqlClient);
  const opened: SqlClient[] = [];
  let database: SqlClient;
  let databaseUrl: string;

  beforeAll(async () => {
    const swept = await pool.sweep();
    if (swept.dropped.length > 0) {
      process.stderr.write(`Swept abandoned test databases: ${swept.dropped.join(', ')}\n`);
    }
    database = await pool.create();
    databaseUrl = await urlOf(database);
  }, networkTimeoutMs);

  afterAll(async () => {
    for (const client of opened) await client.close?.();
    await pool.dropAll();
  }, networkTimeoutMs);

  it(
    'holds a transaction-scoped advisory lock for the whole batch and releases it at commit',
    async () => {
      // Warm the pool before timing anything. Opening a TLS connection to the
      // live database is the slowest thing in this test by an order of
      // magnitude, and a probe that fires while the transaction is still
      // connecting reports an unlocked key for an honest reason -- which is a
      // green test that proves nothing, or a red one that blames the adapter.
      await Promise.all([warm(), warm()]);

      let settled = false;
      // Written exactly as `runMigrations` writes it, `$1` and all, so this also
      // proves that an untyped bind parameter reaches pg_advisory_xact_lock as a
      // bigint on this driver.
      const inFlight = database
        .transaction([
          { text: 'SELECT pg_advisory_xact_lock($1)', values: [advisoryLockProbeKey] },
          { text: 'SELECT pg_sleep(5)' },
        ])
        .then((results) => {
          settled = true;
          return results;
        });

      // A different pooled connection, polled rather than sampled once: the
      // question is whether the key is *ever* held while the batch is in
      // flight, and no wall-clock guess can answer that across a network. If
      // the transaction's client had been returned to the pool after its first
      // statement, no poll would ever find the key taken -- which is precisely
      // how a migration runner would stop serializing.
      let heldWhileRunning = false;
      const deadline = Date.now() + 4_000;
      while (!settled && !heldWhileRunning && Date.now() < deadline) {
        const probe = await database.query<{ got: boolean }>({
          text: 'SELECT pg_try_advisory_xact_lock($1) AS got',
          values: [advisoryLockProbeKey],
        });
        heldWhileRunning = probe[0]?.got === false;
        if (!heldWhileRunning) await delay(100);
      }

      await inFlight;
      const after = await database.query<{ got: boolean }>({
        text: 'SELECT pg_try_advisory_xact_lock($1) AS got',
        values: [advisoryLockProbeKey],
      });

      expect(heldWhileRunning).toBe(true);
      // And released by the commit, not left behind on a pooled connection for
      // the next borrower to inherit.
      expect(after[0]?.got).toBe(true);
    },
    networkTimeoutMs,
  );

  it(
    'rolls a failed batch back and gives the connection back to the pool',
    async () => {
      // Two connections, so a leaked one is exhausted within three attempts.
      // The acquisition bound is generous rather than tight: it exists to turn a
      // leak into a failure, not to measure the internet, and a bound near the
      // cost of an honest TLS handshake would fail on a slow network and be
      // reported as a defect in the pool.
      const client = open({ maxConnections: 2, connectionTimeoutMs: 20_000 });
      await client.query({ text: 'CREATE TABLE rollback_probe (n integer NOT NULL)' });

      // Three times the pool size. Every rejection must still be the division by
      // zero: the moment one of them is a pool timeout, the connections are not
      // coming back. The code is extracted first, because a failed assertion
      // prints what it received and a `pg` error can carry the connection.
      const codes: (string | undefined)[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        codes.push(
          await client
            .transaction([
              { text: 'INSERT INTO rollback_probe (n) VALUES ($1)', values: [attempt] },
              { text: 'SELECT 1 / 0' },
            ])
            .then(() => 'resolved', sqlStateOf),
        );
      }
      expect(codes).toEqual(Array.from({ length: 6 }, () => '22012'));

      const rows = await client.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM rollback_probe',
      });
      expect(rows[0]?.n).toBe(0);
    },
    networkTimeoutMs,
  );

  it(
    'gives the connection back to the pool after a committed batch too',
    async () => {
      // One connection: if a committed transaction kept it, the second call
      // would wait out `connectionTimeoutMs` and reject. The bound is generous
      // for the same reason as above -- it separates a leak from a slow
      // network, and only a leak makes it unreachable.
      const client = open({ maxConnections: 1, connectionTimeoutMs: 20_000 });
      await client.query({ text: 'CREATE TABLE commit_probe (n integer NOT NULL)' });

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await client.transaction([
          { text: 'INSERT INTO commit_probe (n) VALUES ($1)', values: [attempt] },
        ]);
      }

      const rows = await client.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM commit_probe',
      });
      expect(rows[0]?.n).toBe(4);
    },
    networkTimeoutMs,
  );

  it(
    'forwards one row set per statement, in the order the statements were given',
    async () => {
      // The contract `runMigrations` reads its outcome table through. A driver
      // that returned only the last statement's rows would fail there with a
      // message about an incomplete outcome set and nothing about why.
      const results = await database.transaction([
        { text: 'SELECT 1 AS a' },
        { text: "SELECT 'x' AS b" },
        { text: 'CREATE TEMPORARY TABLE order_probe (n integer) ON COMMIT DROP' },
        { text: 'SELECT 2 AS c' },
      ]);

      expect(results).toEqual([[{ a: 1 }], [{ b: 'x' }], [], [{ c: 2 }]]);
    },
    networkTimeoutMs,
  );

  it(
    'applies the whole immutable sequence, and skips all of it on a second run',
    async () => {
      const fresh = await pool.create();

      const first = await runMigrations(fresh);
      const second = await runMigrations(fresh);

      expect(first.applied).toEqual(migrations.map((migration) => migration.id));
      expect(first.skipped).toEqual([]);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(migrations.map((migration) => migration.id));
    },
    networkTimeoutMs,
  );

  it(
    'applies each migration exactly once when two first runs start together',
    async () => {
      const contended = await pool.create();

      const [left, right] = await Promise.all([runMigrations(contended), runMigrations(contended)]);

      // The advisory lock is the only thing that can produce this split, and it
      // only produces it if the lock outlives every statement of the batch.
      for (const migration of migrations) {
        const appliedBy = [left, right].filter((result) =>
          result.applied.includes(migration.id),
        ).length;
        expect(`${migration.id}:applied=${appliedBy}`).toBe(`${migration.id}:applied=1`);
      }
      const ledger = await contended.query<{ n: number }>({
        text: 'SELECT count(*)::int AS n FROM hq_schema_migrations',
      });
      expect(ledger[0]?.n).toBe(migrations.length);
    },
    networkTimeoutMs,
  );

  it(
    'survives the server closing its connections, the way an autosuspending compute does',
    async () => {
      // This is the price the TCP driver pays and the HTTP driver does not.
      // Neon's free compute suspends after five minutes without traffic and
      // every connection it was holding dies; a LAN PostgreSQL restarts, a
      // switch reboots. The HTTP driver never notices because it holds nothing
      // between statements. The pool must discard the corpse and open a fresh
      // connection -- and it must not take the process down first, which an
      // unhandled `error` event on the pool would do.
      const isolated = await pool.create();
      const client = createPostgresSqlClient(await urlOf(isolated), {
        maxConnections: 2,
        connectionTimeoutMs: 20_000,
      });
      opened.push(client);
      const name = (
        await client.query<{ name: string }>({ text: 'SELECT current_database() AS name' })
      )[0]?.name;
      expect(name).toEqual(expect.any(String));

      // From the database this suite was pointed at, not from the disposable
      // one, so the statement terminates the pool's backends rather than its own
      // connection. A disposable database of its own is what keeps this from
      // reaching any other suite running beside it.
      const admin = createPostgresSqlClient(testDatabaseUrl ?? '', {
        connectionTimeoutMs: 20_000,
      });
      opened.push(admin);
      await admin.query({
        text: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
               WHERE datname = $1 AND pid <> pg_backend_pid()`,
        values: [name ?? ''],
      });
      await delay(500);

      // Whether the discard happens before or after the next borrow is a race
      // inside `pg`, so one statement is allowed to inherit the corpse. What
      // must not happen is that the connection never comes back.
      let ok: readonly { ok: number }[] | undefined;
      for (let attempt = 0; attempt < 3 && ok === undefined; attempt += 1) {
        ok = await client.query<{ ok: number }>({ text: 'SELECT 1 AS ok' }).catch(() => undefined);
        if (ok === undefined) await delay(250);
      }
      expect(ok).toEqual([{ ok: 1 }]);
    },
    networkTimeoutMs,
  );

  it(
    'lets no error from a live connection out still holding that connection',
    async () => {
      const password = new URL(databaseUrl).password;
      expect(password.length).toBeGreaterThan(0);

      const fromQuery = await database.query({ text: 'SELECT 1 / 0' }).then(() => undefined, keep);
      const fromTransaction = await database
        .transaction([{ text: 'SELECT 1 / 0' }])
        .then(() => undefined, keep);

      // `pg-pool` builds the error for a connection that died while idle with
      // `err.client = client`, and a `pg.Client` carries the connection's
      // password. Nothing a caller receives may be reachable to that object:
      // one printed rejection would put the deployment credential into a log
      // that keeps it.
      for (const error of [fromQuery, fromTransaction]) {
        expect(Object.getOwnPropertyNames(error ?? {})).not.toContain('client');
        expect(reachableStrings(error).some((text) => text.includes(password))).toBe(false);
      }
    },
    networkTimeoutMs,
  );

  it(
    'reports a database that does not exist through the statement, and names no credential',
    async () => {
      const wrong = new URL(databaseUrl);
      wrong.pathname = '/hqtest_no_such_database_here';
      const password = wrong.password;
      expect(password.length).toBeGreaterThan(0);

      // Construction stays free even for a URL that cannot resolve to anything:
      // startup reports a configured database, and the failure arrives when a
      // caller asks for something.
      const client = createPostgresSqlClient(wrong.toString(), { connectionTimeoutMs: 20_000 });
      opened.push(client);

      const error = await client.query({ text: 'SELECT 1' }).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      // Every assertion is on an extracted value. Putting the error itself in an
      // `expect` would print it on failure, and this is the one test guaranteed
      // to be holding a driver error built from the live connection string.
      expect(error instanceof Error).toBe(true);
      // 3D000 invalid_catalog_name is the honest answer; a proxy in front of the
      // database may answer with its own transport failure instead, and either
      // is a report rather than a crash. What must never happen is a message
      // carrying the credential that opened the connection.
      expect(reachableStrings(error).some((text) => text.includes(password))).toBe(false);
      expect(Object.getOwnPropertyNames(error ?? {})).not.toContain('client');
    },
    networkTimeoutMs,
  );

  function open(options: Parameters<typeof createPostgresSqlClient>[1]): SqlClient {
    const client = createPostgresSqlClient(databaseUrl, options);
    opened.push(client);
    return client;
  }

  /** One round trip, so the pool has a connection before anything is timed. */
  async function warm(): Promise<void> {
    await database.query({ text: 'SELECT 1' });
  }

  async function urlOf(client: SqlClient): Promise<string> {
    const rows = await client.query<{ name: string }>({
      text: 'SELECT current_database() AS name',
    });
    const name = rows[0]?.name;
    if (name === undefined) throw new Error('The disposable database did not name itself');
    const url = new URL(testDatabaseUrl ?? '');
    url.pathname = `/${name}`;
    return url.toString();
  }
});

/**
 * The PostgreSQL SQLSTATE of a rejection, and nothing else.
 *
 * Assertions in this file compare these strings rather than the errors they came
 * from. A failed `expect` prints what it received; `pg` attaches the failing
 * client to some of its errors and a `pg.Client` holds the connection's
 * password, so an assertion on the error object turns one red test into a
 * credential in a CI log that keeps it forever.
 */
function sqlStateOf(reason: unknown): string | undefined {
  if (typeof reason !== 'object' || reason === null) return undefined;
  const code: unknown = Reflect.get(reason, 'code');
  return typeof code === 'string' ? code : undefined;
}

function keep(reason: unknown): unknown {
  return reason;
}

/** Every string reachable from a value's own properties, cycles included. */
function reachableStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null || seen.has(value)) return [];
  seen.add(value);
  return Object.getOwnPropertyNames(value).flatMap((name) =>
    reachableStrings(Reflect.get(value, name), seen),
  );
}
