# HQ customization, media, synchronization and Base UI implementation plan

Status: active implementation plan  
Created: 2026-08-15  
Baseline branch: `agent/operational-hq`  
Baseline commit: `90eb785afa14fd6868ab7a858e4333ad7a109413`  
Target public release: `v1.0.0`

## 1. Purpose and non-negotiable constraints

This document is the execution ledger for the production expansion of
"Гремучая смесь — Оперативный штаб". It is created before application code is
changed and must be kept current after every implementation wave.

Non-negotiable constraints:

1. Base UI replaces only the headless interaction layer. It must not replace or
   visually reinterpret the terminal design system.
2. Feature code imports public components from `@gremuchaya/ui`; direct
   `@base-ui/react` imports are confined to that package and enforced by lint.
3. Existing user work is preserved. This checkout starts with almost all project
   files untracked relative to the initial commit; no broad cleanup, reset, or
   overwrite is allowed.
4. The Tauri desktop target retains Next.js static export. Dynamic backend work
   is implemented in a separate control-plane and local Rust agent.
5. First-party business operations use Protobuf/gRPC-Web or native gRPC. Signed
   object-storage URLs, Yandex Maps SDK loading, and server-side GitHub provider
   calls are transport exceptions, not application REST APIs.
6. The page root never scrolls. Only bounded list, table, tree, document, or tile
   viewports may scroll.
7. Uploaded content is never executed. Arbitrary HTML, JavaScript, and CSS are
   not accepted by the interactive editor.
8. Secrets, device keys, filesystem paths, and physical window placement remain
   device-local even when most presentation settings are synchronized.

## 2. Baseline evidence

### 2.1 Toolchain

| Tool              | Baseline                              |
| ----------------- | ------------------------------------- |
| Node.js           | `v24.3.0`                             |
| pnpm              | `10.12.3`                             |
| Rust              | `rustc 1.88.0 (6b00bc388 2025-06-23)` |
| Cargo             | `cargo 1.88.0 (873a06493 2025-05-10)` |
| Next.js           | `16.3.1`                              |
| React / React DOM | `19.2.8`                              |
| TypeScript        | `6.0.3`                               |
| Zustand           | `5.0.15`                              |
| Zod               | `4.4.3`                               |
| Tauri CLI         | `2.11.4`                              |
| Base UI           | not installed at baseline             |

Current implementation version: `@base-ui/react@1.7.0`, pinned exactly in
`packages/ui`. This does not alter the immutable baseline table above.

The protocol foundation now also pins `prost@0.14.4`, `prost-build@0.14.4`,
`prost-types@0.14.4` and `protoc-bin-vendored@3.2.0` in the Tauri shell. The
Rust generator runs from `apps/hq/src-tauri/build.rs` and deliberately emits
only to Cargo's `OUT_DIR`: generated Rust is rebuilt from repository-owned
`.proto` sources and is never hand-edited or checked into source control.

### 2.2 Baseline hashes

| File                                | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `package.json`                      | `0CD80CF782FBEAA61B7A644791F016108F6E169C9429B0AC8BF61A520B601469` |
| `pnpm-lock.yaml`                    | `F344523CAAE0894EE67E126EAC5AE083E815D27984B769C16721F2DF259EC5DC` |
| `apps/hq/package.json`              | `18E34C37D3EF8CA554DD78F37E55DBA9E7891AF66091D75B8A8E8C665B83790F` |
| `apps/hq/next.config.ts`            | `70FD6757E5A3DA85317E6C02271063AD8FB35F99D815B939662FDB1973982C54` |
| `apps/hq/src/styles/operations.css` | `CF579E1A9D6304B88861A6D6E3B4913CDF11E68E3DCE640382C18CC1EA944426` |
| `packages/ui/src/index.ts`          | `5A691CE17E77D2304EB9AB6826C8D81B9F97779157AE6A688612EF9E55508FE1` |
| bridge proto                        | `07C24FD63523A3BAAEA1D58CC2D867084D5B1FF11288A50963AB11F3B1FC5565` |
| Tauri Cargo manifest                | `69C9667FE9F6DFF892EAED6F76CFEFDEE3956C4300B23A3F7522E8E656EC68EC` |
| Tauri configuration                 | `DD33660ADE8D99F529F877D0660662E007A82A1328A2191AAFC6A904A2F0CB9A` |

### 2.3 Baseline verification

The first two-minute aggregate check timed out while the process was still
running. The checks were then executed individually with a sufficient timeout:

| Check            | Result                                           |
| ---------------- | ------------------------------------------------ |
| `pnpm lint`      | pass, 7 packages                                 |
| `pnpm typecheck` | pass, 7 packages                                 |
| `pnpm test`      | pass; domain 11, config 6, bridge 4, HQ 16 tests |
| `pnpm build`     | pass; Next.js 16.3.1, 147 static/SSG pages       |

### 2.4 Current implementation inventory

- `@gremuchaya/ui` currently exposes `Panel`, `StatusBadge`, and `WindowFrame`.
- No Base UI or Radix imports exist at baseline.
- The application contains approximately 172 direct `<button>` elements,
  16 direct `<input>` elements, and 18 direct `<select>` elements.
- Nine `fetch` call sites exist and must be classified as static asset,
  provider SDK, or business transport before replacement.
- Same-browser synchronization currently uses `BroadcastChannel`.
- Persistent operations state currently uses local storage.
- The existing file bridge is gRPC-Web and read-only by default; its local
  material-import capability is enabled only by an explicit non-read-only
  configuration.
- A Yandex tactical map component and surveillance assets already exist.
- The Tauri native filesystem implementation is read-only.

## 3. Requirement traceability

| ID            | Requirement                                                | Primary subsystem          | Acceptance gate                       |
| ------------- | ---------------------------------------------------------- | -------------------------- | ------------------------------------- |
| RQ-BASEUI-001 | Base UI is the headless foundation without visual redesign | `packages/ui`              | visual and interaction contract tests |
| RQ-BASEUI-002 | No direct Base UI imports in features                      | lint boundaries            | forbidden-import test                 |
| RQ-API-001    | First-party business REST is replaced by Protobuf RPC      | protocol/control-plane     | contract and transport tests          |
| RQ-MAT-001    | Upload arbitrary files in the application                  | material service/agent     | browser and desktop upload E2E        |
| RQ-MAT-002    | Cloud plus `shared/materials` mirror                       | storage/agent              | two-client mirror E2E                 |
| RQ-MAT-003    | Replace, trash, restore, purge, versions, quotas           | material service           | lifecycle integration suite           |
| RQ-MEDIA-001  | Custom terminal surveillance player                        | media package/video screen | player E2E and visual baseline        |
| RQ-MAP-001    | Yandex Maps JavaScript API v3                              | map adapter                | provider and fallback tests           |
| RQ-LAYOUT-001 | No page scroll and no avoidable empty grid area            | layout engine              | viewport occupancy suite              |
| RQ-EDIT-001   | Safe interactive editor with snapping dock                 | edit system                | DnD, validation, history E2E          |
| RQ-SET-001    | Extensive settings and category/global reset               | settings schema            | schema/reset tests                    |
| RQ-SYNC-001   | Groups, pairing, roles and realtime state                  | sync/control-plane         | multi-client latency suite            |
| RQ-I18N-001   | Russian and English localization                           | i18n                       | catalog and expansion tests           |
| RQ-GH-001     | Issue draft and translation draft PR                       | GitHub App integration     | sandbox repository test               |
| RQ-TEL-001    | Real and deterministic simulated telemetry                 | Rust/telemetry             | collector and determinism tests       |
| RQ-WIN-001    | Native Windows 10/11 shell                                 | Tauri/Rust                 | Windows VM matrix                     |
| RQ-WIN-002    | Windows 7-8.1 legacy shell                                 | WRY compatibility shell    | WebView2 109 VM matrix                |

## 4. Base UI migration matrix

Base UI is installed as an exact version. Only direct component entry points
are imported. The project design tokens, square geometry, typography, focus
patterns, spacing, borders and animation timings remain authoritative.

| Current primitive     | Base UI primitive | Public wrapper        | Preserved contract          | Required tests              |
| --------------------- | ----------------- | --------------------- | --------------------------- | --------------------------- |
| native/project button | Button            | `TerminalButton`      | size, tone, border, loading | pointer, keyboard, disabled |
| icon button           | Button            | `TerminalIconButton`  | square hit target           | label, tooltip, focus       |
| checkbox              | Checkbox          | `TerminalCheckbox`    | square mark                 | checked, mixed, disabled    |
| switch                | Switch            | `TerminalSwitch`      | terminal toggle             | label, keyboard, form       |
| radio group           | Radio             | `TerminalRadioGroup`  | compact rows                | arrows, selection           |
| text input            | Input/Field       | `TerminalInput`       | field frame                 | label, invalid, disabled    |
| numeric input         | NumberField       | `TerminalNumberField` | numeric controls            | min/max/step                |
| select                | Select            | `TerminalSelect`      | popup list                  | focus, typeahead, collision |
| filter input          | Combobox          | `TerminalCombobox`    | search list                 | async/empty/keyboard        |
| range                 | Slider            | `TerminalSlider`      | square handles              | keys, pointer, bounds       |
| tabs                  | Tabs              | `TerminalTabs`        | tab strip                   | arrows, Home/End            |
| toolbar               | Toolbar           | `TerminalToolbar`     | dense action row            | roving focus                |
| dropdown              | Menu              | `TerminalMenu`        | terminal menu               | nested/checked/disabled     |
| right-click popup     | ContextMenu       | `TerminalContextMenu` | contextual menu             | right click/long press      |
| modal                 | Dialog            | `TerminalDialog`      | framed overlay              | trap, Escape, return focus  |
| destructive modal     | AlertDialog       | `TerminalAlertDialog` | danger confirmation         | cancel/confirm              |
| anchored popup        | Popover           | `TerminalPopover`     | collision-safe surface      | controlled/uncontrolled     |
| hint                  | Tooltip           | `TerminalTooltip`     | compact hint                | delay, focus, hover         |
| side panel            | Drawer            | `TerminalDrawer`      | edge panel                  | drag/dismiss/focus          |
| notifications         | Toast             | `TerminalToast`       | status stack                | F6, action, dismiss         |
| progress              | Progress          | `TerminalProgress`    | square meter                | determinate/indeterminate   |
| bounded scroll        | ScrollArea        | `TerminalScrollArea`  | local scroll only           | keyboard/wheel/resize       |
| separator             | Separator         | `TerminalSeparator`   | one-pixel terminal line     | orientation                 |

Migration procedure for every row:

1. Capture the current component state matrix and computed dimensions.
2. Add the Base UI adapter inside `packages/ui`.
3. Reapply existing classes and CSS custom properties.
4. Add semantic, keyboard and state-attribute tests.
5. Replace feature usage through the public wrapper.
6. Run typecheck, unit tests, affected Playwright flows and visual comparison.
7. Remove the old implementation only after the gate passes.

Allowed DOM changes are limited to ARIA attributes, Base UI state attributes,
portal nodes and focus guards. Color, spacing, border, font metrics, radius,
placement and animation timing are not allowed to drift.

## 5. Target workspace and dependency boundaries

### 5.1 Applications

- `apps/hq`: Next.js UI and static desktop export.
- `apps/control-plane`: Node.js ConnectRPC service for cloud operations.
- `apps/hq-agent`: Rust service for local storage, mirror, media and telemetry.
- `apps/hq-shell-legacy`: WRY/Tao WebView2 109 compatibility shell.
- `apps/file-bridge`: compatibility bridge during the migration; removed only
  after agent parity.

### 5.2 Packages

- `packages/ui`: Base UI adapters and the preserved terminal design system.
- `packages/protocol`: common/material/settings/sync/telemetry/integration proto.
- `packages/config`: validated runtime and settings schemas.
- `packages/domain`: transport-independent entities and policies.
- `packages/layout-engine`: responsive tile registry and deterministic packing.
- `packages/media`: Vidstack viewers and player adapters.
- `packages/sync`: Yjs documents, clock alignment and reconnect policy.
- `packages/i18n`: Russian/English catalogs and contribution validation.
- `packages/telemetry`: source registry, simulation and chart transforms.

### 5.3 Boundary enforcement

- ESLint `no-restricted-imports` prevents feature imports from Base UI.
- Client-only Base UI adapters start from a `use client` entry point.
- Server-only control-plane modules are never imported by `apps/hq`.
- Heavy map, player, viewer and edit-mode modules are dynamically loaded.
- No business state is stored inside Base UI ephemeral interaction state.

## 6. Public RPC implementation order

### Wave A: common and health

- Add `ResourceId`, `Revision`, `MutationContext`, pagination, filters, sorting,
  setting values and structured errors.
- Replace bootstrap JSON assumptions with typed `Health` RPC.
- Reject HTML and unexpected content types without passing them to JSON parsers.
- Preserve local/offline startup when the cloud endpoint is unavailable.

### Wave B: materials

- Implement list/get/begin upload/upload status/complete/cancel.
- Implement versions, metadata, trash, restore, purge and grants.
- Use a 16 MiB multipart chunk and four-part concurrency.
- Use signed private Blob transfers for large payloads.

### Wave C: settings and synchronization

- Implement draft patch, atomic publish, category/element/global reset, history
  and watch streams.
- Implement groups, pairing, roles, authority modes, presence and time sync.
- Use Yjs/Yrs for collaborative documents and ordered commands for playback.

### Wave D: telemetry and integrations

- Implement real/simulated telemetry streams and profiles.
- Implement issue drafts and translation draft pull requests through a GitHub
  App with explicit user confirmation.

## 7. Material storage execution details

Target local layout:

```text
shared/materials/
  objects/blake3/<prefix>/<hash>
  previews/<material>/<version>/
  thumbnails/<material>/<version>/
  imports/
  exports/
  quarantine/
  trash/
  .hq/state.sqlite3
  .hq/locks/
  .hq/upload-cache/
  .hq/sync-cache/
  .hq/jobs/
```

Implementation invariants:

- Atomic temporary-write plus rename.
- BLAKE3 content address and deduplication within an authorized group.
- Stable material ID and immutable version records.
- 30-day trash retention.
- No physical deletion while any active version references the object.
- Default 5 GiB file and 100 GiB group quotas.
- No whole-file buffering in browser, Node or Rust.
- Browser hashing in a worker; desktop hashing in Rust.
- Conversion jobs use leases, heartbeat, timeout and cancellation.
- Unsupported formats still expose metadata, download and system-open actions.

## 8. Settings and editor execution details

Settings categories: general, information, layout, tiles, themes, styles,
colors, typography, size, density, background, patterns, animations, startup,
player, cameras, map, tables, popups, shortcuts, localization, date/time,
telemetry, simulation, groups, materials, title bar, accessibility,
performance, privacy, diagnostics, GitHub and advanced.

Effective order: factory defaults, theme/style, published group state, device
overrides, local draft, session preview, platform safety override.

Edit mode uses a descriptor registry. It permits typed content, token, layout,
visibility, data-source and animation changes. It rejects arbitrary HTML,
JavaScript, CSS, executable URLs and security-sensitive mutations.

The edit dock must support magnetic docking, responsive drag/resize, valid drop
zone highlighting, local undo/redo, instant preview, atomic group publish and
explicit live-edit mode.

## 9. Layout implementation details

- Root is exactly `100dvh` with document overflow hidden.
- Grid columns: 32 ultra-wide, 24 desktop, 16 medium, 12 compact and 6 narrow.
- Every tile declares minimum/maximum dimensions, presentation modes, priority,
  stretch policy, relocation route and internal-scroll permission.
- Resolver normalizes, compacts, stretches, downgrades presentation, relocates
  and verifies occupancy deterministically.
- Tables scroll only their virtualized rows; trees and documents scroll only
  their bounded viewport.
- A free rectangle at least the size of a minimum grid cell is a development
  diagnostic failure unless explicitly reserved by the screen descriptor.

## 10. Media and map implementation details

- Vidstack remains the media engine; Base UI wraps settings, menus, tooltips,
  dialogs and notifications.
- Support bundled MP4/WebM demo loops, assigned local/Blob materials and an
  explicitly approved local webcam. The existing RTSP/FFmpeg gateway is an
  opt-in compatibility adapter, not a production camera requirement.
- Camera page contains the primary player, metadata rail, timeline, camera grid,
  storage, signal, active channel, network, logs, map, intercepts, recognition
  and telemetry panels.
- Hidden cameras do not decode.
- Yandex Maps JavaScript API v3 is loaded lazily in a client-only adapter.
- Missing key/network renders a useful coordinate/object status tile and causes
  layout redistribution rather than a blank panel.
- Yandex, Vercel and GitHub authentication is interactive; browser credentials
  are never extracted.

## 11. Realtime and history implementation details

- Device identity uses Ed25519.
- Pairing codes are one-time, role-scoped and expire after 10 minutes.
- Regular pairing creates viewer/editor membership, never admin.
- Leader and multi-authority modes are supported.
- LAN propagation target p95 is 50 ms; Internet target p95 is 250 ms.
- Playback timestamps have millisecond precision; stabilized drift target is
  at most 80 ms.
- Reconnect uses backoff, resume token, missed sequence or snapshot recovery.
- Local history is stored in SQLite/IndexedDB; group history is append-only in
  PostgreSQL and supports cursor pagination, filters, sorting and revert.

## 12. Windows execution details

- Modern target: Windows 10 1803+ and Windows 11 using Tauri.
- Frameless title bar uses Rust hit testing, native drag/resize, system menu,
  correct work-area maximize, DPI handling and Windows 11 DWM rounding.
- Legacy target: Windows 7-8.1 x64 using a separate WRY/Tao shell and WebView2
  109 Fixed Version Runtime.
- Base UI primitives receive a WebView2 109 compatibility test. Only primitives
  that cannot be safely polyfilled receive a legacy adapter behind the same
  `@gremuchaya/ui` API.
- Internet synchronization is disabled by default on unsupported legacy OSes.
- Vista and older Windows are out of scope.

## 13. Implementation phases and gates

### Phase 0 — baseline and plan

- [x] Inspect repository and local Next.js documentation.
- [x] Record toolchain, hashes, UI/network inventory and verification results.
- [x] Create this document before application source changes.
- [ ] Capture component and screen visual baselines before primitive replacement.

Historical limitation: this checkout did not contain a committed pre-migration
component snapshot set from which a trustworthy "before" image could be
reconstructed. Source hashes and baseline build results are preserved above.
Post-migration component snapshots were added as the current visual contract;
the missing historical evidence is deliberately not marked complete.

### Phase 1 — Base UI foundation

- [x] Install exact `@base-ui/react@1.7.0` in `packages/ui`.
- [x] Add client entry points and terminal primitive styles.
- [x] Implement Button, Dialog, Menu, ContextMenu, Tooltip and Toast adapters.
- [x] Add shared portal/toast providers.
- [x] Add forbidden-import lint boundary.
- [x] Add semantic, keyboard and state tests.
- [x] Verify the modern web/desktop visual contract without redesign.

Gate: package build/typecheck/tests, application build, focused Playwright and
visual comparison pass. The modern-target gate passes. WebView2 109 remains a
separate legacy compatibility gate and is not implied by this phase status.

### Phase 2 — complete primitive migration

- [x] Fields and numeric fields.
- [x] Checkbox, switch and radio.
- [x] Select, combobox and slider.
- [x] Tabs, toggle and toolbar.
- [x] Popover, drawer and alert dialog.
- [x] Progress, scroll area and separator.
- [x] Migrate `SettingsScreen` and the legacy `OpsUi` tooltip/drawer as the
      first feature-screen wave.
- [x] Replace direct controls screen by screen through public wrappers.

Gate: no unauthorized Base UI imports, no obsolete primitive dependency and
keyboard/accessibility coverage for every public wrapper. The modern feature
tree contains zero direct JSX `button`, `input`, `select`, or `textarea`
elements. The CI boundary now rejects both direct Base UI imports and direct
interactive JSX controls outside `packages/ui`. The modern Phase 2 gate passes;
WebView2 109 remains governed by the separate legacy compatibility phase.

### Phase 3 — protocol and control-plane

- [x] Expand Protobuf services.
- [x] Add generated TypeScript code.
- [x] Add generated Rust code.
- [x] Create Node control-plane foundation with typed health and capability discovery.
- [x] Add Neon schema/migrations and lazy connection initialization.
- [x] Add Upstash-backed presence, coordination and rate limits.
- [x] Add binary WebSocket reconnect/resubscribe behavior (Vercel deployment
      verification remains a production-hardening task).

Checkpoint: `gremuchaya.common.v1` now defines resource IDs, revisions,
mutation context, typed settings values, cursor pagination, filters, sorting and
machine-readable errors. Versioned Control, Material, Settings, Sync, Telemetry
and Integration services expose every RPC named in the target contract, with
server-streaming envelopes for watch/telemetry methods. Buf STANDARD lint passes,
TypeScript code is generated with Protobuf-ES 2.14, and contract tests lock the
RPC method sets and binary round trips. A hash-before/generate/hash-after CI gate
rejects stale checked-in TypeScript bindings. `apps/control-plane` serves typed
`Health` and `GetCapabilities` over binary gRPC-Web/Connect with an origin
allow-list and no REST health endpoint. Infrastructure capabilities remain
disabled until their real adapters are implemented. The Tauri native shell now
generates the same eight packages through `prost-build` with a vendored
`protoc`, avoiding a machine-wide compiler dependency. The generated public
module is `gremuchaya_hq_lib::protocol::v1::gremuchaya`; its regression test
proves binary round-trip compatibility across the common and material package
boundary. `cargo test --manifest-path apps/hq/src-tauri/Cargo.toml` passes.
The control-plane also has a lazy Neon HTTP adapter and a production schema
migration `0001_control_plane_foundation`: the 26 product tables from the
target data model plus a checksum ledger are created in advisory-locked,
idempotent transactions. No database connection is created by a health-only
control-plane start; the explicit `pnpm --filter @gremuchaya/control-plane
migrate` command requires `HQ_CONTROL_PLANE_DATABASE_URL` and is the only
operation that touches the configured Neon project.
The lazy Upstash coordination adapter requires an HTTPS REST URL and a paired
server-only token. It namespaces per-group presence records and their TTL index,
uses compare-and-expire/delete scripts for leader leases, provides monotonic
stream sequences, and uses the upstream sliding-window primitive for mutation
rate limiting. Redis is explicitly non-authoritative: the persisted PostgreSQL
documents remain the recovery source after cache eviction or restart.
The control-plane now also exposes the binary Protobuf endpoint `/realtime` on
the same HTTP server. Its explicit `ClientHello` cursor replays retained group
events after reconnect, continues live delivery, and produces `resync_required`
instead of a partial replay when the bounded retained range has expired. Text
or malformed frames return typed error envelopes; WebSocket upgrades use the
same Origin allow-list as gRPC-Web. The hub is intentionally single-process and
in-memory at this stage: durable history, device/pairing authorization and
cross-instance Redis fanout remain SyncService implementation work, while
actual Vercel deployment validation remains part of production hardening.

### Phase 4 — layout and settings

- [ ] Implement tile registry and deterministic packing.
- [ ] Eliminate document scrolling.
- [ ] Add settings schemas, drafts, reset, import/export and history.
- [ ] Recompose all screens against responsive layouts.

Current implementation checkpoint: the isolated `@gremuchaya/layout-engine`
package now resolves a bounded, stable priority-first grid. It selects the
richest variant that fits, compacts positions, stretches declared safe gaps,
and uses an explicit relocation/hide policy instead of silently expanding the
document. Its three unit tests cover determinism, compact/relocate/hide policy
and required-tile failure. The complete screen registry and all-screen CSS
integration are intentionally still pending.

`@gremuchaya/settings-schema` now defines 32 schema-bound personalization
categories and safe factory defaults. Its draft operations provide typed patch,
category reset, full reset, discard/publish, JSON export/import parsing and
append-only local history. Every definition now also derives safe editor
metadata from the same validator that accepts mutations: boolean, enum, bounded
number or comma-delimited string-list. The Settings screen consumes that
metadata through Terminal/Base UI wrappers, so it exposes all 32 categories in
one selectable catalogue without inventing an unvalidated free-form control.
Each selected category has its own reset, while draft discard, full reset,
atomic publish, browser export and schema-validated file import remain global
operations. At 1280×720 only the settings pane scrolls; document and workspace
overflow stay locked and the grid uses dense placement to reuse free cells.

The immediate preview currently applies theme, density, bounded type/size
scale, accent family, style mode, background, focus pattern and
reduced-motion-safe animation state. Image/video background selections stay on
a deterministic terminal fallback until they can be bound to a validated
material, rather than accepting arbitrary filesystem paths or URLs.
Feature-specific settings (player, map, materials, groups and telemetry) are
represented and validated but await their corresponding service/screen phases;
cloud/group settings history will arrive with SettingsService implementation.
Existing screen layout is likewise not yet fully re-composed around the new
resolver.

### Phase 5 — materials and viewers

- [~] Add bounded local material import foundation in the file bridge.
- [ ] Add Rust local storage index and write support.
- [ ] Add upload/version/trash/mirror RPC.
- [ ] Add private Blob integration.
- [~] Add safe bounded local viewer paths (image/PDF/text/audio/video).
- [ ] Add viewer registry, conversion jobs and large-media streaming adapters.

### Phase 5 local material bridge checkpoint — 2026-08-16

`apps/file-bridge` now has a deliberately limited local material-import
vertical slice behind two local configuration gates: `readOnly: false` and
`materialImport.enabled: true`. Its generated binary gRPC-Web contract exposes
begin, ordered chunk upload, status, completion, cancellation, cursor-paged
listing and server-streamed material reads. Import data is written to
`shared/materials/.hq/upload-cache`, hashed by BLAKE3 as a stream, atomically
renamed into `.hq/objects/blake3/<prefix>/<hash>`, and indexed through separate
JSON material records. The importer enforces a configured maximum up to 5 GiB,
64 KiB--16 MiB chunk bounds, safe filenames, sequential offsets and expected
hash verification. Equal content is deduplicated while receiving a separate
material record; hash mismatches are quarantined.

The ordinary bridge explorer hides `.hq` completely, rejects direct requests
for it as permission-denied and verifies canonical paths before streaming an
imported object, so a locally introduced symlink cannot escape the configured
mirror root. Configuration normalization happens at the executable boundary,
which keeps older read-only configuration files safely read-only after the new
property is introduced.

The first checkpoint is covered by eight file-bridge unit/integration tests
(including a real binary gRPC-Web upload/read round-trip), configuration tests,
TypeScript typecheck/lint and deterministic `check:protocol-generation`.
The web client now adds an opt-in hidden local-import dialog on the Files screen
through `Ctrl+Shift+Alt+S`. Before an upload starts, a browser module worker
computes BLAKE3 incrementally from `File.stream()` and supplies the result as an
expected hash; the bridge still recomputes the authoritative digest while it
commits the object. A stream-based in-context fallback is retained for the
legacy shell if a module worker is unavailable. The transport adapter then
streams browser `File` data in bridge-provided bounded chunks, reports hash and
transfer progress, supports cancellation and lists local records through the
cursor contract; entries are projected into the Files registry as `LOCAL MIRROR
/ GRPC-WEB`. A browser regression locks the dialog, terminal wrapper contract
and 720p page-scroll invariant.

It is not a claim of the full material requirement: no `MaterialService` cloud
handler, Vercel Blob, authenticated group grant, persistent resume after a
bridge restart, MIME sniffing/conversion, version lifecycle, trash retention or
cross-client mirror synchronization exists yet.

### Phase 6 — video and map

- [~] Add custom Vidstack terminal player.
- [~] Add demo/material/webcam registry and bounded camera-style grid; retain
  RTSP only as a disabled-by-default compatibility adapter.
- [x] Add gRPC-issued, revocable loopback HTTP Range grants for large local
      material video without renderer buffering or path disclosure.
- [x] Add Yandex Maps JavaScript API v3 adapter and fallback.
- [~] Add synchronized playback; browser-local epoch/sequence transport is
  complete, while the authenticated control-plane adapter remains pending.

### Phase 6 Vidstack checkpoint — 2026-08-16

The primary surveillance feed now uses the exact React-19-compatible
`@vidstack/react@1.15.6` engine rather than a feature-owned `<video>` element.
The application retains its existing terminal transport rail and Base UI
buttons/sliders/selects; no Vidstack default CSS or layout is imported. Its
player instance now owns source loading, duration/current-time state,
play/pause, seeking, volume, rate, fullscreen and picture-in-picture. The
existing screenshot operation deliberately obtains the native video only via
Vidstack's typed video provider, not through an uncontrolled DOM query.

This is a player-foundation checkpoint, not a claim of the full media phase:
local material video/audio up to the explicit 32 MiB bounded-preview limit can
already use the same custom Vidstack control surface, but larger material media
requires a dedicated streaming source adapter. Quality/subtitle menus,
HLS/LL-HLS and RTSP/FFmpeg gateway, marker/annotation storage and synchronized
playback remain pending. The custom terminal CSS contract and existing
surveillance controls were preserved; 24 Playwright operator flows still pass
at 720p after the migration.

### Phase 6 Yandex Maps JavaScript API v3 checkpoint — 2026-08-16

The tactical map adapter now loads the official v3 endpoint lazily only on the
map route and waits for `ymaps3.ready` before creating `YMap` vector layers.
The terminal visual contract remains owned by application CSS: the provider
only renders the basemap, while the application renders terminal DOM markers,
routes, restricted polygons, alerts and sensors through v3 entities. A narrow
provider boundary is explicit about the coordinate conversion from the
operational `[latitude, longitude]` model to the v3 `[longitude, latitude]`
model, preventing a silent axis swap.

The adapter accepts a build-time `NEXT_PUBLIC_YANDEX_MAPS_API_KEY` or an
explicit device-local v3 key. It deliberately does not reuse a legacy v2 local
key. Missing keys, provider load failures and vector-layer failures retain a
non-empty coordinate/object fallback tile rather than a blank or synthetic map.
The user must create and restrict the v3 key interactively in Yandex Developer
Dashboard; no browser profile or credential is read. A browser regression
intercepts the v3 endpoint, verifies the exact SDK URL and proves that the
fallback remains usable when the provider is unavailable.

The completed local gate is `pnpm --filter @gremuchaya/hq typecheck`, lint,
22 unit tests, an optimized 147-route Next.js build and the full 25-scenario
Chromium suite, including the provider-URL and no-provider map flows. The
obsolete `@types/yandex-maps` 2.1 package was removed rather than retained as
a misleading v2 type dependency.

This is not a key-provisioning or full tactical-map completion claim: a real
production key, origin allowlist, optional clusterer plugin, offline tile cache,
group-synchronized viewport and provider availability monitoring remain
deployment/integration work.

### Phase 6 camera registry checkpoint — 2026-08-17

The surveillance screen now projects all 16 domain cameras through one typed
browser registry rather than hard-coding the first 12 tiles. The terminal grid
uses a bounded 12-channel page, exposes deterministic filtering and sorting,
and keeps the remaining four channels reachable on page two. Sparse filtered
pages receive an operational query-summary surface instead of leaving an empty
grid rectangle. Only the selected main feed is attached to Vidstack; thumbnail
tiles remain static and therefore do not allocate hidden media decoders.

Each registry entry contains an opaque stream ID, browser-safe source, bounded
local fallback and thumbnail reference. When
`NEXT_PUBLIC_HQ_RTSP_GATEWAY_ORIGIN` is configured, the browser requests
`/v1/streams/<opaque-stream-id>/index.m3u8` over HTTP(S). Credential-bearing,
query-bearing, fragment-bearing and non-HTTP(S) origins are rejected. Neither
RTSP URLs nor camera credentials are represented in client state. A provider
failure is scoped to the selected camera and deterministically falls back to
the bundled WebM source.

The checkpoint is covered by registry unit tests for paging, filtering,
signal-order sorting, origin validation, thumbnail wrapping and secret-free
gateway URLs, plus a 1280×720 browser flow for the 12+4 page transition,
signal-loss filtering, channel selection and document overflow invariants.

The completed local gate includes formatting, strict TypeScript, ESLint, 26
unit tests, the Base UI import/native-control boundary check, an optimized
147-route Next.js build and the complete 26-scenario Chromium suite.

This camera-registry checkpoint partially completed the grid task. At that
point it did not yet claim an implemented Rust/FFmpeg RTSP ingestion service,
signed HLS grants, gateway
health/reconnect policy, multi-quality HLS ladder or cross-client playback
synchronization. Those server and realtime portions remain pending, so the
phase item intentionally remains `[~]` rather than `[x]`.

### Phase 6 native RTSP→HLS gateway foundation — 2026-08-17

The Tauri shell now owns a bounded loopback media gateway instead of requiring
the webview to know an RTSP endpoint. Native configuration is read from an
explicit regular, non-symlink JSON file capped at 1 MiB. Camera URLs and
credentials remain native-side and are never serialized through an invoke
response, browser store or application log. FFmpeg receives the RTSP URL as a
direct argv value without shell interpolation; a same-user process inspector
may still observe it. Eliminating that exposure requires a future Credential
Manager plus native libav or protected credential-handoff adapter. The webview
sends only a validated camera ID and per-component consumer ID.

The gateway binds exclusively to `127.0.0.1` on an ephemeral port. FFmpeg is
spawned directly without a command shell, with stdin/stdout/stderr detached,
`kill_on_drop` enabled and a ten-second manifest readiness gate. The default
copy profile minimizes CPU usage for browser-compatible H.264 sources; an
explicit per-camera transcode profile uses low-latency H.264/AAC. HLS output is
bounded to six two-second entries, uses `delete_segments`, and is removed when
the last consumer releases its lease. Global worker capacity defaults to four
and is hard-bounded to 16.

Each active worker receives a cryptographically random 256-bit hexadecimal
grant embedded in the URL path. Axum serves only the active worker's exact
playlist and whitelisted segment filenames; it exposes no directory listing
and rejects traversal-shaped IDs and assets. CORS is limited to known Next dev
and Tauri origins, while the Tauri CSP permits loopback media/connect traffic
without opening a remote host. Closing the control window drains workers and
requests graceful HTTP shutdown.

The React client validates every native descriptor again before handing it to
Vidstack: HTTP only, hostname exactly `127.0.0.1`, no credentials/query/hash,
opaque stream syntax, 64-hex grant and `index.m3u8`. Native startup failure,
manifest timeout or playback failure retains the bounded local WebM fallback.
The ordinary web build never invokes the native gateway and remains compatible
with the external browser-safe gateway origin.

This is a functional local ingestion foundation, not the completion of the
production media phase. Windows Credential Manager integration, protection
from local process-argument inspection, expiring or rotating grants, automatic
restart/backoff, GPU encoder selection, multi-quality and LL-HLS ladders,
recording retention, authenticated group authorization, metrics and
synchronized playback remain pending. The parent Phase 6 item therefore
remains `[~]`.

The completed gate includes `cargo fmt --check`, `cargo check --all-targets`,
nine Rust tests, Clippy with warnings denied, strict TypeScript, ESLint, 28
frontend unit tests, the Base UI/native-control boundary, optimized web and
desktop static builds with 147 routes each, and the complete 26-scenario
Chromium regression suite.

### Phase 6 RTSP worker supervisor checkpoint — 2026-08-17

The native gateway now owns a continuously running worker supervisor rather
than deleting an active camera after the first FFmpeg failure. The supervisor
polls at a bounded 500 ms interval, detects exited processes and ten-second
manifest startup failures, terminates the failed child, and schedules a fresh
direct FFmpeg spawn. The retry policy uses deterministic per-camera jitter and
exponential backoff starting at 500 ms and capped at 30 seconds, so concurrent
camera failures do not immediately create a restart storm.

Worker identity is intentionally stable across restarts: `stream_id`, 256-bit
grant, generation, output directory and manifest URL do not rotate. The
selected Vidstack source can therefore recover at the same URL without sending
an RTSP address or a replacement grant through the webview. A successful
manifest probe moves the worker from `starting` to `ready`; a failed attempt
moves it through `reconnecting`, and five consecutive failures expose a
`degraded` state. Thirty seconds of stable execution resets only the
consecutive-failure backoff counter, not the lifetime restart counter.

The trusted Tauri status contract now includes deterministic per-stream health:
camera and opaque stream IDs, state, consumer count, consecutive failures,
lifetime restarts and last-manifest age. The loopback HTTP health route remains
aggregate-only and reports active, reconnecting and failed counts, avoiding a
camera inventory disclosure through the browser-facing endpoint.

The React client adds a cancellation-safe native startup retry sequence of 500
ms, 1 s, 2 s, 4 s and a repeated 8 s ceiling. Changing cameras clears the
pending timer and releases the previous consumer lease. A regular web client
still receives `null` from the native adapter and performs no retry, preserving
the static/exported browser contract and hydration output. If Vidstack
temporarily switches to the bounded local fallback after a native playback
error, a second lease-safe recovery loop waits for the same worker to become
ready, clears the fallback override and reloads the original stable HLS URL.

The regression layer now covers bounded deterministic backoff, worker failure
transition, stable grant/path/generation across a restart, degraded health
aggregation and client retry ceilings. Real RTSP camera acceptance,
manifest-stall detection, camera credential provisioning and recording
retention are no longer production requirements; the adapter is preserved only
for opt-in compatibility. Multi-quality material playback and synchronized
group playback still keep Phase 6 at `[~]`.

The completed gate includes `cargo fmt --check`, `cargo check --all-targets`, 12
Rust tests, Clippy with warnings denied, strict TypeScript, ESLint, 29 frontend
unit tests, the Base UI/native-control boundary, optimized web and desktop
static builds with 147 routes each, and the complete 26-scenario Chromium
regression suite.

### Phase 6 source-model correction — 2026-08-17

The user clarified that the product will not connect to real surveillance
cameras. The normative source model is now `DEMO_VIDEO`, `LOCAL_MATERIAL` and
an explicitly initiated local `WEBCAM`; all camera-like rows, thumbnails,
signal states and PTZ data are simulated presentation fixtures. UI labels must
identify demo loops and material playback instead of presenting them as real
live recording.

The webcam is a browser-local `MediaStream` acquired only from a button or
keyboard action. It is never requested on mount, persisted, uploaded, placed
in Zustand/group documents or transmitted to the bridge/control-plane. Track
cleanup is mandatory on stop, channel switch, request cancellation and screen
unmount. Permission denial and unavailable or busy hardware are recoverable UI
states, followed by the bundled demo fallback.

The Rust RTSP→HLS work remains preserved as an isolated compatibility adapter
behind explicit environment/configuration opt-in. Its committed example has no
camera URLs and starts no FFmpeg workers. A real RTSP fixture, camera credential
provisioning, recording retention and camera-fleet hardening are removed from
the Definition of Done rather than left as blocking Phase 6 work. The remaining
media work is material streaming beyond the bounded preview limit, richer
Vidstack menus and annotations, plus synchronized playback.

The corrected source-model gate passes formatting, strict TypeScript, ESLint,
31 frontend unit tests, the Base UI/native-control boundary, both optimized
147-route web and desktop builds, 12 Rust tests, `cargo check`, rustfmt, Clippy
with warnings denied and all 27 Chromium scenarios. The browser suite includes
a hardware-independent canvas `MediaStream` fixture proving explicit webcam
start, local playback, stop and deterministic return to `DEMO_VIDEO`.

### Phase 6 local material-to-channel checkpoint — 2026-08-18

The selected simulated channel on `/video` can now be bound to an imported
video material from the existing local mirror. The selector reads the bounded,
cursor-paged local catalogue through `BridgeMaterialClient`; it only offers
video MIME types that satisfy the current 32 MiB preview limit. This keeps
large-file streaming an explicit later phase instead of silently buffering a
large video in the renderer.

The persistent contract is deliberately narrow: local storage contains only a
validated `cameraId → materialId` UUID mapping. It never contains a material
path, a `file:` URI, raw bytes or a runtime `blob:` URL. When the active
channel needs that material, the screen performs the existing bounded binary
gRPC-Web read, makes one temporary object URL and revokes it when the material,
channel or screen changes. Missing or unreadable material falls back to the
demo loop while preserving a visible terminal status. No real camera, IP
camera discovery, RTSP configuration or automatic webcam permission is
introduced by this feature.

The source selector is a terminal Base UI wrapper, so its keyboard and focus
semantics stay consistent with the rest of the application. Browser-only
storage and object-URL work are deferred to client-side asynchronous effects;
the static export and SSR boundary do not read `window`, `localStorage` or
`URL.createObjectURL` during render. The browser regression covers restoration
of a persisted material assignment and clearing it back to `DEMO_VIDEO`, while
asserting that no runtime URL persists.

The completed gate passes `check:ui-boundary`, strict TypeScript, ESLint, 34
frontend unit tests, all 28 Chromium scenarios, and optimized web plus desktop
static exports with 147 routes each. The older native/Rust verification remains
valid because this increment changes only the React client and plan documents.

### Phase 6 large local-video range streaming checkpoint — 2026-08-18

The 32 MiB bounded-read ceiling remains mandatory for images, documents, text
and small audio/video previews, but it no longer prevents a large imported
video from becoming the source of a simulated channel. A large video is never
buffered into the renderer. `BridgeService.GetMaterialPlaybackGrant` first
issues a short-lived capability and Vidstack then uses a loopback HTTP byte
data plane with native `Range` seeking. `BridgeService.RevokeMaterialPlaybackGrant`
explicitly closes the capability when the source, channel or screen changes.
This exception transports media bytes only; all discovery, authorization,
metadata and lifecycle operations remain generated Protobuf over gRPC-Web.

The grant registry is in-memory and bounded to 256 active capabilities. A
grant has a five-minute sliding idle TTL, is limited to registered audio/video
materials, binds to `127.0.0.1`, and stores only a SHA-256 digest of its random
256-bit token. Its opaque URL contains a UUID and token but no material path,
query, credentials or fragment. The browser independently validates the exact
loopback origin and path shape before accepting the grant. The server checks
the exact application Origin, implements `GET`, `HEAD` and one RFC 7233 range,
returns `206`/`Content-Range` for valid seeking, `416` for invalid or multiple
ranges, and `404` after revoke, expiry or bridge shutdown. The streamed file
is piped from disk with backpressure; its size does not determine renderer or
bridge memory consumption.

The same lifecycle is used by the standalone material preview and by an
assigned simulated camera channel. Materials at or below 32 MiB retain the
simpler bounded gRPC-Web Blob path. A channel stores only the material UUID;
neither a grant token nor runtime URL is persisted or synchronized. Real/IP
cameras remain outside the product scope, automatic webcam permission remains
forbidden, and the disabled RTSP adapter is not reintroduced into the default
source model.

Verification covers registry issuance, wrong-token rejection, sliding expiry,
explicit revoke, unsafe MIME/origin denial, exact partial bytes, invalid range
handling, browser URL validation and cleanup on source change. The refreshed
final gate completed protocol generation/type validation plus 4 protocol tests,
file-bridge typecheck plus 12 tests, HQ unit/type/lint validation (39 tests),
the full 30-scenario Playwright run, the UI-boundary and repository-wide
formatting gates, and root typecheck/lint for all ten packages. Both web and
desktop-web production builds generated all 147 static routes successfully.
Richer Vidstack menus and annotations remain Phase 6 work; group-authorized
playback synchronization remains the deliberately separate Phase 7 task.

### Phase 6 browser-local playback synchronization checkpoint — 2026-08-18

The video screen now uses `PlaybackSyncCoordinator` rather than the generic
world-state broadcast for timing-sensitive media. Its commands deliberately
mirror the durable `SyncService.SessionCommand` shape: `epoch`, per-device
`sequence`, action, safe source target, position, rate, execution timestamp
and issuing device ID. A `BroadcastChannel` transport plus storage-event
fallback carries the command between windows of the same browser profile; a
transport interface keeps the Vidstack/UI surface independent from the future
authenticated WebSocket/Protobuf group transport.

Only `DEMO_VIDEO` and `LOCAL_MATERIAL` identities are valid targets. The
coordinator never serializes a filesystem path, Blob URL, loopback grant URL,
capability token or webcam `MediaStream`. Webcams, RTSP compatibility streams
and an unrecognized source stay strictly local. Each action is scheduled 40 ms
ahead, duplicated or stale per-device sequences are rejected, newer commands
supersede pending commands for the same source, and leader mode accepts only
the configured leader device. The player marks a material/source mismatch
instead of applying a command to different content.

The generic operations snapshot transport now omits `videoPlaying`,
`videoLive` and `videoPosition` when it applies a remote snapshot. This is a
necessary isolation rule: otherwise the ordinary Zustand broadcast could apply
a transient state before the ordered playback command and defeat scheduling.
The browser-local coordinator is covered by deterministic unit tests for
ordering, delayed execution, duplicate suppression, leader enforcement and
the absence of local media URLs, plus a two-page browser test that verifies
real demo-playback propagation without copying a local media capability. Its
dedicated cloud transport, time-sync offset estimation, group
membership/presence and cross-device SLO are deferred to the Phase 7
synchronization/control-plane completion work.

### Phase 7 — editor, sync, localization and telemetry

- [ ] Add edit descriptor registry and dock.
- [~] Add local settings history with reversible draft checkpoints; group
  collaboration, CRDT history and server-side retention remain pending.
- [ ] Add Russian/English catalogs and GitHub workflows.
- [ ] Add real Rust telemetry and deterministic simulation editor.

### Phase 7 local settings history checkpoint — 2026-08-18

The safe settings schema now exposes immutable, schema-validated draft
checkpoints. The browser-local SettingsHistoryLedger retains a bounded
before/after checkpoint for each patch, category reset, global reset, import,
discard, publish, restore, undo and redo action. A historical state is never
written directly into a published revision: selecting it loads the safe values
into the local draft, after which the existing publish action creates a new
revision.

The settings screen now has terminal-styled undo/redo actions and a dedicated
history pane. It provides local pagination, operation/category/setting/date
filters, newest/oldest sort order and a per-event load-to-draft command. The
history pane owns its overflow, so it does not introduce document scroll.
Stored v4 settings state is accepted and initialized with an empty ledger;
subsequent snapshots persist as v5.

This is intentionally not the group history promised by the final product:
there is no CRDT document, server event journal, cross-device authority or
group revert yet. Those capabilities remain coupled to the authenticated
SyncService work.

Verification for this increment: settings-schema has five passing unit tests,
HQ has thirteen passing unit files with forty-two tests, and the full Chromium
suite has thirty-one passing scenarios, including the visible history
filter/undo/redo flow and the existing 720p no-page-scroll assertion. Root
typecheck, Base UI import/control-boundary validation, Prettier and the
147-route production web build also pass.

### Phase 8 — native and release hardening

- [ ] Add modern native title bar and Windows integrations.
- [ ] Add legacy shell and compatibility matrix.
- [ ] Provision Vercel resources after interactive sign-in.
- [ ] Run full Windows, security, load, accessibility and recovery suites.
- [ ] Release `v1.0.0` only after all gates pass.

### 13.1 Actual phase state — 2026-08-18

This is an additive, evidence-based status audit. It does **not** rewrite the
requirements or retroactively convert a completed checkpoint into a closed
phase. A phase is closed only when every delivery item and its declared gate
pass. In particular, a green UI test suite proves the covered implementation
slice, not unrelated cloud, security, legacy-Windows or release requirements.

Status vocabulary:

- **closed (modern scope)** — all deliverables and gates stated for the modern
  web/desktop target pass; a separately declared legacy gate is not implied.
- **partial** — one or more useful, tested vertical slices exist, but one or
  more phase deliverables or final gates remain open.
- **not started** — the phase has no closure-grade delivery yet, even if a
  preceding phase created reusable prerequisites.

| Phase                                        | Actual status             | Completed checkpoints retained as evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Conditions still required before phase closure                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — baseline and plan                        | **partial**               | Repository/toolchain inventory, hashes, baseline build results, plan and post-migration visual contract snapshots exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | A trustworthy pre-migration component/screen snapshot set cannot be reconstructed from this checkout. Keep the documented historical-evidence exception; do not fabricate a `before` baseline. Closure requires explicit maintainer acceptance of that exception.                                                                                                 |
| 1 — Base UI foundation                       | **closed (modern scope)** | Exact Base UI package, terminal adapters for Button/Dialog/Menu/ContextMenu/Tooltip/Toast, portal/toast layer, import boundary and semantic/keyboard/state coverage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | WebView2 109 validation is deliberately outside this modern checkpoint and belongs to Phase 8 legacy hardening.                                                                                                                                                                                                                                                   |
| 2 — primitive migration                      | **closed (modern scope)** | Terminal wrappers cover the complete listed primitive catalog; feature code has no direct Base UI import or direct interactive JSX control outside `packages/ui`; modern accessibility and visual gates pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Record per-primitive WebView2 109 results during Phase 8; do not reopen this phase unless a modern regression breaks the public wrapper contract.                                                                                                                                                                                                                 |
| 3 — protocol and control-plane               | **partial**               | Versioned Protobuf surface, generated TypeScript/Rust bindings, binary Connect/gRPC-Web `Health` and `GetCapabilities`, Neon/Upstash foundations, immutable auth migrations `0002`/`0003`/`0004`, transaction-scoped advisory-lock migration serialization, a durable paired-device lifecycle with parameterized locked CTEs, configuration composition, session-bound access-token authentication, automatic fail-closed server activation, post-admission realtime revalidation, fail-closed pairing-code issuer/session binding, and a real PostgreSQL integration/concurrency suite covering simultaneous migration runners, one-time pairing redemption, refresh rotation, refresh replay and revoke. | Idempotency receipts, persistent group/history data, all remaining service handlers, cross-instance Redis fanout, production deployment and end-to-end control-plane SLOs.                                                                                                                                                                                        |
| 4 — layout and settings                      | **partial**               | Bounded tile resolver; 32 schema-bound settings categories; local drafts, resets, import/export, safe visual preview and local reversible history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Complete tile registry, all-screen responsive recomposition, full viewport/DPI matrix, no document scroll on every route, no unfilled layout defects, and remote/group SettingsService history.                                                                                                                                                                   |
| 5 — materials and viewers                    | **partial**               | Opt-in local binary gRPC-Web import, BLAKE3 addressing/deduplication/quarantine, safe bounded previews and revocable Range playback for large local video.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Rust persistent index/write layer, cloud MaterialService, Blob, versions, trash/restore/retention, conversion jobs, viewer registry and authenticated cross-client mirror.                                                                                                                                                                                        |
| 6 — video and map                            | **partial — not closed**  | Terminal Vidstack foundation; demo/material/webcam registry; paged camera grid; local material assignment; revocable Range playback; Yandex Maps JavaScript API v3 adapter/fallback; browser-local ordered epoch/sequence playback sync.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Quality/subtitle/track UX, complete HLS/LL-HLS material pipeline, marker/annotation and clip-export lifecycle, cloud material grants, authenticated group SyncService transport, time synchronization, presence/authority and LAN/Internet playback SLO verification. Real IP cameras are out of main scope; RTSP remains disabled-by-default compatibility only. |
| 7 — editor, sync, localization and telemetry | **partial**               | Schema-validated local settings history, undo/redo, filtered/paged local history and safe load-to-draft behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Edit descriptor registry/dock/DnD, CRDT and group history, ru/en catalogs, translation/GitHub workflows, Rust collectors and deterministic telemetry curve editor.                                                                                                                                                                                                |
| 8 — native and release hardening             | **not started**           | Tauri/file-bridge prerequisites from earlier phases are reusable but are not release closure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Native Windows titlebar/integration, legacy shell and WebView2 matrix, Vercel provisioning, security/load/recovery/VM validation, installers and final `v1.0.0` release.                                                                                                                                                                                          |

The Phase 6 wording is intentionally explicit: `Phase 6 validation refreshed`
means that the implemented local video/map slice was tested. It must never be
read as `Phase 6 closed`. The current phase checklist retains two completed
items and three partial items for exactly this reason.

### 13.1.1 Active L1 paired-device and realtime checkpoint — 2026-08-18

The following commits advance **L1 only**. They are deliberately smaller than a
claim of Phase 3 closure and preserve the closed modern Base UI surface and the
already-working local material/video checkpoints:

| Commit        | Narrow, verified effect                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence retained                                                                                                                                                                    | Not claimed at that checkpoint / still open now                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `c8a0dec`     | Adds versioned application contracts and deterministic generation guard.                                                                                                                                                                                                                                                                                                                                                                            | Protocol lint/typecheck/test and generated-source check.                                                                                                                             | Any service implementation.                                                                                                      |
| `132b61f`     | Adds health-only Connect/gRPC-Web control-plane and local realtime foundation.                                                                                                                                                                                                                                                                                                                                                                      | Control-plane lint/typecheck/build/test.                                                                                                                                             | Authentication or durable group state.                                                                                           |
| `e9a171f`     | Adds canonical opaque `DeviceSession` and refresh lifecycle contract.                                                                                                                                                                                                                                                                                                                                                                               | Protobuf binary round-trip coverage.                                                                                                                                                 | Runtime credential storage.                                                                                                      |
| `0996ea8`     | Adds `MutationContext` to pairing and refresh requests for later durable retry receipts.                                                                                                                                                                                                                                                                                                                                                            | Generated descriptor and binary request round trips.                                                                                                                                 | Receipt persistence/idempotent response replay.                                                                                  |
| `93ca235`     | Implements deterministic, injectable paired-device domain lifecycle with UUIDv7 IDs and purpose-separated HMAC token hashes.                                                                                                                                                                                                                                                                                                                        | 23 control-plane tests at that checkpoint.                                                                                                                                           | Production startup or durable database storage.                                                                                  |
| `0be3716`     | Exposes the six lifecycle RPCs through binary gRPC-Web with bootstrap/bearer gates and health-only fallback.                                                                                                                                                                                                                                                                                                                                        | End-to-end ConnectRPC lifecycle test, CORS and typed-error assertions.                                                                                                               | Activation later completed by `b89539b`; durable service coverage remains.                                                       |
| `1d90fb4`     | Appends immutable auth schema migration `0002`.                                                                                                                                                                                                                                                                                                                                                                                                     | Ordered migration/checksum/raw-credential tests.                                                                                                                                     | A Neon CTE repository consuming the schema.                                                                                      |
| `d960fe3`     | Carries an opaque short-lived credential only in binary realtime `ClientHello`.                                                                                                                                                                                                                                                                                                                                                                     | Deterministic generated binding and round trip.                                                                                                                                      | WebSocket admission by itself.                                                                                                   |
| `24af428`     | Requires injected group/device admission for realtime, with an explicit test-only development escape hatch.                                                                                                                                                                                                                                                                                                                                         | 27 control-plane tests, including authenticated WebSocket admission and replay.                                                                                                      | Redis fanout, durable event replay and deployment SLOs.                                                                          |
| `dff5976`     | Validates the all-or-nothing auth configuration, token lifetimes and credential-hash closure before durable composition.                                                                                                                                                                                                                                                                                                                            | Configuration unit tests reject incomplete or unsafe auth setup.                                                                                                                     | Creating or activating a durable runtime.                                                                                        |
| `c8faf10`     | Adds immutable migration `0003` for refresh-replay detection and group-membership integrity.                                                                                                                                                                                                                                                                                                                                                        | Migration ordering, checksum and raw-credential regression coverage.                                                                                                                 | A runtime that consumes the new integrity fields.                                                                                |
| `1777f51`     | Adds the durable paired-device adapter: bootstrap, pairing, refresh/replay, auth, list and membership-scoped revoke use parameterized locked CTEs.                                                                                                                                                                                                                                                                                                  | Eight durable-adapter tests plus the five domain-lifecycle parity tests.                                                                                                             | Server activation later completed by `b89539b`; real PostgreSQL concurrency and idempotency receipts.                            |
| `3622bbd`     | Adds an all-or-nothing configuration composition factory; it runs immutable migrations before returning the durable runtime, authenticated `SyncService` and realtime admission.                                                                                                                                                                                                                                                                    | Five factory tests prove health-only isolation, ordering, closure propagation and failure containment.                                                                               | Automatic use later completed by `b89539b`; pairing-code issuer binding remains.                                                 |
| `6a8cf84`     | Binds each access-token row to its owning session before deriving group, device, role or session identity, closing a cross-group join path.                                                                                                                                                                                                                                                                                                         | Focused token/session join plus revoke and expiry predicate regression coverage.                                                                                                     | Post-admission revalidation later completed by `49933e9`; live PostgreSQL proof remains.                                         |
| `b89539b`     | Activates the durable lifecycle automatically before server listen when auth is configured; health-only startup remains isolated and volatile overrides fail closed.                                                                                                                                                                                                                                                                                | Running-server tests cover isolation, migration-before-capabilities and rejected overrides.                                                                                          | Post-admission revalidation later completed by `49933e9`; real PostgreSQL and idempotency remain.                                |
| `ea2ef3b`     | Serializes every immutable migration decision inside one transaction-scoped advisory lock before ledger/outcome reads, with precise in-transaction applied/skipped results.                                                                                                                                                                                                                                                                         | Targeted migration/database suite: 2 files, 8 tests; strict typecheck and changed-file ESLint pass.                                                                                  | Live PostgreSQL/Neon contention validation and the remaining durable service work.                                               |
| `49933e9`     | Revalidates an admitted socket before protected frames and bounded idle checks; failure removes its subscription, clears credentials, emits neutral reauthentication and closes with policy `1008`.                                                                                                                                                                                                                                                 | Targeted realtime/startup/configuration suite: 3 files, 21 tests; strict typecheck, changed-file ESLint and independent full control-plane lint pass.                                | Fail-closed pairing-code issuer access/session binding, live PostgreSQL contention, idempotency and cross-instance invalidation. |
| _uncommitted_ | Binds a durable pairing code to the exact session and access token that created it via migration `0004_paired_device_pairing_issuer_binding`; `createPairingCode` locks and re-checks that live credential before insert, and `pairDevice` redemption requires the same credential to still be unrevoked and unexpired. Also fixes a real `tsc -b` failure: `DurablePairedDeviceRuntime.authenticateAccessToken` was not returning `accessTokenId`. | Durable lifecycle/startup suite: 4 files, 27 tests (2 new, structural/scripted-`SqlClient`); full control-plane suite 11 files/62 tests; strict typecheck and lint pass. See 13.1.2. | Real isolated PostgreSQL/Neon proof of this CTE under concurrent pairing/refresh/revoke; the rest of L1 below.                   |

Current verified L1 gate:

- The retained Protocol gate remains `pnpm --filter @gremuchaya/protocol lint`,
  `typecheck` and `test` (**5 protocol tests**) plus
  `pnpm check:protocol-generation`.
- The retained durable lifecycle/startup gate remains: `runtime.test.ts`,
  `durable-runtime.test.ts`, `configured-lifecycle.test.ts` and `server.test.ts`,
  now **27 targeted tests** (see 13.1.2) with strict control-plane `typecheck`
  and `lint`.
- `ea2ef3b` closes the structural migration-decision race: the advisory lock is
  the first statement of the one-transaction immutable migration run, ledger and
  outcome records are created/read only after that lock, and final applied/skipped
  results are derived in-transaction. Its focused `database`/`migrations` run
  passed **2 files / 8 tests**, followed by strict `typecheck` and changed-file
  ESLint. This is not live PostgreSQL/Neon contention proof.
- `49933e9` closes the P0 transport boundary: the exact access-token/group/device
  triple is revalidated before protected outbound ready/replay/event/pong frames,
  authenticated inbound acknowledgement/ping work, and a bounded idle check
  (10 ms–60 s, 15 s default). A failed check serializes subscription removal and
  credential clearing before neutral reauthentication error plus policy close
  `1008`; legacy `admit`-only adapters fail closed by reusing `admit`. Its focused
  realtime/server/configuration run passed **3 files / 21 tests**, followed by
  strict `typecheck`, changed-file ESLint and independent full control-plane lint.
- `b89539b` calls the configured lifecycle from `startControlPlane` before the
  HTTP server is created. Auth-configured startup therefore awaits migrations,
  exposes the durable `SyncService` plus authenticated realtime admission as one
  unit, and rejects volatile lifecycle/admission/unauthenticated-policy
  overrides. Health-only startup still performs no database or migration work.
- Realtime remains disabled by default. It opens only when an authenticated
  admission adapter is supplied, or when a caller explicitly selects the local
  development escape hatch; the latter is never a production capability.
- Fail-closed pairing-code issuer access/session binding (the subwave this
  section previously named as immediate) is implemented in both runtimes; see
  13.1.2 for the durable/Postgres side, which was the actual gap.

### 13.1.2 Fail-closed pairing-code issuer binding checkpoint — 2026-08-19

The in-memory `PairedDeviceRuntime` already bound a pairing code to the exact
issuing session and access token (`requireActivePairingIssuer`,
`createdBySessionId`/`createdByAccessTokenId`). `DurablePairedDeviceRuntime`
did not: `createPairingCode` recorded only `created_by_device_id`, and
redemption's `active_code_creator` re-checked only that the creator device
was still an active, non-revoked member — so a code survived its issuing
session being refreshed, replayed, or individually revoked as long as the
device stayed a group member. This was also, independently, a genuine `tsc -b`
failure in the checked-out source: `authenticateAccessToken` did not return
`accessTokenId`, which the shared `AuthenticatedDevice` contract requires.

Immutable migration `0004_paired_device_pairing_issuer_binding` adds nullable
`created_by_session_id` and `created_by_access_token_id` columns to
`pairing_codes`, referencing `device_sessions`/`device_access_tokens`.
`createPairingCode` now locks and re-validates the caller's own live session
and access-token row (not only device/membership/role) before inserting the
code, and persists both ids. `pairDevice` redemption now additionally joins
`device_sessions`/`device_access_tokens` on those exact ids, requiring
`revoked_at IS NULL` and `expires_at > now`, under the same row locks already
held for the group/pairing-code/membership rows.

This proves the three paths the plan requires without inferring authority
from device identity alone: normal refresh rotation retires the previous
access-token row (`REFRESH_ROTATED`) so a code bound to it stops matching;
refresh-replay revocation retires both the session and its access tokens
(`REFRESH_REPLAY`) with the same effect; and a pre-migration code has a NULL
`created_by_session_id`/`created_by_access_token_id`, which an inner join
never matches, so it fails closed instead of falling back to device-only
authority. Every failure path returns the same generic `UNAUTHENTICATED`
error already used for expired/consumed codes, so redemption does not leak
which specific check failed.

Verification: `pnpm --filter @gremuchaya/control-plane typecheck`, `lint` and
`test` pass — 11 files, 62 tests total; the durable lifecycle/startup subset
(`runtime.test.ts`, `durable-runtime.test.ts`, `configured-lifecycle.test.ts`,
`server.test.ts`) is 27 tests, including two new cases (stale issuer rejected
at issuance; absent/legacy binding rejected at redemption) and strengthened
assertions on the existing issue/redeem test. `migrations.ts` gained its
fourth immutable entry with dedicated checksum/content coverage in
`migrations.test.ts`. As with every other durable-adapter checkpoint in this
plan, these are structural tests against a scripted `SqlClient`: they prove
the generated SQL shape and parameter binding, not live PostgreSQL locking or
constraint behavior. Separately, the workspace root `package.json`
`packageManager` field was corrected from a locally unresolvable
`pnpm@11.22.0` back to the documented pinned `pnpm@10.12.3` (see
`docs/release/environment.md`); without that fix `pnpm typecheck`/`lint`/
`test` could not run at all in this checkout.

Not claimed: real isolated PostgreSQL/Neon proof of this exact CTE under
concurrent pairing/refresh/revoke, durable idempotency receipts, or any other
part of L1 below. This checkpoint is not yet committed to version control.

The real isolated PostgreSQL/Neon integration and concurrency suite that this
section previously named as the immediate subwave is now implemented and
passing; see 13.1.3.

### 13.1.3 Real PostgreSQL integration and concurrency checkpoint — 2026-08-20

Every durable-adapter test before this point asserted the _shape_ of generated
SQL against a scripted `SqlClient`. Such tests cannot observe advisory-lock
serialization, row locking, or whether a join actually eliminates a row, so
they could not close this gate. `apps/control-plane/src/postgres.integration.test.ts`
now executes the same code paths against a live PostgreSQL engine (Neon).

The suite is opt-in through `HQ_CONTROL_PLANE_TEST_DATABASE_URL`. Unset, it
skips and the default `pnpm test` run stays offline and deterministic
(**62 passed, 7 skipped**). It is destructive by design: it creates and drops
its own `hqtest_*` databases, which is how each run gets a genuinely clean
schema — the Neon HTTP driver ignores a `search_path` connection option, so
per-database isolation is the only workable mechanism here.

Seven scenarios pass against real PostgreSQL:

| Scenario                                             | What it proves                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simultaneous migration runners on a fresh database   | `pg_advisory_xact_lock` serializes startup: each migration is applied by exactly one runner and skipped by the other, and the ledger holds exactly one row per migration. |
| Pairing with a live issuing session and access token | Positive control — redemption genuinely works, so the negative cases below are not passing vacuously.                                                                     |
| Simultaneous redemption of one pairing code          | The `FOR UPDATE` redemption CTE admits exactly one device: one call succeeds, one fails, one `consumed_at` is set, and the group gains exactly one member.                |
| Refresh rotation `T1` → `T2`                         | Retiring the bound access token invalidates the code even though the session stays valid and re-authenticates.                                                            |
| Refresh-token replay                                 | Replay revokes the session family, and a code bound to the _current_ token is invalidated by that revocation alone.                                                       |
| Legacy code with `NULL` issuer binding               | A pre-0004 row fails closed while its creator is still an active admin, so rejection cannot come from device authority.                                                   |
| Device revoke                                        | Membership, sessions, access tokens and pending pairing codes are revoked together; the revoked bearer stops authenticating and refreshing.                               |

The suite was mutation-tested rather than merely observed green. Reverting the
issuer-binding joins in `pairDevice` fails **exactly** the three fail-closed
scenarios (rotation, replay, legacy) while the other four continue to pass.
That is the evidence that the pre-fix vulnerability was real and reachable
against a live database, and that these tests detect it rather than asserting a
tautology.

Gate: strict `typecheck`, `lint`, offline `test` (62 passed / 7 skipped) and the
online suite (7 passed). No connection string is committed; the credential is
supplied through the environment and `.env.example` documents the variable with
its destructive-use warning.

Not claimed: durable idempotency receipts, persistent group/history events, the
remaining service handlers, Redis cross-instance fanout, or deployment SLOs.
This suite also exercises a single control-plane process against one database —
cross-instance behavior remains unproven.

The **immediate non-skippable L1 subwave** is therefore now **durable
idempotency receipts with response replay**, so `MutationContext` can be relied
on for retries. Sections 13.1.4 and 13.1.5 record that subwave; 13.1.5 also
corrects an evidence claim made in 13.1.4. With every destructive lifecycle
mutation now covered, the **next non-skippable L1 subwave is persistent
group/history events**.

After that, the remaining L1 gates are persistent group/history events,
remaining service handlers, Redis cross-instance fanout and deployment SLO
proof. Only after these pass can `WatchGroup`, player-group ordering and
distributed behavior be claimed truthfully. The existing
`apps/control-plane` lockfile closure must be committed only with the final
workspace lockfile reconciliation after the already-pending layout/settings/
materials/video package manifests are committed; historical commit `132b61f`
therefore remains source-verified but is not independently frozen-install
reproducible.

### 13.1.4 Durable idempotency receipts checkpoint — 2026-08-20

`MutationContext.request_id` existed on the wire since `0996ea8` but nothing
read it, so a retry of a destructive mutation re-executed it. Two cases were
not merely wasteful but unrecoverable:

- **Pairing.** A lost `PairDevice` response leaves the code consumed and the
  device holding a membership it has no credentials for. The retry is rejected
  as an already-consumed code, and the one-time capability is gone.
- **Refresh.** A lost `RefreshDeviceSession` response leaves the client holding
  the token rotation just retired. The retry presents it, the replay detector
  correctly classifies that as a stolen credential, and the whole session
  family is revoked. A dropped packet therefore bricks a paired device.

Migration `0005_mutation_idempotency_receipts` adds `mutation_receipts`.
It stores **no response body**. Pairing and refresh responses carry raw bearer
credentials, so persisting them would replace "credentials are never stored"
with "credentials are stored for the receipt retention window" — a strictly
worse property than the problem being solved. The row holds a purpose-separated
HMAC of the request identifier, an opaque fingerprint of the semantic request
payload, and the identity of the rows the mutation produced.

A retry is therefore answered by **re-issuing credentials on the recorded
session**, not by replaying bytes. This is the honest reading of "response
replay" under a no-credential-at-rest constraint: the caller observes the
property it actually needs — the mutation ran exactly once, and it now holds
usable credentials for it.

The claim is a data-modifying CTE at the head of the existing single-statement
mutations. Every downstream CTE chains from it, so a refused claim makes the
whole statement a no-op rather than a second redemption, and the conflicting
`ON CONFLICT ... DO UPDATE` takes the receipt row lock, which serializes
concurrent retries of one identifier. `completed_at IS NULL` means exactly one
thing — the mutation did not commit — so a failed attempt leaves its identifier
re-claimable instead of burning it.

Fail-closed properties, each covered by a test:

| Property                                                | Why it matters                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A receipt records identity, never authority             | Membership, device status and session liveness are re-checked at replay, so a revoke still wins. |
| A reused identifier with a different payload is refused | A retry cannot inherit another request's credentials; the answer is `ALREADY_EXISTS`.            |
| The identifier is scoped per operation                  | One value used on two RPCs performs two mutations rather than colliding.                         |
| Receipts expire                                         | The window in which a recorded mutation can mint credentials is bounded.                         |
| Absent `request_id` changes nothing                     | Replay detection keeps its fail-closed meaning for clients that have not opted in.               |

Evidence. Ten deterministic runtime tests exercise behaviour, not SQL shape —
whether a retry performs a second mutation, whether it is misread as an attack,
whether a receipt survives a revoke. They were **mutation-tested**: disabling
receipt claiming fails 4; removing the replay-time authorization re-check fails
exactly the 2 revocation tests; ignoring the fingerprint fails exactly 1;
unscoping the identifier fails exactly 1; ignoring expiry fails exactly 1;
treating an incomplete receipt as replayable fails exactly 1. No mutant failed
a test it was not aimed at. Five durable-adapter tests cover the generated
statement and the refused-claim paths; seven PostgreSQL scenarios cover the
same properties, including two identical retries racing and an assertion that
no receipt row contains a raw credential or the raw request identifier.

**Correction, 2026-08-20.** This checkpoint originally described those seven
PostgreSQL scenarios as passing against a live engine. They were written and
committed but never executed — the suite skips without
`HQ_CONTROL_PLANE_TEST_DATABASE_URL`, and the run that produced the numbers
quoted here was the offline one. When they were finally executed, in the
following subwave, **all of them failed**, and for a real reason: see 13.1.5.
The durable receipts described above did not work. The claim recorded here
should have read "written, not run".

Gate as actually run at the time: strict `typecheck`, `lint`, offline `test`
(77 passed / 14 skipped). No live-database evidence.

Not claimed: receipts for `CreateGroup`, `CreatePairingCode` and `RevokeDevice`
— their `MutationContext` is still accepted and ignored, so those three remain
non-idempotent and are the next subwave. Also unclaimed: expired-receipt
reaping (rows are bounded by `expires_at` and indexed for it, but nothing
deletes them yet), and cross-instance behaviour, which the single-process
suite cannot observe.

### 13.1.5 Receipts for every destructive mutation, and the CTE-visibility defect — 2026-08-20

This subwave extended receipts to `CreateGroup`, `CreatePairingCode` and
`RevokeDevice`, and — on first executing the PostgreSQL suite — found that the
previous subwave's receipts had never worked at all.

#### The defect

Every mutation is one statement with data-modifying CTEs. Receipts were built
the same way: a `claimed_receipt` CTE inserted the row, and a `completed_receipt`
CTE at the tail updated it with the outcome. PostgreSQL runs every
data-modifying CTE against **one pre-statement snapshot**, so the completion
matched no row: the insert was invisible to it. `completed_at` stayed NULL
forever, the gate never closed, and every retry re-executed its mutation.

Reduced to its essentials against a live database:

```
WITH claimed AS (INSERT INTO r ... RETURNING scope),
     made    AS (INSERT INTO thing ... SELECT FROM claimed RETURNING id),
     completed AS (UPDATE r SET completed_at = now() FROM made WHERE ... RETURNING rid)
SELECT ...
-->  made_rows: 1,  completed_rows: 0
```

Nothing offline could see this. The structural tests assert the shape of the
generated SQL and passed. The deterministic runtime has different semantics and
passed. Only executing the statements against PostgreSQL exposed it — which is
precisely the reason 13.1.3 exists, and precisely the reason the previous
checkpoint should not have claimed coverage it had not run.

#### The fix

The claim moves into its own statement, committed before the mutation runs, so
the receipt row is visible to the mutation statement that has to complete it.
The mutation then locks that committed row instead of inserting one:

```sql
locked_receipt AS MATERIALIZED (
  SELECT receipt.request_id_hash FROM mutation_receipts AS receipt
  WHERE receipt.scope = $a AND receipt.request_id_hash = $b
    AND receipt.completed_at IS NULL
  FOR UPDATE OF receipt
)
```

A refused claim short-circuits before the mutation statement is issued. The
post-mutation resolution stays as a second layer for the case where a
concurrent retry completes the receipt between the claim and the mutation.

#### The three new scopes

| Mutation            | Why a retry is not free                                                       | How a retry is answered                                                                |
| ------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `CreateGroup`       | A lost response leaves two groups and no way to tell which the next call hits | Re-issue credentials on the recorded session.                                          |
| `CreatePairingCode` | A lost response leaves a live code nobody has seen                            | Retire the recorded code and mint a replacement, so one identity means one capability. |
| `RevokeDevice`      | Re-running bumps the revision again, then fails on the membership it wants    | Return the recorded revision, not the group's current one.                             |

A consumed recorded code refuses replacement with `FAILED_PRECONDITION`: the
pairing it authorised has happened, and minting another would grant a second
capability nobody asked for.

Migration `0006` drops `0005`'s shape constraints — they assumed every receipt
produced a session, which is false for the two new non-credential mutations —
and replaces them with one scope-aware constraint. The old constraints are
dropped by catalogue lookup, because `0005` declared them inline and their
names are server-generated.

#### Evidence, including what is _not_ established

**18 PostgreSQL scenarios pass against live Neon**, covering retried bootstrap,
pairing, refresh, pairing-code replacement, consumed-code refusal, retried
revoke, reused identifiers, failed-claim reuse, post-revoke refusal, and the
absence of any raw credential in a receipt row.

Mutation testing of the deterministic runtime: disabling the bootstrap replay,
the pairing-code retirement, the consumed-code check, the recorded revision, or
the revoke receipt each fails exactly the tests aimed at it and no others.

Mutation testing against the live database is **weaker, and is reported as
such**:

| Mutant                                        | Result   | Why                                                                                                    |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| A completed receipt no longer refuses a claim | killed 1 | The post-mutation resolution still catches the rest, so only the bootstrap path depends on it alone.   |
| `FOR UPDATE OF receipt` removed               | survived | The race scenario is serialized by the pairing code's own `FOR UPDATE`, so it does not test this lock. |
| The gate stops checking `completed_at`        | survived | The short-circuit already returned before the gate mattered.                                           |

So the suite establishes the **observable contract** — a retry does not
double-execute and returns a usable answer — but it does **not** establish that
the in-statement receipt lock is what provides serialization. The layers are
deliberately redundant, which is defensible, and it means no single layer is
individually covered. A test that genuinely exercises two concurrent mutation
statements for one identifier remains unwritten.

Gate: strict `typecheck`, `lint`, offline `test` (87 passed / 18 skipped), and
the online suite (18 passed). No connection string is committed.

Not claimed: expired-receipt reaping (rows are bounded by `expires_at` and
indexed for it, but nothing deletes them), receipt coverage for RPCs beyond the
five destructive lifecycle mutations, and cross-instance behaviour, which a
single-process suite cannot observe.

### 13.2 Linear route to phase closure

This route is deliberately linear and additive. It carries completed
checkpoints forward as regression contracts rather than repeating their work or
rewriting the preceding sections. A later line may not mark its target phase
closed until all listed exit conditions pass.

#### L0 — lock the evidence baseline and preserve closed modern UI work

- Retain the Phase 0 historical-snapshot limitation as an explicit exception;
  preserve current visual contracts, hashes and change-log evidence instead of
  inventing pre-migration screenshots.
- Treat Phases 1 and 2 as completed modern-target checkpoints. Do not replace
  Base UI adapters, terminal tokens or public `Terminal*` APIs during later
  work; run their visual/accessibility/boundary regressions when affected.
- Exit: the status table remains accurate, the exception is accepted by the
  maintainer, and no new direct Base UI or raw interactive-control imports are
  introduced.

#### L1 — close Phase 3 before claiming distributed behavior

- Close fail-closed pairing-code issuer access/session binding before another
  distributed or release claim. Test that normal refresh `T1` → `T2` invalidates
  a code bound to retired `T1` even while its session remains valid, that replay
  revocation also blocks redemption, and that legacy issuer-unbound rows reject
  without a device-only authority fallback.
- Prove the durable lifecycle and its migration serialization against isolated
  PostgreSQL/Neon contention (simultaneous migration runners, pairing, refresh
  replay and revoke), then add durable idempotency receipts and response replay
  before relying on `MutationContext` for retries.
- Implement authenticated `MaterialService`, `SettingsService`, `SyncService`,
  `TelemetryService` and `IntegrationService` handlers behind the existing
  Protobuf contracts.
- Add device identity, pairing, roles, group membership, durable PostgreSQL
  history, Redis cross-instance fanout, idempotency and production-safe errors.
- Deploy a preview control-plane only after interactive provider sign-in; prove
  binary gRPC-Web/Connect and realtime behavior against it.
- Exit: a paired device can authenticate, join a group, publish/receive a
  durable authorized event after reconnect, and service integration/security
  tests pass.

#### L2 — close Phase 4 across every operational screen

- Register every tile/screen with min/max sizes, priorities, compact/minimal
  presentations and relocation policy.
- Apply the resolver and document-overflow lock to all routes, not only the
  settings and video checkpoints.
- Complete remote/group settings history only after L1 provides the durable
  SettingsService path.
- Exit: the complete viewport/DPI/locale/theme matrix has no page scroll,
  overlap, inaccessible tile or unexplained empty grid area; each allowed local
  scroll remains inside its owning panel.

#### L3 — close Phase 5 with an authenticated materials lifecycle

- Keep the existing BLAKE3 local import and Range reader as the local-first
  transport; do not regress to whole-file renderer buffering.
- Add persistent Rust indexing, cloud upload/download grants, private Blob,
  resumable multipart transfer, versions, trash/restore/retention and mirror
  reconciliation.
- Add safe MIME verification, preview/conversion queues, viewer registry and
  clear local/cloud/mirror conflict states.
- Exit: an authorized material can be uploaded, resumed, viewed from another
  paired client, versioned, moved to trash, restored and audited without a path
  or capability leak.

#### L4 — close Phase 6 as a media and map product slice

- Keep the approved source scope: demo media, stored material and explicitly
  permitted webcam. Do not make real IP cameras a release dependency; leave
  RTSP/FFmpeg behind the disabled compatibility switch.
- Build the remaining custom-player capabilities: production material source
  selection, tracks/subtitles/quality where available, HLS/LL-HLS handling,
  markers, annotations, clip export and bounded inactive-feed decoding.
- Replace browser-local `BroadcastChannel`/storage synchronization with the
  authenticated L1 `SyncService` transport, group authority, time offset
  estimation, reconnect and SLO instrumentation.
- Provision the user-created, origin-restricted Yandex Maps JavaScript API v3
  key through local/deployment environment configuration; retain the no-key
  fallback and never extract credentials from a browser profile.
- Exit: two authorized devices synchronize a permitted media item within the
  declared LAN/Internet SLOs; all player/map failure modes fall back safely;
  production map provisioning and observability are verified.

#### L5 — close Phase 7 on top of the finished group services

- Implement safe edit descriptors, floating dock, layout drag-and-drop,
  resize/animation controls, undo/redo and issue-draft composition without
  allowing arbitrary HTML, JavaScript or CSS.
- Add Yjs/Yrs only for approved collaborative documents; keep roles, purge,
  quotas and leader ordering server-authoritative.
- Deliver ru/en catalogs, locale expansion tests and confirmed GitHub App
  issue/translation draft-PR workflows.
- Deliver real Rust telemetry collectors and an explicitly labelled deterministic
  simulator with a bounded curve editor.
- Exit: local and group histories are durable, filterable, reversible and
  authorized; edit, localization and telemetry tests demonstrate their complete
  supported contracts.

#### L6 — close Phase 8 and create the only public release

- Implement and test Windows 10/11 native titlebar, drag/resize/hit-test,
  DPI, Snap/Alt+Space, picker, notifications and recovery behavior.
- Build and validate the Windows 7–8.1 legacy shell separately, including the
  documented Base UI compatibility matrix and reduced-effects fallbacks.
- Provision production Vercel resources after user authentication, execute
  security/load/accessibility/recovery and clean-machine installer tests, and
  verify monitoring/diagnostics redaction.
- Exit: all final matrix gates pass, rollback paths are exercised, installers
  pass clean-machine smoke tests, and a single `v1.0.0` release is approved.

## 14. Verification matrix

Every implementation wave runs at minimum:

- `pnpm lint`
- `pnpm typecheck`
- affected unit tests
- `pnpm build`
- desktop static export when relevant
- Rust format check, Clippy and tests when Rust changes
- Playwright for affected user flows
- forbidden Base UI import check

Final viewports: 2560x1440, 1920x1080, 1600x1000, 1600x900,
1366x768, 1280x720, 1024x768 and narrow web fallback at 100%, 125%,
150% and 200% scaling.

Base UI visual acceptance:

- static-region perceptual difference at most 0.5%;
- component bounds difference at most one CSS pixel;
- no new radius, color or token drift;
- no clipped portal;
- correct focus restoration and keyboard navigation;
- WebView2 109 compatibility result recorded per primitive.

### Phase 2 verification checkpoint — 2026-08-15

- `pnpm check:ui-boundary`: passes; direct `@base-ui/react` imports remain
  isolated to `packages/ui`, and feature code contains zero direct JSX
  `button`, `input`, `select` or `textarea` elements.
- `pnpm lint`, `pnpm typecheck`, package unit tests and `pnpm build`: pass;
  Next.js generates 147 static pages.
- `pnpm test:ui`: 19 of 19 Chromium Playwright scenarios pass, including the
  complete primitive catalog, keyboard semantics, visual snapshots, registry
  filters, custom snapshot dialog, operational screens, surveillance transport
  and PTZ controls, compatibility routes and every primary application route.
- `pnpm build:desktop:web`: passes and generates the desktop static export for
  the same 147 routes.
- `pnpm format:check`: passes. The generated `apps/hq/next-env.d.ts` is excluded
  explicitly because Next.js owns and rewrites that file.
- `cargo fmt --all -- --check`: passes after applying mechanical Rust formatting.
- `cargo clippy --all-targets --all-features -- -D warnings`: passes from a clean
  Rust build cache.
- `pnpm test:cargo`: passes; the native path-containment security regression is
  green.

This checkpoint closes the modern Phase 2 control migration only. It does not
claim the WebView2 109 legacy compatibility gate, Vidstack media engine,
Yandex key provisioning, material storage, group
synchronization, interactive editor or release hardening phases.

### Phase 3 protocol foundation checkpoint — 2026-08-15

- Buf STANDARD lint passes for bridge, common, control, material, settings,
  sync, telemetry, integration and realtime packages.
- Protobuf-ES 2.14 generates nine current TypeScript modules; the root
  `check:protocol-generation` command proves deterministic regeneration by
  comparing SHA-256 snapshots before and after Buf runs.
- Protocol contract tests pass as exactly one source test file with four tests:
  typed binary round trips, exact RPC descriptor sets, server-streaming method
  semantics and the realtime oneof envelope. Test sources are excluded from
  `dist`.
- The existing file bridge retains four passing security/gRPC integration tests
  after regenerating its stream response types.
- The Node control-plane has seven test files and eighteen passing tests covering
  environment validation, typed health/capability discovery, allowed-origin
  preflight, denied-origin behavior, absence of `/api/health` REST fallback,
  lazy Neon/Upstash adapters, bounded resume history and binary WebSocket
  reconnect/replay behavior.
- `pnpm check` passes across eight workspace packages and still generates 147
  Next.js pages. `pnpm format:check` also passes.

This checkpoint completes the application Protobuf surface, deterministic
TypeScript and Rust generation, and a runnable control-plane bootstrap.
Authentication, Blob access and durable cross-instance sync remain separate
unfinished Phase 3 gates. The single-process binary reconnect transport is
implemented, but it is not yet a Vercel production deployment or an
authenticated pairing endpoint.

### Phase 4 safe personalization checkpoint — 2026-08-15

- `@gremuchaya/settings-schema` exposes render metadata from each setting's
  existing validator, with unit coverage for enum, bounded-number and category
  queries. The UI never receives an arbitrary CSS, HTML or JavaScript editor.
- The terminal Settings screen renders all 32 categories using public Base UI
  wrappers only. Changing a category instantly swaps to its schema-safe
  controls; resetting it affects only that category.
- Exported JSON can be selected through the terminal import action and is
  rejected if it fails the schema. The file round trip is covered by Playwright.
- The latest verification passes `settings-schema` unit tests, HQ typecheck and
  lint, plus 23/23 Chromium scenarios. One 720p scenario locks document and
  workspace overflow while allowing the settings content pane to scroll.

This is a local draft/catalogue checkpoint, not the final remote
SettingsService, synchronized history, arbitrary dashboard layout editor or
complete feature-by-feature application of every option.

## 15. Rollback policy

- Base UI wrappers preserve the feature-facing API.
- Old primitive code is removed only after its replacement gate passes.
- Web and control-plane deployments roll back independently.
- Settings and layout use versioned documents and last-known-good recovery.
- Original media is never deleted after a failed conversion.
- Invalid title bar or layout configuration falls back to a safe preset.
- Blob purge runs only after retention and reference verification.

## 16. Change log

| Date       | Change                                                                                           | Evidence                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-15 | Phase 0 baseline captured; plan created before source changes                                    | baseline hashes and `pnpm` gates above                                                                                                                                                                                                                                          |
| 2026-08-15 | Base UI foundation installed without introducing a second visual theme                           | exact `@base-ui/react@1.7.0`, `packages/ui/src/primitives`, token-driven `primitives.css`                                                                                                                                                                                       |
| 2026-08-15 | Public terminal wrapper catalog and portal/toast provider completed                              | 25 public wrapper modules, client-only entry point and shared provider                                                                                                                                                                                                          |
| 2026-08-15 | Feature import boundary enforced                                                                 | ESLint restricted imports and `pnpm check:ui-boundary` pass                                                                                                                                                                                                                     |
| 2026-08-15 | First real screen migration completed                                                            | `SettingsScreen` controls and `OpsUi` tooltip/drawer use `@gremuchaya/ui/primitives`                                                                                                                                                                                            |
| 2026-08-15 | Hydration mismatch in progress value formatting detected and fixed                               | deterministic server/client locale plus browser-console regression test                                                                                                                                                                                                         |
| 2026-08-15 | Modern Base UI visual and behavior contract established                                          | 14/14 Playwright tests and three 0.5% threshold component snapshots                                                                                                                                                                                                             |
| 2026-08-15 | Aggregate modern-target verification completed                                                   | `pnpm check`, static desktop export and Cargo tests pass; 147 Next.js routes generated                                                                                                                                                                                          |
| 2026-08-15 | Registry screen migration completed                                                              | Files, objects and cases use typed Terminal inputs, selects and buttons with registry E2E coverage                                                                                                                                                                              |
| 2026-08-15 | Global and compatibility shell migration completed                                               | titlebar, navigation, windows, scenes, developer gate, explorer and production controls use public wrappers                                                                                                                                                                     |
| 2026-08-15 | Native developer prompt removed                                                                  | Base UI snapshot dialog, focus/inert behavior and portal layering regression test                                                                                                                                                                                               |
| 2026-08-15 | Dialog stacking contract corrected                                                               | `--z-dialog` keeps modal portals above feature and developer overlays                                                                                                                                                                                                           |
| 2026-08-15 | Operational screens and surveillance controls migrated                                           | overview, map layers, communications, video transport, camera grid and PTZ use Terminal wrappers                                                                                                                                                                                |
| 2026-08-15 | Phase 2 direct-control migration closed                                                          | zero direct interactive JSX controls outside `packages/ui`; enforced by `check:ui-boundary`                                                                                                                                                                                     |
| 2026-08-15 | Modern Phase 2 verification checkpoint completed                                                 | 19/19 Playwright, 147-route web/desktop builds, Prettier, rustfmt, Clippy and Cargo tests pass                                                                                                                                                                                  |
| 2026-08-15 | Versioned application Protobuf surface completed                                                 | common/control/material/settings/sync/telemetry/integration packages pass Buf STANDARD lint and generation                                                                                                                                                                      |
| 2026-08-15 | TypeScript protocol contract gate added                                                          | binary round trips, exact RPC descriptor sets and server-streaming semantics are covered by Vitest                                                                                                                                                                              |
| 2026-08-15 | Deterministic protocol generation gate added                                                     | hash-before/generate/hash-after check rejects stale or missing checked-in Protobuf-ES bindings                                                                                                                                                                                  |
| 2026-08-15 | Node control-plane foundation added                                                              | typed health/capabilities, Connect plus binary gRPC-Web, CORS denial and no-REST integration tests pass                                                                                                                                                                         |
| 2026-08-15 | Rust Protobuf binding generation completed                                                       | vendored `protoc`, `prost` 0.14.4 and native cross-package binary round-trip test pass                                                                                                                                                                                          |
| 2026-08-15 | Neon storage foundation and migration ledger added                                               | lazy `@neondatabase/serverless` adapter, advisory-locked `0001` schema, checksum-drift and no-network tests                                                                                                                                                                     |
| 2026-08-15 | Upstash coordination foundation added                                                            | lazy presence, lease, sequence and `@upstash/ratelimit` adapters pass deterministic no-network tests                                                                                                                                                                            |
| 2026-08-15 | Binary realtime reconnect transport added                                                        | `/realtime` uses generated Protobuf envelopes for hello/resume/replay/resync and passes WebSocket integration tests                                                                                                                                                             |
| 2026-08-15 | Safe personalization catalogue added                                                             | 32 categories render from validator-derived editor metadata; import/export and category reset are browser-tested                                                                                                                                                                |
| 2026-08-15 | Phase 4 layout and settings foundations added                                                    | bounded tile resolver plus schema-validated local personalization draft, resets, publish and JSON export pass unit/build checks                                                                                                                                                 |
| 2026-08-16 | Opt-in local material-import foundation added                                                    | bounded binary gRPC-Web import, BLAKE3 content addressing, atomic mirror records, quarantine, dedupe and private `.hq` boundary                                                                                                                                                 |
| 2026-08-16 | Hidden terminal import UI attached to local bridge                                               | Ctrl+Shift+Alt+S dialog streams browser Files, supports cancellation and cursor-paged local registry without page scroll                                                                                                                                                        |
| 2026-08-16 | Client-side BLAKE3 prehash checkpoint completed                                                  | module-worker streaming digest plus legacy fallback supplies an expected hash; the bridge independently verifies before commit                                                                                                                                                  |
| 2026-08-16 | Bounded local material preview checkpoint completed                                              | image, PDF, text and ≤32 MiB local audio/video use explicit bounded gRPC-Web reads; unsupported or oversized content is inert                                                                                                                                                   |
| 2026-08-16 | Vidstack player foundation completed                                                             | custom terminal surveillance controls now drive the exact 1.15.6 React media engine without importing its default visual layer                                                                                                                                                  |
| 2026-08-16 | Yandex Maps JavaScript API v3 adapter added                                                      | client-only vector `YMap` loader, provider-agnostic terminal overlay, coordinate-safe fallback and a v3 endpoint regression test                                                                                                                                                |
| 2026-08-17 | Typed camera registry and bounded grid checkpoint added                                          | all 16 channels are filterable/sortable and paged 12+4; only the selected feed decodes and gateway URLs remain credential-free                                                                                                                                                  |
| 2026-08-17 | Native RTSP→HLS gateway foundation added                                                         | Tauri owns bounded FFmpeg workers, loopback HLS grants, consumer leases and a browser-validated native descriptor boundary                                                                                                                                                      |
| 2026-08-17 | RTSP worker supervisor and client retry checkpoint added                                         | stable HLS identity survives FFmpeg exit; bounded jittered backoff, detailed health and cancellation-safe startup retry pass                                                                                                                                                    |
| 2026-08-17 | Camera source model corrected to demo/material/webcam                                            | real cameras are out of scope; webcam is explicit and local-only, while RTSP is a disabled compatibility adapter                                                                                                                                                                |
| 2026-08-18 | Local video material assignment added                                                            | a channel persists only a validated material UUID; bounded gRPC-Web preview Blob URLs are temporary and safely revoked                                                                                                                                                          |
| 2026-08-18 | Large local-video Range streaming added                                                          | gRPC-issued loopback capabilities provide revocable partial-byte playback without path disclosure or full-file buffering                                                                                                                                                        |
| 2026-08-18 | Browser-local playback synchronization added                                                     | ordered 40 ms epoch/sequence commands synchronize demo/material playback without serializing local media capabilities                                                                                                                                                           |
| 2026-08-18 | Current Phase 6 slice validation refreshed (not phase closure)                                   | root typecheck/lint, 30 Playwright scenarios, all format/boundary gates, and both 147-route web exports now pass                                                                                                                                                                |
| 2026-08-18 | Local settings history and reversible draft checkpoints added                                    | bounded before/after ledger supports undo, redo, filtered pagination and safe load-to-draft without rewriting published history                                                                                                                                                 |
| 2026-08-18 | Actual phase-state audit and linear closure route added                                          | Phases 1–2 are closed for the modern target; Phase 0 and Phases 3–7 remain partial; Phase 8 is not started                                                                                                                                                                      |
| 2026-08-18 | Phase 3 L1 paired-device/realtime checkpoint recorded                                            | `c8a0dec`…`24af428`: generated contracts, injected lifecycle, auth schema and admission; 5 protocol + 27 control-plane tests pass                                                                                                                                               |
| 2026-08-18 | Phase 3 durable auth configuration validated                                                     | `dff5976`: incomplete auth configuration is rejected; hash closure and lifetime inputs are explicitly bounded                                                                                                                                                                   |
| 2026-08-18 | Phase 3 replay and membership integrity migration appended                                       | `c8faf10`: immutable `0003` records prior refresh hashes and deferred group-membership foreign-key integrity                                                                                                                                                                    |
| 2026-08-18 | Phase 3 durable paired-device adapter added                                                      | `1777f51`: parameterized locked CTE lifecycle covers bootstrap, pairing, refresh/replay, auth, listing and scoped revocation                                                                                                                                                    |
| 2026-08-18 | Phase 3 durable configuration composition added                                                  | `3622bbd`: migrations precede construction of durable SyncService/realtime collaborators; automatic activation follows in `b89539b`                                                                                                                                             |
| 2026-08-18 | Phase 3 access-token/session binding corrected                                                   | `6a8cf84`: authenticated identity now requires the token row to match its owning session, closing a cross-group SQL-join path                                                                                                                                                   |
| 2026-08-18 | Phase 3 fail-closed durable server activation added                                              | `b89539b`: configured startup awaits migrations before listen/capabilities and rejects volatile auth/realtime overrides                                                                                                                                                         |
| 2026-08-18 | Phase 3 immutable migration serialization fixed                                                  | `ea2ef3b`: one transaction-scoped advisory lock precedes all immutable ledger decisions; live PostgreSQL contention remains open                                                                                                                                                |
| 2026-08-18 | Phase 3 post-admission realtime revalidation closed                                              | `49933e9`: protected work and bounded idle sockets revalidate, then neutral-close revoked/expired credentials with policy `1008`                                                                                                                                                |
| 2026-08-19 | Phase 3 fail-closed pairing-code issuer binding closed (durable adapter)                         | migration `0004_paired_device_pairing_issuer_binding`; `createPairingCode`/`pairDevice` now bind and re-check the exact issuing session/access token; 27 durable lifecycle/startup tests, 62 total control-plane tests; committed as `3b9ab46`                                  |
| 2026-08-19 | Fixed a genuine strict-typecheck failure in `DurablePairedDeviceRuntime.authenticateAccessToken` | `access_token.id` was missing from the `RETURNING` clause and the mapped `AuthenticatedDevice`, so `tsc -b` rejected the file before this fix; committed as `3b9ab46`                                                                                                           |
| 2026-08-19 | Reverted an uncommitted local `packageManager` drift that blocked all `pnpm` commands            | the working copy of root `package.json` had an unresolvable `pnpm@11.22.0`; restored to the already-committed `pnpm@10.12.3` baseline, so this is a working-copy repair with no repository diff                                                                                 |
| 2026-08-20 | Phase 3 real PostgreSQL integration and concurrency suite added                                  | `src/postgres.integration.test.ts`: 7 scenarios against live Neon — simultaneous migration runners, one-time pairing redemption race, refresh rotation, refresh replay, legacy `NULL` binding, revoke cascade; opt-in via `HQ_CONTROL_PLANE_TEST_DATABASE_URL`, skipped offline |
| 2026-08-20 | Issuer-binding suite mutation-tested rather than merely observed green                           | reverting the `pairDevice` issuer joins fails exactly the three fail-closed scenarios and no others, proving the pre-fix vulnerability was reachable against a live database                                                                                                    |
