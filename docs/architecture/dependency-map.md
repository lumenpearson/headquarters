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
  simulation-curve evaluator (`simulationCurve.ts`) — the one copy of the curve arithmetic in the
  repository, including the phase `curvePhaseAt` derives. Both callers reach it: the client's
  `simulationTick` and the control plane's `previewSnapshots`, so a preview an operator judges a
  curve by and the reading that curve produces on a screen are the same number by construction.
  This sentence was overstated until 2026-08-26, when the second copy of the phase was removed
  from `apps/control-plane/src/telemetry/service.ts`.
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
- `@gremuchaya/control-plane`: ConnectRPC composition root, served by two adapters over one route
  registration (ADR-0009). It compiles to three entry points — `dist/server.js` (the Node adapter
  and the socket), `dist/migrate.js` (the schema alone) and `dist/healthcheck.js` (a gRPC-Web
  probe over its own `ControlPlaneService`) — and ships as a container image built from
  `apps/control-plane/Dockerfile`, the only application in this repository that does (ADR-0010).
  `ControlPlaneService` always serves; `SyncService`, `SettingsService`,
  `MaterialService`, `TelemetryService` and `IntegrationService` are registered only when durable
  auth config is present. `src/routes.ts` holds the registration both adapters call,
  `src/http-policy.ts` the origin and header decision they share, `src/server.ts` the Node adapter
  with the WebSocket hub attached to it, and `src/fetch-adapter.ts` the request-handler adapter the
  web build mounts. `src/db` owns the schema, its migrations and the two database drivers —
  `neon` over HTTP and `postgres` over TCP, chosen by `HQ_CONTROL_PLANE_DATABASE_DRIVER` —
  `src/realtime` the hub, the `sync_events` replay store and the retention rule both the socket and
  the polling feed decide by, `src/redis` the optional presence and rate-limit coordinator, and
  `src/sync` the paired-device lifecycle with its row mappers, receipt guard and paging.
  `src/telemetry` previews a profile through `@gremuchaya/domain`'s curve evaluator, mapping the
  protocol enums at the boundary; that is the control plane's only dependency on `domain`, and
  nothing in `apps/hq` calls that telemetry surface.
  **`apps/hq` reaches the rest of it over the wire, never by import.** The one exception is
  `apps/hq/app/api/[[...rpc]]/route.web.ts`, which mounts the fetch adapter in the web build alone;
  `no-restricted-imports` in the root `eslint.config.mjs` refuses the package everywhere else under
  `apps/hq/src/**` and `apps/hq/app/**`.
- `src-tauri`: native read-only projection, watcher, physical monitor and window management, plus a
  loopback media gateway that runs `ffmpeg` and serves the resulting HLS to the WebView.

State ownership:

- Zustand owns the current client runtime snapshot across two stores,
  `apps/hq/src/state/operationsStore.ts` and `apps/hq/src/state/appStore.ts`. The first composes
  `OperationsUiState`, `ProductionState` and `PersonalizationState` with the `content`, `connection`
  and `materials` regions into one `OperationsState`. It is one store with named regions, not
  per-domain slice modules; a plan that assumes separate slice files describes a target, not the
  code.
- Scene definitions and content remain immutable configuration.
- Personalization values reach the document through one table,
  `apps/hq/src/application/personalization/presentation.ts`. A setting is bound there to a
  `data-*` attribute or an `--ops-*` custom property, or it is listed as read by a named consumer;
  a test fails on a definition that is neither.
- `localStorage` owns everything the browser persists, under nine keys:
  `gremuchaya-hq:operations:v3`, `gremuchaya-hq:production-snapshots:v3`,
  `gremuchaya-hq:snapshots:v1`, `gremuchaya-hq:device-session:v3` (the paired control-plane session,
  refresh token included, with the installation id it was minted against),
  `gremuchaya-hq:group-mirror:v1` (the last group state the device downloaded, plus a draft
  companion that lives for one download), `gremuchaya-hq:control-plane-address:v1` (the operator's
  in-app control-plane address list, scoped to the device), `hq.camera-material-assignments.v1`,
  `hq.keybinds-intro-seen.v1`, and the Yandex Maps key. There is no IndexedDB and no Tauri store
  plugin in this repository. Media and timer handles are never persisted.
- Application services perform cross-slice transitions and all IO. React components dispatch use
  cases and select narrow state only.
