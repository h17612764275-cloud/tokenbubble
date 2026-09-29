use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

#[cfg(target_os = "macos")]
#[path = "screenshot_macos.rs"]
mod screenshot_macos;

// Local troubleshooting records contain lifecycle events only, never image data.
pub(crate) fn log_event(app: &AppHandle, event: &str) {
    let Ok(directory) = app.path().app_log_dir() else { return };
    if fs::create_dir_all(&directory).is_err() { return; }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true)
        .open(directory.join("screenshot.log"))
    {
        let _ = writeln!(file, "{} {event}", now_millis());
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowTarget {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DesktopRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

fn clip_window_targets(
    monitor: DesktopRect,
    candidates: impl IntoIterator<Item = DesktopRect>,
) -> Vec<WindowTarget> {
    candidates
        .into_iter()
        .filter_map(|candidate| {
            let left = candidate.left.max(monitor.left);
            let top = candidate.top.max(monitor.top);
            let right = candidate.right.min(monitor.right);
            let bottom = candidate.bottom.min(monitor.bottom);
            if right <= left || bottom <= top {
                return None;
            }
            Some(WindowTarget {
                x: left - monitor.left,
                y: top - monitor.top,
                width: (right - left) as u32,
                height: (bottom - top) as u32,
            })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn collect_window_targets(monitor: DesktopRect) -> Vec<WindowTarget> {
    use std::{ffi::c_void, mem::size_of};
    use windows::core::BOOL;
    use windows::Win32::{
        Foundation::{HWND, LPARAM, RECT, TRUE},
        Graphics::Dwm::{
            DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
        },
        UI::WindowsAndMessaging::{
            EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowRect,
            GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TRANSPARENT,
        },
    };

    struct Enumeration {
        current_process_id: u32,
        rects: Vec<DesktopRect>,
    }

    unsafe extern "system" fn visit_window(handle: HWND, state: LPARAM) -> BOOL {
        let enumeration = unsafe { &mut *(state.0 as *mut Enumeration) };
        if !unsafe { IsWindowVisible(handle) }.as_bool() || unsafe { IsIconic(handle) }.as_bool() {
            return TRUE;
        }

        let mut process_id = 0_u32;
        unsafe { GetWindowThreadProcessId(handle, Some(&mut process_id)) };
        if process_id == enumeration.current_process_id {
            return TRUE;
        }

        let extended_style = unsafe { GetWindowLongPtrW(handle, GWL_EXSTYLE) };
        if extended_style & WS_EX_TRANSPARENT.0 as isize != 0 {
            return TRUE;
        }

        let mut cloaked = 0_u32;
        if unsafe {
            DwmGetWindowAttribute(
                handle,
                DWMWA_CLOAKED,
                (&mut cloaked as *mut u32).cast::<c_void>(),
                size_of::<u32>() as u32,
            )
        }
        .is_ok()
            && cloaked != 0
        {
            return TRUE;
        }

        let mut class_name = [0_u16; 64];
        let class_length = unsafe { GetClassNameW(handle, &mut class_name) };
        if class_length > 0 {
            let class_name = String::from_utf16_lossy(&class_name[..class_length as usize]);
            if is_ignored_window_class(&class_name) {
                return TRUE;
            }
        }

        let mut bounds = RECT::default();
        if unsafe {
            DwmGetWindowAttribute(
                handle,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&mut bounds as *mut RECT).cast::<c_void>(),
                size_of::<RECT>() as u32,
            )
        }
        .is_err()
            && unsafe { GetWindowRect(handle, &mut bounds) }.is_err()
        {
            return TRUE;
        }

        enumeration.rects.push(DesktopRect {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
        });
        TRUE
    }

    let mut enumeration = Enumeration {
        current_process_id: std::process::id(),
        rects: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(
            Some(visit_window),
            LPARAM((&mut enumeration as *mut Enumeration) as isize),
        );
    }
    clip_window_targets(monitor, enumeration.rects)
}

#[cfg(target_os = "windows")]
fn is_ignored_window_class(class_name: &str) -> bool {
    matches!(
        class_name.to_ascii_lowercase().as_str(),
        "progman"
            | "workerw"
            | "shell_traywnd"
            | "shell_secondarytraywnd"
            | "tooltips_class32"
            | "ime"
            | "msctfime ui"
            | "sysshadow"
    )
}

#[derive(Clone)]
struct ScreenCapture {
    png: Vec<u8>,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    // On macOS the PNG is in pixels while native windows occupy screen points.
    logical_size: Option<(f64, f64)>,
    window_targets: Vec<WindowTarget>,
}

#[derive(Clone, Copy, Default)]
struct HiddenWindows {
    widget: bool,
    panel: bool,
}

#[derive(Default)]
pub(crate) struct ScreenshotManager {
    capture: Mutex<Option<ScreenCapture>>,
    hidden_windows: Mutex<Option<HiddenWindows>>,
    lifecycle_lock: Mutex<()>,
    active: AtomicBool,
    capturing: AtomicBool,
    revealed: AtomicBool,
    dialog_open: AtomicBool,
    session_id: AtomicU64,
    last_heartbeat_ms: AtomicU64,
    pins: Mutex<HashMap<String, ScreenCapture>>,
}

fn lock_current_session(
    manager: &ScreenshotManager,
    session_id: u64,
) -> Result<MutexGuard<'_, ()>, String> {
    let lifecycle = manager
        .lifecycle_lock
        .lock()
        .map_err(|_| "截图会话状态不可用".to_string())?;
    if manager.session_id.load(Ordering::Acquire) != session_id
        || !manager.active.load(Ordering::Acquire)
    {
        return Err("截图会话已结束".to_string());
    }
    Ok(lifecycle)
}

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapturePayload {
    data_url: String,
    width: u32,
    height: u32,
    session_id: u64,
    window_targets: Vec<WindowTarget>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinishPayload {
    saved_path: String,
}

pub(crate) fn default_screenshot_folder() -> PathBuf {
    #[cfg(target_os = "macos")]
    return dirs::picture_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Pictures")))
        .unwrap_or_else(|| PathBuf::from("Pictures"))
        .join("Token Bubble 截图");

    #[cfg(not(target_os = "macos"))]
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("截图")
}

fn window_is_visible(window: &WebviewWindow) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, IsWindowVisible, GA_ROOT};
        return window.hwnd().ok().is_some_and(|handle| unsafe {
            let root = GetAncestor(handle, GA_ROOT);
            IsWindowVisible(if root.0.is_null() { handle } else { root }).as_bool()
        });
    }
    #[cfg(not(target_os = "windows"))]
    window.is_visible().unwrap_or(false)
}

fn warm_screenshot_window(window: &WebviewWindow, capture: &ScreenCapture) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::{COLORREF, TRUE};
        use windows::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GetAncestor, GetWindowLongPtrW, IsWindowVisible, SetLayeredWindowAttributes,
            SetWindowLongPtrW, SetWindowPos, GA_ROOT, GWL_EXSTYLE, HWND_TOPMOST, LWA_ALPHA,
            SWP_NOACTIVATE, SWP_SHOWWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
        };
        let child = window.hwnd().map_err(|error| error.to_string())?;
        unsafe {
            let root = GetAncestor(child, GA_ROOT);
            let handle = if root.0.is_null() { child } else { root };
            let _ = DwmSetWindowAttribute(
                handle,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                std::ptr::from_ref(&TRUE).cast::<std::ffi::c_void>(),
                std::mem::size_of_val(&TRUE) as u32,
            );
            let style = GetWindowLongPtrW(handle, GWL_EXSTYLE);
            SetWindowLongPtrW(
                handle,
                GWL_EXSTYLE,
                style
                    | WS_EX_LAYERED.0 as isize
                    | WS_EX_TRANSPARENT.0 as isize
                    | WS_EX_NOACTIVATE.0 as isize,
            );
            SetLayeredWindowAttributes(handle, COLORREF(0), 1, LWA_ALPHA)
                .map_err(|error| error.to_string())?;
            // Keep the WebView logically visible and painting at a visually imperceptible alpha.
            // Alpha zero lets DWM suspend the child surface and reveal a stale background frame
            // when the window becomes opaque again.
            SetWindowPos(
                handle,
                Some(HWND_TOPMOST),
                capture.x,
                capture.y,
                capture.width as i32,
                capture.height as i32,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .map_err(|error| error.to_string())?;
            if !IsWindowVisible(handle).as_bool() {
                return Err("截图窗口未能显示".to_string());
            }
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        screenshot_macos::set_window_frame(window, capture.x as f64 - 10_000.0, capture.y as f64, 160.0, 80.0)?;
        return window.show().map_err(|error| error.to_string());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    window
        .set_position(tauri::PhysicalPosition::new(capture.x - 10_000, capture.y))
        .and_then(|_| window.set_size(tauri::PhysicalSize::new(160, 80)))
        .and_then(|_| window.show())
        .map_err(|error| error.to_string())
}

fn prepare_screenshot_window(window: &WebviewWindow, capture: &ScreenCapture) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetAncestor, SetWindowPos, GA_ROOT, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW,
        };
        let child = window.hwnd().map_err(|error| error.to_string())?;
        unsafe {
            let root = GetAncestor(child, GA_ROOT);
            let handle = if root.0.is_null() { child } else { root };
            SetWindowPos(
                handle,
                Some(HWND_TOPMOST),
                capture.x,
                capture.y,
                capture.width as i32,
                capture.height as i32,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let (width, height) = capture.logical_size.ok_or_else(|| "截图显示器尺寸无效".to_string())?;
        screenshot_macos::set_window_frame(window, capture.x as f64, capture.y as f64, width, height)?;
        return window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|error| error.to_string());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    window
        .set_position(tauri::PhysicalPosition::new(capture.x, capture.y))
        .and_then(|_| {
            window.set_size(tauri::PhysicalSize::new(capture.width, capture.height))
        })
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus())
        .map_err(|error| error.to_string())
}

fn reveal_screenshot_window(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::COLORREF;
        use windows::Win32::Graphics::Dwm::DwmFlush;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetAncestor, GetWindowLongPtrW, SetForegroundWindow, SetLayeredWindowAttributes,
            SetWindowLongPtrW, SetWindowPos, GA_ROOT, GWL_EXSTYLE, HWND_TOPMOST, LWA_ALPHA,
            SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WS_EX_NOACTIVATE,
            WS_EX_TRANSPARENT,
        };
        let child = window.hwnd().map_err(|error| error.to_string())?;
        unsafe {
            let root = GetAncestor(child, GA_ROOT);
            let handle = if root.0.is_null() { child } else { root };
            let _ = DwmFlush();
            SetLayeredWindowAttributes(handle, COLORREF(0), 255, LWA_ALPHA)
                .map_err(|error| error.to_string())?;
            let style = GetWindowLongPtrW(handle, GWL_EXSTYLE);
            SetWindowLongPtrW(
                handle,
                GWL_EXSTYLE,
                style & !(WS_EX_TRANSPARENT.0 as isize | WS_EX_NOACTIVATE.0 as isize),
            );
            SetWindowPos(
                handle,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            )
            .map_err(|error| error.to_string())?;
            let _ = SetForegroundWindow(handle);
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Ok(())
    }
}

fn repair_screenshot_interactivity(window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetAncestor, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GA_ROOT, GWL_EXSTYLE,
            SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_EX_NOACTIVATE,
            WS_EX_TRANSPARENT,
        };
        let child = window.hwnd().map_err(|error| error.to_string())?;
        unsafe {
            let root = GetAncestor(child, GA_ROOT);
            let handle = if root.0.is_null() { child } else { root };
            let style = GetWindowLongPtrW(handle, GWL_EXSTYLE);
            let interactive = style & !(WS_EX_TRANSPARENT.0 as isize | WS_EX_NOACTIVATE.0 as isize);
            if interactive != style {
                SetWindowLongPtrW(handle, GWL_EXSTYLE, interactive);
                SetWindowPos(
                    handle,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
                )
                .map_err(|error| error.to_string())?;
            }
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    Ok(())
}

fn set_screenshot_topmost(window: &WebviewWindow, topmost: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetAncestor, SetForegroundWindow, SetWindowPos, GA_ROOT, HWND_NOTOPMOST, HWND_TOPMOST,
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        };
        let child = window.hwnd().map_err(|error| error.to_string())?;
        unsafe {
            let root = GetAncestor(child, GA_ROOT);
            let handle = if root.0.is_null() { child } else { root };
            SetWindowPos(
                handle,
                Some(if topmost { HWND_TOPMOST } else { HWND_NOTOPMOST }),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            )
            .map_err(|error| error.to_string())?;
            if topmost {
                let _ = SetForegroundWindow(handle);
            }
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    window.set_always_on_top(topmost).map_err(|error| error.to_string())
}

fn set_native_visibility(window: &WebviewWindow, visible: bool) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetAncestor, ShowWindow, GA_ROOT, SW_HIDE, SW_SHOWNOACTIVATE,
        };
        if let Ok(child) = window.hwnd() {
            unsafe {
                let root = GetAncestor(child, GA_ROOT);
                let handle = if root.0.is_null() { child } else { root };
                let _ = ShowWindow(handle, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    if visible {
        let _ = window.show();
    } else {
        let _ = window.hide();
    }
}

fn emergency_cancel_screenshot_locked(app: &AppHandle, manager: &ScreenshotManager) {
    log_event(app, "screenshot session closed");
    manager.session_id.fetch_add(1, Ordering::AcqRel);
    manager.active.store(false, Ordering::Release);
    manager.capturing.store(false, Ordering::Release);
    manager.revealed.store(false, Ordering::Release);
    manager.dialog_open.store(false, Ordering::Release);
    manager.last_heartbeat_ms.store(0, Ordering::Release);
    discard_capture(manager);
    if let Some(window) = app.get_webview_window("screenshot") {
        set_native_visibility(&window, false);
    }
    let visibility = manager
        .hidden_windows
        .lock()
        .ok()
        .and_then(|mut value| value.take())
        .unwrap_or(HiddenWindows { widget: true, panel: false });
    if visibility.widget {
        if let Some(window) = app.get_webview_window("widget") {
            set_native_visibility(&window, true);
        }
    }
    if visibility.panel {
        if let Some(window) = app.get_webview_window("tray-panel") {
            set_native_visibility(&window, true);
        }
    }
}

fn cancel_current_session_if(
    app: &AppHandle,
    manager: &ScreenshotManager,
    session_id: u64,
    predicate: impl FnOnce(&ScreenshotManager) -> bool,
) -> bool {
    let _lifecycle = manager
        .lifecycle_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if manager.session_id.load(Ordering::Acquire) != session_id || !predicate(manager) {
        return false;
    }
    emergency_cancel_screenshot_locked(app, manager);
    true
}

fn should_cancel_unrevealed_session(manager: &ScreenshotManager, session_id: u64) -> bool {
    manager.session_id.load(Ordering::Acquire) == session_id
        && manager.active.load(Ordering::Acquire)
        && !manager.revealed.load(Ordering::Acquire)
}

fn start_screenshot_reveal_watchdog(app: AppHandle, session_id: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        let manager = app.state::<ScreenshotManager>();
        let _ = cancel_current_session_if(&app, &manager, session_id, |manager| {
            should_cancel_unrevealed_session(manager, session_id)
        });
    });
}

fn cancel_timed_out_session(
    app: &AppHandle,
    manager: &ScreenshotManager,
    session_id: u64,
) -> bool {
    cancel_current_session_if(app, manager, session_id, |manager| {
        let active = manager.active.load(Ordering::Acquire);
        let pending = manager
            .capture
            .lock()
            .ok()
            .is_some_and(|value| value.is_some());
        if (!active && !pending) || manager.dialog_open.load(Ordering::Acquire) {
            return false;
        }
        let last = manager.last_heartbeat_ms.load(Ordering::Acquire);
        let timeout = if active { 4_500 } else { 8_000 };
        last == 0 || now_millis().saturating_sub(last) > timeout
    })
}

fn repair_current_screenshot_if_revealed(
    app: &AppHandle,
    manager: &ScreenshotManager,
    session_id: u64,
) -> bool {
    let _lifecycle = manager
        .lifecycle_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if manager.session_id.load(Ordering::Acquire) != session_id {
        return false;
    }
    if manager.active.load(Ordering::Acquire) && manager.revealed.load(Ordering::Acquire) {
        if let Some(window) = app.get_webview_window("screenshot") {
            let _ = repair_screenshot_interactivity(&window);
        }
    }
    true
}

fn start_screenshot_watchdog(app: AppHandle, session_id: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let manager = app.state::<ScreenshotManager>();
        if manager.session_id.load(Ordering::Acquire) != session_id {
            return;
        }
        let active = manager.active.load(Ordering::Acquire);
        let pending = manager.capture.lock().ok().is_some_and(|value| value.is_some());
        if !active && !pending {
            return;
        }
        if !repair_current_screenshot_if_revealed(&app, &manager, session_id) {
            return;
        }
        if cancel_timed_out_session(&app, &manager, session_id) {
            return;
        }
    });
}

fn hide_preserved_windows(app: &AppHandle, manager: &ScreenshotManager) {
    let visibility = manager.hidden_windows.lock().ok().and_then(|value| *value);
    let Some(visibility) = visibility else { return };
    if visibility.widget {
        if let Some(window) = app.get_webview_window("widget") { let _ = window.hide(); }
    }
    if visibility.panel {
        if let Some(window) = app.get_webview_window("tray-panel") { let _ = window.hide(); }
    }
}

pub(crate) fn remove_pin(manager: &ScreenshotManager, label: &str) {
    if let Ok(mut pins) = manager.pins.lock() {
        pins.remove(label);
    }
}

pub(crate) fn discard_capture(manager: &ScreenshotManager) {
    if let Ok(mut capture) = manager.capture.lock() {
        *capture = None;
    }
}

#[tauri::command]
pub(crate) async fn begin_screenshot(app: AppHandle) -> Result<(), String> {
    log_event(&app, "screenshot requested");
    tauri::async_runtime::spawn_blocking(move || begin_screenshot_on_worker(app))
        .await
        .map_err(|error| format!("截图任务未能完成：{error}"))?
}

fn begin_screenshot_on_worker(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<ScreenshotManager>();
    crate::quick_actions::close_widget_quick_actions(app.clone())?;
    // Native visibility getters may wait for the main thread. Keep them outside
    // the lifecycle lock: main-thread cancellation also acquires that lock.
    let visibility = HiddenWindows {
        widget: app.get_webview_window("widget").as_ref().is_some_and(window_is_visible),
        panel: app.get_webview_window("tray-panel").as_ref().is_some_and(window_is_visible),
    };
    let lifecycle = manager
        .lifecycle_lock
        .lock()
        .map_err(|_| "截图会话状态不可用".to_string())?;
    let pending = manager.capture.lock().ok().is_some_and(|capture| capture.is_some());
    if manager.active.load(Ordering::Acquire) || pending || manager.capturing.load(Ordering::Acquire) {
        emergency_cancel_screenshot_locked(&app, &manager);
        return Ok(());
    }

    if let Ok(mut hidden) = manager.hidden_windows.lock() {
        *hidden = Some(visibility);
    }
    // Keep the widget visible during capture so its pixels remain in the screenshot. The live
    // window is hidden only after the full-screen overlay replaces it with those same pixels.
    if let Some(window) = app.get_webview_window("tray-panel") {
        let _ = window.hide();
    }
    let session_id = manager.session_id.fetch_add(1, Ordering::AcqRel) + 1;
    manager.capturing.store(true, Ordering::Release);
    // ScreenCaptureKit completion handlers may need the app's main queue.
    // Never keep the lifecycle lock while waiting for them.
    drop(lifecycle);
    if visibility.panel {
        std::thread::sleep(Duration::from_millis(120));
    }

    let capture = match capture_current_monitor() {
        Ok(value) => value,
        Err(error) => {
            log_event(&app, &format!("screen capture failed: {error}"));
            let was_current = cancel_current_session_if(&app, &manager, session_id, |manager| manager.capturing.load(Ordering::Acquire));
            return if was_current { Err(error) } else { Ok(()) };
        }
    };
    log_event(&app, &format!("screen captured for session {session_id}"));
    let lifecycle = manager
        .lifecycle_lock
        .lock()
        .map_err(|_| "截图会话状态不可用".to_string())?;
    if manager.session_id.load(Ordering::Acquire) != session_id || !manager.capturing.load(Ordering::Acquire) {
        return Ok(());
    }
    if let Ok(mut slot) = manager.capture.lock() {
        *slot = Some(capture.clone());
    }
    manager.capturing.store(false, Ordering::Release);
    manager.revealed.store(false, Ordering::Release);
    manager.dialog_open.store(false, Ordering::Release);
    manager.last_heartbeat_ms.store(now_millis(), Ordering::Release);
    let window = match app.get_webview_window("screenshot") {
        Some(window) => window,
        None => {
            emergency_cancel_screenshot_locked(&app, &manager);
            return Err("截图窗口不存在".to_string());
        }
    };
    // AppKit frame changes are dispatched to the main thread. Release the session
    // lock first so a main-thread command cannot wait for it while we wait for AppKit.
    drop(lifecycle);
    if let Err(error) = warm_screenshot_window(&window, &capture) {
        log_event(&app, &format!("screenshot window warm-up failed: {error}"));
        let was_current = cancel_current_session_if(&app, &manager, session_id, |_| true);
        return if was_current { Err(error) } else { Ok(()) };
    }
    log_event(&app, &format!("screenshot window ready for session {session_id}"));
    if manager.session_id.load(Ordering::Acquire) != session_id
        || manager.capture.lock().ok().is_none_or(|pending| pending.is_none())
    {
        return Ok(());
    }
    start_screenshot_watchdog(app.clone(), session_id);
    let emitter = app.clone();
    std::thread::spawn(move || {
        // The image onLoad + two animation frames are the actual paint readiness gate. Keep a
        // short native warm-up window without adding a perceptible fixed delay to every capture.
        std::thread::sleep(Duration::from_millis(48));
        let manager = emitter.state::<ScreenshotManager>();
        let pending = manager.capture.lock().ok().is_some_and(|value| value.is_some());
        if manager.session_id.load(Ordering::Acquire) == session_id && pending {
            let _ = emitter.emit_to("screenshot", "screenshot-capture-ready", session_id);
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn activate_screenshot(
    app: AppHandle,
    manager: State<'_, ScreenshotManager>,
    session_id: u64,
) -> Result<u64, String> {
    let lifecycle = manager
        .lifecycle_lock
        .lock()
        .map_err(|_| "截图会话状态不可用".to_string())?;
    if manager.session_id.load(Ordering::Acquire) != session_id {
        return Err("截图会话已结束".to_string());
    }
    if manager.active.load(Ordering::Acquire) {
        return Ok(session_id);
    }
    let capture = manager
        .capture
        .lock()
        .map_err(|_| "截图数据不可用".to_string())?
        .clone()
        .ok_or_else(|| "没有待处理的截图".to_string())?;
    let window = app
        .get_webview_window("screenshot")
        .ok_or_else(|| "截图窗口不存在".to_string())?;
    if let Err(error) = prepare_screenshot_window(&window, &capture) {
        drop(lifecycle);
        let _ = cancel_current_session_if(&app, &manager, session_id, |_| true);
        return Err(error);
    }
    manager.last_heartbeat_ms.store(now_millis(), Ordering::Release);
    manager.active.store(true, Ordering::Release);
    log_event(&app, &format!("screenshot window activated for session {session_id}"));
    drop(lifecycle);
    start_screenshot_reveal_watchdog(app, session_id);
    Ok(session_id)
}

#[tauri::command]
pub(crate) fn reveal_screenshot(
    app: AppHandle,
    manager: State<'_, ScreenshotManager>,
    session_id: u64,
) -> Result<(), String> {
    let lifecycle = manager
        .lifecycle_lock
        .lock()
        .map_err(|_| "截图会话状态不可用".to_string())?;
    if manager.session_id.load(Ordering::Acquire) != session_id
        || !manager.active.load(Ordering::Acquire)
    {
        return Err("截图会话已结束".to_string());
    }
    let window = app
        .get_webview_window("screenshot")
        .ok_or_else(|| "截图窗口不存在".to_string())?;
    if let Err(error) = reveal_screenshot_window(&window) {
        drop(lifecycle);
        let _ = cancel_current_session_if(&app, &manager, session_id, |_| true);
        return Err(error);
    }
    hide_preserved_windows(&app, &manager);
    manager.revealed.store(true, Ordering::Release);
    manager.last_heartbeat_ms.store(now_millis(), Ordering::Release);
    log_event(&app, &format!("screenshot window revealed for session {session_id}"));
    Ok(())
}

#[tauri::command]
pub(crate) fn get_screenshot_capture(
    manager: State<'_, ScreenshotManager>,
    expected_session_id: Option<u64>,
) -> Result<CapturePayload, String> {
    let session_id = manager.session_id.load(Ordering::Acquire);
    if expected_session_id.is_some_and(|expected| expected != session_id) {
        return Err("截图会话已结束".to_string());
    }
    let capture = manager
        .capture
        .lock()
        .map_err(|_| "截图数据不可用".to_string())?
        .clone()
        .ok_or_else(|| "没有待处理的截图".to_string())?;
    if manager.session_id.load(Ordering::Acquire) != session_id {
        return Err("截图会话已结束".to_string());
    }
    Ok(payload(&capture, session_id))
}

#[tauri::command]
pub(crate) fn screenshot_heartbeat(
    manager: State<'_, ScreenshotManager>,
    session_id: u64,
) -> bool {
    if manager.session_id.load(Ordering::Acquire) != session_id {
        return false;
    }
    let active = manager.active.load(Ordering::Acquire);
    let pending = manager.capture.lock().ok().is_some_and(|value| value.is_some());
    if active || pending {
        manager.last_heartbeat_ms.store(now_millis(), Ordering::Release);
        true
    } else {
        false
    }
}

#[tauri::command]
pub(crate) fn set_screenshot_dialog_mode(
    app: AppHandle,
    manager: State<'_, ScreenshotManager>,
    session_id: u64,
    open: bool,
) -> Result<(), String> {
    let _lifecycle = lock_current_session(&manager, session_id)?;
    let window = app
        .get_webview_window("screenshot")
        .ok_or_else(|| "截图窗口不存在".to_string())?;
    if open {
        manager.dialog_open.store(false, Ordering::Release);
        set_screenshot_topmost(&window, false)?;
        manager.dialog_open.store(true, Ordering::Release);
    } else {
        manager.dialog_open.store(false, Ordering::Release);
        set_screenshot_topmost(&window, true)?;
    }
    manager.last_heartbeat_ms.store(now_millis(), Ordering::Release);
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_screenshot(
    app: AppHandle,
    manager: State<'_, ScreenshotManager>,
    session_id: u64,
) -> Result<(), String> {
    let _lifecycle = lock_current_session(&manager, session_id)?;
    emergency_cancel_screenshot_locked(&app, &manager);
    Ok(())
}

pub(crate) fn force_cancel_screenshot(app: &AppHandle, manager: &ScreenshotManager) {
    let _lifecycle = manager
        .lifecycle_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let pending = manager
        .capture
        .lock()
        .ok()
        .is_some_and(|capture| capture.is_some());
    if manager.active.load(Ordering::Acquire) || pending || manager.capturing.load(Ordering::Acquire) {
        emergency_cancel_screenshot_locked(app, manager);
    } else if let Some(window) = app.get_webview_window("screenshot") {
        set_native_visibility(&window, false);
    }
}

#[tauri::command]
pub(crate) fn get_default_screenshot_folder() -> String {
    default_screenshot_folder().to_string_lossy().into_owned()
}

#[tauri::command]
pub(crate) fn open_screenshot_folder(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    fs::create_dir_all(&path).map_err(|error| format!("无法创建截图文件夹：{error}"))?;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("无法打开截图文件夹：{error}"))
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("无法打开截图文件夹：{error}"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = path;
        Err("当前只支持在 Windows 打开截图文件夹".into())
    }
}

#[tauri::command]
pub(crate) fn finish_screenshot(
    app: AppHandle,
    manager: State<'_, ScreenshotManager>,
    state: State<'_, crate::AppState>,
    session_id: u64,
    data_url: String,
    target_path: Option<String>,
    pin: bool,
) -> Result<FinishPayload, String> {
    let png = decode_png_data_url(&data_url)?;
    let image = image::load_from_memory_with_format(&png, ImageFormat::Png)
        .map_err(|_| "截图图片无效".to_string())?;
    let _lifecycle = lock_current_session(&manager, session_id)?;
    let folder = state
        .preferences
        .lock()
        .map_err(|_| "截图设置不可用".to_string())?
        .screenshot_folder
        .clone();
    let target = match target_path {
        Some(value) if !value.trim().is_empty() => ensure_png_extension(PathBuf::from(value)),
        _ => {
            let folder = if folder.trim().is_empty() { default_screenshot_folder() } else { PathBuf::from(folder) };
            folder.join(format!("Token-Bubble_{}.png", chrono::Local::now().format("%Y-%m-%d_%H-%M-%S")))
        }
    };
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建保存文件夹：{error}"))?;
    }
    fs::write(&target, &png).map_err(|error| format!("无法保存截图：{error}"))?;
    copy_image_to_clipboard(&image, &png)?;

    if pin {
        create_pin_window(&app, &manager, ScreenCapture {
            png: png.clone(),
            width: image.width(),
            height: image.height(),
            x: 0,
            y: 0,
            logical_size: {
                #[cfg(target_os = "macos")]
                {
                    manager.capture.lock().ok().and_then(|capture| capture.as_ref().and_then(|source| {
                        source.logical_size.map(|(width, height)| (
                            image.width() as f64 * width / source.width as f64,
                            image.height() as f64 * height / source.height as f64,
                        ))
                    }))
                }
                #[cfg(not(target_os = "macos"))]
                { None }
            },
            window_targets: Vec::new(),
        })?;
    }
    emergency_cancel_screenshot_locked(&app, &manager);
    Ok(FinishPayload { saved_path: target.to_string_lossy().into_owned() })
}

#[tauri::command]
pub(crate) fn get_pinned_screenshot(id: String, manager: State<'_, ScreenshotManager>) -> Result<CapturePayload, String> {
    let capture = manager
        .pins
        .lock()
        .map_err(|_| "贴图数据不可用".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "贴图已经关闭".to_string())?;
    Ok(payload(&capture, 0))
}

#[tauri::command]
pub(crate) fn close_pinned_screenshot(
    id: String,
    app: AppHandle,
    manager: State<'_, ScreenshotManager>,
) -> Result<(), String> {
    if id != "pin" && !id.starts_with("pin-") {
        return Err("贴图标识无效".to_string());
    }
    let window = app
        .get_webview_window(&id)
        .ok_or_else(|| "贴图窗口不存在".to_string())?;
    remove_pin(&manager, &id);
    let _ = window.emit("pinned-screenshot-cleared", ());
    if id == "pin" {
        window.hide().map_err(|error| format!("无法关闭贴图：{error}"))
    } else {
        window.close().map_err(|error| format!("无法关闭贴图：{error}"))
    }
}

fn payload(capture: &ScreenCapture, session_id: u64) -> CapturePayload {
    CapturePayload {
        data_url: format!("data:image/png;base64,{}", BASE64.encode(&capture.png)),
        width: capture.width,
        height: capture.height,
        session_id,
        window_targets: capture.window_targets.clone(),
    }
}

fn decode_png_data_url(value: &str) -> Result<Vec<u8>, String> {
    let encoded = value
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| "截图数据格式不正确".to_string())?;
    BASE64.decode(encoded).map_err(|_| "截图数据无法解码".to_string())
}

fn ensure_png_extension(mut path: PathBuf) -> PathBuf {
    if path.extension().and_then(|value| value.to_str()).is_none_or(|value| !value.eq_ignore_ascii_case("png")) {
        path.set_extension("png");
    }
    path
}

fn create_pin_window(app: &AppHandle, manager: &ScreenshotManager, capture: ScreenCapture) -> Result<(), String> {
    let id = "pin";
    if let Ok(mut pins) = manager.pins.lock() { pins.insert(id.to_string(), capture.clone()); }
    let (source_width, source_height) = capture.logical_size.unwrap_or((capture.width as f64, capture.height as f64));
    let scale = (720.0 / source_width).min(520.0 / source_height).min(1.0);
    let width = (source_width * scale).max(120.0);
    let height = (source_height * scale).max(80.0);
    let window = app.get_webview_window(id).ok_or_else(|| "贴图窗口不存在".to_string())?;
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .and_then(|_| window.center())
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus())
        .map_err(|error| format!("无法显示贴图：{error}"))?;
    let _ = app.emit_to(id, "pinned-screenshot-updated", ());
    Ok(())
}

#[cfg(target_os = "windows")]
fn capture_current_monitor() -> Result<ScreenCapture, String> {
    use std::{ffi::c_void, mem::size_of};
    use windows::Win32::{
        Foundation::POINT,
        Graphics::Gdi::{
            BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
            GetDIBits, GetMonitorInfoW, MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HGDIOBJ, MONITORINFO,
            MONITOR_DEFAULTTONEAREST, ROP_CODE, SRCCOPY,
        },
        UI::WindowsAndMessaging::GetCursorPos,
    };

    unsafe {
        let mut cursor = POINT::default();
        GetCursorPos(&mut cursor).map_err(|error| error.to_string())?;
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() { return Err("无法读取显示器信息".into()); }
        let width = info.rcMonitor.right - info.rcMonitor.left;
        let height = info.rcMonitor.bottom - info.rcMonitor.top;
        if width <= 0 || height <= 0 { return Err("显示器尺寸无效".into()); }
        let window_targets = collect_window_targets(DesktopRect {
            left: info.rcMonitor.left,
            top: info.rcMonitor.top,
            right: info.rcMonitor.right,
            bottom: info.rcMonitor.bottom,
        });

        let screen_dc = GetDC(None);
        if screen_dc.0.is_null() { return Err("无法访问屏幕画面".into()); }
        let memory_dc = CreateCompatibleDC(Some(screen_dc));
        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        if memory_dc.0.is_null() || bitmap.0.is_null() {
            if !memory_dc.0.is_null() { let _ = DeleteDC(memory_dc); }
            let _ = ReleaseDC(None, screen_dc);
            return Err("无法创建截图缓冲区".into());
        }
        let old = SelectObject(memory_dc, HGDIOBJ(bitmap.0));
        let result = (|| -> Result<Vec<u8>, String> {
            BitBlt(
                memory_dc,
                0,
                0,
                width,
                height,
                Some(screen_dc),
                info.rcMonitor.left,
                info.rcMonitor.top,
                ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0),
            )
            .map_err(|error| error.to_string())?;
            let mut pixels = vec![0_u8; width as usize * height as usize * 4];
            let mut bitmap_info = BITMAPINFO::default();
            bitmap_info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: pixels.len() as u32,
                ..Default::default()
            };
            let rows = GetDIBits(
                memory_dc,
                bitmap,
                0,
                height as u32,
                Some(pixels.as_mut_ptr().cast::<c_void>()),
                &mut bitmap_info,
                DIB_RGB_COLORS,
            );
            if rows != height { return Err("无法读取屏幕像素".into()); }
            for pixel in pixels.chunks_exact_mut(4) { pixel.swap(0, 2); }
            Ok(pixels)
        })();
        let _ = SelectObject(memory_dc, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory_dc);
        let _ = ReleaseDC(None, screen_dc);
        let pixels = result?;
        let image = RgbaImage::from_raw(width as u32, height as u32, pixels)
            .ok_or_else(|| "截图像素尺寸不匹配".to_string())?;
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut output, ImageFormat::Png)
            .map_err(|error| format!("截图编码失败：{error}"))?;
        Ok(ScreenCapture {
            png: output.into_inner(),
            width: width as u32,
            height: height as u32,
            x: info.rcMonitor.left,
            y: info.rcMonitor.top,
            logical_size: None,
            window_targets,
        })
    }
}

#[cfg(target_os = "macos")]
fn capture_current_monitor() -> Result<ScreenCapture, String> {
    screenshot_macos::capture_current_monitor()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn capture_current_monitor() -> Result<ScreenCapture, String> {
    Err("截图功能当前只支持 Windows".into())
}

#[cfg(target_os = "windows")]
fn copy_image_to_clipboard(image: &DynamicImage, _png: &[u8]) -> Result<(), String> {
    use std::{mem::size_of, ptr::copy_nonoverlapping};
    use windows::Win32::{
        Foundation::{GlobalFree, HANDLE},
        Graphics::Gdi::{BITMAPINFOHEADER, BI_RGB},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        },
    };

    let rgba = image.to_rgba8();
    let width = rgba.width();
    let height = rgba.height();
    let header = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width as i32,
        biHeight: height as i32,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        biSizeImage: width * height * 4,
        ..Default::default()
    };
    let mut dib = vec![0_u8; size_of::<BITMAPINFOHEADER>() + (width * height * 4) as usize];
    unsafe {
        copy_nonoverlapping(
            (&header as *const BITMAPINFOHEADER).cast::<u8>(),
            dib.as_mut_ptr(),
            size_of::<BITMAPINFOHEADER>(),
        );
    }
    let header_size = size_of::<BITMAPINFOHEADER>();
    for y in 0..height {
        let source_y = height - 1 - y;
        for x in 0..width {
            let source = rgba.get_pixel(x, source_y).0;
            let target = header_size + ((y * width + x) * 4) as usize;
            dib[target..target + 4].copy_from_slice(&[source[2], source[1], source[0], source[3]]);
        }
    }

    unsafe {
        OpenClipboard(None).map_err(|error| format!("无法打开剪贴板：{error}"))?;
        let result = (|| -> Result<(), String> {
            EmptyClipboard().map_err(|error| error.to_string())?;
            let memory = GlobalAlloc(GMEM_MOVEABLE, dib.len()).map_err(|error| error.to_string())?;
            let target = GlobalLock(memory);
            if target.is_null() {
                let _ = GlobalFree(Some(memory));
                return Err("无法分配剪贴板内存".into());
            }
            copy_nonoverlapping(dib.as_ptr(), target.cast::<u8>(), dib.len());
            let _ = GlobalUnlock(memory);
            if let Err(error) = SetClipboardData(8, Some(HANDLE(memory.0))) {
                let _ = GlobalFree(Some(memory));
                return Err(error.to_string());
            }
            Ok(())
        })();
        let _ = CloseClipboard();
        result.map_err(|error| format!("复制截图失败：{error}"))
    }
}

#[cfg(target_os = "macos")]
fn copy_image_to_clipboard(_image: &DynamicImage, png: &[u8]) -> Result<(), String> {
    screenshot_macos::copy_png_to_clipboard(png)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn copy_image_to_clipboard(_image: &DynamicImage, _png: &[u8]) -> Result<(), String> {
    Err("复制图片当前只支持 Windows".into())
}

#[cfg(test)]
mod tests {
    use super::{
        clip_window_targets, ensure_png_extension, lock_current_session,
        payload, should_cancel_unrevealed_session, DesktopRect, ScreenCapture, ScreenshotManager,
        WindowTarget,
    };
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use std::sync::{mpsc, Arc};

    #[test]
    fn save_targets_are_png_files() {
        assert_eq!(ensure_png_extension(PathBuf::from("capture")), PathBuf::from("capture.png"));
        assert_eq!(ensure_png_extension(PathBuf::from("capture.PNG")), PathBuf::from("capture.PNG"));
    }

    #[test]
    fn window_targets_are_relative_to_a_negative_coordinate_monitor() {
        let monitor = DesktopRect { left: -1920, top: -200, right: 0, bottom: 880 };
        let targets = clip_window_targets(
            monitor,
            [DesktopRect { left: -2100, top: -300, right: -200, bottom: 700 }],
        );

        assert_eq!(
            targets,
            vec![WindowTarget { x: 0, y: 0, width: 1720, height: 900 }]
        );
    }

    #[test]
    fn window_targets_are_clipped_to_the_current_monitor() {
        let monitor = DesktopRect { left: 0, top: 0, right: 1920, bottom: 1080 };
        let targets = clip_window_targets(
            monitor,
            [DesktopRect { left: 1700, top: 100, right: 2200, bottom: 700 }],
        );

        assert_eq!(
            targets,
            vec![WindowTarget { x: 1700, y: 100, width: 220, height: 600 }]
        );
    }

    #[test]
    fn window_targets_drop_empty_intersections() {
        let monitor = DesktopRect { left: 0, top: 0, right: 1920, bottom: 1080 };
        let targets = clip_window_targets(
            monitor,
            [
                DesktopRect { left: 40, top: 80, right: 40, bottom: 360 },
                DesktopRect { left: 1920, top: 40, right: 2200, bottom: 600 },
                DesktopRect { left: 200, top: 1080, right: 800, bottom: 1400 },
            ],
        );

        assert!(targets.is_empty());
    }

    #[test]
    fn window_targets_keep_the_enumerator_z_order() {
        let monitor = DesktopRect { left: 0, top: 0, right: 1920, bottom: 1080 };
        let targets = clip_window_targets(
            monitor,
            [
                DesktopRect { left: 600, top: 100, right: 1200, bottom: 700 },
                DesktopRect { left: 2100, top: 100, right: 2400, bottom: 500 },
                DesktopRect { left: 40, top: 60, right: 480, bottom: 420 },
            ],
        );

        assert_eq!(
            targets,
            vec![
                WindowTarget { x: 600, y: 100, width: 600, height: 600 },
                WindowTarget { x: 40, y: 60, width: 440, height: 360 },
            ]
        );
    }

    #[test]
    fn capture_payload_serializes_window_targets_in_camel_case() {
        let capture = ScreenCapture {
            png: Vec::new(),
            width: 1920,
            height: 1080,
            x: -1920,
            y: 0,
            logical_size: None,
            window_targets: vec![WindowTarget { x: 120, y: 80, width: 800, height: 600 }],
        };

        let value = serde_json::to_value(payload(&capture, 17)).unwrap();

        assert_eq!(
            value["windowTargets"],
            serde_json::json!([{ "x": 120, "y": 80, "width": 800, "height": 600 }])
        );
        assert!(value.get("window_targets").is_none());
    }

    #[test]
    fn unrevealed_active_session_is_cancelled_by_the_reveal_watchdog() {
        let manager = ScreenshotManager::default();
        manager.session_id.store(7, Ordering::Release);
        manager.active.store(true, Ordering::Release);

        assert!(should_cancel_unrevealed_session(&manager, 7));

        manager.revealed.store(true, Ordering::Release);
        assert!(!should_cancel_unrevealed_session(&manager, 7));

        manager.revealed.store(false, Ordering::Release);
        assert!(!should_cancel_unrevealed_session(&manager, 8));
    }

    #[test]
    fn stale_callback_waiting_for_lifecycle_lock_cannot_end_new_session() {
        let manager = Arc::new(ScreenshotManager::default());
        manager.session_id.store(1, Ordering::Release);
        manager.active.store(true, Ordering::Release);
        let lifecycle = manager.lifecycle_lock.lock().unwrap();
        let old_manager = Arc::clone(&manager);
        let (started_tx, started_rx) = mpsc::channel();

        let stale_callback = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            match lock_current_session(&old_manager, 1) {
                Ok(_lifecycle) => {
                    old_manager.active.store(false, Ordering::Release);
                    None
                }
                Err(error) => Some(error),
            }
        });

        started_rx.recv().unwrap();
        manager.session_id.store(2, Ordering::Release);
        manager.active.store(true, Ordering::Release);
        drop(lifecycle);

        assert_eq!(
            stale_callback.join().unwrap(),
            Some("截图会话已结束".to_string())
        );
        assert_eq!(manager.session_id.load(Ordering::Acquire), 2);
        assert!(manager.active.load(Ordering::Acquire));
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "captures the active Windows monitor"]
    fn captures_current_monitor_as_png() {
        let capture = super::capture_current_monitor().unwrap();
        assert!(capture.width > 0);
        assert!(capture.height > 0);
        let decoded = image::load_from_memory_with_format(&capture.png, image::ImageFormat::Png).unwrap();
        assert_eq!(decoded.width(), capture.width);
        assert_eq!(decoded.height(), capture.height);
    }
}
