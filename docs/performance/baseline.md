# Performance baseline

No measurement has been taken yet. Every row below is a budget and a placeholder: the values must be
filled from clean release-candidate builds on the target production machine, and until they are,
this table states an intent and not a baseline. Nothing here is invented.

## Method

Every row is measured the same way, and a value without these five facts recorded beside it is not a
baseline:

- **Build** — which command produced the artifact (`pnpm build:web` or `pnpm build:desktop:web`;
  they differ, and desktop is a static export).
- **Machine** — the target production workstation, named, with its display resolution and scale.
- **Route and fixture** — the exact route measured and the exact fixture loaded.
- **Samples** — how many runs the percentile is taken over, and whether the first run is discarded.
- **Date and commit** — when the run happened and against which commit.

Bundle rows come from `pnpm --filter @gremuchaya/hq analyze`. Nothing in CI produces these numbers;
they are taken by hand during the release rehearsal described in `docs/release/runbook.md`.

| Metric                          | Budget                                                                                  | Initial baseline                                  |
| ------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Cold dev startup                | Report only                                                                             | pending measurement                               |
| Warm dev startup                | Report only                                                                             | pending measurement                               |
| Clean monorepo build            | Report only                                                                             | pending measurement                               |
| Cached monorepo build           | Report only                                                                             | pending measurement                               |
| Display route client bundle     | Report only — no developer chunk                                                        | pending measurement                               |
| Operator route client bundle    | Report only                                                                             | pending measurement                               |
| Preloaded scene switch p95      | < 100 ms                                                                                | pending measurement — no runtime benchmark exists |
| Cue dispatch-to-apply p95       | < 100 ms                                                                                | pending measurement — no runtime benchmark exists |
| Explorer initial index          | No > 50 ms long task at reference fixture                                               | pending measurement                               |
| Screen restore after local boot | < 500 ms excluding media decode                                                         | pending measurement                               |
| Memory after 30 minutes         | No unbounded growth                                                                     | pending long-run test                             |
| Simultaneously decoded video    | Current cue plus configured backgrounds only, with `performance.inactiveDecode` enabled | pending audit                                     |

Neither bundle row is a gate. `pnpm check` contains no size assertion and CI has no size step, so
both are reported and compared by hand until a check exists to enforce them.

Optimization order is architecture/data flow, unnecessary work, IO/preload, code splitting, store
subscriptions, media resource count, bundle imports, compiler behavior, then micro-optimization.
