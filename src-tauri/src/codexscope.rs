//! Launch the unmodified CodexScope v0.1.9 dashboard on macOS.

use std::{
    fs,
    path::Path,
    process::Command,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
};

use tauri::{AppHandle, Manager};

static GENERATION_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

struct GenerationGuard;

impl Drop for GenerationGuard {
    fn drop(&mut self) {
        GENERATION_IN_PROGRESS.store(false, Ordering::Release);
    }
}

/// Generate real local data off the UI thread, then open the dashboard.
/// The caller should await this in a Tauri async task and surface any error.
pub(crate) async fn open(app: AppHandle) -> Result<(), String> {
    if GENERATION_IN_PROGRESS
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        return Err("CodexScope 数据生成已在进行中".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = GenerationGuard;
        open_blocking(&app)
    })
    .await
    .map_err(|error| format!("CodexScope 后台任务失败：{error}"))?
}

fn copy_file(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(source, target)
        .map(|_| ())
        .map_err(|error| format!("复制 {} 失败：{error}", source.display()))
}

fn open_blocking(app: &AppHandle) -> Result<(), String> {
    if std::env::consts::ARCH != "aarch64" {
        return Err("CodexScope v0.1.9 官方 macOS 生成器仅提供 Apple Silicon arm64 架构".into());
    }
    let sessions = crate::codex::codex_home()
        .ok_or("无法确定 Codex 数据目录")?
        .join("sessions");
    if !sessions.is_dir() {
        return Err("Codex 会话目录不存在，无法生成真实用量数据".into());
    }

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
    let source_files = source.join("CodexScope Files");
    let target_files = target.join("CodexScope Files");
    let source_app = source_files.join("app");
    let target_app = target_files.join("app");

    // Copy only static files. Generated exports and the incremental cache stay in
    // the writable app data directory across launches.
    for name in ["index.html", "app.js", "styles.css", "data.sample.js"] {
        copy_file(&source_app.join(name), &target_app.join(name))?;
    }
    copy_file(
        &source_files.join("LICENSE"),
        &target_files.join("LICENSE"),
    )?;
    let generator = target_files.join("bin/codexscope-darwin-arm64");
    copy_file(
        &source_files.join("bin/codexscope-darwin-arm64"),
        &generator,
    )?;
    copy_file(
        &source.join("Open CodexScope.command"),
        &target.join("Open CodexScope.command"),
    )?;

    let data = target_app.join("data.js");
    let raw_data = target_app.join("data.raw.js");
    let cache = target_app.join(".codexscope-cache.json");
    let result = Command::new(&generator)
        .arg("--root")
        .arg(&sessions)
        .arg("--out")
        .arg(&data)
        .arg("--raw-out")
        .arg(&raw_data)
        .arg("--cache")
        .arg(&cache)
        .current_dir(&target)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("启动 CodexScope 生成器失败：{error}"))?;
    if !result.success() {
        return Err(format!("CodexScope 生成器退出状态：{result}"));
    }
    for path in [&data, &raw_data] {
        let metadata = fs::metadata(path)
            .map_err(|error| format!("CodexScope 未生成 {}：{error}", path.display()))?;
        if metadata.len() == 0 {
            return Err(format!("CodexScope 生成文件为空：{}", path.display()));
        }
    }

    let dashboard = target_app.join("index.html");
    let result = Command::new("open")
        .arg(&dashboard)
        .status()
        .map_err(|error| format!("打开 CodexScope 仪表盘失败：{error}"))?;
    if !result.success() {
        return Err(format!("打开 CodexScope 仪表盘失败：{result}"));
    }
    Ok(())
}
