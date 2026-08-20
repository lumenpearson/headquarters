# HQ feature delivery plan — V3

> **For agentic workers:** this is the **route** document. It decides order and
> records module verdicts. The executable, step-by-step plans live in
> `docs/plans/features/` — one per feature, each with real code in every step.
> Use `superpowers:subagent-driven-development` against those, not against this
> file.

**Goal:** Deliver the original request one feature at a time, each to full
depth, replacing the layer-by-layer route that produced nineteen half-finished
requirements.

**Architecture:** Vertical slices. A feature is not started until its
predecessor is usable on shoot day, and is not called done until an operator can
use it. The only horizontal work permitted is a shared _instrument_ — defined
below by a test, not by taste.

**Tech Stack:** unchanged — pnpm/Turborepo, Next.js 16 + React 19, Tauri 2,
ConnectRPC over binary gRPC-Web, Neon PostgreSQL, Upstash Redis, Zustand, Zod,
Base UI + shadcn/ui, Tailwind v4, Vidstack.

**Spec:** `docs/plans/HQ_ORIGINAL_REQUEST.md` (prompt #0), requirement IDs
`R1`–`R31`.

**Supersedes:** V2's route (§4) and sub-plan split (§5). V2's corrections
register (§1) and verification protocol (§6) stand unchanged and are not
repeated here. V1 remains the evidence archive.

## Global Constraints

Unchanged from V2 §Global Constraints. Every task in every feature plan inherits
them. Restated only where V3 adds one:

- **Definition of done — new, and binding.** A feature is done when an operator
  can use it on shoot day. Not when the schema exists. Not when structural tests
  pass. Not when a category is declared in `settings-schema`.
- **Work-in-progress cap — new, and binding.** One feature in flight. No feature
  starts while its predecessor is partial.

---

## 1. Corrections to V2's own matrix

V2 measured by grep. Two entries were wrong once the modules were read properly.
Recorded here because a plan that misreports its own baseline is the thing V2
existed to fix.

**R5 (per-category reset) — V2 said "no per-category reset control located".**
Misleading. `packages/settings-schema` exports `resetDraftCategory` and
`resetDraftAll`, and `operationsStore.ts` imports both. The domain capability
exists and is correct. What is missing is the **UI control**. Revised verdict:
_domain complete, surface absent_.

**R6 (a large number of personalization settings) — V2 said "32 categories
declared, most have no UI".** Undercounts the machinery and overstates the
content. The machinery is senior-grade: `SettingDefinition` carries id,
category, `defaultValue`, `scope`, `description`, `editor` and a `validate`
type-guard; drafts are immutable with `baseRevision`, `changedIds` and an
embedded `SettingsHistoryEvent[]`; checkpoints, import/export and publish exist.
The content is a skeleton: **33 definitions across 32 categories**. Revised
verdict: _architecture complete, population ~3% of intent_.

The practical consequence is large: most personalization work is **adding
definitions and rendering their declared `editor`**, not designing a settings
system. That is a fundamentally cheaper job than V2 implied.

---

## 2. Module verdicts

Four verdicts only. Every one is evidence-based; nothing is condemned for being
long.

### Keep — do not touch except to extend

| Module                        | Why                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/settings-schema`    | Correct draft/snapshot/checkpoint model, per-category reset, per-setting validation and editor hints. See §1.       |
| `apps/control-plane/src/sync` | Auth lifecycle is mutation-proven against a live database; the hardest correctness work in the repo already landed. |
| `packages/ui/src/primitives`  | 25 `Terminal*` wrappers behind a CI-enforced boundary. This is what keeps a second design language from leaking in. |
| `packages/layout-engine`      | 267 lines, tested, framework-free, does exactly one thing.                                                          |
| `packages/protocol`           | Generated, freshness-gated. Never hand-edit.                                                                        |

### Populate — architecture is right, content is missing

| Module                     | Gap                                                                      |
| -------------------------- | ------------------------------------------------------------------------ |
| `packages/settings-schema` | 33 definitions where the request implies hundreds. Add definitions only. |
| `apps/hq/src/screens/*`    | Screens exist; the layout resolver is not applied across all of them.    |

### Rewrite — will not carry the target feature set

**`apps/control-plane/src/realtime/hub.ts` history.** `#historyByGroup` is an
in-memory `Map`. Replace with `history_events`/`sync_events` (V2 C3). Replace,
not extend — a hub that reads from both is a hub with two sources of truth.

That is the only rewrite. The list was longer; see the correction below.

### Corrected — `operationsStore` does not need decomposing

An earlier revision of this document put `apps/hq/src/state/operationsStore.ts`
under Rewrite, arguing that merging production, UI and personalization state
into one store means every edit-mode action re-renders every consumer of
production data. **That reasoning was wrong, and it was not measured.**

Measured: of 50 `useOperationsStore(...)` call sites, 44 return a stable
reference — a primitive, an object already held in state, or an action — and
Zustand's default `Object.is` comparison makes them bail correctly on an
unrelated update. Six return a freshly constructed collection, and all six are
in one file:

```powershell
Select-String -Path apps/hq/src -Pattern 'useOperationsStore\(\(state\) =>' -Recurse |
  Where-Object { $_.Line -match 'Object\.(values|keys|entries)|\.slice\(|\.filter\(|\.map\(' }
```

→ six matches, every one in `apps/hq/src/screens/OverviewScreen.tsx`.

The defect is real: `Object.values(state.sectors)` allocates a new array on
every store notification, so those six components re-render whenever anything in
the store changes. But its cause is the **selector**, not the store's shape, and
splitting the store would not have fixed it — any production-data edit would
still re-render all six. The remedy is `useShallow` on six selectors in one
file.

Decomposing 997 lines across four modules and rewriting seventeen import sites
would have been churn that left the actual defect in place, plus a re-export
shim living alongside the thing it re-exports. Revised verdict for
`operationsStore.ts`: **keep, with a targeted selector fix** (F1 Task 1).

### Wire — written, tested, connected to nothing

**`apps/control-plane/src/redis/coordination.ts`.** Imported only by its own
test (V2 C5). No code change expected; it needs a call site in the server
composition root.

---

## 3. The instrument test

One horizontal exception is permitted, and it is decided by a test rather than
by judgement:

> If two or more requirements would each have to build their own version of
> something, it is an instrument and is built once, first. If exactly one
> requirement needs it, that requirement builds it inside its own slice.

By that test this project has four instruments. Everything else is a feature.

| Instrument                                    | Requirements riding on it            |
| --------------------------------------------- | ------------------------------------ |
| Edit-mode shell (R7 core)                     | R4, R8, R17, R19, R22, R23, R25, R28 |
| Settings persistence path (`SettingsService`) | R3, R5, R6, R19, R29                 |
| Layout resolver applied to every route        | R3, R10, R26, R30                    |
| Durable event log                             | R8, R27, R29                         |

---

## 4. Delivery order

Each entry is one executable plan in `docs/plans/features/`. Each produces
software an operator can use.

### F1 — Edit mode (instrument + feature)

**Delivers in full:** R7, R17, R22, R23, and the drag-and-drop reordering folded
into R7.

First because it is the instrument the request is written around, and because
building it late forces every personalization feature to be built twice — once
as a static settings panel, once again as an editable surface (V2 §3).

Full depth is achievable without the control plane: the floating magnetic panel,
in-place editing of safe descriptors, drag-and-drop with dashed drop targets and
accent highlight, instant state switching, the accent-gradient window border and
the resize cursors are all client-side. The GitHub issue draft (R8) is a
prefilled URL, not an API call, so it ships here too.

Depends on the `operationsStore` decomposition, which is Task 1 of its plan.

**Not in F1:** group-scoped edit history (that is R29, feature F8).

### F2 — Background, patterns and startup animation

**Delivers in full:** R13, R16, and the animation half of R19.

First feature after the instrument because it is entirely absent
(`animatedBackground` → 0 files), self-contained, and it establishes the
template every later personalization feature follows: add `SettingDefinition`s
→ render their declared `editor` → wire the edit-mode surface → persist through
the draft model → reset per category.

### F3 — Keybinds

**Delivers in full:** R11, including the highlighted list in settings and the
first-run surface.

### F4 — Popups, selection and cursors

**Delivers in full:** R12, R23's field cursors, and the selection-colour rules.

### F5 — Layout closure (instrument + feature)

**Delivers in full:** R10, R26, R30, R3.

Applies the layout resolver to every route and enforces the no-page-scroll rule
across the viewport/DPI/locale/theme matrix. Benefits from F1: tile visibility
and sizing become editable rather than a second settings surface.

### F6 — Control plane: durable history and remaining handlers (instrument)

**Delivers:** V2 C3, C4, C5 — durable group history, the eleven missing
SyncService RPCs, `SettingsService`, and the Redis wiring.

Positioned here, not first, because F1–F5 need no server. It is required before
anything group-scoped.

**Carries V2 §6 in full:** this is the first code to touch the twenty-one
untested tables, so live-database scenarios ship in the same commit as the first
query.

### F7 — Personalization surfaces

**Delivers in full:** R5, R6, R14, and the remaining `SettingDefinition`
population.

After F6 because group-scoped settings need `SettingsService`.

### F8 — History

**Delivers in full:** R29 — local and group, paginated, sorted, filtered by
date, category and individual element.

### F9 — Materials lifecycle

**Delivers in full:** R1, R2.

### F10 — Media and synchronization transport

**Delivers in full:** R20 completion, R21, R27 — replacing browser-local
`BroadcastChannel` with the authenticated transport.

### F11 — Localization

**Delivers in full:** R28 including the translation pull-request path.

### F12 — Dynamic data and the curve editor

**Delivers in full:** R31.

### F13 — Native shell and release

**Delivers in full:** R18, R24, R25, the legacy Windows shell, production
provisioning and the single `v1.0.0` release.

---

## 5. Why this order and not another

**F1 before everything** — the instrument test. Eight requirements ride on it.

**F2–F5 before F6** — they need no server, so they convert directly into
shippable capability. Front-loading the control plane would repeat V1's mistake
of spending the early budget where nothing is visible.

**F6 before F7–F8** — group scope and durable history are server-shaped, and
V2's L1 exit condition is unmet until they land.

**F9–F12 after** — each is large and self-contained; none blocks another.

**F13 last** — release hardening cannot precede the thing being released.

---

## 6. Debt policy for the nineteen partials

Each existing partial is resolved by exactly one feature above, or is declared
debt with a named owner feature. None is left to be finished "somewhere along
the way" — that is the mechanism that produced them.

| Partial            | Resolved by         |
| ------------------ | ------------------- |
| R3, R10, R26, R30  | F5                  |
| R5, R6, R14, R19   | F7 (animations: F2) |
| R9                 | F5 and F8           |
| R11, R12, R15, R23 | F3, F4              |
| R1, R2, R21        | F9                  |
| R20, R27           | F10                 |
| R28, R29           | F8, F11             |
| R18, R24, R25      | F13                 |

---

## 7. Execution

Executable plans are written one at a time, immediately before their feature
starts, so each is written against the repository as it actually is rather than
as it was predicted to be. Writing all thirteen up front would recreate the
drift this document exists to correct.

`docs/plans/features/F1-edit-mode.md` is the first.
