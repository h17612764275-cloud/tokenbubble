export type ProviderId = "codex" | "claude";
export type SnapshotStatus = "ok" | "stale" | "loading" | "unavailable" | "signed_out";
export type Language = "zh-CN" | "en";
export type WidgetStyle = "bubble" | "bottle";

export interface UsageWindow {
  remainingPercent: number;
  resetsAt: string | null;
  windowSeconds: number;
}

export interface DailyTokenUsage {
  date: string;
  tokens: number;
}

export interface TokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  calls: number;
  estimatedCostUsd: number;
}

export interface HourlyTokenUsage {
  hour: string;
  tokens: number;
  calls: number;
  estimatedCostUsd: number;
}

export interface DailyTokenBreakdown {
  date: string;
  usage: TokenBreakdown;
}

export interface ModelTokenUsage {
  model: string;
  tokens: number;
  calls: number;
  estimatedCostUsd: number;
}

export interface LocalUsageSummary {
  today: TokenBreakdown;
  lastHour: TokenBreakdown;
  hourly: HourlyTokenUsage[];
  daily: DailyTokenBreakdown[];
  models: ModelTokenUsage[];
  cacheHitPercent: number;
  peakHour: string | null;
  peakHourTokens: number;
  usdCnyRate: number;
  exchangeRateDate: string;
  scannedAt: string;
}

export interface ProviderSnapshot {
  provider: ProviderId;
  displayName: string;
  plan: string | null;
  shortWindow: UsageWindow | null;
  weeklyWindow: UsageWindow | null;
  sparkWeeklyWindow?: UsageWindow | null;
  resetCredits: number | null;
  resetCreditExpiresAt?: string[];
  dailyTokenUsage?: DailyTokenUsage[] | null;
  lifetimeTokens?: number | null;
  peakDailyTokens?: number | null;
  localUsage?: LocalUsageSummary | null;
  updatedAt: string;
  status: SnapshotStatus;
  message: string | null;
}

export interface QuotaState {
  snapshots: ProviderSnapshot[];
  revision: number;
  refreshing: boolean;
  failureCount: number;
}

export interface WidgetPreferences {
  locked: boolean;
  positionLocked: boolean;
  widgetSize: number;
  /** Flat-panel accent; also drives the glass-bottle liquid widget. */
  accentColor: string;
  /** Soap-bubble panel accent only. The soap-bubble widget has a fixed optical style. */
  bubblePanelAccentColor: string;
  widgetStyle: WidgetStyle;
  alwaysOnTop: boolean;
  stayExpanded: boolean;
  pinnedProvider: ProviderId | null;
  autoRotateSeconds: number;
  language: Language;
  screenshotShortcut: string;
  screenshotFolder: string;
}
