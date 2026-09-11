mod codex;
mod local_usage;
mod models;
mod quota;
mod quota_cache;
mod quick_actions;
mod screenshot;
mod voice;

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

use models::{ProviderSnapshot, WidgetPreferences};
use quota::{QuotaCoordinator, QuotaState};
#[cfg(debug_assertions)]
use models::UsageWindow;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_window_state::Builder as WindowStateBuilder;
use voice::VoiceManager;

const DEFAULT_COLLAPSED_LOGICAL_SIZE: f64 = 68.0;
const MIN_COLLAPSED_LOGICAL_SIZE: f64 = 52.0;
const MAX_COLLAPSED_LOGICAL_SIZE: f64 = 100.0;
const COLLAPSED_SIZE_STEP: f64 = 8.0;
const EXPANDED_LOGICAL_SIZE: f64 = 320.0;
const EDGE_SAFE_INSET_LOGICAL: f64 = 10.0;
const SNAP_THRESHOLD_LOGICAL: f64 = 24.0;
const POSITION_EPSILON: u32 = 2;
const TRAY_PANEL_LOGICAL_WIDTH: f64 = 380.0;
const TRAY_PANEL_LOGICAL_HEIGHT: f64 = 504.0;
const TRAY_PANEL_GAP_LOGICAL: f64 = 10.0;

#[tauri::command]
fn start_voice(app: AppHandle, voice: State<'_, VoiceManager>, state: State<'_, AppState>) -> Result<bool, String> {
    let target = voice::preferred_text_target();
    let preferences = state
        .preferences
        .lock()
        .map_err(|_| "语音输入设置不可用".to_string())?;
    let input_device = preferences.voice_input_device.clone();
    let sensitivity = preferences.voice_sensitivity;
    let endpoint_seconds = preferences.voice_endpoint_seconds;
    let punctuation_enabled = preferences.voice_punctuation_enabled;
    drop(preferences);
    if let Some(panel) = app.get_webview_window("tray-panel") {
        let _ = panel.hide();
    }
    voice::focus_text_target(target);
    voice.start(
        app,
        target,
        input_device,
        sensitivity,
        endpoint_seconds,
        punctuation_enabled,
    )
}

#[tauri::command]
fn stop_voice(voice: State<'_, VoiceManager>) {
    voice.stop();
}

#[tauri::command]
fn get_voice_input_devices() -> Result<Vec<String>, String> {
    voice::input_device_names()
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            copy_directory(&source_path, &target_path)?;
        } else {
            fs::copy(source_path, target_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn open_codexscope(app: &AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Err("CodexScope verification is currently available on Windows only.".into());
    }

    #[cfg(target_os = "windows")]
    {
        let source = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?
            .join("codexscope");
        let target = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("CodexScope");
        copy_directory(&source, &target)?;
        let launcher = target.join("Open CodexScope.cmd");
        Command::new("cmd.exe")
            .arg("/C")
            .arg(&launcher)
            .current_dir(&target)
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod codexscope_resource_tests {
    use super::*;

    #[test]
    fn copies_static_files_without_deleting_generated_data() {
        let root = std::env::temp_dir().join(format!(
            "token-bubble-codexscope-{}",
            std::process::id()
        ));
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(source.join("CodexScope Files/app")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("Open CodexScope.cmd"), "launcher").unwrap();
        fs::write(source.join("CodexScope Files/app/index.html"), "dashboard").unwrap();
        fs::write(target.join("data.js"), "generated").unwrap();

        copy_directory(&source, &target).unwrap();

        assert_eq!(fs::read_to_string(target.join("Open CodexScope.cmd")).unwrap(), "launcher");
        assert_eq!(
            fs::read_to_string(target.join("CodexScope Files/app/index.html")).unwrap(),
            "dashboard"
        );
        assert_eq!(fs::read_to_string(target.join("data.js")).unwrap(), "generated");
        let _ = fs::remove_dir_all(root);
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct WidgetMotionPayload {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy)]
enum HorizontalDock {
    Left,
    Right,
}

#[derive(Clone, Copy)]
enum VerticalDock {
    Top,
    Bottom,
}

#[derive(Clone, Copy, Default)]
struct DockState {
    horizontal: Option<HorizontalDock>,
    vertical: Option<VerticalDock>,
}

impl DockState {
    fn is_docked(self) -> bool {
        self.horizontal.is_some() || self.vertical.is_some()
    }
}

#[derive(Clone, Copy)]
struct WidgetRect {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

#[derive(Clone, Copy, Deserialize)]
struct WorkAreaPoint {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, Deserialize)]
struct WorkAreaSize {
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Deserialize)]
struct WorkAreaPayload {
    position: WorkAreaPoint,
    size: WorkAreaSize,
}

#[derive(Clone, Copy)]
enum WidgetMode {
    Collapsed,
    Expanded,
}

#[derive(Clone, Copy)]
struct WidgetGeometryState {
    mode: WidgetMode,
    dock: DockState,
    collapsed_rect: WidgetRect,
    expanded_rect: Option<WidgetRect>,
    user_moved_expanded: bool,
}

struct AppState {
    client: reqwest::Client,
    preferences: Mutex<WidgetPreferences>,
    preferences_path: PathBuf,
    quota_cache_path: PathBuf,
    startup_cache_auth: Option<quota_cache::AuthContext>,
    #[cfg(debug_assertions)]
    simulate_short_window_for_testing: Mutex<bool>,
    geometry: Mutex<Option<WidgetGeometryState>>,
    drag_mode: Mutex<Option<WidgetMode>>,
    panel_resize_active: AtomicBool,
    panel_resize_generation: AtomicU64,
}

#[tauri::command]
fn begin_panel_resize(state: State<'_, AppState>) {
    state.panel_resize_generation.fetch_add(1, Ordering::Relaxed);
    state.panel_resize_active.store(true, Ordering::Release);
}

fn finish_panel_resize_after(app: AppHandle, generation: u64, delay: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let state = app.state::<AppState>();
        if state.panel_resize_generation.load(Ordering::Acquire) != generation {
            return;
        }
        if let Some(panel) = app.get_webview_window("tray-panel") {
            let _ = panel.set_focus();
        }
        std::thread::sleep(Duration::from_millis(700));
        let state = app.state::<AppState>();
        if state.panel_resize_generation.load(Ordering::Acquire) == generation {
            state.panel_resize_active.store(false, Ordering::Release);
        }
    });
}

#[tauri::command]
fn end_panel_resize(app: AppHandle, state: State<'_, AppState>) {
    let generation = state
        .panel_resize_generation
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    finish_panel_resize_after(app, generation, Duration::ZERO);
}

async fn fetch_quota_snapshot(
    client: reqwest::Client,
    simulate_short_window_for_testing: bool,
    quota_cache_path: PathBuf,
) -> Vec<ProviderSnapshot> {
    let auth = quota_cache::current_auth_context();
    let mut snapshot = codex::fetch_snapshot(&client, true).await;
    if auth.as_ref().is_some_and(|context| !quota_cache::auth_is_current(context)) {
        return vec![ProviderSnapshot::failure("signed_out", "Login changed. It will retry automatically.")];
    }
    if let Err(error) =
        quota_cache::update_from_fetch(quota_cache_path, vec![snapshot.clone()], auth.clone()).await
    {
        eprintln!("quota cache update failed: {error}");
    }
    let usage_task = tokio::task::spawn_blocking(local_usage::collect_local_usage);
    let exchange_rate = local_usage::fetch_usd_cny_rate(&client).await;
    snapshot.local_usage = usage_task
        .await
        .ok()
        .and_then(Result::ok);
    if let (Some(usage), Some((rate, date))) = (&mut snapshot.local_usage, exchange_rate) {
        usage.usd_cny_rate = rate;
        usage.exchange_rate_date = date;
    }
    if auth.as_ref().is_some_and(|context| !quota_cache::auth_is_current(context)) {
        return vec![ProviderSnapshot::failure("signed_out", "Login changed. It will retry automatically.")];
    }
    let mut values = vec![snapshot];
    #[cfg(debug_assertions)]
    if simulate_short_window_for_testing {
        for snapshot in &mut values {
            if snapshot.status == "ok" {
                snapshot.short_window = Some(UsageWindow {
                    remaining_percent: 88.0,
                    resets_at: Some((chrono::Utc::now() + chrono::Duration::hours(3)).to_rfc3339()),
                    window_seconds: 18_000,
                });
            }
        }
    }
    values
}

fn load_preferences(path: &PathBuf) -> WidgetPreferences {
    let parse = |candidate: &PathBuf| {
        fs::read_to_string(candidate)
            .ok()
            .and_then(|raw| serde_json::from_str::<WidgetPreferences>(&raw).ok())
    };
    if let Some(value) = parse(path) {
        return value.normalized();
    }
    let backup = path.with_extension("json.bak");
    if let Some(value) = parse(&backup) {
        eprintln!("preferences recovered from backup");
        return value.normalized();
    }
    WidgetPreferences::default()
}

fn persist_preferences(path: &PathBuf, value: &WidgetPreferences) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "failed to create settings directory".to_string())?;
    }
    let serialized =
        serde_json::to_vec_pretty(value).map_err(|_| "failed to serialize settings".to_string())?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let mut file = fs::File::create(&temporary)
        .map_err(|_| "failed to create temporary settings file".to_string())?;
    file.write_all(&serialized)
        .and_then(|_| file.sync_all())
        .map_err(|_| "failed to write settings".to_string())?;
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|_| "failed to back up settings".to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::rename(&backup, path);
        return Err(format!("failed to commit settings: {error}"));
    }
    Ok(())
}

async fn refresh_quota_for_app(app: AppHandle) -> QuotaState {
    let coordinator = app.state::<QuotaCoordinator>().inner().clone();
    let state = app.state::<AppState>();
    let client = state.client.clone();
    let quota_cache_path = state.quota_cache_path.clone();
    #[cfg(debug_assertions)]
    let simulate = state
        .simulate_short_window_for_testing
        .lock()
        .map(|value| *value)
        .unwrap_or(false);
    #[cfg(not(debug_assertions))]
    let simulate = false;
    coordinator
        .refresh_with(move || fetch_quota_snapshot(client, simulate, quota_cache_path))
        .await
}

#[tauri::command]
async fn get_quota_state(coordinator: State<'_, QuotaCoordinator>) -> Result<QuotaState, String> {
    Ok(coordinator.current().await)
}

#[tauri::command]
async fn request_quota_refresh(app: AppHandle) -> Result<QuotaState, String> {
    Ok(refresh_quota_for_app(app).await)
}

// Compatibility commands for the current WebViews; both delegate to the Rust-owned state.
#[tauri::command]
async fn get_snapshots(
    coordinator: State<'_, QuotaCoordinator>,
) -> Result<Vec<ProviderSnapshot>, String> {
    Ok(coordinator.current().await.snapshots)
}

#[tauri::command]
async fn refresh_snapshots(app: AppHandle) -> Result<Vec<ProviderSnapshot>, String> {
    Ok(refresh_quota_for_app(app).await.snapshots)
}

fn trigger_quota_refresh(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = refresh_quota_for_app(app).await;
    });
}

fn start_quota_background_tasks(app: AppHandle) {
    let coordinator = app.state::<QuotaCoordinator>().inner().clone();
    let mut changed = coordinator.subscribe();
    let mut schedule_changed = coordinator.subscribe();
    let event_app = app.clone();
    let expiry_coordinator = coordinator.clone();
    let cache_auth = app.state::<AppState>().startup_cache_auth.clone();
    tauri::async_runtime::spawn(async move {
        expiry_coordinator.expire_cached_while(move || cache_auth.as_ref().is_some_and(quota_cache::auth_is_current)).await;
    });
    tauri::async_runtime::spawn(async move {
        while let Some(state) = quota::recv_next_state(&mut changed).await {
            let _ = event_app.emit("quota-state-changed", state);
        }
    });
    tauri::async_runtime::spawn(async move {
        let mut completed = refresh_quota_for_app(app.clone()).await;
        loop {
            if quota::wait_for_refresh_due(&mut schedule_changed, completed)
                .await
                .is_none()
            {
                break;
            }
            completed = refresh_quota_for_app(app.clone()).await;
        }
    });
}

fn clamp_position_to_monitor(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    monitor: &tauri::Monitor,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let left = monitor_position.x;
    let top = monitor_position.y;
    let right = left + monitor_size.width as i32;
    let bottom = top + monitor_size.height as i32;
    PhysicalPosition::new(
        position
            .x
            .clamp(left - safe_inset, right - size.width as i32 + safe_inset),
        position
            .y
            .clamp(top - safe_inset, bottom - size.height as i32 + safe_inset),
    )
}

fn logical_to_physical(value: f64, scale_factor: f64) -> u32 {
    (value * scale_factor).round().max(1.0) as u32
}

fn window_size_for_visual_size(visual_size: u32, safe_inset: u32) -> u32 {
    visual_size + safe_inset * 2
}

fn widget_window_size(logical_visual_size: f64, scale_factor: f64, safe_inset: u32) -> u32 {
    window_size_for_visual_size(
        logical_to_physical(logical_visual_size, scale_factor),
        safe_inset,
    )
}

fn preferred_widget_size(state: &State<'_, AppState>) -> f64 {
    state
        .preferences
        .lock()
        .ok()
        .map(|preferences| preferences.widget_size)
        .unwrap_or(DEFAULT_COLLAPSED_LOGICAL_SIZE)
        .clamp(MIN_COLLAPSED_LOGICAL_SIZE, MAX_COLLAPSED_LOGICAL_SIZE)
}

fn detect_dock(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    monitor: &tauri::Monitor,
    threshold: i32,
    safe_inset: i32,
) -> DockState {
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let visible_left = position.x + safe_inset;
    let visible_top = position.y + safe_inset;
    let visible_right = position.x + size.width as i32 - safe_inset;
    let visible_bottom = position.y + size.height as i32 - safe_inset;
    let left_distance = (visible_left - monitor_position.x).abs();
    let top_distance = (visible_top - monitor_position.y).abs();
    let right_distance = (monitor_position.x + monitor_size.width as i32 - visible_right).abs();
    let bottom_distance = (monitor_position.y + monitor_size.height as i32 - visible_bottom).abs();
    let horizontal = if left_distance <= threshold || right_distance <= threshold {
        if left_distance <= right_distance {
            Some(HorizontalDock::Left)
        } else {
            Some(HorizontalDock::Right)
        }
    } else {
        None
    };
    let vertical = if top_distance <= threshold || bottom_distance <= threshold {
        if top_distance <= bottom_distance {
            Some(VerticalDock::Top)
        } else {
            Some(VerticalDock::Bottom)
        }
    } else {
        None
    };
    DockState {
        horizontal,
        vertical,
    }
}

fn snap_position(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    dock: DockState,
    monitor: &tauri::Monitor,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let mut next = clamp_position_to_monitor(position, size, monitor, safe_inset);
    match dock.horizontal {
        Some(HorizontalDock::Left) => next.x = monitor_position.x - safe_inset,
        Some(HorizontalDock::Right) => {
            next.x = monitor_position.x + monitor_size.width as i32 - size.width as i32 + safe_inset
        }
        None => {}
    }
    match dock.vertical {
        Some(VerticalDock::Top) => next.y = monitor_position.y - safe_inset,
        Some(VerticalDock::Bottom) => {
            next.y =
                monitor_position.y + monitor_size.height as i32 - size.height as i32 + safe_inset
        }
        None => {}
    }
    next
}

fn expanded_position_in_bounds(
    collapsed: WidgetRect,
    expanded_size: PhysicalSize<u32>,
    dock: DockState,
    bounds_position: PhysicalPosition<i32>,
    bounds_size: PhysicalSize<u32>,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    let monitor_right = bounds_position.x + bounds_size.width as i32;
    let monitor_bottom = bounds_position.y + bounds_size.height as i32;
    let collapsed_left = collapsed.position.x + safe_inset;
    let collapsed_top = collapsed.position.y + safe_inset;
    let collapsed_right = collapsed.position.x + collapsed.size.width as i32 - safe_inset;
    let collapsed_bottom = collapsed.position.y + collapsed.size.height as i32 - safe_inset;
    let x = match dock.horizontal {
        Some(HorizontalDock::Left) => collapsed_left - safe_inset,
        Some(HorizontalDock::Right) => collapsed_right - expanded_size.width as i32 + safe_inset,
        None if collapsed_left + expanded_size.width as i32 - safe_inset > monitor_right => {
            collapsed_right - expanded_size.width as i32 + safe_inset
        }
        None => collapsed_left - safe_inset,
    };
    let y = match dock.vertical {
        Some(VerticalDock::Top) => collapsed_top - safe_inset,
        Some(VerticalDock::Bottom) => collapsed_bottom - expanded_size.height as i32 + safe_inset,
        None if collapsed_top + expanded_size.height as i32 - safe_inset > monitor_bottom => {
            collapsed_bottom - expanded_size.height as i32 + safe_inset
        }
        None => collapsed_top - safe_inset,
    };
    let min_x = bounds_position.x - safe_inset;
    let min_y = bounds_position.y - safe_inset;
    let max_x = (monitor_right - expanded_size.width as i32 + safe_inset).max(min_x);
    let max_y = (monitor_bottom - expanded_size.height as i32 + safe_inset).max(min_y);
    PhysicalPosition::new(x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

fn expanded_position(
    collapsed: WidgetRect,
    expanded_size: PhysicalSize<u32>,
    dock: DockState,
    monitor: &tauri::Monitor,
    work_area: Option<WorkAreaPayload>,
    safe_inset: i32,
) -> PhysicalPosition<i32> {
    let (bounds_position, bounds_size) = work_area
        .map(|area| {
            (
                PhysicalPosition::new(area.position.x, area.position.y),
                PhysicalSize::new(area.size.width, area.size.height),
            )
        })
        .unwrap_or_else(|| (*monitor.position(), *monitor.size()));
    expanded_position_in_bounds(
        collapsed,
        expanded_size,
        dock,
        bounds_position,
        bounds_size,
        safe_inset,
    )
}

fn collapsed_geometry_for_expand(
    current_position: PhysicalPosition<i32>,
    collapsed_size: PhysicalSize<u32>,
    monitor: &tauri::Monitor,
    threshold: i32,
    safe_inset: i32,
    previous: Option<WidgetGeometryState>,
) -> (WidgetRect, DockState) {
    if let Some(previous) = previous {
        let can_reuse_anchor = matches!(previous.mode, WidgetMode::Collapsed)
            || (matches!(previous.mode, WidgetMode::Expanded) && !previous.user_moved_expanded);
        if can_reuse_anchor {
            let position = if previous.dock.is_docked() {
                snap_position(
                    previous.collapsed_rect.position,
                    collapsed_size,
                    previous.dock,
                    monitor,
                    safe_inset,
                )
            } else {
                clamp_position_to_monitor(
                    previous.collapsed_rect.position,
                    collapsed_size,
                    monitor,
                    safe_inset,
                )
            };
            return (
                WidgetRect {
                    position,
                    size: collapsed_size,
                },
                previous.dock,
            );
        }
    }

    let current_collapsed = WidgetRect {
        position: clamp_position_to_monitor(current_position, collapsed_size, monitor, safe_inset),
        size: collapsed_size,
    };
    let dock = detect_dock(
        current_collapsed.position,
        collapsed_size,
        monitor,
        threshold,
        safe_inset,
    );
    let position = if dock.is_docked() {
        snap_position(
            current_collapsed.position,
            collapsed_size,
            dock,
            monitor,
            safe_inset,
        )
    } else {
        current_collapsed.position
    };
    (
        WidgetRect {
            position,
            size: collapsed_size,
        },
        dock,
    )
}

fn current_widget_rect(window: &tauri::WebviewWindow) -> Result<WidgetRect, String> {
    Ok(WidgetRect {
        position: window
            .outer_position()
            .map_err(|_| "failed to read widget position".to_string())?,
        size: window
            .outer_size()
            .map_err(|_| "failed to read widget size".to_string())?,
    })
}

fn monitor_and_scale(
    window: &tauri::WebviewWindow,
) -> Result<(Option<tauri::Monitor>, f64), String> {
    let monitor = window
        .current_monitor()
        .map_err(|_| "failed to read monitor".to_string())?;
    let scale_factor = monitor
        .as_ref()
        .map(|item| item.scale_factor())
        .unwrap_or(1.0);
    Ok((monitor, scale_factor))
}

fn infer_mode(rect: WidgetRect, collapsed_size: PhysicalSize<u32>) -> WidgetMode {
    if rect.size.width <= collapsed_size.width + POSITION_EPSILON
        && rect.size.height <= collapsed_size.height + POSITION_EPSILON
    {
        WidgetMode::Collapsed
    } else {
        WidgetMode::Expanded
    }
}

#[tauri::command]
fn expand_widget(
    work_area: Option<WorkAreaPayload>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let current = current_widget_rect(&window)?;
    let (monitor, scale_factor) = monitor_and_scale(&window)?;
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
    let collapsed_size = PhysicalSize::new(
        widget_window_size(preferred_widget_size(&state), scale_factor, safe_inset),
        widget_window_size(preferred_widget_size(&state), scale_factor, safe_inset),
    );
    let expanded_size = PhysicalSize::new(
        widget_window_size(EXPANDED_LOGICAL_SIZE, scale_factor, safe_inset),
        widget_window_size(EXPANDED_LOGICAL_SIZE, scale_factor, safe_inset),
    );
    let Some(monitor) = monitor else {
        window
            .set_size(expanded_size)
            .map_err(|_| "failed to resize widget".to_string())?;
        return Ok(());
    };
    let threshold = logical_to_physical(SNAP_THRESHOLD_LOGICAL, scale_factor) as i32;
    let previous = state.geometry.lock().ok().and_then(|value| *value);
    let (collapsed_rect, dock) = collapsed_geometry_for_expand(
        current.position,
        collapsed_size,
        &monitor,
        threshold,
        safe_inset as i32,
        previous,
    );
    let expanded_rect = WidgetRect {
        position: expanded_position(
            collapsed_rect,
            expanded_size,
            dock,
            &monitor,
            work_area,
            safe_inset as i32,
        ),
        size: expanded_size,
    };

    if let Ok(mut geometry) = state.geometry.lock() {
        *geometry = Some(WidgetGeometryState {
            mode: WidgetMode::Expanded,
            dock,
            collapsed_rect,
            expanded_rect: Some(expanded_rect),
            user_moved_expanded: false,
        });
    }

    window
        .set_position(expanded_rect.position)
        .map_err(|_| "failed to position widget".to_string())?;
    window
        .set_size(expanded_size)
        .map_err(|_| "failed to resize widget".to_string())
}

#[cfg(test)]
mod geometry_tests {
    use super::*;

    fn rect(x: i32, y: i32, size: u32) -> WidgetRect {
        WidgetRect {
            position: PhysicalPosition::new(x, y),
            size: PhysicalSize::new(size, size),
        }
    }

    #[test]
    fn window_size_includes_the_transparent_safe_inset() {
        assert_eq!(window_size_for_visual_size(68, EDGE_SAFE_INSET_LOGICAL as u32), 88);
        assert_eq!(widget_window_size(320.0, 1.5, 6), 492);
    }

    #[test]
    fn expansion_stays_above_a_bottom_taskbar() {
        let position = expanded_position_in_bounds(
            rect(1812, 952, 88),
            PhysicalSize::new(328, 328),
            DockState {
                horizontal: Some(HorizontalDock::Right),
                vertical: Some(VerticalDock::Bottom),
            },
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1040),
            4,
        );
        assert_eq!(position, PhysicalPosition::new(1572, 712));
    }

    #[test]
    fn expansion_handles_negative_origin_work_areas() {
        let position = expanded_position_in_bounds(
            rect(-1284, -4, 88),
            PhysicalSize::new(328, 328),
            DockState {
                horizontal: Some(HorizontalDock::Left),
                vertical: Some(VerticalDock::Top),
            },
            PhysicalPosition::new(-1280, 0),
            PhysicalSize::new(1280, 984),
            4,
        );
        assert_eq!(position, PhysicalPosition::new(-1284, -4));
    }

    #[test]
    fn undocked_expansion_flips_inward_near_work_area_edges() {
        let position = expanded_position_in_bounds(
            rect(1750, 900, 88),
            PhysicalSize::new(328, 328),
            DockState::default(),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1040),
            4,
        );
        assert_eq!(position, PhysicalPosition::new(1510, 660));
    }
}

#[tauri::command]
fn collapse_widget(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let current = current_widget_rect(&window)?;
    let (monitor, scale_factor) = monitor_and_scale(&window)?;
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
    let collapsed_size = PhysicalSize::new(
        widget_window_size(preferred_widget_size(&state), scale_factor, safe_inset),
        widget_window_size(preferred_widget_size(&state), scale_factor, safe_inset),
    );
    let Some(monitor) = monitor else {
        window
            .set_size(collapsed_size)
            .map_err(|_| "failed to resize widget".to_string())?;
        return Ok(());
    };
    let threshold = logical_to_physical(SNAP_THRESHOLD_LOGICAL, scale_factor) as i32;
    let previous = state.geometry.lock().ok().and_then(|value| *value);
    let user_moved_expanded = previous
        .map(|value| value.user_moved_expanded)
        .unwrap_or(false);
    let candidate = if user_moved_expanded {
        current.position
    } else {
        previous
            .map(|value| value.collapsed_rect.position)
            .unwrap_or(current.position)
    };
    let dock = detect_dock(
        candidate,
        collapsed_size,
        &monitor,
        threshold,
        safe_inset as i32,
    );
    let next_position = if dock.is_docked() {
        snap_position(candidate, collapsed_size, dock, &monitor, safe_inset as i32)
    } else {
        clamp_position_to_monitor(candidate, collapsed_size, &monitor, safe_inset as i32)
    };
    let collapsed_rect = WidgetRect {
        position: next_position,
        size: collapsed_size,
    };
    if let Ok(mut geometry) = state.geometry.lock() {
        *geometry = Some(WidgetGeometryState {
            mode: WidgetMode::Collapsed,
            dock,
            collapsed_rect,
            expanded_rect: None,
            user_moved_expanded: false,
        });
    }
    window
        .set_size(collapsed_size)
        .map_err(|_| "failed to resize widget".to_string())?;
    window
        .set_position(next_position)
        .map_err(|_| "failed to position widget".to_string())
}

#[tauri::command]
fn begin_widget_drag(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    quick_actions::close_widget_quick_actions(app.clone())?;
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let current = current_widget_rect(&window)?;
    let (_, scale_factor) = monitor_and_scale(&window)?;
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
    let collapsed_size = PhysicalSize::new(
        widget_window_size(preferred_widget_size(&state), scale_factor, safe_inset),
        widget_window_size(preferred_widget_size(&state), scale_factor, safe_inset),
    );
    let mode = state
        .geometry
        .lock()
        .ok()
        .and_then(|value| *value)
        .map(|value| value.mode)
        .unwrap_or_else(|| infer_mode(current, collapsed_size));
    if let Ok(mut drag_mode) = state.drag_mode.lock() {
        *drag_mode = Some(mode);
    }
    Ok(())
}

#[tauri::command]
fn finish_widget_drag(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let current = current_widget_rect(&window)?;
    let (monitor, scale_factor) = monitor_and_scale(&window)?;
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let threshold = logical_to_physical(SNAP_THRESHOLD_LOGICAL, scale_factor) as i32;
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
    let collapsed_size = PhysicalSize::new(
        widget_window_size(preferred_widget_size(&state), scale_factor, safe_inset),
        widget_window_size(preferred_widget_size(&state), scale_factor, safe_inset),
    );
    let expanded_size = PhysicalSize::new(
        widget_window_size(EXPANDED_LOGICAL_SIZE, scale_factor, safe_inset),
        widget_window_size(EXPANDED_LOGICAL_SIZE, scale_factor, safe_inset),
    );
    let mode = state
        .drag_mode
        .lock()
        .ok()
        .and_then(|mut value| value.take())
        .or_else(|| {
            state
                .geometry
                .lock()
                .ok()
                .and_then(|value| *value)
                .map(|value| value.mode)
        })
        .unwrap_or_else(|| infer_mode(current, collapsed_size));

    match mode {
        WidgetMode::Collapsed => {
            let dock = detect_dock(
                current.position,
                collapsed_size,
                &monitor,
                threshold,
                safe_inset as i32,
            );
            let next_position = if dock.is_docked() {
                snap_position(
                    current.position,
                    collapsed_size,
                    dock,
                    &monitor,
                    safe_inset as i32,
                )
            } else {
                clamp_position_to_monitor(
                    current.position,
                    collapsed_size,
                    &monitor,
                    safe_inset as i32,
                )
            };
            let collapsed_rect = WidgetRect {
                position: next_position,
                size: collapsed_size,
            };
            window
                .set_position(next_position)
                .map_err(|_| "failed to position widget".to_string())?;
            if let Ok(mut geometry) = state.geometry.lock() {
                *geometry = Some(WidgetGeometryState {
                    mode: WidgetMode::Collapsed,
                    dock,
                    collapsed_rect,
                    expanded_rect: None,
                    user_moved_expanded: false,
                });
            }
        }
        WidgetMode::Expanded => {
            let current_position = clamp_position_to_monitor(
                current.position,
                expanded_size,
                &monitor,
                safe_inset as i32,
            );
            let updated_rect = WidgetRect {
                position: current_position,
                size: expanded_size,
            };
            window
                .set_position(current_position)
                .map_err(|_| "failed to position widget".to_string())?;
            if let Ok(mut geometry) = state.geometry.lock() {
                if let Some(mut value) = *geometry {
                    value.mode = WidgetMode::Expanded;
                    value.expanded_rect = Some(updated_rect);
                    value.user_moved_expanded = true;
                    *geometry = Some(value);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn get_preferences(state: State<'_, AppState>) -> Result<WidgetPreferences, String> {
    state
        .preferences
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "settings unavailable".into())
}

#[tauri::command]
fn set_preferences(
    preferences: WidgetPreferences,
    app: AppHandle,
    state: State<'_, AppState>,
    voice: State<'_, VoiceManager>,
) -> Result<(), String> {
    let preferences = preferences.normalized();
    let mut stored_preferences = state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())?;
    let previous = stored_preferences.clone();
    let restart_voice = (previous.voice_enabled != preferences.voice_enabled)
        || (previous.voice_input_device != preferences.voice_input_device)
        || (previous.voice_sensitivity != preferences.voice_sensitivity)
        || (previous.voice_endpoint_seconds != preferences.voice_endpoint_seconds)
        || (previous.voice_punctuation_enabled != preferences.voice_punctuation_enabled);
    let should_start_voice = !previous.voice_enabled && preferences.voice_enabled;
    let should_stop_voice = previous.voice_enabled && !preferences.voice_enabled;
    let previous_shortcut = previous.screenshot_shortcut.clone();
    let shortcut_changed = previous_shortcut != preferences.screenshot_shortcut;
    let previous_shortcut_registered = shortcut_changed
        && app
            .global_shortcut()
            .is_registered(previous_shortcut.as_str());
    if shortcut_changed {
        register_screenshot_shortcut(&app, &preferences.screenshot_shortcut)?;
        if previous_shortcut_registered {
            if let Err(error) = app.global_shortcut().unregister(previous_shortcut.as_str()) {
                let rollback = app
                    .global_shortcut()
                    .unregister(preferences.screenshot_shortcut.as_str());
                return Err(match rollback {
                    Ok(()) => format!("无法停用旧截图快捷键：{error}"),
                    Err(rollback_error) => format!(
                        "无法停用旧截图快捷键：{error}；撤销新快捷键也失败：{rollback_error}"
                    ),
                });
            }
        }
    }
    if let Err(error) = persist_preferences(&state.preferences_path, &preferences) {
        if shortcut_changed {
            let unregister_error = app
                .global_shortcut()
                .unregister(preferences.screenshot_shortcut.as_str())
                .err();
            let restore_error = previous_shortcut_registered
                .then(|| register_screenshot_shortcut(&app, &previous_shortcut).err())
                .flatten();
            return Err(match (unregister_error, restore_error) {
                (None, None) => error,
                (unregister_error, restore_error) => format!(
                    "{error}；快捷键回滚不完整（撤销新快捷键：{}；恢复旧快捷键：{}）",
                    unregister_error.map_or_else(|| "成功".to_string(), |value| value.to_string()),
                    restore_error.map_or_else(
                        || if previous_shortcut_registered { "成功" } else { "无需恢复" }.to_string(),
                        |value| value,
                    ),
                ),
            });
        }
        return Err(error);
    }
    *stored_preferences = preferences.clone();
    drop(stored_preferences);
    let _ = app.emit("preferences-changed", preferences.clone());
    if restart_voice {
        if should_stop_voice || (previous.voice_enabled && preferences.voice_enabled) {
            voice.stop();
        }
        if should_start_voice || (previous.voice_enabled && preferences.voice_enabled) {
            start_voice(app, voice, state)?;
        }
    }
    Ok(())
}

fn register_screenshot_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                let manager = app.state::<screenshot::ScreenshotManager>();
                let _ = screenshot::begin_screenshot(app.clone(), manager);
            }
        })
        .map_err(|error| format!("截图快捷键注册失败：{error}"))
}

fn apply_lock(app: &AppHandle, locked: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    window
        .set_ignore_cursor_events(locked)
        .map_err(|_| "failed to toggle click-through".to_string())
}

#[tauri::command]
fn set_widget_locked(
    locked: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WidgetPreferences, String> {
    let previous = state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())?
        .clone();
    let mut next = previous.clone();
    next.locked = locked;
    persist_preferences(&state.preferences_path, &next)?;
    if let Err(error) = apply_lock(&app, locked) {
        let _ = persist_preferences(&state.preferences_path, &previous);
        return Err(error);
    }
    *state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())? = next.clone();
    Ok(next)
}

#[tauri::command]
fn set_widget_always_on_top(
    always_on_top: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WidgetPreferences, String> {
    let previous = state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())?
        .clone();
    let mut next = previous.clone();
    next.always_on_top = always_on_top;
    persist_preferences(&state.preferences_path, &next)?;
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    if let Err(error) = window.set_always_on_top(always_on_top) {
        let _ = persist_preferences(&state.preferences_path, &previous);
        return Err(format!("failed to toggle always-on-top: {error}"));
    }
    *state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())? = next.clone();
    let _ = app.emit("preferences-changed", next.clone());
    Ok(next)
}

fn set_floating_widget_visibility(app: &AppHandle, visible: bool) -> Result<bool, String> {
    let widget = app.get_webview_window("widget").ok_or("widget window missing")?;
    if visible {
        widget.show().map_err(|e| e.to_string())?;
        widget.set_focus().map_err(|e| e.to_string())?;
    } else {
        let mut first_error = None;
        for label in ["quick-actions", "tray-panel", "widget"] {
            if let Some(window) = app.get_webview_window(label) {
                if let Err(error) = window.hide() { first_error.get_or_insert(error.to_string()); }
                if window.is_visible().map_err(|e| e.to_string())? { first_error.get_or_insert(format!("{label} remained visible")); }
            }
        }
        if let Some(error) = first_error { return Err(error); }
    }
    let actual = widget.is_visible().map_err(|e| e.to_string())?;
    if actual != visible { return Err("window visibility did not change".to_string()); }
    Ok(actual)
}

#[tauri::command]
fn hide_floating_widget(app: AppHandle) -> Result<bool, String> { set_floating_widget_visibility(&app, false) }

#[tauri::command]
fn show_floating_widget(app: AppHandle) -> Result<(), String> { set_floating_widget_visibility(&app, true).map(|_| ()) }

#[tauri::command]
fn get_floating_widget_visible(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    window.is_visible().map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_floating_widget(app: AppHandle) -> Result<bool, String> {
    let window = app.get_webview_window("widget").ok_or("widget window missing")?;
    let visible = window.is_visible().map_err(|e| e.to_string())?;
    set_floating_widget_visibility(&app, !visible)
}

#[tauri::command]
fn set_widget_position_locked(
    position_locked: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WidgetPreferences, String> {
    let mut next = state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())?
        .clone();
    next.position_locked = position_locked;
    persist_preferences(&state.preferences_path, &next)?;
    *state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())? = next.clone();
    let _ = app.emit("preferences-changed", next.clone());
    Ok(next)
}

#[tauri::command]
fn resize_floating_widget(
    larger: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WidgetPreferences, String> {
    let mut next = state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())?
        .clone();
    let adjustment = if larger {
        COLLAPSED_SIZE_STEP
    } else {
        -COLLAPSED_SIZE_STEP
    };
    next.widget_size = (next.widget_size + adjustment)
        .clamp(MIN_COLLAPSED_LOGICAL_SIZE, MAX_COLLAPSED_LOGICAL_SIZE);

    let window = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let current = current_widget_rect(&window)?;
    let (monitor, scale_factor) = monitor_and_scale(&window)?;
    let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
    let physical_size = widget_window_size(next.widget_size, scale_factor, safe_inset);
    let size = PhysicalSize::new(physical_size, physical_size);
    let centered = PhysicalPosition::new(
        current.position.x + (current.size.width as i32 - physical_size as i32) / 2,
        current.position.y + (current.size.height as i32 - physical_size as i32) / 2,
    );
    let position = monitor
        .as_ref()
        .map(|monitor| clamp_position_to_monitor(centered, size, monitor, safe_inset as i32))
        .unwrap_or(centered);

    window
        .set_size(size)
        .map_err(|_| "failed to resize widget".to_string())?;
    window
        .set_position(position)
        .map_err(|_| "failed to reposition widget".to_string())?;
    persist_preferences(&state.preferences_path, &next)?;
    *state
        .preferences
        .lock()
        .map_err(|_| "settings unavailable".to_string())? = next.clone();
    if let Ok(mut geometry) = state.geometry.lock() {
        *geometry = None;
    }
    let _ = app.emit("preferences-changed", next.clone());
    Ok(next)
}

#[tauri::command]
fn toggle_panel_from_widget(app: AppHandle) -> Result<bool, String> {
    let widget = app
        .get_webview_window("widget")
        .ok_or_else(|| "widget window missing".to_string())?;
    let panel = app
        .get_webview_window("tray-panel")
        .ok_or_else(|| "panel window missing".to_string())?;
    if panel.is_visible().map_err(|error| error.to_string())? {
        panel.hide().map_err(|error| error.to_string())?;
        return Ok(false);
    }

    let widget_position = widget.outer_position().map_err(|error| error.to_string())?;
    let widget_size = widget.outer_size().map_err(|error| error.to_string())?;
    let panel_size = panel.outer_size().unwrap_or_else(|_| {
        let scale = panel.scale_factor().unwrap_or(1.0);
        PhysicalSize::new(
            (TRAY_PANEL_LOGICAL_WIDTH * scale).round() as u32,
            (TRAY_PANEL_LOGICAL_HEIGHT * scale).round() as u32,
        )
    });
    let gap = (TRAY_PANEL_GAP_LOGICAL * panel.scale_factor().unwrap_or(1.0)).round() as i32;
    let monitor = widget.current_monitor().map_err(|error| error.to_string())?;
    let (left, top, right, bottom) = monitor
        .map(|monitor| {
            let origin = monitor.position();
            let size = monitor.size();
            (origin.x, origin.y, origin.x + size.width as i32, origin.y + size.height as i32)
        })
        .unwrap_or((0, 0, i32::MAX / 2, i32::MAX / 2));
    let right_of_widget = widget_position.x + widget_size.width as i32 + gap;
    let x = if right_of_widget + panel_size.width as i32 <= right - gap {
        right_of_widget
    } else {
        widget_position.x - panel_size.width as i32 - gap
    }
    .clamp(left + gap, (right - panel_size.width as i32 - gap).max(left + gap));
    let y = widget_position
        .y
        .clamp(top + gap, (bottom - panel_size.height as i32 - gap).max(top + gap));
    panel
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    panel.show().map_err(|error| error.to_string())?;
    panel.set_focus().map_err(|error| error.to_string())?;
    trigger_quota_refresh(app.clone());
    Ok(true)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)?;
    let codexscope = MenuItem::with_id(
        app,
        "codexscope",
        "Open CodexScope verification",
        cfg!(target_os = "windows"),
        None::<&str>,
    )?;
    let update = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
    let unlock = MenuItem::with_id(app, "unlock", "Unlock widget", true, None::<&str>)?;
    let pin = MenuItem::with_id(app, "pin", "Pin / Unpin Codex", true, None::<&str>)?;
    let language = MenuItem::with_id(
        app,
        "language",
        "Switch Language / 切换语言",
        true,
        None::<&str>,
    )?;
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    #[cfg(debug_assertions)]
    let test_short_window = CheckMenuItem::with_id(
        app,
        "debug-short-window",
        "Test: simulate 5-hour quota",
        true,
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let initial_language = app
        .try_state::<AppState>()
        .and_then(|state| {
            state
                .preferences
                .lock()
                .ok()
                .map(|prefs| prefs.language.clone())
        })
        .unwrap_or_else(|| "zh-CN".into());
    if initial_language != "en" {
        let _ = show.set_text("显示 / 隐藏");
        let _ = refresh.set_text("立即刷新");
        let _ = codexscope.set_text("打开 CodexScope 数据核验");
        let _ = update.set_text("检查更新");
        let _ = unlock.set_text("解锁悬浮窗");
        let _ = pin.set_text("固定 / 取消固定 Codex");
        let _ = language.set_text("Switch to English");
        let _ = autostart.set_text("开机启动");
        let _ = quit.set_text("退出");
    }
    #[cfg(debug_assertions)]
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &refresh,
            &codexscope,
            &update,
            &unlock,
            &pin,
            &language,
            &autostart,
            &test_short_window,
            &quit,
        ],
    )?;
    #[cfg(not(debug_assertions))]
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &refresh,
            &codexscope,
            &update,
            &unlock,
            &pin,
            &language,
            &autostart,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Token Bubble 余量浮窗");
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let autostart_menu = autostart.clone();
    let show_menu = show.clone();
    let refresh_menu = refresh.clone();
    let codexscope_menu = codexscope.clone();
    let update_menu = update.clone();
    let unlock_menu = unlock.clone();
    let pin_menu = pin.clone();
    let language_menu = language.clone();
    let quit_menu = quit.clone();
    #[cfg(debug_assertions)]
    let test_short_window_menu = test_short_window.clone();
    builder
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => { let _ = toggle_floating_widget(app.clone()); }
            "refresh" => {
                trigger_quota_refresh(app.clone());
            }
            "codexscope" => {
                if let Err(error) = open_codexscope(app) {
                    eprintln!("CodexScope launch failed: {error}");
                }
            }
            "update" => {
                let _ = app.emit_to("widget", "update-check-requested", ());
            }
            "debug-short-window" =>
            {
                #[cfg(debug_assertions)]
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut enabled) = state.simulate_short_window_for_testing.lock() {
                        *enabled = !*enabled;
                        let _ = test_short_window_menu.set_checked(*enabled);
                    }
                    trigger_quota_refresh(app.clone());
                }
            }
            "unlock" => {
                let _ = apply_lock(app, false);
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut prefs) = state.preferences.lock() {
                        prefs.locked = false;
                        let _ = persist_preferences(&state.preferences_path, &prefs);
                        let _ = app.emit("preferences-changed", prefs.clone());
                    }
                }
            }
            "pin" => {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut prefs) = state.preferences.lock() {
                        prefs.pinned_provider = if prefs.pinned_provider.is_some() {
                            None
                        } else {
                            Some("codex".into())
                        };
                        let _ = persist_preferences(&state.preferences_path, &prefs);
                        let _ = app.emit("preferences-changed", prefs.clone());
                    }
                }
            }
            "language" => {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut prefs) = state.preferences.lock() {
                        prefs.language = if prefs.language == "en" {
                            "zh-CN".into()
                        } else {
                            "en".into()
                        };
                        let normalized = prefs.clone().normalized();
                        *prefs = normalized.clone();
                        let _ = persist_preferences(&state.preferences_path, &normalized);
                        let english = normalized.language == "en";
                        let _ = show_menu.set_text(if english {
                            "Show / Hide"
                        } else {
                            "显示 / 隐藏"
                        });
                        let _ = refresh_menu.set_text(if english {
                            "Refresh now"
                        } else {
                            "立即刷新"
                        });
                        let _ = codexscope_menu.set_text(if english {
                            "Open CodexScope verification"
                        } else {
                            "打开 CodexScope 数据核验"
                        });
                        let _ = update_menu.set_text(if english {
                            "Check for updates"
                        } else {
                            "检查更新"
                        });
                        let _ = unlock_menu.set_text(if english {
                            "Unlock widget"
                        } else {
                            "解锁悬浮窗"
                        });
                        let _ = pin_menu.set_text(if english {
                            "Pin / Unpin Codex"
                        } else {
                            "固定 / 取消固定 Codex"
                        });
                        let _ = language_menu.set_text(if english {
                            "切换到中文"
                        } else {
                            "Switch to English"
                        });
                        let _ = autostart_menu.set_text(if english {
                            "Start at login"
                        } else {
                            "开机启动"
                        });
                        let _ = quit_menu.set_text(if english { "Quit" } else { "退出" });
                        let _ = app.emit("preferences-changed", normalized);
                    }
                }
            }
            "autostart" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let result = if enabled {
                    manager.disable()
                } else {
                    manager.enable()
                };
                match result {
                    Ok(()) => {
                        let _ = autostart_menu.set_checked(!enabled);
                    }
                    Err(_) => eprintln!("autostart update failed"),
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_page_load(|window, payload| {
            if window.label() == "screenshot" && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(80));
                    let _ = app.emit_to("screenshot", "screenshot-capture-ready", ());
                });
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("widget") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(WindowStateBuilder::default().with_denylist(&["quick-actions"]).build())
        .setup(|app| {
            let data_dir = app.path().app_config_dir()?;
            let preferences_path = data_dir.join("preferences.json");
            let quota_cache_path = data_dir.join("quota-cache.json");
            let startup_cache_auth = quota_cache::current_auth_context();
            let cached_quota = startup_cache_auth.as_ref().and_then(|auth| quota_cache::load_for_auth(&quota_cache_path, auth));
            if startup_cache_auth.is_none() { let _ = quota_cache::invalidate_for_missing_auth(&quota_cache_path); }
            let quota_coordinator = cached_quota.map(|cache| QuotaCoordinator::with_cached_snapshots(cache.snapshots, cache.valid_for)).unwrap_or_default();
            let mut preferences = load_preferences(&preferences_path);
            preferences.voice_enabled = false;
            if preferences.screenshot_folder.is_empty() {
                preferences.screenshot_folder = screenshot::default_screenshot_folder()
                    .to_string_lossy()
                    .into_owned();
                let _ = persist_preferences(&preferences_path, &preferences);
            }
            let voice_model_dir = app.path().resource_dir()?.join("asr");
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(12))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("TokenBubble/0.1")
                .build()
                .expect("static HTTP client configuration must be valid");
            app.manage(AppState {
                client,
                preferences: Mutex::new(preferences.clone()),
                preferences_path,
                quota_cache_path,
                startup_cache_auth,
                #[cfg(debug_assertions)]
                simulate_short_window_for_testing: Mutex::new(false),
                geometry: Mutex::new(None),
                drag_mode: Mutex::new(None),
                panel_resize_active: AtomicBool::new(false),
                panel_resize_generation: AtomicU64::new(0),
            });
            app.manage(quota_coordinator);
            start_quota_background_tasks(app.handle().clone());
            app.manage(VoiceManager::new(voice_model_dir));
            app.manage(screenshot::ScreenshotManager::default());
            if let Err(error) = register_screenshot_shortcut(app.handle(), &preferences.screenshot_shortcut) {
                eprintln!("{error}");
            }
            if setup_tray(app).is_err() {
                eprintln!("tray setup failed; enabling taskbar fallback");
                if let Some(window) = app.get_webview_window("widget") {
                    let _ = window.set_skip_taskbar(false);
                }
            }
            if preferences.locked {
                let _ = apply_lock(app.handle(), true);
            }
            if let Some(window) = app.get_webview_window("widget") {
                let _ = window.set_always_on_top(preferences.always_on_top);
                let scale_factor = window.scale_factor().unwrap_or(1.0);
                let safe_inset = logical_to_physical(EDGE_SAFE_INSET_LOGICAL, scale_factor);
                let size = widget_window_size(preferences.widget_size, scale_factor, safe_inset);
                let _ = window.set_size(PhysicalSize::new(size, size));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_quota_state,
            request_quota_refresh,
            get_snapshots,
            refresh_snapshots,
            expand_widget,
            collapse_widget,
            begin_widget_drag,
            finish_widget_drag,
            get_preferences,
            set_preferences,
            set_widget_locked,
            set_widget_always_on_top,
            show_floating_widget,
            get_floating_widget_visible,
            toggle_floating_widget,
            hide_floating_widget,
            quick_actions::show_widget_quick_actions,
            quick_actions::close_widget_quick_actions,
            set_widget_position_locked,
            resize_floating_widget,
            begin_panel_resize,
            end_panel_resize,
            toggle_panel_from_widget,
            start_voice,
            stop_voice,
            get_voice_input_devices,
            screenshot::begin_screenshot,
            screenshot::activate_screenshot,
            screenshot::reveal_screenshot,
            screenshot::get_screenshot_capture,
            screenshot::screenshot_heartbeat,
            screenshot::set_screenshot_dialog_mode,
            screenshot::cancel_screenshot,
            screenshot::finish_screenshot,
            screenshot::get_default_screenshot_folder,
            screenshot::open_screenshot_folder,
            screenshot::get_pinned_screenshot,
            screenshot::close_pinned_screenshot,
            quit_app
        ])
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. }
                    if window.label() == "widget" || window.label() == "tray-panel" || window.label() == "quick-actions" => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                WindowEvent::CloseRequested { api, .. } if window.label() == "screenshot" => {
                    api.prevent_close();
                    let manager = window.state::<screenshot::ScreenshotManager>();
                    screenshot::force_cancel_screenshot(window.app_handle(), &manager);
                }
                WindowEvent::CloseRequested { api, .. } if window.label() == "pin" => {
                    api.prevent_close();
                    let manager = window.state::<screenshot::ScreenshotManager>();
                    screenshot::remove_pin(&manager, window.label());
                    let _ = window.emit("pinned-screenshot-cleared", ());
                    let _ = window.hide();
                }
                WindowEvent::CloseRequested { .. } if window.label().starts_with("pin-") => {
                    let manager = window.state::<screenshot::ScreenshotManager>();
                    screenshot::remove_pin(&manager, window.label());
                }
                WindowEvent::Focused(false) if window.label() == "tray-panel" => {
                    let resizing = window
                        .state::<AppState>()
                        .panel_resize_active
                        .load(Ordering::Acquire);
                    let cursor_inside = window
                        .cursor_position()
                        .ok()
                        .zip(window.outer_position().ok())
                        .zip(window.outer_size().ok())
                        .is_some_and(|((cursor, position), size)| {
                            cursor.x >= position.x as f64
                                && cursor.x < (position.x + size.width as i32) as f64
                                && cursor.y >= position.y as f64
                                && cursor.y < (position.y + size.height as i32) as f64
                        });
                    if !resizing && !cursor_inside {
                        let _ = window.hide();
                    }
                }
                WindowEvent::Focused(false) if window.label() == "quick-actions" => { let _ = window.hide(); }
                WindowEvent::Resized(_) if window.label() == "tray-panel" => {
                    let state = window.state::<AppState>();
                    if state.panel_resize_active.load(Ordering::Acquire) {
                        let generation = state
                            .panel_resize_generation
                            .fetch_add(1, Ordering::Relaxed)
                            + 1;
                        finish_panel_resize_after(
                            window.app_handle().clone(),
                            generation,
                            Duration::from_millis(600),
                        );
                    }
                }
                WindowEvent::Moved(position) if window.label() == "widget" => {
                    let _ = window.emit(
                        "widget-motion",
                        WidgetMotionPayload {
                            x: position.x,
                            y: position.y,
                        },
                    );
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Token Bubble");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Resumed) {
            trigger_quota_refresh(app_handle.clone());
        }
    });
}
