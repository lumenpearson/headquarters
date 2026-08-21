import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const workspaceRoot = process.cwd();
const generatedRoot = resolve(workspaceRoot, 'packages', 'protocol', 'src', 'gen');

const before = await snapshot(generatedRoot);
runGeneration();
const after = await snapshot(generatedRoot);
const changed = changedFiles(before, after);

if (changed.length > 0) {
  process.stderr.write(
    [
      'Generated Protobuf bindings are stale.',
      ...changed.map((file) => `  - ${file}`),
      'Run: pnpm --filter @gremuchaya/protocol generate',
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Protocol generation verified: checked-in TypeScript bindings are current.\n',
  );
}

async function snapshot(root) {
  const files = await listFiles(root);
  const entries = await Promise.all(
    files.map(async (file) => {
      const content = await readFile(file);
      return [
        normalizePath(relative(root, file)),
        createHash('sha256').update(content).digest('hex'),
      ];
    }),
  );
  return new Map(entries);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat().sort();
}

function runGeneration() {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli === undefined) {
    throw new Error('npm_execpath is unavailable; run this check through pnpm');
  }
  const nativeExecutable = pnpmCli.toLocaleLowerCase('en-US').endsWith('.exe');
  const command = nativeExecutable ? pnpmCli : process.execPath;
  const args = [
    ...(nativeExecutable ? [] : [pnpmCli]),
    '--filter',
    '@gremuchaya/protocol',
    'generate',
  ];
  const generated = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (generated.error !== undefined) throw generated.error;
  if (generated.status !== 0) process.exit(generated.status ?? 1);
}

function changedFiles(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

function normalizePath(path) {
  return path.replaceAll('\\', '/');
}
