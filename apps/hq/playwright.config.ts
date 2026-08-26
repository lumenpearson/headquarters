import { defineConfig, devices } from '@playwright/test';

/*
 * Measured on this repository's own suite, 139 tests, against the production
 * server: one worker takes 4.2 minutes, two take 1.5, four take 1.2. Nothing
 * about these tests needs a worker to itself -- each gets its own browser
 * context, and the application under test keeps no server-side state a second
 * context could disturb -- so the serial run was paying for isolation it
 * already had.
 *
 * Two in CI rather than four: the runner has four vCPUs and the Next server
 * shares them with the browsers, so the third and fourth worker would compete
 * with the process serving them.
 */
const workers = process.env.CI ? 2 : 4;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // `github` annotates the failing line in the pull request; `list` is what a
  // person reads in a terminal.
  reporter: process.env.CI
    ? [['github' as const], ['html' as const, { open: 'never' }]]
    : [['list' as const], ['html' as const, { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    /*
     * Tests run as a returning operator, not as a first launch: R11 shows the
     * keybind card the very first time the application is opened, and every
     * test that is not about onboarding would otherwise start behind it.
     *
     * The onboarding test opts back out with `test.use({ storageState: ... })`,
     * which is the one place a first launch should be simulated.
     */
    storageState: './tests/returning-operator.storage.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    /*
     * The built application in CI, the dev server locally.
     *
     * `next dev` compiles a route the first time something asks for it, so a
     * suite that visits sixteen routes pays sixteen compilations while the
     * browsers wait -- measured here as 1.9 minutes against the dev server
     * versus 1.2 against `next start`, with the same four workers. Locally the
     * dev server is still the right default: it is already running, and
     * `reuseExistingServer` picks it up instead of building.
     */
    command: process.env.CI ? 'pnpm --filter @gremuchaya/hq start' : 'pnpm dev',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
