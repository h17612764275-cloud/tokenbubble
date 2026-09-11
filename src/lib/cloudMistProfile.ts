export interface CloudMistProfile {
  quota: number;
  visualFraction: number;
  cloudCount: number;
  cloudAlpha: number;
  lowerCloudCount: number;
  lowerCloudAlpha: number;
}

export function getCloudMistProfile(level: number): CloudMistProfile {
  const quota = Math.min(1, Math.max(0, level / 100));

  return {
    quota,
    // Keep visible headroom below 100%. A truly full quota overscans the rim
    // so the antialiased edge has no empty strip.
    visualFraction: quota <= 0 ? 0 : quota >= 1 ? 1.08 : quota * .94,
    cloudCount: quota <= 0 ? 0 : 4 + Math.round(quota * 4),
    cloudAlpha: quota <= 0 ? 0 : .32 + quota * .14,
    lowerCloudCount: quota <= 0 ? 0 : 3 + Math.round(quota * 2),
    lowerCloudAlpha: quota <= 0 ? 0 : .2 + quota * .1,
  };
}
