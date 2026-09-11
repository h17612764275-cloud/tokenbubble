use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub remaining_percent: f64,
    pub resets_at: Option<String>,
    pub window_seconds: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DailyTokenUsage {
    pub date: String,
    pub tokens: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenBreakdown {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub calls: u64,
    pub estimated_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HourlyTokenUsage {
    pub hour: String,
    pub tokens: u64,
    pub calls: u64,
    pub estimated_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DailyTokenBreakdown {
    pub date: String,
    pub usage: TokenBreakdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelTokenUsage {
    pub model: String,
    pub tokens: u64,
    pub calls: u64,
    pub estimated_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsageSummary {
    pub today: TokenBreakdown,
    pub last_hour: TokenBreakdown,
    pub hourly: Vec<HourlyTokenUsage>,
    pub daily: Vec<DailyTokenBreakdown>,
    pub models: Vec<ModelTokenUsage>,
    pub cache_hit_percent: f64,
    pub peak_hour: Option<String>,
    pub peak_hour_tokens: u64,
    pub usd_cny_rate: f64,
    pub exchange_rate_date: String,
    pub scanned_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub provider: String,
    pub display_name: String,
    pub plan: Option<String>,
    pub short_window: Option<UsageWindow>,
    pub weekly_window: Option<UsageWindow>,
    pub spark_weekly_window: Option<UsageWindow>,
    pub reset_credits: Option<u64>,
    pub reset_credit_expires_at: Vec<String>,
    pub daily_token_usage: Option<Vec<DailyTokenUsage>>,
    pub lifetime_tokens: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    pub local_usage: Option<LocalUsageSummary>,
    pub updated_at: String,
    pub status: String,
    pub message: Option<String>,
}

impl ProviderSnapshot {
    pub fn failure(status: &str, message: &str) -> Self {
        Self {
            provider: "codex".into(),
            display_name: "CODEX".into(),
            plan: None,
            short_window: None,
            weekly_window: None,
            spark_weekly_window: None,
            reset_credits: None,
            reset_credit_expires_at: Vec::new(),
            daily_token_usage: None,
            lifetime_tokens: None,
            peak_daily_tokens: None,
            local_usage: None,
            updated_at: chrono::Utc::now().to_rfc3339(),
            status: status.into(),
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetPreferences {
    pub locked: bool,
    #[serde(default)]
    pub position_locked: bool,
    #[serde(default = "default_widget_size")]
    pub widget_size: f64,
    #[serde(default = "default_accent_color")]
    pub accent_color: String,
    #[serde(default = "default_bubble_panel_accent_color")]
    pub bubble_panel_accent_color: String,
    #[serde(default = "default_widget_style")]
    pub widget_style: String,
    #[serde(default = "default_always_on_top")]
    pub always_on_top: bool,
    #[serde(default)]
    pub stay_expanded: bool,
    pub pinned_provider: Option<String>,
    pub auto_rotate_seconds: u64,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub voice_enabled: bool,
    #[serde(default = "default_voice_shortcut")]
    pub voice_shortcut: String,
    #[serde(default)]
    pub voice_input_device: Option<String>,
    #[serde(default = "default_voice_sensitivity")]
    pub voice_sensitivity: f32,
    #[serde(default = "default_voice_endpoint_seconds")]
    pub voice_endpoint_seconds: f32,
    #[serde(default)]
    pub voice_punctuation_enabled: bool,
    #[serde(default = "default_screenshot_shortcut")]
    pub screenshot_shortcut: String,
    #[serde(default)]
    pub screenshot_folder: String,
}

fn default_always_on_top() -> bool {
    true
}
fn default_widget_size() -> f64 {
    68.0
}
fn default_accent_color() -> String {
    "#b97892".into()
}
fn default_bubble_panel_accent_color() -> String {
    "#faa4ce".into()
}
fn default_widget_style() -> String {
    "bubble".into()
}
fn default_language() -> String {
    "zh-CN".into()
}
fn default_voice_shortcut() -> String {
    "Ctrl+Space".into()
}
fn default_voice_sensitivity() -> f32 {
    65.0
}
fn default_voice_endpoint_seconds() -> f32 {
    3.0
}
fn default_screenshot_shortcut() -> String {
    "Ctrl+P".into()
}
impl Default for WidgetPreferences {
    fn default() -> Self {
        Self {
            locked: false,
            position_locked: false,
            widget_size: default_widget_size(),
            accent_color: default_accent_color(),
            bubble_panel_accent_color: default_bubble_panel_accent_color(),
            widget_style: default_widget_style(),
            always_on_top: true,
            stay_expanded: false,
            pinned_provider: None,
            auto_rotate_seconds: 12,
            language: default_language(),
            voice_enabled: false,
            voice_shortcut: default_voice_shortcut(),
            voice_input_device: None,
            voice_sensitivity: default_voice_sensitivity(),
            voice_endpoint_seconds: default_voice_endpoint_seconds(),
            voice_punctuation_enabled: false,
            screenshot_shortcut: default_screenshot_shortcut(),
            screenshot_folder: String::new(),
        }
    }
}

impl WidgetPreferences {
    pub fn normalized(mut self) -> Self {
        self.auto_rotate_seconds = self.auto_rotate_seconds.clamp(5, 300);
        self.widget_size = self.widget_size.clamp(52.0, 100.0);
        if self.accent_color.len() != 7
            || !self.accent_color.starts_with('#')
            || !self.accent_color[1..].chars().all(|value| value.is_ascii_hexdigit())
        {
            self.accent_color = default_accent_color();
        }
        if self.bubble_panel_accent_color.len() != 7
            || !self.bubble_panel_accent_color.starts_with('#')
            || !self.bubble_panel_accent_color[1..]
                .chars()
                .all(|value| value.is_ascii_hexdigit())
        {
            self.bubble_panel_accent_color = default_bubble_panel_accent_color();
        }
        if self.widget_style != "bubble" && self.widget_style != "bottle" {
            self.widget_style = default_widget_style();
        }
        if self.pinned_provider.as_deref() != Some("codex") {
            self.pinned_provider = None;
        }
        if self.language != "en" && self.language != "zh-CN" {
            self.language = default_language();
        }
        if self.voice_shortcut.trim().is_empty() || self.voice_shortcut.len() > 64 {
            self.voice_shortcut = default_voice_shortcut();
        }
        self.voice_input_device = self.voice_input_device.and_then(|value| {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        });
        self.voice_sensitivity = if self.voice_sensitivity.is_finite() {
            self.voice_sensitivity.clamp(0.0, 100.0)
        } else {
            default_voice_sensitivity()
        };
        self.voice_endpoint_seconds = if self.voice_endpoint_seconds.is_finite() {
            self.voice_endpoint_seconds.clamp(1.0, 8.0)
        } else {
            default_voice_endpoint_seconds()
        };
        if self.screenshot_shortcut.trim().is_empty() || self.screenshot_shortcut.len() > 64 {
            self.screenshot_shortcut = default_screenshot_shortcut();
        }
        self.screenshot_folder = self.screenshot_folder.trim().to_string();
        self
    }
}

#[cfg(test)]
mod preference_tests {
    use super::WidgetPreferences;

    #[test]
    fn migrates_preferences_saved_before_bubble_panel_colors_existed() {
        let value = serde_json::from_str::<WidgetPreferences>(
            r##"{
                "locked": false,
                "positionLocked": false,
                "widgetSize": 68,
                "accentColor": "#c07090",
                "widgetStyle": "bubble",
                "alwaysOnTop": true,
                "stayExpanded": false,
                "pinnedProvider": null,
                "autoRotateSeconds": 12,
                "language": "zh-CN"
            }"##,
        )
        .unwrap()
        .normalized();

        assert_eq!(value.accent_color, "#c07090");
        assert_eq!(value.bubble_panel_accent_color, "#faa4ce");
        assert!(!value.voice_enabled);
        assert_eq!(value.voice_shortcut, "Ctrl+Space");
        assert_eq!(value.voice_input_device, None);
        assert_eq!(value.voice_sensitivity, 65.0);
        assert_eq!(value.voice_endpoint_seconds, 3.0);
        assert!(!value.voice_punctuation_enabled);
        assert_eq!(value.screenshot_shortcut, "Ctrl+P");
        assert_eq!(value.screenshot_folder, "");
    }

    #[test]
    fn normalizes_panel_colors_independently() {
        let mut value = WidgetPreferences::default();
        value.accent_color = "#123456".into();
        value.bubble_panel_accent_color = "invalid".into();
        let value = value.normalized();

        assert_eq!(value.accent_color, "#123456");
        assert_eq!(value.bubble_panel_accent_color, "#faa4ce");
    }
}
