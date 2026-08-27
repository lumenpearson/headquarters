//! Host window profile: which Windows generation the shell runs on and the
//! native corner treatment that follows from it (F13, R18/R24).
//!
//! The application layer decides whether to draw its own title bar. This module
//! only reports the host and applies the DWM corner preference it is asked for.

use serde::Serialize;
use tauri::WebviewWindow;

/// Windows 11 shipped as build 22000 (21H2); every 10.0 build below it is
/// Windows 10.
const FIRST_WINDOWS_11_BUILD: u32 = 22000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HostWindowFamily {
    Win11,
    Win10,
    Legacy,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWindowProfile {
    pub family: HostWindowFamily,
    pub build_number: Option<u32>,
    pub rounded: bool,
}

/// The NT kernel version as reported by the host. `minor` is not carried
/// because no family boundary depends on it: 10.x is decided by build, and
/// everything before 10 is legacy regardless of minor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct KernelVersion {
    major: u32,
    build: u32,
}

fn classify(version: Option<KernelVersion>) -> HostWindowProfile {
    let family = match version {
        None => HostWindowFamily::Other,
        Some(KernelVersion { major, build })
            if major > 10 || (major == 10 && build >= FIRST_WINDOWS_11_BUILD) =>
        {
            HostWindowFamily::Win11
        }
        Some(KernelVersion { major: 10, .. }) => HostWindowFamily::Win10,
        Some(_) => HostWindowFamily::Legacy,
    };
    HostWindowProfile {
        family,
        build_number: version.map(|version| version.build),
        rounded: family == HostWindowFamily::Win11,
    }
}

/// Reads the kernel version through `RtlGetVersion` from ntdll.
///
/// `GetVersionExW` and `VerifyVersionInfoW` report at most the version the
/// executable's `supportedOS` manifest admits, so they cannot tell Windows 10
/// from 11 unless the manifest is kept current. `RtlGetVersion` answers with the
/// real kernel version regardless of the manifest; this is the approach the
/// `windows-version` crate takes and the one Microsoft documents for callers
/// that need the true build number.
#[cfg(windows)]
fn kernel_version() -> Option<KernelVersion> {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::Foundation::STATUS_SUCCESS;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;

    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is a writable OSVERSIONINFOW whose size field is set, which
    // is the only precondition RtlGetVersion documents.
    let status = unsafe { RtlGetVersion(&mut info) };
    (status == STATUS_SUCCESS).then_some(KernelVersion {
        major: info.dwMajorVersion,
        build: info.dwBuildNumber,
    })
}

#[cfg(not(windows))]
fn kernel_version() -> Option<KernelVersion> {
    None
}

#[cfg(windows)]
fn corner_preference(
    rounded: bool,
) -> windows_sys::Win32::Graphics::Dwm::DWM_WINDOW_CORNER_PREFERENCE {
    use windows_sys::Win32::Graphics::Dwm::{DWMWCP_DONOTROUND, DWMWCP_ROUND};

    if rounded {
        DWMWCP_ROUND
    } else {
        DWMWCP_DONOTROUND
    }
}

#[cfg(windows)]
pub(crate) fn apply_corners(window: &WebviewWindow, rounded: bool) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
    };

    if classify(kernel_version()).family != HostWindowFamily::Win11 {
        // DWMWA_WINDOW_CORNER_PREFERENCE exists from build 22000. Earlier DWM
        // builds reject it with E_INVALIDARG and draw square corners anyway, so
        // there is nothing to apply and nothing to report.
        return Ok(());
    }
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let preference = corner_preference(rounded);
    // SAFETY: `hwnd` is the handle tauri holds for a window that is alive for the
    // duration of this command; the attribute buffer is a single i32 that
    // outlives the call, and its size is passed alongside it.
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            std::ptr::from_ref(&preference).cast(),
            std::mem::size_of_val(&preference) as u32,
        )
    };
    if result < 0 {
        Err(format!(
            "DwmSetWindowAttribute failed: HRESULT {result:#010x}"
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn apply_corners(_window: &WebviewWindow, _rounded: bool) -> Result<(), String> {
    // Corner preferences are a DWM concept; other hosts keep their native chrome.
    Ok(())
}

#[tauri::command]
pub fn host_window_profile() -> HostWindowProfile {
    classify(kernel_version())
}

#[tauri::command]
pub fn apply_window_corners(window: WebviewWindow, rounded: bool) -> Result<(), String> {
    apply_corners(&window, rounded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(major: u32, build: u32) -> Option<KernelVersion> {
        Some(KernelVersion { major, build })
    }

    #[test]
    fn build_22000_and_above_is_windows_11_and_rounded() {
        for build in [22000, 22621, 22631, 26100] {
            let profile = classify(version(10, build));
            assert_eq!(profile.family, HostWindowFamily::Win11, "build {build}");
            assert_eq!(profile.build_number, Some(build));
            assert!(profile.rounded, "build {build}");
        }
    }

    #[test]
    fn nt10_builds_below_22000_are_windows_10_and_square() {
        for build in [10240, 17763, 19045, 21999] {
            let profile = classify(version(10, build));
            assert_eq!(profile.family, HostWindowFamily::Win10, "build {build}");
            assert_eq!(profile.build_number, Some(build));
            assert!(!profile.rounded, "build {build}");
        }
    }

    #[test]
    fn older_nt_majors_are_legacy_whatever_the_build() {
        for (major, build) in [(6, 9600), (6, 7601), (5, 2600)] {
            let profile = classify(version(major, build));
            assert_eq!(
                profile.family,
                HostWindowFamily::Legacy,
                "{major}.x build {build}"
            );
            assert_eq!(profile.build_number, Some(build));
            assert!(!profile.rounded);
        }
    }

    #[test]
    fn a_future_major_is_treated_as_the_newest_known_family() {
        assert_eq!(classify(version(11, 1)).family, HostWindowFamily::Win11);
    }

    #[test]
    fn an_unreadable_or_non_windows_host_is_other() {
        assert_eq!(
            classify(None),
            HostWindowProfile {
                family: HostWindowFamily::Other,
                build_number: None,
                rounded: false,
            }
        );
    }

    #[test]
    fn serializes_to_the_camel_case_payload_the_frontend_reads() {
        let win11 = serde_json::to_string(&classify(version(10, 22631))).unwrap();
        assert_eq!(
            win11,
            r#"{"family":"win11","buildNumber":22631,"rounded":true}"#
        );
        let other = serde_json::to_string(&classify(None)).unwrap();
        assert_eq!(
            other,
            r#"{"family":"other","buildNumber":null,"rounded":false}"#
        );
        let legacy = serde_json::to_string(&classify(version(6, 9600))).unwrap();
        assert_eq!(
            legacy,
            r#"{"family":"legacy","buildNumber":9600,"rounded":false}"#
        );
    }

    #[cfg(windows)]
    #[test]
    fn rtl_get_version_reports_an_nt10_or_newer_kernel_on_the_build_host() {
        let version = kernel_version().expect("RtlGetVersion should succeed on Windows");
        assert!(version.major >= 10, "unexpected major {}", version.major);
        assert!(version.build >= 10240, "unexpected build {}", version.build);
    }

    #[cfg(windows)]
    #[test]
    fn corner_preference_maps_rounded_to_round_and_square_to_do_not_round() {
        use windows_sys::Win32::Graphics::Dwm::{DWMWCP_DONOTROUND, DWMWCP_ROUND};

        assert_eq!(corner_preference(true), DWMWCP_ROUND);
        assert_eq!(corner_preference(false), DWMWCP_DONOTROUND);
    }
}
