import { describe, expect, it } from "vitest";
import { getCloudMistProfile } from "./cloudMistProfile";

describe("bubble cloud volume profile", () => {
  it("renders no cloud volume at zero quota", () => {
    expect(getCloudMistProfile(0)).toEqual({
      quota: 0,
      visualFraction: 0,
      cloudCount: 0,
      cloudAlpha: 0,
      lowerCloudCount: 0,
      lowerCloudAlpha: 0,
    });
  });

  it("increases cloud height and density with remaining quota", () => {
    const low = getCloudMistProfile(25);
    const middle = getCloudMistProfile(50);
    const high = getCloudMistProfile(89);

    expect(low.visualFraction).toBeLessThan(middle.visualFraction);
    expect(middle.visualFraction).toBeLessThan(high.visualFraction);
    expect(low.cloudCount).toBeLessThanOrEqual(middle.cloudCount);
    expect(middle.cloudCount).toBeLessThanOrEqual(high.cloudCount);
    expect(low.cloudAlpha).toBeLessThan(middle.cloudAlpha);
    expect(middle.cloudAlpha).toBeLessThan(high.cloudAlpha);
  });

  it("clamps invalid levels and only overscans at a full quota", () => {
    expect(getCloudMistProfile(-20).quota).toBe(0);
    expect(getCloudMistProfile(99).visualFraction).toBeLessThan(1);
    expect(getCloudMistProfile(100).visualFraction).toBe(1.08);
    expect(getCloudMistProfile(130)).toEqual(getCloudMistProfile(100));
  });
});
