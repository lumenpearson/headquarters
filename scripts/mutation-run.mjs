// A repeatable mutation-testing tool (plan rules 2.3/2.4): applies a small,
// declared set of mutants -- each one exact source string replaced by
// another -- runs the vitest files the mutant is supposed to break, and
// reports which mutants a reader can call "killed" versus "survived".
//
// Every "N mutants, zero survivors" claim in this repository used to be a
// manual procedure nobody after the fact could repeat. This script is that
// procedure, made mechanical: a spec file (see scripts/mutants/*.json for the
// format and scripts/mutants/README.md for worked examples) names a file, an
// exact `find` string that must occur exactly once, a `replace` string, and
// the vitest files expected to fail once the replacement lands. The tool
// mutates the file on disk, runs those tests, and restores the original file
// byte for byte on every exit path this process can act on: the ordinary
// finish, a thrown error, and SIGINT/SIGTERM/SIGHUP (a handler restores and
// re-raises; a signal arriving while the child test run blocks the loop is
// handled the moment it returns, and the `finally` restore runs either way).
// The one boundary is SIGKILL, which no process can intercept -- after one,
// `git diff` the mutant's file before trusting the tree. Nothing here uses
// `git`: restoration is a saved copy of the one touched file, not a
// checkout, so it works inside a dirty tree mid-edit by another agent and
// never touches a file this tool did not itself change.
//
// Usage (through pnpm -- the runner resolves vitest via npm_execpath, so a
// bare `node scripts/mutation-run.mjs` refuses to run):
//   pnpm mutation:run <spec.json> [<spec2.json> ...]
//   pnpm mutation:run scripts/mutants/wave-c9-example.json --only=m1,m3
//   pnpm mutation:run scripts/mutants/wave-c9-example.json --skip-baseline
//
// Exit code is 0 when every selected mutant was killed and, where the spec
// named expectedKillingTests, exactly those tests (or a superset the report
// prints explicitly) are among the failures; 1 otherwise. A survived mutant,
// a baseline that does not pass unmutated, and a mutated run that failed
// without a single named failing test (the file no longer parses, so nothing
// ran -- that is a broken mutant, not evidence) are all reported as failures
// of the *tool*, not swallowed -- the discipline this exists to serve says a
// mutant with no failing test is a vacuous test, not a clean pass.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, sep } from 'node:path';

const workspaceRoot = process.cwd();

/**
 * The one file currently holding a mutant, with its original bytes. Restored
 * by the `finally` in the loop, by the signal handlers below, and by the
 * `exit` hook as the last belt -- whichever runs first clears it, so the
 * others become no-ops.
 */
let pendingRestore = null;

function restorePending() {
  if (pendingRestore === null) return;
  const { file, original } = pendingRestore;
  pendingRestore = null;
  try {
    writeFileSync(file, original);
  } catch (error) {
    console.error(
      `FAILED TO RESTORE ${file} -- the mutant is still on disk: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restorePending();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}
process.on('exit', restorePending);

const args = process.argv.slice(2);
const specPaths = [];
let only = null;
let skipBaseline = false;
for (const arg of args) {
  if (arg === '--skip-baseline') {
    skipBaseline = true;
  } else if (arg.startsWith('--only=')) {
    only = new Set(
      arg
        .slice('--only='.length)
        .split(',')
        .filter((id) => id.length > 0),
    );
  } else if (arg.startsWith('--')) {
    fail(`unknown flag: ${arg}`);
  } else {
    specPaths.push(arg);
  }
}
if (specPaths.length === 0) {
  fail('usage: pnpm mutation:run <spec.json> [...] [--only=id,id] [--skip-baseline]');
}

/** @type {Array<{id: string, description?: string, package: string, file: string, find: string, replace: string, testFiles: string[], expectedKillingTests?: string[]}>} */
const mutants = [];
for (const specPath of specPaths) {
  const raw = readFileSync(resolve(workspaceRoot, specPath), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${specPath}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(parsed)) fail(`${specPath}: expected a JSON array of mutants`);
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`${specPath}: every mutant must be a JSON object`);
    }
    for (const required of ['id', 'package', 'file', 'find', 'replace']) {
      if (typeof entry[required] !== 'string' || entry[required].length === 0) {
        fail(`${specPath}: mutant field "${required}" must be a non-empty string`);
      }
    }
    if (
      !Array.isArray(entry.testFiles) ||
      entry.testFiles.length === 0 ||
      entry.testFiles.some((testFile) => typeof testFile !== 'string')
    ) {
      fail(`${specPath}: mutant "${entry.id}" needs testFiles as a non-empty string array`);
    }
    // The tool writes the file a spec names, so the spec must not be able to
    // name one outside this repository: no absolute paths, no `..` climbing.
    const resolvedTarget = resolve(workspaceRoot, entry.file);
    if (!resolvedTarget.startsWith(workspaceRoot + sep)) {
      fail(`${specPath}: mutant "${entry.id}" names a file outside the workspace: ${entry.file}`);
    }
    mutants.push({ ...entry, specPath });
  }
}

const selected = only === null ? mutants : mutants.filter((mutant) => only.has(mutant.id));
if (selected.length === 0) fail('no mutants selected (check --only against the spec ids)');
const unknownOnly =
  only === null ? [] : [...only].filter((id) => !mutants.some((mutant) => mutant.id === id));
if (unknownOnly.length > 0)
  fail(`--only named ids not present in any spec: ${unknownOnly.join(', ')}`);

/**
 * `pnpm --filter <package> exec vitest run <files>`, run from the workspace
 * root, so a mutant's `testFiles` are package-root-relative paths (the same
 * shape as CLAUDE.md's one-file example,
 * `pnpm --filter @gremuchaya/hq test -- src/state/someSlice.test.ts`).
 * `exec vitest run` rather than the `test --` form that example uses:
 * routing the file argument through the package's own `test` script (a bare
 * `vitest run`) leaves pnpm inserting a literal `--` ahead of it, which
 * vitest does not treat as a file filter -- the whole suite runs instead of
 * the one file. `exec` hands vitest the argument directly.
 */
function runVitest(mutant) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli === undefined)
    throw new Error('npm_execpath is unavailable; run this script through pnpm');
  const nativeExecutable = pnpmCli.toLocaleLowerCase('en-US').endsWith('.exe');
  const command = nativeExecutable ? pnpmCli : process.execPath;
  const args = [
    ...(nativeExecutable ? [] : [pnpmCli]),
    '--filter',
    mutant.package,
    'exec',
    'vitest',
    'run',
    ...mutant.testFiles,
  ];
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { exitCode: result.status ?? 1, output };
}

/**
 * Only `×` lines -- vitest's per-test failure marker -- count as failing
 * tests. A file-level `FAIL path [ path ]` line appears both when tests in
 * the file fail and when the file no longer parses at all, so counting it
 * would let a mutant that broke the parse masquerade as killed; a mutated
 * run with a non-zero exit and not one `×` line is a collection error.
 */
function failingTestNames(output) {
  return [
    ...new Set(
      output
        .split('\n')
        .filter((line) => /^\s*×\s/u.test(line))
        .map((line) => line.replace(/^\s*×\s*/u, '').trim())
        .filter((line) => line.length > 0),
    ),
  ];
}

function summaryLine(output) {
  return output
    .split('\n')
    .filter((line) => line.includes('Test Files') || line.trimStart().startsWith('Tests '))
    .join(' | ');
}

console.log(
  `Mutation run: ${selected.length} mutant(s) selected from ${specPaths.length} spec file(s).\n`,
);

let allKilled = true;
const report = [];

for (const mutant of selected) {
  const file = resolve(workspaceRoot, mutant.file);
  console.log(`### ${mutant.id}${mutant.description ? ` -- ${mutant.description}` : ''}`);
  console.log(`    file: ${mutant.file}`);

  if (!skipBaseline) {
    const baseline = runVitest(mutant);
    if (baseline.exitCode !== 0) {
      console.log(
        `    BASELINE FAILED before any mutation -- this mutant proves nothing until the suite is green unmutated.`,
      );
      console.log(`    ${summaryLine(baseline.output)}`);
      allKilled = false;
      report.push({ id: mutant.id, outcome: 'baseline-red' });
      console.log('');
      continue;
    }
    console.log(`    baseline: ${summaryLine(baseline.output)} (green)`);
  }

  const original = readFileSync(file, 'utf8');
  const occurrences = original.split(mutant.find).length - 1;
  if (occurrences === 0) {
    console.log(
      `    ANCHOR NOT FOUND -- the "find" string no longer occurs in ${mutant.file}. Spec is stale.`,
    );
    allKilled = false;
    report.push({ id: mutant.id, outcome: 'anchor-not-found' });
    console.log('');
    continue;
  }
  if (occurrences > 1) {
    console.log(
      `    AMBIGUOUS ANCHOR -- "find" occurs ${occurrences} times in ${mutant.file}; narrow it to exactly one.`,
    );
    allKilled = false;
    report.push({ id: mutant.id, outcome: 'ambiguous-anchor' });
    console.log('');
    continue;
  }

  let mutantRun;
  pendingRestore = { file, original };
  try {
    // The replacement callback keeps `replace` literal: the string form of
    // `String.replace` expands `$&`, `$'` and `$$` in its second argument,
    // which would write bytes nobody declared into a file full of SQL
    // dollar-quoting or template literals.
    writeFileSync(
      file,
      original.replace(mutant.find, () => mutant.replace),
    );
    mutantRun = runVitest(mutant);
  } finally {
    // Restored on the ordinary path and on a thrown error; the signal
    // handlers and the `exit` hook above cover an interrupt, and whichever
    // runs first clears `pendingRestore` for the rest. This is a
    // copy/restore of the one file this mutant names, never a git operation,
    // so it is safe to run inside a tree another agent is actively editing.
    restorePending();
  }

  const failing = failingTestNames(mutantRun.output);
  if (mutantRun.exitCode !== 0 && failing.length === 0) {
    // Non-zero exit with not one named failing test is vitest failing to
    // collect at all -- the mutant broke the parse, so no test ever judged
    // it. Calling that "killed" would launder a broken mutant into evidence.
    console.log(
      `    NO TEST RAN -- the mutated run failed without a single failing test (collection error). Fix the mutant.`,
    );
    console.log(`    ${summaryLine(mutantRun.output)}`);
    allKilled = false;
    report.push({ id: mutant.id, outcome: 'collection-error' });
    console.log('');
    continue;
  }
  const killed = mutantRun.exitCode !== 0;
  console.log(
    `    mutated: ${summaryLine(mutantRun.output)} (${killed ? 'RED -- killed' : 'GREEN -- SURVIVED'})`,
  );
  for (const line of failing) console.log(`      × ${line}`);

  let matchedExpectations = true;
  if (
    killed &&
    Array.isArray(mutant.expectedKillingTests) &&
    mutant.expectedKillingTests.length > 0
  ) {
    const unmatched = mutant.expectedKillingTests.filter(
      (expected) => !failing.some((line) => line.includes(expected)),
    );
    if (unmatched.length > 0) {
      matchedExpectations = false;
      console.log(
        `    EXPECTATION MISMATCH -- expected among the failures, not seen: ${unmatched.join(' | ')}`,
      );
    }
    const unexpected = failing.filter(
      (line) => !mutant.expectedKillingTests.some((expected) => line.includes(expected)),
    );
    if (unexpected.length > 0) {
      console.log(
        `    (also failing, not named as expected -- wider blast radius than declared): ${unexpected.join(' | ')}`,
      );
    }
  }

  if (!killed || !matchedExpectations) allKilled = false;
  report.push({
    id: mutant.id,
    outcome: killed ? (matchedExpectations ? 'killed' : 'killed-unexpected-tests') : 'survived',
    failing,
  });
  console.log('');
}

console.log('--- summary ---');
for (const entry of report) {
  console.log(`${entry.id}: ${entry.outcome}`);
}
console.log(
  allKilled
    ? '\nAll selected mutants killed.'
    : '\nAt least one mutant did not confirm as killed -- see above.',
);

process.exitCode = allKilled ? 0 : 1;

function fail(message) {
  console.error(message);
  process.exit(2);
}
