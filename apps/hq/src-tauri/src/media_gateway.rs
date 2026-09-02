use axum::{
    extract::{Path as RoutePath, State as RouteState},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env, fs, io, mem,
    net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant, SystemTime},
};
use tauri::State;
use thiserror::Error;
use tokio::{
    process::{Child, Command},
    sync::{Mutex, Notify},
    time::{sleep, timeout},
};
use tower_http::cors::{AllowOrigin, CorsLayer};
use url::Url;

const DEFAULT_MAX_WORKERS: usize = 4;
const MAX_CONFIGURED_STREAMS: usize = 64;
const MAX_CONFIG_BYTES: u64 = 1_048_576;
const MANIFEST_START_TIMEOUT: Duration = Duration::from_secs(10);
const PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const SUPERVISOR_INTERVAL: Duration = Duration::from_millis(500);
const RESTART_BACKOFF_BASE_MS: u64 = 500;
const RESTART_BACKOFF_MAX_MS: u64 = 30_000;
const RESTART_JITTER_MAX_MS: u64 = 250;
const RESTART_STABILITY_WINDOW: Duration = Duration::from_secs(30);
const DEGRADED_FAILURE_THRESHOLD: u32 = 5;
const HLS_SEGMENT_SECONDS: &str = "2";
const HLS_LIST_SIZE: &str = "6";
const HLS_DELETE_THRESHOLD: &str = "2";
/// How long one HLS access grant stays the one handed to new consumers
/// before the supervisor mints a fresh one for the same worker. Overridable
/// with `HQ_MEDIA_GATEWAY_GRANT_ROTATE_SECS` for a shorter interval in a
/// deployment that wants it; the floor below keeps a misconfigured value
/// from rotating faster than a manifest poll cycle can keep up with.
const DEFAULT_GRANT_ROTATE_INTERVAL: Duration = Duration::from_secs(900);
const MIN_GRANT_ROTATE_INTERVAL: Duration = Duration::from_secs(30);
/// How long a rotated-out grant keeps authorizing requests after rotation,
/// so a consumer's already-open HLS session does not fail the instant a
/// worker mints a new one.
const GRANT_GRACE_PERIOD: Duration = Duration::from_secs(120);

#[derive(Debug, Error)]
pub enum MediaGatewayError {
    #[error("media gateway configuration is invalid")]
    InvalidConfiguration,
    // The message names the field and the accepted values, and deliberately repeats
    // neither the value the operator typed nor anything else from the camera entry:
    // the neighbouring `rtspUrl` carries credentials, and this error is serialized to
    // the UI and printed at startup.
    #[error(
        "media gateway configuration field videoEncoder is not a supported encoder; \
         accepted values are libx264, h264_nvenc, h264_qsv and h264_amf"
    )]
    UnsupportedVideoEncoder,
    #[error("media gateway configuration file must be a regular non-symbolic file")]
    UnsafeConfigurationFile,
    #[error("camera or consumer identifier is invalid")]
    InvalidIdentifier,
    #[error("camera stream is not configured in the native gateway")]
    CameraNotConfigured,
    #[error("media gateway worker capacity has been reached")]
    CapacityReached,
    #[error("FFmpeg is unavailable or could not be started")]
    FfmpegUnavailable,
    #[error("FFmpeg exited before the HLS manifest became ready")]
    FfmpegExited,
    #[error("HLS manifest startup timed out")]
    StartupTimeout,
    #[error("media gateway server is already running or unavailable")]
    ServerUnavailable,
    #[error("media gateway is shutting down")]
    ShuttingDown,
    #[error("media gateway I/O operation failed")]
    Io(#[from] io::Error),
}

impl Serialize for MediaGatewayError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RtspTransport {
    #[default]
    Tcp,
    Udp,
}

impl RtspTransport {
    fn as_ffmpeg_value(self) -> &'static str {
        match self {
            Self::Tcp => "tcp",
            Self::Udp => "udp",
        }
    }
}

/// Video encoder the gateway may hand to FFmpeg for a transcoded camera.
///
/// The set is closed on purpose, and stays closed. Whatever this field selects is
/// spliced verbatim into the argument vector of an external process, so a free-form
/// string would turn a field that reads like a codec name into a way of adding
/// arguments to that process: `libx264 -f null -` arrives as two extra arguments,
/// and there is no shell to blame for it. A closed enum makes the argument vector a
/// function of literals compiled into this file — the configuration only chooses
/// between them, and adding an encoder is a code change that can be reviewed.
///
/// The members are the software encoder plus the three hardware families that exist
/// on the Windows shoot machines: NVIDIA NVENC, Intel Quick Sync and AMD AMF.
#[derive(Clone, Copy, Default)]
enum VideoEncoder {
    /// Software H.264. The default, and the only encoder present on every machine.
    #[default]
    Libx264,
    /// NVIDIA NVENC. Needs an FFmpeg built with `--enable-nvenc` and driver support.
    H264Nvenc,
    /// Intel Quick Sync Video.
    H264Qsv,
    /// AMD Advanced Media Framework.
    H264Amf,
}

impl VideoEncoder {
    fn from_configuration_value(value: &str) -> Result<Self, MediaGatewayError> {
        match value {
            "libx264" => Ok(Self::Libx264),
            "h264_nvenc" => Ok(Self::H264Nvenc),
            "h264_qsv" => Ok(Self::H264Qsv),
            "h264_amf" => Ok(Self::H264Amf),
            // A name that is not in the set is refused rather than replaced by the
            // default. An operator who writes `h264_nvnec` on a machine bought for
            // hardware encoding would otherwise get software encoding, a hot CPU and
            // no indication that the configuration was ever read as anything else.
            _ => Err(MediaGatewayError::UnsupportedVideoEncoder),
        }
    }

    /// The whole video branch of the FFmpeg invocation for this encoder.
    ///
    /// Each encoder carries its own list instead of sharing one list with the codec
    /// name substituted, because the quality and latency knobs are not shared
    /// vocabulary: `-preset veryfast -tune zerolatency` is libx264's, NVENC spells
    /// the same intent `-preset p4 -tune ll`, Quick Sync has no `-tune` at all and
    /// lowers latency by shortening its async queue, and AMF has neither and uses
    /// `-usage`/`-quality`. Where an option has no counterpart it is left out rather
    /// than approximated:
    ///
    /// * `-sc_threshold 0` is libx264's scene-cut suppression. NVENC's nearest
    ///   equivalent, `-no-scenecut`, only applies when lookahead is on, which
    ///   `-tune ll` turns off; Quick Sync and AMF have none. Only libx264 gets it.
    /// * `-pix_fmt yuv420p` is repeated per encoder rather than shared because
    ///   `h264_qsv` does not accept it — Quick Sync encodes `nv12`.
    ///
    /// `-g 50 -keyint_min 50` is repeated for the same reason it exists at all: HLS
    /// needs segment boundaries to land on keyframes, and every encoder here honours
    /// those two generic options.
    fn video_arguments(self) -> &'static [&'static str] {
        match self {
            // Byte for byte the profile this gateway has always emitted. A camera
            // entry without `videoEncoder` must keep producing exactly this.
            Self::Libx264 => &[
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-tune",
                "zerolatency",
                "-pix_fmt",
                "yuv420p",
                "-g",
                "50",
                "-keyint_min",
                "50",
                "-sc_threshold",
                "0",
            ],
            // NVENC: `p1`..`p7` replaced the old named presets, and `ll` is its own
            // low-latency tuning (no lookahead, no B-frames).
            Self::H264Nvenc => &[
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p4",
                "-tune",
                "ll",
                "-pix_fmt",
                "yuv420p",
                "-g",
                "50",
                "-keyint_min",
                "50",
            ],
            // Quick Sync: the preset names read like libx264's but belong to the QSV
            // encoder. Latency is set by `-async_depth`, which is how deep the
            // encoder is allowed to queue; 1 means it does not run ahead.
            Self::H264Qsv => &[
                "-c:v",
                "h264_qsv",
                "-preset",
                "veryfast",
                "-async_depth",
                "1",
                "-pix_fmt",
                "nv12",
                "-g",
                "50",
                "-keyint_min",
                "50",
            ],
            // AMF: `-usage` states the scenario and `-quality` the speed/quality
            // trade-off. There is no preset and no tune.
            Self::H264Amf => &[
                "-c:v",
                "h264_amf",
                "-usage",
                "lowlatency",
                "-quality",
                "speed",
                "-pix_fmt",
                "yuv420p",
                "-g",
                "50",
                "-keyint_min",
                "50",
            ],
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawGatewayConfiguration {
    #[serde(default)]
    cameras: Vec<RawCameraSource>,
    max_workers: Option<usize>,
    ffmpeg_path: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCameraSource {
    camera_id: String,
    rtsp_url: String,
    #[serde(default)]
    transport: RtspTransport,
    #[serde(default)]
    transcode_video: bool,
    // Read as a string and resolved by `VideoEncoder::from_configuration_value` rather
    // than deserialized straight into the enum: serde reports an unknown variant as a
    // parse failure, which `read_configuration` can only report as
    // `InvalidConfiguration` — an error that does not say which field was wrong.
    // Absent means `VideoEncoder::default()`, so configurations written before this
    // field existed keep the command line they have always produced.
    video_encoder: Option<String>,
}

struct NativeCameraSource {
    rtsp_url: Url,
    transport: RtspTransport,
    transcode_video: bool,
    video_encoder: VideoEncoder,
}

struct GatewayConfiguration {
    sources: HashMap<String, NativeCameraSource>,
    max_workers: usize,
    ffmpeg_path: PathBuf,
    grant_rotate_interval: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MediaWorkerState {
    Starting,
    Ready,
    Backoff,
}

impl MediaWorkerState {
    fn public_name(self, consecutive_failures: u32) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Backoff if consecutive_failures >= DEGRADED_FAILURE_THRESHOLD => "degraded",
            Self::Backoff => "reconnecting",
        }
    }
}

struct MediaWorker {
    child: Option<Child>,
    stream_id: String,
    /// The grant a *new* consumer is handed (`descriptor`) and the one the
    /// asset route checks first. Rotates on `GRANT_ROTATE_INTERVAL` --
    /// before this field existed, a worker's one grant was valid,
    /// unrotated, for as long as at least one consumer kept the worker
    /// alive, which for a live monitoring wall is the length of the shoot.
    grant: String,
    grant_issued_at: Instant,
    /// The grant this worker served before the last rotation, and the
    /// instant it stops authorizing anything. A consumer's already-open HLS
    /// session has this URL baked into its manifest and every segment
    /// request until it refreshes, so the previous grant keeps working for
    /// one grace window rather than failing the instant a new grant is
    /// minted; after the deadline it authorizes nothing, same as a grant
    /// that was never issued.
    previous_grant: Option<(String, Instant)>,
    output_dir: PathBuf,
    consumers: HashSet<String>,
    generation: u64,
    state: MediaWorkerState,
    consecutive_failures: u32,
    total_restarts: u32,
    next_restart_at: Option<Instant>,
    last_manifest_modified_at: Option<SystemTime>,
    started_at: Instant,
}

#[derive(Clone)]
pub struct MediaGatewayState {
    inner: Arc<MediaGatewayInner>,
}

struct MediaGatewayInner {
    configuration: GatewayConfiguration,
    workers: Mutex<HashMap<String, MediaWorker>>,
    listener: StdMutex<Option<StdTcpListener>>,
    origin: String,
    output_root: PathBuf,
    generation: AtomicU64,
    shutting_down: AtomicBool,
    shutdown_notify: Notify,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCameraStream {
    camera_id: String,
    stream_id: String,
    manifest_url: String,
    generation: u64,
    transport: &'static str,
    state: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaGatewayStatus {
    available: bool,
    origin: String,
    configured_streams: usize,
    active_streams: usize,
    starting_streams: usize,
    reconnecting_streams: usize,
    failed_streams: usize,
    max_workers: usize,
    streams: Vec<MediaGatewayStreamHealth>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaGatewayStreamHealth {
    camera_id: String,
    stream_id: String,
    state: &'static str,
    consumers: usize,
    consecutive_failures: u32,
    total_restarts: u32,
    manifest_age_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayHealth {
    status: &'static str,
    configured_streams: usize,
    active_streams: usize,
    reconnecting_streams: usize,
    failed_streams: usize,
    capacity: usize,
}

impl MediaGatewayState {
    pub fn from_environment() -> Result<Self, MediaGatewayError> {
        let configuration = load_configuration()?;
        let port = env::var("HQ_MEDIA_GATEWAY_PORT")
            .ok()
            .map(|value| value.parse::<u16>())
            .transpose()
            .map_err(|_| MediaGatewayError::InvalidConfiguration)?
            .unwrap_or(0);
        let listener = StdTcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))?;
        listener.set_nonblocking(true)?;
        let local_addr = listener.local_addr()?;
        let output_root = env::temp_dir().join(format!(
            "gremuchaya-hq-media-gateway-{}",
            std::process::id()
        ));
        fs::create_dir_all(&output_root)?;

        Ok(Self {
            inner: Arc::new(MediaGatewayInner {
                configuration,
                workers: Mutex::new(HashMap::new()),
                listener: StdMutex::new(Some(listener)),
                origin: format!("http://{local_addr}"),
                output_root,
                generation: AtomicU64::new(1),
                shutting_down: AtomicBool::new(false),
                shutdown_notify: Notify::new(),
            }),
        })
    }

    pub async fn serve(self) -> Result<(), MediaGatewayError> {
        let listener = self
            .inner
            .listener
            .lock()
            .map_err(|_| MediaGatewayError::ServerUnavailable)?
            .take()
            .ok_or(MediaGatewayError::ServerUnavailable)?;
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let shutdown_state = self.clone();
        axum::serve(listener, gateway_router(self))
            .with_graceful_shutdown(async move { shutdown_state.wait_for_shutdown().await })
            .await?;
        Ok(())
    }

    pub async fn supervise(self) {
        while !self.inner.shutting_down.load(Ordering::SeqCst) {
            self.supervisor_tick().await;
            sleep(SUPERVISOR_INTERVAL).await;
        }
    }

    pub async fn shutdown(&self) {
        if self.inner.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        // There is one HTTP-server waiter. `notify_one` retains a permit when
        // shutdown wins the race before the waiter is first polled.
        self.inner.shutdown_notify.notify_one();
        let workers = {
            let mut active = self.inner.workers.lock().await;
            active.drain().map(|(_, worker)| worker).collect::<Vec<_>>()
        };
        for worker in workers {
            terminate_worker(worker).await;
        }
        let _ = tokio::fs::remove_dir_all(&self.inner.output_root).await;
    }

    async fn wait_for_shutdown(&self) {
        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        self.inner.shutdown_notify.notified().await;
    }

    async fn start_stream(
        &self,
        camera_id: &str,
        consumer_id: &str,
    ) -> Result<NativeCameraStream, MediaGatewayError> {
        validate_identifier(camera_id)?;
        validate_identifier(consumer_id)?;
        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return Err(MediaGatewayError::ShuttingDown);
        }
        let source = self
            .inner
            .configuration
            .sources
            .get(camera_id)
            .ok_or(MediaGatewayError::CameraNotConfigured)?;

        self.supervisor_tick().await;
        let generation;
        {
            let mut workers = self.inner.workers.lock().await;
            if let Some(worker) = workers.get_mut(camera_id) {
                worker.consumers.insert(consumer_id.to_owned());
                generation = worker.generation;
            } else {
                if workers.len() >= self.inner.configuration.max_workers {
                    return Err(MediaGatewayError::CapacityReached);
                }
                generation = self.inner.generation.fetch_add(1, Ordering::Relaxed);
                let stream_id = stream_id_for_camera(camera_id);
                let grant = create_grant()?;
                let output_dir = self
                    .inner
                    .output_root
                    .join(format!("{stream_id}-{generation}"));
                fs::create_dir_all(&output_dir)?;
                let mut command = build_ffmpeg_command(
                    &self.inner.configuration.ffmpeg_path,
                    source,
                    &output_dir,
                );
                let child = match command.spawn() {
                    Ok(child) => child,
                    Err(_) => {
                        let _ = fs::remove_dir_all(&output_dir);
                        return Err(MediaGatewayError::FfmpegUnavailable);
                    }
                };
                workers.insert(
                    camera_id.to_owned(),
                    MediaWorker {
                        child: Some(child),
                        stream_id,
                        grant,
                        grant_issued_at: Instant::now(),
                        previous_grant: None,
                        output_dir,
                        consumers: HashSet::from([consumer_id.to_owned()]),
                        generation,
                        state: MediaWorkerState::Starting,
                        consecutive_failures: 0,
                        total_restarts: 0,
                        next_restart_at: None,
                        last_manifest_modified_at: None,
                        started_at: Instant::now(),
                    },
                );
            }
        }

        self.wait_for_manifest(camera_id, generation).await
    }

    async fn wait_for_manifest(
        &self,
        camera_id: &str,
        generation: u64,
    ) -> Result<NativeCameraStream, MediaGatewayError> {
        let deadline = Instant::now() + MANIFEST_START_TIMEOUT;
        loop {
            self.supervisor_tick().await;
            let descriptor = {
                let workers = self.inner.workers.lock().await;
                let worker = workers
                    .get(camera_id)
                    .filter(|worker| worker.generation == generation)
                    .ok_or(MediaGatewayError::FfmpegExited)?;
                (worker.state == MediaWorkerState::Ready)
                    .then(|| self.descriptor(camera_id, worker))
            };
            if let Some(descriptor) = descriptor {
                return Ok(descriptor);
            }
            if Instant::now() >= deadline {
                return Err(MediaGatewayError::StartupTimeout);
            }
            sleep(Duration::from_millis(100)).await;
        }
    }

    async fn stop_stream(
        &self,
        camera_id: &str,
        consumer_id: &str,
    ) -> Result<bool, MediaGatewayError> {
        validate_identifier(camera_id)?;
        validate_identifier(consumer_id)?;
        let removed = {
            let mut workers = self.inner.workers.lock().await;
            let should_remove = workers
                .get_mut(camera_id)
                .map(|worker| {
                    worker.consumers.remove(consumer_id);
                    worker.consumers.is_empty()
                })
                .unwrap_or(false);
            should_remove.then(|| workers.remove(camera_id)).flatten()
        };
        if let Some(worker) = removed {
            terminate_worker(worker).await;
            return Ok(true);
        }
        Ok(false)
    }

    /// Hands an already-registered consumer the worker's current descriptor,
    /// which carries whatever grant is live at the moment of the call --
    /// freshly rotated or not. This is the half of "rotating grants" a
    /// player calls: `supervisor_tick` rotates the grant on its own schedule
    /// regardless of whether anything ever calls this, but nothing in this
    /// crate calls it *for* a consumer, so a session that never refreshes
    /// keeps degrading gracefully into the grace window and then failing,
    /// same as it would if a grant were never rotated for it at all. Calling
    /// this periodically, before that grace window closes, is the player's
    /// responsibility and is not implemented by this crate.
    ///
    /// `consumer_id` must already be registered against the worker --
    /// refreshing is not a way to join a stream, only to keep one going --
    /// so both an unconfigured camera and an unregistered consumer answer
    /// `CameraNotConfigured`.
    async fn refresh_grant(
        &self,
        camera_id: &str,
        consumer_id: &str,
    ) -> Result<NativeCameraStream, MediaGatewayError> {
        validate_identifier(camera_id)?;
        validate_identifier(consumer_id)?;
        let workers = self.inner.workers.lock().await;
        let worker = workers
            .get(camera_id)
            .filter(|worker| worker.consumers.contains(consumer_id))
            .ok_or(MediaGatewayError::CameraNotConfigured)?;
        Ok(self.descriptor(camera_id, worker))
    }

    async fn supervisor_tick(&self) {
        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let now = Instant::now();
        let (children_to_stop, manifest_probes) = {
            let mut workers = self.inner.workers.lock().await;
            let mut children_to_stop = Vec::new();
            let mut manifest_probes = Vec::new();
            for (camera_id, worker) in workers.iter_mut() {
                let child_failed = match worker.child.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(_)) | Err(_) => true,
                        Ok(None) => false,
                    },
                    None => false,
                };
                let startup_timed_out = worker.state == MediaWorkerState::Starting
                    && worker.started_at.elapsed() >= MANIFEST_START_TIMEOUT;
                if child_failed || startup_timed_out {
                    if let Some(child) = worker.child.take() {
                        children_to_stop.push(child);
                    }
                    schedule_worker_restart(camera_id, worker, now);
                    continue;
                }

                if worker.state == MediaWorkerState::Backoff
                    && worker
                        .next_restart_at
                        .is_some_and(|restart_at| restart_at <= now)
                {
                    worker.total_restarts = worker.total_restarts.saturating_add(1);
                    let restarted = reset_output_directory(&worker.output_dir).and_then(|()| {
                        let source =
                            self.inner
                                .configuration
                                .sources
                                .get(camera_id)
                                .ok_or_else(|| {
                                    io::Error::new(io::ErrorKind::NotFound, "camera source missing")
                                })?;
                        build_ffmpeg_command(
                            &self.inner.configuration.ffmpeg_path,
                            source,
                            &worker.output_dir,
                        )
                        .spawn()
                    });
                    match restarted {
                        Ok(child) => {
                            worker.child = Some(child);
                            worker.state = MediaWorkerState::Starting;
                            worker.next_restart_at = None;
                            worker.last_manifest_modified_at = None;
                            worker.started_at = now;
                        }
                        Err(_) => schedule_worker_restart(camera_id, worker, now),
                    }
                }

                if now.duration_since(worker.grant_issued_at)
                    >= self.inner.configuration.grant_rotate_interval
                {
                    if let Ok(fresh_grant) = create_grant() {
                        let rotated_out = mem::replace(&mut worker.grant, fresh_grant);
                        worker.previous_grant = Some((rotated_out, now + GRANT_GRACE_PERIOD));
                        worker.grant_issued_at = now;
                    }
                    // `create_grant` failing is `getrandom` failing, which this
                    // module already treats as transient elsewhere (`start_stream`
                    // simply propagates it); here the worse outcome is a skipped
                    // rotation, not a stopped stream, so a failure this tick is
                    // retried next tick rather than torn down.
                }

                if matches!(
                    worker.state,
                    MediaWorkerState::Starting | MediaWorkerState::Ready
                ) {
                    manifest_probes.push((
                        camera_id.clone(),
                        worker.generation,
                        worker.output_dir.join("index.m3u8"),
                    ));
                }
                if worker.state == MediaWorkerState::Ready
                    && worker.started_at.elapsed() >= RESTART_STABILITY_WINDOW
                {
                    worker.consecutive_failures = 0;
                }
            }
            (children_to_stop, manifest_probes)
        };

        for child in children_to_stop {
            terminate_child(child).await;
        }

        let mut manifest_updates = Vec::with_capacity(manifest_probes.len());
        for (camera_id, generation, manifest_path) in manifest_probes {
            if let Some(modified_at) = manifest_modified_at(&manifest_path).await {
                manifest_updates.push((camera_id, generation, modified_at));
            }
        }
        if !manifest_updates.is_empty() {
            let mut workers = self.inner.workers.lock().await;
            for (camera_id, generation, modified_at) in manifest_updates {
                if let Some(worker) = workers.get_mut(&camera_id).filter(|worker| {
                    worker.generation == generation
                        && worker.child.is_some()
                        && matches!(
                            worker.state,
                            MediaWorkerState::Starting | MediaWorkerState::Ready
                        )
                }) {
                    worker.state = MediaWorkerState::Ready;
                    worker.last_manifest_modified_at = Some(modified_at);
                }
            }
        }
    }

    async fn status(&self) -> MediaGatewayStatus {
        self.supervisor_tick().await;
        let workers = self.inner.workers.lock().await;
        let mut streams = workers
            .iter()
            .map(|(camera_id, worker)| MediaGatewayStreamHealth {
                camera_id: camera_id.clone(),
                stream_id: worker.stream_id.clone(),
                state: worker.state.public_name(worker.consecutive_failures),
                consumers: worker.consumers.len(),
                consecutive_failures: worker.consecutive_failures,
                total_restarts: worker.total_restarts,
                manifest_age_ms: worker.last_manifest_modified_at.and_then(|modified_at| {
                    modified_at
                        .elapsed()
                        .ok()
                        .map(|elapsed| elapsed.as_millis().min(u128::from(u64::MAX)) as u64)
                }),
            })
            .collect::<Vec<_>>();
        streams.sort_unstable_by(|left, right| left.camera_id.cmp(&right.camera_id));
        let starting_streams = workers
            .values()
            .filter(|worker| worker.state == MediaWorkerState::Starting)
            .count();
        let reconnecting_streams = workers
            .values()
            .filter(|worker| worker.state == MediaWorkerState::Backoff)
            .count();
        let failed_streams = workers
            .values()
            .filter(|worker| {
                worker.state == MediaWorkerState::Backoff
                    && worker.consecutive_failures >= DEGRADED_FAILURE_THRESHOLD
            })
            .count();
        MediaGatewayStatus {
            available: !self.inner.shutting_down.load(Ordering::SeqCst),
            origin: self.inner.origin.clone(),
            configured_streams: self.inner.configuration.sources.len(),
            active_streams: workers.len(),
            starting_streams,
            reconnecting_streams,
            failed_streams,
            max_workers: self.inner.configuration.max_workers,
            streams,
        }
    }

    async fn authorize_asset(
        &self,
        stream_id: &str,
        grant: &str,
        asset_name: &str,
    ) -> Option<PathBuf> {
        if !valid_stream_id(stream_id) || !valid_grant(grant) || !valid_asset_name(asset_name) {
            return None;
        }
        let now = Instant::now();
        let workers = self.inner.workers.lock().await;
        workers
            .values()
            .find(|worker| {
                if worker.stream_id != stream_id {
                    return false;
                }
                worker.grant == grant
                    || worker
                        .previous_grant
                        .as_ref()
                        .is_some_and(|(previous, expires_at)| {
                            previous == grant && now < *expires_at
                        })
            })
            .map(|worker| worker.output_dir.join(asset_name))
    }

    fn descriptor(&self, camera_id: &str, worker: &MediaWorker) -> NativeCameraStream {
        NativeCameraStream {
            camera_id: camera_id.to_owned(),
            stream_id: worker.stream_id.clone(),
            manifest_url: format!(
                "{}/v1/streams/{}/{}/index.m3u8",
                self.inner.origin, worker.stream_id, worker.grant
            ),
            generation: worker.generation,
            transport: "RTSP_GATEWAY",
            state: "ready",
        }
    }
}

#[tauri::command]
pub async fn start_camera_stream(
    state: State<'_, MediaGatewayState>,
    camera_id: String,
    consumer_id: String,
) -> Result<NativeCameraStream, MediaGatewayError> {
    state.start_stream(&camera_id, &consumer_id).await
}

#[tauri::command]
pub async fn stop_camera_stream(
    state: State<'_, MediaGatewayState>,
    camera_id: String,
    consumer_id: String,
) -> Result<bool, MediaGatewayError> {
    state.stop_stream(&camera_id, &consumer_id).await
}

/// Returns the worker's current descriptor without starting or restarting
/// anything, so a long-lived player can pick up a rotated grant before its
/// previous one leaves the `GRANT_GRACE_PERIOD` window. See
/// `MediaGatewayState::refresh_grant` for what calling this periodically
/// still requires on the caller's side, which nothing in this crate does.
#[tauri::command]
pub async fn refresh_camera_stream_grant(
    state: State<'_, MediaGatewayState>,
    camera_id: String,
    consumer_id: String,
) -> Result<NativeCameraStream, MediaGatewayError> {
    state.refresh_grant(&camera_id, &consumer_id).await
}

#[tauri::command]
pub async fn get_media_gateway_status(
    state: State<'_, MediaGatewayState>,
) -> Result<MediaGatewayStatus, MediaGatewayError> {
    Ok(state.status().await)
}

fn gateway_router(state: MediaGatewayState) -> Router {
    Router::new()
        .route("/v1/health", get(gateway_health))
        .route(
            "/v1/streams/{stream_id}/{grant}/{asset_name}",
            get(serve_hls_asset),
        )
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::predicate(|origin, _| allowed_origin(origin)))
                .allow_methods([Method::GET]),
        )
        .with_state(state)
}

async fn gateway_health(RouteState(state): RouteState<MediaGatewayState>) -> Json<GatewayHealth> {
    let status = state.status().await;
    Json(GatewayHealth {
        status: if status.configured_streams == 0 {
            "disabled"
        } else if !status.available {
            "stopping"
        } else if status.reconnecting_streams > 0 || status.failed_streams > 0 {
            "degraded"
        } else {
            "ready"
        },
        configured_streams: status.configured_streams,
        active_streams: status.active_streams,
        reconnecting_streams: status.reconnecting_streams,
        failed_streams: status.failed_streams,
        capacity: status.max_workers,
    })
}

async fn serve_hls_asset(
    RouteState(state): RouteState<MediaGatewayState>,
    RoutePath((stream_id, grant, asset_name)): RoutePath<(String, String, String)>,
) -> Response {
    let Some(path) = state.authorize_asset(&stream_id, &grant, &asset_name).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type_for_asset(&asset_name)),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if asset_name == "index.m3u8" {
            "private, no-store, max-age=0"
        } else {
            "private, max-age=8, immutable"
        }),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    (headers, bytes).into_response()
}

fn load_configuration() -> Result<GatewayConfiguration, MediaGatewayError> {
    let raw = match env::var_os("HQ_CAMERA_STREAMS_CONFIG") {
        Some(path) => read_configuration(Path::new(&path))?,
        None => RawGatewayConfiguration {
            cameras: Vec::new(),
            max_workers: None,
            ffmpeg_path: None,
        },
    };
    if raw.cameras.len() > MAX_CONFIGURED_STREAMS {
        return Err(MediaGatewayError::InvalidConfiguration);
    }
    let max_workers = env::var("HQ_MEDIA_GATEWAY_MAX_WORKERS")
        .ok()
        .map(|value| value.parse::<usize>())
        .transpose()
        .map_err(|_| MediaGatewayError::InvalidConfiguration)?
        .or(raw.max_workers)
        .unwrap_or(DEFAULT_MAX_WORKERS);
    if !(1..=16).contains(&max_workers) {
        return Err(MediaGatewayError::InvalidConfiguration);
    }
    let ffmpeg_path = env::var_os("HQ_FFMPEG_PATH")
        .map(PathBuf::from)
        .or(raw.ffmpeg_path)
        .unwrap_or_else(|| PathBuf::from("ffmpeg"));
    if ffmpeg_path.as_os_str().is_empty() {
        return Err(MediaGatewayError::InvalidConfiguration);
    }
    let grant_rotate_interval = env::var("HQ_MEDIA_GATEWAY_GRANT_ROTATE_SECS")
        .ok()
        .map(|value| value.parse::<u64>())
        .transpose()
        .map_err(|_| MediaGatewayError::InvalidConfiguration)?
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_GRANT_ROTATE_INTERVAL);
    if grant_rotate_interval < MIN_GRANT_ROTATE_INTERVAL {
        return Err(MediaGatewayError::InvalidConfiguration);
    }

    Ok(GatewayConfiguration {
        sources: native_camera_sources(raw.cameras)?,
        max_workers,
        ffmpeg_path,
        grant_rotate_interval,
    })
}

fn native_camera_sources(
    cameras: Vec<RawCameraSource>,
) -> Result<HashMap<String, NativeCameraSource>, MediaGatewayError> {
    let mut sources = HashMap::new();
    for source in cameras {
        validate_identifier(&source.camera_id)?;
        let url = parse_rtsp_url(&source.rtsp_url)?;
        // Resolved for every camera, including one with `transcodeVideo` false. A
        // misspelt encoder is a misspelt encoder whether or not this entry happens to
        // reach the branch that uses it; validity must not depend on a second field.
        let video_encoder = match source.video_encoder.as_deref() {
            Some(value) => VideoEncoder::from_configuration_value(value)?,
            None => VideoEncoder::default(),
        };
        if sources
            .insert(
                source.camera_id,
                NativeCameraSource {
                    rtsp_url: url,
                    transport: source.transport,
                    transcode_video: source.transcode_video,
                    video_encoder,
                },
            )
            .is_some()
        {
            return Err(MediaGatewayError::InvalidConfiguration);
        }
    }
    Ok(sources)
}

fn parse_rtsp_url(value: &str) -> Result<Url, MediaGatewayError> {
    let url = Url::parse(value).map_err(|_| MediaGatewayError::InvalidConfiguration)?;
    if !matches!(url.scheme(), "rtsp" | "rtsps") || url.host_str().is_none() {
        return Err(MediaGatewayError::InvalidConfiguration);
    }
    Ok(url)
}

fn read_configuration(path: &Path) -> Result<RawGatewayConfiguration, MediaGatewayError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err(MediaGatewayError::UnsafeConfigurationFile);
    }
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|_| MediaGatewayError::InvalidConfiguration)
}

fn build_ffmpeg_command(
    ffmpeg_path: &Path,
    source: &NativeCameraSource,
    output_dir: &Path,
) -> Command {
    let mut command = Command::new(ffmpeg_path);
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .arg("-nostdin")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("warning")
        .arg("-rtsp_transport")
        .arg(source.transport.as_ffmpeg_value())
        .arg("-rw_timeout")
        .arg("5000000")
        .arg("-i")
        .arg(source.rtsp_url.as_str())
        .arg("-map")
        .arg("0:v:0")
        .arg("-map")
        .arg("0:a:0?");
    if source.transcode_video {
        command.args(source.video_encoder.video_arguments());
    } else {
        command.arg("-c:v").arg("copy");
    }
    command
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("96k")
        .arg("-ac")
        .arg("2")
        .arg("-ar")
        .arg("48000")
        .arg("-f")
        .arg("hls")
        .arg("-hls_time")
        .arg(HLS_SEGMENT_SECONDS)
        .arg("-hls_list_size")
        .arg(HLS_LIST_SIZE)
        .arg("-hls_delete_threshold")
        .arg(HLS_DELETE_THRESHOLD)
        .arg("-hls_flags")
        .arg("delete_segments+append_list+omit_endlist+independent_segments")
        .arg("-hls_allow_cache")
        .arg("0")
        .arg("-hls_segment_filename")
        .arg(output_dir.join("segment-%09d.ts"))
        .arg(output_dir.join("index.m3u8"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    command
}

async fn manifest_modified_at(path: &Path) -> Option<SystemTime> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    (metadata.is_file() && metadata.len() > 0)
        .then(|| metadata.modified().ok())
        .flatten()
}

async fn terminate_worker(mut worker: MediaWorker) {
    if let Some(child) = worker.child.take() {
        terminate_child(child).await;
    }
    let _ = tokio::fs::remove_dir_all(worker.output_dir).await;
}

async fn terminate_child(mut child: Child) {
    let _ = child.start_kill();
    let _ = timeout(PROCESS_STOP_TIMEOUT, child.wait()).await;
}

fn reset_output_directory(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    fs::create_dir_all(path)
}

fn schedule_worker_restart(camera_id: &str, worker: &mut MediaWorker, now: Instant) {
    worker.state = MediaWorkerState::Backoff;
    worker.consecutive_failures = worker.consecutive_failures.saturating_add(1);
    worker.next_restart_at = Some(now + restart_delay(camera_id, worker.consecutive_failures));
}

fn restart_delay(camera_id: &str, consecutive_failures: u32) -> Duration {
    let exponent = consecutive_failures.saturating_sub(1).min(6);
    let base = RESTART_BACKOFF_BASE_MS
        .saturating_mul(1_u64 << exponent)
        .min(RESTART_BACKOFF_MAX_MS);
    let jitter = restart_jitter(camera_id, consecutive_failures);
    Duration::from_millis(base.saturating_add(jitter).min(RESTART_BACKOFF_MAX_MS))
}

fn restart_jitter(camera_id: &str, consecutive_failures: u32) -> u64 {
    let hash = camera_id
        .bytes()
        .chain(consecutive_failures.to_le_bytes())
        .fold(0xcbf29ce484222325_u64, |current, byte| {
            current.wrapping_mul(0x100000001b3) ^ u64::from(byte)
        });
    hash % (RESTART_JITTER_MAX_MS + 1)
}

fn create_grant() -> Result<String, MediaGatewayError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| MediaGatewayError::ServerUnavailable)?;
    Ok(hex::encode(bytes))
}

fn validate_identifier(value: &str) -> Result<(), MediaGatewayError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(MediaGatewayError::InvalidIdentifier);
    }
    Ok(())
}

fn stream_id_for_camera(camera_id: &str) -> String {
    format!("camera-{}", camera_id.to_ascii_lowercase())
}

fn valid_stream_id(value: &str) -> bool {
    value
        .strip_prefix("camera-")
        .is_some_and(|camera_id| validate_identifier(camera_id).is_ok())
}

fn valid_grant(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_asset_name(value: &str) -> bool {
    if matches!(value, "index.m3u8" | "init.mp4") {
        return true;
    }
    [".ts", ".m4s"].into_iter().any(|suffix| {
        value
            .strip_prefix("segment-")
            .and_then(|rest| rest.strip_suffix(suffix))
            .is_some_and(|index| {
                !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
            })
    })
}

fn content_type_for_asset(value: &str) -> &'static str {
    if value.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else if value.ends_with(".ts") {
        "video/mp2t"
    } else {
        "video/mp4"
    }
}

fn allowed_origin(origin: &HeaderValue) -> bool {
    matches!(
        origin.as_bytes(),
        b"http://127.0.0.1:3000"
            | b"http://localhost:3000"
            | b"http://tauri.localhost"
            | b"https://tauri.localhost"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_OUTPUT_DIR: &str = "C:/hq/hls";
    const TEST_RTSP_URL: &str = "rtsp://operator:s3cr3t@camera.invalid/live";

    fn source(url: &str, transcode_video: bool) -> NativeCameraSource {
        NativeCameraSource {
            rtsp_url: Url::parse(url).expect("test source URL must parse"),
            transport: RtspTransport::Tcp,
            transcode_video,
            video_encoder: VideoEncoder::default(),
        }
    }

    fn command_arguments(source: &NativeCameraSource) -> Vec<String> {
        let command = build_ffmpeg_command(Path::new("ffmpeg"), source, Path::new(TEST_OUTPUT_DIR));
        command
            .as_std()
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect()
    }

    /// Builds the arguments the gateway would run for a camera entry written as JSON,
    /// so the assertions below are made against the external process invocation rather
    /// than against the parsed structure.
    fn command_arguments_for_configuration(json: &str) -> Result<Vec<String>, MediaGatewayError> {
        let raw: RawGatewayConfiguration =
            serde_json::from_str(json).expect("test configuration must be valid JSON");
        let sources = native_camera_sources(raw.cameras)?;
        let source = sources.get("K-17").expect("test camera must be configured");
        Ok(command_arguments(source))
    }

    /// The video half of the invocation: everything from `-c:v` up to the audio codec.
    fn video_arguments_of(arguments: &[String]) -> Vec<String> {
        let start = arguments
            .iter()
            .position(|argument| argument == "-c:v")
            .expect("a video codec must be selected");
        let end = arguments
            .iter()
            .position(|argument| argument == "-c:a")
            .expect("an audio codec must follow the video arguments");
        arguments[start..end].to_vec()
    }

    fn camera_configuration(encoder_field: &str) -> String {
        format!(
            r#"{{"cameras":[{{"cameraId":"K-17","rtspUrl":"{TEST_RTSP_URL}","transcodeVideo":true{encoder_field}}}]}}"#
        )
    }

    #[test]
    fn rejects_traversal_like_identifiers_and_asset_names() {
        assert!(validate_identifier("K-17").is_ok());
        assert!(validate_identifier("../K-17").is_err());
        assert!(!valid_stream_id("../camera-k-17"));
        assert!(valid_asset_name("segment-000000123.ts"));
        assert!(!valid_asset_name("../segment-000000123.ts"));
        assert!(!valid_asset_name("camera.env"));
    }

    #[test]
    fn grants_are_256_bit_hex_values() {
        let first = create_grant().expect("grant must be generated");
        let second = create_grant().expect("grant must be generated");
        assert!(valid_grant(&first));
        assert_ne!(first, second);
    }

    #[test]
    fn copy_profile_keeps_input_native_and_bounds_hls_retention() {
        let arguments = command_arguments(&source("rtsp://camera.invalid/live", false));
        assert!(arguments.windows(2).any(|pair| pair == ["-c:v", "copy"]));
        assert!(arguments
            .windows(2)
            .any(|pair| pair == ["-hls_list_size", HLS_LIST_SIZE]));
        assert!(arguments
            .iter()
            .any(|argument| argument
                == "delete_segments+append_list+omit_endlist+independent_segments"));
        assert!(arguments
            .last()
            .is_some_and(|argument| argument.ends_with("index.m3u8")));
    }

    #[test]
    fn transcode_profile_uses_low_latency_h264_without_shell_interpolation() {
        let arguments = command_arguments(&source("rtsps://camera.invalid/live", true));
        assert!(arguments.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
        assert!(arguments
            .windows(2)
            .any(|pair| pair == ["-tune", "zerolatency"]));
        assert!(arguments.windows(2).any(|pair| pair == ["-c:a", "aac"]));
        assert!(!arguments.iter().any(|argument| argument == "cmd.exe"));
        assert!(!arguments.iter().any(|argument| argument == "sh"));
    }

    #[test]
    fn an_unset_encoder_reproduces_the_previous_command_line_argument_for_argument() {
        let arguments = command_arguments_for_configuration(&camera_configuration(""))
            .expect("a camera entry without videoEncoder must be accepted");
        let mut expected: Vec<String> = [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-rtsp_transport",
            "tcp",
            "-rw_timeout",
            "5000000",
            "-i",
        ]
        .iter()
        .map(|argument| (*argument).to_owned())
        .collect();
        expected.push(
            Url::parse(TEST_RTSP_URL)
                .expect("test source URL must parse")
                .to_string(),
        );
        expected.extend(
            [
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-tune",
                "zerolatency",
                "-pix_fmt",
                "yuv420p",
                "-g",
                "50",
                "-keyint_min",
                "50",
                "-sc_threshold",
                "0",
                "-c:a",
                "aac",
                "-b:a",
                "96k",
                "-ac",
                "2",
                "-ar",
                "48000",
                "-f",
                "hls",
                "-hls_time",
                "2",
                "-hls_list_size",
                "6",
                "-hls_delete_threshold",
                "2",
                "-hls_flags",
                "delete_segments+append_list+omit_endlist+independent_segments",
                "-hls_allow_cache",
                "0",
                "-hls_segment_filename",
            ]
            .iter()
            .map(|argument| (*argument).to_owned()),
        );
        expected.push(
            Path::new(TEST_OUTPUT_DIR)
                .join("segment-%09d.ts")
                .to_string_lossy()
                .into_owned(),
        );
        expected.push(
            Path::new(TEST_OUTPUT_DIR)
                .join("index.m3u8")
                .to_string_lossy()
                .into_owned(),
        );
        assert_eq!(arguments, expected);
    }

    #[test]
    fn each_encoder_carries_its_own_quality_and_latency_options() {
        for (encoder, expected) in [
            (
                "libx264",
                vec![
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-tune",
                    "zerolatency",
                    "-pix_fmt",
                    "yuv420p",
                    "-g",
                    "50",
                    "-keyint_min",
                    "50",
                    "-sc_threshold",
                    "0",
                ],
            ),
            (
                "h264_nvenc",
                vec![
                    "-c:v",
                    "h264_nvenc",
                    "-preset",
                    "p4",
                    "-tune",
                    "ll",
                    "-pix_fmt",
                    "yuv420p",
                    "-g",
                    "50",
                    "-keyint_min",
                    "50",
                ],
            ),
            (
                "h264_qsv",
                vec![
                    "-c:v",
                    "h264_qsv",
                    "-preset",
                    "veryfast",
                    "-async_depth",
                    "1",
                    "-pix_fmt",
                    "nv12",
                    "-g",
                    "50",
                    "-keyint_min",
                    "50",
                ],
            ),
            (
                "h264_amf",
                vec![
                    "-c:v",
                    "h264_amf",
                    "-usage",
                    "lowlatency",
                    "-quality",
                    "speed",
                    "-pix_fmt",
                    "yuv420p",
                    "-g",
                    "50",
                    "-keyint_min",
                    "50",
                ],
            ),
        ] {
            let configuration = camera_configuration(&format!(r#","videoEncoder":"{encoder}""#));
            let arguments = command_arguments_for_configuration(&configuration)
                .expect("a supported encoder must be accepted");
            assert_eq!(
                video_arguments_of(&arguments),
                expected,
                "encoder {encoder}"
            );
        }
    }

    #[test]
    fn an_unknown_encoder_is_refused_by_field_name_instead_of_falling_back() {
        let configuration = camera_configuration(r#","videoEncoder":"h264_nvnec""#);
        let error = command_arguments_for_configuration(&configuration)
            .expect_err("a misspelt encoder must not be accepted");
        assert!(matches!(error, MediaGatewayError::UnsupportedVideoEncoder));
        let message = error.to_string();
        assert!(message.contains("videoEncoder"), "{message}");
        // The refusal must not quote the camera entry back: `rtspUrl` carries
        // credentials, and this message reaches the UI and the startup output.
        assert!(!message.contains("s3cr3t"), "{message}");
        assert!(!message.contains("camera.invalid"), "{message}");
        assert!(!message.contains("h264_nvnec"), "{message}");
    }

    #[test]
    fn an_unknown_encoder_is_refused_even_when_the_camera_is_not_transcoded() {
        let configuration = format!(
            r#"{{"cameras":[{{"cameraId":"K-17","rtspUrl":"{TEST_RTSP_URL}","videoEncoder":"h264_nvnec"}}]}}"#
        );
        assert!(matches!(
            command_arguments_for_configuration(&configuration),
            Err(MediaGatewayError::UnsupportedVideoEncoder)
        ));
    }

    #[test]
    fn the_encoder_field_cannot_smuggle_further_ffmpeg_arguments() {
        for value in [
            "libx264 -f null -",
            "libx264\" \"-vf",
            "libx264;calc.exe",
            "LIBX264",
            "",
        ] {
            let encoded = serde_json::to_string(value).expect("test value must serialize");
            let configuration = camera_configuration(&format!(r#","videoEncoder":{encoded}"#));
            assert!(
                matches!(
                    command_arguments_for_configuration(&configuration),
                    Err(MediaGatewayError::UnsupportedVideoEncoder)
                ),
                "value {value:?} must be refused"
            );
        }
    }

    #[test]
    fn cors_is_limited_to_known_application_origins() {
        assert!(allowed_origin(&HeaderValue::from_static(
            "http://127.0.0.1:3000"
        )));
        assert!(allowed_origin(&HeaderValue::from_static(
            "http://tauri.localhost"
        )));
        assert!(!allowed_origin(&HeaderValue::from_static(
            "https://untrusted.invalid"
        )));
    }

    #[test]
    fn accepts_only_rtsp_sources_with_a_host() {
        assert!(parse_rtsp_url("rtsp://camera.invalid/live").is_ok());
        assert!(parse_rtsp_url("rtsps://camera.invalid/live").is_ok());
        assert!(parse_rtsp_url("https://camera.invalid/live").is_err());
        assert!(parse_rtsp_url("rtsp:///missing-host").is_err());
    }

    #[test]
    fn restart_backoff_is_deterministic_bounded_and_jittered() {
        let first = restart_delay("K-17", 1);
        let second = restart_delay("K-17", 2);
        assert_eq!(first, restart_delay("K-17", 1));
        assert!(first >= Duration::from_millis(RESTART_BACKOFF_BASE_MS));
        assert!(first <= Duration::from_millis(RESTART_BACKOFF_BASE_MS + RESTART_JITTER_MAX_MS));
        assert!(second >= Duration::from_millis(RESTART_BACKOFF_BASE_MS * 2));
        assert!(
            second <= Duration::from_millis(RESTART_BACKOFF_BASE_MS * 2 + RESTART_JITTER_MAX_MS)
        );
        assert_eq!(
            restart_delay("K-17", u32::MAX),
            Duration::from_millis(RESTART_BACKOFF_MAX_MS)
        );
        assert_ne!(restart_jitter("K-17", 1), restart_jitter("K-18", 1));
    }

    #[test]
    fn supervisor_preserves_stream_identity_and_reports_degraded_restart() {
        tauri::async_runtime::block_on(async {
            let listener =
                StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("test listener must bind");
            listener
                .set_nonblocking(true)
                .expect("test listener must become nonblocking");
            let local_addr = listener.local_addr().expect("test address must resolve");
            let output_root = env::temp_dir().join(format!(
                "gremuchaya-hq-media-supervisor-test-{}",
                create_grant().expect("test suffix must be generated")
            ));
            let output_dir = output_root.join("camera-k-17-1");
            fs::create_dir_all(&output_dir).expect("test output directory must exist");
            let mut child_command = Command::new(
                env::current_exe().expect("current test executable must be available"),
            );
            child_command
                .arg("--help")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            let mut child = child_command.spawn().expect("test child must start");
            child.wait().await.expect("test child must exit");
            let grant = create_grant().expect("test grant must be generated");
            let state = MediaGatewayState {
                inner: Arc::new(MediaGatewayInner {
                    configuration: GatewayConfiguration {
                        sources: HashMap::from([(
                            "K-17".to_owned(),
                            source("rtsp://camera.invalid/live", false),
                        )]),
                        max_workers: 4,
                        ffmpeg_path: PathBuf::from("ffmpeg"),
                        grant_rotate_interval: DEFAULT_GRANT_ROTATE_INTERVAL,
                    },
                    workers: Mutex::new(HashMap::from([(
                        "K-17".to_owned(),
                        MediaWorker {
                            child: Some(child),
                            stream_id: "camera-k-17".to_owned(),
                            grant: grant.clone(),
                            grant_issued_at: Instant::now(),
                            previous_grant: None,
                            output_dir: output_dir.clone(),
                            consumers: HashSet::from(["test-consumer".to_owned()]),
                            generation: 1,
                            state: MediaWorkerState::Ready,
                            consecutive_failures: DEGRADED_FAILURE_THRESHOLD - 1,
                            total_restarts: 2,
                            next_restart_at: None,
                            last_manifest_modified_at: Some(SystemTime::now()),
                            started_at: Instant::now(),
                        },
                    )])),
                    listener: StdMutex::new(Some(listener)),
                    origin: format!("http://{local_addr}"),
                    output_root,
                    generation: AtomicU64::new(2),
                    shutting_down: AtomicBool::new(false),
                    shutdown_notify: Notify::new(),
                }),
            };

            state.supervisor_tick().await;
            let status = state.status().await;
            assert_eq!(status.active_streams, 1);
            assert_eq!(status.reconnecting_streams, 1);
            assert_eq!(status.failed_streams, 1);
            assert_eq!(status.streams[0].state, "degraded");
            let workers = state.inner.workers.lock().await;
            let worker = workers.get("K-17").expect("worker must remain registered");
            assert_eq!(worker.stream_id, "camera-k-17");
            assert_eq!(worker.grant, grant);
            assert_eq!(worker.output_dir, output_dir);
            assert_eq!(worker.generation, 1);
            assert!(worker.child.is_none());
            drop(workers);
            state.shutdown().await;
        });
    }

    #[tokio::test]
    async fn supervisor_rotates_the_grant_after_the_interval_and_keeps_the_previous_one_valid_during_grace(
    ) {
        let listener =
            StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("test listener must bind");
        listener
            .set_nonblocking(true)
            .expect("test listener must become nonblocking");
        let local_addr = listener.local_addr().expect("test address must resolve");
        let output_root = env::temp_dir().join(format!(
            "gremuchaya-hq-media-grant-rotation-test-{}",
            create_grant().expect("test suffix must be generated")
        ));
        let output_dir = output_root.join("camera-k-17-1");
        fs::create_dir_all(&output_dir).expect("test output directory must exist");
        let original_grant = create_grant().expect("test grant must be generated");
        let state = MediaGatewayState {
            inner: Arc::new(MediaGatewayInner {
                configuration: GatewayConfiguration {
                    sources: HashMap::new(),
                    max_workers: 4,
                    ffmpeg_path: PathBuf::from("ffmpeg"),
                    // Short enough that this test does not have to sleep for
                    // the production default to observe a rotation.
                    grant_rotate_interval: Duration::from_millis(10),
                },
                workers: Mutex::new(HashMap::from([(
                    "K-17".to_owned(),
                    MediaWorker {
                        child: None,
                        stream_id: "camera-k-17".to_owned(),
                        grant: original_grant.clone(),
                        grant_issued_at: Instant::now() - Duration::from_secs(1),
                        previous_grant: None,
                        output_dir: output_dir.clone(),
                        consumers: HashSet::from(["test-consumer".to_owned()]),
                        generation: 1,
                        state: MediaWorkerState::Ready,
                        consecutive_failures: 0,
                        total_restarts: 0,
                        next_restart_at: None,
                        last_manifest_modified_at: None,
                        started_at: Instant::now(),
                    },
                )])),
                listener: StdMutex::new(Some(listener)),
                origin: format!("http://{local_addr}"),
                output_root,
                generation: AtomicU64::new(2),
                shutting_down: AtomicBool::new(false),
                shutdown_notify: Notify::new(),
            }),
        };

        state.supervisor_tick().await;

        let rotated_grant = {
            let workers = state.inner.workers.lock().await;
            let worker = workers.get("K-17").expect("worker must remain registered");
            assert_ne!(
                worker.grant, original_grant,
                "the grant must rotate once the interval elapses"
            );
            assert!(worker
                .previous_grant
                .as_ref()
                .is_some_and(|(previous, _)| previous == &original_grant));
            worker.grant.clone()
        };

        assert!(state
            .authorize_asset("camera-k-17", &rotated_grant, "index.m3u8")
            .await
            .is_some());
        // The rotated-out grant still authorizes during its grace window --
        // a consumer's already-open HLS session does not fail the instant a
        // new grant is minted.
        assert!(state
            .authorize_asset("camera-k-17", &original_grant, "index.m3u8")
            .await
            .is_some());

        state.shutdown().await;
    }

    #[tokio::test]
    async fn authorize_asset_refuses_a_previous_grant_once_its_grace_window_has_passed() {
        let listener =
            StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("test listener must bind");
        listener
            .set_nonblocking(true)
            .expect("test listener must become nonblocking");
        let local_addr = listener.local_addr().expect("test address must resolve");
        let output_root = env::temp_dir().join(format!(
            "gremuchaya-hq-media-grant-grace-test-{}",
            create_grant().expect("test suffix must be generated")
        ));
        let output_dir = output_root.join("camera-k-17-1");
        fs::create_dir_all(&output_dir).expect("test output directory must exist");
        let current_grant = create_grant().expect("test grant must be generated");
        let expired_grant = create_grant().expect("test grant must be generated");
        let state = MediaGatewayState {
            inner: Arc::new(MediaGatewayInner {
                configuration: GatewayConfiguration {
                    sources: HashMap::new(),
                    max_workers: 4,
                    ffmpeg_path: PathBuf::from("ffmpeg"),
                    grant_rotate_interval: DEFAULT_GRANT_ROTATE_INTERVAL,
                },
                workers: Mutex::new(HashMap::from([(
                    "K-17".to_owned(),
                    MediaWorker {
                        child: None,
                        stream_id: "camera-k-17".to_owned(),
                        grant: current_grant.clone(),
                        grant_issued_at: Instant::now(),
                        // Already past its deadline: rotation happened one
                        // grace window ago, not this tick.
                        previous_grant: Some((
                            expired_grant.clone(),
                            Instant::now() - Duration::from_secs(1),
                        )),
                        output_dir,
                        consumers: HashSet::from(["test-consumer".to_owned()]),
                        generation: 1,
                        state: MediaWorkerState::Ready,
                        consecutive_failures: 0,
                        total_restarts: 0,
                        next_restart_at: None,
                        last_manifest_modified_at: None,
                        started_at: Instant::now(),
                    },
                )])),
                listener: StdMutex::new(Some(listener)),
                origin: format!("http://{local_addr}"),
                output_root,
                generation: AtomicU64::new(2),
                shutting_down: AtomicBool::new(false),
                shutdown_notify: Notify::new(),
            }),
        };

        assert!(state
            .authorize_asset("camera-k-17", &current_grant, "index.m3u8")
            .await
            .is_some());
        assert!(state
            .authorize_asset("camera-k-17", &expired_grant, "index.m3u8")
            .await
            .is_none());

        state.shutdown().await;
    }

    #[tokio::test]
    async fn refresh_grant_returns_the_live_descriptor_and_refuses_an_unregistered_consumer() {
        let listener =
            StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("test listener must bind");
        listener
            .set_nonblocking(true)
            .expect("test listener must become nonblocking");
        let local_addr = listener.local_addr().expect("test address must resolve");
        let output_root = env::temp_dir().join(format!(
            "gremuchaya-hq-media-refresh-grant-test-{}",
            create_grant().expect("test suffix must be generated")
        ));
        let output_dir = output_root.join("camera-k-17-1");
        fs::create_dir_all(&output_dir).expect("test output directory must exist");
        let grant = create_grant().expect("test grant must be generated");
        let state = MediaGatewayState {
            inner: Arc::new(MediaGatewayInner {
                configuration: GatewayConfiguration {
                    sources: HashMap::new(),
                    max_workers: 4,
                    ffmpeg_path: PathBuf::from("ffmpeg"),
                    grant_rotate_interval: DEFAULT_GRANT_ROTATE_INTERVAL,
                },
                workers: Mutex::new(HashMap::from([(
                    "K-17".to_owned(),
                    MediaWorker {
                        child: None,
                        stream_id: "camera-k-17".to_owned(),
                        grant: grant.clone(),
                        grant_issued_at: Instant::now(),
                        previous_grant: None,
                        output_dir,
                        consumers: HashSet::from(["consumer-a".to_owned()]),
                        generation: 1,
                        state: MediaWorkerState::Ready,
                        consecutive_failures: 0,
                        total_restarts: 0,
                        next_restart_at: None,
                        last_manifest_modified_at: None,
                        started_at: Instant::now(),
                    },
                )])),
                listener: StdMutex::new(Some(listener)),
                origin: format!("http://{local_addr}"),
                output_root,
                generation: AtomicU64::new(2),
                shutting_down: AtomicBool::new(false),
                shutdown_notify: Notify::new(),
            }),
        };

        let descriptor = state
            .refresh_grant("K-17", "consumer-a")
            .await
            .expect("a registered consumer must be able to refresh");
        assert!(descriptor.manifest_url.contains(&grant));

        assert!(matches!(
            state.refresh_grant("K-17", "consumer-b").await,
            Err(MediaGatewayError::CameraNotConfigured)
        ));
        assert!(matches!(
            state.refresh_grant("K-99", "consumer-a").await,
            Err(MediaGatewayError::CameraNotConfigured)
        ));

        state.shutdown().await;
    }

    #[test]
    fn failed_initial_spawn_does_not_leave_an_untracked_output_directory() {
        tauri::async_runtime::block_on(async {
            let listener =
                StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("test listener must bind");
            listener
                .set_nonblocking(true)
                .expect("test listener must become nonblocking");
            let local_addr = listener.local_addr().expect("test address must resolve");
            let output_root = env::temp_dir().join(format!(
                "gremuchaya-hq-media-spawn-test-{}",
                create_grant().expect("test suffix must be generated")
            ));
            fs::create_dir_all(&output_root).expect("test output root must exist");
            let state = MediaGatewayState {
                inner: Arc::new(MediaGatewayInner {
                    configuration: GatewayConfiguration {
                        sources: HashMap::from([(
                            "K-17".to_owned(),
                            source("rtsp://camera.invalid/live", false),
                        )]),
                        max_workers: 4,
                        ffmpeg_path: output_root.join("missing-ffmpeg-binary.exe"),
                        grant_rotate_interval: DEFAULT_GRANT_ROTATE_INTERVAL,
                    },
                    workers: Mutex::new(HashMap::new()),
                    listener: StdMutex::new(Some(listener)),
                    origin: format!("http://{local_addr}"),
                    output_root: output_root.clone(),
                    generation: AtomicU64::new(1),
                    shutting_down: AtomicBool::new(false),
                    shutdown_notify: Notify::new(),
                }),
            };

            assert!(matches!(
                state.start_stream("K-17", "test-consumer").await,
                Err(MediaGatewayError::FfmpegUnavailable)
            ));
            assert!(state.inner.workers.lock().await.is_empty());
            assert_eq!(
                fs::read_dir(&output_root)
                    .expect("output root must remain readable")
                    .count(),
                0
            );
            state.shutdown().await;
        });
    }

    #[test]
    fn serves_only_granted_hls_assets_with_security_headers() {
        tauri::async_runtime::block_on(async {
            let listener =
                StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("test listener must bind");
            listener
                .set_nonblocking(true)
                .expect("test listener must become nonblocking");
            let local_addr = listener.local_addr().expect("test address must resolve");
            let output_root = env::temp_dir().join(format!(
                "gremuchaya-hq-media-gateway-test-{}",
                create_grant().expect("test suffix must be generated")
            ));
            let output_dir = output_root.join("camera-k-17-1");
            fs::create_dir_all(&output_dir).expect("test output directory must exist");
            fs::write(output_dir.join("index.m3u8"), b"#EXTM3U\n")
                .expect("test manifest must be written");
            let mut child_command = Command::new(
                env::current_exe().expect("current test executable must be available"),
            );
            child_command
                .arg("--help")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            let child = child_command.spawn().expect("test child must start");
            let grant = create_grant().expect("test grant must be generated");
            let state = MediaGatewayState {
                inner: Arc::new(MediaGatewayInner {
                    configuration: GatewayConfiguration {
                        sources: HashMap::new(),
                        max_workers: 4,
                        ffmpeg_path: PathBuf::from("ffmpeg"),
                        grant_rotate_interval: DEFAULT_GRANT_ROTATE_INTERVAL,
                    },
                    workers: Mutex::new(HashMap::from([(
                        "K-17".to_owned(),
                        MediaWorker {
                            child: Some(child),
                            stream_id: "camera-k-17".to_owned(),
                            grant: grant.clone(),
                            grant_issued_at: Instant::now(),
                            previous_grant: None,
                            output_dir,
                            consumers: HashSet::from(["test-consumer".to_owned()]),
                            generation: 1,
                            state: MediaWorkerState::Ready,
                            consecutive_failures: 0,
                            total_restarts: 0,
                            next_restart_at: None,
                            last_manifest_modified_at: Some(SystemTime::now()),
                            started_at: Instant::now(),
                        },
                    )])),
                    listener: StdMutex::new(Some(listener)),
                    origin: format!("http://{local_addr}"),
                    output_root,
                    generation: AtomicU64::new(2),
                    shutting_down: AtomicBool::new(false),
                    shutdown_notify: Notify::new(),
                }),
            };

            let response = serve_hls_asset(
                RouteState(state.clone()),
                RoutePath(("camera-k-17".to_owned(), grant, "index.m3u8".to_owned())),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers().get(header::X_CONTENT_TYPE_OPTIONS),
                Some(&HeaderValue::from_static("nosniff"))
            );

            let denied = serve_hls_asset(
                RouteState(state.clone()),
                RoutePath((
                    "camera-k-17".to_owned(),
                    "0".repeat(64),
                    "index.m3u8".to_owned(),
                )),
            )
            .await;
            assert_eq!(denied.status(), StatusCode::NOT_FOUND);
            state.shutdown().await;
        });
    }
}
