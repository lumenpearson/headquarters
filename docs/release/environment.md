# Release environment

Checked on 2026-08-15 in the production development worktree.

| Component            | Detected or pinned version | Policy                                                                |
| -------------------- | -------------------------- | --------------------------------------------------------------------- |
| Node.js              | 24.3.0                     | Pinned LTS runtime; Next.js requires Node 20.9 or newer.              |
| pnpm                 | 10.12.3                    | Pinned in `packageManager`.                                           |
| Corepack             | 0.33.0                     | Development-machine bootstrap only.                                   |
| Next.js              | 16.3.1                     | Exact dependency; App Router and default Turbopack path.              |
| React / React DOM    | 19.2.8                     | Exact application dependencies.                                       |
| TypeScript           | 6.0.3                      | Latest release accepted by `typescript-eslint` 8.67.0.                |
| Zustand              | 5.0.15                     | Exact application dependency.                                         |
| Zod                  | 4.4.3                      | Exact config/runtime validation dependency.                           |
| Turborepo            | 2.10.10                    | Exact root development dependency.                                    |
| Rust                 | 1.88.0                     | Installed stable toolchain.                                           |
| Cargo                | 1.88.0                     | Installed with Rust.                                                  |
| Tauri JavaScript CLI | 2.11.4                     | Project-local dependency; no global CLI is required.                  |
| Tauri Rust crate     | 2.11.5                     | Exact Cargo dependency.                                               |
| Tauri JavaScript API | 2.11.1                     | Exact application dependency.                                         |
| ESLint               | 9.39.5                     | Newest major accepted by every plugin in `eslint-config-next@16.3.1`. |

## Compatibility decision

The registry's newest TypeScript release was 7.0.2, while `typescript-eslint@8.67.0`, used by
`eslint-config-next@16.3.1`, declares `typescript >=4.8.4 <6.1.0`. TypeScript 6.0.3 is therefore
the newest compatible release for this production baseline. See ADR 0007.

The registry's newest ESLint release was 10.8.1, but the React, import and JSX accessibility plugins
bundled by `eslint-config-next@16.3.1` still declare ESLint 9 as their maximum supported major. ESLint
9.39.5 is pinned so the lint baseline has no out-of-range peer dependencies.

The global `cargo tauri` command was not installed. The repository intentionally uses the pinned
workspace CLI through `pnpm tauri`, so release builds do not depend on machine-global JavaScript or
Rust CLI state.
