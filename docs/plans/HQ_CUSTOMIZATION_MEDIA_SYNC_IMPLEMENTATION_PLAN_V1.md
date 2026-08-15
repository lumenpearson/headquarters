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
- The existing file bridge is gRPC-Web and read-only.
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
| RQ-MAP-001    | Yandex Maps API 2.1                                        | map adapter                | provider and fallback tests           |
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
- Support MP4/WebM, HLS/LL-HLS, recordings, Blob sources and RTSP through a
  local FFmpeg gateway.
- Camera page contains the primary player, metadata rail, timeline, camera grid,
  storage, signal, active channel, network, logs, map, intercepts, recognition
  and telemetry panels.
- Hidden cameras do not decode.
- Yandex Maps API 2.1 is loaded lazily in a client-only adapter.
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

- [ ] Expand Protobuf services.
- [ ] Add generated TypeScript/Rust code.
- [ ] Create Node control-plane.
- [ ] Add Neon schema/migrations and lazy connection initialization.
- [ ] Add Upstash-backed presence, coordination and rate limits.
- [ ] Add Vercel WebSocket reconnect/resubscribe behavior.

### Phase 4 — layout and settings

- [ ] Implement tile registry and deterministic packing.
- [ ] Eliminate document scrolling.
- [ ] Add settings schemas, drafts, reset, import/export and history.
- [ ] Recompose all screens against responsive layouts.

### Phase 5 — materials and viewers

- [ ] Add Rust local storage index and write support.
- [ ] Add upload/version/trash/mirror RPC.
- [ ] Add private Blob integration.
- [ ] Add viewer registry and conversion jobs.

### Phase 6 — video and map

- [ ] Add custom Vidstack terminal player.
- [ ] Add camera registry/grid and RTSP gateway.
- [ ] Add Yandex Maps API 2.1 adapter and fallback.
- [ ] Add synchronized playback.

### Phase 7 — editor, sync, localization and telemetry

- [ ] Add edit descriptor registry and dock.
- [ ] Add Yjs/Yrs collaboration and history.
- [ ] Add Russian/English catalogs and GitHub workflows.
- [ ] Add real Rust telemetry and deterministic simulation editor.

### Phase 8 — native and release hardening

- [ ] Add modern native title bar and Windows integrations.
- [ ] Add legacy shell and compatibility matrix.
- [ ] Provision Vercel resources after interactive sign-in.
- [ ] Run full Windows, security, load, accessibility and recovery suites.
- [ ] Release `v1.0.0` only after all gates pass.

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
Yandex key provisioning, Protobuf control-plane expansion, material storage,
group synchronization, interactive editor or release hardening phases.

## 15. Rollback policy

- Base UI wrappers preserve the feature-facing API.
- Old primitive code is removed only after its replacement gate passes.
- Web and control-plane deployments roll back independently.
- Settings and layout use versioned documents and last-known-good recovery.
- Original media is never deleted after a failed conversion.
- Invalid title bar or layout configuration falls back to a safe preset.
- Blob purge runs only after retention and reference verification.

## 16. Change log

| Date       | Change                                                                 | Evidence                                                                                                    |
| ---------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 2026-08-15 | Phase 0 baseline captured; plan created before source changes          | baseline hashes and `pnpm` gates above                                                                      |
| 2026-08-15 | Base UI foundation installed without introducing a second visual theme | exact `@base-ui/react@1.7.0`, `packages/ui/src/primitives`, token-driven `primitives.css`                   |
| 2026-08-15 | Public terminal wrapper catalog and portal/toast provider completed    | 25 public wrapper modules, client-only entry point and shared provider                                      |
| 2026-08-15 | Feature import boundary enforced                                       | ESLint restricted imports and `pnpm check:ui-boundary` pass                                                 |
| 2026-08-15 | First real screen migration completed                                  | `SettingsScreen` controls and `OpsUi` tooltip/drawer use `@gremuchaya/ui/primitives`                        |
| 2026-08-15 | Hydration mismatch in progress value formatting detected and fixed     | deterministic server/client locale plus browser-console regression test                                     |
| 2026-08-15 | Modern Base UI visual and behavior contract established                | 14/14 Playwright tests and three 0.5% threshold component snapshots                                         |
| 2026-08-15 | Aggregate modern-target verification completed                         | `pnpm check`, static desktop export and Cargo tests pass; 147 Next.js routes generated                      |
| 2026-08-15 | Registry screen migration completed                                    | Files, objects and cases use typed Terminal inputs, selects and buttons with registry E2E coverage          |
| 2026-08-15 | Global and compatibility shell migration completed                     | titlebar, navigation, windows, scenes, developer gate, explorer and production controls use public wrappers |
| 2026-08-15 | Native developer prompt removed                                        | Base UI snapshot dialog, focus/inert behavior and portal layering regression test                           |
| 2026-08-15 | Dialog stacking contract corrected                                     | `--z-dialog` keeps modal portals above feature and developer overlays                                       |
| 2026-08-15 | Operational screens and surveillance controls migrated                 | overview, map layers, communications, video transport, camera grid and PTZ use Terminal wrappers            |
| 2026-08-15 | Phase 2 direct-control migration closed                                | zero direct interactive JSX controls outside `packages/ui`; enforced by `check:ui-boundary`                 |
| 2026-08-15 | Modern Phase 2 verification checkpoint completed                       | 19/19 Playwright, 147-route web/desktop builds, Prettier, rustfmt, Clippy and Cargo tests pass              |
