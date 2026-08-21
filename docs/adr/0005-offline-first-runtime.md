# Context

Shoot-day cue execution, restoration, assets and operator controls must work with no internet and no
Node.js server.

# Decision

Build the desktop profile with Next.js `output: 'export'`, local fonts/assets/runtime JSON and Tauri
native adapters. All cue and monitor state is client/native. The web profile may use server rendering
only for non-critical review surfaces.

# Alternatives

`next start`, remote APIs and Server Actions were rejected as desktop runtime dependencies.

# Consequences

Dynamic server features are unavailable in desktop builds. Runtime configuration must be read from
external/local sources rather than bundled TypeScript constants.
