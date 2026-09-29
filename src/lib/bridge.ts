import type { ProviderSnapshot, QuotaState, WidgetPreferences } from "../types";

const defaultPreferences: WidgetPreferences = {
  locked: false,
  positionLocked: false,
  widgetSize: 68,
  accentColor: "#b97892",
  bubblePanelAccentColor: "#faa4ce",
  widgetStyle: "bubble",
  alwaysOnTop: true,
  stayExpanded: false,
  pinnedProvider: null,
  autoRotateSeconds: 12,
  language: "zh-CN",
  screenshotShortcut: "Ctrl+P",
  screenshotFolder: "",
};

const mockSnapshot: ProviderSnapshot = {
  provider: "codex",
  displayName: "CODEX",
  plan: "PRO",
  shortWindow: { remainingPercent: 74, resetsAt: new Date(Date.now() + 78 * 60_000).toISOString(), windowSeconds: 18_000 },
  weeklyWindow: { remainingPercent: 42, resetsAt: new Date(Date.now() + 3.2 * 86_400_000).toISOString(), windowSeconds: 604_800 },
  resetCredits: 1,
  resetCreditExpiresAt: [new Date(Date.now() + 9 * 86_400_000).toISOString()],
  localUsage: {
    today: { inputTokens: 24_600_000, cachedInputTokens: 19_200_000, cacheWriteInputTokens: 0, outputTokens: 5_700_000, reasoningOutputTokens: 500_000, totalTokens: 30_300_000, calls: 64, estimatedCostUsd: 2.44 },
    lastHour: { inputTokens: 1_420_000, cachedInputTokens: 1_010_000, cacheWriteInputTokens: 0, outputTokens: 420_000, reasoningOutputTokens: 90_000, totalTokens: 1_840_000, calls: 12, estimatedCostUsd: 0.17 },
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      hour: `${String(hour).padStart(2, "0")}:00`,
      tokens: hour < 12 ? 0 : [42, 61, 89, 72, 58, 83, 111, 136, 96, 128, 181, 236][hour - 12] * 1000,
      calls: hour < 12 ? 0 : Math.max(1, hour - 11),
      estimatedCostUsd: hour < 12 ? 0 : (hour - 11) * .01,
    })),
    daily: Array.from({ length: 90 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (89 - index));
      const tokens = index < 45 ? 0 : ((index * 7919) % 27_000_000) + 1_800_000;
      return {
        date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
        usage: { inputTokens: tokens, cachedInputTokens: Math.round(tokens * .72), cacheWriteInputTokens: 0, outputTokens: Math.round(tokens * .08), reasoningOutputTokens: Math.round(tokens * .015), totalTokens: tokens, calls: Math.max(0, Math.round(tokens / 800_000)), estimatedCostUsd: tokens / 12_000_000 },
      };
    }),
    models: [{ model: "gpt-5.6-sol", tokens: 30_300_000, calls: 64, estimatedCostUsd: 2.44 }],
    cacheHitPercent: 78,
    peakHour: "23:00",
    peakHourTokens: 236_000,
    usdCnyRate: 6.7775,
    exchangeRateDate: "2026-07-17",
    scannedAt: new Date().toISOString(),
  },
  updatedAt: new Date().toISOString(),
  status: "ok",
  message: null,
};

let widgetTransition: Promise<void> = Promise.resolve();

function enqueueWidgetTransition(operation: () => Promise<void>): Promise<void> {
  const next = widgetTransition.then(operation, operation);
  widgetTransition = next.catch(() => undefined);
  return next;
}

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export interface WidgetMotionPayload {
  x: number;
  y: number;
}

export type PanelResizeDirection = "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

export async function startPanelResize(direction: PanelResizeDirection): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await invoke("begin_panel_resize");
  try {
    await getCurrentWindow().startResizeDragging(direction);
  } catch (error) {
    await invoke("end_panel_resize");
    throw error;
  }
}

export function finishPanelResize(): void {
  if (!isTauri()) return;
  window.setTimeout(() => {
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("end_panel_resize"));
  }, 350);
}

export async function listenWidgetMotion(handler: (position: WidgetMotionPayload) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<WidgetMotionPayload>("widget-motion", (event) => handler(event.payload));
}

export async function getQuotaState(): Promise<QuotaState> {
  if (!isTauri()) return { snapshots: [mockSnapshot], revision: 1, refreshing: false, failureCount: 0 };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuotaState>("get_quota_state");
}

export async function requestQuotaRefresh(): Promise<QuotaState> {
  if (!isTauri()) return { snapshots: [mockSnapshot], revision: 1, refreshing: false, failureCount: 0 };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuotaState>("request_quota_refresh");
}

export async function getPreferences(): Promise<WidgetPreferences> {
  if (!isTauri()) return defaultPreferences;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WidgetPreferences>("get_preferences");
}

export async function updatePreferences(value: WidgetPreferences): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_preferences", { preferences: value });
}

export async function setClickThrough(locked: boolean): Promise<WidgetPreferences> {
  if (!isTauri()) return { ...defaultPreferences, locked };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WidgetPreferences>("set_widget_locked", { locked });
}

export async function setAlwaysOnTop(alwaysOnTop: boolean): Promise<WidgetPreferences> {
  if (!isTauri()) return { ...defaultPreferences, alwaysOnTop };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WidgetPreferences>("set_widget_always_on_top", { alwaysOnTop });
}

export async function showFloatingWidget(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("show_floating_widget");
}

export async function getFloatingWidgetVisible(): Promise<boolean> {
  if (!isTauri()) return true;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("get_floating_widget_visible");
}

export async function toggleFloatingWidget(): Promise<boolean> {
  if (!isTauri()) return true;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("toggle_floating_widget");
}

export async function setWidgetPositionLocked(positionLocked: boolean): Promise<WidgetPreferences> {
  if (!isTauri()) return { ...defaultPreferences, positionLocked };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WidgetPreferences>("set_widget_position_locked", { positionLocked });
}

export async function resizeFloatingWidget(larger: boolean): Promise<WidgetPreferences> {
  if (!isTauri()) return { ...defaultPreferences, widgetSize: larger ? 76 : 60 };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WidgetPreferences>("resize_floating_widget", { larger });
}

export async function togglePanelFromWidget(): Promise<boolean> {
  if (!isTauri()) return true;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("toggle_panel_from_widget");
}

export async function isGlobalShortcutRegistered(shortcut: string): Promise<boolean> {
  if (!isTauri()) return false;
  const { isRegistered } = await import("@tauri-apps/plugin-global-shortcut");
  return isRegistered(shortcut);
}

export interface ScreenshotCapturePayload {
  dataUrl: string;
  width: number;
  height: number;
  sessionId: number;
  windowTargets?: Array<{ x: number; y: number; width: number; height: number }>;
}

export async function beginScreenshot(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("begin_screenshot");
}

export async function getScreenshotCapture(expectedSessionId?: number): Promise<ScreenshotCapturePayload> {
  if (!isTauri()) {
    const width = 1440;
    const height = 900;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    const background = context.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, "#071323");
    background.addColorStop(.55, "#142942");
    background.addColorStop(1, "#080d18");
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    const glow = context.createRadialGradient(620, 390, 20, 620, 390, 430);
    glow.addColorStop(0, "rgba(71,146,255,.92)");
    glow.addColorStop(.5, "rgba(52,88,205,.48)");
    glow.addColorStop(1, "rgba(26,34,80,0)");
    context.fillStyle = glow;
    context.fillRect(120, 40, 1000, 800);
    return { dataUrl: canvas.toDataURL("image/png"), width, height, sessionId: 0, windowTargets: [] };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ScreenshotCapturePayload>("get_screenshot_capture", {
    expectedSessionId: expectedSessionId ?? null,
  });
}

export async function activateScreenshot(sessionId: number): Promise<number> {
  if (!isTauri()) return 0;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("activate_screenshot", { sessionId });
}

export async function revealScreenshot(sessionId: number): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_screenshot", { sessionId });
}

export async function heartbeatScreenshot(sessionId: number): Promise<boolean> {
  if (!isTauri()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("screenshot_heartbeat", { sessionId });
}

export async function setScreenshotDialogMode(sessionId: number, open: boolean): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_screenshot_dialog_mode", { sessionId, open });
}

export async function cancelScreenshot(sessionId: number): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("cancel_screenshot", { sessionId });
}

export async function finishScreenshot(sessionId: number, dataUrl: string, targetPath: string | null, pin = false): Promise<{ savedPath: string }> {
  if (!isTauri()) return { savedPath: "" };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ savedPath: string }>("finish_screenshot", { sessionId, dataUrl, targetPath, pin });
}

export async function getDefaultScreenshotFolder(): Promise<string> {
  if (!isTauri()) return "Token Bubble\\Screenshots";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("get_default_screenshot_folder");
}

export async function chooseScreenshotFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const value = await open({ directory: true, multiple: false, title: "Choose screenshot folder" });
  return typeof value === "string" ? value : null;
}

export async function chooseScreenshotFile(defaultPath: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath, title: "淇濆瓨鎴浘", filters: [{ name: "PNG 鍥剧墖", extensions: ["png"] }] });
}

export async function openScreenshotFolder(path: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_screenshot_folder", { path });
}

export async function getPinnedScreenshot(id: string): Promise<ScreenshotCapturePayload> {
  if (!isTauri()) throw new Error("Screenshot not available before app initialization.");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ScreenshotCapturePayload>("get_pinned_screenshot", { id });
}

export async function closePinnedScreenshot(id: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("close_pinned_screenshot", { id });
}

export async function quitApp(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("quit_app");
}

export async function startDragging(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { invoke } = await import("@tauri-apps/api/core");
  const currentWindow = getCurrentWindow();
  await invoke("begin_widget_drag");
  await currentWindow.startDragging();
  let previous = await currentWindow.outerPosition();
  let stableTicks = 0;
  let attempts = 0;
  const finishWhenStable = window.setInterval(() => {
    void currentWindow.outerPosition()
      .then((next) => {
        attempts += 1;
        const stable = Math.abs(next.x - previous.x) <= 1 && Math.abs(next.y - previous.y) <= 1;
        stableTicks = stable ? stableTicks + 1 : 0;
        previous = next;
        if (stableTicks >= 3 || attempts >= 25) {
          window.clearInterval(finishWhenStable);
          void invoke("finish_widget_drag").catch(() => undefined);
        }
      })
      .catch(() => {
        window.clearInterval(finishWhenStable);
        void invoke("finish_widget_drag").catch(() => undefined);
      });
  }, 80);
}

export function setWidgetExpanded(expanded: boolean): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return enqueueWidgetTransition(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    if (!expanded) {
      await invoke("collapse_widget");
      return;
    }
    const { currentMonitor } = await import("@tauri-apps/api/window");
    const monitor = await currentMonitor().catch(() => null);
    const workArea = monitor ? {
      position: { x: monitor.workArea.position.x, y: monitor.workArea.position.y },
      size: { width: monitor.workArea.size.width, height: monitor.workArea.size.height },
    } : null;
    await invoke("expand_widget", { workArea });
  });
}

export async function listenDesktopEvents(handlers: {
  onPreferences: (value: WidgetPreferences) => void;
  onUpdate: () => void;
  onQuotaState: (value: QuotaState) => void;
}): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  const unlisteners: Array<() => void> = [];
  const cleanupAll = () => {
    for (const unlisten of unlisteners.splice(0).reverse()) {
      try { unlisten(); } catch { /* Continue releasing the remaining listeners. */ }
    }
  };
  try {
    unlisteners.push(await listen<WidgetPreferences>("preferences-changed", (event) => handlers.onPreferences(event.payload)));
    unlisteners.push(await listen("update-check-requested", handlers.onUpdate));
    unlisteners.push(await listen<QuotaState>("quota-state-changed", (event) => handlers.onQuotaState(event.payload)));
  } catch (error) {
    cleanupAll();
    throw error;
  }
  return cleanupAll;
}

export async function showWidgetQuickActions(): Promise<void> { if (!isTauri()) return; const { invoke } = await import("@tauri-apps/api/core"); await invoke("show_widget_quick_actions"); }
export async function closeWidgetQuickActions(): Promise<void> { if (!isTauri()) return; const { invoke } = await import("@tauri-apps/api/core"); await invoke("close_widget_quick_actions"); }
export async function hideFloatingWidget(): Promise<boolean> { if (!isTauri()) return false; const { invoke } = await import("@tauri-apps/api/core"); return invoke<boolean>("hide_floating_widget"); }
