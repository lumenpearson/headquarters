/**
 * Relocates shadcn/ui components into `packages/ui`.
 *
 * The shadcn CLI resolves its `ui`/`lib`/`hooks` aliases through the host
 * package's own exports, so it can only write into `apps/hq`. That is the one
 * place these components must not live: they render raw `<button>`/`<input>`
 * elements and import `@base-ui/react` directly, both of which
 * `scripts/check-ui-boundary.mjs` rejects outside `packages/ui`.
 *
 * So the CLI writes to its natural staging directory and this script moves the
 * result, rewriting the `@/…` aliases to relative specifiers. Relative imports
 * matter: an alias would survive into `packages/ui/dist` and fail to resolve
 * for any consumer, because only `apps/hq/tsconfig.json` knows about `@/*`.
 *
 * Run through `pnpm ui:add <component>`, which chains the CLI and this script.
 */
import { readdir, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const stagingRoot = join(workspaceRoot, 'apps', 'hq', 'src', 'components', 'ui');
const destinationRoot = join(workspaceRoot, 'packages', 'ui', 'src', 'shadcn');
const componentAlias = /(['"])@\/components\/ui\/([^'"]+)\1/g;
const utilsAlias = /(['"])@\/lib\/utils\1/g;
const sourceExtensions = new Set(['.ts', '.tsx']);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
      continue;
    }
    if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

/**
 * Rewrites the host app's path aliases to specifiers that stay valid once the
 * file is compiled into `packages/ui/dist`.
 */
function rewriteAliases(source, fileDirectoryDepth) {
  const upward = fileDirectoryDepth === 0 ? './' : '../'.repeat(fileDirectoryDepth);
  return source
    .replace(componentAlias, (_match, quote, target) => `${quote}${upward}${target}.js${quote}`)
    .replace(utilsAlias, (_match, quote) => `${quote}${upward}utils.js${quote}`);
}

if (!existsSync(stagingRoot)) {
  process.stdout.write('sync-shadcn: nothing staged in apps/hq/src/components/ui.\n');
  process.exit(0);
}

const moved = [];
for (const filePath of await collectFiles(stagingRoot)) {
  const relativePath = relative(stagingRoot, filePath);
  const destination = join(destinationRoot, relativePath);
  await mkdir(join(destination, '..'), { recursive: true });

  if (sourceExtensions.has(extname(filePath))) {
    const depth = relativePath.split(/[\\/]/u).length - 1;
    await writeFile(destination, rewriteAliases(await readFile(filePath, 'utf8'), depth), 'utf8');
  } else {
    await writeFile(destination, await readFile(filePath));
  }
  moved.push(relativePath.replace(/\\/gu, '/'));
}

// The staging directory must not survive: a leftover copy would reintroduce the
// very boundary violation this script exists to prevent.
await rm(stagingRoot, { recursive: true, force: true });
const componentsRoot = join(workspaceRoot, 'apps', 'hq', 'src', 'components');
if (existsSync(componentsRoot) && (await readdir(componentsRoot)).length === 0) {
  await rm(componentsRoot, { recursive: true, force: true });
}

// Re-export every relocated component so consumers import from one entry point.
const entryPoints = moved
  .filter((name) => /\.tsx?$/u.test(name))
  .filter((name) => !name.startsWith('hooks/') && name !== 'index.ts')
  .map((name) => name.replace(/\.tsx?$/u, '.js'))
  .sort();

if (entryPoints.length > 0) {
  const indexPath = join(destinationRoot, 'index.ts');
  const existing = await readFile(indexPath, 'utf8');
  const missing = entryPoints
    .map((name) => `export * from './${name}';`)
    .filter((line) => !existing.includes(line));
  if (missing.length > 0) {
    await writeFile(indexPath, `${existing.trimEnd()}\n${missing.join('\n')}\n`, 'utf8');
  }
}

process.stdout.write(
  moved.length === 0
    ? 'sync-shadcn: nothing to move.\n'
    : `sync-shadcn: moved ${moved.length.toString()} file(s) into packages/ui/src/shadcn:\n${moved
        .map((name) => `  ${name}`)
        .join('\n')}\n`,
);
