# ADR-0001: Multi-screen bus

- Status: Accepted
- Date: 2026-08-15

## Context

The operator and display routes must synchronize locally with sub-100 ms cue application, survive
screen reloads and work without a Next.js server or internet connection.

## Decision

Use a typed screen-bus port. Two adapters implement it: `BroadcastChannel` with a `storage` event
fallback for the web build (`apps/hq/src/infrastructure/browser/BrowserScreenBus.ts`) and Tauri
events on `hq:screen-bus` for the desktop shell
(`apps/hq/src/infrastructure/tauri/TauriScreenBus.ts`, added 2026-08-26).
`createScreenBus` picks between them by `isTauri()` at runtime, because one bundle is served to
both. Every message carries protocol version, id, sender id and an issue timestamp, produced and
validated by the shared envelope in `apps/hq/src/infrastructure/tauri/screenBusEnvelope.ts`.
Screens boot on the safe background and request an authoritative current snapshot before applying
media state.

## Alternatives

WebSockets and Server Actions were rejected because they add a server dependency to cue execution.

## Consequences

The operator store is the authority. Adapters require explicit cleanup and must drop their own
echo, which they do by sender id — load-bearing in both transports, and unavoidable in the Tauri
one, where an emit reaches every webview including the emitting one. Duplicate suppression was
missing and was added on 2026-08-26: `BrowserScreenBus.publish` sends over both
`BroadcastChannel` and `localStorage`, so a peer window with both transports live dispatched the
same message twice and ran every cue twice. Both adapters now hold a bounded seen-id set
(`SeenScreenBusIds`, 256 ids) and dispatch a given message id once. Heartbeat data is separate
from cinematic screen state.

Two further buses reuse this shape rather than this port: the live-edit channel for settings
patches (`apps/hq/src/infrastructure/browser/LiveEditBus.ts`, which reuses
`screenBusProtocolVersion`) and the camera playback transport in
`apps/hq/src/infrastructure/media/PlaybackSyncCoordinator.ts`.
