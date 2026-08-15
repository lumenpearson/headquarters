mod managed_windows;
mod native_fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .manage(native_fs::NativeFsState::from_environment())
        .manage(native_fs::NativeWatchState::default())
        .invoke_handler(tauri::generate_handler![
            managed_windows::list_monitors,
            managed_windows::open_screen_window,
            managed_windows::close_managed_windows,
            native_fs::list_native_roots,
            native_fs::list_directory,
            native_fs::read_file,
            native_fs::watch_directory,
            native_fs::unwatch_directory,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Gremuchaya HQ native shell");
}
