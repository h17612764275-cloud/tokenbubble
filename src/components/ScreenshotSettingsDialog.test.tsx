// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WidgetPreferences } from "../types";

const bridge = vi.hoisted(() => ({
  beginScreenshot: vi.fn(async (): Promise<void> => undefined),
  chooseScreenshotFolder: vi.fn(async () => null),
  getDefaultScreenshotFolder: vi.fn(async () => "/Users/test/Pictures/Token Bubble 截图"),
  isGlobalShortcutRegistered: vi.fn(async () => false),
  openScreenshotFolder: vi.fn(async () => undefined),
}));
vi.mock("../lib/bridge", () => bridge);

import { ScreenshotSettingsDialog } from "./ScreenshotSettingsDialog";

const preferences: WidgetPreferences = {
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
  screenshotFolder: "/Users/test/Pictures/Token Bubble 截图",
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ScreenshotSettingsDialog", () => {
  it("starts a capture once without saving unsaved settings", async () => {
    let resolveStart!: () => void;
    bridge.beginScreenshot.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveStart = resolve; }));
    const onClose = vi.fn();
    const onSave = vi.fn();
    render(<ScreenshotSettingsDialog preferences={preferences} zh onClose={onClose} onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "更改快捷键" }));
    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    await waitFor(() => expect(screen.getByText("Ctrl+K")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "开始截图" }));
    expect(bridge.beginScreenshot).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "正在启动截图…" })).toHaveProperty("disabled", true);
    expect(onSave).not.toHaveBeenCalled();

    resolveStart();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a backend failure and lets the user retry", async () => {
    bridge.beginScreenshot.mockRejectedValueOnce(new Error("请开启屏幕录制权限"));
    const onClose = vi.fn();
    render(<ScreenshotSettingsDialog preferences={preferences} zh onClose={onClose} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "开始截图" }));
    expect((await screen.findByRole("alert")).textContent).toContain("请开启屏幕录制权限");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "开始截图" }));
    await waitFor(() => expect(bridge.beginScreenshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
