import { neon } from '@neondatabase/serverless';

import { createPostgresSqlClient } from './postgresDatabase.js';

export type SqlParameter = boolean | Date | null | number | string | Uint8Array;

export interface SqlStatement {
  readonly text: string;
  readonly values?: readonly SqlParameter[];
}

/**
 * Rows returned by a non-interactive SQL transaction, in the same order as
 * the statements supplied to {@link SqlClient.transaction}.
 *
 * `void` remains part of the transaction return contract because adapters
 * written before result forwarding are still valid for fire-and-forget
 * callers. Callers that need a transaction-scoped query result must reject a
 * `void` response explicitly instead of falling back to a separate query.
 */
export type SqlTransactionResults = readonly (readonly Record<string, unknown>[])[];

export interface SqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: SqlStatement,
  ): Promise<readonly Row[]>;
  transaction(statements: readonly SqlStatement[]): Promise<SqlTransactionResults | void>;
  /**
   * Releases whatever the driver holds open. Optional because a driver may hold
   * nothing: the Neon HTTP client opens a connection per request and has no
   * pool to end, while the TCP client does. A caller that is provably finished
   * with a database -- a test about to drop it, a script about to exit -- calls
   * it when it knows; nothing else has to.
   */
  close?(): Promise<void>;
}

export type SqlClientFactory = (connectionUrl: string) => SqlClient;

/**
 * Which driver reaches the database.
 *
 * `neon` is the HTTP driver: one HTTPS request per statement, no pool, and a
 * dependency on the public internet. `postgres` is node-postgres over TCP: a
 * pool, real transactions, and a database that can be a machine on the set's
 * own network with no route out of it.
 *
 * This is configuration and not inference, for three reasons measured rather
 * than assumed. The connection URL does not carry the answer: Neon's compute
 * speaks the wire protocol on 5432, so one `postgresql://` string is valid for
 * both drivers and a live TCP connection to the URL in this repository's own
 * `.env` was proved on 2026-08-26. Inferring would mean matching a vendor
 * hostname inside a configuration parser, which is wrong for a Neon custom
 * domain and for every other provider that ships an HTTP driver. And the choice
 * belongs to the deployment rather than to the database: a serverless function
 * wants one round trip and no pool, a long-lived process on set wants a pool and
 * a real transaction, and both may address the same database on the same day.
 */
export type SqlDriverName = 'neon' | 'postgres';

export const defaultSqlDriver: SqlDriverName = 'neon';

export class DatabaseConfigurationError extends Error {
  constructor() {
    super('HQ_CONTROL_PLANE_DATABASE_URL is required for a database operation');
    this.name = 'DatabaseConfigurationError';
  }
}

/**
 * A lazy database handle. Merely constructing it does not create a network
 * connection, which keeps control-plane health-only development and tests
 * independent from a configured database, and keeps an unreachable one out of
 * the startup path: `configured` says a URL was supplied, `initialized` says a
 * driver client was built, and neither of them asks the database anything.
 *
 * The driver is whatever `clientFactory` builds. Both shipped drivers honour
 * the same laziness -- the Neon HTTP client because it holds no connection at
 * all, the TCP client because `pg.Pool` opens its first connection on first use.
 */
export class LazyDatabase {
  #client: SqlClient | undefined;

  constructor(
    readonly connectionUrl: string | undefined,
    private readonly clientFactory: SqlClientFactory = createNeonSqlClient,
  ) {}

  get configured(): boolean {
    return this.connectionUrl !== undefined;
  }

  get initialized(): boolean {
    return this.#client !== undefined;
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: SqlStatement,
  ): Promise<readonly Row[]> {
    return this.getClient().query<Row>(statement);
  }

  transaction(statements: readonly SqlStatement[]): Promise<SqlTransactionResults | void> {
    return this.getClient().transaction(statements);
  }

  /**
   * Releases the driver client, if one was ever built. A handle that never ran a
   * statement has nothing to close and must not build a client in order to
   * close it -- that would make shutdown the one path that dials an unreachable
   * database. After closing, the handle is usable again and the next statement
   * builds a fresh client.
   */
  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    await client?.close?.();
  }

  private getClient(): SqlClient {
    if (this.connectionUrl === undefined) throw new DatabaseConfigurationError();
    this.#client ??= this.clientFactory(this.connectionUrl);
    return this.#client;
  }
}

export function createDatabase(
  connectionUrl: string | undefined,
  clientFactory?: SqlClientFactory,
): LazyDatabase {
  return new LazyDatabase(connectionUrl, clientFactory);
}

/**
 * The factory for a driver name. `undefined` resolves to {@link defaultSqlDriver},
 * so a deployment that sets nothing behaves exactly as it did before the TCP
 * driver existed: this selection adds a capability and changes no default.
 */
export function sqlClientFactoryFor(driver: SqlDriverName | undefined): SqlClientFactory {
  return (driver ?? defaultSqlDriver) === 'postgres'
    ? createPostgresSqlClient
    : createNeonSqlClient;
}

export function createNeonSqlClient(connectionUrl: string): SqlClient {
  const sql = neon(connectionUrl);

  return {
    async query<Row extends Record<string, unknown>>({ text, values = [] }: SqlStatement) {
      return (await sql.query(text, [...values])) as readonly Row[];
    },
    async transaction(statements: readonly SqlStatement[]): Promise<SqlTransactionResults> {
      return (await sql.transaction(
        statements.map(({ text, values = [] }) => sql.query(text, [...values])),
      )) as SqlTransactionResults;
    },
  };
}
