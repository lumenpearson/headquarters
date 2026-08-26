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

## The control plane is built and not reachable from the application

This is the largest gap in the build and the one most likely to be planned around wrongly.

- `apps/control-plane` implements the whole `SyncService` contract plus four services, proved
  against live PostgreSQL. **`apps/hq` holds no client for any of it.** Whatever the server can
  do, no shipped screen can ask it to. Session synchronization in the application still runs over
  the browser screen bus (ADR 0001).
- **Object storage is implemented and unproven against a live bucket.** `BeginUpload`,
  `CreateMaterialVersion`, `GetDownloadGrant` and `GetPreviewGrant` mint AWS Signature Version 4
  presigned URLs once the `HQ_CONTROL_PLANE_STORAGE_*` group in `apps/control-plane/.env.example`
  is set (`apps/control-plane/src/storage/`, no SDK); without it they answer `FAILED_PRECONDITION`
  naming the missing variables. What is proved: the signature algorithm against the AWS SigV4
  test-suite vectors and the S3 API Reference examples (`sigv4.test.ts`), the multipart calls
  against a scripted bucket (`s3-grant-issuer.test.ts`), and the whole lifecycle —
  `CreateMultipartUpload`, part grants, `CompleteMultipartUpload` before the database records the
  version, `AbortMultipartUpload` after it records the cancellation — over binary gRPC-Web against
  live PostgreSQL (`services.wire.integration.test.ts`, `material.integration.test.ts`). What is
  not, because no bucket exists in any environment this repository has been run in: that a real
  store accepts the signed requests; that a client `PUT` to a part grant succeeds and returns the
  etag the completion then sends; that `CompleteMultipartUpload` assembles the object; that a
  download grant serves it. Three gaps are by design and stay open with a bucket: the store never
  checks `content_hash`, so the stored bytes match the declared hash only as far as the client was
  honest; a zero-byte upload plans no parts, opens no multipart upload, and marks the material
  `READY` with no object behind it; every preview variant is the original object served inline,
  because no conversion pipeline renders another.
- **Three `IntegrationService` RPCs answer `unimplemented`** for the same reason: `CreateIssue`,
  `CreateTranslationPullRequest` and `GetPullRequestStatus` need GitHub egress the composition
  root holds no secret for.
- **Three `TelemetryService` RPCs are unimplemented by design.** `ListDataSources`,
  `GetTelemetrySnapshot` and `StreamTelemetry` need a data-source registry and a sample store
  that migrations 0001–0008 do not declare. The simulation half of the contract is complete; the
  measurement half is not.
- **Realtime fan-out is single-process.** Two control-plane processes both persist to
  `sync_events`, but neither pushes the other's events to its own sockets: Upstash REST has no
  pub/sub. A client's periodic reconnect picks up the gap through replay.
- **Without Upstash, presence cannot report a device gone** and publications are unbounded. The
  service still runs; `Health` says which of the two modes is in force.
- `layout_documents`, `layout_versions` and `conversion_jobs` are created by migrations and
  reached by no code. No RPC in the current contract can fill them.
- **Mounted in the web build, a request or response body above 4.5 MB fails.** The Fetch adapter
  (`apps/control-plane/src/fetch-adapter.ts`) is mounted at `apps/hq/app/api/[[...rpc]]/route.web.ts`
  in the web target, and Vercel caps a Function's request body and its response body at 4.5 MB
  each; over that the platform answers `FUNCTION_PAYLOAD_TOO_LARGE` before the handler is reached,
  so no control-plane error names the cause. The two RPCs that can produce a body that large are
  `GetDocumentSnapshot`, whose reply carries the whole serialized document, and
  `PublishDocumentDelta`, whose request carries an update. Nothing in the repository enforces a
  ceiling below the platform's, and no document in any fixture approaches it, so this has not been
  observed — it is recorded here rather than found on a shoot day. The Node process
  (`apps/control-plane/src/server.ts`) has no such cap: it is the same router behind a socket the
  deployment owns.

## Personalization

- **Four settings are declared and do nothing, and the settings screen does not say so.**
  `localization.locale` (no locale runtime exists; every label is a Russian literal),
  `simulation.preset` (the simulation formula reads no setting), `groups.authority` (needs the
  absent sync client) and `titlebar.alignment` (no custom titlebar exists in Rust or in
  TypeScript). They are listed by name in
  `apps/hq/src/application/personalization/presentation.ts`, where a test refuses to let a fifth
  join them silently — but an operator moving one of the four gets no warning.
- There is no custom window titlebar. `tauri.conf.json` sets `decorations` and nothing else.

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
