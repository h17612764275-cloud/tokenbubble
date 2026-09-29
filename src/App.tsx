import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WidgetQuickActionsWindow } from "./components/WidgetQuickActionsWindow";
import { showWidgetQuickActions } from "./lib/bridge";
import { QuotaOrb } from "./components/QuotaCard";
import { PinnedScreenshot } from "./components/PinnedScreenshot";
import { ScreenshotOverlay } from "./components/ScreenshotOverlay";
import { TrayPanel } from "./components/TrayPanel";
import { getPreferences, getQuotaState, listenDesktopEvents, requestQuotaRefresh, resizeFloatingWidget, setWidgetExpanded, setWidgetPositionLocked, startDragging, toggleFloatingWidget, togglePanelFromWidget, updatePreferences } from "./lib/bridge";
import { checkForAppUpdate } from "./lib/appUpdate";
import { copy, normalizeLanguage } from "./lib/i18n";
import { recordDailyUsage } from "./lib/dailyUsage";
import { withPanelAccentColor, withWidgetStyle } from "./lib/skin";
import type { ProviderSnapshot, QuotaState, WidgetPreferences } from "./types";

const DEFAULT_PREFS: WidgetPreferences = { locked: false, positionLocked: false, widgetSize: 68, accentColor: "#b97892", bubblePanelAccentColor: "#faa4ce", widgetStyle: "bubble", alwaysOnTop: true, stayExpanded: false, pinnedProvider: null, autoRotateSeconds: 12, language: "zh-CN", screenshotShortcut: "Ctrl+P", screenshotFolder: "" };
const DESKTOP_LISTENER_RETRY_MS = 1_000;

export default function App() {
  const bootstrap = window as typeof window & { __TOKEN_BUBBLE_VIEW__?: string };
  const view = bootstrap.__TOKEN_BUBBLE_VIEW__ ?? new URLSearchParams(window.location.search).get("view");
  const nativeLabel = "__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "";
  if (nativeLabel === "quick-actions" || view === "quick-actions") return <WidgetQuickActionsWindow />;
  if (nativeLabel === "screenshot" || view === "screenshot") return <ScreenshotOverlay />;
  if (nativeLabel.startsWith("pin-") || view === "pin") return <PinnedScreenshot />;
  return <QuotaApp isTrayPanel={nativeLabel === "tray-panel" || view === "tray"} />;
}

function QuotaApp({ isTrayPanel }: { isTrayPanel: boolean }) {
  const [snapshots, setSnapshots] = useState<ProviderSnapshot[]>([]);
  const [preferences, setPreferences] = useState(DEFAULT_PREFS);
  const [activeIndex, setActiveIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [compact, setCompact] = useState(true);
  const [consumingProviders, setConsumingProviders] = useState<Set<string>>(() => new Set());
  const [operationError, setOperationError] = useState<string | null>(null);
  const [showUpdateFallback, setShowUpdateFallback] = useState(false);
  const quotaRevision = useRef(-1);
  const previousPrimary = useRef(new Map<string, number>());
  const consumptionTimers = useRef(new Map<string, number>());
  const collapseTimer = useRef<number | null>(null);
  const hoverSequence = useRef(0);
  const mounted = useRef(false);
  const mountGeneration = useRef(0);
  const language = normalizeLanguage(preferences.language);
  const t = copy[language];

  useEffect(() => {
    mounted.current = true;
    mountGeneration.current += 1;
    return () => {
      mounted.current = false;
      mountGeneration.current += 1;
    };
  }, []);

  const checkUpdate = useCallback((manual = false) => {
    setShowUpdateFallback(false);
    void checkForAppUpdate(language, {
      checking: t.updateChecking,
      current: t.updateCurrent,
      downloading: t.updateDownloading,
      installing: t.updateInstalling,
      availableWindows: t.updateAvailableWindows,
      availableMac: t.updateAvailableMac,
      failed: t.updateFailed,
    }, (message) => {
      setOperationError(message);
      if (message === t.updateFailed) setShowUpdateFallback(true);
    }, manual);
  }, [language, t]);
  const checkUpdateRef = useRef(checkUpdate);

  useEffect(() => {
    checkUpdateRef.current = checkUpdate;
  }, [checkUpdate]);

  const applyQuotaState = useCallback((state: QuotaState): boolean => {
    if (!mounted.current) return false;
    if (state.revision <= quotaRevision.current) return false;
    quotaRevision.current = state.revision;
    setSnapshots(state.snapshots);

    for (const item of state.snapshots) {
      if (item.status !== "ok") continue;
      const nextPrimary = item.shortWindow?.remainingPercent;
      if (state.refreshing) {
        if (nextPrimary !== undefined) previousPrimary.current.set(item.provider, nextPrimary);
        continue;
      }
      recordDailyUsage(item);
      const previous = previousPrimary.current.get(item.provider);
      if (nextPrimary !== undefined && previous !== undefined && nextPrimary < previous) {
        setConsumingProviders((current) => new Set(current).add(item.provider));
        const oldTimer = consumptionTimers.current.get(item.provider);
        if (oldTimer !== undefined) window.clearTimeout(oldTimer);
        const timer = window.setTimeout(() => {
          setConsumingProviders((current) => { const next = new Set(current); next.delete(item.provider); return next; });
          consumptionTimers.current.delete(item.provider);
        }, 5 * 60_000);
        consumptionTimers.current.set(item.provider, timer);
      }
      if (nextPrimary !== undefined) previousPrimary.current.set(item.provider, nextPrimary);
    }
    return true;
  }, []);

  const refresh = useCallback(async () => {
    const generation = mountGeneration.current;
    try {
      const state = await requestQuotaRefresh();
      if (mounted.current && mountGeneration.current === generation) applyQuotaState(state);
    } catch {
      if (mounted.current && mountGeneration.current === generation) {
        setOperationError("Quota refresh request failed.");
      }
    }
  }, [applyQuotaState]);

  useEffect(() => {
    void getPreferences().then((value) => setPreferences({ ...DEFAULT_PREFS, ...value, language: normalizeLanguage(value.language) })).catch(() => setOperationError("Unable to read settings. Defaults are in use."));
    return () => {
      for (const timer of consumptionTimers.current.values()) window.clearTimeout(timer);
      consumptionTimers.current.clear();
      if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let cleanupListener: () => void = () => {};
    let retryTimer: number | null = null;
    const generation = mountGeneration.current;
    const active = () => !disposed && mounted.current && mountGeneration.current === generation;
    const readState = async () => {
      try {
        const state = await getQuotaState();
        if (active()) applyQuotaState(state);
      } catch {
        if (active()) setOperationError("Unable to read quota state.");
      }
    };
    const connect = async () => {
      try {
        const cleanup = await listenDesktopEvents({
          onPreferences: (value) => { if (active()) setPreferences({ ...DEFAULT_PREFS, ...value, language: normalizeLanguage(value.language) }); },
          onUpdate: () => { if (active()) checkUpdateRef.current(true); },
          onQuotaState: (state) => { if (active()) applyQuotaState(state); },
        });
        if (!active()) {
          cleanup();
          return;
        }
        cleanupListener = cleanup;
        void readState();
      } catch {
        if (!active()) return;
        setOperationError("Desktop event listener failed to start.");
        void readState();
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          void connect();
        }, DESKTOP_LISTENER_RETRY_MS);
      }
    };
    void connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      cleanupListener();
    };
  }, [applyQuotaState, isTrayPanel]);

  useEffect(() => {
    if (isTrayPanel) return;
    const timer = window.setTimeout(() => checkUpdate(false), 12_000);
    return () => window.clearTimeout(timer);
  }, [checkUpdate, isTrayPanel]);

  useEffect(() => {
    const refreshWhenActive = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", refreshWhenActive);
    document.addEventListener("visibilitychange", refreshWhenActive);
    return () => {
      window.removeEventListener("focus", refreshWhenActive);
      document.removeEventListener("visibilitychange", refreshWhenActive);
    };
  }, [refresh]);

  useEffect(() => {
    if (hovered || preferences.pinnedProvider || snapshots.length < 2) return;
    const id = window.setInterval(() => setActiveIndex((value) => (value + 1) % snapshots.length), preferences.autoRotateSeconds * 1000);
    return () => window.clearInterval(id);
  }, [hovered, preferences.autoRotateSeconds, preferences.pinnedProvider, snapshots.length]);

  const current = preferences.pinnedProvider
    ? snapshots.find((item) => item.provider === preferences.pinnedProvider) ?? snapshots[0]
    : snapshots[activeIndex % Math.max(1, snapshots.length)];

  const savePreferences = useCallback((next: WidgetPreferences) => {
    const previous = preferences;
    setPreferences(next);
    setOperationError(null);
    void updatePreferences(next).catch((error) => {
      setPreferences(previous);
      setOperationError(
        error instanceof Error && error.message
          ? `Settings could not be saved: ${error.message}`
          : "Settings could not be saved. Previous state restored.",
      );
    });
  }, [preferences]);

  const handleHover = useCallback((value: boolean) => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    setHovered(value);
    if (!value && preferences.stayExpanded) return;
    if (value) {
      const sequence = ++hoverSequence.current;
      void setWidgetExpanded(true)
        .then(() => { if (hoverSequence.current === sequence) setCompact(false); })
        .catch(() => {
          setCompact(false);
          setOperationError("Widget expand failed.");
        });
      return;
    }
    const sequence = ++hoverSequence.current;
    collapseTimer.current = window.setTimeout(() => {
      if (hoverSequence.current !== sequence) return;
      setCompact(true);
      void setWidgetExpanded(false).catch(() => setOperationError("Widget collapse failed."));
    }, 180);
  }, [preferences.stayExpanded, refresh]);

  if (!current) return <div className={isTrayPanel ? "tray-panel tray-panel--loading" : "loading-orb"} aria-label={t.loadingQuota}><span /><span /><span /></div>;

  if (isTrayPanel) {
    return (
      <TrayPanel
        snapshot={current}
        preferences={preferences}
        operationError={operationError}
        onRefresh={() => void refresh()}
        onToggleWidget={() => toggleFloatingWidget()}
        onTogglePositionLock={() => setWidgetPositionLocked(!preferences.positionLocked).then((value) => setPreferences({ ...DEFAULT_PREFS, ...value }))}
        onResizeWidget={(larger) => resizeFloatingWidget(larger).then((value) => setPreferences({ ...DEFAULT_PREFS, ...value }))}
        onPanelColorChange={(color) => {
          const next = withPanelAccentColor(preferences, color);
          return updatePreferences(next).then(() => setPreferences(next));
        }}
        onSkinChange={(widgetStyle) => {
          const next = withWidgetStyle(preferences, widgetStyle);
          return updatePreferences(next).then(() => setPreferences(next));
        }}
        onScreenshotPreferencesChange={(screenshotShortcut, screenshotFolder) => savePreferences({ ...preferences, screenshotShortcut, screenshotFolder })}
      />
    );
  }

  return <QuotaOrb onOpenQuickActions={() => showWidgetQuickActions()} snapshot={current} language={language} positionLocked={preferences.positionLocked} widgetSize={preferences.widgetSize} accentColor={preferences.accentColor} widgetStyle={preferences.widgetStyle} onDrag={() => startDragging()} onHover={(value) => { setHovered(value); if (value && (current.status === "unavailable" || current.status === "stale")) void refresh(); }} onOpenPanel={() => togglePanelFromWidget()} />;
}
