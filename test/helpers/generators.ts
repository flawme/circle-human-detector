/**
 * Deterministic synthetic drawing generators used by the test suite and
 * the evaluation harness (scripts/evaluate.mjs).
 *
 * The human model is a movement synthesis, not a claim about all
 * humans: smooth angular-velocity modulation, start/end ramps, an
 * 8-12 Hz physiological tremor band, low-frequency radius wobble, and
 * OS-like timestamp jitter. The machine models represent the generator
 * classes the engine is designed to flag.
 *
 * Everything is driven by a seeded PRNG, so every test is reproducible.
 */

import type { PointerSample } from "../../src/types.ts";

/** Deterministic PRNG (mulberry32), returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller gaussian sample. */
export function gaussian(
  rand: () => number,
  mu: number,
  sigma: number,
): number {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

function clamp01to(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export interface HumanModelOptions {
  seed: number;
  radiusPx?: number;
  durationMs?: number;
  turns?: number;
  dtMeanMs?: number;
  pointerType?: "mouse" | "touch" | "pen";
  includePressure?: boolean;
}

/**
 * Human-like circle. Combines:
 * - smooth angular velocity modulation (1 and 2 cycles per sweep),
 * - start/end speed ramps (minimum-jerk-like envelope),
 * - low-frequency radius wobble (1-2 cycles) + slow center drift,
 * - 8-12 Hz physiological tremor,
 * - sub-pixel white noise,
 * - timestamp jitter with occasional coalescing hiccups.
 */
export function generateHumanCircle(
  opts: HumanModelOptions,
): PointerSample[] {
  const rand = mulberry32(opts.seed);
  const cx = 300 + 200 * rand();
  const cy = 250 + 200 * rand();
  const r0 = opts.radiusPx ?? 80 + 70 * rand();
  const T = opts.durationMs ?? 1100 + 1300 * rand();
  const turns = opts.turns ?? 1.02 + 0.16 * rand();
  const dtMean = opts.dtMeanMs ?? 7 + 7 * rand();
  const theta0 = rand() * 2 * Math.PI;

  const a1 = 0.15 + 0.25 * rand();
  const a2 = 0.05 + 0.15 * rand();
  const p1 = rand() * 2 * Math.PI;
  const p2 = rand() * 2 * Math.PI;
  const m1 = rand() < 0.5 ? 1 : 2;
  const w1 = 0.015 + 0.035 * rand();
  const w2 = 0.005 + 0.015 * rand();
  const p3 = rand() * 2 * Math.PI;
  const p4 = rand() * 2 * Math.PI;
  const tremorAmp = 0.004 + 0.006 * rand();
  const tremorHz = 8 + 4 * rand();
  const p5 = rand() * 2 * Math.PI;
  const noiseSigma = 0.1 + 0.2 * rand();
  const driftAmp = r0 * 0.03 * rand();
  const p6 = rand() * 2 * Math.PI;
  const p7 = rand() * 2 * Math.PI;

  // Timestamps: base jitter plus occasional coalescing hiccups.
  const ts: number[] = [0];
  for (;;) {
    const last = ts[ts.length - 1] as number;
    let dt = dtMean * (1 + 0.6 * (rand() - 0.5));
    if (rand() < 0.02) dt *= 1.5 + rand();
    if (last + dt > T) break;
    ts.push(last + dt);
  }
  const n = ts.length;
  const sweep = 2 * Math.PI * turns;

  // Angular velocity with ramps, normalized so the sweep is exact.
  const rawOmega: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const t0 = ts[i] as number;
    const t1 = ts[i + 1] as number;
    const sMid = ((t0 + t1) / 2) / T;
    const env = smoothstep(sMid / 0.12) * smoothstep((1 - sMid) / 0.1);
    rawOmega.push(
      env * (1 + a1 * Math.sin(2 * Math.PI * sMid + p1) + a2 * Math.sin(4 * Math.PI * sMid + p2)),
    );
  }
  let omegaScale = 0;
  for (let i = 0; i < rawOmega.length; i++) {
    omegaScale += (rawOmega[i] as number) * ((ts[i + 1] as number) - (ts[i] as number));
  }
  omegaScale = omegaScale > 0 ? sweep / omegaScale : 1;

  const thetas: number[] = [theta0];
  for (let i = 0; i + 1 < n; i++) {
    const prev = thetas[thetas.length - 1] as number;
    const dTheta = (rawOmega[i] as number) * omegaScale * ((ts[i + 1] as number) - (ts[i] as number));
    thetas.push(prev + dTheta);
  }

  const samples: PointerSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = ts[i] as number;
    const s = t / T;
    const r =
      r0 * (1 + w1 * Math.sin(2 * Math.PI * m1 * s + p3) + w2 * Math.sin(2 * Math.PI * (m1 + 1) * s + p4)) +
      r0 * tremorAmp * Math.sin(2 * Math.PI * tremorHz * (t / 1000) + p5);
    const dcx = driftAmp * Math.sin(2 * Math.PI * s + p6);
    const dcy = driftAmp * 0.6 * Math.cos(2 * Math.PI * s + p6);
    const theta = thetas[i] as number;
    const x = cx + dcx + r * Math.cos(theta) + gaussian(rand, 0, noiseSigma);
    const y = cy + dcy + r * Math.sin(theta) + gaussian(rand, 0, noiseSigma);
    const sample: PointerSample = { x, y, t: 1000 + t, stroke: 0 };
    if (opts.pointerType !== undefined) sample.pointerType = opts.pointerType;
    if (opts.includePressure === true) {
      sample.pointerType = opts.pointerType ?? "pen";
      sample.pressure = clamp01to(
        0.45 + 0.18 * Math.sin(2 * Math.PI * 1.3 * s + p7) + gaussian(rand, 0, 0.02),
        0.05,
        1,
      );
    }
    samples.push(sample);
  }
  return samples;
}

/** Machine generator variants. */
export type MachineVariant = "parametric" | "noisy" | "waypoint" | "adversarial";

export interface MachineModelOptions {
  seed: number;
  variant: MachineVariant;
  radiusPx?: number;
  durationMs?: number;
  samples?: number;
  turns?: number;
  noiseSigmaPx?: number;
}

/**
 * Machine-generated circles.
 *
 * - `parametric`: exact circle, constant angular velocity, uniform dt.
 *   The naive generator.
 * - `noisy`: parametric plus white positional noise (0.5-2 px).
 *   Amplitude fakes jitter, but the jitter is temporally independent.
 * - `waypoint`: circle approximated by chords between sparse anchors
 *   with linear interpolation between them. Produces exactly-collinear
 *   equal-step runs.
 * - `adversarial`: parametric plus start/end ramps, timestamp jitter,
 *   and white noise. Models a generator author who has read the
 *   obvious signatures; it evades the hard anomalies but still fails
 *   the human-consistency metrics.
 */
export function generateMachineCircle(
  opts: MachineModelOptions,
): PointerSample[] {
  const rand = mulberry32(opts.seed);
  const cx = 300 + 200 * rand();
  const cy = 250 + 200 * rand();
  const r0 = opts.radiusPx ?? 80 + 70 * rand();
  const T = opts.durationMs ?? 1200 + 800 * rand();
  const turns = opts.turns ?? 1;
  const theta0 = rand() * 2 * Math.PI;
  const sweep = 2 * Math.PI * turns;

  if (opts.variant === "parametric" || opts.variant === "noisy") {
    const n = opts.samples ?? 80 + Math.floor(60 * rand());
    const sigma =
      opts.variant === "noisy"
        ? opts.noiseSigmaPx ?? 0.5 + 1.5 * rand()
        : 0;
    const samples: PointerSample[] = [];
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const theta = theta0 + sweep * f;
      samples.push({
        x: cx + r0 * Math.cos(theta) + gaussian(rand, 0, sigma),
        y: cy + r0 * Math.sin(theta) + gaussian(rand, 0, sigma),
        t: 1000 + T * f,
        pointerType: "mouse",
        stroke: 0,
      });
    }
    return samples;
  }

  if (opts.variant === "waypoint") {
    const anchors = 16 + Math.floor(8 * rand());
    const sub = 6 + Math.floor(4 * rand());
    const total = anchors * sub; // steps; +1 points
    const dt = T / total;
    const samples: PointerSample[] = [];
    const px = (a: number): number => cx + r0 * Math.cos(theta0 + sweep * a);
    const py = (a: number): number => cy + r0 * Math.sin(theta0 + sweep * a);
    for (let i = 0; i <= total; i++) {
      const a = Math.floor(i / sub);
      const k = (i % sub) / sub;
      const ax = px(a / anchors);
      const ay = py(a / anchors);
      const bx = px(((a + 1) % anchors) / anchors);
      const by = py(((a + 1) % anchors) / anchors);
      samples.push({
        x: ax + (bx - ax) * k,
        y: ay + (by - ay) * k,
        t: 1000 + i * dt,
        pointerType: "mouse",
        stroke: 0,
      });
    }
    return samples;
  }

  // adversarial: constant omega + ramps + dt jitter + white noise.
  const n = opts.samples ?? 100 + Math.floor(50 * rand());
  const sigma = opts.noiseSigmaPx ?? 0.5 + rand();
  const dts: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const dt = (T / n) * (1 + 0.6 * (rand() - 0.5));
    dts.push(dt);
    acc += dt;
  }
  const ts: number[] = [0];
  for (const dt of dts) ts.push((ts[ts.length - 1] as number) + dt);
  const omegaRaw: number[] = [];
  for (let i = 0; i < n; i++) {
    const sMid = ((ts[i] as number) + (ts[i + 1] as number)) / 2 / T;
    omegaRaw.push(smoothstep(sMid / 0.12) * smoothstep((1 - sMid) / 0.1));
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (omegaRaw[i] as number) * ((ts[i + 1] as number) - (ts[i] as number));
  const scale = sum > 0 ? sweep / sum : 1;
  const samples: PointerSample[] = [];
  let theta = theta0;
  for (let i = 0; i <= n; i++) {
    const x = cx + r0 * Math.cos(theta) + gaussian(rand, 0, sigma);
    const y = cy + r0 * Math.sin(theta) + gaussian(rand, 0, sigma);
    samples.push({
      x,
      y,
      t: 1000 + (ts[i] as number),
      pointerType: "mouse",
      stroke: 0,
    });
    if (i < n) theta += (omegaRaw[i] as number) * scale * ((ts[i + 1] as number) - (ts[i] as number));
  }
  return samples;
}

/** Points along a straight line (non-circle fixture). */
export function generateStraightLine(n: number): PointerSample[] {
  const samples: PointerSample[] = [];
  for (let i = 0; i < n; i++) {
    samples.push({
      x: 100 + 4 * i,
      y: 200 + 2 * i,
      t: 1000 + 12 * i,
      pointerType: "mouse",
      stroke: 0,
    });
  }
  return samples;
}

/** Affine transforms for invariance tests (timestamps untouched). */
export function translateSamples(
  samples: readonly PointerSample[],
  dx: number,
  dy: number,
): PointerSample[] {
  return samples.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy }));
}

export function scaleSamples(
  samples: readonly PointerSample[],
  k: number,
): PointerSample[] {
  return samples.map((s) => ({ ...s, x: s.x * k, y: s.y * k }));
}

export function rotateSamples(
  samples: readonly PointerSample[],
  angleRad: number,
): PointerSample[] {
  let mx = 0;
  let my = 0;
  for (const s of samples) {
    mx += s.x;
    my += s.y;
  }
  mx /= samples.length;
  my /= samples.length;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return samples.map((s) => {
    const dx = s.x - mx;
    const dy = s.y - my;
    return {
      ...s,
      x: mx + dx * cos - dy * sin,
      y: my + dx * sin + dy * cos,
    };
  });
}
