# Performance baseline

Measurements are recorded from clean release-candidate builds. Values marked `pending measurement`
must be filled by the release workflow on the target production machine; they are not invented.

| Metric                          | Budget                                       | Initial baseline             |
| ------------------------------- | -------------------------------------------- | ---------------------------- |
| Cold dev startup                | Report only                                  | pending measurement          |
| Warm dev startup                | Report only                                  | pending measurement          |
| Clean monorepo build            | Report only                                  | pending measurement          |
| Cached monorepo build           | Report only                                  | pending measurement          |
| Display route client bundle     | No developer chunk                           | pending measurement          |
| Operator route client bundle    | Regression gate                              | pending measurement          |
| Preloaded scene switch p95      | < 100 ms                                     | covered by runtime benchmark |
| Cue dispatch-to-apply p95       | < 100 ms                                     | covered by runtime benchmark |
| Explorer initial index          | No > 50 ms long task at reference fixture    | pending measurement          |
| Screen restore after local boot | < 500 ms excluding media decode              | pending measurement          |
| Memory after 30 minutes         | No unbounded growth                          | pending long-run test        |
| Simultaneously decoded video    | Current cue plus configured backgrounds only | pending audit                |

Optimization order is architecture/data flow, unnecessary work, IO/preload, code splitting, store
subscriptions, media resource count, bundle imports, compiler behavior, then micro-optimization.
