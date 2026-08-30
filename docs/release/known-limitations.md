# Known release limitations

What this build cannot do, and what has to be supplied to it before a shoot. Each entry names
the code that makes it true, so the next reader can check rather than trust.

## Assets and media

- Final production photography, video and map plates were not present in the repository at
  project bootstrap. All 86 entries in `apps/hq/public/runtime/assets_manifest.json` carry an
  explicit `placeholder` status and render through the safe asset pipeline; every referenced
  asset id is present and replaceable through the ignored runtime override.
- Local font files are not modelled as assets at all. Typography is the OS font stack declared
  in `packages/ui/src/styles/tokens.css`, and `next/font/google` is deliberately not used
  because it fetches at build time — which an offline-first desktop build cannot do (ADR 0005).
- The bundled surveillance loop and twelve thumbnails are demonstration media derived from the
  supplied visual references. Production RTSP endpoints have to be provisioned by the deployment
  environment. What consumes them exists: the desktop shell runs an ffmpeg-backed RTSP-to-HLS
  gateway (`apps/hq/src-tauri/src/media_gateway.rs`), enabled by
  `NEXT_PUBLIC_HQ_ENABLE_NATIVE_RTSP_GATEWAY` and configured through `HQ_CAMERA_STREAMS_CONFIG`;
  a browser deployment reaches an external gateway through `NEXT_PUBLIC_HQ_RTSP_GATEWAY_ORIGIN`.
  **There is no WebRTC path**, and naming one would imply a route that does not exist. Player
  controls, channel switching, assigned local materials and the approved local webcam work.
- Yandex Maps JavaScript **API v3** requires a user-provided browser key
  (`NEXT_PUBLIC_YANDEX_MAPS_API_KEY`) and network access to Yandex map domains. No credential is
  committed. Without a key the tactical screen keeps every operational panel and shows a local
  key-configuration state beside `[ MAP DATA / LOCAL FALLBACK ]` rather than a fake map.

## The control plane is built, wired to a client, and local-only by default

- **Both halves exist, and the two of them were first run together on 2026-08-30.**
  `apps/control-plane` implements the whole `SyncService` contract plus four services, proved
  against live PostgreSQL, and since F10 `apps/hq` holds the client half: `ControlPlaneClient`,
  `RealtimeClient`, `GroupEventPoller` and `GroupSettingsClient` under
  `apps/hq/src/infrastructure/controlPlane/`, mounted by `ControlPlaneRuntime` in the root
  layout. An earlier version of this chapter said `apps/hq` holds no client, which stopped being
  true on 2026-08-26; corrections C43 and C49 in `docs/plans/actual_plan.md` record the same
  claim's life inside the plan, and C59 records this one. Until 2026-08-30 the two halves had
  only ever met through test doubles. `apps/hq/tests/live-control-plane-proof.mjs` now drives
  the production build in two real browser contexts against a running control plane and live
  PostgreSQL: `CreateGroup`, `CreatePairingCode`, `PairDevice`, `TimeSync` and a group-scoped
  setting travelling the `/realtime` socket from one window to the other, 14 assertions of 14.
  **That first run found two defects the doubles could not produce, and both are release
  business.** Pairing sent an empty `public_key`, which a control plane with durable auth
  refuses, so no real pairing had ever succeeded anywhere; the client now presents a persistent
  ECDSA P-256 device identity stored under `gremuchaya-hq:device-identity:v1`, and a browser
  where WebCrypto refuses the curve falls back to 32 random bytes rather than a shared constant.
  And `sync_events.document_id`/`sync_snapshots.document_id` were `uuid` columns while the one
  published document id is the symbolic `settings.live-edit`, so against real PostgreSQL every
  `PublishDocumentDelta` failed whole and the group mirror was never written; **migration 0014
  is required** and widens both columns to `text`. Corrections C61 and C62 in
  `docs/plans/history.md` carry the full account. The proof's own boundary, stated in its
  header: one machine, two origins of one server process — LAN discovery and real network
  latency stay unexercised, and no call has been made from the desktop build.
- **Out of the box the application is local-only, by configuration rather than by gap.**
  `general.localOnly` defaults to `true` (`packages/settings-schema`), and `controlPlaneUrl`
  defaults to an empty list (`packages/config/src/projectSchemas.ts`), so no client is built
  until an operator names an address. Three ways exist, in the order the client checks them:
  the АДРЕС CONTROL PLANE field in the group pairing dialog (device-scoped, stored under
  `gremuchaya-hq:control-plane-address:v1`), `apps/hq/public/runtime/project.override.json`,
  and the `NEXT_PUBLIC_HQ_CONTROL_PLANE_URL` build variable. With no address, or with
  `general.localOnly` on, session synchronization runs over the browser screen bus alone
  (ADR 0001).
- **Object storage has been run against a live bucket once, in a container.** `BeginUpload`,
  `CreateMaterialVersion`, `GetDownloadGrant` and `GetPreviewGrant` mint AWS Signature Version 4
  presigned URLs once the `HQ_CONTROL_PLANE_STORAGE_*` group in `apps/control-plane/.env.example`
  is set (`apps/control-plane/src/storage/`, no SDK); without it they answer `FAILED_PRECONDITION`
  naming the missing variables. What is proved offline: the signature algorithm against the AWS
  SigV4 test-suite vectors and the S3 API Reference examples (`sigv4.test.ts`), the multipart calls
  and the object read-back against a scripted bucket (`s3-grant-issuer.test.ts`), and the whole
  lifecycle — `CreateMultipartUpload`, part grants, `CompleteMultipartUpload` and the verification
  read-back before the database records the version, `AbortMultipartUpload` after it records the
  cancellation — over binary gRPC-Web against live PostgreSQL
  (`services.wire.integration.test.ts`, `material.integration.test.ts`). What was unproven until
  2026-08-29, because no environment this repository had run in held a bucket, is now proved
  against MinIO in Docker by two opt-in suites: a real store accepting the signed requests, a
  client `PUT` to a part grant returning the etag the completion sends back,
  `CompleteMultipartUpload` assembling a two-part 5 MiB + 4 KiB object, and a download grant
  serving those exact bytes (`storage/s3-grant-issuer.live.integration.test.ts` and
  `material/material.live-storage.integration.test.ts`, gated on `HQ_CONTROL_PLANE_TEST_STORAGE_*`
  alongside `HQ_CONTROL_PLANE_TEST_DATABASE_URL`; both create and drop their own bucket). Two of
  the three gaps that were "by design" are closed with them. `CompleteUpload` now reads the
  assembled object back and re-derives its BLAKE3 digest before any version is recorded, so a
  client that declares one file's hash and uploads another is refused rather than allowed to
  poison every later deduplicated reference to that hash; the cost is that every completion reads
  the object once more, and a `content_hash` that is not a 64-character lowercase hexadecimal
  digest — optionally prefixed `blake3:` or `sha256:` — is refused rather than accepted unchecked.
  A zero-byte upload is refused at `BeginUpload` and `CreateMaterialVersion` instead of producing
  a `READY` material with no object behind it; an empty file cannot be stored at all, because a
  real empty object would need an upload path outside the multipart lifecycle. The third gap —
  every preview variant being the original object served inline — closed on 2026-08-29 with the
  conversion pipeline; see the rendition entry below. What no container can settle is a hosted
  store's own behaviour — bucket policy, lifecycle rules, cross-region latency and a provider's
  multipart limits are still unmeasured. The client half of the material lifecycle was run
  against this same bucket for the first time on 2026-08-30
  (`apps/hq/tests/live-materials-lifecycle-proof.mjs`): upload, new version, rename, trash, list
  trash, restore, purge and the library event stream, 13 assertions of 13 on three consecutive
  runs, driven through the real import dialog rather than a scripted client. One device in a
  group it created for itself, so a second device being notified of the first one's upload stays
  unexercised.
- **The three outbound `IntegrationService` RPCs reach a GitHub nobody here can log in to.**
  `CreateIssue`, `CreateTranslationPullRequest` and `GetPullRequestStatus` are served by a REST
  gateway written directly over `fetch`, wired when `HQ_CONTROL_PLANE_GITHUB_TOKEN` and
  `HQ_CONTROL_PLANE_GITHUB_REPOSITORY` are set; without them they answer `FAILED_PRECONDITION`
  naming those two variables rather than `unimplemented`, and `Health` reports `github` while
  `GetCapabilities` reports `integration.github-egress` either way. The token stays inside a
  configuration closure, is spent only by a group that registered no installation of its own,
  and only against the configured repository. What is proved is every request the gateway
  sends and every documented answer it reads — against a scripted `fetch`, against a real HTTP
  GitHub on loopback, and end to end over binary gRPC-Web against live PostgreSQL. What is not
  proved is github.com itself: a live call needs a real token this repository does not hold, so
  rate limits, GitHub App permission scoping, and whether a repository accepts a draft pull
  request are unmeasured. A translation pull request commits a proposal record at a
  configurable path rather than editing a message catalogue, because this control plane cannot
  parse an arbitrary repository's catalogue format. No RPC registers a per-group
  `github_installations` row, and no composition root supplies the `CredentialSealer` that
  storing one needs, so the per-group credential path is still reachable only from the store.
- **Telemetry measures only what a simulation profile declares.** `ListDataSources`,
  `GetTelemetrySnapshot` and `StreamTelemetry` answer from the registry and sample store
  migration 0011 declares, and both halves of the contract are now served. What feeds them is the
  group's own published `SimulationChannel` list: a data source exists because a channel names
  it, and a reading is that channel evaluated by the arithmetic
  `PreviewSimulationProfile` and the client's own simulation already share, so every screen of a
  group reads one number at one sequence. Every snapshot therefore reports `simulated: true`.
  There is no ingest RPC in the contract and none was added, so a control plane cannot receive a
  reading taken on a machine; hardware telemetry stays a client-side concern. A group that has
  published no profile is refused rather than served an empty snapshot, and a stream's cadence is
  the shortest `update_interval_ms ÷ time_scale` its profiles ask for, floored at 200 ms. A group
  keeps its last 720 snapshots; a client that reconnects further behind that resumes from the
  oldest still held.
- **Realtime fan-out crosses processes only where Redis is configured.** A control plane
  announces every group publication on one Redis channel — `hq:realtime:group-events`, carrying a
  group id, a sequence and the announcing process's id, and no event content — and answers a
  sibling's announcement by reading `sync_events` from the cursor of its furthest-behind socket.
  So two processes sharing a database and an Upstash pair no longer split the audience. Without
  Redis nothing carries the announcement and the old behaviour stands: each process serves what it
  published itself, and a client's periodic reconnect picks up the rest through replay. Two
  earlier versions of this entry were wrong in turn — the first blamed Upstash REST for having no
  pub/sub, which it documents as `POST /subscribe/{channel}` over Server-Sent Events; the second
  said nobody had lifted the limitation, which is no longer true.
  What is still unproved is the hosted endpoint itself. The carrier is proved against the pinned
  `@upstash/redis` client, a real Redis and a real PostgreSQL, but Upstash's own SSE route has
  never been reached from this repository: the container stand-in for it,
  `hiett/serverless-redis-http`, answers the command endpoint and returns
  `404 SRH: Endpoint not found` for `/subscribe/{channel}`.
- **The container deployment is one replica because the compose tier configures no Redis.**
  `deploy.replicas: 1` is a constraint there, not a starting point: without the carrier a second
  replica splits the audience of every live publication silently. Scaling this stack is two steps
  — configure the Redis REST pair, then raise the count — and raising the count alone reinstates
  the split.
- **The compose tier has no object storage and no Redis, so two capabilities are off in it.**
  `materials.storage-grants` is disabled and the four grant RPCs answer `FAILED_PRECONDITION`;
  presence reports the last state a device recorded rather than noticing one gone, group
  publications are not rate limited, and no announcement leaves the process — which is the entry
  above, and why the tier pins one replica. Both are upgrades that need an account, and both are
  reported by `Health` and `GetCapabilities` rather than having to be inferred. The fan-out is
  not: nothing in `GetCapabilities` yet says whether a deployment carries announcements across
  processes, so an operator reads it from the Redis capability instead.
  `docs/release/self-hosting.md` holds the full table of what each tier has; it is not repeated
  here.
- **The container image builds, and no registry has ever held it.**
  `apps/control-plane/Dockerfile`, `compose.yaml` and `.github/workflows/container.yml` were
  written on a machine with no Docker installed. They have since been executed: the four-stage
  build completes from the repository root, and the resulting image was run against a
  live PostgreSQL 18. All three entry points answer inside the image — `node dist/server.js`
  binds and serves, `node dist/migrate.js` applies every migration and then re-runs applying
  none, and `node dist/healthcheck.js` reports `SERVING`. `docker compose up -d --wait` brings
  both services to healthy, and the capability assertion `container.yml` makes — ten required
  capabilities and `materials.storage-grants` refused — passes against the compose stack.
  **The Dockerfile did need one fix, found by the workflow's own first execution rather than by
  a local build.** Serving the settings schema made `@gremuchaya/control-plane` depend on
  `@gremuchaya/settings-schema`, and the build stage copied tsconfig and sources for domain and
  protocol only, so `tsc -b` stopped at `TS5083` inside the image; the build stage now carries
  settings-schema's tsconfig and sources and the runtime stage copies its `dist`. Adding a
  workspace dependency to this package therefore means editing the Dockerfile, and nothing
  checks that for you. What is still unproved is everything downstream of the build: no image
  has been pushed to GHCR, so the publish job, the tag rules and the by-hand
  package-visibility step in that workflow's header remain unexecuted; no deployment has run
  this image for longer than a smoke test; and no successful run of `container.yml` itself is
  on record — the fix above was verified locally by running the same sequence the workflow
  runs.
- **On a group fed by polling, a playback command executes six seconds after it is
  pressed — on every screen, including the one that issued it.** The lead has to
  exceed the poll interval or the screens diverge by however long the page took to
  arrive, so `playbackLeadForDelivery` raises the floor to 6000 ms whenever the
  group's delivery is `poll`. A group on a socket keeps whatever the operator set
  (`performance.playbackLeadMs`, 40 ms by default), and so does a session in no
  group at all. The setting cannot express the polling floor — it is declared
  0–400 ms — so the floor lives in code. This is a deliberate trade, not a defect:
  six seconds of waiting buys screens that start together.
- **In a group reachable both on the set's LAN and over the internet, the six-second
  lead applies to every screen — and the rule depends on each screen being
  configured with both addresses.** A playback lead belongs to the publisher: it
  stamps the execution instant and every other screen obeys it. A screen therefore
  publishes with the lead its own slowest link needs, so a screen holding both the
  near plane and the cloud plane publishes at six seconds, and a session outside
  the LAN does the same. That makes every member of a mixed group agree, which is
  what makes them converge. The failure mode this cannot detect: a screen on the
  LAN configured with the near address **only**, in a group that also has a cloud
  plane, publishes at 40 ms, and the screens outside the LAN receive a command
  whose instant has already passed and run it on arrival — a different moment on
  each of them. Presence names devices, not how each of them is fed, so no client
  can notice. **Configure every screen of a mixed group with both addresses, in the
  order near-then-cloud.** A group that has no cloud plane keeps the operator's own
  lead, unchanged.
- **The two planes must share a token pepper and a token hash version.** An access
  token minted by one plane is presented to the other, and the verifying query
  filters by the verifier's own `hash_version` with no issuer recorded on the row.
  Two planes configured with different `HQ_CONTROL_PLANE_AUTH_TOKEN_PEPPER` or
  `HQ_CONTROL_PLANE_AUTH_TOKEN_HASH_VERSION` values would refuse each other's
  sessions, and the refusal would read to the operator as a revoked device.
- **A link whose control plane answers for a different database is shown and never
  followed.** The client compares each address's `installationId` with the one the
  session was checked against; a disagreement is two groups rather than two ways to
  one, so the link is left in the list with its address on show and carries and
  publishes nothing.
- **The session state machine fails over between the planes, and the failover is
  unhurried.** Pairing, refresh, join, presence and the clock all run on the first
  configured address; a publication moves to the second plane while the first is not
  carrying, and both planes feed the event channel. Since 2026-08-30 a session that goes
  `offline` with two or more configured links no longer waits for the operator:
  `attemptPlaneFailover` (`apps/hq/src/components/sync/ControlPlaneRuntime.tsx`) probes the
  other configured planes, promotes the first that answers with device-lifecycle support to
  primary and owner, demotes the old primary to secondary and reader, and rebuilds the session
  against the promoted client — which re-checks the installation identity on connect, so a
  plane answering for a different database lands on `installation-changed` rather than
  joining the wrong group. `ControlPlaneClient.asOwner()`/`.asReader()` build the sibling
  client rather than mutating credentials in place, which keeps exactly one owner of the
  refresh-token rotation. Two limits stand: the retry cadence is the presence interval and
  nothing shortens it, so failover takes up to fifteen seconds; and if no plane answers at
  all the behaviour is unchanged — the group is left through the local copy.
- **Without Upstash, presence cannot report a device gone** and publications are unbounded. The
  service still runs; `Health` says which of the two modes is in force.
- **Every migrated table is now reached by code, and two of them by no client.**
  `conversion_jobs`, created by migration 0001 and reached by nothing for as long as it
  existed, has both a producer and a consumer since 2026-08-29: `completeUpload` queues the
  declared quality ladder, `getPreviewGrant` queues a rung nobody has built, and
  `MaterialConversionWorker` (`apps/control-plane/src/conversion/`) claims a job with
  `FOR UPDATE OF job SKIP LOCKED`, renders it with ffmpeg, writes the object before the row
  that names it, and records the result against migration 0012's `material_renditions`. A
  preview variant is a rendered object wherever the deployment runs the worker: proved against
  live PostgreSQL 18, live MinIO and real ffmpeg, where a 1280x720 source serves an 854x480
  preview whose BLAKE3 differs from the material's `content_hash`. Without a worker the ladder
  accumulates in `conversion_jobs`, nothing consumes it, and every variant is still the
  original — which `Health`'s `conversion` dependency and `GetCapabilities`'
  `materials.rendition-pipeline` both report, so an operator does not have to guess.
  `layout_documents` and `layout_versions` were in the same position until
  `SettingsService.PutLayoutDocument`, `GetLayoutDocument` and `ListLayoutHistory` filled them:
  a screen's whole arrangement, written with an expected revision, and the version log that put
  appends to. The client does not call those three yet, so no surface in `apps/hq` stores a
  layout on the control plane.
- **A document body above 4 MB is refused, and above 4.5 MB the platform would refuse it first.**
  The Fetch adapter (`apps/control-plane/src/fetch-adapter.ts`) is mounted at
  `apps/hq/app/api/[[...rpc]]/route.web.ts` in the web target, and Vercel caps a Function's request
  body and its response body at 4.5 MB each; over that the platform answers
  `FUNCTION_PAYLOAD_TOO_LARGE` before the handler is reached, so no control-plane error would name
  the cause. The two RPCs that can produce a body that large are `GetDocumentSnapshot`, whose reply
  carries the whole serialized document, and `PublishDocumentDelta`, whose request carries an
  update. Both now measure the payload against `maxDocumentBodyBytes` in
  `apps/control-plane/src/http-policy.ts` — 4 000 000 bytes, half a megabyte below the platform's
  limit so the gRPC-Web envelope, the identifiers and the trailers fit inside it — and refuse
  before the log is touched: `INVALID_ARGUMENT` for a request the caller can shrink,
  `FAILED_PRECONDITION` for a reply this deployment cannot deliver, both naming the size and the
  ceiling. The refusal is a better error, not a fix: a document that has grown past the ceiling is
  still a resync a client cannot complete, and nothing in the repository compacts one. The Node
  process (`apps/control-plane/src/server.ts`) has no platform cap and may raise the ceiling
  through `PairedDeviceServiceOptions.maxDocumentBodyBytes`; no assembly point sets it today, so
  every deployment runs the default. The platform half of this — that Vercel really answers
  `FUNCTION_PAYLOAD_TOO_LARGE` — remains unobserved, because no deployment exists to observe it
  on.

## Personalization

- **No setting is declared and read by nothing, and the settings screen would say so if one
  were.** `settingsAwaitingTheirFeature` in
  `apps/hq/src/application/personalization/presentation.ts` is empty as of 2026-08-29. The last
  two members left it that day: `simulation.preset` now supplies the criticality baseline under
  a channel with no operator-drawn curve (`application/simulation/simulationCurves.ts`), and
  `layout.tileMinimumWidth` is read by `resolveGridLayout`, which takes an optional
  `containerWidth`/`minimumTileWidth` pair and checks each candidate variant against the
  measured pixel width — capping the column count instead is what emptied eleven routes, and
  that approach was not taken. Its default is 160, the floor of the range: at 240 the setting
  displaced a map-layer checkbox and a report kind from stock screens at 1440x900 the day the
  resolver gained its reader. The accounting test still refuses to let a definition join the
  list silently, and `SchemaSetting` now prints a `ПОКА НЕ ДЕЙСТВУЕТ` notice beside any member
  of it, tracking the list rather than any hardcoded id — so an operator moving a future
  unwired setting is warned. Two earlier versions of this entry named four settings and then
  two; `localization.locale`, `groups.authority` and `titlebar.alignment` gained readers before
  these — the locale runtime in `apps/hq/src/application/localization/locale.ts`, the authority
  reconciliation in `ControlPlaneRuntime` over `SetAuthorityMode`, and the `TitleBar` component
  with its `data-titlebar-alignment` attribute.

## Local access and the shoot machine

- **Browser directory access is not persisted.** `BrowserDirectorySource` holds the picked handle
  in memory, and with no IndexedDB in the project a `FileSystemDirectoryHandle` cannot survive a
  reload. The directory must be picked again every browser session. Tauri and the localhost
  bridge are the persistent alternatives.
- The desktop shell can now supervise `apps/file-bridge` itself
  (`apps/hq/src-tauri/src/file_bridge_supervisor.rs`), in the idiom
  `media_gateway.rs` already uses for its `ffmpeg` workers: spawn, watch for
  exit, restart with exponential backoff and jitter. It is opt-in and unset
  by default — `HQ_FILE_BRIDGE_AUTOSTART_COMMAND` is the one gate, and with
  it absent (every machine today) the module spawns nothing at all, so an
  operator who wants the bridge still starts it separately unless that
  variable is set. `HQ_FILE_BRIDGE_AUTOSTART_ARGS`, `_CWD` and `_ENV` (each a
  JSON value) fill in arguments, a working directory and extra environment
  variables such as `HQ_BRIDGE_CONFIG`. A malformed value disables autostart
  rather than failing the shell, logged to stderr, because the bridge itself
  is optional by ADR-0003 and a typo in an optional variable should not take
  the rest of the app down with it.
- Local production mount paths are intentionally uncommitted and configured per shoot machine.
- `FREEZE` and `BLACKOUT` are one-way in the interface. `resetScene` is the only exit, which is
  what the runbook prescribes, and no toggle was added because adding one would contradict the
  recorded shoot-day rule. What changed on 2026-08-29 is that the state is now visible rather
  than inferred: `TopBar` reads the screens slice and reflects an active freeze or blackout on
  the existing buttons through `aria-pressed`, an `is-active` class and a Russian tooltip
  naming `RESET` as the exit. An operator reaching for a toggle still will not find one, but no
  longer has to guess whether the command took.
- **The desktop CSP cannot name an arbitrary LAN control plane, so the R18-aligned answer routes
  that traffic through a Tauri command instead.** `tauri.conf.json`'s `connect-src` admits
  loopback, `https://*.vercel.app` and `wss://*.vercel.app`, which covers the deployed control
  plane and the socket, but cannot cover a control plane at an address like
  `http://192.168.10.5:4100`: CSP wildcards only the leftmost label of a hostname and cannot
  wildcard an IP address at all. `control_plane_http_request`
  (`apps/hq/src-tauri/src/control_plane_proxy.rs`) is now registered for exactly that case: the
  webview never addresses a LAN control plane directly, it calls this command over `ipc:` — which
  the CSP already admits — and the native process makes the real request outside the CSP
  entirely. `apps/hq/src/infrastructure/tauri/controlPlaneLanProxy.ts` is the client half,
  handed to `createGrpcWebTransport` as its `fetch` override
  (`apps/hq/src/infrastructure/controlPlane/transport.ts`): it steps aside to the real `fetch` for
  every address the CSP already admits, and only routes through the command for a literal
  private-use, loopback or link-local IPv4/IPv6 `http://` address, which is also everything the
  Rust command itself will carry (no DNS name, no `https://`, no method beyond `GET`/`POST`) —
  the client-side check is routing, not the security boundary, which is enforced again on the
  Rust side independently. **What this does not cover:** a long-lived server-streaming RPC
  (`WatchGroup`, `TimeSync`) is buffered start to finish before crossing back over `ipc:`, so it
  only completes through this path once the peer closes the response on its own, not while it is
  still streaming; and the realtime WebSocket channel does not use this command at all and is
  still blocked by the same CSP gap for a LAN address, unaddressed by this change. The two
  cheaper alternatives the previous text named still apply where they fit better: build the
  desktop bundle with the address baked in (`tauri build --config`), or put the LAN control plane
  behind a name under a domain the CSP already admits. **Not verified against the real WebView2
  runtime** — this container has no Windows target; the Rust half is proven against a loopback
  HTTP fixture (`cargo test --manifest-path apps/hq/src-tauri/Cargo.toml control_plane_proxy`) and
  the TypeScript half against a mocked Tauri IPC bridge
  (`controlPlaneLanProxy.test.ts`), not against a shipped installer.

## Verification that cannot be done here

- Camera-based moire and readability approval and the two-hour long-run test require the actual
  production monitors and cannot be truthfully completed on a development workstation. Nothing in
  `apps/hq/tests/` measures cover latency or runs a soak, so there is no automated substitute.
- The opt-in PostgreSQL suites now run in CI. `.github/workflows/ci.yml` gives the `verify` job a
  `postgres:18` service container and points `HQ_CONTROL_PLANE_TEST_DATABASE_URL` and
  `HQ_CONTROL_PLANE_TEST_DATABASE_DRIVER=postgres` at it on the `Test` step alone, so no secret
  is involved and every other step sees the environment it saw before. Fourteen suite files and
  161 tests that a run without the variable skipped are now executed on every pull request. Two
  things this does not cover: the suites still run against the TCP driver only, so the `neon`
  HTTP adapter is proved by a local run and not by CI, and the three `*.live*` storage suites
  stay skipped because `HQ_CONTROL_PLANE_TEST_STORAGE_*` names an S3-compatible bucket the job
  does not stand up.
