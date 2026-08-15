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
- `@gremuchaya/config`: Zod trust-boundary schemas, parsers, migrations and scene validation.
- `@gremuchaya/protocol`: generated Protobuf messages and the shared `FileBridgeService` RPC
  descriptor; it contains no runtime policy or UI code.
- `@gremuchaya/ui`: design tokens and scene-agnostic React primitives.
- `@gremuchaya/test-fixtures`: deterministic data that is excluded from production imports.
- `@gremuchaya/hq`: composition root, application services, adapters, Zustand runtime and UI.
- `@gremuchaya/file-bridge`: localhost-only read-only gRPC-Web file projection and server-streaming
  watcher fallback.
- `src-tauri`: native read-only projection, watcher, physical monitor and window management.

State ownership:

- Zustand owns the current client runtime snapshot, split into scene, screens, operator, workspace,
  explorer, developer and connection slices.
- Scene definitions and content remain immutable configuration.
- IndexedDB/native storage owns persisted snapshots; media and timer handles are never persisted.
- Application services perform cross-slice transitions and all IO. React components dispatch use
  cases and select narrow state only.
