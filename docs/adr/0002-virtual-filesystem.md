# Context

The fictional explorer must merge physical production files with config-defined files while a pure
browser cannot silently read arbitrary disks.

# Decision

Use branded virtual paths and a `FileSourcePort`. Browser directory, localhost bridge, Tauri,
static and emulated adapters are merged by `CompositeFileSource`. Real nodes shadow an emulated node
at the same virtual path; physical paths never leak into the cinematic UI.

# Alternatives

Copying files into `public/` requires rebuilds. Pretending a browser has unrestricted disk access is
incorrect. A Tauri-only model would remove the required web/review fallback.

# Consequences

Every source validates paths and availability. The explorer can keep operating on static/emulated
content when native or bridge sources are offline.
