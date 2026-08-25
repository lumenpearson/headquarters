# Architecture dependency map

```text
presentation (Next routes, React, CSS)
        |
        v
application (scene, explorer, snapshot, asset and screen use cases; personalization
             presentation, keybinds, record paging and context menus)
        |
        v
domain (plain immutable types, state machines, invariants and ports)

infrastructure (browser, bridge and Tauri adapters)
        |
        +------ implements domain/application ports
```

Package ownership:

- `@gremuchaya/domain`: framework-free models, state machines, errors, paths and ports, and the
  simulation-curve evaluator (`simulationCurve.ts`), the one copy of the curve arithmetic in the
  repository.
- `@gremuchaya/config`: Zod trust-boundary schemas, parsers and scene validation. It holds no
  migrations; the only migrations in the repository live in
  `apps/control-plane/src/db/migrations.ts`.
- `@gremuchaya/protocol`: generated Protobuf messages for the nine `gremuchaya.*.v1` packages and
  the `FileBridgeService`, `ControlPlaneService`, `SyncService`, `SettingsService`,
  `MaterialService`, `TelemetryService` and `IntegrationService` descriptors; it contains no
  runtime policy or UI code.
- `@gremuchaya/ui`: design tokens, scene-agnostic `Terminal*` primitives over Base UI, and the
  generated shadcn set. It is the only tree `scripts/check-ui-boundary.mjs` exempts from the ban
  on direct Base UI imports and raw JSX controls.
- `@gremuchaya/layout-engine`: deterministic bounded tile packing, relocation and overflow policy.
  It depends on nothing.
- `@gremuchaya/settings-schema`: the 71 personalization `SettingDefinition`s, their validators and
  the draft/checkpoint types the personalization state is built from.
- `@gremuchaya/test-fixtures`: deterministic data that is excluded from production imports.
- `@gremuchaya/hq`: composition root, application services, adapters, Zustand runtime and UI.
- `@gremuchaya/file-bridge`: localhost-only gRPC-Web file projection and server-streaming watcher.
  It is read-only unless a local config sets `readOnly: false` and enables `materialImport`, which
  adds a resumable upload mirror and a grant-scoped playback route.
- `@gremuchaya/control-plane`: Node ConnectRPC composition root. `ControlPlaneService` always
  serves; `SyncService`, `SettingsService`, `MaterialService`, `TelemetryService` and
  `IntegrationService` are registered only when durable auth config is present. `src/db` owns the
  schema and its migrations, `src/realtime` the WebSocket hub and the `sync_events` replay store,
  `src/redis` the optional presence and rate-limit coordinator, and `src/sync` the paired-device
  lifecycle with its row mappers, receipt guard and paging. `src/telemetry` previews a profile
  through `@gremuchaya/domain`'s curve evaluator, mapping the protocol enums at the boundary; that
  is the control plane's only dependency on `domain`. No client in `apps/hq` calls any of it.
- `src-tauri`: native read-only projection, watcher, physical monitor and window management, plus a
  loopback media gateway that runs `ffmpeg` and serves the resulting HLS to the WebView.

State ownership:

- Zustand owns the current client runtime snapshot across two stores,
  `apps/hq/src/state/operationsStore.ts` and `apps/hq/src/state/appStore.ts`. It is not split into
  per-domain slices; a plan that assumes scene/screens/workspace/explorer/connection slices
  describes a target, not the code.
- Scene definitions and content remain immutable configuration.
- Personalization values reach the document through one table,
  `apps/hq/src/application/personalization/presentation.ts`. A setting is bound there to a
  `data-*` attribute or an `--ops-*` custom property, or it is listed as read by a named consumer;
  a test fails on a definition that is neither.
- `localStorage` owns everything the browser persists, under six keys:
  `gremuchaya-hq:operations:v3`, `gremuchaya-hq:production-snapshots:v3`,
  `gremuchaya-hq:snapshots:v1`, `hq.camera-material-assignments.v1`, `hq.keybinds-intro-seen.v1`, and the Yandex Maps key.
  There is no IndexedDB and no Tauri store plugin in this repository. Media and timer handles are
  never persisted.
- Application services perform cross-slice transitions and all IO. React components dispatch use
  cases and select narrow state only.
