import { describe, expect, it } from "vitest";
import { cloudHeightSurface, cloudHeightAlpha, cloudMaskPixels } from "./cloudHeightMask";

describe("approved percentage cloud height", () => {
  it("uses vertical height rather than circle area or texture coordinates", () => {
    expect(cloudHeightSurface(64, 68, 68).line).toBe(24.48);
    expect(cloudHeightSurface(64, 68, 68).feather).toBe(6.57);
    expect(cloudHeightSurface(25, 100, 100).line).toBe(75);
  });
  it("keeps both sides at the same midpoint and softens around that height", () => {
    for (const level of [1, 25, 50, 64, 75, 99]) {
      const s = cloudHeightSurface(level, 68, 68);
      expect(cloudHeightAlpha(s, 17, s.line)).toBeCloseTo(.5, 12);
      expect(cloudHeightAlpha(s, 51, s.line)).toBeCloseTo(.5, 12);
      expect(cloudHeightAlpha(s, 17, s.line - s.feather)).toBeCloseTo(0, 12);
      expect(cloudHeightAlpha(s, 17, s.line + s.feather)).toBeCloseTo(1, 12);
    }
  });
  it("aligns a full photo wrapper and inset fog to the same global coordinates", () => {
    const s = cloudHeightSurface(64, 100, 100);
    const full = cloudMaskPixels(s, { x: 0, y: 0, width: 100, height: 100 }, 100);
    const inset = cloudMaskPixels(s, { x: 2, y: 2, width: 96, height: 96 }, 96);
    for (let y=0;y<96;y++) for (let x=0;x<96;x++) {
      expect(inset[(y*96+x)*4+3]).toBe(full[((y+2)*100+x+2)*4+3]);
    }
  });
  it("empties at zero and fills at one hundred, including out-of-range inputs", () => {
    for (const level of [-10, 0, 100, 110]) {
      const s = cloudHeightSurface(level, 68, 68);
      for (const y of [-5, 0, 34, 68, 80]) expect(cloudHeightAlpha(s, 34, y)).toBe(level <= 0 ? 0 : 1);
    }
  });
  it("uses empty state for missing or invalid quota", () => {
    for (const level of [null, Number.NaN, Infinity]) expect(cloudHeightSurface(level, 68, 68).quota).toBe(0);
  });
});
