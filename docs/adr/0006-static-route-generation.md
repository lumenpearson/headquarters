# Context

Tauri serves static files and cannot provide a Node fallback for `/screen/:id`, `/wall/:id` and
`/scene/:id`.

# Decision

Generate all finite screen, wall and September scene route parameters at build time and use trailing
slash output. Runtime-created files and overrides remain application documents/state, never Next.js
filesystem routes.

# Alternatives

A single hash router shell would reduce route assets but weaken direct display URLs and review links.

# Consequences

New route-level scene identifiers require a release build. Production content and cue data can still
change through runtime configuration without introducing new route identifiers.
