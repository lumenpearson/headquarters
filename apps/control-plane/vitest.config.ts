import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Vitest does not read `.env`, and the opt-in PostgreSQL suite is gated on
// HQ_CONTROL_PLANE_TEST_DATABASE_URL. Loading the same file the server and the
// migrator read -- with Node's own parser, so it cannot disagree with
// `--env-file-if-exists` -- keeps local configuration meaning one thing.
// This runs in the Vitest main process, whose `process.env` the workers inherit.
const envFile = fileURLToPath(new URL('.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
