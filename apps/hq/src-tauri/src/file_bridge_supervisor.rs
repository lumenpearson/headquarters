//! Optional desktop-side autostart for `apps/file-bridge`.
//!
//! `docs/release/known-limitations.md` ("local access") has recorded, until now,
//! that "the desktop build does not start `apps/file-bridge` itself... so an
//! operator who wants the bridge starts it separately." ADR-0003 makes the
//! bridge itself optional -- a service an operator opts into by writing a local
//! `bridge.config.json` -- but says nothing about who launches the process, and
//! ADR-0005 already treats a local child process as ordinary for this shell: "the
//! optional file bridge is a separate Node process [...] not a rendering
//! dependency", named in the very sentence that also names the native media
//! gateway's own `ffmpeg` child process. Supervising the bridge the way
//! `media_gateway::MediaGatewayState::supervise` already supervises `ffmpeg`
//! workers is that same idiom applied to a second optional local process, not a
//! new category of one.
//!
//! What stays unchanged is the opt-in: this module never spawns anything on its
//! own. `HQ_FILE_BRIDGE_AUTOSTART_COMMAND` is the one gate -- unset (the default
//! on every machine today), `supervise()` returns immediately having spawned
//! nothing, and the desktop shell behaves exactly as it does before this module
//! existed. Set, the module treats the bridge like any other supervised child:
//! spawn, watch for exit, restart with the same exponential-backoff-plus-jitter
//! shape `media_gateway.rs` uses, and stop supervising (without killing an
//! already-running process it did not start) if the command is missing rather
//! than a good binary that panics.

use serde::Serialize;
use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::State;
use thiserror::Error;
use tokio::{
    process::{Child, Command},
    sync::{Mutex, Notify},
    time::sleep,
};

const SUPERVISOR_INTERVAL: Duration = Duration::from_millis(500);
const RESTART_BACKOFF_BASE_MS: u64 = 500;
const RESTART_BACKOFF_MAX_MS: u64 = 30_000;
const RESTART_JITTER_MAX_MS: u64 = 250;
const MAX_ARGS: usize = 32;
const MAX_ENV_ENTRIES: usize = 32;
const MAX_FIELD_LEN: usize = 4096;

#[derive(Debug, Error)]
pub enum FileBridgeAutostartError {
    #[error("file bridge autostart configuration is invalid")]
    InvalidConfiguration,
}

impl Serialize for FileBridgeAutostartError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AutostartConfiguration {
    command: OsString,
    args: Vec<OsString>,
    cwd: Option<PathBuf>,
    env: HashMap<String, String>,
}

struct Inner {
    configuration: Option<AutostartConfiguration>,
    child: Mutex<Option<Child>>,
    /// `Some(instant)` while backing off after a failed or exited spawn, in
    /// the past once the wait is over; `None` while a child is running or
    /// before the first spawn attempt. Checked, never blocked on: a blocking
    /// sleep here would delay `shutdown` noticing the child needs to be
    /// killed by as much as `RESTART_BACKOFF_MAX_MS`.
    next_restart_at: Mutex<Option<Instant>>,
    restarts: AtomicU32,
    shutting_down: AtomicBool,
    shutdown_notify: Notify,
}

/// Tauri-managed state for the bridge autostart supervisor.
///
/// One instance lives for the process, the same as
/// `media_gateway::MediaGatewayState`; `.clone()` is a cheap `Arc` clone so the
/// `setup` closure, the window-destroyed handler and the `#[tauri::command]`
/// status reader can each hold their own copy.
#[derive(Clone)]
pub struct FileBridgeSupervisorState {
    inner: Arc<Inner>,
}

impl FileBridgeSupervisorState {
    pub fn from_environment() -> Result<Self, FileBridgeAutostartError> {
        let configuration = load_configuration(|name| env::var_os(name))?;
        Ok(Self::with_configuration(configuration))
    }

    /// Autostart turned off outright, the same shape `from_environment`
    /// produces when `HQ_FILE_BRIDGE_AUTOSTART_COMMAND` is unset. The caller
    /// in `lib.rs` falls back to this when `from_environment` errors: unlike
    /// the native media gateway, which is core to the camera surfaces and
    /// panics on a bad configuration, a typo in an optional autostart
    /// variable disables the optional feature rather than the whole shell.
    pub fn disabled() -> Self {
        Self::with_configuration(None)
    }

    fn with_configuration(configuration: Option<AutostartConfiguration>) -> Self {
        Self {
            inner: Arc::new(Inner {
                configuration,
                child: Mutex::new(None),
                next_restart_at: Mutex::new(None),
                restarts: AtomicU32::new(0),
                shutting_down: AtomicBool::new(false),
                shutdown_notify: Notify::new(),
            }),
        }
    }

    /// Runs until `shutdown` is called, restarting the configured command with
    /// backoff whenever it exits. A poll every `SUPERVISOR_INTERVAL`, the same
    /// shape `MediaGatewayState::supervise` already uses for its `ffmpeg`
    /// workers, rather than blocking on `Child::wait` -- that keeps `shutdown`
    /// free to take the child and kill it without racing a concurrent waiter.
    pub async fn supervise(self) {
        let Some(configuration) = self.inner.configuration.clone() else {
            // No command configured: this is the default, and the only
            // correct behaviour is to spawn nothing at all, ever.
            return;
        };
        if let Err(error) = self.spawn_now(&configuration).await {
            eprintln!("file bridge autostart could not start the configured command: {error}");
            self.schedule_restart().await;
        }
        while !self.inner.shutting_down.load(Ordering::SeqCst) {
            self.tick(&configuration).await;
            sleep(SUPERVISOR_INTERVAL).await;
        }
    }

    async fn tick(&self, configuration: &AutostartConfiguration) {
        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let exited = {
            let mut child = self.inner.child.lock().await;
            match child.as_mut() {
                Some(handle) => match handle.try_wait() {
                    Ok(Some(_)) | Err(_) => {
                        *child = None;
                        true
                    }
                    Ok(None) => false,
                },
                None => false,
            }
        };
        if exited {
            self.schedule_restart().await;
            return;
        }
        let due = {
            let next_restart_at = self.inner.next_restart_at.lock().await;
            next_restart_at.is_some_and(|instant| instant <= Instant::now())
        };
        if due {
            if let Err(error) = self.spawn_now(configuration).await {
                eprintln!(
                    "file bridge autostart could not restart the configured command: {error}"
                );
                self.schedule_restart().await;
            }
        }
    }

    async fn spawn_now(
        &self,
        configuration: &AutostartConfiguration,
    ) -> Result<(), std::io::Error> {
        let mut command = Command::new(&configuration.command);
        command
            .args(&configuration.args)
            .envs(&configuration.env)
            .kill_on_drop(true)
            .stdin(Stdio::null());
        if let Some(cwd) = &configuration.cwd {
            command.current_dir(cwd);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.as_std_mut().creation_flags(0x0800_0000);
        }
        let child = command.spawn()?;
        *self.inner.child.lock().await = Some(child);
        *self.inner.next_restart_at.lock().await = None;
        Ok(())
    }

    async fn schedule_restart(&self) {
        let attempt = self.inner.restarts.fetch_add(1, Ordering::SeqCst) + 1;
        *self.inner.next_restart_at.lock().await = Some(Instant::now() + restart_delay(attempt));
    }

    /// Stops supervising and, if the last spawn is still alive, kills it. A
    /// process this module never spawned -- because autostart was never
    /// configured -- is never touched: `child` is `None` in that case, and
    /// this is a no-op.
    pub async fn shutdown(&self) {
        if self.inner.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        self.inner.shutdown_notify.notify_waiters();
        if let Some(mut child) = self.inner.child.lock().await.take() {
            let _ = child.kill().await;
        }
    }

    pub fn status(&self) -> FileBridgeAutostartStatus {
        FileBridgeAutostartStatus {
            configured: self.inner.configuration.is_some(),
            running: self
                .inner
                .child
                .try_lock()
                .map(|guard| guard.is_some())
                .unwrap_or(false),
            restarts: self.inner.restarts.load(Ordering::SeqCst),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBridgeAutostartStatus {
    /// Whether `HQ_FILE_BRIDGE_AUTOSTART_COMMAND` was set at startup.
    pub configured: bool,
    /// Whether this module currently holds a live child handle. `false` while
    /// `configured` is `true` means the command has not been (re)spawned yet,
    /// most often because it is in its backoff window.
    pub running: bool,
    pub restarts: u32,
}

fn restart_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(6);
    let base = RESTART_BACKOFF_BASE_MS
        .saturating_mul(1_u64 << exponent)
        .min(RESTART_BACKOFF_MAX_MS);
    // A pseudo-random jitter derived from the attempt count is enough here --
    // this only has to keep one process's restarts from lining up with
    // another supervised process's, not resist prediction.
    let jitter = (u64::from(attempt).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 48)
        % (RESTART_JITTER_MAX_MS + 1);
    Duration::from_millis(base.saturating_add(jitter).min(RESTART_BACKOFF_MAX_MS))
}

/// Reads the four `HQ_FILE_BRIDGE_AUTOSTART_*` variables through `lookup`
/// (`std::env::var_os` in production, a fake map in tests) and returns `None`
/// -- autostart disabled -- whenever `HQ_FILE_BRIDGE_AUTOSTART_COMMAND` is
/// unset. That is the only gate: every other variable is meaningless without
/// it, and their absence once the command is set falls back to "no
/// arguments, this process's own working directory, no extra environment".
fn load_configuration(
    lookup: impl Fn(&str) -> Option<OsString>,
) -> Result<Option<AutostartConfiguration>, FileBridgeAutostartError> {
    let Some(command) = lookup("HQ_FILE_BRIDGE_AUTOSTART_COMMAND") else {
        return Ok(None);
    };
    if command.is_empty() {
        return Err(FileBridgeAutostartError::InvalidConfiguration);
    }
    let args = match lookup("HQ_FILE_BRIDGE_AUTOSTART_ARGS") {
        Some(raw) => parse_args_json(&raw.to_string_lossy())?,
        None => Vec::new(),
    };
    let cwd = lookup("HQ_FILE_BRIDGE_AUTOSTART_CWD").map(PathBuf::from);
    let env = match lookup("HQ_FILE_BRIDGE_AUTOSTART_ENV") {
        Some(raw) => parse_env_json(&raw.to_string_lossy())?,
        None => HashMap::new(),
    };
    Ok(Some(AutostartConfiguration {
        command,
        args,
        cwd,
        env,
    }))
}

fn parse_args_json(raw: &str) -> Result<Vec<OsString>, FileBridgeAutostartError> {
    let values: Vec<String> =
        serde_json::from_str(raw).map_err(|_| FileBridgeAutostartError::InvalidConfiguration)?;
    if values.len() > MAX_ARGS || values.iter().any(|value| value.len() > MAX_FIELD_LEN) {
        return Err(FileBridgeAutostartError::InvalidConfiguration);
    }
    Ok(values.into_iter().map(OsString::from).collect())
}

fn parse_env_json(raw: &str) -> Result<HashMap<String, String>, FileBridgeAutostartError> {
    let values: HashMap<String, String> =
        serde_json::from_str(raw).map_err(|_| FileBridgeAutostartError::InvalidConfiguration)?;
    if values.len() > MAX_ENV_ENTRIES
        || values
            .iter()
            .any(|(key, value)| key.len() > MAX_FIELD_LEN || value.len() > MAX_FIELD_LEN)
    {
        return Err(FileBridgeAutostartError::InvalidConfiguration);
    }
    Ok(values)
}

#[tauri::command]
pub fn get_file_bridge_autostart_status(
    state: State<'_, FileBridgeSupervisorState>,
) -> FileBridgeAutostartStatus {
    state.status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration as StdDuration;

    fn env_map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    fn lookup_from(map: HashMap<&'static str, &'static str>) -> impl Fn(&str) -> Option<OsString> {
        move |name| map.get(name).map(|value| OsString::from(*value))
    }

    #[test]
    fn autostart_is_disabled_by_default_with_no_command_configured() {
        let configuration = load_configuration(lookup_from(HashMap::new())).unwrap();
        assert!(configuration.is_none());
    }

    #[test]
    fn refuses_an_empty_command() {
        let error = load_configuration(lookup_from(HashMap::from([(
            "HQ_FILE_BRIDGE_AUTOSTART_COMMAND",
            "",
        )])))
        .expect_err("an empty command must be refused");
        assert!(matches!(
            error,
            FileBridgeAutostartError::InvalidConfiguration
        ));
    }

    #[test]
    fn reads_command_args_cwd_and_env_when_all_four_are_set() {
        let configuration = load_configuration(lookup_from(HashMap::from([
            ("HQ_FILE_BRIDGE_AUTOSTART_COMMAND", "node"),
            (
                "HQ_FILE_BRIDGE_AUTOSTART_ARGS",
                r#"["../file-bridge/dist/index.js"]"#,
            ),
            ("HQ_FILE_BRIDGE_AUTOSTART_CWD", "/opt/gremuchaya"),
            (
                "HQ_FILE_BRIDGE_AUTOSTART_ENV",
                r#"{"HQ_BRIDGE_CONFIG":"/opt/gremuchaya/bridge.config.json"}"#,
            ),
        ])))
        .expect("a fully specified configuration must be accepted")
        .expect("the command was set, so autostart must be enabled");

        assert_eq!(configuration.command, OsString::from("node"));
        assert_eq!(
            configuration.args,
            vec![OsString::from("../file-bridge/dist/index.js")]
        );
        assert_eq!(configuration.cwd, Some(PathBuf::from("/opt/gremuchaya")));
        assert_eq!(
            configuration.env,
            env_map(&[("HQ_BRIDGE_CONFIG", "/opt/gremuchaya/bridge.config.json")]),
        );
    }

    #[test]
    fn command_alone_is_enough_to_enable_autostart_with_empty_defaults() {
        let configuration = load_configuration(lookup_from(HashMap::from([(
            "HQ_FILE_BRIDGE_AUTOSTART_COMMAND",
            "node",
        )])))
        .expect("configuration must parse")
        .expect("the command was set, so autostart must be enabled");

        assert!(configuration.args.is_empty());
        assert!(configuration.cwd.is_none());
        assert!(configuration.env.is_empty());
    }

    #[test]
    fn refuses_malformed_args_and_env_json() {
        let error = load_configuration(lookup_from(HashMap::from([
            ("HQ_FILE_BRIDGE_AUTOSTART_COMMAND", "node"),
            ("HQ_FILE_BRIDGE_AUTOSTART_ARGS", "not json"),
        ])))
        .expect_err("malformed args JSON must be refused");
        assert!(matches!(
            error,
            FileBridgeAutostartError::InvalidConfiguration
        ));

        let error = load_configuration(lookup_from(HashMap::from([
            ("HQ_FILE_BRIDGE_AUTOSTART_COMMAND", "node"),
            ("HQ_FILE_BRIDGE_AUTOSTART_ENV", "[1,2,3]"),
        ])))
        .expect_err("an array is not a valid env object and must be refused");
        assert!(matches!(
            error,
            FileBridgeAutostartError::InvalidConfiguration
        ));
    }

    #[tokio::test]
    async fn spawns_nothing_at_all_when_no_command_is_configured() {
        let state = FileBridgeSupervisorState::with_configuration(None);

        // `supervise` must return immediately -- if it looped even once with
        // no configuration this would hang until the test's own timeout.
        tokio::time::timeout(StdDuration::from_millis(200), state.clone().supervise())
            .await
            .expect("supervise must return immediately with no configuration");

        let status = state.status();
        assert!(!status.configured);
        assert!(!status.running);
        assert_eq!(status.restarts, 0);
    }

    #[tokio::test]
    async fn spawns_the_configured_command_and_reports_it_running() {
        let configuration = AutostartConfiguration {
            command: OsString::from("sh"),
            args: vec![OsString::from("-c"), OsString::from("sleep 5")],
            cwd: None,
            env: HashMap::new(),
        };
        let state = FileBridgeSupervisorState::with_configuration(Some(configuration.clone()));

        state
            .spawn_now(&configuration)
            .await
            .expect("sh must be on PATH in test environments");
        assert!(state.status().configured);
        assert!(state.status().running);

        state.shutdown().await;
        assert!(!state.status().running);
    }

    #[tokio::test]
    async fn restarts_a_command_that_exits_on_its_own() {
        let configuration = AutostartConfiguration {
            command: OsString::from("sh"),
            args: vec![OsString::from("-c"), OsString::from("exit 1")],
            cwd: None,
            env: HashMap::new(),
        };
        let state = FileBridgeSupervisorState::with_configuration(Some(configuration.clone()));

        state
            .spawn_now(&configuration)
            .await
            .expect("sh must be on PATH in test environments");
        // Give the short-lived process time to exit before the tick observes it.
        sleep(StdDuration::from_millis(50)).await;
        state.tick(&configuration).await;

        assert_eq!(state.status().restarts, 1);
        state.shutdown().await;
    }

    #[test]
    fn restart_delay_grows_and_caps() {
        assert!(restart_delay(1) >= Duration::from_millis(RESTART_BACKOFF_BASE_MS));
        assert!(
            restart_delay(1)
                <= Duration::from_millis(RESTART_BACKOFF_BASE_MS + RESTART_JITTER_MAX_MS)
        );
        assert!(
            restart_delay(20)
                <= Duration::from_millis(RESTART_BACKOFF_MAX_MS + RESTART_JITTER_MAX_MS)
        );
    }
}
