import { describe, expect, it } from 'vitest';

import { isEntrypoint } from './entrypoint.js';

/*
 * The two shapes are asserted from one host, in both directions, because the
 * regression this guards is exactly a check that was true on the development
 * machine and false in the deployment target. A suite that only exercised the
 * platform it runs on would have passed on Windows throughout the whole life of
 * the defect.
 */
describe('entry-point detection', () => {
  it('matches the module Node was told to run on Linux', () => {
    expect(isEntrypoint('file:///app/dist/server.js', '/app/dist/server.js', 'linux')).toBe(true);
    expect(
      isEntrypoint('file:///app/dist/healthcheck.js', '/app/dist/healthcheck.js', 'linux'),
    ).toBe(true);
  });

  it('matches the module Node was told to run on Windows, case-insensitively', () => {
    expect(
      isEntrypoint('file:///C:/repo/dist/server.js', 'C:\\repo\\dist\\server.js', 'win32'),
    ).toBe(true);
    expect(
      isEntrypoint('file:///C:/Repo/dist/Server.js', 'c:\\repo\\dist\\server.js', 'win32'),
    ).toBe(true);
  });

  /*
   * The whole point of the guard: importing a module must not run it. A sibling
   * in the same directory is the closest miss a real invocation can produce --
   * `node dist/migrate.js` loading `server.js` through an import.
   */
  it('does not match a different module in the same directory', () => {
    expect(isEntrypoint('file:///app/dist/server.js', '/app/dist/migrate.js', 'linux')).toBe(false);
    expect(
      isEntrypoint('file:///C:/repo/dist/server.js', 'C:\\repo\\dist\\migrate.js', 'win32'),
    ).toBe(false);
  });

  /*
   * Case matters on Linux and does not on Windows. Asserting both is what stops
   * a future simplification to one case-folding rule for both platforms, which
   * would make `/app/dist/Server.js` and `/app/dist/server.js` -- two files that
   * can coexist on ext4 -- the same entry point.
   */
  it('keeps case significant on Linux and insignificant on Windows', () => {
    expect(isEntrypoint('file:///app/dist/Server.js', '/app/dist/server.js', 'linux')).toBe(false);
  });

  it('normalizes redundant segments rather than comparing raw text', () => {
    expect(isEntrypoint('file:///app/dist/server.js', '/app/./dist/server.js', 'linux')).toBe(true);
    expect(
      isEntrypoint(
        'file:///C:/repo/dist/server.js',
        'C:\\repo\\build\\..\\dist\\server.js',
        'win32',
      ),
    ).toBe(true);
  });

  /*
   * `process.argv[1]` is absent when Node was started with `--eval`, and empty
   * when a launcher passes a placeholder. Neither is this module, and both must
   * fail closed rather than throw out of a top-level guard.
   */
  it('fails closed when Node was given no script at all', () => {
    expect(isEntrypoint('file:///app/dist/server.js', undefined, 'linux')).toBe(false);
    expect(isEntrypoint('file:///app/dist/server.js', '', 'linux')).toBe(false);
  });
});
