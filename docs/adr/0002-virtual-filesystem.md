# ADR-0002: Virtual filesystem

- Status: Accepted
- Date: 2026-08-15

## Context

The fictional explorer must merge physical production files with config-defined files while a pure
browser cannot silently read arbitrary disks.

## Decision

Use branded virtual paths and a `FileSourcePort`. Four adapters implement it — browser directory,
localhost bridge, Tauri and emulated — and `ExplorerService.list` merges them over the domain's
`mergeExplorerNodes`. Real nodes shadow an emulated node at the same virtual path; physical paths
never leak into the cinematic UI.

## Alternatives

Copying files into `public/` requires rebuilds. Pretending a browser has unrestricted disk access is
incorrect. A Tauri-only model would remove the required web/review fallback.

## Consequences

Every source validates paths and availability. `ExplorerService.list` wraps each source in its own
`try`, so a failing bridge or native root degrades to an `offline` status while emulated content
keeps listing.
