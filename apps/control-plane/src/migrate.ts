import { loadControlPlaneConfig } from './config.js';
import { createDatabase, sqlClientFactoryFor } from './db/database.js';
import { runMigrations } from './db/migrations.js';

const config = loadControlPlaneConfig();
const database = createDatabase(config.databaseUrl, sqlClientFactoryFor(config.databaseDriver));

if (!database.configured) {
  throw new Error('HQ_CONTROL_PLANE_DATABASE_URL must be configured before applying migrations');
}

const result = await runMigrations(database);
process.stdout.write(
  `Control-plane migrations complete: applied=${result.applied.join(',') || 'none'} skipped=${result.skipped.join(',') || 'none'}\n`,
);
// The TCP driver holds a connection pool; the HTTP driver holds nothing and has
// no `close`. Ending it deliberately is what makes this script exit the moment
// its work is done, rather than at the pool's idle timeout.
await database.close();
