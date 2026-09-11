// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WidgetQuickActionsWindow } from "./WidgetQuickActionsWindow";

const native = vi.hoisted(() => ({
  hide: vi.fn<() => Promise<boolean>>(),
  close: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
  visible: vi.fn(async () => true),
  refresh: vi.fn(async () => {}),
  lock: vi.fn(async (positionLocked: boolean) => ({ language: "zh-CN", widgetStyle: "bubble", bubblePanelAccentColor: "#faa4ce", widgetSize: 68, positionLocked })),
}));
vi.mock("../lib/bridge", () => ({
  getPreferences: vi.fn(async () => ({ language: "zh-CN", widgetStyle: "bubble", bubblePanelAccentColor: "#faa4ce", widgetSize: 68, positionLocked: false })),
  getQuotaState: vi.fn(async () => ({ revision: 1, snapshots: [{ localUsage: { today: { totalTokens: 1234500 } } }] })),
  listenDesktopEvents: vi.fn(async () => () => {}),
  getFloatingWidgetVisible: native.visible,
  hideFloatingWidget: native.hide,
  showFloatingWidget: native.show,
  closeWidgetQuickActions: native.close,
  requestQuotaRefresh: native.refresh,
  setWidgetPositionLocked: native.lock,
}));
beforeEach(() => { vi.clearAllMocks(); native.hide.mockReset().mockResolvedValue(false); });
afterEach(cleanup);

it("completes one explicit hide before closing the menu even with repeated clicks", async () => {
  let complete!: (visible: boolean) => void;
  native.hide.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  render(<WidgetQuickActionsWindow />);
  const eye = await screen.findByRole("button", { name: "浮窗当前显示，点击隐藏" });
  fireEvent.pointerDown(eye);
  fireEvent.mouseDown(eye);
  fireEvent.mouseUp(eye);
  fireEvent.click(eye);
  fireEvent.click(eye);
  expect(native.hide).toHaveBeenCalledOnce();
  expect(native.close).not.toHaveBeenCalled();
  await act(async () => complete(false));
  expect(native.close).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "浮窗当前隐藏，点击显示" })).toBeTruthy();
});

it("keeps the menu open and reports a failed hide instead of moving or closing it", async () => {
  native.hide.mockRejectedValueOnce(new Error("native hide failed"));
  render(<WidgetQuickActionsWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "浮窗当前显示，点击隐藏" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(native.close).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "浮窗当前显示，点击隐藏" })).toBeTruthy();
});

it("refreshes through the quota command and closes only after success", async () => {
  render(<WidgetQuickActionsWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "刷新" }));
  await act(async () => { await Promise.resolve(); });
  expect(native.refresh).toHaveBeenCalledOnce();
  expect(native.close).toHaveBeenCalledOnce();
});

it("uses the panel accent and existing today's token count", async () => {
  const { container } = render(<WidgetQuickActionsWindow />);
  expect(await screen.findByRole("status", { name: "今日 Token 消耗 1.2M" })).toBeTruthy();
  expect((container.querySelector(".widget-quick-actions") as HTMLElement).style.getPropertyValue("--theme-accent")).toBe("#faa4ce");
});

it("locks the position and reflects the new state without changing widget size", async () => {
  render(<WidgetQuickActionsWindow />);
  fireEvent.click(await screen.findByRole("button", { name: "固定位置" }));
  await act(async () => { await Promise.resolve(); });
  expect(native.lock).toHaveBeenCalledWith(true);
  expect(screen.getByRole("button", { name: "解锁位置" }).classList.contains("is-active")).toBe(true);
  expect(native.close).toHaveBeenCalledOnce();
});

it("closes on Escape and removes its listener on unmount", async () => {
  const { unmount } = render(<WidgetQuickActionsWindow />);
  await screen.findByRole("button", { name: "刷新" });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(native.close).toHaveBeenCalledOnce();
  unmount();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(native.close).toHaveBeenCalledOnce();
});
