import {
  ArrowClockwise,
  Camera,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  Eye,
  Eyedropper,
  EyeSlash,
  GearSix,
  Microphone,
  Minus,
  Palette,
  Plus,
  PushPin,
  TShirt,
  X,
} from "@phosphor-icons/react";
import { memo, type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { getUsageCalendar, recordTokenUsage, recordUsage, tokenHeatLevel, visibleTokenPeak } from "../lib/usageHistory";
import { getTodayUsagePercent, recordDailyUsage } from "../lib/dailyUsage";
import { clampPercent } from "../lib/format";
import { normalizeLanguage } from "../lib/i18n";
import { finishPanelResize, getFloatingWidgetVisible, getVoiceInputDevices, startPanelResize, type PanelResizeDirection } from "../lib/bridge";
import { FIXED_BUBBLE_PANEL_ACCENT, hexToRgb, hsvToRgb, isDarkPanelColor, panelAccentColor, rgbToHex, rgbToHsv } from "../lib/skin";
import { formatEstimatedCost, nextCostCurrency, type CostCurrency } from "../lib/currency";
import { nextUsageRange, selectUsageRange, type UsageRange } from "../lib/usageRange";
import { getVoiceCalendar } from "../lib/voiceHistory";
import { localDateKey, monthGrid } from "../lib/calendar";
import type { ProviderSnapshot, TokenBreakdown, VoiceEvent, WidgetPreferences, WidgetStyle } from "../types";
import { ScreenshotSettingsDialog } from "./ScreenshotSettingsDialog";

interface Props {
  snapshot: ProviderSnapshot;
  preferences: WidgetPreferences;
  operationError: string | null;
  onRefresh: () => void;
  onToggleWidget: () => Promise<boolean>;
  onTogglePositionLock: () => Promise<void>;
  onResizeWidget: (larger: boolean) => Promise<void>;
  onPanelColorChange: (color: string) => Promise<void>;
  onSkinChange: (widgetStyle: WidgetStyle) => Promise<void>;
  voiceEvent: VoiceEvent;
  voiceRevision: number;
  onVoicePreferencesChange: (enabled: boolean, shortcut: string, inputDevice: string | null, sensitivity: number, endpointSeconds: number, punctuationEnabled: boolean) => void;
  onScreenshotPreferencesChange: (shortcut: string, folder: string) => void;
}

const WEEKDAYS_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAYS_EN = ["M", "T", "W", "T", "F", "S", "S"];
const MEMBERSHIP_EXPIRY_KEY = "quota-float:membership-expiry";
const COST_CURRENCY_KEY = "quota-float:cost-currency";
const WEEKLY_TOKEN_TARGET = 20_000_000_000;
const PANEL_COLOR_PRESETS = ["#faa4ce", "#d486e8", "#9a8cf2", "#72b7ea", "#6fcfc9", "#e6a56f", "#c77b91", "#75809a"];
const RESIZE_HANDLES: Array<{ direction: PanelResizeDirection; className: string }> = [
  { direction: "North", className: "north" },
  { direction: "East", className: "east" },
  { direction: "South", className: "south" },
  { direction: "West", className: "west" },
  { direction: "NorthEast", className: "north-east" },
  { direction: "SouthEast", className: "south-east" },
  { direction: "SouthWest", className: "south-west" },
  { direction: "NorthWest", className: "north-west" },
];
const EMPTY_BREAKDOWN: TokenBreakdown = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  calls: 0,
  estimatedCostUsd: 0,
};

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return Math.round(tokens).toLocaleString();
}

function heatLevel(value: number | null, tokens: number | null, tokenReference: number): number {
  if (tokens !== null) return tokenHeatLevel(tokens, tokenReference);
  if (value === null || value <= 0) return 0;
  const percent = clampPercent(value);
  if (percent < 20) return 1;
  if (percent < 40) return 2;
  if (percent < 65) return 3;
  return 4;
}

export const TrayPanel = memo(function TrayPanel({
  snapshot,
  preferences,
  operationError,
  onRefresh,
  onToggleWidget,
  onTogglePositionLock,
  onResizeWidget,
  onPanelColorChange,
  onSkinChange,
  voiceEvent,
  voiceRevision,
  onVoicePreferencesChange,
  onScreenshotPreferencesChange,
}: Props) {
  const language = normalizeLanguage(preferences.language);
  const zh = language === "zh-CN";
  const bubbleSkin = preferences.widgetStyle === "bubble";
  const panelAccent = panelAccentColor(preferences);
  const weeklyRemaining = snapshot.weeklyWindow
    ? clampPercent(snapshot.weeklyWindow.remainingPercent)
    : null;
  const [todayWeeklyPercent, setTodayWeeklyPercent] = useState(() => getTodayUsagePercent() ?? 0);
  const [widgetVisible, setWidgetVisible] = useState(true);
  const [usageRange, setUsageRange] = useState<UsageRange>("today");
  const [historyFace, setHistoryFace] = useState<"tokens" | "voice">("tokens");
  const [historyFlip, setHistoryFlip] = useState<"to-voice" | "to-tokens" | null>(null);
  const [shortcutSettingsOpen, setShortcutSettingsOpen] = useState(false);
  const [screenshotSettingsOpen, setScreenshotSettingsOpen] = useState(false);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [voiceInputDevices, setVoiceInputDevices] = useState<string[]>([]);
  const [voiceDevicesLoading, setVoiceDevicesLoading] = useState(false);
  const [draftVoiceSensitivity, setDraftVoiceSensitivity] = useState(preferences.voiceSensitivity);
  const [draftVoiceEndpointSeconds, setDraftVoiceEndpointSeconds] = useState(preferences.voiceEndpointSeconds);
  const [renewalCalendarOpen, setRenewalCalendarOpen] = useState(false);
  const [draftMembershipExpiry, setDraftMembershipExpiry] = useState("");
  const [panelColorDialogOpen, setPanelColorDialogOpen] = useState(false);
  const [draftPanelColor, setDraftPanelColor] = useState(panelAccent);
  const [panelColorHue, setPanelColorHue] = useState(() => rgbToHsv(...(hexToRgb(panelAccent) ?? [250, 164, 206]))[0]);
  const [calendarCursor, setCalendarCursor] = useState(() => {
    const today = new Date();
    return { year: today.getFullYear(), month: today.getMonth() };
  });
  const [costCurrency, setCostCurrency] = useState<CostCurrency>(() => {
    try {
      return window.localStorage.getItem(COST_CURRENCY_KEY) === "USD" ? "USD" : "CNY";
    } catch {
      return "CNY";
    }
  });
  const [membershipExpiry, setMembershipExpiry] = useState(() => {
    try {
      return window.localStorage.getItem(MEMBERSHIP_EXPIRY_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const shortcutCaptureButton = useRef<HTMLButtonElement>(null);

  const localUsage = snapshot.localUsage;
  const localDaily = useMemo(
    () => localUsage?.daily.map((day) => ({ date: day.date, tokens: day.usage.totalTokens })) ?? null,
    [localUsage?.daily],
  );
  const profileDaily = snapshot.dailyTokenUsage ?? null;
  const historySource = profileDaily?.length ? profileDaily : localDaily;
  const history = useMemo(() => getUsageCalendar(historySource), [historySource]);
  const currentDate = localDateKey();
  const profileToday = profileDaily?.find((day) => day.date === currentDate)?.tokens ?? 0;
  const estimatedToday = WEEKLY_TOKEN_TARGET * todayWeeklyPercent / 100;
  const today = localUsage?.today ?? {
    ...EMPTY_BREAKDOWN,
    totalTokens: profileToday || estimatedToday,
  };
  const rangeSelection = useMemo(
    () => selectUsageRange(localUsage, usageRange),
    [localUsage, usageRange],
  );
  const selectedUsage = localUsage ? rangeSelection.breakdown : today;
  const chartRows = rangeSelection.chart;
  const maxChartTokens = Math.max(1, ...chartRows.map((row) => row.tokens));
  const heatReferenceTokens = visibleTokenPeak(history);
  const totalTokenCount = history.reduce((sum, day) => sum + (day.tokens ?? 0), 0);
  const voiceHistory = useMemo(() => getVoiceCalendar(), [voiceRevision]);

  useEffect(() => {
    let cancelled = false;
    void getFloatingWidgetVisible()
      .then((visible) => {
        if (!cancelled) setWidgetVisible(visible);
      })
      .catch(() => {
        if (!cancelled) setWidgetVisible(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const todayVoiceCharacters = voiceHistory.at(-1)?.characters ?? 0;
  const totalVoiceCharacters = voiceHistory.reduce((sum, day) => sum + day.characters, 0);
  const voicePeak = Math.max(1, ...voiceHistory.map((day) => day.characters));
  const voiceStatusLabel = voiceEvent.status === "error"
    ? (voiceEvent.message ?? (zh ? "启动失败" : "Failed"))
    : voiceEvent.status === "starting"
      ? (zh ? "启动中" : "Starting")
    : voiceEvent.status === "listening"
      ? (zh ? "聆听中" : "Listening")
      : voiceEvent.status === "recognizing"
        ? (zh ? "识别中" : "Recognizing")
        : preferences.voiceEnabled ? (zh ? "已开启" : "On") : (zh ? "点击开启" : "Tap to start");

  const captureShortcut = (event: KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (event.key === "Escape") {
      setCapturingShortcut(false);
      return;
    }
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
    const key = event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
    const parts = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta", key].filter(Boolean);
    if (parts.length < 2) return;
    onVoicePreferencesChange(preferences.voiceEnabled, parts.join("+"), preferences.voiceInputDevice, preferences.voiceSensitivity, preferences.voiceEndpointSeconds, preferences.voicePunctuationEnabled);
    setCapturingShortcut(false);
  };

  const saveVoiceSensitivity = (value: number) => {
    const next = Math.min(100, Math.max(0, Math.round(value)));
    setDraftVoiceSensitivity(next);
    if (next !== preferences.voiceSensitivity) {
      onVoicePreferencesChange(preferences.voiceEnabled, preferences.voiceShortcut, preferences.voiceInputDevice, next, preferences.voiceEndpointSeconds, preferences.voicePunctuationEnabled);
    }
  };

  const saveVoiceEndpointSeconds = (value: number) => {
    const next = Math.min(8, Math.max(1, Math.round(value * 2) / 2));
    setDraftVoiceEndpointSeconds(next);
    if (next !== preferences.voiceEndpointSeconds) {
      onVoicePreferencesChange(preferences.voiceEnabled, preferences.voiceShortcut, preferences.voiceInputDevice, preferences.voiceSensitivity, next, preferences.voicePunctuationEnabled);
    }
  };

  const toggleHistoryFace = () => {
    const next = historyFace === "tokens" ? "voice" : "tokens";
    setHistoryFlip(next === "voice" ? "to-voice" : "to-tokens");
    setHistoryFace(next);
  };

  const composition = [
    { key: "input", label: zh ? "输入" : "Input" },
    { key: "cache", label: zh ? "缓存" : "Cache" },
    { key: "output", label: zh ? "输出" : "Output" },
    { key: "reasoning", label: zh ? "推理" : "Reasoning" },
  ];

  const updated = new Date(snapshot.updatedAt);
  const updatedLabel = Number.isNaN(updated.getTime())
    ? "--:--"
    : updated.toLocaleTimeString(zh ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" });
  const membershipRenewal = useMemo(() => {
    if (!membershipExpiry) {
      return { dateLabel: zh ? "选择日期" : "Choose date", relativeLabel: "" };
    }
    const [year, month, day] = membershipExpiry.split("-").map(Number);
    const renewalDate = new Date(year, month - 1, day);
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const daysAway = Math.round((renewalDate.getTime() - todayDate.getTime()) / 86_400_000);
    const dateLabel = zh
      ? `${month}月${day}日`
      : renewalDate.toLocaleDateString("en", { month: "short", day: "numeric" });
    const relativeLabel = daysAway === 0
      ? (zh ? "今天" : "Today")
      : daysAway > 0
        ? (zh ? `${daysAway}天后` : `in ${daysAway}d`)
        : (zh ? `已过期${Math.abs(daysAway)}天` : `${Math.abs(daysAway)}d overdue`);
    return { dateLabel, relativeLabel };
  }, [membershipExpiry, zh]);

  useEffect(() => {
    recordUsage(snapshot);
    recordTokenUsage(historySource);
    setTodayWeeklyPercent(recordDailyUsage(snapshot) ?? 0);
  }, [historySource, snapshot]);

  useEffect(() => {
    if (capturingShortcut) shortcutCaptureButton.current?.focus();
  }, [capturingShortcut]);

  useEffect(() => {
    if (!shortcutSettingsOpen) {
      setDraftVoiceSensitivity(preferences.voiceSensitivity);
      setDraftVoiceEndpointSeconds(preferences.voiceEndpointSeconds);
    }
  }, [preferences.voiceEndpointSeconds, preferences.voiceSensitivity, shortcutSettingsOpen]);

  useEffect(() => {
    if (!shortcutSettingsOpen) return;
    let cancelled = false;
    setVoiceDevicesLoading(true);
    void getVoiceInputDevices()
      .then((devices) => { if (!cancelled) setVoiceInputDevices(devices); })
      .catch(() => { if (!cancelled) setVoiceInputDevices([]); })
      .finally(() => { if (!cancelled) setVoiceDevicesLoading(false); });
    return () => { cancelled = true; };
  }, [shortcutSettingsOpen]);

  useEffect(() => {
    const finishResize = () => finishPanelResize();
    window.addEventListener("mouseup", finishResize, true);
    window.addEventListener("pointercancel", finishResize, true);
    return () => {
      window.removeEventListener("mouseup", finishResize, true);
      window.removeEventListener("pointercancel", finishResize, true);
    };
  }, []);

  const updateMembershipExpiry = (value: string) => {
    setMembershipExpiry(value);
    try {
      if (value) window.localStorage.setItem(MEMBERSHIP_EXPIRY_KEY, value);
      else window.localStorage.removeItem(MEMBERSHIP_EXPIRY_KEY);
    } catch {
      // Keep the in-memory date when local storage is unavailable.
    }
  };

  const openMembershipDatePicker = () => {
    const selected = membershipExpiry ? new Date(`${membershipExpiry}T00:00:00`) : new Date();
    setDraftMembershipExpiry(membershipExpiry);
    setCalendarCursor({ year: selected.getFullYear(), month: selected.getMonth() });
    setRenewalCalendarOpen(true);
  };

  const calendarDays = useMemo(
    () => monthGrid(calendarCursor.year, calendarCursor.month),
    [calendarCursor.month, calendarCursor.year],
  );

  const shiftCalendarMonth = (offset: number) => {
    const next = new Date(calendarCursor.year, calendarCursor.month + offset, 1);
    setCalendarCursor({ year: next.getFullYear(), month: next.getMonth() });
  };

  const openPanelColorPicker = () => {
    setDraftPanelColor(panelAccent);
    setPanelColorHue(rgbToHsv(...(hexToRgb(panelAccent) ?? [250, 164, 206]))[0]);
    setPanelColorDialogOpen(true);
  };

  const validDraftPanelColor = /^#[0-9a-f]{6}$/i.test(draftPanelColor);
  const panelColorRgb = hexToRgb(validDraftPanelColor ? draftPanelColor : panelAccent) ?? [250, 164, 206];
  const [, panelColorSaturation, panelColorValue] = rgbToHsv(...panelColorRgb);
  const setValidDraftPanelColor = (color: string) => {
    const rgb = hexToRgb(color);
    if (rgb) {
      const [hue, saturation] = rgbToHsv(...rgb);
      if (saturation > 0) setPanelColorHue(hue);
    }
    setDraftPanelColor(color);
  };
  const updatePanelColorChannel = (index: number, value: number) => {
    const next = [...panelColorRgb] as [number, number, number];
    next[index] = value;
    setValidDraftPanelColor(rgbToHex(...next));
  };
  const updatePanelColorField = (element: HTMLDivElement, clientX: number, clientY: number) => {
    const bounds = element.getBoundingClientRect();
    const saturation = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
    const value = 1 - Math.min(1, Math.max(0, (clientY - bounds.top) / bounds.height));
    setDraftPanelColor(rgbToHex(...hsvToRgb(panelColorHue, saturation, value)));
  };
  const updatePanelColorHue = (hue: number) => {
    setPanelColorHue(hue);
    setDraftPanelColor(rgbToHex(...hsvToRgb(hue, panelColorSaturation, panelColorValue)));
  };
  const pickScreenColor = async () => {
    const EyeDropperApi = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!EyeDropperApi) return;
    try {
      setValidDraftPanelColor((await new EyeDropperApi().open()).sRGBHex);
    } catch {
      // Escape cancels the native eyedropper without changing the draft color.
    }
  };

  const toggleCostCurrency = () => {
    const next = nextCostCurrency(costCurrency);
    setCostCurrency(next);
    try {
      window.localStorage.setItem(COST_CURRENCY_KEY, next);
    } catch {
      // Keep the in-memory currency when local storage is unavailable.
    }
  };

  const toggleUsageRange = () => setUsageRange((current) => nextUsageRange(current));
  const rangeTokenLabel = usageRange === "today"
    ? (zh ? "今日 Token" : "Today tokens")
    : usageRange === "7d"
      ? (zh ? "近7天 Token" : "7-day tokens")
      : (zh ? "近30天 Token" : "30-day tokens");
  const rangeCostLabel = usageRange === "today"
    ? (zh ? "今日花费" : "Today cost")
    : usageRange === "7d"
      ? (zh ? "近7天花费" : "7-day cost")
      : (zh ? "近30天花费" : "30-day cost");
  const rangeChartLabel = usageRange === "today"
    ? (zh ? "今日 Token 消耗" : "Today's token usage")
    : usageRange === "7d"
      ? (zh ? "近7天 Token 消耗" : "7-day token usage")
      : (zh ? "近30天 Token 消耗" : "30-day token usage");
  const rangeDetailLabel = usageRange === "today"
    ? (zh ? "今日按小时" : "Hourly today")
    : usageRange === "7d"
      ? (zh ? "最近7天按日" : "Last 7 days")
      : (zh ? "最近30天按日" : "Last 30 days");
  const formattedCost = formatEstimatedCost(
    selectedUsage.estimatedCostUsd,
    costCurrency,
    localUsage?.usdCnyRate,
  );

  return (
    <main
      className={`tray-panel tray-panel--skin-${preferences.widgetStyle}`}
      data-skin={preferences.widgetStyle}
      data-panel-tone={isDarkPanelColor(panelAccent) ? "dark" : "light"}
      style={{ "--theme-accent": panelAccent, "--panel-accent": panelAccent } as CSSProperties}
    >
      <div className="tray-panel__wash" aria-hidden="true" />
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.direction}
          className={`panel-resize-handle panel-resize-handle--${handle.className}`}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            void startPanelResize(handle.direction);
          }}
          aria-hidden="true"
        />
      ))}

      <header className="tray-panel__header">
        <div className="tray-brand">
          <span className={`tray-brand__mark${bubbleSkin ? " tray-brand__mark--bubble" : ""}`}>
            {bubbleSkin ? <i aria-hidden="true" /> : "W"}
          </span>
          <div>
            <strong>Token Bubble</strong>
            <small>{zh ? `刷新 ${updatedLabel}` : `Updated ${updatedLabel}`}</small>
          </div>
        </div>
        <div
          className="tray-reset"
          onClick={openMembershipDatePicker}
        >
          <button
            className="renewal-calendar-button"
            type="button"
            aria-label={zh ? "设置续费日期" : "Set renewal date"}
            title={zh ? "设置续费日期" : "Set renewal date"}
          >
            <CalendarBlank weight="duotone" />
          </button>
          <div className="membership-date">
            <span>{zh ? "下次续费" : "Next renewal"}</span>
            <strong className="membership-date__value">
              {membershipRenewal.dateLabel}
              {membershipRenewal.relativeLabel && <em> · {membershipRenewal.relativeLabel}</em>}
            </strong>
          </div>
        </div>
        <button
          className="tray-icon-button screenshot-settings-button"
          type="button"
          onClick={() => setScreenshotSettingsOpen(true)}
          aria-expanded={screenshotSettingsOpen}
          aria-label={zh ? "截图设置" : "Screenshot settings"}
          title={zh ? "截图设置" : "Screenshot settings"}
        >
          <Camera weight="duotone" />
        </button>
        <button
          className="tray-icon-button"
          type="button"
          onClick={onRefresh}
          aria-label={zh ? "立即刷新" : "Refresh now"}
          title={zh ? "立即刷新" : "Refresh now"}
        >
          <ArrowClockwise />
        </button>
      </header>

      {screenshotSettingsOpen ? (
        <ScreenshotSettingsDialog
          preferences={preferences}
          zh={zh}
          onClose={() => setScreenshotSettingsOpen(false)}
          onSave={onScreenshotPreferencesChange}
        />
      ) : null}

      {renewalCalendarOpen ? (
        <div className="voice-shortcut-backdrop renewal-calendar-backdrop" onMouseDown={() => setRenewalCalendarOpen(false)}>
          <section
            className="voice-shortcut-dialog renewal-calendar-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="renewal-calendar-title"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") setRenewalCalendarOpen(false); }}
          >
            <header>
              <div>
                <strong id="renewal-calendar-title">{zh ? "设置下次续费日期" : "Set next renewal date"}</strong>
                <span>{zh ? "选择日期后点击完成" : "Choose a date, then confirm"}</span>
              </div>
              <button type="button" autoFocus onClick={() => setRenewalCalendarOpen(false)} aria-label={zh ? "关闭日期设置" : "Close date settings"}><X /></button>
            </header>
            <div className="renewal-calendar__toolbar">
              <strong>{new Intl.DateTimeFormat(language, { year: "numeric", month: "long" }).format(new Date(calendarCursor.year, calendarCursor.month, 1))}</strong>
              <span>
                <button type="button" onClick={() => shiftCalendarMonth(-1)} aria-label={zh ? "上个月" : "Previous month"}><CaretLeft /></button>
                <button type="button" onClick={() => shiftCalendarMonth(1)} aria-label={zh ? "下个月" : "Next month"}><CaretRight /></button>
              </span>
            </div>
            <div className="renewal-calendar__weekdays" aria-hidden="true">
              {(zh ? WEEKDAYS_ZH : WEEKDAYS_EN).map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
            </div>
            <div className="renewal-calendar__days">
              {calendarDays.map((day) => (
                <button
                  key={day.date}
                  type="button"
                  className={`${day.inMonth ? "" : "is-outside"}${day.date === draftMembershipExpiry ? " is-selected" : ""}${day.date === currentDate ? " is-today" : ""}`}
                  aria-pressed={day.date === draftMembershipExpiry}
                  onClick={() => {
                    setDraftMembershipExpiry(day.date);
                    if (!day.inMonth) {
                      const selected = new Date(`${day.date}T00:00:00`);
                      setCalendarCursor({ year: selected.getFullYear(), month: selected.getMonth() });
                    }
                  }}
                >
                  {day.day}
                </button>
              ))}
            </div>
            <footer>
              <button type="button" onClick={() => setDraftMembershipExpiry("")}>{zh ? "清除日期" : "Clear"}</button>
              <button type="button" className="is-primary" onClick={() => { updateMembershipExpiry(draftMembershipExpiry); setRenewalCalendarOpen(false); }}>{zh ? "完成" : "Done"}</button>
            </footer>
          </section>
        </div>
      ) : null}

      {panelColorDialogOpen ? (
        <div className="voice-shortcut-backdrop panel-color-backdrop" onMouseDown={() => setPanelColorDialogOpen(false)}>
          <section
            className="voice-shortcut-dialog panel-color-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="panel-color-title"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape") setPanelColorDialogOpen(false); }}
          >
            <header>
              <div>
                <strong id="panel-color-title">{zh ? "面板配色" : "Panel color"}</strong>
                <span>{zh ? "快速取色、吸色或精确调整 RGB" : "Pick, sample, or adjust RGB"}</span>
              </div>
              <button type="button" autoFocus onClick={() => setPanelColorDialogOpen(false)} aria-label={zh ? "关闭配色设置" : "Close color settings"}><X /></button>
            </header>
            <div className="panel-color__current">
              <i style={{ background: validDraftPanelColor ? draftPanelColor : panelAccent }} aria-hidden="true" />
              <label>
                <span>{zh ? "颜色值" : "Hex color"}</span>
                <input
                  value={draftPanelColor}
                  maxLength={7}
                  spellCheck={false}
                  aria-invalid={!validDraftPanelColor}
                  onChange={(event) => setValidDraftPanelColor(event.currentTarget.value)}
                />
              </label>
              <button type="button" className="panel-color__eyedropper" onClick={() => void pickScreenColor()} disabled={!("EyeDropper" in window)} aria-label={zh ? "从屏幕吸取颜色" : "Pick a color from the screen"} title={zh ? "吸色器" : "Eyedropper"}>
                <Eyedropper weight="duotone" />
              </button>
            </div>
            <div
              className="panel-color__field"
              style={{ "--picker-hue": `hsl(${panelColorHue} 100% 50%)`, "--picker-x": `${panelColorSaturation * 100}%`, "--picker-y": `${(1 - panelColorValue) * 100}%` } as CSSProperties}
              role="slider"
              tabIndex={0}
              aria-label={zh ? "颜色明暗与饱和度" : "Color saturation and brightness"}
              aria-valuetext={`${Math.round(panelColorSaturation * 100)}%, ${Math.round(panelColorValue * 100)}%`}
              onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); updatePanelColorField(event.currentTarget, event.clientX, event.clientY); }}
              onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePanelColorField(event.currentTarget, event.clientX, event.clientY); }}
              onKeyDown={(event) => {
                const step = event.shiftKey ? .1 : .02;
                const nextSaturation = event.key === "ArrowLeft" ? panelColorSaturation - step : event.key === "ArrowRight" ? panelColorSaturation + step : panelColorSaturation;
                const nextValue = event.key === "ArrowDown" ? panelColorValue - step : event.key === "ArrowUp" ? panelColorValue + step : panelColorValue;
                if (nextSaturation !== panelColorSaturation || nextValue !== panelColorValue) {
                  event.preventDefault();
                  setDraftPanelColor(rgbToHex(...hsvToRgb(panelColorHue, nextSaturation, nextValue)));
                }
              }}
            ><i aria-hidden="true" /></div>
            <input className="panel-color__hue" type="range" min="0" max="359" value={Math.round(panelColorHue)} onChange={(event) => updatePanelColorHue(Number(event.currentTarget.value))} aria-label={zh ? "色相" : "Hue"} />
            <div className="panel-color__presets" aria-label={zh ? "推荐颜色" : "Recommended colors"}>
              {PANEL_COLOR_PRESETS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={color.toLowerCase() === draftPanelColor.toLowerCase() ? "is-selected" : ""}
                  style={{ "--swatch": color } as CSSProperties}
                  onClick={() => setValidDraftPanelColor(color)}
                  aria-label={color}
                  aria-pressed={color.toLowerCase() === draftPanelColor.toLowerCase()}
                />
              ))}
            </div>
            <div className="panel-color__channels">
              {["R", "G", "B"].map((channel, index) => (
                <label key={channel}>
                  <span>{channel}</span>
                  <input
                    type="range"
                    min="0"
                    max="255"
                    value={panelColorRgb[index]}
                    style={{ accentColor: validDraftPanelColor ? draftPanelColor : panelAccent }}
                    onChange={(event) => updatePanelColorChannel(index, Number(event.currentTarget.value))}
                  />
                  <output>{panelColorRgb[index]}</output>
                </label>
              ))}
            </div>
            <footer>
              <button type="button" onClick={() => setDraftPanelColor(bubbleSkin ? FIXED_BUBBLE_PANEL_ACCENT : "#b97892")}>{zh ? "恢复默认" : "Reset"}</button>
              <button type="button" className="is-primary" disabled={!validDraftPanelColor} onClick={() => { void onPanelColorChange(draftPanelColor.toLowerCase()); setPanelColorDialogOpen(false); }}>{zh ? "完成" : "Done"}</button>
            </footer>
          </section>
        </div>
      ) : null}

      <section className="tray-overview tray-surface">
        <div
          className="quota-ring"
          style={{ "--ring-value": `${weeklyRemaining === null ? 0 : weeklyRemaining * 3.6}deg` } as CSSProperties}
          role="progressbar"
          aria-label={zh ? "周额度剩余" : "Weekly quota remaining"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={weeklyRemaining ?? undefined}
        >
          <div>
            <strong>{weeklyRemaining ?? "--"}<sup>{weeklyRemaining === null ? "" : "%"}</sup></strong>
            <span>{zh ? "周额度剩余" : "Weekly left"}</span>
          </div>
        </div>
        <button
          type="button"
          className="overview-metric overview-metric--tokens overview-metric--range"
          onClick={toggleUsageRange}
          title={zh ? "点击切换今日、7天和30天" : "Switch today, 7 days, and 30 days"}
          aria-label={`${rangeTokenLabel} ${formatTokenCount(selectedUsage.totalTokens)}`}
        >
          <span>{rangeTokenLabel}</span>
          <strong>{formatTokenCount(selectedUsage.totalTokens)}</strong>
        </button>
        <div className="overview-metric overview-metric--cost">
          <button
            type="button"
            className="overview-metric__range-button"
            onClick={toggleUsageRange}
            title={zh ? "点击切换今日、7天和30天" : "Switch today, 7 days, and 30 days"}
            aria-label={rangeCostLabel}
          >
            {rangeCostLabel}
          </button>
          <button
            type="button"
            className={`overview-metric__currency-button${formattedCost.length >= 7 ? " is-compact" : ""}`}
            onClick={toggleCostCurrency}
            title={zh ? `点击切换人民币/美元 · 汇率日期 ${localUsage?.exchangeRateDate ?? "--"}` : `Toggle CNY/USD · FX date ${localUsage?.exchangeRateDate ?? "--"}`}
            aria-label={`${rangeCostLabel} ${formattedCost}. ${zh ? "切换人民币和美元" : "Toggle CNY and USD"}`}
          >
            <em>估算</em>
            <strong>{formattedCost}</strong>
          </button>
        </div>
        <button
          type="button"
          className="token-composition"
          onClick={toggleUsageRange}
          title={zh ? "点击切换今日、7天和30天" : "Switch today, 7 days, and 30 days"}
          aria-label={`${rangeTokenLabel} ${zh ? "构成" : "composition"}`}
        >
          <span className="token-composition__bar">
            {composition.map((item) => (
              <i
                key={item.key}
                className={`token-part token-part--${item.key}`}
              />
            ))}
          </span>
          <span className="token-composition__legend">
            {composition.map((item) => <span key={item.key} className={`token-label token-label--${item.key}`}>{item.label}</span>)}
          </span>
        </button>
      </section>

      <section className="voice-strip tray-surface" aria-label={zh ? "语音输入" : "Voice input"}>
        <button type="button" className={`voice-strip__toggle${preferences.voiceEnabled ? " is-active" : ""}`} onClick={() => onVoicePreferencesChange(!preferences.voiceEnabled, preferences.voiceShortcut, preferences.voiceInputDevice, preferences.voiceSensitivity, preferences.voiceEndpointSeconds, preferences.voicePunctuationEnabled)} aria-pressed={preferences.voiceEnabled} title={zh ? "开启后持续聆听；再次点击关闭" : "Listen continuously until turned off"}>
          <Microphone weight={preferences.voiceEnabled ? "fill" : "duotone"} />
        </button>
        <div className="voice-strip__count">
          <strong><span>{zh ? "今日字数：" : "Today: "}</span><b>{todayVoiceCharacters.toLocaleString()}{zh ? "字" : " chars"}</b></strong>
        </div>
        <div className={`voice-strip__status${voiceEvent.status === "error" ? " is-error" : ""}`}>
          <span>{zh ? "语音模式" : "Voice mode"}</span>
          <strong title={voiceStatusLabel}>{voiceStatusLabel}</strong>
        </div>
        <button type="button" className="voice-strip__settings" onClick={() => { setDraftVoiceSensitivity(preferences.voiceSensitivity); setDraftVoiceEndpointSeconds(preferences.voiceEndpointSeconds); setShortcutSettingsOpen(true); setCapturingShortcut(false); }} aria-expanded={shortcutSettingsOpen} aria-label={zh ? "设置语音输入" : "Set voice input"} title={zh ? "设置快捷键、设备、灵敏度和断句" : "Set shortcut, device, sensitivity, and endpoint"}>
          <GearSix weight="duotone" />
        </button>
      </section>

      {shortcutSettingsOpen ? (
        <div className="voice-shortcut-backdrop" onMouseDown={() => { setShortcutSettingsOpen(false); setCapturingShortcut(false); }}>
          <section className="voice-shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="voice-shortcut-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong id="voice-shortcut-title">{zh ? "语音识别开关快捷键" : "Voice toggle shortcut"}</strong>
                <span>{zh ? "按一次启动持续识别，再按一次关闭" : "Press once to start continuous recognition, again to stop"}</span>
              </div>
              <button type="button" onClick={() => { setShortcutSettingsOpen(false); setCapturingShortcut(false); }} aria-label={zh ? "关闭" : "Close"}>×</button>
            </header>
            <div className="voice-shortcut-current">
              <span>{zh ? "当前快捷键" : "Current shortcut"}</span>
              <kbd>{preferences.voiceShortcut}</kbd>
            </div>
            <label className="voice-input-device">
              <span>{zh ? "语音输入设备" : "Voice input device"}</span>
              <select
                value={preferences.voiceInputDevice ?? ""}
                onChange={(event) => onVoicePreferencesChange(preferences.voiceEnabled, preferences.voiceShortcut, event.target.value || null, preferences.voiceSensitivity, preferences.voiceEndpointSeconds, preferences.voicePunctuationEnabled)}
              >
                <option value="">{voiceDevicesLoading ? (zh ? "正在读取设备…" : "Loading devices…") : (zh ? "跟随系统默认" : "Follow system default")}</option>
                {preferences.voiceInputDevice && !voiceInputDevices.includes(preferences.voiceInputDevice) ? <option value={preferences.voiceInputDevice}>{preferences.voiceInputDevice}</option> : null}
                {voiceInputDevices.map((device) => <option key={device} value={device}>{device}</option>)}
              </select>
            </label>
            <label className="voice-sensitivity">
              <span><b>{zh ? "识别灵敏度" : "Recognition sensitivity"}</b><output>{draftVoiceSensitivity}%</output></span>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={draftVoiceSensitivity}
                onChange={(event) => setDraftVoiceSensitivity(Number(event.target.value))}
                onPointerUp={(event) => saveVoiceSensitivity(Number(event.currentTarget.value))}
                onKeyUp={(event) => saveVoiceSensitivity(Number(event.currentTarget.value))}
                aria-label={zh ? "语音识别灵敏度" : "Voice recognition sensitivity"}
              />
              <small><span>{zh ? "低" : "Low"}</span><span>{zh ? "越高越容易被声音唤起" : "Higher reacts to quieter speech"}</span><span>{zh ? "高" : "High"}</span></small>
            </label>
            <label className="voice-sensitivity voice-endpoint">
              <span><b>{zh ? "连续静音提交等待" : "Continuous-silence submit wait"}</b><output>{draftVoiceEndpointSeconds.toFixed(draftVoiceEndpointSeconds % 1 ? 1 : 0)}s</output></span>
              <input
                type="range"
                min="1"
                max="8"
                step="0.5"
                value={draftVoiceEndpointSeconds}
                onChange={(event) => setDraftVoiceEndpointSeconds(Number(event.target.value))}
                onPointerUp={(event) => saveVoiceEndpointSeconds(Number(event.currentTarget.value))}
                onKeyUp={(event) => saveVoiceEndpointSeconds(Number(event.currentTarget.value))}
                aria-label={zh ? "连续静音后的文字提交等待时间" : "Continuous silence before submitting the segment"}
              />
              <small><span>1s</span><span>{zh ? "文字实时出现；静音达到此时间后确认本段" : "Text stays live; submit after continuous silence"}</span><span>8s</span></small>
            </label>
            <button
              type="button"
              className="voice-punctuation"
              role="switch"
              aria-checked={preferences.voicePunctuationEnabled}
              onClick={() =>
                onVoicePreferencesChange(
                  preferences.voiceEnabled,
                  preferences.voiceShortcut,
                  preferences.voiceInputDevice,
                  preferences.voiceSensitivity,
                  preferences.voiceEndpointSeconds,
                  !preferences.voicePunctuationEnabled
                )
              }
            >
              <span><b>{zh ? "自动标点" : "Automatic punctuation"}</b><small>{zh ? "关闭时，每次断句只添加一个空格" : "When off, append one space per segment"}</small></span>
              <span
                className={`voice-punctuation-toggle${preferences.voicePunctuationEnabled ? " is-on" : ""}`}
                aria-hidden="true"
              >
                <span />
              </span>
            </button>
            <button ref={shortcutCaptureButton} type="button" className={`voice-shortcut-capture${capturingShortcut ? " is-capturing" : ""}`} onClick={() => setCapturingShortcut(true)} onKeyDown={capturingShortcut ? captureShortcut : undefined}>
              {capturingShortcut ? (zh ? "现在按下新的组合键…" : "Press the new shortcut…") : (zh ? "更改快捷键" : "Change shortcut")}
            </button>
            <p>{zh ? "快捷键只切换识别开关；开启后无需按住，文字会边说边出现。" : "The shortcut toggles recognition. Keep speaking after starting; text appears live."}</p>
            <footer>
              <button type="button" onClick={() => { setDraftVoiceSensitivity(65); setDraftVoiceEndpointSeconds(3); onVoicePreferencesChange(preferences.voiceEnabled, "Ctrl+Space", null, 65, 3, false); setCapturingShortcut(false); }}>{zh ? "恢复默认" : "Reset"}</button>
              <button type="button" className="is-primary" onClick={() => { setShortcutSettingsOpen(false); setCapturingShortcut(false); }}>{zh ? "完成" : "Done"}</button>
            </footer>
          </section>
        </div>
      ) : null}

      <section className="tray-middle">
        <button
          type="button"
          className={`hourly-usage hourly-usage--${usageRange} tray-surface`}
          onClick={toggleUsageRange}
          title={zh ? "点击切换今日、7天和30天" : "Switch today, 7 days, and 30 days"}
          aria-label={`${rangeChartLabel} ${formatTokenCount(selectedUsage.totalTokens)}`}
        >
          <header>
            <div>
              <span>{rangeChartLabel}</span>
              <strong>{formatTokenCount(selectedUsage.totalTokens)}</strong>
              <small>{rangeDetailLabel} · {selectedUsage.calls} {zh ? "次调用" : "calls"}</small>
            </div>
          </header>
          <div
            className="hourly-chart"
            style={{ "--chart-columns": chartRows.length } as CSSProperties}
            aria-label={rangeChartLabel}
          >
            {chartRows.map((row, index) => {
              const labelStep = usageRange === "today" ? 6 : usageRange === "7d" ? 1 : 7;
              const showLabel = index % labelStep === 0 || index === chartRows.length - 1;
              return (
                <div className="hourly-bar" key={row.key} title={`${row.title} · ${formatTokenCount(row.tokens)}`}>
                  <i style={{ height: `${row.tokens === 0 ? 0 : Math.max(5, row.tokens / maxChartTokens * 100)}%` }} />
                  <span>{showLabel ? row.label : ""}</span>
                </div>
              );
            })}
          </div>
        </button>

        <aside className="widget-controls-card tray-surface" aria-label={zh ? "浮窗和皮肤控制" : "Widget and skin controls"}>
          <button
            type="button"
            className={widgetVisible ? "is-active" : ""}
            onClick={async () => {
              try {
                setWidgetVisible(await onToggleWidget());
              } catch {
                try {
                  setWidgetVisible(await getFloatingWidgetVisible());
                } catch {
                  setWidgetVisible((current) => !current);
                }
              }
            }}
            title={zh ? "显示或隐藏浮窗" : "Show or hide widget"}
            aria-label={zh ? "显示或隐藏浮窗" : "Show or hide widget"}
          >
            {widgetVisible ? <Eye weight="duotone" /> : <EyeSlash weight="duotone" />}
          </button>
          <button
            type="button"
            className={preferences.positionLocked ? "is-active" : ""}
            onClick={() => void onTogglePositionLock()}
            title={zh ? "固定或取消固定浮窗" : "Pin or unpin widget"}
            aria-label={zh ? "固定或取消固定浮窗" : "Pin or unpin widget"}
          >
            <PushPin weight={preferences.positionLocked ? "fill" : "duotone"} />
          </button>
          <button
            type="button"
            onClick={() => void onResizeWidget(true)}
            disabled={preferences.widgetSize >= 100}
            title={zh ? "放大浮窗" : "Enlarge widget"}
            aria-label={zh ? "放大浮窗" : "Enlarge widget"}
          >
            <Plus weight="bold" />
          </button>
          <button
            type="button"
            onClick={() => void onResizeWidget(false)}
            disabled={preferences.widgetSize <= 52}
            title={zh ? "缩小浮窗" : "Shrink widget"}
            aria-label={zh ? "缩小浮窗" : "Shrink widget"}
          >
            <Minus weight="bold" />
          </button>
          <button
            type="button"
            className="panel-color-control"
            title={zh ? "调整当前面板颜色" : "Adjust current panel color"}
            aria-label={zh ? "调整当前面板颜色" : "Adjust current panel color"}
            onClick={openPanelColorPicker}
          >
            <Palette weight="duotone" />
          </button>
          <button
            type="button"
            className="skin-switch-control"
            onClick={() => void onSkinChange(bubbleSkin ? "bottle" : "bubble")}
            title={bubbleSkin ? (zh ? "切换为平面面板和玻璃瓶浮窗" : "Switch to flat panel and bottle widget") : (zh ? "切换为肥皂泡面板和浮窗" : "Switch to soap-bubble panel and widget")}
            aria-label={bubbleSkin ? (zh ? "切换为平面皮肤" : "Switch to flat skin") : (zh ? "切换为肥皂泡皮肤" : "Switch to bubble skin")}
          >
            <TShirt weight={bubbleSkin ? "fill" : "duotone"} />
          </button>
        </aside>
      </section>

      <section className={`usage-history tray-surface${historyFlip ? ` usage-history--flip-${historyFlip}` : ""}`} role="button" tabIndex={0} onClick={toggleHistoryFace} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleHistoryFace(); } }} onAnimationEnd={() => setHistoryFlip(null)}>
        <header>
          <strong>{historyFace === "voice" ? (zh ? "近 90 天语音字数" : "Voice · last 90 days") : (zh ? "近 90 天用量" : "Last 90 days")}</strong>
          <span>{historyFace === "voice" ? (zh ? "点击翻回 Token" : "Click for tokens") : (zh ? "点击查看语音" : "Click for voice")}</span>
        </header>
        <div className="heatmap-wrap">
          <div className="weekday-labels">
            {(zh ? WEEKDAYS_ZH : WEEKDAYS_EN).map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
          </div>
          <div className="usage-heatmap" aria-label={historyFace === "voice" ? (zh ? "近 90 天语音字数热力图" : "90 day voice character heatmap") : (zh ? "近 90 天 Token 用量热力图" : "90 day token usage heatmap")}>
            {historyFace === "voice" ? voiceHistory.map((day) => (
              <i key={day.date} className={`heat-${tokenHeatLevel(day.characters, voicePeak)}`} title={`${day.date}: ${day.characters} ${zh ? "字" : "chars"}`} />
            )) : history.map((day) => (
              <i
                key={day.date}
                className={`heat-${heatLevel(day.usedPercent, day.tokens, heatReferenceTokens)}`}
                title={`${day.date}: ${day.tokens === null ? "--" : formatTokenCount(day.tokens)}`}
              />
            ))}
          </div>
        </div>
        <footer>
          <strong>{historyFace === "voice" ? (zh ? `合计 ${totalVoiceCharacters.toLocaleString()} 字` : `Total ${totalVoiceCharacters.toLocaleString()} chars`) : (zh ? `合计 ${formatTokenCount(totalTokenCount)}` : `Total ${formatTokenCount(totalTokenCount)}`)}</strong>
          <span>{zh ? "少" : "Less"}<i className="heat-1" /><i className="heat-2" /><i className="heat-3" /><i className="heat-4" />{zh ? "多" : "More"}</span>
        </footer>
      </section>
    </main>
  );
});
