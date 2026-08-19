import { loadControlPlaneConfig } from './config.js';
import { createNeonDatabase } from './db/database.js';
import { runMigrations } from './db/migrations.js';

const config = loadControlPlaneConfig();
const database = createNeonDatabase(config.databaseUrl);

if (!database.configured) {
  throw new Error('HQ_CONTROL_PLANE_DATABASE_URL must be configured before applying migrations');
}

const result = await runMigrations(database);
process.stdout.write(
  `Control-plane migrations complete: applied=${result.applied.join(',') || 'none'} skipped=${result.skipped.join(',') || 'none'}\n`,
);
