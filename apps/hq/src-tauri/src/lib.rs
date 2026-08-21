mod managed_windows;
mod media_gateway;
mod native_fs;
pub mod protocol;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;

    let media_gateway = media_gateway::MediaGatewayState::from_environment()
        .expect("failed to initialize the loopback media gateway");
    let media_gateway_server = media_gateway.clone();
    let media_gateway_supervisor = media_gateway.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .manage(native_fs::NativeFsState::from_environment())
        .manage(native_fs::NativeWatchState::default())
        .manage(media_gateway)
        .setup(move |_| {
            tauri::async_runtime::spawn(async move {
                if media_gateway_server.serve().await.is_err() {
                    eprintln!("loopback media gateway stopped unexpectedly");
                }
            });
            tauri::async_runtime::spawn(media_gateway_supervisor.supervise());
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
