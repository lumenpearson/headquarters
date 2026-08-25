use notify::{event::ModifyKind, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NativeFsError {
    #[error("native filesystem root is not registered")]
    UnknownRoot,
    #[error("path traversal and absolute paths are forbidden")]
    InvalidPath,
    #[error("symbolic links are not exposed")]
    SymbolicLink,
    #[error("path escapes the registered root")]
    EscapedRoot,
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("watch error: {0}")]
    Watch(#[from] notify::Error),
    #[error("watch state is unavailable")]
    WatchState,
}

impl Serialize for NativeFsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRoot {
    pub index: usize,
    pub label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: &'static str,
    pub byte_size: Option<u64>,
    pub modified_at_ms: Option<u128>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWatchEvent {
    watcher_id: String,
    kind: &'static str,
    relative_paths: Vec<String>,
}

pub struct NativeFsState {
    roots: Vec<PathBuf>,
}

impl NativeFsState {
    pub fn from_environment() -> Self {
        let roots = env::var_os("HQ_NATIVE_ROOTS")
            .map(|value| {
                env::split_paths(&value)
                    .filter_map(|path| path.canonicalize().ok())
                    .collect()
            })
            .unwrap_or_default();
        Self { roots }
    }

    fn root(&self, index: usize) -> Result<&Path, NativeFsError> {
        self.roots
            .get(index)
            .map(PathBuf::as_path)
            .ok_or(NativeFsError::UnknownRoot)
    }
}

pub struct NativeWatchState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
    sequence: AtomicU64,
}

impl Default for NativeWatchState {
    fn default() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
        }
    }
}

#[tauri::command]
pub fn list_native_roots(state: State<'_, NativeFsState>) -> Vec<NativeRoot> {
    state
        .roots
        .iter()
        .enumerate()
        .map(|(index, root)| NativeRoot {
            index,
            label: root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("LOCAL ROOT")
                .to_owned(),
        })
        .collect()
}

#[tauri::command]
pub fn list_directory(
    state: State<'_, NativeFsState>,
    root_index: usize,
    relative_path: String,
) -> Result<Vec<NativeEntry>, NativeFsError> {
    let root = state.root(root_index)?;
    let target = resolve_safe(root, &relative_path)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(target)? {
        let item = item?;
        let file_type = item.file_type()?;
        if file_type.is_symlink() || (!file_type.is_file() && !file_type.is_dir()) {
            continue;
        }
        let metadata = item.metadata()?;
        let item_path = item.path();
        let relative = item_path
            .strip_prefix(root)
            .map_err(|_| NativeFsError::EscapedRoot)?;
        entries.push(NativeEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            relative_path: slash_path(relative),
            kind: if file_type.is_dir() {
                "directory"
            } else {
                "file"
            },
            byte_size: file_type.is_file().then_some(metadata.len()),
            modified_at_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis()),
        });
    }
    entries.sort_by(|left, right| {
        left.kind
            .cmp(right.kind)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

#[tauri::command]
pub fn read_file(
    state: State<'_, NativeFsState>,
    root_index: usize,
    relative_path: String,
) -> Result<Vec<u8>, NativeFsError> {
    let root = state.root(root_index)?;
    let target = resolve_safe(root, &relative_path)?;
    if !target.is_file() {
        return Err(NativeFsError::InvalidPath);
    }
    Ok(fs::read(target)?)
}

#[tauri::command]
pub fn watch_directory(
    app: AppHandle,
    fs_state: State<'_, NativeFsState>,
    watch_state: State<'_, NativeWatchState>,
    root_index: usize,
    relative_path: String,
) -> Result<String, NativeFsError> {
    let root = fs_state.root(root_index)?.to_path_buf();
    let target = resolve_safe(&root, &relative_path)?;
    let watcher_id = format!(
        "watch-{}",
        watch_state.sequence.fetch_add(1, Ordering::Relaxed)
    );
    let emitted_id = watcher_id.clone();
    let mut watcher =
        notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            if let Ok(event) = result {
                let relative_paths = event
                    .paths
                    .iter()
                    .filter_map(|path| path.strip_prefix(&root).ok())
                    .map(slash_path)
                    .collect();
                let payload = NativeWatchEvent {
                    watcher_id: emitted_id.clone(),
                    kind: watch_event_kind(&event.kind),
                    relative_paths,
                };
                let _ = app.emit("hq:file-event", payload);
            }
        })?;
    watcher.watch(&target, RecursiveMode::Recursive)?;
    watch_state
        .watchers
        .lock()
        .map_err(|_| NativeFsError::WatchState)?
        .insert(watcher_id.clone(), watcher);
    Ok(watcher_id)
}

#[tauri::command]
pub fn unwatch_directory(
    state: State<'_, NativeWatchState>,
    watcher_id: String,
) -> Result<bool, NativeFsError> {
    Ok(state
        .watchers
        .lock()
        .map_err(|_| NativeFsError::WatchState)?
        .remove(&watcher_id)
        .is_some())
}

/// Resolves a caller-supplied relative path inside `root`.
///
/// Segment classification is done on the string rather than through
/// `Path::components`, because that classification is host-dependent: a Linux
/// build reads `C:/Windows` and `..\secret` as ordinary file names, so a guard
/// built on it would silently stop guarding anywhere except Windows.
fn resolve_safe(root: &Path, relative_path: &str) -> Result<PathBuf, NativeFsError> {
    let mut current = root.to_path_buf();
    for segment in safe_segments(relative_path)? {
        current.push(segment);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(NativeFsError::SymbolicLink);
        }
    }
    let canonical = current.canonicalize()?;
    if !canonical.starts_with(root) {
        return Err(NativeFsError::EscapedRoot);
    }
    Ok(canonical)
}

/// Splits a relative path into the plain descending segments it is allowed to
/// contain, rejecting anything else before a single filesystem call is made.
///
/// Both separators are treated as separators on every host, `..` is refused, and
/// a segment carrying `:` is refused because that covers drive prefixes
/// (`C:/Windows`, `C:relative`) and NTFS alternate data streams alike.
fn safe_segments(relative_path: &str) -> Result<Vec<&str>, NativeFsError> {
    if relative_path.starts_with('/') || relative_path.starts_with('\\') {
        return Err(NativeFsError::InvalidPath);
    }
    let mut segments = Vec::new();
    for segment in relative_path.split(['/', '\\']) {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." || segment.contains(':') {
            return Err(NativeFsError::InvalidPath);
        }
        segments.push(segment);
    }
    Ok(segments)
}

/// Collapses notify's platform-flavoured event kinds into the stable tags a
/// screen-bus consumer can switch on. Renames get their own tag because the
/// Windows watcher reports them as a `Modify(Name)` pair, not as remove+create,
/// and a consumer that refreshes on "modified" would otherwise miss the move.
fn watch_event_kind(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "created",
        EventKind::Modify(ModifyKind::Name(_)) => "renamed",
        EventKind::Modify(_) => "modified",
        EventKind::Remove(_) => "removed",
        EventKind::Any | EventKind::Access(_) | EventKind::Other => "other",
    }
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_and_absolute_paths_before_io() {
        let root = Path::new("C:/hq");
        for candidate in [
            "../secret",
            r"..\secret",
            "nested/../../secret",
            "C:/Windows",
            r"C:\Windows",
            "C:relative",
            "/etc/passwd",
            r"\\server\share",
            "report.txt:hidden",
        ] {
            assert!(
                matches!(
                    resolve_safe(root, candidate),
                    Err(NativeFsError::InvalidPath)
                ),
                "expected {candidate} to be rejected without touching the filesystem"
            );
        }
    }

    #[test]
    fn accepts_plain_descending_segments_with_either_separator() {
        assert_eq!(safe_segments("").unwrap(), Vec::<&str>::new());
        assert_eq!(safe_segments("./cases").unwrap(), vec!["cases"]);
        assert_eq!(
            safe_segments("cases/K-01/report.txt").unwrap(),
            vec!["cases", "K-01", "report.txt"]
        );
        assert_eq!(
            safe_segments(r"cases\K-01\report.txt").unwrap(),
            vec!["cases", "K-01", "report.txt"]
        );
    }

    #[test]
    fn maps_every_notify_kind_to_a_stable_tag() {
        use notify::event::{
            AccessKind, AccessMode, CreateKind, DataChange, MetadataKind, RemoveKind, RenameMode,
        };

        assert_eq!(
            watch_event_kind(&EventKind::Create(CreateKind::Any)),
            "created"
        );
        assert_eq!(
            watch_event_kind(&EventKind::Create(CreateKind::File)),
            "created"
        );
        assert_eq!(
            watch_event_kind(&EventKind::Remove(RemoveKind::Folder)),
            "removed"
        );
        assert_eq!(
            watch_event_kind(&EventKind::Modify(ModifyKind::Any)),
            "modified"
        );
        assert_eq!(
            watch_event_kind(&EventKind::Modify(ModifyKind::Data(DataChange::Content))),
            "modified"
        );
        assert_eq!(
            watch_event_kind(&EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any))),
            "modified"
        );
        for mode in [
            RenameMode::Any,
            RenameMode::From,
            RenameMode::To,
            RenameMode::Both,
        ] {
            assert_eq!(
                watch_event_kind(&EventKind::Modify(ModifyKind::Name(mode))),
                "renamed"
            );
        }
        assert_eq!(watch_event_kind(&EventKind::Any), "other");
        assert_eq!(
            watch_event_kind(&EventKind::Access(AccessKind::Open(AccessMode::Read))),
            "other"
        );
        assert_eq!(watch_event_kind(&EventKind::Other), "other");
    }
}
