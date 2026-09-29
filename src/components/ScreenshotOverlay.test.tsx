// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../styles.css";

const bridge = vi.hoisted(() => ({
  activateScreenshot: vi.fn(async (sessionId: number) => sessionId),
  cancelScreenshot: vi.fn(async (_sessionId: number) => undefined),
  chooseScreenshotFile: vi.fn(async (_defaultPath: string): Promise<string | null> => null),
  finishScreenshot: vi.fn(async (_sessionId: number, _dataUrl: string, _targetPath: string | null, _pin = false) => ({ savedPath: "" })),
  getPreferences: vi.fn(),
  getScreenshotCapture: vi.fn(async () => ({
    dataUrl: "data:image/png;base64,cGl4ZWxz",
    width: 1024,
    height: 768,
    sessionId: 1,
  })),
  heartbeatScreenshot: vi.fn(async () => true),
  revealScreenshot: vi.fn(async () => undefined),
  setScreenshotDialogMode: vi.fn(async (_sessionId: number, _open: boolean) => undefined),
}));

const events = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: number }) => void>(),
  listen: vi.fn(async (name: string, listener: (event: { payload: number }) => void) => {
    events.listeners.set(name, listener);
    return () => events.listeners.delete(name);
  }),
}));
const path = vi.hoisted(() => ({ join: vi.fn(async (_folder: string, _filename: string): Promise<string> => "") }));

vi.mock("../lib/bridge", () => bridge);
vi.mock("@tauri-apps/api/event", () => ({ listen: events.listen }));
vi.mock("@tauri-apps/api/path", () => ({ join: path.join }));

import { ScreenshotOverlay } from "./ScreenshotOverlay";

function selectRegion(overlay: HTMLElement, pointerId: number) {
  fireEvent.pointerDown(overlay, {
    button: 0,
    buttons: 1,
    pointerId,
    clientX: 20,
    clientY: 20,
  });
  fireEvent.pointerMove(overlay, {
    buttons: 1,
    pointerId,
    clientX: 220,
    clientY: 160,
  });
  fireEvent.pointerUp(overlay, {
    button: 0,
    buttons: 0,
    pointerId,
    clientX: 220,
    clientY: 160,
  });
}

function expectCustomMoveCursor(element: HTMLElement) {
  expect(element.style.cursor).toContain("url(");
  expect(element.style.cursor).toContain("16 16");
  expect(element.style.cursor).toContain("move");
}

function mockCaptureWithWindowTargets(windowTargets: Array<{ x: number; y: number; width: number; height: number }>) {
  bridge.getScreenshotCapture.mockResolvedValue({
    dataUrl: "data:image/png;base64,cGl4ZWxz",
    width: 1024,
    height: 768,
    sessionId: 1,
    windowTargets,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  events.listeners.clear();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  bridge.getScreenshotCapture.mockResolvedValue({
    dataUrl: "data:image/png;base64,cGl4ZWxz",
    width: 1024,
    height: 768,
    sessionId: 1,
  });
  bridge.getPreferences.mockResolvedValue({ screenshotFolder: "C:\\Screenshots" });
  path.join.mockImplementation(async (folder, filename) => `${folder}${folder.startsWith("/") ? "/" : "\\"}${filename}`);

  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => null),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ScreenshotOverlay", () => {
  it("reloads captures only from the native ready event", async () => {
    render(<ScreenshotOverlay />);

    await waitFor(() => expect(bridge.getScreenshotCapture).toHaveBeenCalledOnce());
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => Promise.resolve());
    expect(bridge.getScreenshotCapture).toHaveBeenCalledOnce();

    bridge.getScreenshotCapture.mockResolvedValueOnce({
      dataUrl: "data:image/png;base64,bmV4dA==",
      width: 1024,
      height: 768,
      sessionId: 2,
    });
    await act(async () => {
      events.listeners.get("screenshot-capture-ready")?.({ payload: 2 });
      await Promise.resolve();
    });
    await waitFor(() => expect(bridge.getScreenshotCapture).toHaveBeenCalledTimes(2));
    expect(bridge.getScreenshotCapture).toHaveBeenLastCalledWith(2);
  });

  it("ignores an older capture request after a newer session becomes ready", async () => {
    let resolveInitial!: (capture: {
      dataUrl: string;
      width: number;
      height: number;
      sessionId: number;
    }) => void;
    bridge.getScreenshotCapture
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,bmV3ZXI=",
        width: 1024,
        height: 768,
        sessionId: 2,
      });
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(events.listeners.has("screenshot-capture-ready")).toBe(true));
    await act(async () => {
      events.listeners.get("screenshot-capture-ready")?.({ payload: 2 });
      await Promise.resolve();
    });
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("bmV3ZXI="));

    await act(async () => {
      resolveInitial({
        dataUrl: "data:image/png;base64,b2xkZXI=",
        width: 1024,
        height: 768,
        sessionId: 1,
      });
      await Promise.resolve();
    });

    expect(container.querySelector("img")?.getAttribute("src")).toContain("bmV3ZXI=");
  });

  it("ignores ready events that are not newer than the current session", async () => {
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("cGl4ZWxz"));

    bridge.getScreenshotCapture.mockResolvedValueOnce({
      dataUrl: "data:image/png;base64,bmV3ZXN0",
      width: 1024,
      height: 768,
      sessionId: 3,
    });
    await act(async () => {
      events.listeners.get("screenshot-capture-ready")?.({ payload: 3 });
      await Promise.resolve();
    });
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("bmV3ZXN0"));

    await act(async () => {
      events.listeners.get("screenshot-capture-ready")?.({ payload: 2 });
      events.listeners.get("screenshot-capture-ready")?.({ payload: 3 });
      await Promise.resolve();
    });

    expect(bridge.getScreenshotCapture).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("bmV3ZXN0");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores ready events without a valid session number", async () => {
    const { container } = render(<ScreenshotOverlay />);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("cGl4ZWxz"));

    await act(async () => {
      events.listeners.get("screenshot-capture-ready")?.({ payload: undefined as never });
      events.listeners.get("screenshot-capture-ready")?.({ payload: Number.NaN });
      events.listeners.get("screenshot-capture-ready")?.({ payload: 1.5 });
      await Promise.resolve();
    });

    expect(bridge.getScreenshotCapture).toHaveBeenCalledOnce();
    expect(container.querySelector("img")?.getAttribute("src")).toContain("cGl4ZWxz");
  });

  it("does not let the initial read replace a ready event received during listener registration", async () => {
    bridge.getScreenshotCapture.mockResolvedValue({
      dataUrl: "data:image/png;base64,bmV3ZXI=",
      width: 1024,
      height: 768,
      sessionId: 2,
    });
    events.listen.mockImplementationOnce(async (name, listener) => {
      events.listeners.set(name, listener);
      listener({ payload: 2 });
      return () => events.listeners.delete(name);
    });

    const { container } = render(<ScreenshotOverlay />);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("bmV3ZXI="));

    expect(bridge.getScreenshotCapture).toHaveBeenCalledOnce();
    expect(bridge.getScreenshotCapture).toHaveBeenCalledWith(2);
  });

  it("does not surface an activation error from an older session", async () => {
    let rejectOlderActivation!: (reason?: unknown) => void;
    bridge.activateScreenshot
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectOlderActivation = reject;
      }))
      .mockResolvedValueOnce(2);
    const { container } = render(<ScreenshotOverlay />);

    const olderImage = await waitFor(() => {
      const value = container.querySelector<HTMLImageElement>(".screenshot-capture");
      expect(value).not.toBeNull();
      return value as HTMLImageElement;
    });
    fireEvent.load(olderImage);
    await waitFor(() => expect(bridge.activateScreenshot).toHaveBeenCalledWith(1));

    bridge.getScreenshotCapture.mockResolvedValueOnce({
      dataUrl: "data:image/png;base64,bmV3ZXI=",
      width: 1024,
      height: 768,
      sessionId: 2,
    });
    await act(async () => {
      events.listeners.get("screenshot-capture-ready")?.({ payload: 2 });
      await Promise.resolve();
    });
    const currentImage = await waitFor(() => {
      const value = container.querySelector<HTMLImageElement>(".screenshot-capture");
      expect(value?.getAttribute("src")).toContain("bmV3ZXI=");
      return value as HTMLImageElement;
    });
    fireEvent.load(currentImage);
    await waitFor(() => expect(bridge.activateScreenshot).toHaveBeenCalledWith(2));

    await act(async () => {
      rejectOlderActivation(new Error("older activation failed"));
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("prepares the native window before revealing the painted capture", async () => {
    let resolveActivation!: (sessionId: number) => void;
    bridge.activateScreenshot.mockImplementationOnce(() => new Promise((resolve) => {
      resolveActivation = resolve;
    }));
    const { container } = render(<ScreenshotOverlay />);

    const image = await waitFor(() => {
      const value = container.querySelector<HTMLImageElement>(".screenshot-capture");
      expect(value).not.toBeNull();
      return value as HTMLImageElement;
    });
    expect(bridge.activateScreenshot).not.toHaveBeenCalled();

    fireEvent.load(image);

    await waitFor(() => expect(bridge.activateScreenshot).toHaveBeenCalledWith(1));
    expect(bridge.revealScreenshot).not.toHaveBeenCalled();

    await act(async () => {
      resolveActivation(17);
      await Promise.resolve();
    });

    await waitFor(() => expect(bridge.revealScreenshot).toHaveBeenCalledWith(17));
  });

  it("activates and reveals when animation frames are paused", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    const { container } = render(<ScreenshotOverlay />);
    const image = await waitFor(() => {
      const value = container.querySelector<HTMLImageElement>(".screenshot-capture");
      expect(value).not.toBeNull();
      return value!;
    });

    fireEvent.load(image);

    await waitFor(() => expect(bridge.activateScreenshot).toHaveBeenCalledWith(1));
    await waitFor(() => expect(bridge.revealScreenshot).toHaveBeenCalledWith(1));
  });

  it("does not reveal a canceled capture after the fallback timeout", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    const { container } = render(<ScreenshotOverlay />);
    const image = await waitFor(() => {
      const value = container.querySelector<HTMLImageElement>(".screenshot-capture");
      expect(value).not.toBeNull();
      return value!;
    });
    fireEvent.load(image);
    await waitFor(() => expect(bridge.activateScreenshot).toHaveBeenCalledWith(1));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(bridge.cancelScreenshot).toHaveBeenCalledWith(1));
    await new Promise((resolve) => setTimeout(resolve, 160));

    expect(bridge.revealScreenshot).not.toHaveBeenCalled();
  });

  it("does not reveal an old capture after a newer session arrives", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    const { container } = render(<ScreenshotOverlay />);
    const oldImage = await waitFor(() => {
      const value = container.querySelector<HTMLImageElement>(".screenshot-capture");
      expect(value).not.toBeNull();
      return value!;
    });
    fireEvent.load(oldImage);
    await waitFor(() => expect(bridge.activateScreenshot).toHaveBeenCalledWith(1));

    bridge.getScreenshotCapture.mockResolvedValueOnce({
      dataUrl: "data:image/png;base64,bmV3ZXI=",
      width: 1024,
      height: 768,
      sessionId: 2,
    });
    await act(async () => {
      events.listeners.get("screenshot-capture-ready")?.({ payload: 2 });
      await Promise.resolve();
    });
    const newImage = await waitFor(() => {
      const value = container.querySelector<HTMLImageElement>(".screenshot-capture");
      expect(value?.getAttribute("src")).toContain("bmV3ZXI=");
      return value!;
    });
    fireEvent.load(newImage);
    await waitFor(() => expect(bridge.revealScreenshot).toHaveBeenCalledWith(2));

    expect(bridge.revealScreenshot).not.toHaveBeenCalledWith(1);
  });

  it("does not reveal after the overlay unmounts", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    const { container, unmount } = render(<ScreenshotOverlay />);
    const image = await waitFor(() => {
      const value = container.querySelector<HTMLImageElement>(".screenshot-capture");
      expect(value).not.toBeNull();
      return value!;
    });
    fireEvent.load(image);
    await waitFor(() => expect(bridge.activateScreenshot).toHaveBeenCalledWith(1));

    unmount();
    await new Promise((resolve) => setTimeout(resolve, 160));

    expect(bridge.revealScreenshot).not.toHaveBeenCalled();
  });

  it.each([
    ["/Users/test/Pictures", "/Users/test/Pictures/"],
    ["C:\\Screenshots", "C:\\Screenshots\\"],
  ])("uses native path joining for the save dialog in %s", async (folder, pathPrefix) => {
    bridge.getPreferences.mockResolvedValue({ screenshotFolder: folder });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({ clearRect: vi.fn(), drawImage: vi.fn() })),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,cGl4ZWxz");
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    selectRegion(screen.getByRole("main"), 19);
    fireEvent.click(await screen.findByRole("button", { name: "另存为" }));

    await waitFor(() => expect(path.join).toHaveBeenCalledWith(folder, expect.stringMatching(/^Token-Bubble_.*\.png$/)));
    await waitFor(() => expect(bridge.chooseScreenshotFile).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}Token-Bubble_.*\\.png$`))));
  });

  it("does not let an older save dialog callback alter the newer screenshot session", async () => {
    let resolveSaveDialog!: (path: string | null) => void;
    bridge.chooseScreenshotFile.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSaveDialog = resolve;
    }));
    bridge.setScreenshotDialogMode.mockImplementation(async (sessionId: number, open: boolean) => {
      if (sessionId === 1 && !open) throw new Error("截图会话已结束");
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({ clearRect: vi.fn(), drawImage: vi.fn() })),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,cGl4ZWxz");
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 10);
    fireEvent.click(await screen.findByRole("button", { name: "另存为" }));
    await waitFor(() => expect(bridge.setScreenshotDialogMode).toHaveBeenCalledWith(1, true));

    bridge.getScreenshotCapture.mockResolvedValueOnce({
      dataUrl: "data:image/png;base64,bmV3ZXI=",
      width: 1024,
      height: 768,
      sessionId: 2,
    });
    await act(async () => {
      events.listeners.get("screenshot-capture-ready")?.({ payload: 2 });
      await Promise.resolve();
    });
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("bmV3ZXI="));

    await act(async () => {
      resolveSaveDialog("C:\\Screenshots\\old.png");
      await Promise.resolve();
    });
    await waitFor(() => expect(bridge.setScreenshotDialogMode).toHaveBeenCalledWith(1, false));

    selectRegion(overlay, 11);
    expect((await screen.findByRole("button", { name: "完成" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(bridge.finishScreenshot).not.toHaveBeenCalled();
  });

  it("clears an in-progress pointer interaction when a newer session loads", async () => {
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    fireEvent.pointerDown(overlay, {
      button: 0,
      buttons: 1,
      pointerId: 21,
      clientX: 20,
      clientY: 20,
    });

    bridge.getScreenshotCapture.mockResolvedValueOnce({
      dataUrl: "data:image/png;base64,bmV3ZXI=",
      width: 1024,
      height: 768,
      sessionId: 2,
    });
    await act(async () => {
      events.listeners.get("screenshot-capture-ready")?.({ payload: 2 });
      await Promise.resolve();
    });
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("bmV3ZXI="));

    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 21,
      clientX: 220,
      clientY: 160,
    });

    expect(screen.queryByRole("navigation", { name: "截图工具栏" })).toBeNull();
  });

  it("brightens the recommended window without opening the toolbar", async () => {
    mockCaptureWithWindowTargets([
      { x: 100, y: 90, width: 320, height: 240 },
      { x: 130, y: 120, width: 120, height: 100 },
    ]);
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    fireEvent.pointerMove(screen.getByRole("main"), {
      buttons: 0,
      pointerId: 25,
      clientX: 160,
      clientY: 150,
    });

    const suggestion = container.querySelector<HTMLElement>(".screenshot-window-suggestion");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.style.left).toBe("100px");
    expect(suggestion!.style.top).toBe("90px");
    expect(suggestion!.style.width).toBe("320px");
    expect(suggestion!.style.height).toBe("240px");
    expect(container.querySelector(".screenshot-mask--full")).toBeNull();
    expect(container.querySelector<HTMLElement>(".screenshot-mask--top")!.style.height).toBe("90px");
    expect(container.querySelector<HTMLElement>(".screenshot-mask--left")!.style.width).toBe("100px");
    expect(container.querySelector<HTMLElement>(".screenshot-mask--right")!.style.left).toBe("420px");
    expect(container.querySelector<HTMLElement>(".screenshot-mask--bottom")!.style.top).toBe("330px");
    expect(screen.queryByRole("navigation", { name: "截图工具栏" })).toBeNull();
  });

  it("clears a window suggestion when a newer screenshot session loads", async () => {
    mockCaptureWithWindowTargets([{ x: 100, y: 90, width: 320, height: 240 }]);
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    fireEvent.pointerMove(screen.getByRole("main"), {
      buttons: 0,
      pointerId: 34,
      clientX: 160,
      clientY: 150,
    });
    expect(container.querySelector(".screenshot-window-suggestion")).not.toBeNull();

    bridge.getScreenshotCapture.mockResolvedValueOnce({
      dataUrl: "data:image/png;base64,bmV3LXdpbmRvdy10YXJnZXRz",
      width: 1024,
      height: 768,
      sessionId: 2,
      windowTargets: [],
    } as never);
    await act(async () => {
      events.listeners.get("screenshot-capture-ready")?.({ payload: 2 });
      await Promise.resolve();
    });

    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toContain("bmV3LXdpbmRvdy10YXJnZXRz"));
    expect(container.querySelector(".screenshot-window-suggestion")).toBeNull();
  });

  it("selects the suggested window with a click", async () => {
    mockCaptureWithWindowTargets([{ x: 100, y: 90, width: 320, height: 240 }]);
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    fireEvent.pointerMove(overlay, {
      buttons: 0,
      pointerId: 26,
      clientX: 160,
      clientY: 150,
    });
    fireEvent.pointerDown(overlay, {
      button: 0,
      buttons: 1,
      pointerId: 26,
      clientX: 160,
      clientY: 150,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 26,
      clientX: 160,
      clientY: 150,
    });

    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();
    expect(selection!.style.left).toBe("100px");
    expect(selection!.style.top).toBe("90px");
    expect(selection!.style.width).toBe("320px");
    expect(selection!.style.height).toBe("240px");
    expect(await screen.findByRole("navigation", { name: "截图工具栏" })).toBeTruthy();
  });

  it("keeps the suggested window when pointer movement stays within four pixels", async () => {
    mockCaptureWithWindowTargets([{ x: 100, y: 90, width: 320, height: 240 }]);
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    fireEvent.pointerDown(overlay, {
      button: 0,
      buttons: 1,
      pointerId: 30,
      clientX: 160,
      clientY: 150,
    });
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 30,
      clientX: 163,
      clientY: 150,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 30,
      clientX: 163,
      clientY: 150,
    });

    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection!.style.left).toBe("100px");
    expect(selection!.style.top).toBe("90px");
    expect(selection!.style.width).toBe("320px");
    expect(selection!.style.height).toBe("240px");
  });

  it("switches from a window suggestion to manual selection after dragging four pixels", async () => {
    mockCaptureWithWindowTargets([{ x: 100, y: 90, width: 320, height: 240 }]);
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    fireEvent.pointerMove(overlay, {
      buttons: 0,
      pointerId: 27,
      clientX: 160,
      clientY: 150,
    });
    fireEvent.pointerDown(overlay, {
      button: 0,
      buttons: 1,
      pointerId: 27,
      clientX: 160,
      clientY: 150,
    });
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 27,
      clientX: 190,
      clientY: 180,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 27,
      clientX: 190,
      clientY: 180,
    });

    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();
    expect(selection!.style.left).toBe("160px");
    expect(selection!.style.top).toBe("150px");
    expect(selection!.style.width).toBe("30px");
    expect(selection!.style.height).toBe("30px");
  });

  it("snaps both ends of a manual drag to nearby window edges unless Alt is held", async () => {
    mockCaptureWithWindowTargets([{ x: 100, y: 90, width: 320, height: 240 }]);
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    fireEvent.pointerDown(overlay, {
      button: 0,
      buttons: 1,
      pointerId: 28,
      clientX: 106,
      clientY: 96,
    });
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 28,
      clientX: 412,
      clientY: 322,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 28,
      clientX: 412,
      clientY: 322,
    });

    let selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection!.style.left).toBe("100px");
    expect(selection!.style.top).toBe("90px");
    expect(selection!.style.width).toBe("320px");
    expect(selection!.style.height).toBe("240px");

    fireEvent.pointerDown(overlay, {
      button: 0,
      buttons: 1,
      pointerId: 29,
      clientX: 106,
      clientY: 96,
    });
    fireEvent.pointerMove(overlay, {
      altKey: true,
      buttons: 1,
      pointerId: 29,
      clientX: 412,
      clientY: 322,
    });
    fireEvent.pointerUp(overlay, {
      altKey: true,
      button: 0,
      buttons: 0,
      pointerId: 29,
      clientX: 412,
      clientY: 322,
    });

    selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection!.style.left).toBe("106px");
    expect(selection!.style.top).toBe("96px");
    expect(selection!.style.width).toBe("306px");
    expect(selection!.style.height).toBe("226px");
  });

  it("snaps resize handles to nearby window edges unless Alt is held", async () => {
    mockCaptureWithWindowTargets([
      { x: 100, y: 90, width: 320, height: 240 },
      { x: 500, y: 90, width: 200, height: 240 },
    ]);
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    fireEvent.pointerDown(overlay, {
      button: 0,
      buttons: 1,
      pointerId: 31,
      clientX: 160,
      clientY: 150,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 31,
      clientX: 160,
      clientY: 150,
    });

    const eastHandle = screen.getByRole("button", { name: "调整 e" });
    fireEvent.pointerDown(eastHandle, {
      button: 0,
      buttons: 1,
      pointerId: 32,
      clientX: 420,
      clientY: 210,
    });
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 32,
      clientX: 492,
      clientY: 210,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 32,
      clientX: 492,
      clientY: 210,
    });

    let selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection!.style.width).toBe("400px");

    fireEvent.pointerDown(eastHandle, {
      button: 0,
      buttons: 1,
      pointerId: 33,
      clientX: 500,
      clientY: 210,
    });
    fireEvent.pointerMove(overlay, {
      altKey: true,
      buttons: 1,
      pointerId: 33,
      clientX: 492,
      clientY: 210,
    });
    fireEvent.pointerUp(overlay, {
      altKey: true,
      button: 0,
      buttons: 0,
      pointerId: 33,
      clientX: 492,
      clientY: 210,
    });

    selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection!.style.width).toBe("392px");
  });

  it("shows the custom move cursor over a completed annotation while its drawing tool stays active", async () => {
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 31);

    fireEvent.click(await screen.findByRole("button", { name: "矩形" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 32,
      clientX: 60,
      clientY: 60,
    });
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 32,
      clientX: 120,
      clientY: 100,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 32,
      clientX: 120,
      clientY: 100,
    });

    fireEvent.pointerMove(selection!, {
      buttons: 0,
      pointerId: 33,
      clientX: 60,
      clientY: 80,
    });

    expectCustomMoveCursor(selection!);
  });

  it("drags a completed annotation instead of drawing another one", async () => {
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 41);

    fireEvent.click(await screen.findByRole("button", { name: "矩形" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 42,
      clientX: 60,
      clientY: 60,
    });
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 42,
      clientX: 120,
      clientY: 100,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 42,
      clientX: 120,
      clientY: 100,
    });

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 43,
      clientX: 60,
      clientY: 80,
    });
    expectCustomMoveCursor(selection!);
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 43,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 43,
      clientX: 100,
      clientY: 100,
    });

    fireEvent.pointerMove(selection!, {
      buttons: 0,
      pointerId: 44,
      clientX: 60,
      clientY: 80,
    });
    expect(selection!.style.cursor).not.toContain("url(");

    fireEvent.pointerMove(selection!, {
      buttons: 0,
      pointerId: 44,
      clientX: 100,
      clientY: 100,
    });
    expectCustomMoveCursor(selection!);
  });

  it("clears annotation hover state when undo removes the hovered annotation", async () => {
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 51);

    fireEvent.click(await screen.findByRole("button", { name: "矩形" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 52,
      clientX: 60,
      clientY: 60,
    });
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 52,
      clientX: 120,
      clientY: 100,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 52,
      clientX: 120,
      clientY: 100,
    });
    fireEvent.pointerMove(selection!, {
      buttons: 0,
      pointerId: 53,
      clientX: 60,
      clientY: 80,
    });
    expectCustomMoveCursor(selection!);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    expect(selection!.style.cursor).not.toContain("url(");
  });

  it("restores the annotation and clears drag state when the pointer interaction is cancelled", async () => {
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 61);

    fireEvent.click(await screen.findByRole("button", { name: "矩形" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 62,
      clientX: 60,
      clientY: 60,
    });
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 62,
      clientX: 120,
      clientY: 100,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 62,
      clientX: 120,
      clientY: 100,
    });

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 63,
      clientX: 60,
      clientY: 80,
    });
    expectCustomMoveCursor(selection!);
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 63,
      clientX: 110,
      clientY: 110,
    });

    fireEvent.pointerCancel(overlay, {
      buttons: 0,
      pointerId: 63,
      clientX: 110,
      clientY: 110,
    });

    expect(selection!.style.cursor).not.toContain("url(");

    fireEvent.pointerMove(selection!, {
      buttons: 0,
      pointerId: 64,
      clientX: 60,
      clientY: 80,
    });
    expectCustomMoveCursor(selection!);

    fireEvent.pointerMove(selection!, {
      buttons: 0,
      pointerId: 64,
      clientX: 110,
      clientY: 110,
    });
    expect(selection!.style.cursor).not.toContain("url(");
  });

  it("cancels an in-progress annotation move without undoing another annotation", async () => {
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 65);

    fireEvent.click(await screen.findByRole("button", { name: "矩形" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, { button: 0, buttons: 1, pointerId: 66, clientX: 60, clientY: 60 });
    fireEvent.pointerMove(overlay, { buttons: 1, pointerId: 66, clientX: 120, clientY: 100 });
    fireEvent.pointerUp(overlay, { button: 0, buttons: 0, pointerId: 66, clientX: 120, clientY: 100 });

    fireEvent.pointerDown(selection!, { button: 0, buttons: 1, pointerId: 67, clientX: 180, clientY: 60 });
    fireEvent.pointerMove(overlay, { buttons: 1, pointerId: 67, clientX: 210, clientY: 100 });
    fireEvent.pointerUp(overlay, { button: 0, buttons: 0, pointerId: 67, clientX: 210, clientY: 100 });

    fireEvent.pointerDown(selection!, { button: 0, buttons: 1, pointerId: 68, clientX: 60, clientY: 80 });
    fireEvent.pointerMove(overlay, { buttons: 1, pointerId: 68, clientX: 110, clientY: 110 });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.pointerUp(overlay, { button: 0, buttons: 0, pointerId: 68, clientX: 110, clientY: 110 });

    fireEvent.pointerMove(selection!, { buttons: 0, pointerId: 69, clientX: 60, clientY: 80 });
    expectCustomMoveCursor(selection!);

    fireEvent.pointerMove(selection!, { buttons: 0, pointerId: 69, clientX: 180, clientY: 80 });
    expectCustomMoveCursor(selection!);
  });

  it("undoes a completed annotation move without deleting a later annotation", async () => {
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 75);

    fireEvent.click(await screen.findByRole("button", { name: "矩形" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, { button: 0, buttons: 1, pointerId: 76, clientX: 60, clientY: 60 });
    fireEvent.pointerMove(overlay, { buttons: 1, pointerId: 76, clientX: 120, clientY: 100 });
    fireEvent.pointerUp(overlay, { button: 0, buttons: 0, pointerId: 76, clientX: 120, clientY: 100 });

    fireEvent.pointerDown(selection!, { button: 0, buttons: 1, pointerId: 77, clientX: 180, clientY: 60 });
    fireEvent.pointerMove(overlay, { buttons: 1, pointerId: 77, clientX: 210, clientY: 100 });
    fireEvent.pointerUp(overlay, { button: 0, buttons: 0, pointerId: 77, clientX: 210, clientY: 100 });

    fireEvent.pointerDown(selection!, { button: 0, buttons: 1, pointerId: 78, clientX: 60, clientY: 80 });
    fireEvent.pointerMove(overlay, { buttons: 1, pointerId: 78, clientX: 110, clientY: 110 });
    fireEvent.pointerUp(overlay, { button: 0, buttons: 0, pointerId: 78, clientX: 110, clientY: 110 });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    fireEvent.pointerMove(selection!, { buttons: 0, pointerId: 79, clientX: 60, clientY: 80 });
    expectCustomMoveCursor(selection!);

    fireEvent.pointerMove(selection!, { buttons: 0, pointerId: 79, clientX: 180, clientY: 80 });
    expectCustomMoveCursor(selection!);

    fireEvent.pointerMove(selection!, { buttons: 0, pointerId: 79, clientX: 110, clientY: 110 });
    expect(selection!.style.cursor).not.toContain("url(");
  });

  it("does not open a new text editor after dragging an existing text annotation", async () => {
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 71);

    fireEvent.click(await screen.findByRole("button", { name: "文字" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 72,
      clientX: 60,
      clientY: 60,
    });
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "标注" } });
    fireEvent.blur(editor);
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 73,
      clientX: 65,
      clientY: 70,
    });
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 73,
      clientX: 95,
      clientY: 90,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 73,
      clientX: 95,
      clientY: 90,
    });
    fireEvent.click(selection!, { clientX: 95, clientY: 90 });

    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows typed text directly without a visible editor surface", async () => {
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 80);
    fireEvent.click(await screen.findByRole("button", { name: "文字" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 81,
      clientX: 60,
      clientY: 60,
    });
    const editor = await screen.findByRole("textbox");

    fireEvent.change(editor, { target: { value: "逐字显示" } });
    expect((editor as HTMLInputElement).value).toBe("逐字显示");
    const style = window.getComputedStyle(editor);
    const inlineStyle = editor.getAttribute("style") ?? "";
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(inlineStyle).toContain("border-width: 0px");
    expect(inlineStyle).toContain("box-shadow: none");
    expect(style.color).toBe("rgba(0, 0, 0, 0)");
  });

  it("keeps a long inline text preview aligned with the exported result near the right edge", async () => {
    const annotationFillText = vi.fn();
    const exportFillText = vi.fn();
    const contextFor = (fillText: ReturnType<typeof vi.fn>) => ({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillText,
      restore: vi.fn(),
      save: vi.fn(),
    });
    const annotationContext = contextFor(annotationFillText);
    const exportContext = contextFor(exportFillText);
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(function (this: HTMLCanvasElement) {
        return this.isConnected ? annotationContext : exportContext;
      }),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,bG9uZy10ZXh0");
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 92);
    fireEvent.click(await screen.findByRole("button", { name: "文字" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 93,
      clientX: 205,
      clientY: 60,
    });
    const editor = await screen.findByRole("textbox");
    const longText = "这是一段会超过选区右边缘的长文字内容";
    fireEvent.change(editor, { target: { value: longText } });

    await waitFor(() => expect(annotationFillText).toHaveBeenCalledWith(longText, expect.any(Number), expect.any(Number)));
    const previewCall = annotationFillText.mock.calls.at(-1);
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(bridge.finishScreenshot).toHaveBeenCalledOnce());
    expect(exportFillText).toHaveBeenCalledWith(...previewCall!);
  });

  it("includes text in the exported screenshot without requiring Enter", async () => {
    const annotationFillText = vi.fn();
    const exportFillText = vi.fn();
    const contextFor = (fillText: ReturnType<typeof vi.fn>) => ({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillText,
      restore: vi.fn(),
      save: vi.fn(),
    });
    const annotationContext = contextFor(annotationFillText);
    const exportContext = contextFor(exportFillText);
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(function (this: HTMLCanvasElement) {
        return this.isConnected ? annotationContext : exportContext;
      }),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,dGV4dA==");
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 82);
    fireEvent.click(await screen.findByRole("button", { name: "文字" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 83,
      clientX: 60,
      clientY: 60,
    });
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "不按回车也保留" } });
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(bridge.finishScreenshot).toHaveBeenCalledOnce());
    expect(exportFillText).toHaveBeenCalledTimes(1);
    expect(exportFillText).toHaveBeenCalledWith("不按回车也保留", expect.any(Number), expect.any(Number));
  });

  it("exports inline text once when blur happens before the complete click", async () => {
    const exportFillText = vi.fn();
    const contextFor = (fillText = vi.fn()) => ({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillText,
      restore: vi.fn(),
      save: vi.fn(),
    });
    const annotationContext = contextFor();
    const exportContext = contextFor(exportFillText);
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(function (this: HTMLCanvasElement) {
        return this.isConnected ? annotationContext : exportContext;
      }),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,Ymx1cg==");
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 86);
    fireEvent.click(await screen.findByRole("button", { name: "文字" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 87,
      clientX: 60,
      clientY: 60,
    });
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "只导出一次" } });
    const completeButton = screen.getByRole("button", { name: "完成" });
    act(() => {
      fireEvent.blur(editor);
      fireEvent.click(completeButton);
    });

    await waitFor(() => expect(bridge.finishScreenshot).toHaveBeenCalledOnce());
    expect(exportFillText).toHaveBeenCalledTimes(1);
    expect(exportFillText).toHaveBeenCalledWith("只导出一次", expect.any(Number), expect.any(Number));
  });

  it("keeps the first text and opens a fresh editor when the user clicks a second position", async () => {
    const fillText = vi.fn();
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillText,
      restore: vi.fn(),
      save: vi.fn(),
    };
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => context),
    });
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 88);
    fireEvent.click(await screen.findByRole("button", { name: "文字" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 89,
      clientX: 60,
      clientY: 60,
    });
    const firstEditor = await screen.findByRole("textbox");
    fireEvent.change(firstEditor, { target: { value: "第一段" } });
    const firstLeft = (firstEditor as HTMLElement).style.left;
    fillText.mockClear();

    act(() => {
      fireEvent.pointerDown(selection!, {
        button: 0,
        buttons: 1,
        pointerId: 90,
        clientX: 130,
        clientY: 90,
      });
      fireEvent.blur(firstEditor);
    });

    const secondEditor = screen.getByRole("textbox");
    expect((secondEditor as HTMLElement).style.left).not.toBe(firstLeft);
    expect((secondEditor as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(fillText).toHaveBeenCalledWith("第一段", expect.any(Number), expect.any(Number)));
  });

  it("keeps a text draft when the next click selects an existing annotation", async () => {
    const exportFillText = vi.fn();
    const contextFor = (fillText = vi.fn()) => ({
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillText,
      restore: vi.fn(),
      save: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
    });
    const annotationContext = contextFor();
    const exportContext = contextFor(exportFillText);
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(function (this: HTMLCanvasElement) {
        return this.isConnected ? annotationContext : exportContext;
      }),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,aGlzdG9yeQ==");
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 91);
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "矩形" }));
    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 92,
      clientX: 60,
      clientY: 60,
    });
    fireEvent.pointerMove(overlay, {
      buttons: 1,
      pointerId: 92,
      clientX: 120,
      clientY: 100,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 92,
      clientX: 120,
      clientY: 100,
    });

    fireEvent.click(screen.getByRole("button", { name: "文字" }));
    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 93,
      clientX: 160,
      clientY: 120,
    });
    const editor = await screen.findByRole("textbox");
    fireEvent.change(editor, { target: { value: "不能被旧快照删除" } });

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 94,
      clientX: 60,
      clientY: 80,
    });
    fireEvent.pointerUp(overlay, {
      button: 0,
      buttons: 0,
      pointerId: 94,
      clientX: 60,
      clientY: 80,
    });
    fireEvent.click(screen.getByRole("button", { name: "完成" }));

    await waitFor(() => expect(bridge.finishScreenshot).toHaveBeenCalledOnce());
    expect(exportFillText).toHaveBeenCalledTimes(1);
    expect(exportFillText).toHaveBeenCalledWith("不能被旧快照删除", expect.any(Number), expect.any(Number));
  });

  it("keeps the inline editor open when Enter confirms a Chinese IME composition", async () => {
    const { container } = render(<ScreenshotOverlay />);

    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const overlay = screen.getByRole("main");
    selectRegion(overlay, 84);
    fireEvent.click(await screen.findByRole("button", { name: "文字" }));
    const selection = container.querySelector<HTMLElement>(".screenshot-selection");
    expect(selection).not.toBeNull();

    fireEvent.pointerDown(selection!, {
      button: 0,
      buttons: 1,
      pointerId: 85,
      clientX: 60,
      clientY: 60,
    });
    const editor = await screen.findByRole("textbox");
    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: "输入" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(screen.getByRole("textbox")).toBe(editor);
    expect((editor as HTMLInputElement).value).toBe("输入");

    fireEvent.compositionEnd(editor);
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("resets the selected drawing tool for the next capture in the reused window", async () => {
    render(<ScreenshotOverlay />);

    await waitFor(() => {
      expect(events.listeners.has("screenshot-capture-ready")).toBe(true);
      expect(bridge.getScreenshotCapture).toHaveBeenCalledOnce();
    });

    const overlay = screen.getByRole("main");
    selectRegion(overlay, 1);

    const firstArrow = await screen.findByRole("button", { name: "箭头" });
    fireEvent.click(firstArrow);
    expect(firstArrow.classList.contains("is-active")).toBe(true);

    bridge.getScreenshotCapture.mockResolvedValueOnce({
      dataUrl: "data:image/png;base64,bmV4dA==",
      width: 1024,
      height: 768,
      sessionId: 2,
    });
    await act(async () => {
      events.listeners.get("screenshot-capture-ready")?.({ payload: 2 });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(bridge.getScreenshotCapture).toHaveBeenCalledTimes(2));

    selectRegion(overlay, 2);

    const secondArrow = await screen.findByRole("button", { name: "箭头" });
    expect(secondArrow.classList.contains("is-active")).toBe(false);
  });
});
