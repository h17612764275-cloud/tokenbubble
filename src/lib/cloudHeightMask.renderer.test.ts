// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudHeightSurface, createCloudMaskRenderer, type CloudHeightMotion } from "./cloudHeightMask";

const surface = cloudHeightSurface(64, 68, 68);
const target = { x: 0, y: 0, width: 68, height: 68 };
const frame = (time: number): CloudHeightMotion => ({ time, tilt: 0, wave: 0, energy: 0, reducedMotion: false });

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const decodes: ReturnType<typeof deferred>[] = [];
const sources: string[] = [];
const canvasContext = {
  createImageData: () => ({ data: new Uint8ClampedArray(256 * 256 * 4) }),
  putImageData: vi.fn(),
};
const originalGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
const originalToDataURL = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "toDataURL");

beforeEach(() => {
  decodes.length = 0;
  sources.length = 0;
  let sequence = 0;
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => canvasContext });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true, value: () => `data:image/png;base64,frame-${++sequence}`,
  });
  vi.stubGlobal("Image", class {
    private source = "";
    set src(value: string) { this.source = value; sources.push(value); }
    get src() { return this.source; }
    decode() { const pending = deferred(); decodes.push(pending); return pending.promise; }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalGetContext) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalGetContext);
  if (originalToDataURL) Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", originalToDataURL);
});

describe("cloud mask renderer decode handoff", () => {
  it("shows a same-height gradient while the first PNG is decoding", async () => {
    const element = document.createElement("div");
    const render = createCloudMaskRenderer(element, surface, target);
    const top = (surface.line - surface.feather) / target.height * 100;
    const bottom = (surface.line + surface.feather) / target.height * 100;
    const fallback = `linear-gradient(to bottom, transparent ${top}%, #000 ${bottom}%)`;
    expect(element.style.maskImage).toBe(fallback);
    render(frame(0), true);
    await Promise.resolve();
    expect(element.style.maskImage).toBe(fallback);
    decodes[0].resolve();
    await vi.waitFor(() => expect(element.style.maskImage).toBe("url(data:image/png;base64,frame-1)"));
    render.dispose();
  });

  it("keeps the previous mask until decode and queues only the latest frame", async () => {
    const element = document.createElement("div");
    element.style.maskImage = "linear-gradient(#000, #000)";
    const render = createCloudMaskRenderer(element, surface, target);
    render(frame(0), true);
    await Promise.resolve();
    expect(decodes).toHaveLength(1);
    expect(element.style.maskImage).toBe("linear-gradient(#000, #000)");

    render(frame(100));
    render(frame(200));
    render(frame(300));
    expect(decodes).toHaveLength(1);
    decodes[0].resolve();
    await vi.waitFor(() => expect(decodes).toHaveLength(2));
    expect(element.style.maskImage).toBe("url(data:image/png;base64,frame-1)");
    expect(sources).toEqual(["data:image/png;base64,frame-1", "data:image/png;base64,frame-2"]);

    decodes[1].resolve();
    await vi.waitFor(() => expect(element.style.maskImage).toBe("url(data:image/png;base64,frame-2)"));
    render.dispose();
  });

  it("leaves the old mask visible on failure and can publish the queued frame", async () => {
    const element = document.createElement("div");
    element.style.maskImage = "linear-gradient(#000, #000)";
    const render = createCloudMaskRenderer(element, surface, target);
    render(frame(0), true);
    await Promise.resolve();
    render(frame(100));
    decodes[0].reject(new Error("decode failed"));
    await vi.waitFor(() => expect(decodes).toHaveLength(2));
    expect(element.style.maskImage).toBe("linear-gradient(#000, #000)");
    decodes[1].resolve();
    await vi.waitFor(() => expect(element.style.maskImage).toBe("url(data:image/png;base64,frame-2)"));
    render.dispose();
  });

  it("ignores a pending decode after disposal and cannot overwrite a replacement renderer", async () => {
    const element = document.createElement("div");
    element.style.maskImage = "linear-gradient(#000, #000)";
    const oldRender = createCloudMaskRenderer(element, surface, target);
    oldRender(frame(0), true);
    await Promise.resolve();
    oldRender.dispose();

    const newRender = createCloudMaskRenderer(element, surface, target);
    newRender(frame(500), true);
    await Promise.resolve();
    decodes[1].resolve();
    await vi.waitFor(() => expect(element.style.maskImage).toBe("url(data:image/png;base64,frame-2)"));
    decodes[0].resolve();
    await Promise.resolve();
    oldRender(frame(1000), true);
    expect(element.style.maskImage).toBe("url(data:image/png;base64,frame-2)");
    expect(decodes).toHaveLength(2);
    newRender.dispose();
  });
});
