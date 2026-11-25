import { useEffect, useRef } from 'react';

interface Star {
  r: number;
  angle: number;
  z: number;
  speed: number;
  size: number;
  sprite: number;
  alpha: number;
  twinkleSpeed: number;
  twinklePhase: number;
  dx: number;
  dy: number;
}

interface BgStar {
  nx: number;
  ny: number;
  size: number;
  alpha: number;
  twinklePhase: number;
  twinkleSpeed: number;
}

/**
 * Builds a crisp, pinpoint-core radial glow sprite with steep exponential falloff
 * so individual stars remain distinct rather than blurring into a cloud.
 */
function createStarSprite(
  tintRgb: string,
  withFlare = false,
  size = 96,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const half = size / 2;

  // Steep exponential-like radial falloff for crisp starlight
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(0.08, 'rgba(255, 255, 255, 0.98)');
  grad.addColorStop(0.18, `rgba(${tintRgb}, 0.55)`);
  grad.addColorStop(0.36, `rgba(${tintRgb}, 0.14)`);
  grad.addColorStop(0.65, `rgba(${tintRgb}, 0.025)`);
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  if (withFlare) {
    ctx.save();
    ctx.translate(half, half);
    const spikeLen = half * 0.88;
    const spikeGradH = ctx.createLinearGradient(-spikeLen, 0, spikeLen, 0);
    spikeGradH.addColorStop(0, 'rgba(255,255,255,0)');
    spikeGradH.addColorStop(0.45, `rgba(${tintRgb}, 0.32)`);
    spikeGradH.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    spikeGradH.addColorStop(0.55, `rgba(${tintRgb}, 0.32)`);
    spikeGradH.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spikeGradH;
    ctx.fillRect(-spikeLen, -0.75, spikeLen * 2, 1.5);

    const spikeGradV = ctx.createLinearGradient(0, -spikeLen, 0, spikeLen);
    spikeGradV.addColorStop(0, 'rgba(255,255,255,0)');
    spikeGradV.addColorStop(0.45, `rgba(${tintRgb}, 0.32)`);
    spikeGradV.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    spikeGradV.addColorStop(0.55, `rgba(${tintRgb}, 0.32)`);
    spikeGradV.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spikeGradV;
    ctx.fillRect(-0.75, -spikeLen, 1.5, spikeLen * 2);
    ctx.restore();
  }

  return canvas;
}

export function GalaxyCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    const sprites = [
      // 0: Crisp pure white
      createStarSprite('235, 245, 255', false),
      // 1: Crisp ice-blue
      createStarSprite('155, 210, 255', false),
      // 2: Crisp warm amber/gold
      createStarSprite('255, 195, 130', false),
      // 3: Bright beacon white-blue with subtle diffraction flare
      createStarSprite('200, 228, 255', true),
      // 4: Bright beacon warm gold with subtle diffraction flare
      createStarSprite('255, 205, 145', true),
    ];

    const starCount = 1750;
    const stars: Star[] = [];
    const arms = 2;
    const spiralTwist = 7.4;

    for (let i = 0; i < starCount; i++) {
      const u = Math.random();
      const isCore = u < 0.085;
      const r = isCore
        ? Math.pow(Math.random(), 1.9) * 0.065
        : 0.045 + Math.pow(Math.random(), 1.18) * 0.94;

      const armIndex = i % arms;
      const armBase = (armIndex / arms) * Math.PI * 2;

      // Tight, well-defined spiral lanes with clear dark space between arms
      const armSpread = isCore ? 2.6 : 0.075 + r * 0.14;
      const gauss = (Math.random() + Math.random() - 1) * armSpread;
      const stray = Math.random() < 0.06 ? (Math.random() - 0.5) * 1.4 : 0;
      const angle = armBase + r * spiralTwist + gauss + stray;

      const z = (Math.random() + Math.random() - 1) * (isCore ? 0.035 : 0.015);
      const speed = 0.045 + 0.11 / (0.2 + r * 1.5);

      const isBrightBeacon = !isCore && Math.random() < 0.075;
      let sprite: number;
      if (isCore) {
        sprite = 0;
      } else if (isBrightBeacon) {
        sprite = Math.random() < 0.72 ? 3 : 4;
      } else {
        const roll = Math.random();
        sprite = roll < 0.48 ? 0 : roll < 0.78 ? 1 : 2;
      }

      const size = isBrightBeacon
        ? 14 + Math.random() * 14
        : isCore
          ? 4.5 + Math.random() * 6.5
          : 3.2 + Math.random() * 6.0;

      stars.push({
        r,
        angle,
        z,
        speed,
        size,
        sprite,
        alpha: isBrightBeacon
          ? 0.95 + Math.random() * 0.05
          : isCore
            ? 0.78 + Math.random() * 0.22
            : 0.62 + Math.random() * 0.38,
        twinkleSpeed: 0.8 + Math.random() * 2.0,
        twinklePhase: Math.random() * Math.PI * 2,
        dx: 0,
        dy: 0,
      });
    }

    const bgStars: BgStar[] = Array.from({ length: 240 }, () => ({
      nx: Math.random(),
      ny: Math.random(),
      size: Math.random() < 0.06 ? 2.0 : 0.9 + Math.random() * 1.1,
      alpha: 0.28 + Math.random() * 0.65,
      twinklePhase: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.4 + Math.random() * 1.4,
    }));

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width || window.innerWidth);
      height = Math.max(1, rect.height || window.innerHeight);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    let pointerX = 0;
    let pointerY = 0;
    let pointerActive = false;
    let rawMouseX = -9999;
    let rawMouseY = -9999;
    // Nearly face-on inclination (~16 deg) so spiral arms open cleanly like Astra
    let tiltX = 0.28;
    let tiltY = -0.06;
    let targetTiltX = 0.28;
    let targetTiltY = -0.06;
    let pulseWave = 0;

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      rawMouseX = e.clientX - rect.left;
      rawMouseY = e.clientY - rect.top;
      pointerX = (rawMouseX / Math.max(1, width)) * 2 - 1;
      pointerY = (rawMouseY / Math.max(1, height)) * 2 - 1;
      pointerActive = true;
      targetTiltX = 0.28 + pointerY * 0.22;
      targetTiltY = -0.06 + pointerX * 0.22;
    };

    const onPointerLeave = () => {
      pointerActive = false;
      targetTiltX = 0.28;
      targetTiltY = -0.06;
    };

    const onPointerDown = () => {
      pulseWave = 1;
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointerdown', onPointerDown);

    let rafId = 0;
    let lastTime = performance.now();
    let elapsed = 0;

    const renderFrame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;
      if (!reducedMotion) {
        elapsed += dt;
        pulseWave *= Math.pow(0.25, dt);
      }

      tiltX += (targetTiltX - tiltX) * Math.min(1, dt * 4.5);
      tiltY += (targetTiltY - tiltY) * Math.min(1, dt * 4.5);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);

      // Crisp deep-space background stars
      for (const bg of bgStars) {
        const twinkle =
          0.68 + 0.32 * Math.sin(elapsed * bg.twinkleSpeed + bg.twinklePhase);
        ctx.fillStyle = `rgba(225, 238, 255, ${(bg.alpha * twinkle).toFixed(3)})`;
        ctx.fillRect(bg.nx * width, bg.ny * height, bg.size, bg.size);
      }

      const isNarrow = width < 860;
      const cx = isNarrow ? width * 0.54 : width * 0.63;
      const cy = isNarrow ? height * 0.44 : height * 0.5;
      const radiusScale = Math.min(
        width * (isNarrow ? 0.44 : 0.36),
        height * 0.46,
      );

      // Tight, pure-white core brilliance (no muddy yellow haze)
      ctx.globalCompositeOperation = 'lighter';
      const coreGlow = ctx.createRadialGradient(
        cx,
        cy,
        0,
        cx,
        cy,
        radiusScale * 0.24,
      );
      coreGlow.addColorStop(0, 'rgba(255, 255, 255, 0.72)');
      coreGlow.addColorStop(0.22, 'rgba(220, 238, 255, 0.28)');
      coreGlow.addColorStop(0.55, 'rgba(130, 185, 255, 0.05)');
      coreGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = coreGlow;
      ctx.fillRect(
        cx - radiusScale * 0.3,
        cy - radiusScale * 0.3,
        radiusScale * 0.6,
        radiusScale * 0.6,
      );

      const cosX = Math.cos(tiltX);
      const sinX = Math.sin(tiltX);
      const cosY = Math.cos(tiltY);
      const sinY = Math.sin(tiltY);
      const fov = 2.8;

      for (let i = 0; i < stars.length; i++) {
        const star = stars[i]!;
        const theta = star.angle - elapsed * star.speed;

        const x0 = Math.cos(theta) * star.r;
        const y0 = Math.sin(theta) * star.r;
        const z0 = star.z;

        const y1 = y0 * cosX - z0 * sinX;
        const z1 = y0 * sinX + z0 * cosX;
        const x2 = x0 * cosY + z1 * sinY;
        const z2 = -x0 * sinY + z1 * cosY;

        const depth = fov / Math.max(0.45, fov + z2);
        const pulseScale = 1 + pulseWave * 0.08 * (1 - star.r);
        let sx = cx + x2 * radiusScale * depth * pulseScale;
        let sy = cy + y1 * radiusScale * depth * pulseScale;

        if (pointerActive && !reducedMotion) {
          const mx = sx - rawMouseX;
          const my = sy - rawMouseY;
          const distSq = mx * mx + my * my;
          const interactRadius = 135;
          if (distSq < interactRadius * interactRadius && distSq > 1) {
            const dist = Math.sqrt(distSq);
            const force = (1 - dist / interactRadius) * 24;
            star.dx += ((mx / dist) * force - star.dx) * 0.16;
            star.dy += ((my / dist) * force - star.dy) * 0.16;
          } else {
            star.dx *= 0.9;
            star.dy *= 0.9;
          }
        } else {
          star.dx *= 0.9;
          star.dy *= 0.9;
        }

        sx += star.dx;
        sy += star.dy;

        const twinkle =
          0.76 +
          0.24 * Math.sin(elapsed * star.twinkleSpeed + star.twinklePhase);
        const drawAlpha = Math.min(1, star.alpha * twinkle * (0.75 + 0.25 * depth));
        const drawSize = star.size * depth;

        ctx.globalAlpha = drawAlpha;
        ctx.drawImage(
          sprites[star.sprite]!,
          sx - drawSize * 0.5,
          sy - drawSize * 0.5,
          drawSize,
          drawSize,
        );
      }
      ctx.globalAlpha = 1;

      if (!reducedMotion) {
        rafId = requestAnimationFrame(renderFrame);
      }
    };

    if (reducedMotion) {
      renderFrame(performance.now());
    } else {
      rafId = requestAnimationFrame(renderFrame);
    }

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="hero-galaxy-canvas"
      aria-hidden="true"
    />
  );
}
