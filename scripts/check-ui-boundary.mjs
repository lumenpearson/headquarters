import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const allowedRoot = join(workspaceRoot, 'packages', 'ui');
const sourceRoots = [join(workspaceRoot, 'apps'), join(workspaceRoot, 'packages')];
const ignoredDirectories = new Set([
  '.next',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'target',
  'test-results',
]);
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const forbiddenImport = /(?:from\s*|import\s*\()(['"])@base-ui\/react(?:\/[^'"]*)?\1/g;
const directInteractiveControl = /<(?:button|input|select|textarea)\b/gu;

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name))
        files.push(...(await collectSourceFiles(absolutePath)));
      continue;
    }
    if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(absolutePath);
  }

  return files;
}

const importViolations = [];
const controlViolations = [];

for (const sourceRoot of sourceRoots) {
  for (const filePath of await collectSourceFiles(sourceRoot)) {
    if (filePath === allowedRoot || filePath.startsWith(`${allowedRoot}${sep}`)) continue;
    const source = await readFile(filePath, 'utf8');
    const lines = source.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (forbiddenImport.test(line)) {
        importViolations.push(`${relative(workspaceRoot, filePath)}:${index + 1}: ${line.trim()}`);
      }
      forbiddenImport.lastIndex = 0;
      if (extname(filePath) === '.tsx' && directInteractiveControl.test(line)) {
        controlViolations.push(`${relative(workspaceRoot, filePath)}:${index + 1}: ${line.trim()}`);
      }
      directInteractiveControl.lastIndex = 0;
    }
  }
}

if (importViolations.length > 0 || controlViolations.length > 0) {
  process.stderr.write(
    [
      ...(importViolations.length === 0
        ? []
        : [
            'Direct Base UI imports are forbidden outside packages/ui.',
            'Use @gremuchaya/ui/primitives instead.',
            ...importViolations,
          ]),
      ...(controlViolations.length === 0
        ? []
        : [
            'Direct interactive JSX controls are forbidden outside packages/ui.',
            'Use the public Terminal* wrappers instead.',
            ...controlViolations,
          ]),
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    [
      'UI boundary verified: Base UI imports are isolated to packages/ui.',
      'UI boundary verified: interactive JSX controls use public Terminal* wrappers.',
      '',
    ].join('\n'),
  );
}
