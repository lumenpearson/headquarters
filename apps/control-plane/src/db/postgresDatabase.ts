import { Pool, type PoolClient, type QueryConfig } from 'pg';

import type { SqlClient, SqlStatement, SqlTransactionResults } from './database.js';

/**
 * A `SqlClient` that speaks the PostgreSQL wire protocol over TCP.
 *
 * The Neon adapter in `database.ts` reaches Neon over HTTPS, one request per
 * statement. That is the right shape for a serverless function and the wrong
 * shape for the machine standing on the set: with the local network up and the
 * internet down, an HTTP driver has no database at all, so the group -- pairing,
 * membership, the event ledger -- stops existing while the screens keep running.
 * This adapter is what makes the offline-first posture true of the group and not
 * only of the presentation layer.
 *
 * `pg` is node-postgres, the reference driver for PostgreSQL on Node: it is what
 * `@neondatabase/serverless` itself re-implements, so its type parsing, its
 * parameter serialization and its `bytea` handling already match what every
 * durable adapter in this package was written against. Choosing it is choosing
 * not to introduce a second set of conversion rules.
 */

/**
 * Pool and timeout defaults, named so that a deployment that needs different
 * ones changes a number rather than a strategy.
 *
 * - `maxConnections` (8) is the ceiling on concurrent server connections. Every
 *   RPC in this package issues one statement, so eight is far above the traffic
 *   five paired devices produce; the ceiling exists because a plain PostgreSQL
 *   on a laptop ships with `max_connections = 100` shared with everything else
 *   on that machine. Past the ceiling a caller waits, and past
 *   `connectionTimeoutMs` it fails -- with an error naming a pool timeout,
 *   rather than hanging an RPC until the client gives up.
 * - `connectionTimeoutMs` (10 s) bounds both halves of acquiring a connection:
 *   waiting for a free one and opening a new one. An unreachable database
 *   therefore reports itself in ten seconds instead of blocking a request
 *   thread indefinitely.
 * - `idleTimeoutMs` (30 s) returns an unused connection to the operating system.
 *   On set that matters because the machine sleeps and wakes: a connection that
 *   survived a suspend is dead in a way only the next statement discovers, and
 *   half a minute of idleness is long enough that almost none of them do.
 * - `queryTimeoutMs` (30 s) bounds one standalone statement. `pool.query`
 *   releases the connection with the error, which destroys it, so a timed-out
 *   statement can never leave a half-read connection in the pool.
 * - `transactionStatementTimeoutMs` (120 s) bounds one statement *inside* a
 *   transaction, and is deliberately far looser. `runMigrations` opens its
 *   transaction with `pg_advisory_xact_lock`, whose whole purpose is to wait
 *   for another process's entire migration sequence; capping that at the
 *   standalone bound would turn an orderly wait into a startup failure. It is
 *   still bounded, because a peer that never commits would otherwise hold a
 *   pooled connection -- and its own locks -- forever, and eight of those stop
 *   the control plane answering with no error printed anywhere.
 */
export const postgresPoolDefaults = {
  maxConnections: 8,
  connectionTimeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  queryTimeoutMs: 30_000,
  transactionStatementTimeoutMs: 120_000,
} as const;

export interface PostgresPoolOptions {
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly transactionStatementTimeoutMs?: number;
}

/**
 * `pg` reads `query_timeout` from the per-query configuration object as well as
 * from the connection (`pg/lib/client.js`: `config.query_timeout ||
 * this.connectionParameters.query_timeout`), but `@types/pg` declares only the
 * connection-wide form on `ClientConfig`. Declaring the per-query field here
 * keeps the value type-checked instead of casting the whole configuration
 * object away in the one place where a wrong shape would go unnoticed.
 */
interface TimedQueryConfig extends QueryConfig {
  readonly query_timeout: number;
}

/**
 * Builds a pooled TCP client for `connectionUrl`.
 *
 * Constructing it opens no connection: `pg.Pool` creates its first server
 * connection on the first `connect`/`query`, exactly as the lazy Neon handle in
 * `database.ts` requires. That property is load bearing rather than incidental
 * -- health and capability reporting distinguish "no database is configured"
 * from "a database is configured", and a driver that dialled on construction
 * would turn an unreachable database into a process that never finishes
 * starting.
 *
 * Timeouts are applied by this driver, never as server-side session settings.
 * Measured against a live PostgreSQL 18 behind Neon's pooler on 2026-08-26: the
 * `statement_timeout` startup parameter is dropped in transit and arrives as
 * `0`, and a plain `SET statement_timeout` survives the connection being
 * returned to the pooler and is inherited by the *next*, unrelated client. A
 * session GUC is therefore both unreliable and contaminating here; a client-side
 * bound is neither.
 */
export function createPostgresSqlClient(
  connectionUrl: string,
  options: PostgresPoolOptions = {},
): SqlClient {
  const transactionStatementTimeoutMs =
    options.transactionStatementTimeoutMs ?? postgresPoolDefaults.transactionStatementTimeoutMs;

  const pool = new Pool({
    connectionString: connectionUrl,
    max: options.maxConnections ?? postgresPoolDefaults.maxConnections,
    connectionTimeoutMillis:
      options.connectionTimeoutMs ?? postgresPoolDefaults.connectionTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs ?? postgresPoolDefaults.idleTimeoutMs,
    query_timeout: options.queryTimeoutMs ?? postgresPoolDefaults.queryTimeoutMs,
    // TCP keepalive, so a connection to a machine that left the set's network
    // is discovered by the operating system rather than by a statement that
    // waits for a reply nobody will send.
    keepAlive: true,
    // An idle pooled connection must not be the reason a process stays alive.
    // The control plane's liveness comes from its listening socket; `migrate.ts`
    // and the opt-in test suites are short-lived and have no socket at all, and
    // without this they would sit at the end of their work waiting for an idle
    // timeout that only exists to close a connection nobody wants.
    allowExitOnIdle: true,
  });

  // A pooled connection can fail while nobody is using it -- the backend is
  // terminated by `DROP DATABASE ... WITH (FORCE)`, a compute scales to zero, a
  // switch reboots. `pg` reports that as an `error` event on the pool, and an
  // unhandled `error` event on an EventEmitter terminates the process. The pool
  // has already discarded the broken connection by the time this runs and the
  // next borrow opens a fresh one, so there is nothing to do and no caller to
  // tell: a lost idle connection is precisely the failure a pool exists to
  // absorb. Real failures reach a real caller through `query` and `transaction`.
  //
  // The listener is also what keeps a credential out of the console. `pg-pool`
  // builds that event's error with `err.client = client`, and a `pg.Client`
  // carries `connectionParameters.password`, so anything that prints the
  // unhandled error prints the database role's password with it. Measured on
  // 2026-08-26: with this line removed, terminating this pool's own backend put
  // the password in plain text into the test reporter's output. No committed
  // test reproduces it, because the probe that provokes it -- terminating the
  // backend behind `pg_backend_pid()` -- also terminates the connection issuing
  // it when a transaction pooler multiplexes the two onto one server backend,
  // which is what the live database available here does.
  pool.on('error', () => {});

  return {
    async query<Row extends Record<string, unknown>>({ text, values = [] }: SqlStatement) {
      const result = await pool.query(text, [...values]);
      return result.rows as readonly Row[];
    },

    /**
     * One real PostgreSQL transaction on one pooled connection.
     *
     * The whole batch runs between `BEGIN` and `COMMIT` on a single client, and
     * the client goes back to the pool only after the transaction has ended.
     * That ordering is the correctness property this adapter exists to hold:
     * `runMigrations` takes `pg_advisory_xact_lock` as its first statement, and
     * a transaction-scoped lock lives exactly as long as its transaction. A
     * client released mid-flight would hand the next borrower a connection
     * still inside a transaction, and two concurrent first runs would stop
     * being serialized -- silently, because each would still report success.
     *
     * `SqlClient.transaction` stays non-interactive on purpose: the statements
     * are supplied up front and nothing here reads a row and then decides what
     * to write. Real transactions make that possible, and every
     * security-sensitive mutation in this package is still one parameterized
     * statement with data-modifying CTEs. Do not use this adapter as a licence
     * to introduce a read-then-write sequence: the Neon driver cannot express
     * one, and a mutation that only works on one of the two drivers is a
     * mutation that fails on the shoot day the other one is configured.
     */
    async transaction(statements: readonly SqlStatement[]): Promise<SqlTransactionResults> {
      const client = await pool.connect();
      let unclean: Error | undefined;
      try {
        await client.query('BEGIN');
        const results: (readonly Record<string, unknown>[])[] = [];
        for (const { text, values = [] } of statements) {
          const configuration: TimedQueryConfig = {
            text,
            values: [...values],
            query_timeout: transactionStatementTimeoutMs,
          };
          const result = await client.query(configuration);
          results.push(result.rows as readonly Record<string, unknown>[]);
        }
        await client.query('COMMIT');
        return results;
      } catch (error) {
        unclean = await rollback(client, transactionStatementTimeoutMs);
        throw error;
      } finally {
        // `release(err)` with a truthy argument destroys the connection instead
        // of returning it. A connection whose `ROLLBACK` did not complete may
        // still be inside a transaction, holding the advisory lock and every row
        // lock the failed statements took; handing it to the next borrower would
        // spread one failed migration run into a control plane that deadlocks
        // against itself.
        client.release(unclean);
      }
    },

    /**
     * Closes every pooled connection. Optional on the port because the Neon HTTP
     * client holds none; here it is what lets a caller that is provably finished
     * -- a test dropping the database it just created, a migration script --
     * give the connections back at a moment it chooses rather than at an idle
     * timeout.
     */
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Ends the transaction, and reports the connection as unusable when it cannot.
 *
 * The rollback carries its own bound: the statement that failed may still be
 * running on the server, and this must not wait on it forever. Whatever goes
 * wrong here is deliberately not thrown -- the caller is already receiving the
 * error that ended the transaction, and replacing it with a rollback failure
 * would hide the cause behind the consequence.
 */
async function rollback(client: PoolClient, timeoutMs: number): Promise<Error | undefined> {
  try {
    const configuration: TimedQueryConfig = { text: 'ROLLBACK', query_timeout: timeoutMs };
    await client.query(configuration);
    return undefined;
  } catch (rollbackError) {
    return rollbackError instanceof Error ? rollbackError : new Error('ROLLBACK failed');
  }
}
