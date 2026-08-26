# ADR-0009: One route registration, two adapters

- Status: Accepted
- Date: 2026-08-26

## Context

The control plane existed as one Node process. Route registration, collaborator
resolution, origin policy and `connectNodeAdapter` all lived in
`apps/control-plane/src/server.ts`, which was adequate for as long as the only
way to reach the RPC surface was a socket that process owned.

Two requirements arrived that this shape cannot serve.

The first is deployment. The web profile is to be served from one origin,
interface and RPC surface together, on a platform that runs request handlers
rather than long-lived processes. A second process beside the Next.js
application is precisely what such a platform does not offer.

The second is the set itself. A control plane on the shoot's own machine keeps
the Node process — it holds WebSocket listeners for realtime fan-out, which a
request handler cannot — so the process is not being replaced. Both must serve
the same contract, and the contract must not exist twice.

The obvious failure here is not a broken build but a slow divergence: two route
registrations that agree on the day they are written, and disagree about which
origins may call, which services are registered, or what `GetCapabilities`
reports, on some later day when only one of them was edited.

## Decision

1. Route registration lives in `apps/control-plane/src/routes.ts` and is called
   by every adapter. `registerControlPlaneRoutes`,
   `resolveControlPlaneCollaborators` and the types they need moved there;
   `server.ts` imports them and does not re-export them.
2. The HTTP policy — which origins are admitted, what a preflight answers, which
   headers every response carries — is one pure function of two request facts in
   `apps/control-plane/src/http-policy.ts`. Both adapters call it; neither
   restates it. A response produced by the router carries the same headers as
   one produced by the policy itself.
3. `apps/control-plane/src/fetch-adapter.ts` builds a `ConnectRouter` over the
   same registration and wraps each handler with `createFetchHandler` from
   `@connectrpc/connect/protocol`. Dispatch is an exact match on
   `prefix + requestPath`. Anything else is 404: a prefix fallback would answer
   on behalf of a method that does not exist.
4. The package declares four entry points — `.`, `./routes`, `./config` and
   `./fetch` — so a web bundle can reach the router and the configuration parser
   without importing the process entry point, and with it `ws` and `node:http`.
5. The web build mounts the fetch adapter at
   `apps/hq/app/api/[[...rpc]]/route.web.ts`. `pageExtensions` in
   `apps/hq/next.config.ts` depends on the build target, so this file is a route
   in the web build and matches no route leaf in the desktop build — not a
   route, not in the module graph, not in the bundle — while remaining
   typechecked and linted in both.
6. Collaborators are a module-level memoized promise that is cleared on failure.
   A serverless instance serves many requests, so resolving them per request
   would repeat the migration transaction; caching a rejected promise would
   poison the instance for its lifetime.
7. `apps/hq` may not import `@gremuchaya/control-plane`. This is enforced by
   `no-restricted-imports` in the root `eslint.config.mjs` across
   `apps/hq/src/**` and `apps/hq/app/**`, with one exception for
   `apps/hq/app/api/**/route.web.ts`.

## Alternatives

**A second router for the web build.** Rejected: it is the divergence described
above, written down on purpose.

**Re-exporting the moved symbols from `server.ts`.** Rejected. A re-export keeps
two names for one thing and lets an import choose the heavier module by
accident, which is exactly what entry point 4 exists to prevent.

**Running the Node process on the deployment platform.** Rejected as unavailable
rather than undesirable: the platform holds no instance open for a socket to
belong to, and pins no instance on any plan.

**Serving realtime over the fetch adapter.** Not attempted. `WatchGroup` is
registered on it and has never been exercised there; a serverless deployment
reads the group log by polling instead, because a subscriber admitted by one
instance is invisible to a publisher on another.

## Consequences

- The proof that the move was pure is a run that did not change:
  `apps/control-plane` reported 33 files and 329 tests before it and the same 33
  and 329 after, with no expectation edited.
- The proof that the policy is shared is a mutation: removing the origin check
  from `http-policy.ts` fails both the new wire suite and the existing
  Node-adapter suite. Two copies would have failed one.
- `@connectrpc/connect/protocol` is marked `@private` by the package and carries
  no semver promise. The wire suite — a real `createGrpcWebTransport` whose
  `fetch` calls the handler directly — is what turns an upgrade that changes it
  into a failed test rather than a failed deployment.
- The desktop build must stay static (ADR-0005). The target-dependent
  `pageExtensions` is what keeps that true while the file sits in the tree;
  without it `output: 'export'` refuses the route for want of
  `generateStaticParams()`.
- A request or response body above 4.5 MB fails on the deployment platform
  before the handler is reached. `GetDocumentSnapshot` and `PublishDocumentDelta`
  are the two RPCs that can produce one; nothing in this repository enforces a
  lower ceiling. Recorded in `docs/release/known-limitations.md`.
- The Node adapter keeps what only it can hold: `attachRealtimeTransport` and
  the WebSocket hub belong to it and are not part of the shared registration.
