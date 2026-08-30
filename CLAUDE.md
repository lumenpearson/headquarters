# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

"Гремучая смесь — Оперативный штаб" (`gremuchaya-hq`) is a local-first operational dashboard for a
film shoot: a normalized world of sectors, objects, cases, materials, comms channels and simulated
events, driven by a deterministic scene/cue engine. It ships as a Next.js web app and a Tauri 2
desktop shell (static export, offline-first). **In-app content and the README are Russian; code,
identifiers and comments are English.**

pnpm + Turborepo monorepo: `apps/{hq,control-plane,file-bridge}`, `packages/{domain,config,protocol,
ui,layout-engine,settings-schema,test-fixtures}`.

## Commands

Node 24.3+, pnpm 10.12.3+ (`.tool-versions`, `.nvmrc` and `packageManager` pin the same versions;
`packageManager` wins if they disagree), Rust 1.88+ for desktop builds, ffmpeg on PATH or
`HQ_FFMPEG_PATH` for the native RTSP gateway. Primary target is Windows (NSIS, WebView2); commands
are PowerShell-oriented. Setup: `corepack enable && pnpm install`.

- `dev:hq` (Next alone, `127.0.0.1:3000`) · `dev:full` (+ bridge + control-plane) · `dev` (all)
- `build` / `build:web` / `build:desktop:web` — Turbo, web target, Tauri static-export target
- `typecheck` / `lint` / `format` / `format:check` — across all packages
- `test` (Vitest) · `test:ui` (Playwright for `apps/hq`, starts its own server) · `test:cargo` (Rust)
- **`check`** — the local gate: UI boundary, protocol freshness, lint, typecheck, test, build
- **`check:release`** — `check` + `test:ui` + `build:offline` + `test:cargo`; the shoot-day gate
  (`docs/release/runbook.md`)

One file: `pnpm --filter @gremuchaya/hq test -- src/state/x.test.ts` (same shape elsewhere).

- **Protobuf codegen** after any `.proto` edit, or `check:protocol-generation` fails:
  `pnpm --filter @gremuchaya/protocol generate`
- **Migrations:** `pnpm --filter @gremuchaya/control-plane migrate`
- **Self-hosted control plane:** `node scripts/generate-env.mjs` then `docker compose up -d --build
--wait` (`docs/release/self-hosting.md`; the generator prints variable names, never values)
- **Packaging:** `pnpm tauri:build` (NSIS installer under
  `apps/hq/src-tauri/target/release/bundle/nsis/`); `cargo check --manifest-path
apps/hq/src-tauri/Cargo.toml` for a Rust-only check.

## Architecture

Dependency direction — **presentation → application → domain**, with infrastructure (browser,
bridge and Tauri adapters) implementing domain and application ports. Canonical summary in
`docs/architecture/dependency-map.md`; read it first for anything cross-cutting.

Package ownership:

- `@gremuchaya/domain` — framework-free models, state machines, errors, paths, ports, and the
  shared simulation-curve evaluator.
- `@gremuchaya/config` — Zod trust-boundary schemas, parsers, scene validation. No migrations: the
  only ones are the immutable constants in `apps/control-plane/src/db/migrations.ts`.
- `@gremuchaya/protocol` — generated Protobuf (`gremuchaya.*.v1`) and service descriptors; no
  runtime policy or UI code.
- `@gremuchaya/ui` — design tokens and scene-agnostic `Terminal*` primitives over Base UI.
- `@gremuchaya/layout-engine` — deterministic bounded tile packing and overflow policy.
- `@gremuchaya/settings-schema` — the `SettingDefinition` registry and draft validation.
- `@gremuchaya/test-fixtures` — deterministic test data, excluded from production imports.
- `apps/hq` — composition root: Next.js 16, React 19, Tauri 2 shell, Zustand runtime, application
  services, adapters, and all UI/scene/screen code.
- `apps/file-bridge` — localhost-only, read-only-by-default gRPC-Web file projection and watcher,
  with canonical-path traversal/symlink-escape protection.
- `apps/control-plane` — Node ConnectRPC: health/capabilities, durable paired-device auth, realtime
  hub over WebSocket, Neon and Upstash adapters.
- `apps/hq/src-tauri` — native Rust: monitor/window management, file watcher, read-only projection.

State ownership:

- Zustand holds the runtime in `state/operationsStore.ts` — `OperationsUiState`,
  `ProductionState`, `PersonalizationState`, plus `content`, `connection` and `materials` —
  composed into one `OperationsState`, alongside a small `appStore.ts`. It is one store with
  named regions, not per-domain slice files; a plan that assumes separate slice modules
  describes a target, not the code.
- Scene definitions (52 Zod-validated scenes) are immutable configuration, not runtime state.
- `localStorage` owns everything the browser persists, under eleven keys:
  `gremuchaya-hq:operations:v3`, `…:production-snapshots:v3`, `…:snapshots:v1`,
  `…:device-session:v3` (the paired session, refresh token included; scoped by database, not by
  address, so every configured plane of the group takes it), `…:device-identity:v1` (the
  device's ECDSA P-256 identity keypair, both halves in clear text on the same stated trade-off
  as the refresh token; its public half is what pairing presents as `public_key`, which the
  control plane refuses empty, and the key grants nothing by itself), `…:group-mirror:v1` (the group's
  cloud state, staged under `…:draft` first), `…:control-plane-address:v1` (the operator's
  in-app control-plane address list, scoped to the device), `hq.camera-material-assignments.v1`,
  `hq.keybinds-intro-seen.v1`, `hq.material-annotations.v1` (timestamped notes on a material in
  the local player surface, local to this browser -- there is no `MaterialAnnotation` RPC), and
  the Yandex Maps key. No IndexedDB, no Tauri store plugin.
- Application services perform all IO and cross-region transitions; components dispatch use
  cases and select narrow state.

### Enforced boundaries (CI scripts, not convention)

Both run inside `pnpm check`, from `scripts/`:

- `check-ui-boundary.mjs` — fails if a file outside `packages/ui` imports `@base-ui/react` or uses a
  raw `<button>/<input>/<select>/<textarea>`. Use the `Terminal*` wrappers everywhere else.
- `check-protocol-generation.mjs` — regenerates `packages/protocol/src/gen` and diffs it against the
  committed tree; stale bindings fail. Regenerate and commit after touching a `.proto`.

### Protocol / RPC surface

Versioned contracts under `packages/protocol/proto/gremuchaya/*/v1/*.proto` (nine packages),
generated by buf into `packages/protocol/src/gen`. Transport is **ConnectRPC over binary gRPC-Web
only** — no REST, no native gRPC, no ad hoc JSON (ADR 0003, 0008). `ControlPlaneService` is always
registered; every other service is wired only when its collaborator exists, so a control plane
without durable auth config starts in a reduced health-only mode and `getCapabilities` says so.
The realtime hub revalidates an admitted socket on a timer rather than per message.

### Local-first / offline-first design

The desktop build is `output: 'export'` plus Tauri adapters — no Node server at runtime (ADR 0005).
Multi-window sync goes through a typed screen-bus port: Tauri events on desktop, `BroadcastChannel`
with a `storage` fallback on web, chosen over WebSockets so cue execution needs no server (ADR 0001).
`/screen/:id`, `/wall/:id` and `/scene/:id` are statically generated: Tauri has no dynamic routing
fallback (ADR 0006).

### File access model

A three-tier virtual filesystem (ADR 0002): the browser File System Access API, the localhost
file-bridge (opt-in, read-only by default — ADR 0003) and native Tauri roots. Four `FileSourcePort`
adapters are merged by `ExplorerService.list` behind branded virtual paths, so physical paths never
reach the UI; a real node shadows an emulated one at the same virtual path.

### Further reading

- `docs/architecture/dependency-map.md` — canonical layering summary
- `docs/adr/0001`–`0009` — screen bus, virtual filesystem, file bridge, information state machines,
  offline-first runtime, static route generation, toolchain pinning, contracts, two RPC adapters
- `docs/release/{environment,runbook,known-limitations}.md` — pinned versions, shoot-day procedure,
  and what is deliberately not built yet
- `docs/plans/actual_plan.md` — the one plan (see Notes)
- `docs/plans/history.md` — the plan's historical annex: proven history, correction texts, journal

## Delegation: one agent per task

Seven agents in `.claude/agents/`. **Route work to the agent that owns the area rather than doing
it inline:** the layering above is wide enough that one context reading every package reads none
carefully — which is how `CompositeFileSource` stayed in three documents for months after it
stopped existing.

| Agent               | Owns                                                                         | Writes code |
| ------------------- | ---------------------------------------------------------------------------- | ----------- |
| `architect`         | Where a capability belongs, layering, refactor order, ADRs, plan checkpoints | no          |
| `ui-engineer`       | `apps/hq` presentation, `packages/ui`, `layout-engine`, store, tokens/CSS    | yes         |
| `scene-engineer`    | Scene/cue engine, the 52 scenes, `config` schemas, `domain` state machines   | yes         |
| `protocol-engineer` | `.proto`, `apps/control-plane`, `apps/file-bridge`, tokens, migrations, hub  | yes         |
| `desktop-engineer`  | `apps/hq/src-tauri`, Tauri config/commands, NSIS/WebView2, watcher, gateway  | yes         |
| `tester`            | Vitest, Playwright, cargo, and whether a test proves what it claims          | yes         |
| `reviewer`          | Correctness, security, the enforced boundaries — before a commit or PR       | no          |

- **One agent per task, matched to the area.** A task spanning `apps/hq` and
  `apps/control-plane` is two delegations, not one wide brief.
- **Independent tasks go out in one message** so they run concurrently; dependent ones wait.
- **`architect` before code** when the question is "where does this live", not after.
- **`reviewer` before committing** anything touching credentials, SQL, the file bridge or the
  UI boundary. Read-only by design: it reports, it does not fix.
- **`tester` establishes evidence** — the right agent for "did this test ever fail?" (rules 2.3
  and 2.4 in the plan).
- Agents run `background: true` with `isolation: worktree`; worktree isolation earns its cost
  only when agents edit in parallel, and the edits still have to come back into this tree.
- **Do not delegate** a one-line fix in an open file, or a question one module answers. The
  dispatch costs more than the work.

### Skills

`.claude/skills/` holds ten skills, tracked in git and pinned by `skills-lock.json`. Each
agent's own `## Skills` section says which apply to it. Three carry repository-specific weight:

- `shadcn` + `migrate-radix-to-base` — **always paired.** The shadcn CLI pulls Radix; `packages/ui`
  wraps Base UI. Convert before wrapping as a `Terminal*` export, or `check-ui-boundary.mjs` fails.
- `web-design-guidelines` — accessibility and focus states, alongside this repo's own
  viewport/DPI/density matrix.
- `writing-guidelines` — prose that outlives a session: docs, ADRs, the plan.

The **desktop** profile has no server at runtime (ADR 0005) and must stay static. The **web**
profile is headed for one: F14 mounts the control plane inside the Next.js app and deploys both.

## Git commit and pull request conventions

**English**, in the register of `CODE_OF_CONDUCT.md` — the house style for prose that outlives a
session. Read it before writing one; every rule below is derived from it.

- **Never** mention an AI assistant: no `Co-Authored-By`, no "generated by".
- **Conventional prefix, imperative subject** (`type(scope): do the thing`) saying what the
  change makes the project do, not what the author did.
- **Consequence before measure:** what was wrong first, what the change does about it second.
- **Plain declarative sentences.** No hedging, exclamation marks, emoji, jokes, or self-praise.
- **Describe behaviour, never people.** Never call earlier work careless, clever, or broken.
- **Name concrete artefacts** — the file, setting id, requirement (`R12`) or correction
  (`C19`) — never "some places" or "various fixes".
- **Redact** shoot-machine paths, keys, tokens, connection strings and the contents of
  `*.local.json` and `.env`; write `<redacted>`.
- **State scope, including what is out of it.** A change that stops short says so.
- **Attribute what was borrowed** from a library's API or an outside source.
- **One idea per bullet, parallel grammar.**

## Notes

- TypeScript is strict everywhere (`tsconfig.base.json`): `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax`.
- `apps/hq/AGENTS.md` is regenerated by `next dev`; never hand-edit it, just commit it if it changes.
- **Read a file before editing it; grep every caller before changing a function.** Re-research
  rather than trusting memory of this codebase.
- Keep `docs/plans/actual_plan.md` current **as work happens, not afterward**: state and route
  ahead live in one place so they cannot drift apart. When a task finishes, a defect is found, or
  a claim turns out wrong, update it in the same batch — the corrections register (§6) exists
  because uncorrected claims are worse than claims never made. `docs/plans/history.md` is the
  plan's historical annex, not a second plan: proven history (§5), the full correction texts (§6)
  and the execution journal (§8) live there verbatim, the plan keeps their summaries and the §6
  index, and a new journal entry or correction goes into the annex in the same batch as the work.
  Any other plan document anywhere is drift: fold it back in rather than treating it as a new
  source of truth.
