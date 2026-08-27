# ADR-0010: Container deployment of the control plane

- Status: Accepted
- Date: 2026-08-27

## Context

Running this project has needed an account somewhere. The control plane's
deployment record in `docs/release/environment.md` describes a Vercel project in
front of a Neon database, and both of the databases it names belong to this
repository's own maintainers. Someone else with a clone had no route to a
running control plane at all: they could build the desktop shell, and it would
have nothing to pair with.

That is a gap in the offline story as much as in the onboarding one. ADR-0005's
amendment already records that group synchronization needs a reachable control
plane, and that which one is a deployment choice — Neon over the internet, or a
PostgreSQL on the set's own network through
`HQ_CONTROL_PLANE_DATABASE_DRIVER=postgres`. The second half of that sentence
described a capability nothing in the repository made reachable.

The constraint that shapes the answer is that this is a monorepo with three
applications, and only one of them is a long-lived server.

## Decision

1. **One image, `apps/control-plane` alone.** Its Dockerfile is at
   `apps/control-plane/Dockerfile` and its build context is the repository root,
   because the package is three workspace projects — itself,
   `@gremuchaya/domain` and `@gremuchaya/protocol` — plus the lockfile that pins
   them. `compose.yaml` at the root wires it to a PostgreSQL beside it.

2. **The offline tier is PostgreSQL only, and that is the compose default.**
   `HQ_CONTROL_PLANE_DATABASE_DRIVER=postgres` selects the `pg` adapter, which
   speaks the wire protocol to a host on the container network. There is no
   Redis service and no object store. Both are opt-in upgrades that need an
   account, and the tier without them is a control plane that serves.

3. **The image is the Node adapter, not the Fetch one.** It owns an HTTP server,
   so `attachRealtimeTransport` hangs a WebSocket upgrade handler on it and
   `GetCapabilities` reports `sync.realtime-admission` enabled — the one
   capability a container has that the serverless web deployment does not
   (ADR-0009). Clients follow the socket instead of the polling feed, and the
   six-second playback floor a polled group pays does not apply.

4. **The image bakes no configuration and no secret.** Every value arrives as
   container environment. `scripts/generate-env.mjs` mints the two auth secrets
   and the database password with `randomBytes(48)`, prints their names and the
   path it wrote, and refuses to overwrite an existing file without `--force`.

5. **One replica, stated in `compose.yaml` rather than left to a default.**
   Realtime fan-out is single-process: two replicas both persist to
   `sync_events` and neither pushes the other's events to its own sockets, so a
   second replica splits the audience of every live publication with no error
   anywhere.

6. **A second workflow, `.github/workflows/container.yml`.** It builds on every
   pull request without pushing, smoke-tests the compose stack, and publishes to
   GHCR from `master` and from a `v*` tag. `ci.yml` is untouched, so a Docker
   failure cannot be read as a lint, typecheck or test failure.

## What is deliberately not containerized

- **`apps/hq`.** The web profile already serves the same route registration
  through the Fetch adapter mounted at `apps/hq/app/api/[[...rpc]]/route.web.ts`.
  An image of it would be a second deployment of one contract, which is the
  divergence ADR-0009 exists to prevent.
- **The desktop profile.** It is `output: 'export'` with Tauri adapters and has
  no server at run time (ADR-0005). There is nothing for an image to run.
- **`apps/file-bridge`.** It projects a directory on the shoot machine. Inside a
  container it would project the container's filesystem, which is the wrong one
  by construction, and mounting the real one back in would re-open the
  traversal surface ADR-0003 closes.

Nothing here contradicts ADR-0005: the desktop profile stays static and offline,
and this image is a server for the group surface that ADR-0005's amendment
already said needs one.

## Alternatives

**A Redis-over-REST container to complete the tier.** Refused, and refused in
code rather than by preference: `parseRedis` in `apps/control-plane/src/config.ts`
requires an HTTPS endpoint, so a shim at `http://…` is rejected at startup. The
check is not being widened for a container's convenience — a REST token crossing
a cleartext link is a bearer credential any observer of that link can replay.
Whether a shim would satisfy `UpstashCoordination`'s three Lua scripts and
`@upstash/ratelimit`'s own is unknown; none has been run against one, and this
records that it is untested rather than impossible.

**`pnpm deploy` for the runtime tree.** Attempted and rejected on evidence.
pnpm 10.12.3 refuses `pnpm deploy` in a workspace without
`inject-workspace-packages=true`, and the `--legacy` implementation it points
to warns that it is legacy, re-resolves all 868 packages rather than reusing the
install, and runs the repository root's `prepare` script — husky — inside the
image build. The Dockerfile instead installs production dependencies in their
own stage and copies `/app/node_modules`, `/app/packages` and `/app/apps` at
identical paths, so pnpm's symlink graph resolves whether it was written
relative or absolute.

**Publishing a multi-architecture manifest.** Not done. `linux/amd64` only.
Signing and SBOM generation are likewise absent rather than deferred: claiming
provenance a workflow has not produced is worse than claiming none.

## Consequences

- A person with a clone, Docker and no account runs four commands and gets a
  control plane serving against their own PostgreSQL with their own generated
  secrets. `docs/release/self-hosting.md` is that document, and it owns the
  table of what each tier does and does not have.
- The compose healthcheck is stronger than the image's. The image asks only that
  the service answers, because it serves a health-only deployment as
  legitimately as a configured one; compose requires `sync.device-lifecycle` and
  `sync.realtime-admission`, so a container that started health-only — because a
  secret was rejected or the database was unreachable — never becomes healthy
  instead of looking healthy forever.
- `materials.storage-grants` is off in this tier, so `BeginUpload`,
  `CreateMaterialVersion`, `GetDownloadGrant` and `GetPreviewGrant` answer
  `FAILED_PRECONDITION`. Without Redis, presence reports the last state a device
  recorded rather than noticing one gone, and group publications are not rate
  limited. `Health` says which modes are in force.
- Two defects had to be fixed before any of this could start, and both were
  invisible to every existing test because every existing consumer went through
  a bundler or a TypeScript loader. The entry-point guard in `server.ts` folded
  `/` to `\` unconditionally, so `node dist/server.js` on Linux ran no guarded
  block and exited 0 — a process that starts, serves nothing and reports
  success. And `protoc-gen-es` defaults to `import_extension=none`, which
  TypeScript accepts under `moduleResolution: Bundler` and Node's ESM resolver
  does not, so importing the built `@gremuchaya/protocol` failed with
  `ERR_MODULE_NOT_FOUND`. `pnpm control-plane` had the same two failures and
  nobody had run it.
- The published package is private until someone changes its visibility on the
  GHCR package page. No workflow permission grants that, and the header of
  `container.yml` says so where the person who will need it is looking.
