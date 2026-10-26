"use client";

import { useEffect, useRef } from "react";

/**
 * The JARVIS spark.
 *
 * A canvas-rendered amber particle core: a white-hot centre, a rotating dust shell, tilted
 * orbital rings and a burst of radiating spikes. Everything is drawn with additive
 * compositing so the light accumulates the way a real emitter does.
 *
 * Cost is deliberately bounded — the geometry is generated once, the frame loop stops when
 * the tab is hidden or the element is off-screen, and `prefers-reduced-motion` renders a
 * single still frame instead of animating.
 */

export type SparkState = "idle" | "listening" | "thinking" | "speaking";

interface Particle {
  x: number;
  y: number;
  z: number;
  size: number;
  alpha: number;
}

const PARTICLES = 1100;
const RING_COUNT = 3;
const SPIKES = 9;

const AMBER = "255, 154, 60";
const AMBER_HOT = "255, 214, 150";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildParticles(): Particle[] {
  const rand = mulberry32(0x5eed);
  const out: Particle[] = [];
  for (let i = 0; i < PARTICLES; i++) {
    // Uniform direction on the unit sphere, biased outward toward a shell.
    const u = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const radius = 0.72 + Math.pow(rand(), 0.35) * 0.34;
    out.push({
      x: s * Math.cos(theta) * radius,
      y: u * radius,
      z: s * Math.sin(theta) * radius,
      size: 0.6 + rand() * 1.5,
      alpha: 0.18 + rand() * 0.7,
    });
  }
  return out;
}

export default function SparkOrb({
  state = "idle",
  className = "",
  level = 0,
}: {
  state?: SparkState;
  className?: string;
  /** 0..1 live input level (mic amplitude or speech envelope). */
  level?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<Particle[] | null>(null);
  const stateRef = useRef(state);
  const levelRef = useRef(level);

  // Mirrored into refs by an effect: the draw loop owns the canvas and must read the live
  // state without the animation effect being torn down on every prop change.
  useEffect(() => {
    stateRef.current = state;
    levelRef.current = level;
  }, [state, level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    particlesRef.current ??= buildParticles();
    const particles = particlesRef.current;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let radius = 0;
    let frame = 0;
    let last = 0;
    let clock = 0;
    let visible = true;
    let running = true;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      radius = Math.min(width, height) * 0.34;
    };

    const draw = (t: number) => {
      const cx = width / 2;
      const cy = height / 2;
      const energy =
        stateRef.current === "speaking"
          ? 0.55 + levelRef.current * 0.9
          : stateRef.current === "listening"
            ? 0.75
            : stateRef.current === "thinking"
              ? 0.6
              : 0.45;
      const breath = 1 + Math.sin(t * 1.35) * 0.025 + energy * 0.03;

      ctx.clearRect(0, 0, width, height);

      // Halo — the soft light the sphere throws onto the black around it.
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 2.5);
      halo.addColorStop(0, `rgba(${AMBER}, ${0.3 + energy * 0.12})`);
      halo.addColorStop(0.28, `rgba(${AMBER}, 0.1)`);
      halo.addColorStop(1, "rgba(255, 120, 20, 0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, width, height);

      ctx.globalCompositeOperation = "lighter";

      // ------------------------------------------------------------- dust shell
      const rotY = t * 0.24;
      const rotX = Math.sin(t * 0.31) * 0.32;
      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);

      for (const p of particles) {
        // Rotate about Y then X.
        const x1 = p.x * cosY - p.z * sinY;
        const z1 = p.x * sinY + p.z * cosY;
        const y1 = p.y * cosX - z1 * sinX;
        const z2 = p.y * sinX + z1 * cosX;

        const depth = (z2 + 1) / 2; // 0 = far, 1 = near
        const scale = radius * breath * (0.94 + depth * 0.12);
        const px = cx + x1 * scale;
        const py = cy + y1 * scale;
        const alpha = p.alpha * (0.22 + depth * 0.78) * (0.55 + energy * 0.55);
        const size = p.size * (0.6 + depth * 0.9);

        ctx.fillStyle = `rgba(${AMBER_HOT}, ${alpha.toFixed(3)})`;
        ctx.fillRect(px, py, size, size);
      }

      // ------------------------------------------------------------ orbital rings
      for (let i = 0; i < RING_COUNT; i++) {
        const tilt = -0.55 + i * 0.5;
        const spin = t * (0.35 + i * 0.16) + i * 1.7;
        const rx = radius * breath * (1.02 - i * 0.06);
        const ry = rx * (0.3 + i * 0.05);

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(tilt);
        ctx.lineWidth = 1.6 - i * 0.25;
        ctx.strokeStyle = `rgba(${AMBER}, ${(0.16 + i * 0.03).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();

        // A brighter arc chasing around the ring.
        ctx.strokeStyle = `rgba(${AMBER_HOT}, ${(0.5 - i * 0.08).toFixed(3)})`;
        ctx.lineWidth = 2.2 - i * 0.3;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, spin, spin + 1.1 + i * 0.15);
        ctx.stroke();
        ctx.restore();
      }

      // ---------------------------------------------------------------- starburst
      for (let i = 0; i < SPIKES; i++) {
        const base = (i / SPIKES) * Math.PI * 2;
        const wobble = Math.sin(t * 0.9 + i * 2.1) * 0.12;
        const angle = base + wobble + t * 0.05;
        const long = i % 3 === 0;
        const inner = radius * (0.24 + Math.sin(t * 1.6 + i) * 0.02);
        const outer =
          radius * (long ? 1.62 : 1.18) * (1 + energy * 0.05) + Math.sin(t * 2.1 + i * 1.3) * 3;

        const grad = ctx.createLinearGradient(
          cx + Math.cos(angle) * inner,
          cy + Math.sin(angle) * inner,
          cx + Math.cos(angle) * outer,
          cy + Math.sin(angle) * outer
        );
        grad.addColorStop(0, `rgba(${AMBER_HOT}, ${0.55 + energy * 0.3})`);
        grad.addColorStop(0.45, `rgba(${AMBER}, 0.22)`);
        grad.addColorStop(1, "rgba(255, 120, 20, 0)");

        ctx.strokeStyle = grad;
        ctx.lineWidth = long ? 2 : 1.1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
        ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
        ctx.stroke();
      }

      // -------------------------------------------------------------------- core
      const coreR = radius * 0.2 * breath * (1 + energy * 0.12);
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      core.addColorStop(0, "rgba(255, 255, 245, 0.98)");
      core.addColorStop(0.35, `rgba(${AMBER_HOT}, 0.85)`);
      core.addColorStop(0.7, `rgba(${AMBER}, 0.28)`);
      core.addColorStop(1, "rgba(255, 120, 20, 0)");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = "source-over";
    };

    // ~40fps is plenty for this much glow, and keeping it under 60 keeps laptops cool.
    const tick = (now: number) => {
      if (!running) return;
      frame = requestAnimationFrame(tick);
      if (!visible || document.hidden) return;
      if (now - last < 24) return;
      const delta = last ? Math.min((now - last) / 1000, 0.1) : 0.016;
      last = now;
      clock += delta;
      draw(clock);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
      },
      { threshold: 0.01 }
    );
    observer.observe(canvas);

    const onResize = () => {
      resize();
      if (reduceMotion) draw(clock);
    };

    resize();
    if (reduceMotion) {
      clock = 1.6;
      draw(clock);
      running = false;
    } else {
      frame = requestAnimationFrame(tick);
    }

    window.addEventListener("resize", onResize);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
}
