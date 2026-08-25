use serde::Serialize;
use tauri::{
    AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
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

/// The rectangle a monitor occupies on the virtual desktop, in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MonitorGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl From<&Monitor> for MonitorGeometry {
    fn from(monitor: &Monitor) -> Self {
        Self {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        }
    }
}

/// A monitor is the primary one when it occupies the primary monitor's
/// rectangle. The runtime may report `None` or one shared generic name for
/// several displays, so the name stays metadata and never decides identity.
fn is_primary_monitor(candidate: MonitorGeometry, primary: Option<MonitorGeometry>) -> bool {
    primary == Some(candidate)
}

#[tauri::command]
pub fn list_monitors(window: WebviewWindow) -> Result<Vec<NativeMonitor>, String> {
    let primary = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .as_ref()
        .map(MonitorGeometry::from);
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    Ok(monitors
        .into_iter()
        .map(|monitor| {
            let geometry = MonitorGeometry::from(&monitor);
            NativeMonitor {
                name: monitor.name().cloned(),
                x: geometry.x,
                y: geometry.y,
                width: geometry.width,
                height: geometry.height,
                scale_factor: monitor.scale_factor(),
                primary: is_primary_monitor(geometry, primary),
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry(x: i32, y: i32, width: u32, height: u32) -> MonitorGeometry {
        MonitorGeometry {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn nothing_is_primary_when_the_runtime_reports_no_primary_monitor() {
        assert!(!is_primary_monitor(geometry(0, 0, 1920, 1080), None));
    }

    #[test]
    fn the_monitor_occupying_the_primary_rectangle_is_primary() {
        let primary = Some(geometry(0, 0, 2560, 1440));
        assert!(is_primary_monitor(geometry(0, 0, 2560, 1440), primary));
    }

    #[test]
    fn a_monitor_at_another_position_or_size_is_not_primary() {
        let primary = Some(geometry(0, 0, 1920, 1080));
        assert!(!is_primary_monitor(geometry(1920, 0, 1920, 1080), primary));
        assert!(!is_primary_monitor(geometry(-1920, 0, 1920, 1080), primary));
        assert!(!is_primary_monitor(geometry(0, 0, 2560, 1440), primary));
    }

    #[test]
    fn identical_panels_with_the_same_name_are_told_apart_by_geometry() {
        // Two identical panels report the same generic name (or `None`) to the
        // runtime; only one of them sits at the primary rectangle.
        let left = geometry(0, 0, 1920, 1080);
        let right = geometry(1920, 0, 1920, 1080);
        let primary = Some(left);
        assert!(is_primary_monitor(left, primary));
        assert!(!is_primary_monitor(right, primary));
    }
}
