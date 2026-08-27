import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `moduleUrl` is the file Node was asked to run.
 *
 * Every executable module in this package ends in a block guarded by this, so
 * that importing it -- from a test, from another entry point -- starts no
 * server and exits no process. There is one copy of the rule because there are
 * two guarded entry points now (`server.ts` and `healthcheck.ts`), and a guard
 * written twice is a guard that only gets fixed once.
 *
 * `import.meta.url` is a `file:` URL; `process.argv[1]` is a filesystem path
 * Node has already made absolute. They are compared as paths under the rules of
 * the platform that produced them: the separator differs, and Windows compares
 * case-insensitively where Linux does not.
 *
 * `platform` is a parameter rather than a read of `process.platform` inside the
 * comparison, so one test can prove both shapes from either host. That is not
 * tidiness. The check this replaces folded every `/` to `\` unconditionally,
 * which is right on Windows and wrong for every path on Linux:
 * `file:///app/dist/server.js` became `app\dist\server.js`, which never equals
 * `/app/dist/server.js`. `node dist/server.js` in a Linux container therefore
 * loaded this package, ran no guarded block and exited 0 -- a process that
 * starts, serves nothing, and reports success. Nothing downstream of it can
 * tell that apart from work correctly done.
 */
export function isEntrypoint(
  moduleUrl: string,
  executablePath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (executablePath === undefined || executablePath.length === 0) return false;
  const windows = platform === 'win32';
  const modulePath = fileURLToPath(moduleUrl, { windows });
  // `resolve` normalizes separators and any `.` or `..` segment. It is not
  // asked to make the path absolute -- Node already did -- so it never consults
  // the working directory, which is what lets the Windows rules be applied on a
  // Linux host and the reverse.
  const invokedPath = (windows ? win32 : posix).resolve(executablePath);
  return windows
    ? modulePath.toLocaleLowerCase('en-US') === invokedPath.toLocaleLowerCase('en-US')
    : modulePath === invokedPath;
}
