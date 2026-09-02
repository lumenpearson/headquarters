# Mutation spec format

`pnpm mutation:run <spec.json> [...] [--only=id,id] [--skip-baseline]` reads
one or more JSON files, each an array of mutant declarations. Through pnpm
only: the runner resolves vitest via `npm_execpath`, so a bare
`node scripts/mutation-run.mjs` refuses to run.

```json
[
  {
    "id": "short-stable-id",
    "description": "optional, one line, what the mutant removes and which behaviour it should break",
    "package": "@gremuchaya/hq",
    "file": "apps/hq/src/components/sync/ControlPlaneRuntime.tsx",
    "find": "the exact source substring to replace -- must occur exactly once in the file",
    "replace": "what to replace it with",
    "testFiles": ["src/components/sync/ControlPlaneRuntime.test.tsx"],
    "expectedKillingTests": ["a substring of the test name expected to fail"]
  }
]
```

- `file` is workspace-root-relative. `testFiles` are package-root-relative,
  the same shape as CLAUDE.md's own one-file example.
- `find` must be unique in the file. The tool refuses an anchor that occurs
  zero or more than once, rather than mutating the wrong occurrence or every
  occurrence at once.
- `expectedKillingTests` is optional. When given, the tool checks each named
  substring appears among the actually-failing test lines, and separately
  reports any failure not named -- a wider blast radius than declared, which
  is worth knowing even when the mutant is still correctly killed.
- The tool restores the mutated file from an in-memory copy on the ordinary
  finish, on a thrown error, and on SIGINT/SIGTERM/SIGHUP (a handler restores
  and re-raises). SIGKILL is the one path no process can act on -- after one,
  `git diff` the mutant's file before trusting the tree. It never runs `git`.
- A mutated run that exits non-zero without one named failing test is
  reported as `collection-error`, not as a kill: it means the mutant broke
  the parse and vitest collected nothing, so no test ever judged it.
- By default each mutant runs a baseline pass (the same tests, unmutated)
  first; a baseline that is not green makes the mutant's result meaningless
  and is reported as `baseline-red` rather than silently treated as a kill.
  `--skip-baseline` turns this off for a faster re-run once the baseline is
  known good.

`wave-c9-example.json` in this directory holds three real mutants taken from
this branch's own history, each backed by a test that already exists in the
tree (no test was added to make these pass):

- `plane-failover-admitted-guard` / `plane-failover-device-lifecycle-guard` --
  the two guards in `attemptPlaneFailover`
  (`apps/hq/src/components/sync/ControlPlaneRuntime.tsx`, commit `d467336`)
  that keep the failover from promoting a plane already known to answer for a
  different database, or one started without device lifecycle.
- `remote-content-transition-ledger-guard` -- `remoteContentTransition`'s
  guard (`apps/hq/src/state/operationsStore.ts`, commit `854ae28`) that only
  appends an undo-ledger entry when a peer's content snapshot actually changed
  something; disabling it reintroduces the exact regression R4's tail names --
  a local undo silently discarding a neighbour's edit.

Run `pnpm mutation:run scripts/mutants/wave-c9-example.json` to reproduce.
