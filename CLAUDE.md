# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

"Гремучая смесь — Оперативный штаб" (`gremuchaya-hq`) is a local-first operational dashboard for a
film/production shoot: a normalized world of sectors, objects, cases, materials, comms channels and
simulated events, driven by a deterministic scene/cue engine. It ships as both a Next.js web app and
a native Tauri 2 desktop shell (static export, offline-first). In-app content and the README are
Russian; code, identifiers and comments are English.

pnpm + Turborepo monorepo: `apps/{hq,control-plane,file-bridge}` and `packages/{domain,config,
protocol,ui,layout-engine,settings-schema,test-fixtures}`.

## Commands

Requires Node 24.3+, pnpm 10.12.3+ (`.tool-versions`, `.nvmrc` and `package.json`'s
`packageManager` all pin the same versions; `packageManager` is authoritative if they ever
disagree), Rust/Cargo 1.88+ for desktop builds. The native RTSP gateway additionally needs ffmpeg
on PATH or a path in `HQ_FFMPEG_PATH`. Primary dev/release target is Windows (NSIS installer,
WebView2 Runtime required); commands below are PowerShell-oriented.

```powershell
corepack enable
pnpm install
```

- `pnpm dev:hq` — run only the Next.js app (`http://127.0.0.1:3000`)
- `pnpm dev:full` — hq + file-bridge + control-plane together
- `pnpm dev` — every workspace package's `dev` task in parallel
- `pnpm build` / `pnpm build:web` / `pnpm build:desktop:web` — Turbo build, web target, or Tauri static-export target
- `pnpm typecheck` / `pnpm lint` — across all packages via Turbo
- `pnpm test` — unit/integration tests (Vitest) across all packages
- `pnpm test:ui` — Playwright end-to-end tests for `apps/hq` (starts its own dev server)
- `pnpm test:cargo` — Rust tests for the Tauri backend (`apps/hq/src-tauri`)
- `pnpm check` — the full local gate: UI boundary check, protocol-generation freshness check, lint, typecheck, test, build
- `pnpm check:release` — `check` plus `test:ui`, `build:offline`, `test:cargo`; this is the shoot-day release gate (see `docs/release/runbook.md`)
- `pnpm format` / `pnpm format:check` — Prettier

Single test file, scoped to one package:

```powershell
pnpm --filter @gremuchaya/hq test -- src/state/someSlice.test.ts
pnpm --filter @gremuchaya/control-plane test -- src/sync/runtime.test.ts
pnpm --filter @gremuchaya/hq test:ui -- tests/some-flow.spec.ts
```

Protobuf codegen (required after editing any `.proto` file, or `check:protocol-generation` fails):

```powershell
pnpm --filter @gremuchaya/protocol generate
```

Control-plane DB migrations: `pnpm --filter @gremuchaya/control-plane migrate`.

Desktop packaging: `pnpm tauri:build` (produces the Windows NSIS installer under
`apps/hq/src-tauri/target/release/bundle/nsis/`); `cargo check --manifest-path apps/hq/src-tauri/Cargo.toml`
for a quick Rust-only check.

## Architecture

Layered dependency direction (canonical summary in `docs/architecture/dependency-map.md`, read that
first for anything cross-cutting):

```
presentation (Next routes, React, CSS)
        v
application (scene, explorer, snapshot, asset and screen use cases)
        v
domain (plain immutable types, state machines, invariants and ports)

infrastructure (browser, bridge and Tauri adapters) implements domain/application ports
```

Package ownership:

- `@gremuchaya/domain` — framework-free models, state machines, errors, paths and ports.
- `@gremuchaya/config` — Zod trust-boundary schemas, parsers and scene validation. It holds no
  migrations: the only migrations in the repository are the immutable TypeScript constants in
  `apps/control-plane/src/db/migrations.ts`.
- `@gremuchaya/protocol` — generated Protobuf messages (`gremuchaya.*.v1`) and the shared
  `FileBridgeService` descriptor; no runtime policy or UI code.
- `@gremuchaya/ui` — design tokens and scene-agnostic React primitives (wraps Base UI as the
  public `Terminal*` component set).
- `@gremuchaya/layout-engine` — deterministic bounded tile packing / overflow policy, shared across
  apps instead of relying on document scroll to hide content.
- `@gremuchaya/settings-schema` — schema-bound personalization draft validation (theme/density/etc.).
- `@gremuchaya/test-fixtures` — deterministic test data, excluded from production imports.
- `apps/hq` — composition root: Next.js 16 App Router + React 19 + Tauri 2 desktop shell, Zustand
  runtime, application services, adapters, and all UI/scene/screen code.
- `apps/file-bridge` — localhost-only (`127.0.0.1`), read-only-by-default gRPC-Web file projection
  and server-streaming watcher, with canonical-path traversal/symlink-escape protection.
- `apps/control-plane` — Node ConnectRPC service: health/capabilities, durable paired-device auth
  lifecycle, realtime sync hub over WebSocket with binary Protobuf resume, Neon (serverless Postgres)
  and Upstash (Redis) adapters.
- `apps/hq/src-tauri` — native Rust layer: monitor/window management, native file watcher, read-only
  projection.

State ownership:

- Zustand owns the current client runtime snapshot across two stores:
  `apps/hq/src/state/operationsStore.ts` (the runtime — `OperationsUiState`, `ProductionState` and
  `PersonalizationState` composed into one `OperationsState`) and `apps/hq/src/state/appStore.ts`
  (a small `runtimeState` holder). It is not yet split into per-domain slices; treat any plan that
  assumes scene/screens/workspace/explorer/connection slices as describing a target, not the code.
- Scene definitions (52 Zod-validated scenes) are immutable configuration, not runtime state.
- `localStorage` owns everything the browser persists, under six keys:
  `gremuchaya-hq:operations:v3` (runtime state), `gremuchaya-hq:production-snapshots:v3`,
  `gremuchaya-hq:snapshots:v1` (`LocalSnapshotPersistence`), `hq.camera-material-assignments.v1`, `hq.keybinds-intro-seen.v1`,
  and the Yandex Maps key. There is no IndexedDB and no Tauri store plugin anywhere in this
  repository. Media and timer handles are never persisted.
- Application services perform all IO and cross-slice transitions; React components only dispatch
  use cases and select narrow state.

### Enforced boundaries (CI scripts, not just convention)

Both run as part of `pnpm check` via `scripts/`:

- `check-ui-boundary.mjs` — fails if any file outside `packages/ui` imports `@base-ui/react` directly,
  or uses a raw `<button>/<input>/<select>/<textarea>` JSX element. Use `packages/ui`'s `Terminal*`
  wrappers everywhere else in `apps/` and `packages/`.
- `check-protocol-generation.mjs` — regenerates `packages/protocol/src/gen` and diffs it against the
  committed tree; stale generated bindings fail the check. Always run
  `pnpm --filter @gremuchaya/protocol generate` and commit the result after touching a `.proto` file.

### Protocol / RPC surface

Versioned Protobuf contracts live under
`packages/protocol/proto/gremuchaya/{bridge,common,control,integration,material,realtime,settings,sync,telemetry}/v1/*.proto`,
generated (buf) into `packages/protocol/src/gen`. Transport is ConnectRPC over binary gRPC-Web only —
no REST endpoints, no native gRPC, no ad hoc JSON (ADR 0003, ADR 0008). In `apps/control-plane`,
`ControlPlaneService` (health, getCapabilities) is always registered; `SyncService` (paired-device
auth, authenticated realtime admission) is only wired up when durable auth config
(`apps/control-plane/src/config.ts`) is present — otherwise the control plane starts in a reduced,
health-only/unauthenticated dev mode, and attempting to override auth-configured startup collaborators
throws. Realtime sync uses a WebSocket hub (`apps/control-plane/src/realtime`) with periodic admitted-
socket revalidation rather than a persistent per-message auth check.

### Local-first / offline-first design

The desktop build uses Next.js `output: 'export'` (fully static) plus Tauri native adapters — no Node
server at runtime (ADR 0005). Multi-window/display synchronization uses a typed screen-bus port: Tauri
events in desktop mode, `BroadcastChannel` with a `storage`-event fallback on web — deliberately not
WebSockets, to avoid a server dependency for cue execution (ADR 0001). All `/screen/:id`, `/wall/:id`
and `/scene/:id` routes are statically generated at build time since Tauri has no server-side dynamic
routing fallback (ADR 0006).

### File access model

A three-tier virtual filesystem (ADR 0002): the browser File System Access API, the localhost
gRPC-Web file-bridge (`apps/file-bridge`, opt-in, read-only by default — ADR 0003), and native Tauri
roots. Four `FileSourcePort` adapters are merged by `ExplorerService.list` over the domain's
`mergeExplorerNodes`, behind branded virtual paths, so physical filesystem paths never leak into
the UI. Real nodes shadow an emulated/config-defined node at the same virtual path.

### Further reading

- `docs/architecture/dependency-map.md` — canonical layering summary
- `docs/adr/0001` through `0008` — multi-screen bus, virtual filesystem, local file bridge,
  information state machines, offline-first runtime, static route generation, TS/ESLint compatibility
  pinning, control-plane Protobuf contracts
- `docs/release/environment.md` — pinned toolchain/dependency versions and why
- `docs/release/runbook.md` — shoot-day release/rehearsal/recovery procedure
- `docs/release/known-limitations.md` — e.g. no committed Yandex Maps API key, placeholder media, no
  production RTSP/HLS/WebRTC endpoints yet
- `docs/plans/` — active implementation plans

## Git commit and pull request conventions

Commit messages, pull request titles and pull request bodies are written in **English**,
in the register of `CODE_OF_CONDUCT.md`. That file is this repository's house style for
prose that outlives a session; read it before writing one. The rules below are the parts
of that style that apply to a commit.

- **Never** add `Co-Authored-By` lines, "generated by" notes, or any other mention of an
  AI assistant.
- **Conventional prefix, imperative subject.** `type(scope): do the thing` — the subject
  says what the change makes the project do, not what the author did.
- **Consequence before measure.** The enforcement ladder states the community impact and
  only then the action taken. A message follows the same order: what was wrong or missing
  first, what the change does about it second.
- **Plain declarative sentences.** No hedging, no exclamation marks, no emoji, no jokes,
  and no praise for the work itself. The document never sells its own rules; a commit does
  not sell its own diff.
- **Describe behaviour, never people.** The code of conduct characterises conduct and
  never a person. A message says what the code did and now does; it does not call earlier
  work careless, clever, or broken-by-someone.
- **Name concrete artefacts.** The document names `*.local.json`, `.env` and
  `docs/release/asset-replacement.md` rather than "sensitive files". A message names the
  file, setting id, requirement (`R12`) or correction (`C19`) it touches, never "some
  places" or "various fixes".
- **Redact, in commits as in issues.** Never put real shoot-machine paths, API keys,
  tokens, connection strings, or the contents of `*.local.json` and `.env` into a message,
  issue or pull request; write `<redacted>` in their place.
- **State scope, including what is out of it.** The document devotes a section to where it
  applies. When a change deliberately stops short — a requirement half closed, a surface
  left for a later feature — the message says so rather than letting the reader assume the
  rest.
- **Attribute what was borrowed.** The document credits Contributor Covenant and Mozilla
  by name. When an approach comes from a library's own API or an outside source, name it
  instead of presenting it as invented here.
- **One idea per bullet, parallel grammar**, in a body list as in the standards list.

## Notes

- TypeScript is strict everywhere (`tsconfig.base.json`): `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax` are all on.
- `apps/hq/AGENTS.md` is regenerated automatically by `next dev`; don't hand-edit it, just commit it
  if it changes.
- Before editing any file, read it first. Before modifying a function, grep for all callers. Reresearch before you edit.
- Keep `docs/plans/actual_plan.md` current as work happens, not afterward. It is the repository's
  one plan document by design (its own header explains why prior plan files were folded into it and
  removed): the current state of the project, its proven history and the route ahead all live in one
  place so they cannot drift apart. When a task finishes, a defect is found, or something the plan
  claimed turns out wrong, update the plan in the same batch of work — the corrections register (§6)
  exists because claims left uncorrected are worse than claims never made. A second plan document
  appearing anywhere is a sign something drifted; fold it back in rather than treating it as a new
  source of truth.
