import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/*
 * The compiled `@gremuchaya/protocol` must be loadable by `node` itself.
 *
 * This package is the only one that runs the compiled output directly:
 * `pnpm control-plane` is `node dist/server.js`, and the container image's CMD
 * is the same command. Every other consumer reaches the bindings through a
 * bundler or a TypeScript loader -- `apps/hq` through Next, the suites through
 * Vite, `pnpm dev` through tsx -- and all of those resolve an extensionless
 * relative specifier that Node's ESM resolver rejects.
 *
 * That is not hypothetical. `protoc-gen-es` defaults to
 * `import_extension=none`, TypeScript accepts it under
 * `moduleResolution: Bundler`, and the built package was therefore unloadable
 * by `node` while 414 tests, two typecheckers and a production web build all
 * passed: `await import('./dist/index.js')` failed with `ERR_MODULE_NOT_FOUND`
 * on `gen/gremuchaya/common/v1/common_pb`. `packages/protocol/buf.gen.yaml`
 * now sets `import_extension=js`, and this is what fails if it is ever dropped.
 *
 * It asserts against the compiled artefact rather than the generated source,
 * because the artefact is what Node loads. Nothing here needs a build step of
 * its own: every other suite in this package imports `@gremuchaya/protocol`
 * through the same `exports` entry, so a missing `dist` fails the whole package
 * long before this file runs.
 */
describe('compiled protocol bindings', () => {
  it('write relative imports that Node can resolve', async () => {
    const offenders: string[] = [];

    for (const file of await listJavaScript(generatedRoot())) {
      for (const specifier of relativeSpecifiers(await readFile(file, 'utf8'))) {
        if (specifier.endsWith('.js')) continue;
        offenders.push(`${normalize(relative(generatedRoot(), file))}: ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  /*
   * A check that found nothing to check would pass for the wrong reason: an
   * empty directory and a specifier syntax the pattern stopped matching both
   * read as success. This is the witness that it is looking at something.
   */
  it('has bindings and relative imports to check in the first place', async () => {
    const files = await listJavaScript(generatedRoot());
    const specifiers = (
      await Promise.all(files.map(async (file) => relativeSpecifiers(await readFile(file, 'utf8'))))
    ).flat();

    // Nine versioned packages: bridge, common, control, integration, material,
    // realtime, settings, sync and telemetry.
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(specifiers.length).toBeGreaterThan(0);
  });
});

/**
 * The generated tree this repository ships, named by its place in the
 * workspace rather than by module resolution.
 *
 * Module resolution would be the more elegant expression and the wrong
 * question: it answers "whichever copy of the package this process happens to
 * link against", which in a worktree with a linked `node_modules` can be a
 * different checkout entirely. What has to be Node-loadable is the artefact
 * built from the sources next to this file.
 */
function generatedRoot(): string {
  return fileURLToPath(new URL('../../../packages/protocol/dist/gen', import.meta.url));
}

async function listJavaScript(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listJavaScript(path);
      return entry.name.endsWith('.js') ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

/** Static `import ... from '…'` and `export ... from '…'` specifiers only. */
function relativeSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["'](\.[^"']*)["']/gu)].map((match) => match[1] ?? '');
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/');
}
