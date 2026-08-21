import type { SqlClient } from './database.js';

/**
 * Naming and lifecycle for the throwaway databases the opt-in PostgreSQL suite
 * creates.
 *
 * The suite used to name them `hqtest_<random>` and drop them only in its
 * `afterAll` hook. Any interrupted run -- Ctrl+C, a crashed worker, a dropped
 * network -- left a database behind for good, and nothing distinguished an
 * abandoned one from the database of a run still in flight. Encoding the
 * creation instant in the name makes that distinction decidable, so a later run
 * can sweep what is provably stale without ever touching a live run's database.
 */
export const disposableDatabasePrefix = 'hqtest_';

export interface SweepResult {
  readonly dropped: readonly string[];
  readonly kept: readonly string[];
}

export function disposableDatabaseName(createdAtMs: number, suffix: string): string {
  return `${disposableDatabasePrefix}${createdAtMs.toString(36)}_${suffix}`;
}

/**
 * No instant this scheme produces can predate the scheme itself. The floor is
 * what keeps a legacy name from impersonating one: `hqtest_tvluzt` parses as a
 * perfectly valid base-36 number, and it lands on 1970-01-21.
 */
const earliestPlausibleInstantMs = Date.UTC(2020, 0, 1);

/**
 * The creation instant encoded in the name, or `undefined` when the name did
 * not come from {@link disposableDatabaseName}.
 */
export function disposableDatabaseCreatedAtMs(name: string): number | undefined {
  if (!name.startsWith(disposableDatabasePrefix)) return undefined;
  // `<instant>_<suffix>`. Names from before this scheme carry a suffix alone,
  // so the segment count already separates the two on its own.
  const segments = name.slice(disposableDatabasePrefix.length).split('_');
  if (segments.length !== 2) return undefined;
  const encoded = segments[0];
  if (encoded === undefined || !/^[0-9a-z]+$/u.test(encoded)) return undefined;
  const createdAtMs = Number.parseInt(encoded, 36);
  return Number.isSafeInteger(createdAtMs) && createdAtMs >= earliestPlausibleInstantMs
    ? createdAtMs
    : undefined;
}

export function isStaleDisposableDatabase(
  name: string,
  nowMs: number,
  staleAfterMs: number,
): boolean {
  if (!name.startsWith(disposableDatabasePrefix)) return false;
  const createdAtMs = disposableDatabaseCreatedAtMs(name);
  // A name with no instant predates this scheme, so its run is long over.
  return createdAtMs === undefined || nowMs - createdAtMs >= staleAfterMs;
}

export async function sweepDisposableDatabases(
  admin: SqlClient,
  nowMs: number,
  staleAfterMs: number,
): Promise<SweepResult> {
  // `starts_with`, not LIKE: in a LIKE pattern the underscore of `hqtest_` is a
  // single-character wildcard, so `LIKE 'hqtest_%'` would also match databases
  // this suite does not own.
  const rows = await admin.query<{ datname: string }>({
    text: 'SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname',
    values: [disposableDatabasePrefix],
  });

  const dropped: string[] = [];
  const kept: string[] = [];
  for (const { datname } of rows) {
    if (!isStaleDisposableDatabase(datname, nowMs, staleAfterMs)) {
      kept.push(datname);
      continue;
    }
    // FORCE: the pooled endpoint keeps short-lived connections that would
    // otherwise make DROP DATABASE fail. The name is interpolated because DDL
    // takes no bind parameters; it came from pg_database and matched our own
    // prefix, so no caller-supplied text reaches this statement.
    await admin.query({ text: `DROP DATABASE IF EXISTS ${datname} WITH (FORCE)` });
    dropped.push(datname);
  }
  return { dropped, kept };
}

/**
 * Whether two connection URLs address the same database.
 *
 * The destructive suite drops databases; pointing it at the deployment URL
 * would delete real data. `.env.example` can only ask a human not to do that.
 * Comparing host and database name makes the rule executable, and ignoring the
 * query string keeps a reordered `?sslmode=require` from defeating it.
 */
export function describesSameDatabase(a: string, b: string): boolean {
  const left = new URL(a);
  const right = new URL(b);
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.pathname.replace(/\/+$/u, '') === right.pathname.replace(/\/+$/u, '')
  );
}
