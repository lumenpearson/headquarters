# Architecture dependency map

```text
presentation (Next routes, React, CSS)
        |
        v
application (scene, explorer, snapshot, asset and screen use cases)
        |
        v
domain (plain immutable types, state machines, invariants and ports)

infrastructure (browser, bridge and Tauri adapters)
        |
        +------ implements domain/application ports
```

Package ownership:

- `@gremuchaya/domain`: framework-free models, state machines, errors, paths and ports.
- `@gremuchaya/config`: Zod trust-boundary schemas, parsers and scene validation. It holds no
  migrations; the only migrations in the repository live in
  `apps/control-plane/src/db/migrations.ts`.
- `@gremuchaya/protocol`: generated Protobuf messages and the shared `FileBridgeService` RPC
  descriptor; it contains no runtime policy or UI code.
- `@gremuchaya/ui`: design tokens and scene-agnostic React primitives.
- `@gremuchaya/test-fixtures`: deterministic data that is excluded from production imports.
- `@gremuchaya/hq`: composition root, application services, adapters, Zustand runtime and UI.
- `@gremuchaya/file-bridge`: localhost-only read-only gRPC-Web file projection and server-streaming
  watcher fallback.
- `src-tauri`: native read-only projection, watcher, physical monitor and window management.

State ownership:

- Zustand owns the current client runtime snapshot across two stores,
  `apps/hq/src/state/operationsStore.ts` and `apps/hq/src/state/appStore.ts`. It is not split into
  per-domain slices; a plan that assumes scene/screens/workspace/explorer/connection slices
  describes a target, not the code.
- Scene definitions and content remain immutable configuration.
- `localStorage` owns everything the browser persists, under six keys:
  `gremuchaya-hq:operations:v3`, `gremuchaya-hq:production-snapshots:v3`,
  `gremuchaya-hq:snapshots:v1`, `hq.camera-material-assignments.v1`, `hq.keybinds-intro-seen.v1`, and the Yandex Maps key.
  There is no IndexedDB and no Tauri store plugin in this repository. Media and timer handles are
  never persisted.
- Application services perform cross-slice transitions and all IO. React components dispatch use
  cases and select narrow state only.
