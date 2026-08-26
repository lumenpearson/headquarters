# ADR-0005: Offline-first runtime

- Status: Accepted
- Date: 2026-08-15

## Context

Shoot-day cue execution, restoration, assets and operator controls must work with no internet and no
Node.js server.

## Decision

Build the desktop profile with Next.js `output: 'export'`, local fonts/assets/runtime JSON and Tauri
native adapters. All cue and monitor state is client/native. The web profile may use server rendering
only for non-critical review surfaces.

## Alternatives

`next start`, remote APIs and Server Actions were rejected as desktop runtime dependencies.

## Consequences

Dynamic server features are unavailable in desktop builds. Runtime configuration must be read from
external/local sources rather than bundled TypeScript constants.

Local processes are not excluded by this: the native media gateway binds a loopback HTTP port and
runs `ffmpeg`, and the optional file bridge is a separate Node process. Neither is a rendering
dependency — cue execution proceeds if both are absent.

## Amendment, 2026-08-26 — the web profile has a server half

The decision above says the web profile "may use server rendering only for
non-critical review surfaces". That is no longer what the repository does: the
web build mounts the control plane's RPC surface at
`apps/hq/app/api/[[...rpc]]/route.web.ts` (ADR-0009), so the web profile has a
server half and needs a deployment that runs it.

Nothing about the desktop profile changes, and the reason it must not is
unchanged: `output: 'export'` has no server to fall back on. The route file is
kept out of the desktop build by a target-dependent `pageExtensions`, not by
discipline — in that build it matches no route leaf at all.

What this amendment does change is the meaning of "offline". Screens, scenes and
cue execution stay strictly offline, as before. Group synchronization does not:
without a reachable control plane there is no group. Which control plane is a
deployment choice — Neon over the internet, or a PostgreSQL on the set's own
network through `HQ_CONTROL_PLANE_DATABASE_DRIVER=postgres`, which is what makes
a group possible on a set with no internet at all.
