import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshot, QuotaState } from "../types";

const api = vi.hoisted(() => ({
  calls: [] as string[],
  currentLabel: "widget",
  invoke: vi.fn(async (command: string): Promise<unknown> => {
    api.calls.push(`start:${command}`);
    await Promise.resolve();
    api.calls.push(`end:${command}`);
    return undefined;
  }),
  getCurrentWindow: vi.fn(() => ({ label: api.currentLabel })),
  currentMonitor: vi.fn(async () => ({
    workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
  })),
}));
const events = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  emitTo: vi.fn(async () => undefined),
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    events.listeners.set(name, listener);
    return () => events.listeners.delete(name);
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: events.emitTo, listen: events.listen }));
vi.mock("@tauri-apps/api/window", () => ({ currentMonitor: api.currentMonitor, getCurrentWindow: api.getCurrentWindow }));

beforeEach(() => {
  vi.clearAllMocks();
  api.calls.length = 0;
  api.currentLabel = "widget";
  events.listeners.clear();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});

const recoveredSnapshot: ProviderSnapshot = {
  provider: "codex",
  displayName: "CODEX",
  plan: "PRO",
  shortWindow: null,
  weeklyWindow: { remainingPercent: 99, resetsAt: "2026-08-17T00:00:00Z", windowSeconds: 604_800 },
  resetCredits: null,
  resetCreditExpiresAt: [],
  updatedAt: "2026-08-11T04:00:00Z",
  status: "ok" as const,
  message: null,
};

describe("widget transitions", () => {
  it("passes the monitor work area to the Rust expansion command", async () => {
    const { setWidgetExpanded } = await import("./bridge");
    await setWidgetExpanded(true);
    expect(api.invoke).toHaveBeenCalledWith("expand_widget", {
      workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
    });
  });

  it("serializes rapid expand and collapse requests", async () => {
    const { setWidgetExpanded } = await import("./bridge");
    await Promise.all([setWidgetExpanded(true), setWidgetExpanded(false)]);
    expect(api.calls).toEqual([
      "start:expand_widget",
      "end:expand_widget",
      "start:collapse_widget",
      "end:collapse_widget",
    ]);
  });
});

describe("quota state", () => {
  const quotaState: QuotaState = {
    snapshots: [recoveredSnapshot],
    revision: 7,
    refreshing: false,
    failureCount: 0,
  };

  it("reads the complete versioned state from the backend", async () => {
    api.invoke.mockResolvedValueOnce(quotaState);
    const { getQuotaState } = await import("./bridge");

    await expect(getQuotaState()).resolves.toEqual(quotaState);
    expect(api.invoke).toHaveBeenCalledWith("get_quota_state");
  });

  it("requests a coordinated backend refresh", async () => {
    api.invoke.mockResolvedValueOnce(quotaState);
    const { requestQuotaRefresh } = await import("./bridge");

    await expect(requestQuotaRefresh()).resolves.toEqual(quotaState);
    expect(api.invoke).toHaveBeenCalledWith("request_quota_refresh");
  });

  it("delivers the complete versioned state through the desktop event contract", async () => {
    const onQuotaState = vi.fn();
    const { listenDesktopEvents } = await import("./bridge");
    const dispose = await listenDesktopEvents({
      onPreferences: vi.fn(),
      onUpdate: vi.fn(),
      onQuotaState,
    });

    events.listeners.get("quota-state-changed")?.({ payload: quotaState });
    expect(onQuotaState).toHaveBeenCalledWith(quotaState);
    expect(events.listeners.has("voice-event")).toBe(false);
    dispose();
  });

  it("cleans up earlier listeners when quota listener registration fails", async () => {
    const unlistenPreferences = vi.fn();
    const unlistenUpdate = vi.fn();
    events.listen
      .mockResolvedValueOnce(unlistenPreferences)
      .mockResolvedValueOnce(unlistenUpdate)
      .mockRejectedValueOnce(new Error("quota listener failed"));
    const { listenDesktopEvents } = await import("./bridge");

    await expect(listenDesktopEvents({
      onPreferences: vi.fn(),
      onUpdate: vi.fn(),
      onQuotaState: vi.fn(),
    })).rejects.toThrow("quota listener failed");

    expect(unlistenPreferences).toHaveBeenCalledOnce();
    expect(unlistenUpdate).toHaveBeenCalledOnce();
  });

  it("does not use peer broadcasts for quota synchronization", async () => {
    const bridge = await import("./bridge");
    api.invoke.mockResolvedValue(quotaState);

    const dispose = await bridge.listenDesktopEvents({
      onPreferences: vi.fn(),
      onUpdate: vi.fn(),
      onQuotaState: vi.fn(),
    });
    await bridge.getQuotaState();
    await bridge.requestQuotaRefresh();

    expect(events.emitTo).not.toHaveBeenCalled();
    expect("broadcastSnapshots" in bridge).toBe(false);
    expect(events.listeners.has("snapshots-updated")).toBe(false);
    expect(events.listeners.has("refresh-requested")).toBe(false);
    dispose();
  });
});

describe("pinned screenshots", () => {
  it("closes through the backend so native and webview image state are cleared", async () => {
    const { closePinnedScreenshot } = await import("./bridge");

    await closePinnedScreenshot("pin");

    expect(api.invoke).toHaveBeenCalledWith("close_pinned_screenshot", { id: "pin" });
  });
});

describe("screenshot reveal", () => {
  it("reveals only the native session returned by activation", async () => {
    api.invoke.mockResolvedValueOnce(17).mockResolvedValueOnce(undefined);
    const { activateScreenshot, revealScreenshot } = await import("./bridge");

    const sessionId = await activateScreenshot(17);
    await revealScreenshot(sessionId);

    expect(api.invoke).toHaveBeenNthCalledWith(1, "activate_screenshot", { sessionId: 17 });
    expect(api.invoke).toHaveBeenNthCalledWith(2, "reveal_screenshot", { sessionId: 17 });
  });

  it("binds dialog, finish, and cancel callbacks to their screenshot session", async () => {
    const {
      cancelScreenshot,
      finishScreenshot,
      setScreenshotDialogMode,
    } = await import("./bridge");

    await setScreenshotDialogMode(17, true);
    await finishScreenshot(17, "data:image/png;base64,cGl4ZWxz", "C:\\Shots\\capture.png", true);
    await cancelScreenshot(17);

    expect(api.invoke).toHaveBeenNthCalledWith(1, "set_screenshot_dialog_mode", {
      sessionId: 17,
      open: true,
    });
    expect(api.invoke).toHaveBeenNthCalledWith(2, "finish_screenshot", {
      sessionId: 17,
      dataUrl: "data:image/png;base64,cGl4ZWxz",
      targetPath: "C:\\Shots\\capture.png",
      pin: true,
    });
    expect(api.invoke).toHaveBeenNthCalledWith(3, "cancel_screenshot", { sessionId: 17 });
  });
});
