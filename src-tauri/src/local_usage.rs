use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Duration, Local, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::{
    DailyTokenBreakdown, HourlyTokenUsage, LocalUsageSummary, ModelTokenUsage, TokenBreakdown,
};

const CACHE_VERSION: u32 = 5;
const HISTORY_DAYS: i64 = 90;
const FALLBACK_USD_CNY_RATE: f64 = 6.7775;
const FALLBACK_EXCHANGE_RATE_DATE: &str = "2026-07-17";
const EXCHANGE_RATE_URL: &str = "https://api.frankfurter.dev/v2/rate/USD/CNY?providers=ECB";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageEvent {
    timestamp_ms: i64,
    model: String,
    usage: TokenBreakdown,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedFile {
    size: u64,
    modified_ms: u64,
    events: Vec<UsageEvent>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageCache {
    version: u32,
    files: HashMap<String, ParsedFile>,
}

#[derive(Clone, Copy)]
struct Pricing {
    input: f64,
    cached: f64,
    output: f64,
}

pub async fn fetch_usd_cny_rate(client: &reqwest::Client) -> Option<(f64, String)> {
    let payload = client
        .get(EXCHANGE_RATE_URL)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<Value>()
        .await
        .ok()?;
    let rate = payload.get("rate").and_then(Value::as_f64)?;
    if !rate.is_finite() || rate <= 0.0 {
        return None;
    }
    let date = payload
        .get("date")
        .and_then(Value::as_str)
        .unwrap_or("latest")
        .to_string();
    Some((rate, date))
}

pub fn collect_local_usage() -> Result<LocalUsageSummary, String> {
    let codex_root = crate::codex::codex_home()
        .ok_or_else(|| "Codex directory is unavailable".to_string())?;
    let cache_path = dirs::data_local_dir()
        .unwrap_or_else(|| codex_root.clone())
        .join("app.tokenbubble.desktop")
        .join("local-usage-cache.json");
    collect_local_usage_from(&codex_root, &cache_path, Utc::now())
}

fn collect_local_usage_from(
    codex_root: &Path,
    cache_path: &Path,
    now: DateTime<Utc>,
) -> Result<LocalUsageSummary, String> {
    let mut cache = read_cache(cache_path);
    let mut paths = Vec::new();
    collect_jsonl_files(&codex_root.join("sessions"), &mut paths);

    let cutoff_ms = (now - Duration::days(HISTORY_DAYS)).timestamp_millis();
    let mut current_files = HashMap::new();
    for path in paths {
        let metadata = match fs::metadata(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let size = metadata.len();
        let modified_ms = system_time_ms(metadata.modified().unwrap_or(UNIX_EPOCH));
        let key = path.to_string_lossy().into_owned();
        let parsed = match cache.files.remove(&key) {
            Some(value) if value.size == size && value.modified_ms == modified_ms => value,
            _ => parse_file(&path, size, modified_ms, cutoff_ms),
        };
        current_files.insert(key, parsed);
    }
    cache.files = current_files;
    cache.version = CACHE_VERSION;
    write_cache(cache_path, &cache);

    Ok(summarize(
        cache
            .files
            .values()
            .flat_map(|file| file.events.iter()),
        now,
    ))
}

fn collect_jsonl_files(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, output);
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            output.push(path);
        }
    }
}

fn parse_file(path: &Path, size: u64, modified_ms: u64, cutoff_ms: i64) -> ParsedFile {
    let mut result = ParsedFile {
        size,
        modified_ms,
        events: Vec::new(),
    };
    let Ok(file) = File::open(path) else {
        return result;
    };
    let mut current_model = "unknown".to_string();
    let mut seen_usage = HashSet::new();
    let mut previous_payload_type: Option<String> = None;
    let mut lines = BufReader::new(file).lines().map_while(Result::ok).peekable();
    while let Some(line) = lines.next() {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let payload_type = value
            .pointer("/payload/type")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let preceded_by_abort = previous_payload_type.as_deref() == Some("turn_aborted");
        previous_payload_type = payload_type.clone();
        if value.get("type").and_then(Value::as_str) == Some("turn_context") {
            if let Some(model) = value
                .pointer("/payload/model")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                current_model = model.to_string();
            }
            continue;
        }
        if value.get("type").and_then(Value::as_str) != Some("event_msg")
            || value.pointer("/payload/type").and_then(Value::as_str) != Some("token_count")
        {
            continue;
        }
        let Some(timestamp) = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.timestamp_millis())
        else {
            continue;
        };
        if timestamp < cutoff_ms {
            continue;
        }
        let usage = value
            .pointer("/payload/info/last_token_usage")
            .or_else(|| value.pointer("/payload/info/total_token_usage"));
        let Some(usage) = usage else {
            continue;
        };
        let breakdown = parse_breakdown(usage);
        let has_components = has_component_tokens(&breakdown);
        let is_aborted_rollback = !has_components
            && preceded_by_abort
            && lines
                .peek()
                .and_then(|line| serde_json::from_str::<Value>(line).ok())
                .and_then(|value| {
                    value
                        .pointer("/payload/type")
                        .and_then(Value::as_str)
                        .map(|value| value == "thread_rolled_back")
                })
                .unwrap_or(false);
        let signature = (
            breakdown.input_tokens,
            breakdown.cached_input_tokens,
            breakdown.cache_write_input_tokens,
            breakdown.output_tokens,
            breakdown.reasoning_output_tokens,
            breakdown.total_tokens,
        );
        if breakdown.total_tokens == 0
            || (!has_components && !is_aborted_rollback)
            || !seen_usage.insert(signature)
        {
            continue;
        }
        result.events.push(UsageEvent {
            timestamp_ms: timestamp,
            model: current_model.clone(),
            usage: breakdown,
        });
    }
    result
}

fn has_component_tokens(value: &TokenBreakdown) -> bool {
    value.input_tokens > 0
        || value.cached_input_tokens > 0
        || value.cache_write_input_tokens > 0
        || value.output_tokens > 0
        || value.reasoning_output_tokens > 0
}

fn parse_breakdown(value: &Value) -> TokenBreakdown {
    let number = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    TokenBreakdown {
        input_tokens: number("input_tokens"),
        cached_input_tokens: number("cached_input_tokens"),
        cache_write_input_tokens: number("cache_write_input_tokens"),
        output_tokens: number("output_tokens"),
        reasoning_output_tokens: number("reasoning_output_tokens"),
        total_tokens: number("total_tokens"),
        calls: 1,
        estimated_cost_usd: 0.0,
    }
}

fn summarize<'a>(
    events: impl Iterator<Item = &'a UsageEvent>,
    now: DateTime<Utc>,
) -> LocalUsageSummary {
    let now_local = now.with_timezone(&Local);
    let today_start = Local
        .with_ymd_and_hms(
            now_local.year(),
            now_local.month(),
            now_local.day(),
            0,
            0,
            0,
        )
        .single()
        .unwrap_or(now_local);
    let day_start_ms = today_start.timestamp_millis();
    let hour_start_ms = (now - Duration::hours(1)).timestamp_millis();
    let mut today = TokenBreakdown::default();
    let mut last_hour = TokenBreakdown::default();
    let mut hourly = (0..24)
        .map(|hour| HourlyTokenUsage {
            hour: format!("{hour:02}:00"),
            tokens: 0,
            calls: 0,
            estimated_cost_usd: 0.0,
        })
        .collect::<Vec<_>>();
    let mut models: HashMap<String, ModelTokenUsage> = HashMap::new();
    let mut daily: HashMap<String, TokenBreakdown> = HashMap::new();

    for event in events {
        let cost = estimate_cost(&event.model, &event.usage);
        if let Some(local_time) = Local.timestamp_millis_opt(event.timestamp_ms).single() {
            let date = local_time.format("%Y-%m-%d").to_string();
            add_breakdown(daily.entry(date).or_default(), &event.usage, cost);
        }
        if event.timestamp_ms < day_start_ms {
            continue;
        }
        add_breakdown(&mut today, &event.usage, cost);
        if event.timestamp_ms >= hour_start_ms {
            add_breakdown(&mut last_hour, &event.usage, cost);
        }
        if let Some(local_time) = Local.timestamp_millis_opt(event.timestamp_ms).single() {
            let bucket = &mut hourly[local_time.hour() as usize];
            bucket.tokens = bucket.tokens.saturating_add(event.usage.total_tokens);
            bucket.calls = bucket.calls.saturating_add(1);
            bucket.estimated_cost_usd += cost;
        }
        let model = models
            .entry(event.model.clone())
            .or_insert_with(|| ModelTokenUsage {
                model: event.model.clone(),
                tokens: 0,
                calls: 0,
                estimated_cost_usd: 0.0,
            });
        model.tokens = model.tokens.saturating_add(event.usage.total_tokens);
        model.calls = model.calls.saturating_add(1);
        model.estimated_cost_usd += cost;
    }

    let mut model_rows = models.into_values().collect::<Vec<_>>();
    model_rows.sort_by(|left, right| right.tokens.cmp(&left.tokens));
    let mut daily_rows = daily
        .into_iter()
        .map(|(date, usage)| DailyTokenBreakdown { date, usage })
        .collect::<Vec<_>>();
    daily_rows.sort_by(|left, right| left.date.cmp(&right.date));
    let peak = hourly.iter().max_by_key(|bucket| bucket.tokens);
    let peak_hour = peak
        .filter(|bucket| bucket.tokens > 0)
        .map(|bucket| bucket.hour.clone());
    let peak_hour_tokens = peak.map(|bucket| bucket.tokens).unwrap_or(0);
    let cache_hit_percent = if today.input_tokens == 0 {
        0.0
    } else {
        today.cached_input_tokens as f64 / today.input_tokens as f64 * 100.0
    };
    LocalUsageSummary {
        today,
        last_hour,
        hourly,
        daily: daily_rows,
        models: model_rows,
        cache_hit_percent,
        peak_hour,
        peak_hour_tokens,
        usd_cny_rate: FALLBACK_USD_CNY_RATE,
        exchange_rate_date: FALLBACK_EXCHANGE_RATE_DATE.to_string(),
        scanned_at: now.to_rfc3339(),
    }
}

fn add_breakdown(target: &mut TokenBreakdown, value: &TokenBreakdown, cost: f64) {
    target.input_tokens = target.input_tokens.saturating_add(value.input_tokens);
    target.cached_input_tokens = target
        .cached_input_tokens
        .saturating_add(value.cached_input_tokens);
    target.cache_write_input_tokens = target
        .cache_write_input_tokens
        .saturating_add(value.cache_write_input_tokens);
    target.output_tokens = target.output_tokens.saturating_add(value.output_tokens);
    target.reasoning_output_tokens = target
        .reasoning_output_tokens
        .saturating_add(value.reasoning_output_tokens);
    target.total_tokens = target.total_tokens.saturating_add(value.total_tokens);
    target.calls = target.calls.saturating_add(1);
    target.estimated_cost_usd += cost;
}

fn estimate_cost(model: &str, usage: &TokenBreakdown) -> f64 {
    let Some(pricing) = pricing_for_model(model) else {
        return 0.0;
    };
    let cached = usage.cached_input_tokens.min(usage.input_tokens);
    let uncached = usage.input_tokens.saturating_sub(cached);
    (uncached as f64 * pricing.input
        + cached as f64 * pricing.cached
        + usage.output_tokens as f64 * pricing.output)
        / 1_000_000.0
}

fn pricing_for_model(model: &str) -> Option<Pricing> {
    let model = model.to_ascii_lowercase().replace('_', "-");
    let values = if model.contains("gpt-5.5") {
        (5.0, 0.5, 30.0)
    } else if model.contains("gpt-5.4-mini") {
        (0.75, 0.075, 4.5)
    } else if model.contains("gpt-5.4") {
        (2.5, 0.25, 15.0)
    } else if model.contains("gpt-5.3") || model.contains("gpt-5.2") {
        (1.75, 0.175, 14.0)
    } else if model.contains("gpt-5") || model.contains("codex") {
        (1.25, 0.125, 10.0)
    } else {
        return None;
    };
    Some(Pricing {
        input: values.0,
        cached: values.1,
        output: values.2,
    })
}

fn read_cache(path: &Path) -> UsageCache {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<UsageCache>(&raw).ok())
        .filter(|cache| cache.version == CACHE_VERSION)
        .unwrap_or_default()
}

fn write_cache(path: &Path, cache: &UsageCache) {
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(serialized) = serde_json::to_vec(cache) else {
        return;
    };
    let temporary = path.with_extension("json.tmp");
    if fs::write(&temporary, serialized).is_ok() {
        let _ = fs::remove_file(path);
        let _ = fs::rename(temporary, path);
    }
}

fn system_time_ms(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

use chrono::Datelike;
use chrono::Timelike;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_and_summarizes_local_token_events_without_reading_messages() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("quota-float-usage-{unique}"));
        let sessions = root.join("sessions/2026/07/18");
        fs::create_dir_all(&sessions).unwrap();
        let session = sessions.join("rollout-test.jsonl");
        let mut file = File::create(&session).unwrap();
        writeln!(file, r#"{{"timestamp":"2026-07-18T09:15:00Z","type":"turn_context","payload":{{"model":"gpt-5.6-sol"}}}}"#).unwrap();
        writeln!(file, r#"{{"timestamp":"2026-07-18T09:16:00Z","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":1000,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":20,"total_tokens":1100}}}}}}}}"#).unwrap();
        writeln!(file, r#"{{"timestamp":"2026-07-18T09:16:15Z","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":1000,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":20,"total_tokens":1100}}}}}}}}"#).unwrap();
        writeln!(file, r#"{{"timestamp":"2026-07-18T09:16:29Z","type":"event_msg","payload":{{"type":"turn_aborted"}}}}"#).unwrap();
        writeln!(file, r#"{{"timestamp":"2026-07-18T09:16:30Z","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":0,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":158602}}}}}}}}"#).unwrap();
        writeln!(file, r#"{{"timestamp":"2026-07-18T09:16:31Z","type":"event_msg","payload":{{"type":"thread_rolled_back"}}}}"#).unwrap();
        writeln!(file, r#"{{"timestamp":"2026-07-18T09:16:44Z","type":"event_msg","payload":{{"type":"task_complete"}}}}"#).unwrap();
        writeln!(file, r#"{{"timestamp":"2026-07-18T09:16:45Z","type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":0,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":999}}}}}}}}"#).unwrap();
        writeln!(file, r#"{{"timestamp":"2026-07-18T09:16:46Z","type":"event_msg","payload":{{"type":"thread_rolled_back"}}}}"#).unwrap();
        writeln!(file, r#"{{"timestamp":"2026-07-18T09:17:00Z","type":"event_msg","payload":{{"type":"user_message","message":"must never be collected"}}}}"#).unwrap();
        drop(file);
        let archived = root.join("archived_sessions");
        fs::create_dir_all(&archived).unwrap();
        fs::write(
            archived.join("rollout-archived.jsonl"),
            r#"{"timestamp":"2026-07-18T09:18:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":999999,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0,"total_tokens":1000000}}}}"#,
        )
        .unwrap();

        let now = DateTime::parse_from_rfc3339("2026-07-18T09:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let summary = collect_local_usage_from(&root, &root.join("cache.json"), now).unwrap();
        assert_eq!(summary.today.total_tokens, 159702);
        assert_eq!(summary.today.calls, 2);
        assert_eq!(summary.daily.len(), 1);
        assert_eq!(summary.daily[0].usage.cached_input_tokens, 800);
        assert_eq!(summary.models[0].model, "gpt-5.6-sol");
        assert!((summary.today.estimated_cost_usd - 0.00135).abs() < f64::EPSILON);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn matches_codexscope_reference_totals_and_pricing() {
        let usage = TokenBreakdown {
            input_tokens: 34_386_216,
            cached_input_tokens: 32_932_352,
            cache_write_input_tokens: 0,
            output_tokens: 85_236,
            reasoning_output_tokens: 22_021,
            total_tokens: 34_471_452,
            calls: 259,
            estimated_cost_usd: 0.0,
        };
        let cost = estimate_cost("gpt-5.6-sol", &usage);
        assert!((cost - 6.786234).abs() < 0.0000001);
        assert!((usage.cached_input_tokens as f64 / usage.input_tokens as f64 * 100.0 - 95.771957).abs() < 0.000001);
    }
}
