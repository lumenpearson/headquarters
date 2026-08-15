# Context

The operator and display routes must synchronize locally with sub-100 ms cue application, survive
screen reloads and work without a Next.js server or internet connection.

# Decision

Use a typed screen-bus port. Tauri events are primary in desktop mode; BroadcastChannel is the web
adapter, with a `storage` event fallback. Every message carries protocol version, id and timestamps.
Screens boot on the safe background and request an authoritative current snapshot before applying
media state.

# Alternatives

WebSockets and Server Actions were rejected because they add a server dependency to cue execution.

# Consequences

The operator store is the authority. Adapters require explicit cleanup and duplicate-message
suppression. Heartbeat data is separate from cinematic screen state.
