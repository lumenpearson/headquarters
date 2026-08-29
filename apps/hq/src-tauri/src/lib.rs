mod control_plane_proxy;
mod file_bridge_supervisor;
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

    // A bad `HQ_FILE_BRIDGE_AUTOSTART_*` value disables autostart rather than
    // failing the shell: the bridge is optional (ADR-0003), so a typo in an
    // optional variable must not take the rest of the app down with it.
    let file_bridge = file_bridge_supervisor::FileBridgeSupervisorState::from_environment()
        .unwrap_or_else(|error| {
            eprintln!("file bridge autostart is misconfigured and has been disabled: {error}");
            file_bridge_supervisor::FileBridgeSupervisorState::disabled()
        });
    let file_bridge_supervisor = file_bridge.clone();

    tauri::Builder::default()
        .manage(native_fs::NativeFsState::from_environment())
        .manage(native_fs::NativeWatchState::default())
        .manage(control_plane_proxy::ControlPlaneProxyState::new())
        .manage(file_bridge)
        .manage(media_gateway)
        .setup(move |app| {
            tauri::async_runtime::spawn(async move {
                if media_gateway_server.serve().await.is_err() {
                    eprintln!("loopback media gateway stopped unexpectedly");
                }
            });
            tauri::async_runtime::spawn(media_gateway_supervisor.supervise());
            tauri::async_runtime::spawn(file_bridge_supervisor.supervise());
            // The control window is created hidden and the frontend shows it
            // once the document has fully loaded, so a cold start never paints
            // a half-loaded page. If the frontend fails before reaching that
            // call, the window must still appear rather than leave the process
            // running invisibly with no way to close it.
            if let Some(window) = app.get_webview_window("control") {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    // An unreadable visibility errs toward showing: `show` on a
                    // window that is already visible is a no-op, while skipping
                    // it on a hidden one leaves the process without a window.
                    if !window.is_visible().unwrap_or(false) {
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
                let file_bridge = window
                    .state::<file_bridge_supervisor::FileBridgeSupervisorState>()
                    .inner()
                    .clone();
                tauri::async_runtime::spawn(async move {
                    media_gateway.shutdown().await;
                });
                tauri::async_runtime::spawn(async move {
                    file_bridge.shutdown().await;
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            control_plane_proxy::control_plane_http_request,
            file_bridge_supervisor::get_file_bridge_autostart_status,
            host_profile::host_window_profile,
            host_profile::apply_window_corners,
            managed_windows::list_monitors,
            managed_windows::open_screen_window,
            managed_windows::close_managed_windows,
            media_gateway::get_media_gateway_status,
            media_gateway::start_camera_stream,
            media_gateway::stop_camera_stream,
            media_gateway::refresh_camera_stream_grant,
            native_fs::list_native_roots,
            native_fs::list_directory,
            native_fs::read_file,
            native_fs::watch_directory,
            native_fs::unwatch_directory,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Gremuchaya HQ native shell");
}
