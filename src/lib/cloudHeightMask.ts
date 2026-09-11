export interface CloudHeightSurface {
  quota: number;
  width: number;
  height: number;
  line: number;
  feather: number;
}

export interface CloudMaskRect { x: number; y: number; width: number; height: number }
export interface CloudHeightMotion { time: number; tilt: number; wave: number; energy: number; reducedMotion: boolean }

export function cloudHeightSurface(level: number | null, width: number, height: number): CloudHeightSurface {
  const quota = level !== null && Number.isFinite(level) ? Math.max(0, Math.min(1, level / 100)) : 0;
  return { quota, width, height, line: height * (1 - quota), feather: Math.min(height / 68 * 6.57, height * quota * .8, height * (1 - quota) * .8) };
}

export function cloudHeightOffset(surface: CloudHeightSurface, x: number, motion?: CloudHeightMotion): number {
  const { width, height, quota } = surface;
  const u = x / width;
  const ripple = height * (.004 * Math.cos(2 * Math.PI * u) + .002 * Math.cos(6 * Math.PI * u));
  if (!motion || motion.reducedMotion || quota <= 0 || quota >= 1) return ripple;
  const calm = 1 - Math.min(1, motion.energy / .08);
  const phase = motion.time * .00042;
  const ambient = height / 68 * calm * (
    .55 * Math.cos(2 * Math.PI * u) * Math.sin(phase)
    + .2 * Math.cos(6 * Math.PI * u) * Math.sin(phase * 1.35)
  );
  const tilt = motion.tilt * 7.2;
  const wave = motion.wave * 3.8;
  const limit = Math.min(height * .2, height * quota * .75, height * (1 - quota) * .75);
  const scale = Math.min(1, limit / Math.max(.001, Math.abs(tilt) + Math.abs(wave) + height / 68 * .75));
  // Both spatial waves and the drag tilt have zero mean across the orb.
  return ripple + scale * (tilt * (2 * u - 1) + wave * Math.cos(2 * Math.PI * u) + ambient);
}

export function cloudHeightAlpha(surface: CloudHeightSurface, x: number, y: number, motion?: CloudHeightMotion): number {
  const { quota, line, feather } = surface;
  if (quota <= 0) return 0;
  if (quota >= 1) return 1;
  const t = Math.max(0, Math.min(1, (y - line - cloudHeightOffset(surface, x, motion) + feather) / (2 * feather)));
  return t * t * (3 - 2 * t);
}

export function cloudMaskPixels(surface: CloudHeightSurface, target: CloudMaskRect, size = 256, motion?: CloudHeightMotion, output?: Uint8ClampedArray): Uint8ClampedArray {
  const pixels = output ?? new Uint8ClampedArray(size * size * 4);
  const offsets = Array.from({ length: size }, (_, x) => cloudHeightOffset(surface, target.x + (x + .5) * target.width / size, motion));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    if (surface.quota <= 0) pixels[i + 3] = 0;
    else if (surface.quota >= 1) pixels[i + 3] = 255;
    else {
      const t = Math.max(0, Math.min(1, (target.y + (y + .5) * target.height / size - surface.line - offsets[x] + surface.feather) / (2 * surface.feather)));
      pixels[i + 3] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  return pixels;
}

// Static endpoints and reduced-motion masks can be reused.
const maskCache = new Map<string, string>();
export function cloudMaskImage(surface: CloudHeightSurface, target: CloudMaskRect): string {
  const key = JSON.stringify([surface.quota, surface.width, surface.height, target]);
  const cached = maskCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) {
    if (surface.quota <= 0) return "linear-gradient(transparent, transparent)";
    if (surface.quota >= 1) return "linear-gradient(#000, #000)";
    const top = (surface.line - surface.feather - target.y) / target.height * 100;
    const bottom = (surface.line + surface.feather - target.y) / target.height * 100;
    return `linear-gradient(to bottom, transparent ${top}%, #000 ${bottom}%)`;
  }
  const image = context.createImageData(256, 256);
  image.data.set(cloudMaskPixels(surface, target));
  context.putImageData(image, 0, 0);
  const result = `url(${canvas.toDataURL()})`;
  if (maskCache.size >= 32) maskCache.delete(maskCache.keys().next().value!);
  maskCache.set(key, result);
  return result;
}

export function createCloudMaskRenderer(element: HTMLElement, surface: CloudHeightSurface, target: CloudMaskRect) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  const image = context?.createImageData(256, 256);
  let lastTime = -Infinity;
  let lastUrl = "";
  element.style.maskSize = "100% 100%";
  element.style.maskRepeat = "no-repeat";
  return (motion: CloudHeightMotion, force = false) => {
    const dynamic = surface.quota > 0 && surface.quota < 1 && !motion.reducedMotion;
    const interval = motion.energy > .008 ? 16 : 50;
    if (!force && ((!dynamic && lastUrl) || motion.time >= lastTime && motion.time - lastTime < interval)) return;
    lastTime = motion.time;
    let url: string;
    if (dynamic && context && image) {
      cloudMaskPixels(surface, target, 256, motion, image.data);
      context.putImageData(image, 0, 0);
      url = `url(${canvas.toDataURL()})`;
    } else url = cloudMaskImage(surface, target);
    if (url !== lastUrl) { element.style.maskImage = url; lastUrl = url; }
  };
}
