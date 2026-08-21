use serde::Serialize;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const SCREEN_IDS: &[&str] = &[
    "hwan-main",
    "hwan-map",
    "hwan-comms",
    "wall-center",
    "wall-left",
    "wall-right",
    "kirillov-desk",
    "interrogation-video",
    "interrogation-audio",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMonitor {
    name: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
    primary: bool,
}

#[tauri::command]
pub fn list_monitors(window: WebviewWindow) -> Result<Vec<NativeMonitor>, String> {
    let primary = window
        .primary_monitor()
        .map_err(|error| error.to_string())?;
    let primary_name = primary.as_ref().and_then(|monitor| monitor.name().cloned());
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    Ok(monitors
        .into_iter()
        .map(|monitor| NativeMonitor {
            name: monitor.name().cloned(),
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
            scale_factor: monitor.scale_factor(),
            primary: monitor.name() == primary_name.as_ref(),
        })
        .collect())
}

#[tauri::command]
pub fn open_screen_window(
    app: AppHandle,
    screen_id: String,
    monitor_index: usize,
    fullscreen: bool,
) -> Result<(), String> {
    if !SCREEN_IDS.contains(&screen_id.as_str()) {
        return Err("unknown screen id".to_owned());
    }
    let label = format!("screen-{screen_id}");
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let control = app
        .get_webview_window("control")
        .ok_or_else(|| "control window is unavailable".to_owned())?;
    let monitors = control
        .available_monitors()
        .map_err(|error| error.to_string())?;
    let monitor = monitors
        .get(monitor_index)
        .ok_or_else(|| "monitor index is unavailable".to_owned())?;
    let route = format!("screen/{screen_id}/index.html");
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(route.into()))
        .title(format!("HQ / {screen_id}"))
        .decorations(false)
        .build()
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            monitor.position().x,
            monitor.position().y,
        ))
        .map_err(|error| error.to_string())?;
    window
        .set_size(PhysicalSize::new(
            monitor.size().width,
            monitor.size().height,
        ))
        .map_err(|error| error.to_string())?;
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn close_managed_windows(app: AppHandle) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        if label.starts_with("screen-") || label.starts_with("wall-") || label.starts_with("scene-")
        {
            window.close().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
