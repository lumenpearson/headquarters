import { randomBytes } from 'node:crypto';

import { createNeonDatabase, type SqlClient } from './database.js';
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
  readonly #created: string[] = [];

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
    this.#admin = createNeonDatabase(baseUrl);
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
    this.#created.push(name);
    const url = new URL(this.#baseUrl);
    url.pathname = `/${name}`;
    return createNeonDatabase(url.toString());
  }

  async dropAll(): Promise<void> {
    for (const name of this.#created) {
      // FORCE is required: the pooled endpoint keeps short-lived connections
      // that would otherwise make DROP DATABASE fail.
      await this.#admin.query({ text: `DROP DATABASE IF EXISTS ${name} WITH (FORCE)` });
    }
    this.#created.length = 0;
  }
}
