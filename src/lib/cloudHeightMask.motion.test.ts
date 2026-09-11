import { describe, expect, it } from "vitest";
import { cloudHeightSurface, cloudMaskPixels, cloudHeightOffset, type CloudHeightMotion } from "./cloudHeightMask";
import { applyLiquidMotion, initialLiquidPhysics, stepLiquidPhysics } from "./liquidPhysics";

const frame = (time: number, tilt = 0, wave = 0, energy = 0): CloudHeightMotion => ({ time, tilt, wave, energy, reducedMotion: false });
describe("visible cloud surface motion", () => {
  const surface = cloudHeightSurface(64, 68, 68);
  const rect = { x: 0, y: 0, width: 68, height: 68 };
  it("changes the visible mask at rest and during drag, not only the hidden cloud texture", () => {
    const start = cloudMaskPixels(surface, rect, 64, frame(0));
    expect(cloudMaskPixels(surface, rect, 64, frame(2500))).not.toEqual(start);
    expect(cloudMaskPixels(surface, rect, 64, frame(0, .7, .4, 1))).not.toEqual(start);
  });
  it("keeps idle ripples symmetric and the mean surface at the exact quota baseline", () => {
    for (const motion of [frame(0), frame(2500), frame(8000), frame(100, .7, .4, 1)]) {
      const offsets = Array.from({ length: 256 }, (_, i) => cloudHeightOffset(surface, (i+.5)*68/256, motion));
      expect(offsets.reduce((a,b)=>a+b,0)/256).toBeCloseTo(0, 10);
      expect(surface.line).toBe(24.48);
      if (motion.energy===0) {
        expect(cloudHeightOffset(surface, 12, motion)).toBeCloseTo(cloudHeightOffset(surface, 56, motion),10);
        expect(Math.max(...offsets)-Math.min(...offsets)).toBeLessThan(3);
      }
    }
  });
  it("returns to the idle ripple after the original liquid spring settles", () => {
    let physics=applyLiquidMotion(initialLiquidPhysics(),30,10);
    for(let i=0;i<300;i++) physics=stepLiquidPhysics(physics,1/60);
    const energy=Math.min(1,Math.abs(physics.tilt)*.35+Math.abs(physics.tiltVelocity)*.06+Math.abs(physics.wave)*.28+Math.abs(physics.waveVelocity)*.045);
    for(const x of [8,20,34,48,60]) expect(cloudHeightOffset(surface,x,frame(5000,physics.tilt,physics.wave,energy))).toBeCloseTo(cloudHeightOffset(surface,x,frame(5000)),2);
  });
  it("keeps empty/full endpoints and disables additional motion in reduced-motion mode", () => {
    for(const level of [0,100]) {
      const s=cloudHeightSurface(level,68,68);
      expect(cloudMaskPixels(s,rect,32,frame(5000,1,1,1))).toEqual(cloudMaskPixels(s,rect,32));
    }
    expect(cloudMaskPixels(surface,rect,32,{...frame(5000,1,1,1),reducedMotion:true})).toEqual(cloudMaskPixels(surface,rect,32));
  });
});
