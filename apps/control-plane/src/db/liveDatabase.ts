import { randomBytes } from 'node:crypto';

import {
  createDatabase,
  defaultSqlDriver,
  sqlClientFactoryFor,
  type SqlClient,
  type SqlClientFactory,
  type SqlDriverName,
} from './database.js';
import {
  describesSameDatabase,
  disposableDatabaseName,
  sweepDisposableDatabases,
} from './disposableDatabases.js';

/**
 * The bootstrap the opt-in PostgreSQL suites share.
 *
 * Before F6 exactly one suite proved anything against a live engine, so its
 * sweep-create-drop bootstrap lived inline. F6 adds several more — realtime
 * events, settings, materials, telemetry, integration — and each one repeating
 * sixty lines of database lifecycle is the duplication that turns one corrected
 * safety rule into five uncorrected copies of it. The bootstrap moves here
 * whole; nothing is left behind at the old site.
 *
 * This module deliberately imports no test framework: gating a suite is the
 * caller's business, and a `describe.skip` here would make production code
 * depend on Vitest.
 */

/** One hour is far beyond any suite's worst case, so a sweep cannot reach a live run. */
export const defaultStaleDatabaseAfterMs = 3_600_000;

export class LiveDatabaseMisconfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveDatabaseMisconfigurationError';
  }
}

/**
 * The disposable-database URL, or `undefined` when the suite must skip.
 *
 * Throws rather than skipping when the disposable URL resolves to the
 * deployment database: this code drops databases, and a silent skip would hide
 * a configuration that is one run away from deleting real data.
 */
export function liveTestDatabaseUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const testUrl = environment.HQ_CONTROL_PLANE_TEST_DATABASE_URL;
  const deploymentUrl = environment.HQ_CONTROL_PLANE_DATABASE_URL;
  if (testUrl === undefined || testUrl.trim().length === 0) return undefined;
  if (deploymentUrl !== undefined && describesSameDatabase(testUrl, deploymentUrl)) {
    throw new LiveDatabaseMisconfigurationError(
      'HQ_CONTROL_PLANE_TEST_DATABASE_URL must not address the same database as ' +
        'HQ_CONTROL_PLANE_DATABASE_URL: the opt-in suites create and drop databases.',
    );
  }
  return testUrl;
}

/**
 * Which driver the opt-in suites run through.
 *
 * There is one variable and no second copy of the suites, because a driver that
 * is proved by a suite written for it proves only that the suite matches the
 * driver. `HQ_CONTROL_PLANE_TEST_DATABASE_DRIVER=postgres` re-runs the same
 * eight PostgreSQL suites -- migrations, pairing, receipts, realtime events,
 * settings, materials, telemetry, integrations -- against the TCP adapter,
 * which is what "the adapter satisfies the same contract" has to mean.
 *
 * It defaults to the driver the control plane defaults to, so an unset
 * environment runs exactly what it ran before.
 */
export function liveTestSqlDriver(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SqlDriverName {
  const value = environment.HQ_CONTROL_PLANE_TEST_DATABASE_DRIVER?.trim();
  if (value === undefined || value.length === 0) return defaultSqlDriver;
  if (value !== 'neon' && value !== 'postgres') {
    throw new LiveDatabaseMisconfigurationError(
      `HQ_CONTROL_PLANE_TEST_DATABASE_DRIVER must be 'neon' or 'postgres', not '${value}'`,
    );
  }
  return value;
}

export interface SweptDatabases {
  readonly dropped: readonly string[];
}

/**
 * Creates and destroys the throwaway databases of one suite.
 *
 * Every database it hands out is recorded, so `dropAll` removes exactly what
 * this pool created and nothing else. What earlier runs abandoned is removed by
 * `sweep`, which decides staleness from the instant encoded in the name.
 */
export class DisposableDatabasePool {
  readonly #admin: SqlClient;
  readonly #baseUrl: string;
  readonly #clientFactory: SqlClientFactory;
  readonly #created: { readonly name: string; readonly client: SqlClient }[] = [];

  /**
   * The admin handle and every database this pool hands out use the same
   * driver, so a run configured for TCP has no HTTP request in it anywhere and
   * a failure cannot be attributed to the half that was not under test.
   */
  constructor(
    baseUrl: string,
    clientFactory: SqlClientFactory = sqlClientFactoryFor(liveTestSqlDriver()),
  ) {
    this.#baseUrl = baseUrl;
    this.#clientFactory = clientFactory;
    this.#admin = createDatabase(baseUrl, clientFactory);
  }

  async sweep(
    nowMs: number = Date.now(),
    staleAfterMs: number = defaultStaleDatabaseAfterMs,
  ): Promise<SweptDatabases> {
    const swept = await sweepDisposableDatabases(this.#admin, nowMs, staleAfterMs);
    return { dropped: swept.dropped };
  }

  async create(): Promise<SqlClient> {
    const name = disposableDatabaseName(Date.now(), randomBytes(8).toString('hex'));
    await this.#admin.query({ text: `CREATE DATABASE ${name}` });
    const url = new URL(this.#baseUrl);
    url.pathname = `/${name}`;
    const client = createDatabase(url.toString(), this.#clientFactory);
    this.#created.push({ name, client });
    return client;
  }

  async dropAll(): Promise<void> {
    for (const { name, client } of this.#created) {
      // Close before dropping. The TCP driver holds a connection pool open
      // against exactly the database about to be removed, and giving those
      // connections back deliberately is what keeps the teardown a decision
      // rather than a race against an idle timeout. The HTTP driver holds
      // nothing and its `close` is absent, which is why the call is optional.
      await client.close?.();
      // FORCE is still required: the pooled endpoint keeps short-lived
      // connections of its own that would otherwise make DROP DATABASE fail.
      await this.#admin.query({ text: `DROP DATABASE IF EXISTS ${name} WITH (FORCE)` });
    }
    this.#created.length = 0;
    // The admin handle goes last, and only after the drops it was needed for.
    // It is lazy, so a pool reused after this simply builds a fresh client.
    await this.#admin.close?.();
  }
}
