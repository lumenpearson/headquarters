//! In-app update download with pause/resume, and the trust boundary around it.
//!
//! ## Why a second download path exists
//!
//! `tauri-plugin-updater` v2.10.1's own `Update::download` (`download_url`/`signature`
//! are the only fields of `Update` this module reads) has no way to pause or resume: it
//! opens one streaming GET, buffers every chunk into memory as it arrives, and only
//! offers a callback for progress -- there is no cancellation token, and calling it again
//! after an interruption restarts the whole transfer. Confirmed by reading the crate's own
//! source rather than assumed: `Update::download`'s only inputs are the two closures
//! `on_chunk`/`on_download_finish`, and neither the plugin's Rust API nor its JS bindings
//! (`guest-js/index.ts`) expose a handle to interrupt an in-flight request.
//!
//! So this module downloads the same `download_url` itself, with HTTP `Range` requests
//! against a temp file, and stops there being two update packages in flight: the plugin's
//! `check` command (invoked from the frontend through `@tauri-apps/plugin-updater`) is
//! still what produces the `Update` object -- `update_download_start` takes that object's
//! resource id and takes ownership of it (`ResourceTable::take`), so exactly one `Update`
//! is ever in play per check. `Update::download` verifies the minisign signature itself as
//! part of downloading; this module's downloader does not go through it, so it repeats
//! that verification by hand in `update_install`, against the same base64-then-minisign
//! format (`base64` decodes the transport, `minisign-verify` checks the signature) --
//! `Update::install` trusts whatever bytes it is given completely, and this is the one
//! place upstream from it that can still refuse them.
//!
//! ## The trust anchor is a placeholder
//!
//! `tauri.conf.json`'s `plugins.updater.pubkey` is not a real minisign public key today --
//! it is a literal placeholder string, documented as such at its call site
//! (`read_updater_pubkey`). The matching private key is a shoot-floor secret this
//! environment does not hold, `bundle.createUpdaterArtifacts` stays `false` because
//! producing a signed release needs it, and a real `check`/download/verify cycle against
//! the placeholder is expected to fail: `PublicKey::decode` on a non-minisign string
//! returns `Err`, which surfaces here as `AppUpdaterError::SignatureMismatch`, never a
//! panic. That failure is the honest state until the real key pair exists; see
//! `docs/release/known-limitations.md`. The whole chain -- a valid signature passing, a
//! single flipped payload byte failing, and this literal placeholder failing closed before
//! it ever reaches `PublicKey::decode` -- is pinned by the `verify_signature` tests below
//! against a real minisign keypair, not asserted from reading the code.
//!
//! ## Lifecycle
//!
//! `update_download_start` takes ownership of the checked `Update`, opens (or reuses) a
//! version-named temp file, and streams the response into it, checking `paused`/
//! `cancelled` between chunks. Pausing keeps the file and returns; the temp file's own
//! length *is* the resume offset, so `update_download_resume` needs nothing else to
//! continue from. A resume is not just "keep going from this many bytes", though: the
//! endpoint this module downloads from (`.../releases/latest/download/latest.json`) always
//! tracks the newest release, so between a pause and a resume the file at `download_url`
//! can legitimately have changed underneath the partial bytes already on disk. Three
//! things guard against splicing a resume onto the wrong file: the first response's
//! `ETag` (falling back to `Last-Modified`) is captured and persisted next to the temp
//! file, then sent back as `If-Range` on every later request against that file
//! (`validator_path`); a `206` response's own `Content-Range` start is parsed and must
//! equal the requested offset, not merely trusted because the status code was `206`
//! (`resolve_range`, `parse_content_range_start`); and a `416` (the offset this module
//! computed is no longer satisfiable -- the remote file shrank or was replaced) triggers
//! exactly one automatic restart from byte zero rather than surfacing as a generic
//! failure. Any of the three discards the stale prefix rather than trusting it. None of
//! this replaces the signature check in `update_install` -- a byte-identical replacement
//! release would defeat all three and still be caught there -- it only keeps an honest
//! *mismatch* from being misread as tampering, and stops a corrupted temp file from
//! looping forever on retries that never do anything differently (see `update_install`'s
//! cleanup on a verification failure).
//!
//! `update_install` refuses to run unless the download reached `complete` and was not
//! `cancelled`, verifies the signature, and only then calls `Update::install` -- which on
//! Windows launches the installer and exits the process, and does not return.
//!
//! ## Two different things both called "the lock"
//!
//! `DownloadControl::download_lock` (a `tokio::sync::Mutex<()>`) is the only thing standing
//! between "resume while the previous attempt is still writing" and a corrupted file:
//! `run_download` holds it for its entire body, and it always *tries* to acquire it rather
//! than waiting -- a second call into `run_download` for a session already being written
//! (whether that is a second `update_download_start`, or `update_download_resume` racing
//! an attempt still in flight) fails immediately with `DownloadInProgress` instead of
//! queuing behind it and then running against a file a first attempt has since finished or
//! restarted. `SessionSlot::begin_fresh` peeks at that same lock too, but for a different
//! reason: it decides whether an *older, different* session can be replaced with a new one
//! at `update_download_start`, refusing rather than silently orphaning a writer that is
//! still active on the session being replaced. Both refuse rather than queue; neither ever
//! blocks waiting for the other's writer to finish.
//!
//! ## Why session bookkeeping is generic
//!
//! `SessionSlot<T>`/`Session<T>` hold the mutual-exclusion and replace-only-if-current
//! logic against a type parameter rather than `tauri_plugin_updater::Update` directly.
//! That type has no public constructor -- every field but the three this module reads is
//! private, and there is no `Deserialize` impl either -- so a test that needed a real
//! `Update` could only get one through a live `check()` call. Parameterizing keeps that
//! bookkeeping provable with `cargo test` against a plain fixture type, and confines the
//! real `Update` to the two command bodies that actually call methods on it. `run_download`
//! itself takes no `Update` and no `AppHandle` either, for the same reason: it is a plain
//! `(Url, &Path, &DownloadControl, on_progress)` function precisely so its pause/resume/
//! cancel/restart behaviour can run against a real local HTTP server in `cargo test`
//! without a Tauri app to host it.
//!
//! ## Which window may call these
//!
//! `capabilities/maintenance.json` grants the `updater:*` permissions -- the plugin's own
//! `check`/`download`/`install` commands -- to the `control` window only. That grant does
//! not reach the five commands in this module: they are plain `#[tauri::command]`s with no
//! permission identifier of their own, so Tauri's ACL has nothing to gate on them at all,
//! and a `screen-*` display window can invoke any of them today by name just as freely as
//! `control` can. `update_download_start` is naturally scoped regardless -- its `rid`
//! lives in the calling webview's own resource table, so a `screen-*` window has no `rid`
//! that resolves to anything -- but `update_download_pause`/`resume`/`cancel`/`install`
//! all read the single shared `AppUpdaterState` with no such scoping, so without an
//! explicit check a display window could pause, cancel, or install the control window's
//! download. `refuse_unless_control_window` is that check, applied to those four.

use std::{
    env,
    io::SeekFrom,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use base64::Engine;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, ResourceId, State, Webview, WebviewWindow};
use tauri_plugin_updater::Update as TauriUpdate;
use thiserror::Error;
use tokio::{
    fs::OpenOptions,
    io::{AsyncSeekExt, AsyncWriteExt},
    sync::Mutex,
};
use url::Url;

#[derive(Debug, Error)]
pub enum AppUpdaterError {
    #[error("the checked update is no longer available")]
    UnknownUpdateResource,
    #[error("a download is already in progress for this update")]
    DownloadInProgress,
    #[error("no update download has been started")]
    NoDownloadSession,
    #[error("update download failed: {0}")]
    DownloadFailed(String),
    #[error("the update download has not finished yet")]
    DownloadIncomplete,
    #[error("downloaded update package failed signature verification")]
    SignatureMismatch,
    #[error("update installation failed: {0}")]
    InstallFailed(String),
    #[error("the updater public key is not configured")]
    MissingPubkey,
    #[error("refusing to open a symlinked update temp file")]
    SymlinkedTempFile,
    #[error("this command is only available to the control window")]
    WrongWindow,
}

impl Serialize for AppUpdaterError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum DownloadOutcome {
    Complete,
    Paused,
    Cancelled,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    received: u64,
    total: Option<u64>,
}

/// The flags a running download checks between chunks, and the lock that keeps two
/// downloads from ever writing the same temp file at once. Separate `AtomicBool`s rather
/// than one enum because `pause`/`cancel` are set from a different command invocation than
/// the one reading them, with no shared `&mut` to synchronize through except these.
#[derive(Default)]
struct DownloadControl {
    paused: AtomicBool,
    cancelled: AtomicBool,
    /// Set once the whole body has been read and its length matches what the server
    /// declared (when it declared one at all). `update_install` refuses to run without it.
    complete: AtomicBool,
    /// Held for the whole body of `run_download`, which always *tries* to acquire it and
    /// never waits -- see the module doc's "two different things both called 'the lock'"
    /// section. Also the signal `update_download_cancel` uses to tell whether a
    /// `run_download` loop is currently alive to observe `cancelled` on its own: if this
    /// can be acquired immediately, nothing is running, and that command must do the
    /// cleanup itself (the common case is cancelling a *paused* download, where
    /// `run_download` already returned as soon as it saw `paused` and there is nothing
    /// left to notice a flag changing).
    download_lock: Mutex<()>,
}

struct Session<T> {
    payload: T,
    temp_path: PathBuf,
    control: Arc<DownloadControl>,
}

/// Holds at most one active `Session<T>`, with two rules: never replace one whose
/// `download_lock` is still held (see the module doc), and never clear a session that has
/// already been superseded. See the module doc for why `T` is generic.
struct SessionSlot<T> {
    current: Mutex<Option<Arc<Session<T>>>>,
}

impl<T: Send + Sync + 'static> SessionSlot<T> {
    fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }

    /// Starts a brand-new session, discarding whatever an earlier attempt at the same
    /// `temp_path` left on disk. Refuses with `DownloadInProgress` rather than replacing
    /// the shared session out from under a writer that is still active.
    async fn begin_fresh(
        &self,
        payload: T,
        temp_path: PathBuf,
    ) -> Result<Arc<Session<T>>, AppUpdaterError> {
        let mut guard = self.current.lock().await;
        if let Some(existing) = guard.as_ref() {
            if existing.control.download_lock.try_lock().is_err() {
                return Err(AppUpdaterError::DownloadInProgress);
            }
        }
        // Safe to remove now: either there was no previous session, or its
        // `download_lock` was just proven free, so nothing is writing this path.
        let _ = tokio::fs::remove_file(&temp_path).await;
        let session = Arc::new(Session {
            payload,
            temp_path,
            control: Arc::new(DownloadControl::default()),
        });
        *guard = Some(session.clone());
        Ok(session)
    }

    async fn current(&self) -> Result<Arc<Session<T>>, AppUpdaterError> {
        self.current
            .lock()
            .await
            .clone()
            .ok_or(AppUpdaterError::NoDownloadSession)
    }

    /// Clears the shared session only if it is still the one passed in, so an outcome from
    /// an old, already-superseded attempt can never clear a newer session.
    async fn clear_if_current(&self, session: &Arc<Session<T>>) {
        let mut guard = self.current.lock().await;
        if guard
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            *guard = None;
        }
    }
}

/// Tauri-managed state for the one update download this shell tracks at a time, the same
/// shape `MediaGatewayState`/`FileBridgeSupervisorState` already use: an `Arc`-backed
/// inner value, cloned cheaply into whatever needs it.
#[derive(Clone)]
pub struct AppUpdaterState {
    session: Arc<SessionSlot<TauriUpdate>>,
}

impl AppUpdaterState {
    pub fn new() -> Self {
        Self {
            session: Arc::new(SessionSlot::new()),
        }
    }
}

impl Default for AppUpdaterState {
    fn default() -> Self {
        Self::new()
    }
}

/// The one place all five commands check the calling window -- see the module doc's
/// "which window may call these" section for why this exists at all. `update_download_start`
/// does not call it: its `rid` argument is already scoped to the calling webview's own
/// resource table, so it needs no separate check.
///
/// Not covered by `cargo test` directly: a `&WebviewWindow` only comes from a running
/// Tauri app (`tauri::test::mock_builder()` plus an actual built `App` and a real
/// `WebviewWindow` on it, none of which anything else in this module's test suite needs),
/// and pulling that machinery in just for a two-branch string comparison would cost far
/// more than it proves. The body is kept to exactly that -- one comparison, one `Ok`, one
/// named `Err` -- so the risk that comment is meant to cover stays reviewable by reading it.
fn refuse_unless_control_window(window: &WebviewWindow) -> Result<(), AppUpdaterError> {
    if window.label() == "control" {
        Ok(())
    } else {
        Err(AppUpdaterError::WrongWindow)
    }
}

#[tauri::command]
pub async fn update_download_start(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppUpdaterState>,
    rid: ResourceId,
) -> Result<DownloadOutcome, AppUpdaterError> {
    let update = {
        // Scoped so the synchronous `std::sync::MutexGuard` behind `resources_table()` is
        // dropped before the first `.await` below -- it is not `Send` and must never be
        // held across a suspension point.
        let mut table = webview.resources_table();
        let update = table
            .take::<TauriUpdate>(rid)
            .map_err(|_| AppUpdaterError::UnknownUpdateResource)?;
        (*update).clone()
    };
    let temp_path = temp_download_path(&update.version);
    let session = state.session.begin_fresh(update, temp_path).await?;
    let outcome = run_download(
        &session.payload.download_url,
        &session.temp_path,
        &session.control,
        |received, total| {
            let _ = app.emit(
                "hq:update-download-progress",
                ProgressPayload { received, total },
            );
        },
    )
    .await?;
    if outcome == DownloadOutcome::Cancelled {
        state.session.clear_if_current(&session).await;
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn update_download_pause(
    window: WebviewWindow,
    state: State<'_, AppUpdaterState>,
) -> Result<(), AppUpdaterError> {
    refuse_unless_control_window(&window)?;
    let session = state.session.current().await?;
    session.control.paused.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn update_download_resume(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppUpdaterState>,
) -> Result<DownloadOutcome, AppUpdaterError> {
    refuse_unless_control_window(&window)?;
    let session = state.session.current().await?;
    if session.control.complete.load(Ordering::SeqCst) {
        return Ok(DownloadOutcome::Complete);
    }
    session.control.paused.store(false, Ordering::SeqCst);
    let outcome = run_download(
        &session.payload.download_url,
        &session.temp_path,
        &session.control,
        |received, total| {
            let _ = app.emit(
                "hq:update-download-progress",
                ProgressPayload { received, total },
            );
        },
    )
    .await?;
    if outcome == DownloadOutcome::Cancelled {
        state.session.clear_if_current(&session).await;
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn update_download_cancel(
    window: WebviewWindow,
    state: State<'_, AppUpdaterState>,
) -> Result<(), AppUpdaterError> {
    refuse_unless_control_window(&window)?;
    let session = state.session.current().await?;
    session.control.cancelled.store(true, Ordering::SeqCst);
    // A `run_download` loop that is actively writing sees this flag on its own before its
    // next chunk and cleans up when it exits. If nothing is running -- see
    // `DownloadControl::download_lock`'s doc -- this command has to do that cleanup
    // itself, or a download cancelled while paused would leave its partial file and its
    // session in place forever, with `Ok(())` telling the caller it had already gone away.
    if let Ok(_guard) = session.control.download_lock.try_lock() {
        remove_download_artifacts(&session.temp_path).await;
        state.session.clear_if_current(&session).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppUpdaterState>,
) -> Result<(), AppUpdaterError> {
    refuse_unless_control_window(&window)?;
    let session = state.session.current().await?;
    // Checked ahead of `complete`, not instead of it: a session can be `complete` and
    // `cancelled` both at once (cancel called after a download finished but before this
    // command ran), and `cancelled` must win in that case.
    if session.control.cancelled.load(Ordering::SeqCst) {
        return Err(AppUpdaterError::DownloadIncomplete);
    }
    if !session.control.complete.load(Ordering::SeqCst) {
        return Err(AppUpdaterError::DownloadIncomplete);
    }
    let pubkey = read_updater_pubkey(&app)?;
    let bytes = tokio::fs::read(&session.temp_path)
        .await
        .map_err(io_error)?;
    let install_result =
        verify_then_install(&bytes, &session.payload.signature, &pubkey, |verified| {
            // Only ever reached with bytes `verify_then_install` just verified. On Windows
            // this launches the installer and calls `std::process::exit(0)`; it does not
            // return in that case.
            session
                .payload
                .install(verified)
                .map_err(|error| AppUpdaterError::InstallFailed(error.to_string()))
        });
    if matches!(install_result, Err(AppUpdaterError::SignatureMismatch)) {
        // A spliced or tampered file must not sit on disk for a retry to fail against
        // identically forever -- see the module doc's trust-anchor section. Clearing the
        // session too means the only way forward is a fresh `update_download_start`;
        // there is nothing in this temp file worth keeping once it has failed this check.
        remove_download_artifacts(&session.temp_path).await;
        state.session.clear_if_current(&session).await;
        return install_result;
    }
    install_result?;
    remove_download_artifacts(&session.temp_path).await;
    state.session.clear_if_current(&session).await;
    Ok(())
}

/// Verifies `bytes` against `signature_b64`/`pubkey_b64` and only calls `installer` if
/// that verification passes. Split out of `update_install` so the ordering itself -- never
/// installing before a successful verification -- is provable with a `cargo test` closure
/// that records whether it ran, without weakening what `update_install` actually calls in
/// production: both go through this same function, not a parallel, looser test path.
fn verify_then_install<I>(
    bytes: &[u8],
    signature_b64: &str,
    pubkey_b64: &str,
    installer: I,
) -> Result<(), AppUpdaterError>
where
    I: FnOnce(&[u8]) -> Result<(), AppUpdaterError>,
{
    verify_signature(bytes, signature_b64, pubkey_b64)?;
    installer(bytes)
}

/// Streams `download_url` into `temp_path`, resuming from the file's current length, until
/// the body ends, `control.paused` is set, or `control.cancelled` is set. `on_progress` is
/// called with `(received, total)` at least once (before the first byte, so a caller sees
/// the resume offset immediately) and after every chunk; the two commands that call this
/// wrap `AppHandle::emit` in that closure so this function itself never needs a Tauri app
/// to run -- see the module doc's "why session bookkeeping is generic" section.
async fn run_download<F>(
    download_url: &Url,
    temp_path: &Path,
    control: &DownloadControl,
    mut on_progress: F,
) -> Result<DownloadOutcome, AppUpdaterError>
where
    F: FnMut(u64, Option<u64>),
{
    let _download_guard = control
        .download_lock
        .try_lock()
        .map_err(|_| AppUpdaterError::DownloadInProgress)?;

    refuse_if_symlink(temp_path).await?;
    let mut file = OpenOptions::new()
        .create(true)
        // Explicit and `false`: a resumed download depends on whatever bytes a previous
        // attempt already wrote surviving this `open` call. `resolve_range` below is what
        // decides, after the response headers are in, whether those bytes are still good
        // or must be discarded (`set_len(0)`) -- never this call.
        .truncate(false)
        .write(true)
        .read(true)
        .open(temp_path)
        .await
        .map_err(io_error)?;
    let mut offset = file.metadata().await.map_err(io_error)?.len();
    file.seek(SeekFrom::Start(offset)).await.map_err(io_error)?;

    let sidecar = validator_path(temp_path);
    // Only read back for an actual resume: a fresh download (`offset == 0`) has nothing on
    // disk yet to validate against, and a stale sidecar left by an unrelated earlier
    // attempt at this same path must not be sent as `If-Range` for a request that has
    // nothing to do with it.
    let mut validator = if offset > 0 {
        tokio::fs::read_to_string(&sidecar).await.ok()
    } else {
        None
    };

    // The crypto provider `rustls-no-provider` needs is installed as a side effect of the
    // `tauri_plugin_updater::Updater::check` call that produced the checked `Update` in the
    // first place (see the `reqwest` entry in Cargo.toml), which is why `ClientBuilder::build`
    // -- not the panicking `Client::new` -- is used here regardless.
    let client = reqwest::ClientBuilder::new()
        // A stalled connection must not outlive the operator's patience, and the reason is
        // not politeness: this task holds `download_lock` for as long as it sits inside the
        // body stream, and `update_download_cancel` only cleans up when it can take that
        // lock. Without a read timeout a half-open connection turns cancel into a command
        // that returns `Ok(())` and does nothing at all, for as long as the socket hangs.
        // The timeout is per idle read rather than per download, so a slow but progressing
        // transfer on a shoot LAN is never cut off mid-file.
        .read_timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            // The signature check in `update_install` is the real trust boundary (see the
            // module doc), but refusing to follow a redirect off `https` here means a
            // man-in-the-middle on a redirect hop never gets the chance to substitute
            // plaintext-served bytes before that check ever runs. `previous().len()`
            // mirrors `Policy::default()`'s own cap so a custom policy does not lose the
            // loop protection that comes for free otherwise.
            if attempt.previous().len() > 10 {
                attempt.error("too many redirects")
            } else if attempt.url().scheme() == "https" {
                attempt.follow()
            } else {
                attempt.error("update download redirected away from https")
            }
        }))
        .build()
        .map_err(|error| AppUpdaterError::DownloadFailed(error.to_string()))?;

    // At most one automatic retry, and only for a `416`: the offset this module computed
    // from the file already on disk is not satisfiable against the current response (the
    // remote file shrank, or was replaced by something shorter) -- discard the stale
    // prefix and ask for the whole thing exactly once more, rather than trusting a `206`
    // that will never arrive or looping forever against a server that keeps saying the
    // same thing about a full-file request too.
    let response = loop {
        let mut request = client.get(download_url.clone());
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            if let Some(validator) = &validator {
                request = request.header(reqwest::header::IF_RANGE, validator.clone());
            }
        }
        let response = request
            .send()
            .await
            .map_err(|error| AppUpdaterError::DownloadFailed(error.to_string()))?;
        if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 {
            offset = 0;
            validator = None;
            file.set_len(0).await.map_err(io_error)?;
            file.seek(SeekFrom::Start(0)).await.map_err(io_error)?;
            let _ = tokio::fs::remove_file(&sidecar).await;
            continue;
        }
        break response;
    };
    if !response.status().is_success() {
        return Err(AppUpdaterError::DownloadFailed(format!(
            "update server responded with status {}",
            response.status()
        )));
    }
    let honored = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let content_range_start = parse_content_range_start(response.headers());
    let (restart, total) = resolve_range(
        offset,
        honored,
        content_range_start,
        response.content_length(),
    );
    if restart {
        offset = 0;
        file.set_len(0).await.map_err(io_error)?;
        file.seek(SeekFrom::Start(0)).await.map_err(io_error)?;
    }
    if offset == 0 {
        // This response now describes the package from byte zero (either a genuinely
        // fresh download, or a restart above), so whatever validator it carries replaces
        // whatever was on disk before -- a stale sidecar from a superseded attempt must
        // never be sent as `If-Range` on a later resume of *this* response.
        match extract_validator(response.headers()) {
            Some(validator) => {
                let _ = tokio::fs::write(&sidecar, validator).await;
            }
            None => {
                let _ = tokio::fs::remove_file(&sidecar).await;
            }
        }
    }

    let mut received = offset;
    on_progress(received, total);

    let mut stream = response.bytes_stream();
    loop {
        if control.cancelled.load(Ordering::SeqCst) {
            drop(file);
            remove_download_artifacts(temp_path).await;
            return Ok(DownloadOutcome::Cancelled);
        }
        if control.paused.load(Ordering::SeqCst) {
            file.flush().await.map_err(io_error)?;
            return Ok(DownloadOutcome::Paused);
        }
        match stream.next().await {
            Some(Ok(chunk)) => {
                file.write_all(&chunk).await.map_err(io_error)?;
                received += chunk.len() as u64;
                on_progress(received, total);
            }
            Some(Err(error)) => return Err(AppUpdaterError::DownloadFailed(error.to_string())),
            None => {
                file.flush().await.map_err(io_error)?;
                if total.is_some_and(|total| total != received) {
                    return Err(AppUpdaterError::DownloadFailed(
                        "the update package ended before reaching its expected size".to_owned(),
                    ));
                }
                control.complete.store(true, Ordering::SeqCst);
                return Ok(DownloadOutcome::Complete);
            }
        }
    }
}

/// Whether the bytes already on disk (`offset` of them) are still a valid prefix of what
/// this response describes, and what the package's total size resolves to.
///
/// `offset == 0` always passes: there is nothing on disk yet to invalidate. Past that, the
/// response must both be a `206` *and* claim, via `Content-Range`, to start exactly at
/// `offset` -- a `200` (the server ignored `Range` entirely), a `206` with no parseable
/// `Content-Range`, and a `206` whose `Content-Range` starts somewhere else are all treated
/// identically: the bytes on disk are not provably a prefix of this body, so `restart`
/// discards them rather than splicing blind.
fn resolve_range(
    offset: u64,
    honored: bool,
    content_range_start: Option<u64>,
    content_length: Option<u64>,
) -> (bool, Option<u64>) {
    if offset == 0 || (honored && content_range_start == Some(offset)) {
        (false, content_length.map(|length| offset + length))
    } else {
        (true, content_length)
    }
}

/// The starting byte a `Content-Range: bytes <start>-<end>/<total>` response header
/// claims. `None` for a missing or malformed header -- `resolve_range` treats that the
/// same as an explicit mismatch, never as a pass.
fn parse_content_range_start(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let value = headers.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    let range = value.strip_prefix("bytes ")?;
    let start = range.split(['-', '/']).next()?;
    start.parse().ok()
}

/// `ETag` is preferred because it is meant to change whenever a resource's bytes do;
/// `Last-Modified` is the fallback most static hosts (including GitHub Releases) still
/// send when no `ETag` is present. Neither is cryptographic -- `verify_signature` is what
/// actually matters -- this is only what lets a resume detect "the file moved on" via
/// `If-Range` *before* spending a whole redownload finding out from a failed signature
/// check instead.
fn extract_validator(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(reqwest::header::ETAG)
        .or_else(|| headers.get(reqwest::header::LAST_MODIFIED))
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

/// Path of the small sidecar file that remembers which server-side representation the
/// bytes already on disk came from, so a resume can send `If-Range` and a restart can
/// discard both files together (`remove_download_artifacts`). Suffixing the temp path
/// rather than replacing its extension keeps the two trivially paired by name.
fn validator_path(temp_path: &Path) -> PathBuf {
    let mut name = temp_path.as_os_str().to_owned();
    name.push(".validator");
    PathBuf::from(name)
}

/// Deletes the temp file and its validator sidecar, best-effort -- a `remove_file` on a
/// path that is not there is not an error worth surfacing. Used everywhere a cancelled or
/// failed-verification download must not leave bytes behind for a later attempt, or a
/// later resume, to trip over.
async fn remove_download_artifacts(temp_path: &Path) {
    let _ = tokio::fs::remove_file(temp_path).await;
    let _ = tokio::fs::remove_file(validator_path(temp_path)).await;
}

/// Refuses to open `path` if a symlink already sits there rather than a regular file (or
/// nothing). The temp file's name is deterministic (`temp_download_path`) under a shared,
/// world-writable `env::temp_dir()` on the platforms where that is true; a local attacker
/// who can predict the sanitized version string could pre-plant a symlink there so that
/// this module's own `OpenOptions::open` -- which follows symlinks like any other `open`
/// -- writes, and on a restart `set_len(0)`-truncates, through it into a file this process
/// never chose. `SessionSlot::begin_fresh` already unlinks whatever sits at the path
/// before a *fresh* session starts (`remove_file` does not follow a symlink, so that call
/// clears an attacker's symlink rather than writing through it), but `update_download_
/// resume` must keep the file's existing bytes and cannot unlink first, so both paths
/// route through this same check immediately before the same `open` call below.
///
/// This narrows the window; it does not close it. Nothing stops a symlink from being
/// swapped in between this check and the `open` a few lines later -- that is a genuine
/// TOCTOU gap, and `openat2` with `RESOLVE_NO_SYMLINKS` (Linux-only, with no safe wrapper
/// in this crate's current dependency set) would be needed to close it outright. The
/// primary release target is Windows, where the temp directory is per-user rather than
/// shared, and this class of attack does not apply the same way.
async fn refuse_if_symlink(path: &Path) -> Result<(), AppUpdaterError> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(AppUpdaterError::SymlinkedTempFile)
        }
        _ => Ok(()),
    }
}

/// Reads `plugins.updater.pubkey` straight out of the parsed `tauri.conf.json` rather than
/// duplicating it as a constant here: the two would otherwise have to be kept in step by
/// hand, the way `Cargo.toml`'s and `tauri.conf.json`'s version fields already must be.
fn read_updater_pubkey(app: &AppHandle) -> Result<String, AppUpdaterError> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or(AppUpdaterError::MissingPubkey)
}

/// Mirrors `tauri_plugin_updater::updater::verify_signature`, which is private to that
/// crate: both the public key and the signature are base64-encoded minisign text, decoded
/// to that text and then to a `PublicKey`/`Signature` before checking `bin` against them.
fn verify_signature(
    bin: &[u8],
    signature_b64: &str,
    pubkey_b64: &str,
) -> Result<(), AppUpdaterError> {
    let pubkey_text = decode_base64_text(pubkey_b64)?;
    let public_key =
        PublicKey::decode(&pubkey_text).map_err(|_| AppUpdaterError::SignatureMismatch)?;
    let signature_text = decode_base64_text(signature_b64)?;
    let signature =
        Signature::decode(&signature_text).map_err(|_| AppUpdaterError::SignatureMismatch)?;
    public_key
        .verify(bin, &signature, true)
        .map_err(|_| AppUpdaterError::SignatureMismatch)
}

fn decode_base64_text(value: &str) -> Result<String, AppUpdaterError> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| AppUpdaterError::SignatureMismatch)?;
    String::from_utf8(decoded).map_err(|_| AppUpdaterError::SignatureMismatch)
}

fn io_error(error: std::io::Error) -> AppUpdaterError {
    AppUpdaterError::DownloadFailed(error.to_string())
}

/// A version string that came from the remote update endpoint, so it is treated as
/// untrusted input for the one thing this module does with it: naming a file. Anything
/// outside a small safe set collapses to `_` rather than being rejected outright, because
/// refusing an update over an odd but harmless version string (`1.2.3+build.7`) would be a
/// worse failure mode than a slightly mangled temp file name.
fn sanitize_version(version: &str) -> String {
    let sanitized: String = version
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if sanitized.is_empty() {
        "unknown".to_owned()
    } else {
        sanitized
    }
}

fn temp_download_path(version: &str) -> PathBuf {
    env::temp_dir().join(format!(
        "gremuchaya-hq-update-{}.part",
        sanitize_version(version)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        io::{Read, Write},
        net::{Shutdown, SocketAddr, TcpListener, TcpStream},
        sync::{Mutex as StdMutex, Once},
        time::Duration,
    };
    use tokio::time::timeout;

    #[test]
    fn range_honored_keeps_the_offset_and_adds_the_remaining_length() {
        let (restart, total) = resolve_range(500, true, Some(500), Some(500));
        assert!(!restart);
        assert_eq!(total, Some(1000));
    }

    #[test]
    fn a_fresh_download_never_restarts_regardless_of_the_range_header() {
        let (restart, total) = resolve_range(0, false, None, Some(1000));
        assert!(!restart);
        assert_eq!(total, Some(1000));
    }

    #[test]
    fn an_ignored_range_header_forces_a_restart_from_zero() {
        let (restart, total) = resolve_range(500, false, None, Some(1000));
        assert!(
            restart,
            "a 200 instead of 206 must not be trusted as a continuation"
        );
        assert_eq!(
            total,
            Some(1000),
            "the ignored-range response is the whole package"
        );
    }

    #[test]
    fn a_content_range_start_that_does_not_match_the_offset_forces_a_restart() {
        let (restart, total) = resolve_range(500, true, Some(300), Some(1000));
        assert!(
            restart,
            "a 206 that does not start where it was asked to must not be trusted"
        );
        assert_eq!(total, Some(1000));
    }

    #[test]
    fn a_206_with_no_parseable_content_range_forces_a_restart() {
        let (restart, _total) = resolve_range(500, true, None, Some(1000));
        assert!(
            restart,
            "a missing Content-Range on a 206 must be treated as a mismatch, not a pass"
        );
    }

    #[test]
    fn a_missing_content_length_is_an_indeterminate_total_not_a_zero_one() {
        let (restart, total) = resolve_range(500, true, Some(500), None);
        assert!(!restart);
        assert_eq!(total, None);
    }

    #[test]
    fn parses_the_start_offset_out_of_a_content_range_header() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_RANGE,
            "bytes 500-999/1000".parse().unwrap(),
        );
        assert_eq!(parse_content_range_start(&headers), Some(500));
    }

    #[test]
    fn a_missing_content_range_header_parses_to_none() {
        let headers = reqwest::header::HeaderMap::new();
        assert_eq!(parse_content_range_start(&headers), None);
    }

    #[test]
    fn a_malformed_content_range_header_parses_to_none_rather_than_a_wrong_number() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_RANGE,
            "not-a-content-range".parse().unwrap(),
        );
        assert_eq!(parse_content_range_start(&headers), None);
    }

    #[test]
    fn extract_validator_prefers_etag_over_last_modified() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::ETAG, "\"abc\"".parse().unwrap());
        headers.insert(
            reqwest::header::LAST_MODIFIED,
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(extract_validator(&headers).as_deref(), Some("\"abc\""));
    }

    #[test]
    fn extract_validator_falls_back_to_last_modified_without_an_etag() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::LAST_MODIFIED,
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(
            extract_validator(&headers).as_deref(),
            Some("Wed, 21 Oct 2015 07:28:00 GMT")
        );
    }

    #[test]
    fn extract_validator_is_none_with_neither_header() {
        let headers = reqwest::header::HeaderMap::new();
        assert_eq!(extract_validator(&headers), None);
    }

    #[test]
    fn sanitizes_a_version_string_before_it_becomes_a_file_name() {
        assert_eq!(sanitize_version("1.2.3"), "1.2.3");
        assert_eq!(sanitize_version("1.2.3+build.7"), "1.2.3_build.7");
        assert_eq!(sanitize_version("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(sanitize_version(""), "unknown");
    }

    #[test]
    fn temp_paths_for_different_versions_never_collide() {
        assert_ne!(temp_download_path("1.0.0"), temp_download_path("1.0.1"));
    }

    #[test]
    fn validator_path_stays_paired_with_and_distinct_from_the_temp_path() {
        let temp_path = temp_download_path("1.0.0");
        let sidecar = validator_path(&temp_path);
        assert_ne!(sidecar, temp_path);
        assert!(sidecar.starts_with(temp_path.parent().unwrap()));
    }

    #[tokio::test]
    async fn download_control_starts_with_every_flag_clear() {
        let control = DownloadControl::default();
        assert!(!control.paused.load(Ordering::SeqCst));
        assert!(!control.cancelled.load(Ordering::SeqCst));
        assert!(!control.complete.load(Ordering::SeqCst));
        assert!(control.download_lock.try_lock().is_ok());
    }

    #[tokio::test]
    async fn pause_and_cancel_are_independent_flags_a_second_command_can_set() {
        let control = DownloadControl::default();
        control.paused.store(true, Ordering::SeqCst);
        assert!(control.paused.load(Ordering::SeqCst));
        assert!(!control.cancelled.load(Ordering::SeqCst));

        control.cancelled.store(true, Ordering::SeqCst);
        assert!(control.cancelled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn the_download_lock_refuses_a_second_holder_while_the_first_is_held() {
        let control = DownloadControl::default();
        let guard = control.download_lock.lock().await;
        assert!(control.download_lock.try_lock().is_err());
        drop(guard);
        assert!(control.download_lock.try_lock().is_ok());
    }

    fn fixture_path(name: &str) -> PathBuf {
        env::temp_dir().join(format!("app-updater-test-{name}.part"))
    }

    #[tokio::test]
    async fn begin_fresh_refuses_to_replace_a_session_whose_lock_is_still_held() {
        let slot: SessionSlot<&'static str> = SessionSlot::new();
        let first = slot
            .begin_fresh("payload-a", fixture_path("a"))
            .await
            .expect("first session must start");
        let held = first.control.download_lock.lock().await;

        let result = slot.begin_fresh("payload-b", fixture_path("b")).await;
        assert!(
            matches!(result, Err(AppUpdaterError::DownloadInProgress)),
            "a session actively writing must not be silently replaced"
        );

        drop(held);
        slot.begin_fresh("payload-c", fixture_path("c"))
            .await
            .expect("a session whose lock was released must be replaceable");
    }

    #[tokio::test]
    async fn clear_if_current_leaves_a_superseded_session_untouched() {
        let slot: SessionSlot<&'static str> = SessionSlot::new();
        let stale = slot
            .begin_fresh("stale", fixture_path("stale"))
            .await
            .expect("session must start");
        let fresh = slot
            .begin_fresh("fresh", fixture_path("fresh"))
            .await
            .expect("a released session must be replaceable");

        slot.clear_if_current(&stale).await;
        let current = timeout(Duration::from_millis(50), slot.current())
            .await
            .expect("current() must not hang");
        match current {
            Ok(session) => assert_eq!(session.payload, "fresh"),
            Err(_) => panic!("clearing a superseded session must not clear the current one"),
        }

        slot.clear_if_current(&fresh).await;
        let cleared = timeout(Duration::from_millis(50), slot.current())
            .await
            .expect("current() must not hang");
        assert!(matches!(cleared, Err(AppUpdaterError::NoDownloadSession)));
    }

    // -- Signature verification: a real minisign keypair, not an assumption ---------------
    //
    // Both the public key and the signature below are exactly the ones from
    // `minisign-verify`'s own published doctest (crate 0.2.5, `src/lib.rs`), re-encoded
    // into the base64-wrapped-text form `verify_signature` actually receives (matching
    // `tauri.conf.json`'s `pubkey` field and `Update::signature`, both base64 of minisign's
    // own two/four-line text format). The pair, and `b"test"` as the signed payload, were
    // round-tripped through this exact `verify_signature` function -- via the standalone
    // check in this task's working notes -- before being pasted in, rather than assumed
    // correct from reading the crate's doc comment.

    const FIXTURE_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgZm9yIGdyZW11Y2hheWEtaHEgdGVzdCBmaXh0dXJlClJXUWY2TFJDR0E5aTUzbWxZZWNPNEl6VDUxVEdQcHZXdWNOU0NoMUNCTTBRVGFMbjczWTdHRk8zCg==";
    const FIXTURE_SIGNATURE_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIG1pbmlzaWduIHNlY3JldCBrZXkKUlVRZjZMUkNHQTlpNTU5cjNnN1YxcU55SkRBcEdpcDhNZnFjYWRJZ1Q5Q3VoVjNFTWhIb04xbUdUa1VpZEYvejdTcmxRZ1hkeThvZmpiN2JOSkp5bERPb2NyQ284S0x6WndvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNjMzNzAwODM1CWZpbGU6dGVzdAlwcmVoYXNoZWQKd0xNRGp5OUZMQXV4WjNxNE5sRXZrZ3R5aHJyMGd0VHU2S0M0S0JKZElUYmJPZUFpMXpCSVlvMHY0aVRndDhqSnBJaWRSSm5wOTRBQlFrSkFnQW9vQlE9PQo=";
    const FIXTURE_PAYLOAD: &[u8] = b"test";

    /// The literal value of `plugins.updater.pubkey` in `tauri.conf.json` -- copied, not
    /// derived, so this test fails loudly if the two ever drift apart.
    const PLACEHOLDER_PUBKEY: &str =
        "PLACEHOLDER-NOT-A-REAL-MINISIGN-KEY-SEE-apps/hq/src-tauri/src/app_updater.rs";

    #[test]
    fn verify_signature_accepts_a_genuine_minisign_signature() {
        verify_signature(FIXTURE_PAYLOAD, FIXTURE_SIGNATURE_B64, FIXTURE_PUBKEY_B64)
            .expect("a valid signature over the exact payload it was made for must verify");
    }

    #[test]
    fn verify_signature_rejects_a_single_flipped_payload_byte() {
        let mut tampered = FIXTURE_PAYLOAD.to_vec();
        tampered[0] ^= 0x01;
        let result = verify_signature(&tampered, FIXTURE_SIGNATURE_B64, FIXTURE_PUBKEY_B64);
        assert!(
            matches!(result, Err(AppUpdaterError::SignatureMismatch)),
            "one flipped byte must fail verification, not pass it"
        );
    }

    #[test]
    fn verify_signature_fails_closed_on_the_literal_placeholder_pubkey() {
        // `PLACEHOLDER_PUBKEY` contains `-`, outside the standard base64 alphabet, so this
        // fails at the outer `decode_base64_text` and never reaches `PublicKey::decode` --
        // still `SignatureMismatch`, never a panic, which is the module doc's claim.
        let result = verify_signature(FIXTURE_PAYLOAD, FIXTURE_SIGNATURE_B64, PLACEHOLDER_PUBKEY);
        assert!(matches!(result, Err(AppUpdaterError::SignatureMismatch)));
    }

    #[test]
    fn verify_then_install_calls_the_installer_only_after_a_successful_verification() {
        let mut installed_with: Option<Vec<u8>> = None;
        verify_then_install(
            FIXTURE_PAYLOAD,
            FIXTURE_SIGNATURE_B64,
            FIXTURE_PUBKEY_B64,
            |verified| {
                installed_with = Some(verified.to_vec());
                Ok(())
            },
        )
        .expect("a valid signature must let the installer run");
        assert_eq!(installed_with.as_deref(), Some(FIXTURE_PAYLOAD));
    }

    #[test]
    fn verify_then_install_never_calls_the_installer_when_verification_fails() {
        let mut installer_called = false;
        let mut tampered = FIXTURE_PAYLOAD.to_vec();
        tampered[0] ^= 0x01;
        let result = verify_then_install(
            &tampered,
            FIXTURE_SIGNATURE_B64,
            FIXTURE_PUBKEY_B64,
            |_verified| {
                installer_called = true;
                Ok(())
            },
        );
        assert!(matches!(result, Err(AppUpdaterError::SignatureMismatch)));
        assert!(
            !installer_called,
            "the installer must never run against bytes that failed verification"
        );
    }

    // -- run_download: a real local HTTP server, not a mocked stream ----------------------

    /// `reqwest`'s `rustls-no-provider` feature (see `Cargo.toml`) means `ClientBuilder::
    /// build` panics unless a `rustls` crypto provider was installed first -- normally a
    /// side effect of `tauri_plugin_updater::Updater::check`, which nothing here calls.
    /// Installed once, process-wide; every test below that builds a client goes through
    /// `TestServer::start`, so none of them has to remember to call this itself.
    fn ensure_crypto_provider() {
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
    }

    async fn cleanup(temp_path: &Path) {
        let _ = tokio::fs::remove_file(temp_path).await;
        let _ = tokio::fs::remove_file(validator_path(temp_path)).await;
    }

    /// A raw HTTP/1.1 response: status line, caller-supplied headers (including
    /// `content-length`, deliberately not computed here so a test can declare one that
    /// disagrees with the actual body it sends), a blank line, then the body.
    fn http_response(status_line: &str, headers: &[(&str, String)], body: &[u8]) -> Vec<u8> {
        let mut response = format!("HTTP/1.1 {status_line}\r\n").into_bytes();
        for (name, value) in headers {
            response.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
        response.extend_from_slice(b"\r\n");
        response.extend_from_slice(body);
        response
    }

    /// The first attempt of every multi-request test below: a `200` sent in two writes
    /// with a delay between them, long enough that the test driving it can set `paused`
    /// (or `cancelled`) before the second half ever reaches the socket -- see
    /// `run_paused_download`.
    fn initial_paused_response(fill: u8, total: usize, etag: Option<&str>) -> TestResponse {
        let half = total / 2;
        let first_part = vec![fill; half];
        let second_part = vec![fill; total - half];
        let mut headers = vec![("content-length", total.to_string())];
        if let Some(etag) = etag {
            headers.push(("etag", etag.to_owned()));
        }
        TestResponse::Delayed {
            first: http_response("200 OK", &headers, &first_part),
            delay: Duration::from_millis(150),
            second: second_part,
        }
    }

    enum TestResponse {
        Immediate(Vec<u8>),
        /// Writes `first` (a full response: status line, headers, and the first slice of
        /// the body), sleeps `delay`, then writes `second` (more raw body bytes, no
        /// headers of its own).
        Delayed {
            first: Vec<u8>,
            delay: Duration,
            second: Vec<u8>,
        },
    }

    struct TestRequest {
        headers: HashMap<String, String>,
    }

    impl TestRequest {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .get(&name.to_ascii_lowercase())
                .map(String::as_str)
        }
    }

    type RequestLog = Arc<StdMutex<Vec<HashMap<String, String>>>>;

    /// Records `request`'s headers and returns this connection's zero-based index among
    /// every request the server has received so far -- the dispatch key every multi-
    /// request test below matches on, since "does this request have a Range header"
    /// alone cannot tell a 416-retry's Range-less request apart from the very first,
    /// also Range-less, request that starts the whole scenario.
    fn record(log: &RequestLog, request: &TestRequest) -> usize {
        let mut log = log.lock().expect("test request log must not be poisoned");
        log.push(request.headers.clone());
        log.len() - 1
    }

    /// A background-thread HTTP/1.1 server bound to an ephemeral loopback port, alive for
    /// as long as the returned value is. Handles one connection (one request, one
    /// response) at a time, in the order they arrive, matching the sequential requests
    /// `run_download` itself makes.
    struct TestServer {
        addr: SocketAddr,
        shutdown: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn start<H>(handler: H) -> Self
        where
            H: Fn(TestRequest) -> TestResponse + Send + Sync + 'static,
        {
            ensure_crypto_provider();
            let listener =
                TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral loopback test port");
            listener
                .set_nonblocking(true)
                .expect("make the listener non-blocking so shutdown can be polled");
            let addr = listener.local_addr().expect("read back the bound port");
            let shutdown = Arc::new(AtomicBool::new(false));
            let shutdown_thread = Arc::clone(&shutdown);
            let handle = std::thread::spawn(move || {
                while !shutdown_thread.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let _ = stream.set_nodelay(true);
                            handle_connection(stream, &handler);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                addr,
                shutdown,
                handle: Some(handle),
            }
        }

        fn url(&self, path: &str) -> Url {
            format!("http://{}{path}", self.addr)
                .parse()
                .expect("assemble a valid test URL from the bound loopback address")
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.shutdown.store(true, Ordering::SeqCst);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn handle_connection<H>(mut stream: TcpStream, handler: &H)
    where
        H: Fn(TestRequest) -> TestResponse,
    {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let Ok(read) = stream.read(&mut chunk) else {
                return;
            };
            if read == 0 {
                return; // the client closed before finishing its request headers
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buffer);
        let mut headers = HashMap::new();
        for line in text.lines().skip(1) {
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
            }
        }
        match handler(TestRequest { headers }) {
            TestResponse::Immediate(bytes) => {
                let _ = stream.write_all(&bytes);
            }
            TestResponse::Delayed {
                first,
                delay,
                second,
            } => {
                if stream.write_all(&first).is_err() {
                    return;
                }
                let _ = stream.flush();
                std::thread::sleep(delay);
                let _ = stream.write_all(&second);
            }
        }
        let _ = stream.shutdown(Shutdown::Write);
    }

    /// Runs `run_download` once against a server using `initial_paused_response`, and
    /// stops it as soon as `on_progress` reports the first real bytes written. That
    /// callback runs synchronously on `run_download`'s own task, immediately after the
    /// write it reports on and with no `.await` in between it and the loop's next
    /// `paused` check -- deterministic, unlike racing a wall-clock sleep against the
    /// server's own delay in a separately spawned task, which is indeed what an earlier
    /// version of this helper did and why it is not that anymore: the response's headers
    /// and its first slice of body routinely arrive, and get consumed, in the same
    /// scheduler turn on a loopback connection, leaving a spawned sleep task no
    /// guaranteed chance to run before the whole first half was already written. Asserts
    /// the call paused holding a genuinely partial, non-empty offset (necessarily less
    /// than the response's full declared length, since the server withholds its second
    /// half behind its own delay independently of any of this), clears `paused` again,
    /// and returns that offset for the caller's own resumed `run_download` call.
    async fn run_paused_download(url: &Url, temp_path: &Path, control: &DownloadControl) -> u64 {
        let outcome = run_download(url, temp_path, control, |received, _total| {
            if received > 0 {
                control.paused.store(true, Ordering::SeqCst);
            }
        })
        .await
        .expect("the initial (paused) attempt must not error");
        assert_eq!(
            outcome,
            DownloadOutcome::Paused,
            "the initial attempt must pause partway, not finish outright"
        );
        assert!(!control.complete.load(Ordering::SeqCst));
        let offset = tokio::fs::metadata(temp_path)
            .await
            .expect("a paused download must leave a partial file behind")
            .len();
        assert!(
            offset > 0,
            "pause must hold at least one byte already received, got 0"
        );
        control.paused.store(false, Ordering::SeqCst);
        offset
    }

    #[tokio::test]
    async fn run_download_writes_the_full_body_and_marks_complete() {
        let body = b"the quick brown fox jumps over the lazy dog".to_vec();
        let body_for_server = body.clone();
        let server = TestServer::start(move |_request| {
            TestResponse::Immediate(http_response(
                "200 OK",
                &[("content-length", body_for_server.len().to_string())],
                &body_for_server,
            ))
        });
        let temp_path = fixture_path("full-download");
        cleanup(&temp_path).await;
        let control = DownloadControl::default();

        let outcome = run_download(&server.url("/pkg"), &temp_path, &control, |_, _| {})
            .await
            .expect("a plain 200 download must succeed");

        assert_eq!(outcome, DownloadOutcome::Complete);
        assert!(control.complete.load(Ordering::SeqCst));
        let written = tokio::fs::read(&temp_path)
            .await
            .expect("temp file must exist");
        assert_eq!(written, body);
        cleanup(&temp_path).await;
    }

    #[tokio::test]
    async fn run_download_cancel_deletes_the_temp_file() {
        let server = TestServer::start(|_request| {
            TestResponse::Immediate(http_response(
                "200 OK",
                &[("content-length", "4".to_owned())],
                b"body",
            ))
        });
        let temp_path = fixture_path("cancel-deletes-file");
        cleanup(&temp_path).await;
        let control = DownloadControl::default();
        // Set before `run_download` is even called: `cancelled` is checked at the very
        // top of the streaming loop, before the first chunk is ever read, so this proves
        // cancellation takes effect even against a response that would otherwise arrive
        // and complete before any later check could catch it.
        control.cancelled.store(true, Ordering::SeqCst);

        let outcome = run_download(&server.url("/pkg"), &temp_path, &control, |_, _| {})
            .await
            .expect("a cancel must resolve cleanly, not as an error");

        assert_eq!(outcome, DownloadOutcome::Cancelled);
        assert!(
            tokio::fs::metadata(&temp_path).await.is_err(),
            "a cancelled download must not leave its temp file behind"
        );
        assert!(
            tokio::fs::metadata(validator_path(&temp_path))
                .await
                .is_err(),
            "a cancelled download must not leave its validator sidecar behind either"
        );
    }

    #[tokio::test]
    async fn run_download_does_not_mark_complete_on_a_truncated_body() {
        // Declares more bytes than it ever sends, then closes: hyper surfaces this as a
        // body-decoding error on the stream rather than a clean end, so this exercises the
        // `Some(Err(_))` arm -- proving `control.complete` is never set on a response body
        // that never actually finished, which is the property this test is for, however
        // the underlying transport happens to report it.
        let server = TestServer::start(|_request| {
            TestResponse::Immediate(http_response(
                "200 OK",
                &[("content-length", "100".to_owned())],
                b"short",
            ))
        });
        let temp_path = fixture_path("truncated-body");
        cleanup(&temp_path).await;
        let control = DownloadControl::default();

        let result = run_download(&server.url("/pkg"), &temp_path, &control, |_, _| {}).await;

        assert!(
            result.is_err(),
            "a body shorter than declared must not resolve as success"
        );
        assert!(!control.complete.load(Ordering::SeqCst));
        cleanup(&temp_path).await;
    }

    #[tokio::test]
    async fn run_download_resumes_a_paused_transfer_with_a_valid_206() {
        let total = 10_000usize;
        let etag = "\"fixture-etag\"";
        let log: RequestLog = Arc::new(StdMutex::new(Vec::new()));
        let log_for_server = Arc::clone(&log);
        let server = TestServer::start(move |request| {
            let attempt = record(&log_for_server, &request);
            match attempt {
                0 => initial_paused_response(b'A', total, Some(etag)),
                1 => {
                    let offset: usize = request
                        .header("range")
                        .and_then(|value| value.strip_prefix("bytes="))
                        .and_then(|value| value.strip_suffix('-'))
                        .and_then(|value| value.parse().ok())
                        .expect("resume must send a well-formed Range header");
                    let remaining = vec![b'A'; total - offset];
                    TestResponse::Immediate(http_response(
                        "206 Partial Content",
                        &[
                            ("content-length", remaining.len().to_string()),
                            (
                                "content-range",
                                format!("bytes {offset}-{}/{total}", total - 1),
                            ),
                            ("etag", etag.to_owned()),
                        ],
                        &remaining,
                    ))
                }
                _ => unreachable!("only two requests are expected in this scenario"),
            }
        });

        let temp_path = fixture_path("resume-206");
        cleanup(&temp_path).await;
        let control = Arc::new(DownloadControl::default());
        let url = server.url("/pkg");

        let offset = run_paused_download(&url, &temp_path, &control).await;

        let outcome = run_download(&url, &temp_path, &control, |_, _| {})
            .await
            .expect("resuming over a valid 206 must succeed");
        assert_eq!(outcome, DownloadOutcome::Complete);
        assert!(control.complete.load(Ordering::SeqCst));

        let written = tokio::fs::read(&temp_path)
            .await
            .expect("temp file must exist");
        assert_eq!(written, vec![b'A'; total]);

        {
            // Scoped so the `std::sync::MutexGuard` is dropped before the `.await` below --
            // clippy's `await_holding_lock` does not credit a manual `drop()` call the way
            // it credits the guard's binding actually going out of scope.
            let requests = log.lock().unwrap();
            assert_eq!(
                requests.get(1).and_then(|headers| headers.get("range")),
                Some(&format!("bytes={offset}-"))
            );
            assert_eq!(
                requests.get(1).and_then(|headers| headers.get("if-range")),
                Some(&etag.to_owned()),
                "resume must send the ETag captured on the first response as If-Range"
            );
        }
        cleanup(&temp_path).await;
    }

    #[tokio::test]
    async fn run_download_restarts_from_zero_when_the_server_ignores_range() {
        let stale_total = 10_000usize;
        let fresh_full = vec![b'C'; 7_000];
        let fresh_for_server = fresh_full.clone();
        let log: RequestLog = Arc::new(StdMutex::new(Vec::new()));
        let log_for_server = Arc::clone(&log);
        let server = TestServer::start(move |request| {
            let attempt = record(&log_for_server, &request);
            match attempt {
                0 => initial_paused_response(b'A', stale_total, None),
                1 => TestResponse::Immediate(http_response(
                    "200 OK",
                    &[("content-length", fresh_for_server.len().to_string())],
                    &fresh_for_server,
                )),
                _ => unreachable!("only two requests are expected in this scenario"),
            }
        });

        let temp_path = fixture_path("restart-ignored-range");
        cleanup(&temp_path).await;
        let control = Arc::new(DownloadControl::default());
        let url = server.url("/pkg");
        run_paused_download(&url, &temp_path, &control).await;

        let outcome = run_download(&url, &temp_path, &control, |_, _| {})
            .await
            .expect("a 200 that ignores Range must still be accepted, just as a restart");
        assert_eq!(outcome, DownloadOutcome::Complete);

        let written = tokio::fs::read(&temp_path).await.unwrap();
        assert_eq!(
            written, fresh_full,
            "an ignored Range header must discard the stale prefix rather than splice onto it"
        );
        cleanup(&temp_path).await;
    }

    #[tokio::test]
    async fn run_download_restarts_from_zero_on_a_content_range_mismatch() {
        let stale_total = 10_000usize;
        let fresh_full = vec![b'D'; 6_000];
        let fresh_for_server = fresh_full.clone();
        let log: RequestLog = Arc::new(StdMutex::new(Vec::new()));
        let log_for_server = Arc::clone(&log);
        let server = TestServer::start(move |request| {
            let attempt = record(&log_for_server, &request);
            match attempt {
                0 => initial_paused_response(b'A', stale_total, None),
                1 => {
                    // Claims to start at 0 regardless of the offset that was actually
                    // requested -- the stale-or-malformed Content-Range a misbehaving
                    // proxy or cache could produce.
                    TestResponse::Immediate(http_response(
                        "206 Partial Content",
                        &[
                            ("content-length", fresh_for_server.len().to_string()),
                            (
                                "content-range",
                                format!(
                                    "bytes 0-{}/{}",
                                    fresh_for_server.len() - 1,
                                    fresh_for_server.len()
                                ),
                            ),
                        ],
                        &fresh_for_server,
                    ))
                }
                _ => unreachable!("only two requests are expected in this scenario"),
            }
        });

        let temp_path = fixture_path("restart-content-range-mismatch");
        cleanup(&temp_path).await;
        let control = Arc::new(DownloadControl::default());
        let url = server.url("/pkg");
        run_paused_download(&url, &temp_path, &control).await;

        let outcome = run_download(&url, &temp_path, &control, |_, _| {})
            .await
            .expect("a 206 with a mismatched Content-Range must still be accepted, as a restart");
        assert_eq!(outcome, DownloadOutcome::Complete);

        let written = tokio::fs::read(&temp_path).await.unwrap();
        assert_eq!(
            written, fresh_full,
            "a Content-Range start that does not match the requested offset must not be trusted as a continuation"
        );
        cleanup(&temp_path).await;
    }

    #[tokio::test]
    async fn run_download_restarts_from_zero_on_416() {
        let stale_total = 10_000usize;
        let fresh_full = vec![b'E'; 4_000];
        let fresh_for_server = fresh_full.clone();
        let log: RequestLog = Arc::new(StdMutex::new(Vec::new()));
        let log_for_server = Arc::clone(&log);
        let server = TestServer::start(move |request| {
            let attempt = record(&log_for_server, &request);
            match attempt {
                0 => initial_paused_response(b'A', stale_total, None),
                1 => TestResponse::Immediate(http_response(
                    "416 Range Not Satisfiable",
                    &[("content-length", "0".to_owned())],
                    &[],
                )),
                2 => TestResponse::Immediate(http_response(
                    "200 OK",
                    &[("content-length", fresh_for_server.len().to_string())],
                    &fresh_for_server,
                )),
                _ => unreachable!("only three requests are expected in this scenario"),
            }
        });

        let temp_path = fixture_path("restart-416");
        cleanup(&temp_path).await;
        let control = Arc::new(DownloadControl::default());
        let url = server.url("/pkg");
        run_paused_download(&url, &temp_path, &control).await;

        let outcome = run_download(&url, &temp_path, &control, |_, _| {})
            .await
            .expect(
                "a single 416 must be absorbed by one automatic restart, not surfaced as an error",
            );
        assert_eq!(outcome, DownloadOutcome::Complete);

        let written = tokio::fs::read(&temp_path).await.unwrap();
        assert_eq!(written, fresh_full);

        {
            // Scoped so the `std::sync::MutexGuard` is dropped before the `.await` below --
            // clippy's `await_holding_lock` does not credit a manual `drop()` call the way
            // it credits the guard's binding actually going out of scope.
            let requests = log.lock().unwrap();
            assert_eq!(
                requests.len(),
                3,
                "resume must retry exactly once after a 416"
            );
            assert!(
                requests[1].contains_key("range"),
                "the attempt that received 416 must have sent Range"
            );
            assert!(
                !requests[2].contains_key("range"),
                "the retry after 416 must drop Range and ask for the whole file"
            );
        }
        cleanup(&temp_path).await;
    }

    #[tokio::test]
    async fn run_download_refuses_a_second_concurrent_call_on_the_same_session() {
        // What `update_download_resume` racing an attempt already in flight looks like at
        // this layer: a second `run_download` call against a `DownloadControl` whose lock
        // the first call is still holding must refuse immediately, not queue behind it and
        // then run against a file the first call has since changed underneath it.
        let control = DownloadControl::default();
        let _guard = control.download_lock.lock().await;
        let temp_path = fixture_path("refuses-concurrent");
        let url: Url = "http://127.0.0.1:1/unused".parse().unwrap();

        let result = run_download(&url, &temp_path, &control, |_, _| {}).await;

        assert!(
            matches!(result, Err(AppUpdaterError::DownloadInProgress)),
            "a session whose lock is already held must refuse, not queue"
        );
    }

    // -- Cancel while paused: not exercised by `update_install`'s or `update_download_cancel`'s
    // own `#[tauri::command]` bodies, which need a live `WebviewWindow` (see
    // `refuse_unless_control_window`'s doc) that nothing else in this suite constructs either.
    // What *is* provable without one: the premise `update_download_cancel`'s synchronous
    // cleanup branch depends on -- that a genuinely paused `run_download` has actually
    // released `download_lock` by the time it returns, not merely that reading the source
    // suggests it should -- and that the same `remove_download_artifacts`/
    // `SessionSlot::clear_if_current` functions that command calls do delete both files and
    // clear the session when run against a session left in that exact state.

    #[tokio::test]
    async fn a_genuinely_paused_download_releases_its_lock_so_a_cancel_can_clean_up_synchronously()
    {
        let total = 10_000usize;
        let server = TestServer::start(move |_request| initial_paused_response(b'F', total, None));

        let temp_path = fixture_path("cancel-while-paused");
        cleanup(&temp_path).await;
        let slot: SessionSlot<&'static str> = SessionSlot::new();
        let session = slot
            .begin_fresh("update-payload", temp_path.clone())
            .await
            .expect("a session with no prior lock holder must start");

        let url = server.url("/pkg");
        run_paused_download(&url, &session.temp_path, &session.control).await;

        // The specific fact `update_download_cancel`'s `try_lock` branch stakes its
        // synchronous cleanup on: `run_download` returned as soon as it saw `paused` (see
        // its own body), dropping `_download_guard` on the way out -- proven here by
        // actually acquiring the lock again, not assumed from reading that code path.
        assert!(
            session.control.download_lock.try_lock().is_ok(),
            "a genuinely paused run_download must release download_lock on return, not hold it across the pause -- update_download_cancel's synchronous cleanup depends on this being true"
        );

        // Mirrors `update_download_cancel`'s own body from here: set `cancelled`, then run
        // its cleanup only if the lock is free -- against the same `Session`/`SessionSlot`
        // and the same `remove_download_artifacts` function that command calls, not a
        // reimplementation of what deleting a file means.
        session.control.cancelled.store(true, Ordering::SeqCst);
        if let Ok(_guard) = session.control.download_lock.try_lock() {
            remove_download_artifacts(&session.temp_path).await;
            slot.clear_if_current(&session).await;
        }

        assert!(
            tokio::fs::metadata(&temp_path).await.is_err(),
            "cancelling a paused download must delete its temp file"
        );
        assert!(
            tokio::fs::metadata(validator_path(&temp_path))
                .await
                .is_err(),
            "cancelling a paused download must delete its validator sidecar too"
        );
        let current = timeout(Duration::from_millis(50), slot.current())
            .await
            .expect("current() must not hang");
        assert!(
            matches!(current, Err(AppUpdaterError::NoDownloadSession)),
            "cancelling a paused download must clear the session, not just its files"
        );

        cleanup(&temp_path).await;
    }
}
