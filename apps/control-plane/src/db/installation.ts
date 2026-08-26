import type { SqlClient } from './database.js';

/**
 * The single row migration `0010_control_plane_installation` mints.
 *
 * `installation_id` is cast to `text` in the query rather than trusted to
 * arrive as one: the Neon HTTP driver returns a `uuid` column as a string
 * today, and a driver that ever chose another representation would silently
 * turn the comparison a client makes into a comparison of two different
 * shapes. A cast the database performs cannot drift that way.
 */
interface InstallationRow extends Record<string, unknown> {
  readonly installation_id: unknown;
}

/**
 * What this control plane reports as the identity of its database, or `''`.
 *
 * Read once at startup, in the idiom the health dependency report already
 * uses: this is a fact about the database the process was built against, not a
 * per-request measurement, and a query on every unauthenticated
 * `GetCapabilities` would make an unauthenticated endpoint a database load.
 *
 * Empty rather than thrown when the table is not there. A control plane whose
 * schema predates migration 0010 -- a rollback, or a startup whose migration
 * runner was seamed out by a test -- has nothing to report, and refusing to
 * start over a missing identity would take a serving deployment down for a
 * fact that only a client needs. Absent is not the same fact as different, and
 * the client is told the difference: `''` means "cannot compare", and only two
 * non-empty values that disagree mean "not the same database".
 */
export async function readInstallationId(database: SqlClient): Promise<string> {
  let rows: readonly InstallationRow[];
  try {
    rows = await database.query<InstallationRow>({
      text: `SELECT installation_id::text AS installation_id
        FROM control_plane_installation
        WHERE singleton`,
    });
  } catch {
    return '';
  }
  const value = rows[0]?.installation_id;
  return typeof value === 'string' ? value : '';
}
