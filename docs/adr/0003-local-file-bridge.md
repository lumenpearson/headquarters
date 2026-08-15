# Context

Web preview mode needs automatic projection and watcher updates without granting arbitrary disk or
command access.

# Decision

Provide an optional service bound to `127.0.0.1` with one versioned Protobuf contract and a strict
binary gRPC-Web transport. `Health` and `List` are unary RPCs. `ReadFile` and `Watch` are
server-streaming RPCs so large blobs and file events do not require JSON or a parallel WebSocket
protocol. Native Connect and native gRPC routes are disabled: the only network surface is
gRPC-Web. Roots come only from local uncommitted config. Canonical-path checks reject parent
traversal, unknown mounts and symlink escape. The service is read-only.

# Alternatives

Browser directory handles require an explicit user gesture and do not guarantee automatic watcher
behavior. A generic local REST API would have an unnecessarily broad attack surface. Native
browser gRPC cannot directly use the HTTP/2 framing required by ordinary gRPC, while gRPC-Web
preserves the Protobuf service contract and works in the browser and Tauri WebView without a proxy.

# Consequences

Bridge failure is an expected availability state. Static and emulated sources continue normally.
Protocol changes are generated from `packages/protocol/proto/gremuchaya/bridge/v1/bridge.proto`.
The browser sends binary Protobuf frames and must be included in the bridge Origin allowlist.
