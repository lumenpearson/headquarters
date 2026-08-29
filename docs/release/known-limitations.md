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

- **Both halves exist.** `apps/control-plane` implements the whole `SyncService` contract plus
  four services, proved against live PostgreSQL, and since F10 `apps/hq` holds the client half:
  `ControlPlaneClient`, `RealtimeClient`, `GroupEventPoller` and `GroupSettingsClient` under
  `apps/hq/src/infrastructure/controlPlane/`, mounted by `ControlPlaneRuntime` in the root
  layout. An earlier version of this chapter said `apps/hq` holds no client, which stopped being
  true on 2026-08-26; corrections C43 and C49 in `docs/plans/actual_plan.md` record the same
  claim's life inside the plan, and C59 records this one.
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
  real empty object would need an upload path outside the multipart lifecycle. The remaining gap
  is unchanged: every preview variant is the original object served inline, because no conversion
  pipeline renders another. What no container can settle is a hosted store's own behaviour —
  bucket policy, lifecycle rules, cross-region latency and a provider's multipart limits are
  still unmeasured.
- **Three `IntegrationService` RPCs answer `unimplemented`** for the same reason: `CreateIssue`,
  `CreateTranslationPullRequest` and `GetPullRequestStatus` need GitHub egress the composition
  root holds no secret for.
- **Three `TelemetryService` RPCs are unimplemented by design.** `ListDataSources`,
  `GetTelemetrySnapshot` and `StreamTelemetry` need a data-source registry and a sample store
  that migrations 0001–0008 do not declare. The simulation half of the contract is complete; the
  measurement half is not.
- **Realtime fan-out is single-process.** Two control-plane processes both persist to
  `sync_events`, but neither pushes the other's events to its own sockets, because nothing in this
  repository carries an event between processes: `CoordinationRedisClient` offers
  `set/sadd/expire/smembers/mget/incr` and subscribes to nothing. A client's periodic reconnect
  picks up the gap through replay. An earlier version of this entry gave the reason as Upstash REST
  having no pub/sub, which is wrong — it documents `POST /subscribe/{channel}` over Server-Sent
  Events, and the pinned `@upstash/redis` exposes `subscribe()`. The limitation is one nobody has
  lifted, not one that cannot be lifted.
- **The container deployment is therefore one replica, and `compose.yaml` says so rather than
  leaving it to a default.** `deploy.replicas: 1` is a constraint, not a starting point: a second
  replica splits the audience of every live publication silently, because the entry above means
  neither replica pushes the other's events to its own sockets. Scaling this stack needs the
  cross-process carrier that does not exist, not a larger number.
- **The compose tier has no object storage and no Redis, so two capabilities are off in it.**
  `materials.storage-grants` is disabled and the four grant RPCs answer `FAILED_PRECONDITION`;
  presence reports the last state a device recorded rather than noticing one gone, and group
  publications are not rate limited. Both are upgrades that need an account, and both are reported
  by `Health` and `GetCapabilities` rather than having to be inferred.
  `docs/release/self-hosting.md` holds the full table of what each tier has; it is not repeated
  here.
- **The container image has never been built.** `apps/control-plane/Dockerfile`, `compose.yaml` and
  `.github/workflows/container.yml` were written on a machine with no Docker installed, and the
  workflow's first pull-request run is the first time any of it is executed. What was proved
  without Docker: the three compiled entry points exist, and `node dist/server.js` and
  `node dist/healthcheck.js` work against a hand-assembled copy of the layout the runtime stage
  produces — production dependencies and the three `dist` trees, nothing else.
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
- **The session state machine does not fail over between the planes.** Pairing,
  refresh, join, presence and the clock all run on the first configured address. A
  publication moves to the second plane while the first is not carrying, and both
  planes feed the event channel, but if the first plane stops answering entirely
  the session goes `offline` and the group is left through the local copy rather
  than through the second plane. Nothing in this stage rebuilds the session on
  another address.
- **Without Upstash, presence cannot report a device gone** and publications are unbounded. The
  service still runs; `Health` says which of the two modes is in force.
- `layout_documents`, `layout_versions` and `conversion_jobs` are created by migrations and
  reached by no code. No RPC in the current contract can fill them.
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

- **Two settings are declared and read by nothing, and the settings screen does not say so.**
  `simulation.preset` (nothing maps a preset name onto the set of values it stands for) and
  `layout.tileMinimumWidth` (the layout resolver takes no minimum-width input, and capping the
  column count instead emptied eleven routes). Both are listed by name in
  `apps/hq/src/application/personalization/presentation.ts` (`settingsAwaitingTheirFeature`),
  where a test refuses to let a third join them silently — but an operator moving either gets no
  warning. An earlier version of this entry named four; `localization.locale`,
  `groups.authority` and `titlebar.alignment` have since gained readers — the locale runtime in
  `apps/hq/src/application/localization/locale.ts`, the authority reconciliation in
  `ControlPlaneRuntime` over `SetAuthorityMode`, and the `TitleBar` component with its
  `data-titlebar-alignment` attribute.

## Local access and the shoot machine

- **Browser directory access is not persisted.** `BrowserDirectorySource` holds the picked handle
  in memory, and with no IndexedDB in the project a `FileSystemDirectoryHandle` cannot survive a
  reload. The directory must be picked again every browser session. Tauri and the localhost
  bridge are the persistent alternatives.
- The desktop build does not start `apps/file-bridge` itself: no line in `apps/hq/src-tauri`
  mentions it, so an operator who wants the bridge starts it separately.
- Local production mount paths are intentionally uncommitted and configured per shoot machine.
- `FREEZE` and `BLACKOUT` are one-way in the interface. `resetScene` is the only exit, which is
  what the runbook prescribes — but an operator reaching for a toggle will not find one.
- **The desktop CSP cannot name an arbitrary LAN control plane.** `tauri.conf.json`'s
  `connect-src` now admits loopback, `https://*.vercel.app` and `wss://*.vercel.app`, which
  covers the deployed control plane and the socket. It cannot cover a control plane at an
  address like `http://192.168.10.5:4100`: CSP wildcards only the leftmost label of a hostname
  and cannot wildcard an IP address at all, so "any private range" is not expressible. The
  address is blocked in the webview **before a request is made**, which reads as a network
  failure rather than a policy one. Three ways out, in the order they cost: build the desktop
  bundle with that address baked in (`tauri build --config`), put the LAN control plane behind
  a name under a domain the CSP already admits, or route the traffic through a Tauri command so
  the webview only ever talks to `ipc:` — the last is the R18-aligned answer and is not built.

## Verification that cannot be done here

- Camera-based moire and readability approval and the two-hour long-run test require the actual
  production monitors and cannot be truthfully completed on a development workstation. Nothing in
  `apps/hq/tests/` measures cover latency or runs a soak, so there is no automated substitute.
- The opt-in PostgreSQL suites never run in CI: the workflow sets no
  `HQ_CONTROL_PLANE_TEST_DATABASE_URL`. They are run locally and their results are recorded in
  `docs/plans/actual_plan.md`; CI proves the offline half only.
