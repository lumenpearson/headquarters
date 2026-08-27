# The control plane as a container image.
#
# THE BUILD CONTEXT MUST BE THE REPOSITORY ROOT, not this directory:
#
#     docker build -f apps/control-plane/Dockerfile -t gremuchaya-control-plane:local .
#
# `compose.yaml` at the root already does this. Built from `apps/control-plane`
# instead, the first COPY fails on `pnpm-lock.yaml` with a message about a file
# that plainly exists, and nothing in it says the context was the problem. This
# package is three workspace projects and one lockfile, and none of the other
# three lives here.
#
# What this image is not: `apps/hq` is not containerized, because the web
# profile already serves the same route registration through the Fetch adapter
# and a second copy would be the divergence ADR 0009 exists to prevent, and the
# desktop profile is a static export with no server at run time (ADR 0005). The
# file bridge is not containerized because a container's filesystem is not the
# shoot machine's, which is the only filesystem it is useful over (ADR 0003).
# See docs/adr/0010-container-deployment.md.
#
# The image bakes no configuration and no secret. Every value arrives as
# container environment; `apps/control-plane/.env.example` is the complete list.

# One pin for every stage, matching `.tool-versions` and the CI runner exactly.
# A control plane built on a different minor than the one its suites ran on is a
# deployment nobody tested.
ARG NODE_IMAGE=node:24.3.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/pnpm
WORKDIR /app
# The root manifest first and alone: `packageManager` in it is what pins pnpm to
# 10.12.3, and corepack reads it from the working directory. Copying sources
# before this would make every source edit re-resolve the package manager.
COPY package.json ./
RUN corepack enable

# Every workspace manifest, and nothing else. pnpm validates the lockfile
# against all eleven projects even when the filter selects three, so a missing
# manifest fails `--frozen-lockfile` rather than being ignored. This layer is
# invalidated by a dependency change and by nothing else.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/file-bridge/package.json apps/file-bridge/
COPY apps/hq/package.json apps/hq/
COPY packages/config/package.json packages/config/
COPY packages/domain/package.json packages/domain/
COPY packages/layout-engine/package.json packages/layout-engine/
COPY packages/protocol/package.json packages/protocol/
COPY packages/settings-schema/package.json packages/settings-schema/
COPY packages/test-fixtures/package.json packages/test-fixtures/
COPY packages/ui/package.json packages/ui/

# `@gremuchaya/control-plane...` selects the package and its two workspace
# dependencies -- `@gremuchaya/domain` and `@gremuchaya/protocol` -- and nothing
# else. `--ignore-scripts` is deliberate: pnpm 10 already refuses dependency
# lifecycle scripts unless `onlyBuiltDependencies` names them, and none of these
# three projects has an install script of its own. What it does suppress is the
# root `prepare`, which runs husky and needs a `.git` directory this image has
# no reason to contain.
FROM manifests AS deps
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@gremuchaya/control-plane..."

# The same three projects with development dependencies left out, installed
# fresh rather than pruned from the tree above, so the runtime layer is the
# result of one documented pnpm operation instead of a diff between two.
FROM manifests AS prod-deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@gremuchaya/control-plane..."

# `buf` is not needed and not installed: the generated Protobuf bindings under
# `packages/protocol/src/gen` are committed, and `scripts/check-protocol-generation.mjs`
# in CI is what keeps them current. The build here is `tsc -b` three times, in
# dependency order, which is the order pnpm's filtered run already imposes.
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/domain/tsconfig.json packages/domain/
COPY packages/domain/src packages/domain/src
COPY packages/protocol/tsconfig.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
COPY apps/control-plane/tsconfig.json apps/control-plane/
COPY apps/control-plane/src apps/control-plane/src
RUN pnpm --filter "@gremuchaya/control-plane..." build

FROM ${NODE_IMAGE} AS runtime
# `HQ_CONTROL_PLANE_HOST` is loopback by default, which is right for a process
# an operator starts by hand and wrong for a container: published port or not, a
# server bound to 127.0.0.1 inside its own network namespace answers nobody
# outside it -- and it answers them by not answering, with no error anywhere.
# What limits reach here is the container boundary, and `compose.yaml`
# publishing to the host's loopback alone.
ENV NODE_ENV=production
ENV HQ_CONTROL_PLANE_HOST=0.0.0.0
ENV HQ_CONTROL_PLANE_PORT=4100
WORKDIR /app

# The whole installed layout, at the same paths it was installed at, because
# pnpm's `node_modules` is a graph of symlinks between these directories.
# Copying only `apps/control-plane` would leave every `@gremuchaya/*` link
# pointing at nothing. Keeping `/app` as the prefix in both stages is what makes
# this correct whether pnpm wrote those links relative or absolute.
#
# `/app/apps` and `/app/packages` are taken whole rather than named one by one:
# from this stage they are ten `package.json` files and their link farms, so the
# cost is bytes, and no COPY then depends on whether pnpm created a directory
# for a project whose production dependency set happens to be empty.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/packages ./packages
COPY --from=prod-deps --chown=node:node /app/apps ./apps

# The three compiled trees, over the top of the manifests just copied.
COPY --from=build --chown=node:node /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=node:node /app/apps/control-plane/dist ./apps/control-plane/dist

USER node
WORKDIR /app/apps/control-plane
EXPOSE 4100

# Three entry points, all compiled by the build above:
#   dist/server.js      the RPC surface and the realtime WebSocket hub
#   dist/migrate.js     the schema, for a deployment that sets
#                       HQ_CONTROL_PLANE_RUN_MIGRATIONS_ON_START=false
#   dist/healthcheck.js the probe below
#
# The probe asks only that the service answers `SERVING` over its own gRPC-Web
# transport, because this image serves a health-only deployment as legitimately
# as a fully configured one. A deployment that expects a durable surface states
# that expectation where it knows it -- `compose.yaml` overrides this test with
# `--require-capability sync.device-lifecycle --require-capability sync.realtime-admission`,
# which is what turns "started with the wrong database URL" from a container
# that looks healthy into one that never becomes healthy.
HEALTHCHECK --interval=15s --timeout=10s --start-period=45s --retries=5 \
  CMD ["node", "dist/healthcheck.js", "--require-capability", "control.health"]

# `--enable-source-maps` costs nothing today: this build emits declaration maps
# and no source maps. It is here so that a stack trace becomes readable the day
# `sourceMap` is turned on, rather than after someone works out why it is not.
CMD ["node", "--enable-source-maps", "dist/server.js"]
