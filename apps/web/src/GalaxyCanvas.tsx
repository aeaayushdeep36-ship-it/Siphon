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

function createGlowSprite(
  coreColor: string,
  midColor: string,
  outerColor: string,
  size = 64,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, coreColor);
  grad.addColorStop(0.18, midColor);
  grad.addColorStop(0.5, outerColor);
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
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
      // 0: Pure brilliant white
      createGlowSprite(
        'rgba(255, 255, 255, 1)',
        'rgba(245, 250, 255, 0.9)',
        'rgba(195, 225, 255, 0.28)',
      ),
      // 1: Stellar cool blue
      createGlowSprite(
        'rgba(255, 255, 255, 1)',
        'rgba(165, 220, 255, 0.88)',
        'rgba(95, 180, 255, 0.28)',
      ),
      // 2: Warm galactic core gold
      createGlowSprite(
        'rgba(255, 254, 245, 1)',
        'rgba(255, 228, 175, 0.9)',
        'rgba(255, 188, 110, 0.28)',
      ),
      // 3: Warm amber outer star
      createGlowSprite(
        'rgba(255, 248, 238, 1)',
        'rgba(255, 185, 125, 0.84)',
        'rgba(225, 130, 75, 0.24)',
      ),
    ];

    const starCount = 4200;
    const stars: Star[] = [];
    const arms = 2;
    const spiralTwist = 4.6;

    for (let i = 0; i < starCount; i++) {
      // Bias density toward the galactic core with long sweeping outer tails
      const u = Math.random();
      const isCore = u < 0.2;
      const r = isCore
        ? Math.pow(Math.random(), 1.8) * 0.15
        : 0.05 + Math.pow(Math.random(), 1.32) * 0.98;

      const armIndex = i % arms;
      const armBase = (armIndex / arms) * Math.PI * 2;
      // Tighter scatter near core, wider organic dispersion in outer arms
      const scatterScale = isCore ? 2.4 : 0.16 + r * 0.44;
      // Gaussian-like scatter using sum of two randoms
      const gauss = (Math.random() + Math.random() - 1) * scatterScale;
      const angle =
        armBase +
        r * spiralTwist +
        gauss +
        (Math.random() < 0.14 ? (Math.random() - 0.5) * 2.2 : 0);

      // Thin disk with slight bulge at center
      const thickness = isCore ? 0.08 : 0.025 + (1 - r) * 0.02;
      const z = (Math.random() + Math.random() - 1) * thickness;

      // Differential Keplerian-inspired angular velocity
      const speed = 0.055 + 0.14 / (0.18 + r * 1.4);

      // Sprite selection by radial temperature
      let sprite: number;
      if (r < 0.16) {
        sprite = Math.random() < 0.72 ? 2 : 0;
      } else if (Math.random() < 0.26) {
        sprite = 3;
      } else if (Math.random() < 0.52) {
        sprite = 1;
      } else {
        sprite = 0;
      }

      const isBrightBeacon = Math.random() < 0.085;
      const size = isBrightBeacon
        ? 11 + Math.random() * 13
        : isCore
          ? 4.0 + Math.random() * 6.0
          : 2.8 + Math.random() * 5.6;

      stars.push({
        r,
        angle,
        z,
        speed,
        size,
        sprite,
        alpha: isBrightBeacon
          ? 0.95 + Math.random() * 0.05
          : 0.55 + Math.random() * 0.45,
        twinkleSpeed: 0.8 + Math.random() * 2.2,
        twinklePhase: Math.random() * Math.PI * 2,
        dx: 0,
        dy: 0,
      });
    }

    const bgStars: BgStar[] = Array.from({ length: 380 }, () => ({
      nx: Math.random(),
      ny: Math.random(),
      size: Math.random() < 0.08 ? 1.8 + Math.random() * 1.6 : 0.8 + Math.random() * 1.5,
      alpha: 0.3 + Math.random() * 0.65,
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
    let tiltX = 0.72; // Default 3D inclination (~41 deg like Astra)
    let tiltY = -0.14;
    let targetTiltX = 0.72;
    let targetTiltY = -0.14;
    let pulseWave = 0;

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      rawMouseX = e.clientX - rect.left;
      rawMouseY = e.clientY - rect.top;
      pointerX = (rawMouseX / Math.max(1, width)) * 2 - 1;
      pointerY = (rawMouseY / Math.max(1, height)) * 2 - 1;
      pointerActive = true;
      targetTiltX = 0.72 + pointerY * 0.24;
      targetTiltY = -0.14 + pointerX * 0.24;
    };

    const onPointerLeave = () => {
      pointerActive = false;
      targetTiltX = 0.72;
      targetTiltY = -0.14;
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

      // Ambient deep-space background stars
      for (const bg of bgStars) {
        const twinkle =
          0.65 + 0.35 * Math.sin(elapsed * bg.twinkleSpeed + bg.twinklePhase);
        ctx.fillStyle = `rgba(215, 232, 255, ${(bg.alpha * twinkle).toFixed(3)})`;
        ctx.fillRect(bg.nx * width, bg.ny * height, bg.size, bg.size);
      }

      // Position galaxy center slightly right on wide screens so left-aligned hero text stays crisp
      const isNarrow = width < 860;
      const cx = isNarrow ? width * 0.5 : width * 0.62;
      const cy = isNarrow ? height * 0.42 : height * 0.5;
      const radiusScale = Math.min(width * (isNarrow ? 0.48 : 0.42), height * 0.48);

      // Subtle core nebula bloom
      ctx.globalCompositeOperation = 'lighter';
      const coreGlow = ctx.createRadialGradient(
        cx,
        cy,
        0,
        cx,
        cy,
        radiusScale * 0.55,
      );
      coreGlow.addColorStop(0, 'rgba(255, 246, 225, 0.42)');
      coreGlow.addColorStop(0.22, 'rgba(155, 210, 255, 0.18)');
      coreGlow.addColorStop(0.6, 'rgba(40, 80, 145, 0.05)');
      coreGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = coreGlow;
      ctx.fillRect(
        cx - radiusScale,
        cy - radiusScale,
        radiusScale * 2,
        radiusScale * 2,
      );

      const cosX = Math.cos(tiltX);
      const sinX = Math.sin(tiltX);
      const cosY = Math.cos(tiltY);
      const sinY = Math.sin(tiltY);
      const fov = 2.6;

      for (let i = 0; i < stars.length; i++) {
        const star = stars[i]!;
        const theta = star.angle - elapsed * star.speed;

        // 3D disk coordinates
        const x0 = Math.cos(theta) * star.r;
        const y0 = Math.sin(theta) * star.r;
        const z0 = star.z;

        // Rotate around X (inclination) then Y (yaw)
        const y1 = y0 * cosX - z0 * sinX;
        const z1 = y0 * sinX + z0 * cosX;
        const x2 = x0 * cosY + z1 * sinY;
        const z2 = -x0 * sinY + z1 * cosY;

        const depth = fov / Math.max(0.45, fov + z2);
        const pulseScale = 1 + pulseWave * 0.08 * (1 - star.r);
        let sx = cx + x2 * radiusScale * depth * pulseScale;
        let sy = cy + y1 * radiusScale * depth * pulseScale;

        // Interactive cursor swirl/repulsion
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
          0.74 +
          0.26 * Math.sin(elapsed * star.twinkleSpeed + star.twinklePhase);
        const drawAlpha = Math.min(1, star.alpha * twinkle * (0.7 + 0.3 * depth));
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
