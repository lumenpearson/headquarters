# ADR-0001: Multi-screen bus

- Status: Accepted
- Date: 2026-08-15

## Context

The operator and display routes must synchronize locally with sub-100 ms cue application, survive
screen reloads and work without a Next.js server or internet connection.

## Decision

Use a typed screen-bus port. `BroadcastChannel` is the only adapter today, with a `storage` event
fallback; a Tauri-event adapter for desktop mode is the port's reason for existing and has not
been written. Every message carries protocol version, id, sender id and an issue timestamp.
Screens boot on the safe background and request an authoritative current snapshot before applying
media state.

## Alternatives

WebSockets and Server Actions were rejected because they add a server dependency to cue execution.

## Consequences

The operator store is the authority. Adapters require explicit cleanup and must drop their own
echo, which they do by sender id. Suppressing a duplicate is not yet done: `publish` sends over
both `BroadcastChannel` and `localStorage`, so a peer window with both transports live dispatches
the same message twice, and no adapter keeps a seen-id set. Heartbeat data is separate from
cinematic screen state.

Two further buses reuse this shape rather than this port: the live-edit channel for settings
patches (`apps/hq/src/infrastructure/browser/LiveEditBus.ts`, which reuses
`screenBusProtocolVersion`) and the camera playback transport in
`apps/hq/src/infrastructure/media/PlaybackSyncCoordinator.ts`.
