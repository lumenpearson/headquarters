use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    env, fs,
    path::{Component, Path, PathBuf},
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
    kind: String,
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
                    kind: format!("{:?}", event.kind),
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

fn resolve_safe(root: &Path, relative_path: &str) -> Result<PathBuf, NativeFsError> {
    let relative = Path::new(relative_path);
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(NativeFsError::InvalidPath);
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        if let Component::Normal(segment) = component {
            current.push(segment);
            if fs::symlink_metadata(&current)?.file_type().is_symlink() {
                return Err(NativeFsError::SymbolicLink);
            }
        }
    }
    let canonical = current.canonicalize()?;
    if !canonical.starts_with(root) {
        return Err(NativeFsError::EscapedRoot);
    }
    Ok(canonical)
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
        assert!(matches!(
            resolve_safe(root, "../secret"),
            Err(NativeFsError::InvalidPath)
        ));
        assert!(matches!(
            resolve_safe(root, "C:/Windows"),
            Err(NativeFsError::InvalidPath)
        ));
    }
}
