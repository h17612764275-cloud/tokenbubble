// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshot } from "../types";
import { QuotaOrb } from "./QuotaCard";

vi.mock("../lib/bridge", () => ({
  listenWidgetMotion: vi.fn(async () => () => undefined),
}));

const snapshot: ProviderSnapshot = {
  provider: "codex",
  displayName: "CODEX",
  plan: "PRO",
  shortWindow: null,
  weeklyWindow: { remainingPercent: 91, resetsAt: "2026-08-18T00:00:00Z", windowSeconds: 604_800 },
  sparkWeeklyWindow: { remainingPercent: 98, resetsAt: "2026-08-19T00:00:00Z", windowSeconds: 604_800 },
  resetCredits: null,
  updatedAt: "2026-08-12T07:00:00Z",
  status: "ok",
  message: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => null) });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Original orb with Spark removed and independent quick menu", () => {
  it("keeps Codex quota after stationary clicks even when Spark data exists", async () => {
    const onDrag = vi.fn();
    render(<QuotaOrb snapshot={snapshot} language="en" onDrag={onDrag} onHover={() => undefined} />);
    const orb = screen.getByLabelText("Weekly quota remaining 91%");
    fireEvent.mouseDown(orb, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 1 });
    fireEvent.mouseUp(orb, { button: 0, buttons: 0, clientX: 20, clientY: 20, detail: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByLabelText("Weekly quota remaining 91%")).toBeTruthy();
    expect(screen.queryByLabelText(/Spark weekly/)).toBeNull();
    expect(onDrag).not.toHaveBeenCalled();
    expect(orb.querySelector(".orb-bubble-cloud")).toBeTruthy();
    expect(orb.querySelector(".orb-switch-cloud")?.className).toBe("orb-switch-cloud orb-switch-cloud--idle");
  });

  it("opens the separate menu without changing orb layout or starting a drag", async () => {
    const onOpenQuickActions = vi.fn();
    const onDrag = vi.fn();
    render(<QuotaOrb snapshot={snapshot} language="en" onDrag={onDrag} onHover={() => undefined} onOpenQuickActions={onOpenQuickActions} />);
    const orb = screen.getByLabelText("Weekly quota remaining 91%");
    const originalStyle = orb.getAttribute("style");
    fireEvent.mouseDown(orb, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 1 });
    const nativeMenuAllowed = fireEvent.contextMenu(orb);
    fireEvent.mouseMove(orb, { buttons: 1, clientX: 50, clientY: 20 });
    expect(nativeMenuAllowed).toBe(false);
    expect(onOpenQuickActions).toHaveBeenCalledTimes(1);
    expect(onDrag).not.toHaveBeenCalled();
    expect(orb.getAttribute("style")).toBe(originalStyle);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByLabelText(/Spark weekly/)).toBeNull();
  });

  it("starts dragging past four pixels without switching quota", async () => {
    const onDrag = vi.fn();
    render(<QuotaOrb snapshot={snapshot} language="en" onDrag={onDrag} onHover={() => undefined} />);
    const orb = screen.getByLabelText("Weekly quota remaining 91%");

    fireEvent.mouseDown(orb, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 1 });
    fireEvent.mouseMove(orb, { buttons: 1, clientX: 25, clientY: 20 });
    fireEvent.mouseUp(orb, { button: 0, buttons: 0, clientX: 25, clientY: 20, detail: 1 });

    expect(onDrag).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByLabelText("Weekly quota remaining 91%")).toBeTruthy();
  });

  it("does not turn a locked drag gesture into a Spark click", async () => {
    const onDrag = vi.fn();
    render(<QuotaOrb snapshot={snapshot} language="en" positionLocked onDrag={onDrag} onHover={() => undefined} />);
    const orb = screen.getByLabelText("Weekly quota remaining 91%");

    fireEvent.mouseDown(orb, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 1 });
    fireEvent.mouseMove(orb, { buttons: 1, clientX: 27, clientY: 20 });
    fireEvent.mouseUp(orb, { button: 0, buttons: 0, clientX: 27, clientY: 20, detail: 1 });

    expect(onDrag).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByLabelText("Weekly quota remaining 91%")).toBeTruthy();
  });

  it("keeps the existing double-click panel action without switching quota", async () => {
    const onOpenPanel = vi.fn();
    render(<QuotaOrb snapshot={snapshot} language="en" onDrag={() => undefined} onHover={() => undefined} onOpenPanel={onOpenPanel} />);
    const orb = screen.getByLabelText("Weekly quota remaining 91%");

    fireEvent.mouseDown(orb, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 1 });
    fireEvent.mouseUp(orb, { button: 0, buttons: 0, clientX: 20, clientY: 20, detail: 1 });
    fireEvent.mouseDown(orb, { button: 0, buttons: 1, clientX: 20, clientY: 20, detail: 2 });
    fireEvent.mouseUp(orb, { button: 0, buttons: 0, clientX: 20, clientY: 20, detail: 2 });

    expect(onOpenPanel).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByLabelText("Weekly quota remaining 91%")).toBeTruthy();
  });
});
