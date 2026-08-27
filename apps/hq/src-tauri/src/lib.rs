mod host_profile;
mod managed_windows;
mod media_gateway;
mod native_fs;
pub mod protocol;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;

    // `expect` would print the Debug form, which is the bare variant name; the Display
    // form is the one that says which configuration field was wrong. Both are kept:
    // every Display message here is a fixed sentence carrying no camera URL, and the
    // Debug form still holds the I/O detail behind `MediaGatewayError::Io`.
    let media_gateway =
        media_gateway::MediaGatewayState::from_environment().unwrap_or_else(|error| {
            panic!("failed to initialize the loopback media gateway: {error} ({error:?})")
        });
    let media_gateway_server = media_gateway.clone();
    let media_gateway_supervisor = media_gateway.clone();

    tauri::Builder::default()
        .manage(native_fs::NativeFsState::from_environment())
        .manage(native_fs::NativeWatchState::default())
        .manage(media_gateway)
        .setup(move |app| {
            tauri::async_runtime::spawn(async move {
                if media_gateway_server.serve().await.is_err() {
                    eprintln!("loopback media gateway stopped unexpectedly");
                }
            });
            tauri::async_runtime::spawn(media_gateway_supervisor.supervise());
            // The control window is created hidden and the frontend shows it
            // once the document has fully loaded, so a cold start never paints
            // a half-loaded page. If the frontend fails before reaching that
            // call, the window must still appear rather than leave the process
            // running invisibly with no way to close it.
            if let Some(window) = app.get_webview_window("control") {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "control" && matches!(event, tauri::WindowEvent::Destroyed) {
                let media_gateway = window
                    .state::<media_gateway::MediaGatewayState>()
                    .inner()
                    .clone();
                tauri::async_runtime::spawn(async move {
                    media_gateway.shutdown().await;
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            host_profile::host_window_profile,
            host_profile::apply_window_corners,
            managed_windows::list_monitors,
            managed_windows::open_screen_window,
            managed_windows::close_managed_windows,
            media_gateway::get_media_gateway_status,
            media_gateway::start_camera_stream,
            media_gateway::stop_camera_stream,
            native_fs::list_native_roots,
            native_fs::list_directory,
            native_fs::read_file,
            native_fs::watch_directory,
            native_fs::unwatch_directory,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Gremuchaya HQ native shell");
}
