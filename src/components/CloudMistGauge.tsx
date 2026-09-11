import { memo, useEffect, useRef } from "react";
import { listenWidgetMotion } from "../lib/bridge";
import { getCloudMistProfile } from "../lib/cloudMistProfile";
import { applyLiquidMotion, initialLiquidPhysics, stepLiquidPhysics } from "../lib/liquidPhysics";
import type { CloudHeightMotion } from "../lib/cloudHeightMask";

interface Props {
  level: number;
  onMotionFrame?: (frame: CloudHeightMotion) => void;
}

function drawSoftCloud(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  alpha: number,
) {
  context.save();
  context.translate(x, y);
  context.scale(1, radiusY / radiusX);
  const cloud = context.createRadialGradient(0, 0, 0, 0, 0, radiusX);
  cloud.addColorStop(0, `rgba(255,255,255,${alpha})`);
  cloud.addColorStop(.42, `rgba(255,255,255,${alpha * .82})`);
  cloud.addColorStop(.76, `rgba(255,255,255,${alpha * .28})`);
  cloud.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = cloud;
  context.beginPath();
  context.arc(0, 0, radiusX, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

export const CloudMistGauge = memo(function CloudMistGauge({ level, onMotionFrame }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  const motionFrameRef = useRef(onMotionFrame);
  motionFrameRef.current = onMotionFrame;

  useEffect(() => { levelRef.current = level; }, [level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let physics = initialLiquidPhysics();
    let previousFrame = performance.now();
    let previousPosition: { x: number; y: number } | null = null;
    let frame = 0;
    let disposed = false;
    let unlisten: () => void = () => undefined;

    void listenWidgetMotion((position) => {
      if (previousPosition) {
        physics = applyLiquidMotion(
          physics,
          (position.x - previousPosition.x) * 1.16,
          (position.y - previousPosition.y) * .96,
        );
      }
      previousPosition = position;
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    const draw = (now: number) => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * ratio));
      const height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);

      physics = stepLiquidPhysics(physics, (now - previousFrame) / 1000, !reducedMotion.matches);
      previousFrame = now;

      const w = rect.width;
      const h = rect.height;
      const {
        visualFraction,
        cloudCount,
        cloudAlpha,
        lowerCloudCount,
        lowerCloudAlpha,
      } = getCloudMistProfile(levelRef.current);
      if (visualFraction <= 0) {
        frame = window.requestAnimationFrame(draw);
        return;
      }

      const motionEnergy = Math.min(
        1,
        Math.abs(physics.tilt) * .35 + Math.abs(physics.tiltVelocity) * .06 + Math.abs(physics.wave) * .28 + Math.abs(physics.waveVelocity) * .045,
      );
      const settled = reducedMotion.matches || motionEnergy < .008;
      const ambientPhase = reducedMotion.matches ? 0 : now * .00042;
      const drift = settled ? Math.sin(ambientPhase) * .56 : Math.sin(physics.phase * 2.15) * Math.min(4.2, motionEnergy * 5.6);
      const tilt = settled ? Math.sin(ambientPhase * .7) * .18 : physics.tilt * 7.2;
      const verticalSurge = settled ? Math.cos(ambientPhase * .82) * .24 : physics.wave * 3.8;
      const baseY = h - visualFraction * h;
      const feather = Math.max(10, h * .2);

      const body = context.createLinearGradient(0, baseY - feather, 0, h);
      body.addColorStop(0, "rgba(255,255,255,0)");
      body.addColorStop(.2, "rgba(255,255,255,.07)");
      body.addColorStop(.48, "rgba(255,255,255,.28)");
      body.addColorStop(.72, "rgba(255,255,255,.46)");
      body.addColorStop(1, "rgba(255,255,255,.58)");
      context.fillStyle = body;
      context.fillRect(0, Math.max(0, baseY - feather), w, h - baseY + feather);

      for (let index = 0; index < cloudCount; index += 1) {
        const normalizedX = (index + .35) / (cloudCount - .3);
        const x = w * normalizedX + Math.sin(ambientPhase * 1.7 + index * 1.41) * .88 - tilt * .42;
        const slope = tilt * ((x - w / 2) / Math.max(1, w / 2));
        const wave = Math.sin(index * 1.33 + ambientPhase * 2.2) * (settled ? .58 : Math.min(4.1, motionEnergy * 5.2));
        const radiusX = w * (.2 + (index % 3) * .025);
        const radiusY = h * (.115 + ((index + 1) % 3) * .015);
        drawSoftCloud(context, x, baseY + slope + wave + drift + verticalSurge, radiusX, radiusY, cloudAlpha);
      }

      for (let index = 0; index < lowerCloudCount; index += 1) {
        const normalizedX = lowerCloudCount === 1 ? .5 : .16 + index * (.68 / (lowerCloudCount - 1));
        const x = w * normalizedX + Math.cos(ambientPhase * 1.2 + index * 1.8) * .68 - tilt * .18;
        const y = baseY + feather * (.72 + (index % 2) * .48) + drift * .58 + verticalSurge * .72;
        drawSoftCloud(context, x, y, w * .28, h * .18, lowerCloudAlpha);
      }

      motionFrameRef.current?.({ time: now, tilt: physics.tilt, wave: physics.wave, energy: motionEnergy, reducedMotion: reducedMotion.matches });
      frame = window.requestAnimationFrame(draw);
    };

    frame = window.requestAnimationFrame(draw);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      unlisten();
    };
  }, []);

  return <canvas ref={canvasRef} className="orb-cloud-canvas" aria-hidden="true" />;
});
