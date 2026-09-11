use crate::models::{ProviderSnapshot, UsageWindow};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

const CACHE_VERSION: u8 = 1;
const CACHE_MAX_BYTES: u64 = 64 * 1024;
const AUTH_MAX_BYTES: u64 = 256 * 1024;
const CACHE_MAX_AGE_SECONDS: i64 = 15 * 60;
const CLOCK_SKEW_SECONDS: i64 = 60;
const SHORT_WINDOW_SECONDS: u64 = 18_000;
const WEEKLY_WINDOW_SECONDS: u64 = 604_800;
const MAX_WINDOW_SECONDS: u64 = 90 * 24 * 60 * 60;
static TEMP_FILE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub struct LoadedQuotaCache {
    pub snapshots: Vec<ProviderSnapshot>,
    pub valid_for: Duration,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CacheKind {
    Quota,
    SignedOut,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuotaCacheRecord {
    version: u8,
    kind: CacheKind,
    saved_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth_generation: Option<AuthGeneration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    quota: Option<CachedQuota>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthGeneration {
    modified_unix_nanos: u64,
    file_len: u64,
}

#[derive(Debug, Clone)]
pub struct AuthContext {
    path: PathBuf,
    generation: AuthGeneration,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedQuota {
    updated_at: String,
    short_window: Option<UsageWindow>,
    weekly_window: Option<UsageWindow>,
    #[serde(default, skip_serializing)]
    spark_weekly_window: Option<UsageWindow>,
}

pub fn default_auth_path() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .map(|codex_home| codex_home.join("auth.json"))
}

pub fn auth_is_current(auth: &AuthContext) -> bool {
    read_auth_generation(&auth.path).as_ref() == Some(&auth.generation)
}

pub fn current_auth_context() -> Option<AuthContext> {
    auth_context_for_path(&default_auth_path()?)
}

fn auth_context_for_path(path: &Path) -> Option<AuthContext> {
    let metadata_before = fs::metadata(path).ok()?;
    let generation_before = auth_generation_from_metadata(&metadata_before)?;
    let metadata = metadata_before;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > AUTH_MAX_BYTES {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    if raw.len() as u64 > AUTH_MAX_BYTES {
        return None;
    }
    let generation_after = read_auth_generation(path)?;
    if generation_before != generation_after {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let tokens = value.get("tokens").unwrap_or(&value);
    let has_access_token = tokens
        .get("access_token")
        .or_else(|| tokens.get("accessToken"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|token| !token.trim().is_empty());
    has_access_token.then_some(AuthContext {
        path: path.to_path_buf(),
        generation: generation_after,
    })
}

fn read_auth_generation(path: &Path) -> Option<AuthGeneration> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > AUTH_MAX_BYTES {
        return None;
    }
    auth_generation_from_metadata(&metadata)
}

fn auth_generation_from_metadata(metadata: &fs::Metadata) -> Option<AuthGeneration> {
    let modified_unix_nanos = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos()
        .try_into()
        .ok()?;
    Some(AuthGeneration {
        modified_unix_nanos,
        file_len: metadata.len(),
    })
}

pub fn load_for_auth(path: &Path, auth: &AuthContext) -> Option<LoadedQuotaCache> {
    if read_auth_generation(&auth.path).as_ref() != Some(&auth.generation) {
        return None;
    }
    load_at_with_auth_generation(path, Utc::now(), &auth.generation)
}

pub fn invalidate_for_missing_auth(path: &Path) -> Result<(), String> {
    persist_signed_out(path, Utc::now())
}

pub async fn update_from_fetch(
    path: PathBuf,
    snapshots: Vec<ProviderSnapshot>,
    auth: Option<AuthContext>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        update_from_fetch_for_auth(&path, &snapshots, Utc::now(), auth)
    })
    .await
    .map_err(|error| format!("quota cache worker failed: {error}"))?
}

#[cfg(test)]
fn load_at(path: &Path, now: DateTime<Utc>) -> Option<LoadedQuotaCache> {
    let generation = read_record(path)?.auth_generation?;
    load_at_with_auth_generation(path, now, &generation)
}

fn load_at_with_auth_generation(
    path: &Path,
    now: DateTime<Utc>,
    auth_generation: &AuthGeneration,
) -> Option<LoadedQuotaCache> {
    let record = read_record(path)?;
    if record.version != CACHE_VERSION || record.kind == CacheKind::SignedOut {
        return None;
    }
    if record.auth_generation.as_ref() != Some(auth_generation) {
        return None;
    }

    let age_millis = now
        .signed_duration_since(record.saved_at)
        .num_milliseconds();
    let max_age_millis = CACHE_MAX_AGE_SECONDS * 1_000;
    if age_millis < -CLOCK_SKEW_SECONDS * 1_000 || age_millis > max_age_millis {
        return None;
    }

    // Check the original deadlines before dropping any expired window.
    // Otherwise a restart could revive the weekly portion of an expired cache.
    let original_quota = record.quota?;
    let valid_for_millis = effective_valid_for_millis(&original_quota, record.saved_at, now)?;
    let quota = sanitize_cached_quota(original_quota, now)?;
    Some(LoadedQuotaCache {
        snapshots: vec![quota.into_snapshot()],
        valid_for: Duration::from_millis(valid_for_millis as u64),
    })
}

fn read_record(path: &Path) -> Option<QuotaCacheRecord> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > CACHE_MAX_BYTES {
        return None;
    }
    let raw = fs::read(path).ok()?;
    if raw.len() as u64 > CACHE_MAX_BYTES {
        return None;
    }
    serde_json::from_slice(&raw).ok()
}

fn effective_valid_for_millis(
    quota: &CachedQuota,
    saved_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Option<i64> {
    let cache_lifetime = chrono::Duration::seconds(CACHE_MAX_AGE_SECONDS);
    let updated_at = DateTime::parse_from_rfc3339(&quota.updated_at)
        .ok()?
        .with_timezone(&Utc);
    let mut deadline = (saved_at + cache_lifetime).min(updated_at + cache_lifetime);
    for window in [
        quota.short_window.as_ref(),
        quota.weekly_window.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(reset_at) = window
            .resets_at
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc))
        {
            deadline = deadline.min(reset_at);
        }
    }
    let remaining = deadline.signed_duration_since(now).num_milliseconds();
    (remaining > 0).then_some(remaining)
}

fn update_from_fetch_for_auth(
    path: &Path,
    snapshots: &[ProviderSnapshot],
    now: DateTime<Utc>,
    auth: Option<AuthContext>,
) -> Result<(), String> {
    if snapshots
        .iter()
        .any(|snapshot| snapshot.status == "signed_out")
    {
        return persist_signed_out(path, now);
    }
    if snapshots.is_empty() || snapshots.iter().any(|snapshot| snapshot.status != "ok") {
        return Ok(());
    }

    let Some(auth) = auth else {
        return Ok(());
    };
    if read_auth_generation(&auth.path).as_ref() != Some(&auth.generation) {
        return Ok(());
    }

    update_from_fetch_at(path, snapshots, now, &auth.generation)?;
    if read_auth_generation(&auth.path).as_ref() != Some(&auth.generation) {
        persist_signed_out(path, Utc::now())?;
    }
    Ok(())
}

fn update_from_fetch_at(
    path: &Path,
    snapshots: &[ProviderSnapshot],
    now: DateTime<Utc>,
    auth_generation: &AuthGeneration,
) -> Result<(), String> {
    if snapshots
        .iter()
        .any(|snapshot| snapshot.status == "signed_out")
    {
        return persist_signed_out(path, now);
    }
    if snapshots.is_empty() || snapshots.iter().any(|snapshot| snapshot.status != "ok") {
        return Ok(());
    }

    let Some(snapshot) = snapshots
        .iter()
        .find(|snapshot| snapshot.provider == "codex")
    else {
        return Ok(());
    };
    let Some(quota) = CachedQuota::from_snapshot(snapshot, now) else {
        return Ok(());
    };
    persist_record(
        path,
        &QuotaCacheRecord {
            version: CACHE_VERSION,
            kind: CacheKind::Quota,
            saved_at: now,
            auth_generation: Some(auth_generation.clone()),
            quota: Some(quota),
        },
    )
}

fn persist_signed_out(path: &Path, now: DateTime<Utc>) -> Result<(), String> {
    let result = persist_record(
        path,
        &QuotaCacheRecord {
            version: CACHE_VERSION,
            kind: CacheKind::SignedOut,
            saved_at: now,
            auth_generation: None,
            quota: None,
        },
    );
    if result.is_err() {
        let _ = fs::remove_file(path);
        cleanup_legacy_files(path);
    }
    result
}

impl CachedQuota {
    fn from_snapshot(snapshot: &ProviderSnapshot, now: DateTime<Utc>) -> Option<Self> {
        let updated_at = validate_timestamp(&snapshot.updated_at, now)?;
        let short_window =
            sanitize_window(snapshot.short_window.clone(), now, SHORT_WINDOW_SECONDS);
        let weekly_window =
            sanitize_window(snapshot.weekly_window.clone(), now, WEEKLY_WINDOW_SECONDS);
        let spark_weekly_window = None;
        if short_window.is_none() && weekly_window.is_none() {
            return None;
        }
        Some(Self {
            updated_at: updated_at.to_rfc3339(),
            short_window,
            weekly_window,
            spark_weekly_window,
        })
    }

    fn into_snapshot(self) -> ProviderSnapshot {
        ProviderSnapshot {
            provider: "codex".into(),
            display_name: "CODEX".into(),
            plan: None,
            short_window: self.short_window,
            weekly_window: self.weekly_window,
            spark_weekly_window: self.spark_weekly_window,
            reset_credits: None,
            reset_credit_expires_at: Vec::new(),
            daily_token_usage: None,
            lifetime_tokens: None,
            peak_daily_tokens: None,
            local_usage: None,
            updated_at: self.updated_at,
            status: "ok".into(),
            message: None,
        }
    }
}

fn sanitize_cached_quota(mut quota: CachedQuota, now: DateTime<Utc>) -> Option<CachedQuota> {
    quota.updated_at = validate_timestamp(&quota.updated_at, now)?.to_rfc3339();
    quota.short_window = sanitize_window(quota.short_window, now, SHORT_WINDOW_SECONDS);
    quota.weekly_window = sanitize_window(quota.weekly_window, now, WEEKLY_WINDOW_SECONDS);
    quota.spark_weekly_window = None;
    (quota.short_window.is_some() || quota.weekly_window.is_some()).then_some(quota)
}

fn validate_timestamp(value: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let timestamp = DateTime::parse_from_rfc3339(value).ok()?.with_timezone(&Utc);
    let age = now.signed_duration_since(timestamp).num_seconds();
    (-CLOCK_SKEW_SECONDS..=CACHE_MAX_AGE_SECONDS)
        .contains(&age)
        .then_some(timestamp)
}

fn sanitize_window(
    window: Option<UsageWindow>,
    now: DateTime<Utc>,
    default_window_seconds: u64,
) -> Option<UsageWindow> {
    let mut window = window?;
    if !window.remaining_percent.is_finite()
        || !(0.0..=100.0).contains(&window.remaining_percent)
        || window.window_seconds > MAX_WINDOW_SECONDS
    {
        return None;
    }
    if window.window_seconds == 0 {
        window.window_seconds = default_window_seconds;
    }
    if let Some(resets_at) = &window.resets_at {
        let reset = DateTime::parse_from_rfc3339(resets_at).ok()?.with_timezone(&Utc);
        if reset <= now {
            return None;
        }
    }
    Some(window)
}

fn persist_record(path: &Path, record: &QuotaCacheRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let serialized = serde_json::to_vec(record).map_err(|error| error.to_string())?;
    if serialized.len() as u64 > CACHE_MAX_BYTES {
        return Err("quota cache exceeds size limit".into());
    }

    let temporary = unique_temporary_path(path);
    let write_result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&serialized)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);
        replace_file_atomically(&temporary, path)
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    } else {
        cleanup_legacy_files(path);
    }
    write_result
}

#[cfg(target_os = "windows")]
fn replace_file_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    for attempt in 0..3 {
        let succeeded = unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } != 0;
        if succeeded {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(32) || attempt == 2 {
            return Err(error.to_string());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    unreachable!()
}

#[cfg(not(target_os = "windows"))]
fn replace_file_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

fn unique_temporary_path(path: &Path) -> PathBuf {
    let generation = TEMP_FILE_GENERATION.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("quota-cache.json");
    path.with_file_name(format!(
        ".{file_name}.{}.{timestamp}.{generation}.tmp",
        std::process::id(),
    ))
}

fn cleanup_legacy_files(path: &Path) {
    for candidate in [legacy_temporary_path(path), legacy_backup_path(path)] {
        let _ = fs::remove_file(candidate);
    }
}

fn legacy_temporary_path(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

fn legacy_backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DailyTokenUsage, ProviderSnapshot, UsageWindow};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn test_auth_generation() -> AuthGeneration {
        AuthGeneration {
            modified_unix_nanos: 1_000,
            file_len: 100,
        }
    }

    fn snapshot(now: DateTime<Utc>) -> ProviderSnapshot {
        ProviderSnapshot {
            provider: "codex".into(),
            display_name: "CODEX".into(),
            plan: Some("PRO".into()),
            short_window: Some(UsageWindow {
                remaining_percent: 64.0,
                resets_at: Some((now + chrono::Duration::hours(4)).to_rfc3339()),
                window_seconds: 18_000,
            }),
            weekly_window: Some(UsageWindow {
                remaining_percent: 32.0,
                resets_at: Some((now + chrono::Duration::days(6)).to_rfc3339()),
                window_seconds: 604_800,
            }),
            spark_weekly_window: None,
            reset_credits: Some(2),
            reset_credit_expires_at: vec![(now + chrono::Duration::days(1)).to_rfc3339()],
            daily_token_usage: Some(vec![DailyTokenUsage {
                date: "2026-09-04".into(),
                tokens: 123,
            }]),
            lifetime_tokens: Some(456),
            peak_daily_tokens: Some(123),
            local_usage: None,
            updated_at: now.to_rfc3339(),
            status: "ok".into(),
            message: None,
        }
    }

    fn temp_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "token-bubble-{name}-{}-{nonce}.json",
            std::process::id()
        ))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_file(path);
        cleanup_legacy_files(path);
    }

    #[test]
    fn spark_quota_is_neither_persisted_nor_restored() {
        let now = at("2026-09-11T00:00:00Z");
        let mut value = snapshot(now);
        value.spark_weekly_window = value.weekly_window.clone();
        let cached = CachedQuota::from_snapshot(&value, now).unwrap();
        let json = serde_json::to_string(&cached).unwrap();
        assert!(!json.contains("spark"));
        assert!(cached.into_snapshot().spark_weekly_window.is_none());
    }

    #[test]
    fn valid_cache_round_trips_only_quota_fields() {
        let path = temp_path("round-trip");
        let now = at("2026-09-04T02:40:00Z");
        update_from_fetch_at(&path, &[snapshot(now)], now, &test_auth_generation()).unwrap();
        let loaded = load_at(&path, now + chrono::Duration::minutes(5)).unwrap();
        let raw = fs::read_to_string(&path).unwrap();

        assert_eq!(loaded.snapshots.len(), 1);
        assert_eq!(loaded.snapshots[0].weekly_window.as_ref().unwrap().remaining_percent, 32.0);
        assert!(loaded.snapshots[0].daily_token_usage.is_none());
        assert!(loaded.snapshots[0].local_usage.is_none());
        assert!(loaded.snapshots[0].reset_credits.is_none());
        assert!(!raw.contains("PRO"));
        assert!(!raw.contains("dailyTokenUsage"));
        cleanup(&path);
    }

    #[test]
    fn expired_and_future_cache_is_ignored() {
        let path = temp_path("expired");
        let now = at("2026-09-04T02:40:00Z");
        update_from_fetch_at(&path, &[snapshot(now)], now, &test_auth_generation()).unwrap();

        assert!(load_at(&path, now + chrono::Duration::seconds(901)).is_none());
        assert!(load_at(&path, now - chrono::Duration::seconds(61)).is_none());
        cleanup(&path);
    }

    #[test]
    fn unavailable_refresh_does_not_extend_cache_ttl() {
        let path = temp_path("no-renew");
        let now = at("2026-09-04T02:40:00Z");
        update_from_fetch_at(&path, &[snapshot(now)], now, &test_auth_generation()).unwrap();
        let before = fs::read(&path).unwrap();
        let failure = ProviderSnapshot::failure("unavailable", "temporary failure");

        update_from_fetch_at(
            &path,
            &[failure],
            now + chrono::Duration::minutes(10),
            &test_auth_generation(),
        )
        .unwrap();

        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(load_at(&path, now + chrono::Duration::seconds(901)).is_none());
        cleanup(&path);
    }

    #[test]
    fn signed_out_refresh_commits_tombstone_and_removes_legacy_copies() {
        let path = temp_path("signed-out");
        let now = at("2026-09-04T02:40:00Z");
        update_from_fetch_at(&path, &[snapshot(now)], now, &test_auth_generation()).unwrap();
        fs::write(legacy_backup_path(&path), b"old").unwrap();
        fs::write(legacy_temporary_path(&path), b"old").unwrap();
        let signed_out = ProviderSnapshot::failure("signed_out", "sign in required");

        update_from_fetch_at(
            &path,
            &[signed_out],
            now + chrono::Duration::minutes(1),
            &test_auth_generation(),
        )
        .unwrap();

        assert!(path.exists());
        assert!(load_at(&path, now + chrono::Duration::minutes(1)).is_none());
        assert_eq!(read_record(&path).unwrap().kind, CacheKind::SignedOut);
        assert!(!legacy_backup_path(&path).exists());
        assert!(!legacy_temporary_path(&path).exists());

        let failure = ProviderSnapshot::failure("unavailable", "temporary failure");
        update_from_fetch_at(
            &path,
            &[failure],
            now + chrono::Duration::minutes(20),
            &test_auth_generation(),
        )
        .unwrap();
        assert!(load_at(&path, now + chrono::Duration::minutes(20)).is_none());
        assert_eq!(read_record(&path).unwrap().kind, CacheKind::SignedOut);
        cleanup(&path);
    }

    #[test]
    fn missing_auth_invalidation_writes_a_tombstone() {
        let path = temp_path("missing-auth");

        invalidate_for_missing_auth(&path).unwrap();

        assert!(path.exists());
        assert_eq!(read_record(&path).unwrap().kind, CacheKind::SignedOut);
        cleanup(&path);
    }

    #[test]
    fn corrupt_oversized_and_out_of_range_cache_is_rejected() {
        let path = temp_path("invalid");
        let now = at("2026-09-04T02:40:00Z");
        fs::write(&path, b"not json").unwrap();
        assert!(load_at(&path, now).is_none());

        fs::write(&path, vec![b'x'; CACHE_MAX_BYTES as usize + 1]).unwrap();
        assert!(load_at(&path, now).is_none());

        let mut invalid = CachedQuota::from_snapshot(&snapshot(now), now).unwrap();
        invalid.short_window.as_mut().unwrap().remaining_percent = 101.0;
        invalid.weekly_window = None;
        let record = QuotaCacheRecord {
            version: CACHE_VERSION,
            kind: CacheKind::Quota,
            saved_at: now,
            auth_generation: Some(test_auth_generation()),
            quota: Some(invalid),
        };
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(load_at(&path, now).is_none());

        let unknown_version = QuotaCacheRecord {
            version: CACHE_VERSION + 1,
            kind: CacheKind::Quota,
            saved_at: now,
            auth_generation: Some(test_auth_generation()),
            quota: CachedQuota::from_snapshot(&snapshot(now), now),
        };
        fs::write(&path, serde_json::to_vec(&unknown_version).unwrap()).unwrap();
        assert!(load_at(&path, now).is_none());
        cleanup(&path);
    }

    #[test]
    fn corrupt_canonical_never_falls_back_to_legacy_backup() {
        let path = temp_path("no-backup-fallback");
        let now = at("2026-09-04T02:40:00Z");
        update_from_fetch_at(&path, &[snapshot(now)], now, &test_auth_generation()).unwrap();
        fs::copy(&path, legacy_backup_path(&path)).unwrap();
        fs::write(&path, b"truncated").unwrap();

        assert!(load_at(&path, now).is_none());
        cleanup(&path);
    }

    #[test]
    fn cache_stops_exactly_at_fifteen_minutes() {
        let path = temp_path("exact-fifteen");
        let now = at("2026-09-11T00:00:00Z");
        update_from_fetch_at(&path, &[snapshot(now)], now, &test_auth_generation()).unwrap();
        assert!(load_at(&path, now + chrono::Duration::seconds(899)).is_some());
        assert!(load_at(&path, now + chrono::Duration::seconds(900)).is_none());
        cleanup(&path);
    }

    #[test]
    fn any_reset_expires_the_entire_cached_record() {
        let path = temp_path("window-expiry");
        let now = at("2026-09-04T02:40:00Z");
        let mut cached = CachedQuota::from_snapshot(&snapshot(now), now).unwrap();
        cached.short_window.as_mut().unwrap().resets_at =
            Some((now - chrono::Duration::seconds(1)).to_rfc3339());
        let record = QuotaCacheRecord {
            version: CACHE_VERSION,
            kind: CacheKind::Quota,
            saved_at: now,
            auth_generation: Some(test_auth_generation()),
            quota: Some(cached),
        };
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();

        assert!(load_at(&path, now).is_none());
        cleanup(&path);
    }

    #[test]
    fn invalid_reset_timestamp_is_dropped_and_zero_duration_is_normalized() {
        let path = temp_path("window-validation");
        let now = at("2026-09-04T02:40:00Z");
        let mut cached = CachedQuota::from_snapshot(&snapshot(now), now).unwrap();
        cached.short_window.as_mut().unwrap().resets_at = Some("not-a-timestamp".into());
        cached.weekly_window.as_mut().unwrap().window_seconds = 0;
        let record = QuotaCacheRecord {
            version: CACHE_VERSION,
            kind: CacheKind::Quota,
            saved_at: now,
            auth_generation: Some(test_auth_generation()),
            quota: Some(cached),
        };
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();

        let loaded = load_at(&path, now).unwrap();

        assert!(loaded.snapshots[0].short_window.is_none());
        assert_eq!(
            loaded.snapshots[0]
                .weekly_window
                .as_ref()
                .unwrap()
                .window_seconds,
            WEEKLY_WINDOW_SECONDS
        );
        cleanup(&path);
    }

    #[test]
    fn different_auth_generation_rejects_hydration() {
        let path = temp_path("auth-generation");
        let now = at("2026-09-04T02:40:00Z");
        update_from_fetch_at(&path, &[snapshot(now)], now, &test_auth_generation()).unwrap();

        let mut changed_generation = test_auth_generation();
        changed_generation.file_len += 1;
        assert!(load_at_with_auth_generation(
            &path,
            now + chrono::Duration::seconds(2),
            &changed_generation,
        )
        .is_none());
        cleanup(&path);
    }

    #[tokio::test]
    async fn nearest_reset_deadline_expires_loaded_cache_without_refresh() {
        use crate::quota::{recv_next_state, QuotaCoordinator};

        let path = temp_path("reset-deadline");
        let now = at("2026-09-04T02:40:00Z");
        let mut expiring = snapshot(now);
        expiring.short_window.as_mut().unwrap().resets_at =
            Some((now + chrono::Duration::milliseconds(20)).to_rfc3339());
        update_from_fetch_at(
            &path,
            &[expiring],
            now,
            &test_auth_generation(),
        )
        .unwrap();
        let loaded = load_at(&path, now).unwrap();
        let coordinator =
            QuotaCoordinator::with_cached_snapshots(loaded.snapshots, loaded.valid_for);
        let mut changed = coordinator.subscribe();
        let expiry_coordinator = coordinator.clone();
        tokio::spawn(async move {
            expiry_coordinator.expire_cached_when_due().await;
        });

        let state = tokio::time::timeout(Duration::from_secs(1), recv_next_state(&mut changed))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(state.snapshots[0].status, "unavailable");
        cleanup(&path);
    }

    #[test]
    fn auth_change_between_fetch_and_commit_does_not_write_old_snapshot() {
        let cache_path = temp_path("auth-race-cache");
        let auth_path = temp_path("auth-race-auth");
        let now = at("2026-09-04T02:40:00Z");
        fs::write(&auth_path, br#"{"tokens":{"access_token":"old"}}"#).unwrap();
        let old_auth = auth_context_for_path(&auth_path).unwrap();
        fs::write(
            &auth_path,
            br#"{"tokens":{"access_token":"new-and-longer"}}"#,
        )
        .unwrap();

        update_from_fetch_for_auth(
            &cache_path,
            &[snapshot(now)],
            now,
            Some(old_auth),
        )
        .unwrap();

        assert!(!cache_path.exists());
        cleanup(&cache_path);
        cleanup(&auth_path);
    }

    #[test]
    fn non_codex_provider_is_never_persisted_as_codex() {
        let path = temp_path("wrong-provider");
        let now = at("2026-09-04T02:40:00Z");
        let mut other = snapshot(now);
        other.provider = "other".into();

        update_from_fetch_at(&path, &[other], now, &test_auth_generation()).unwrap();

        assert!(!path.exists());
        cleanup(&path);
    }

    #[test]
    fn atomic_file_supports_first_create_and_overwrite() {
        let path = temp_path("overwrite");
        let now = at("2026-09-04T02:40:00Z");
        update_from_fetch_at(&path, &[snapshot(now)], now, &test_auth_generation()).unwrap();
        let mut newer = snapshot(now + chrono::Duration::minutes(1));
        newer.short_window.as_mut().unwrap().remaining_percent = 55.0;

        update_from_fetch_at(
            &path,
            &[newer],
            now + chrono::Duration::minutes(1),
            &test_auth_generation(),
        )
        .unwrap();

        assert_eq!(
            load_at(&path, now + chrono::Duration::minutes(1))
                .unwrap()
                .snapshots[0]
                .short_window
                .as_ref()
                .unwrap()
                .remaining_percent,
            55.0
        );
        cleanup(&path);
    }

    #[test]
    fn unusable_auth_files_do_not_enable_cache_hydration() {
        let path = temp_path("auth");
        assert!(auth_context_for_path(&path).is_none());
        fs::write(&path, br#"{"tokens":{"access_token":""}}"#).unwrap();
        assert!(auth_context_for_path(&path).is_none());
        fs::write(&path, br#"{"tokens":{"access_token":"present"}}"#).unwrap();
        assert!(auth_context_for_path(&path).is_some());
        cleanup(&path);
    }
}
