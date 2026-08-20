# HQ customization, media and synchronization plan — V2 reconciliation

> **For agentic workers:** this is a **program-level** plan. It reconciles the
> original request with the repository's measured state and re-orders the route.
> It deliberately does **not** contain bite-sized implementation steps: the
> original request spans nineteen independent subsystems, and one task-level
> plan covering all of them would be unreviewable. Section 5 defines the
> per-subsystem plans that carry the steps. Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`
> against those, not against this file.

**Goal:** Restate what the project was actually asked to build, measure what
exists, and correct the route so no later phase depends on a capability that was
recorded as done but is not.

**Architecture:** V1 stays as the evidence archive — its checkpoints (§13.1.1
through §13.1.5) are hard-won and remain valid as records of what was proven and
when. V2 supersedes only V1's **status claims** and **linear route** (§13.1,
§13.2). Where the two disagree, V2 wins.

**Tech Stack:** unchanged — pnpm/Turborepo, Next.js 16 + React 19, Tauri 2,
ConnectRPC over binary gRPC-Web, Neon PostgreSQL, Upstash Redis, Zustand, Zod,
Base UI + shadcn/ui, Tailwind v4, Vidstack.

**Spec:** the original request, reproduced verbatim in
`docs/plans/HQ_ORIGINAL_REQUEST.md` (prompt #0). Every requirement ID below
(`R1`–`R31`) points into it.

## Global Constraints

Copied from the existing architecture and enforced by CI. Every task in every
sub-plan inherits these.

- **Transport:** ConnectRPC over binary gRPC-Web only. No REST, no native gRPC,
  no ad hoc JSON (ADR 0003, ADR 0008).
- **UI boundary:** no file outside `packages/ui` may import `@base-ui/react`
  directly or use a raw `<button>/<input>/<select>/<textarea>`. Enforced by
  `scripts/check-ui-boundary.mjs`. shadcn/ui components live in
  `packages/ui/src/shadcn` for this reason.
- **Protocol freshness:** any `.proto` change requires
  `pnpm --filter @gremuchaya/protocol generate` and a committed result.
  Enforced by `scripts/check-protocol-generation.mjs`.
- **Migrations are append-only.** Never edit a shipped migration.
- **Credentials are never stored raw** — only purpose-separated HMAC hashes with
  a `hash_version`.
- **Offline-first:** desktop is `output: 'export'` with no Node server at
  runtime (ADR 0005). No build-time network dependency for fonts or assets.
- **No page scroll** (R26): scrolling belongs to a panel or a table body, never
  the document.
- **Language split:** in-app content and README in Russian; code, identifiers,
  comments and these plans in English.
- **Commits:** Conventional Commits; no AI-assistant attribution of any kind.

---

## 1. Corrections register

Each entry supersedes a claim in V1 or `CLAUDE.md`. Every one was measured, and
the command that measured it is given so the finding can be re-checked rather
than trusted.

### C1 — Zustand slice structure is not what the documentation says

`CLAUDE.md` states the runtime is "split into scene, screens, operator,
workspace, explorer, developer and connection slices." There are two store
files: `appStore.ts` (56 lines, one `runtimeState` export) and
`operationsStore.ts` (997 lines, containing `OperationsUiState`,
`ProductionState`, `PersonalizationState` inside a single `OperationsState`).

```powershell
Get-ChildItem apps/hq/src/state
Select-String -Path apps/hq/src/state/operationsStore.ts -Pattern 'scene|screens|workspace|explorer|developer|connection'
```

Of the seven named slices only `operator` appears at all, three times. This
matters more than a stale sentence: `CLAUDE.md` is loaded into every agent
session, so the wrong mental model propagates into every future change. **Fix
`CLAUDE.md` before any state work begins.**

### C2 — The database schema is roughly three times ahead of the code

Migrations create 29 tables. Eight are referenced by application code:
`groups`, `devices`, `group_memberships`, `device_sessions`,
`device_access_tokens`, `device_refresh_token_history`, `pairing_codes`,
`mutation_receipts`.

```powershell
node -e "const s=require('fs').readFileSync('apps/control-plane/src/db/migrations.ts','utf8');console.log([...s.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m=>m[1]).join('\n'))"
```

Twenty-one tables are touched by nothing: `materials`, `material_versions`,
`material_objects`, `material_tags`, `material_tag_links`, `upload_sessions`,
`upload_parts`, `conversion_jobs`, `settings_documents`, `settings_versions`,
`layout_documents`, `layout_versions`, `history_events`, `sync_events`,
`sync_snapshots`, `presence_snapshots`, `simulation_profiles`,
`simulation_versions`, `integration_jobs`, `github_installations`,
`translation_proposals`.

This was deliberate — migration `0001` laid down the whole target model at once,
and V1 says so. The correction is to the **risk assessment**, not the decision:
those twenty-one tables carry constraints, foreign keys and indexes that have
never been executed against anything. The receipts defect found on 2026-08-20
was exactly this failure mode — schema that looked right, structural tests that
passed, and a feature that did not work against a real engine. `0005` shipped
CHECK constraints resting on an assumption ("every receipt produces a session")
that was false one wave later, and `0006` had to drop them by catalogue lookup
because their names were server-generated.

**Consequence for the route:** the first code to touch any of those twenty-one
tables must arrive with live-database integration scenarios in the same commit,
not afterwards.

### C3 — Realtime history is in memory; the durable tables are empty

`apps/control-plane/src/realtime/hub.ts:24` holds
`#historyByGroup = new Map<string, syncV1.GroupEvent[]>()`. The hub contains no
database access at all.

```powershell
Select-String -Path apps/control-plane/src/realtime/*.ts -Pattern 'database|SqlClient|query\('
```

V1 acknowledges the hub is "intentionally single-process and in-memory at this
stage", but V1's own L1 exit condition requires "a paired device can … publish/
receive a **durable** authorized event after reconnect". A process restart
currently erases every group's history. **This is the single largest gap
between the recorded status and the stated exit condition.**

### C4 — Six of seventeen SyncService RPCs are implemented

Implemented: `CreateGroup`, `CreatePairingCode`, `PairDevice`,
`RefreshDeviceSession`, `ListDevices`, `RevokeDevice`.

Not implemented: `UpdateGroup`, `JoinGroup`, `LeaveGroup`, `SetDeviceRole`,
`SetAuthorityMode`, `SetLeader`, `WatchGroup`, `PublishDocumentDelta`,
`PublishSessionCommand`, `GetPresence`, `TimeSync`.

`MaterialService`, `SettingsService`, `TelemetryService` and
`IntegrationService` have no implementation module at all — `apps/control-plane/src`
contains only `sync/`, `realtime/`, `redis/`, `db/`.

### C5 — The Redis adapter is written, tested, and wired to nothing

`apps/control-plane/src/redis/coordination.ts` is imported by exactly one file:
its own test.

```powershell
Select-String -Path apps/control-plane/src -Pattern 'coordination' -Recurse | Where-Object { $_.Path -notmatch 'src.redis' }
```

V1's Phase 3 checklist marks "Add Upstash-backed presence, coordination and rate
limits" as `[x]`. The code exists and passes its unit tests; it is not part of
the running control plane. Cross-instance fanout has not started.

### C6 — V1 §13.1.4 claimed PostgreSQL evidence it had not run

Already corrected in place in V1 and recorded in §13.1.5. Restated here because
it drove a process change: **a plan may not record a live-database claim unless
the run that produced it is quoted.** See §6.

---

## 2. Requirement traceability against the original request

Verdicts are measured, not self-reported. `absent` means no implementing code
was found; `partial` means a slice exists; `present` means the requirement is
met for the modern web/desktop target.

### 2.1 Materials and files

| ID  | Requirement (prompt #0)                                         | Verdict     | Evidence                                                                                     |
| --- | --------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| R1  | Upload files from any client into the monorepo `shared/` folder | **partial** | `shared/materials/` exists; local BLAKE3 import and Range reader work; no cross-client path. |
| R2  | Upload new files through hidden in-app settings                 | **partial** | Local import dialog exists on the FILES screen; gated on file-bridge write mode.             |
| R21 | Optimized playback                                              | **partial** | Range streaming and browser-local playback sync landed (V1 §Phase 6 checkpoints).            |

### 2.2 Personalization and edit mode

| ID  | Requirement                                                                 | Verdict     | Evidence                                                                              |
| --- | --------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| R3  | Configure tile appearance; hide/show categories and tiles                   | **partial** | `settingCategories` declares `tiles`, `layout`; no per-tile visibility control found. |
| R4  | Edit date, time and information in-app                                      | **absent**  | No edit surface; `dateTime` is a declared category with no editor.                    |
| R5  | Per-category reset button **and** a global reset                            | **partial** | 54 files mention reset; no per-category reset control located.                        |
| R6  | A large number of personalization settings, informational and visual        | **partial** | 32 categories declared in `packages/settings-schema` (685 lines); most have no UI.    |
| R7  | Edit mode with a floating, magnetically edge-aligned panel editing anything | **absent**  | `Select-String -Pattern 'editMode\|EditMode' -Recurse` → **0 files**.                 |
| R17 | Instant state switching while in edit mode                                  | **absent**  | Depends on R7.                                                                        |
| R22 | Accent-gradient window border while in edit mode                            | **absent**  | Depends on R7.                                                                        |
| R19 | All animation settings, plus per-tile/category/element animation settings   | **partial** | `animations` category declared; per-element control absent.                           |

**R7 is the centre of the original request** — the floating edit panel is the
instrument through which most other requirements are exercised. It has no
implementation. V1 places it in L5, behind materials and media. That ordering is
the plan's biggest structural error; see §4.

### 2.3 Layout and interaction

| ID  | Requirement                                                               | Verdict     | Evidence                                                                              |
| --- | ------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| R9  | Pagination, filters and sorting wherever data exists                      | **partial** | Cursor pagination in the protocol and control plane; screen-level coverage uneven.    |
| R10 | Overflowing elements move to their own screens/tiles; no empty grid areas | **partial** | `packages/layout-engine` (267 lines) does bounded packing; not applied to all routes. |
| R26 | No page scroll; scroll only inside a table's list                         | **partial** | Layout engine exists for this; not enforced across the route matrix.                  |
| R30 | On truncation, scroll appears on the owning panel, or the panel adapts    | **partial** | Same as R10/R26.                                                                      |
| R15 | Bold-text accents                                                         | **present** | 30 files use weight/`<strong>` accents.                                               |
| R23 | `cursor: pointer` on interactive elements; resize cursors in edit mode    | **partial** | 4 files set pointer cursors; resize cursors depend on R7.                             |
| R12 | Custom popups incl. right-click; selection disabled outside edit mode     | **partial** | 7 files use `TerminalPopover`/context menu; **1 file** touches selection styling.     |
| R11 | App-wide keybinds, highlighted list in settings and on first run          | **partial** | 3 files mention keybinds; `keybinds` category declared; no first-run surface found.   |
| R14 | Theme and style switching without breaking the interface                  | **partial** | Terminal tokens + shadcn preset coexist (see `docs/architecture/styling.md`).         |

### 2.4 Visual effects

| ID  | Requirement                                                                           | Verdict    | Evidence                                                         |
| --- | ------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------- |
| R13 | Animated background, disableable; grid/dotted/barber patterns on focus and background | **absent** | `animatedBackground` → 0 files; `barber\|dotted` → 2 files only. |
| R16 | Startup animation, configurable and disableable                                       | **absent** | 3 files mention startup; no animation implementation found.      |

### 2.5 Native shell

| ID  | Requirement                                                                      | Verdict     | Evidence                                                           |
| --- | -------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| R18 | Push as much as possible into Rust; TypeScript only where Rust cannot            | **partial** | `apps/hq/src-tauri` has monitors, windows, watcher, media gateway. |
| R24 | Custom titlebar for Win11/Win10 with native rounding; square window on Vista–8.1 | **partial** | 4 files mention titlebar; legacy shell unstarted.                  |
| R25 | Titlebar configurable: buttons, order, alignment, embedded info, drag region     | **absent**  | `titlebar` category declared; no configuration surface.            |

### 2.6 Synchronization, history, localization

| ID  | Requirement                                                                                    | Verdict     | Evidence                                                                               |
| --- | ---------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| R27 | Millisecond-accurate sync across sessions; sync groups; leader or all-leader mode              | **partial** | Browser-local `BroadcastChannel` sync only; `TimeSync`/`SetLeader` unimplemented (C4). |
| R29 | History of edit-mode and settings changes, per-session **and** per-group, paginated + filtered | **partial** | 14 files mention history; local settings history landed; group history absent (C3).    |
| R28 | Localization of every text element; per-element translit in edit mode; translation PR + link   | **partial** | 13 files mention locale/i18n; the edit-mode translit path depends on R7.               |
| R8  | Issue draft generation with a link to a new repository issue                                   | **absent**  | `github_installations` and `translation_proposals` tables exist, unused (C2).          |

### 2.7 Media and simulation

| ID  | Requirement                                                                          | Verdict     | Evidence                                                                    |
| --- | ------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------- |
| R20 | Custom player theme from a community library, not the native browser player          | **present** | Vidstack in 2 files; V1 §Phase 6 Vidstack checkpoint.                       |
| R31 | Dynamic mainframe/server/network data; presets, criticality, draggable curve, timing | **absent**  | `curve` → 2 files; `simulation_profiles`/`simulation_versions` unused (C2). |

### 2.8 Coverage summary

Of 31 measured requirements: **2 present**, **19 partial**, **10 absent**.

The absent set is dominated by one cluster — edit mode (R7) and everything that
hangs off it: R4, R17, R22, and the edit-mode halves of R28, R29, R23, R25.

---

## 3. What V1 got structurally wrong

V1's route is ordered by **technical layer** — protocol, then layout, then
materials, then media, then editor. The original request is organised around a
**product capability**: an operator opens edit mode and reshapes the application
from inside it. Sequencing the editor last means:

1. Every personalization requirement (R3–R6, R19) has to be built twice — once
   as a static setting, once again as an edit-mode surface.
2. The two requirements that generate outbound artefacts (R8 issue drafts, R28
   translation PRs) are specified as edit-mode actions and cannot be built at
   all until R7 exists.
3. The history requirement (R29) is specified as "history of edit-mode **and**
   settings changes". Half of its subject does not exist, so the local history
   already shipped covers a subset that cannot be completed without R7.

V1 also treats the 32 declared setting categories as evidence of progress. They
are a schema, not a feature: `packages/settings-schema` validates drafts for
categories that have no UI and no persistence path.

---

## 4. Revised route

L0 and the closed Base UI checkpoints (V1 Phases 1–2) stand unchanged. The
change is to what follows.

### L1 — finish the control plane (unchanged in intent, corrected in content)

Still first: nothing distributed can be claimed without it. Remaining work, in
order:

1. **Durable group history** — replace `#historyByGroup` with `history_events`
   and `sync_events` (C3). This is also the first code to touch the untested
   twenty-one-table set, so it carries live-database scenarios in the same
   commit (C2).
2. **Remaining SyncService handlers** (C4), starting with `WatchGroup`,
   `JoinGroup`/`LeaveGroup`, `SetDeviceRole`, `SetLeader`, `TimeSync`.
3. **Wire the Redis adapter into the running server** (C5), then cross-instance
   fanout.
4. **`SettingsService`** — required by L2 and L3, and the first consumer of
   `settings_documents`/`settings_versions`.
5. **Preview deployment**, then prove binary gRPC-Web and realtime against it.

Exit: unchanged from V1 — a paired device authenticates, joins a group, and
publishes/receives a durable authorized event after reconnect.

### L2 — edit mode (new position: was L5)

Moved ahead of layout, materials and media, because it is the instrument the
original request is written around and because building it late forces
duplicated work (§3).

Delivers R7, R17, R22, R23 (resize cursors), and the edit-mode halves of R4 and
R25. Depends on L1 only for the group-scoped variant; the local-session variant
can ship first.

**Hard constraint:** no arbitrary HTML, JavaScript or CSS. Edits are safe
descriptors validated by `packages/settings-schema`, as V1's L5 already states.

### L3 — layout closure across every screen (was L2)

Delivers R10, R26, R30, and finishes R3. Now benefits from edit mode: tile
visibility and sizing become editable rather than a separate settings surface.

### L4 — personalization surfaces (was spread across L2/L5)

Delivers R5, R6, R19, R13, R16, R14, R12, R11. Each category gets its UI, its
reset control, and its group/local persistence through the `SettingsService`
from L1.

### L5 — materials lifecycle (was L3)

Unchanged in content: R1, R2 completed with authenticated upload, versions,
trash/restore, mirror reconciliation.

### L6 — media and map slice (was L4)

Unchanged in content: R20 completion, R21, and the authenticated replacement of
browser-local synchronization with the L1 transport (R27).

### L7 — history, localization, telemetry, simulation (was L5's tail)

Delivers R29 in full (local **and** group), R28 including the translation-PR
path, R8, and R31 with the curve editor.

### L8 — native and release hardening (was L6)

Unchanged: R18, R24, R25 completion, legacy Windows shell, production
provisioning, the single `v1.0.0` release.

---

## 5. Sub-plan split

This document does not carry implementation steps. Per the writing-plans scope
rule, each of the following gets its own task-level plan with real code in every
step, and each produces working, testable software on its own:

| Plan                                   | Covers                | Depends on       |
| -------------------------------------- | --------------------- | ---------------- |
| `L1a-durable-group-history.md`         | C3, `history_events`  | —                |
| `L1b-sync-service-handlers.md`         | C4                    | L1a              |
| `L1c-redis-fanout.md`                  | C5                    | L1a              |
| `L1d-settings-service.md`              | R6 persistence        | L1a              |
| `L2-edit-mode.md`                      | R7, R17, R22, R23     | L1d (group mode) |
| `L3-layout-closure.md`                 | R10, R26, R30, R3     | L2               |
| `L4-personalization-surfaces.md`       | R5, R6, R19, R13, R16 | L1d, L2          |
| `L5-materials-lifecycle.md`            | R1, R2                | L1a              |
| `L6-media-and-sync-transport.md`       | R20, R21, R27         | L1b, L1c         |
| `L7-history-localization-telemetry.md` | R29, R28, R8, R31     | L2, L1a          |
| `L8-native-and-release.md`             | R18, R24, R25         | all              |

`L1a` is the next one to write: it unblocks the most and it is where the
untested-schema risk (C2) first becomes real.

---

## 6. Verification protocol — changed as a result of C6

The receipts defect was invisible to every offline test and was recorded as
proven before it had been run. Three rules follow, and they are binding on every
sub-plan:

1. **A live-database claim requires a quoted run.** A plan or checkpoint may not
   describe an integration scenario as passing unless the command and its result
   are recorded alongside. "Written, not run" is an acceptable status; silently
   implying otherwise is not.
2. **Structural tests are change detectors, never gate evidence.** Asserting the
   shape of generated SQL proves construction, not locking, serialization, or
   whether a join eliminates a row. Any gate concerning concurrency, locking or
   persistence needs the real engine.
3. **Mutation results are reported in full, including survivors.** A surviving
   mutant is a finding about the tests, not something to omit. V1 §13.1.5 shows
   the intended format: which mutant killed which tests, and which survived and
   why.

The first table any sub-plan touches from the twenty-one unused set gets its
integration scenarios in the same commit as its first query — not in a
follow-up.
