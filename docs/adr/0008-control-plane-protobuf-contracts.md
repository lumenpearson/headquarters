# ADR-0008: Versioned Protobuf control-plane contracts

- Status: Accepted
- Date: 2026-08-15

## Context

The local file bridge already used ConnectRPC and binary gRPC-Web, but its
single `gremuchaya.bridge.v1` service could not describe cloud materials,
settings publication, group synchronization, telemetry simulation or GitHub
integration. Adding feature-specific REST endpoints would create a second
application transport and would reintroduce untyped JSON bootstrap failures.

The browser, Tauri UI, Rust agent and Node control-plane need one versioned
schema with deterministic code generation. The UI must also be able to discover
which infrastructure-backed capabilities are genuinely available instead of
assuming that an incomplete backend is ready.

## Decision

1. `packages/protocol/proto` is the canonical application contract source.
2. Every package uses the `gremuchaya.<domain>.v1` naming convention.
3. Shared IDs, revisions, mutation metadata, pagination, sorting, filters,
   typed setting values and machine-readable errors live in
   `gremuchaya.common.v1`.
4. Control, Material, Settings, Sync, Telemetry and Integration services expose
   versioned request and response messages for every RPC.
5. Watch and telemetry methods use server-streaming response envelopes.
6. Browser-facing traffic uses Connect or binary gRPC-Web. Native HTTP/2 gRPC
   is added with the Rust-agent binding wave. Application REST endpoints are
   not introduced.
7. Protobuf-ES generated TypeScript is checked into `src/gen` and regenerated
   only through Buf. Feature code consumes `@gremuchaya/protocol`, not generated
   filesystem paths.
8. Domain modules are exported as `materialV1`, `settingsV1`, `syncV1`, and
   equivalent namespaces. Unique service descriptors are also exported by name.
   This avoids collisions between identically named messages from different
   Protobuf packages.
9. `ControlPlaneService.Health` and `GetCapabilities` are the typed bootstrap
   surface. Capabilities are disabled until the corresponding real adapter is
   installed; placeholders do not report readiness.
10. CORS uses an explicit origin allow-list. Responses use `no-store`,
    `nosniff`, a same-site resource policy and a restrictive CSP.

## Consequences

- Removing or renaming an RPC is detected by descriptor contract tests and Buf
  breaking checks once the first released schema baseline is published.
- Binary round-trip tests verify that shared values remain serializable.
- The existing file bridge remains wire-compatible after its stream response
  messages are renamed to satisfy Buf STANDARD conventions.
- PostgreSQL, Redis, Blob, authentication and realtime fanout remain explicit
  follow-up adapters. Their capabilities stay disabled in the meantime.
- Rust bindings are a separate incomplete gate and must not be inferred from
  the generated TypeScript surface.

## Verification

```powershell
pnpm --filter @gremuchaya/protocol generate
pnpm --dir packages/protocol exec buf lint
pnpm --filter @gremuchaya/protocol test
pnpm --filter @gremuchaya/control-plane test
pnpm check
```
