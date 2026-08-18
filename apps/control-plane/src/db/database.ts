import { neon } from '@neondatabase/serverless';

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
}

export type SqlClientFactory = (connectionUrl: string) => SqlClient;

export class DatabaseConfigurationError extends Error {
  constructor() {
    super('HQ_CONTROL_PLANE_DATABASE_URL is required for a database operation');
    this.name = 'DatabaseConfigurationError';
  }
}

/**
 * A lazy Neon HTTP client. Merely constructing it does not create a network
 * connection, which keeps control-plane health-only development and tests
 * independent from a configured cloud database.
 */
export class NeonDatabase {
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

  private getClient(): SqlClient {
    if (this.connectionUrl === undefined) throw new DatabaseConfigurationError();
    this.#client ??= this.clientFactory(this.connectionUrl);
    return this.#client;
  }
}

export function createNeonDatabase(
  connectionUrl: string | undefined,
  clientFactory?: SqlClientFactory,
): NeonDatabase {
  return new NeonDatabase(connectionUrl, clientFactory);
}

function createNeonSqlClient(connectionUrl: string): SqlClient {
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
