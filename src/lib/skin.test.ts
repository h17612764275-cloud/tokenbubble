import { describe, expect, it } from "vitest";
import type { WidgetPreferences } from "../types";
import {
  FIXED_BUBBLE_WIDGET_ACCENT,
  hexToRgb,
  hsvToRgb,
  isDarkPanelColor,
  panelAccentColor,
  rgbToHsv,
  rgbToHex,
  widgetAccentColor,
  withPanelAccentColor,
  withWidgetStyle,
} from "./skin";

const preferences: WidgetPreferences = {
  locked: false,
  positionLocked: false,
  widgetSize: 68,
  accentColor: "#b97892",
  bubblePanelAccentColor: "#faa4ce",
  widgetStyle: "bottle",
  alwaysOnTop: true,
  stayExpanded: false,
  pinnedProvider: null,
  autoRotateSeconds: 12,
  language: "zh-CN",
  screenshotShortcut: "Ctrl+P",
  screenshotFolder: "",
};

describe("bound panel and widget skins", () => {
  it("round-trips RGB values without a native color picker", () => {
    expect(hexToRgb("#faa4ce")).toEqual([250, 164, 206]);
    expect(rgbToHex(250, 164, 206)).toBe("#faa4ce");
    expect(hsvToRgb(...rgbToHsv(250, 164, 206))).toEqual([250, 164, 206]);
  });

  it("keeps flat-panel color linked to the bottle widget", () => {
    const recolored = withPanelAccentColor(preferences, "#3178c6");
    expect(panelAccentColor(recolored)).toBe("#3178c6");
    expect(widgetAccentColor(recolored)).toBe("#3178c6");
  });

  it("recolors the bubble panel without changing the fixed bubble widget", () => {
    const bubble = withWidgetStyle(preferences, "bubble");
    const recolored = withPanelAccentColor(bubble, "#22aacc");
    expect(panelAccentColor(recolored)).toBe("#22aacc");
    expect(widgetAccentColor(recolored)).toBe(FIXED_BUBBLE_WIDGET_ACCENT);
    expect(recolored.accentColor).toBe("#b97892");
    expect(recolored.bubblePanelAccentColor).toBe("#22aacc");
  });

  it("preserves the bottle color when switching skins", () => {
    const bubble = withPanelAccentColor(withWidgetStyle(preferences, "bubble"), "#7657ff");
    const bottle = withWidgetStyle(bubble, "bottle");
    expect(panelAccentColor(bottle)).toBe("#b97892");
    expect(panelAccentColor(withWidgetStyle(bottle, "bubble"))).toBe("#7657ff");
  });

  it("classifies panel colors for contrast-aware heatmaps", () => {
    expect(isDarkPanelColor("#181b24")).toBe(true);
    expect(isDarkPanelColor("#f7f8fc")).toBe(false);
    expect(isDarkPanelColor("invalid")).toBe(false);
  });
});
