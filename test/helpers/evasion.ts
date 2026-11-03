/**
 * Evasion attack generators: attempts to bypass the detector.
 *
 * Where `generators.ts` models "machines as they are commonly built",
 * this file models "machines built to defeat the detector". Every
 * generator is a component machine: the base is a constant-angular-
 * velocity circle (uniform timestamps, no ramps, no noise), and each
 * option fakes exactly one human structure the engine measures.
 *
 * Component toggles allow three families of attacks:
 * - single spoofs: fake one structure, leave the rest machine-like
 *   (verifies the "no single metric is trusted" design rule)
 * - combinations: partial stacks toward a complete fake
 * - ablations: the full synthesis minus one component (verifies each
 *   structure is load-bearing)
 *
 * Everything is seeded; every attack is reproducible.
 */

import type { PointerSample } from "../../src/types.ts";
import { gaussian, mulberry32 } from "./generators.ts";

/** Components of a human stroke an attacker can try to fake. */
export interface EvasionOptions {
  seed: number;
  /** 8-12 Hz sinusoidal radial oscillation (physiological band). */
  tremor?: boolean;
  /** 1-2 cycle low-frequency radius modulation. */
  wobble?: boolean;
  /** 1-2 cycle angular-speed modulation over the sweep. */
  modulation?: boolean;
  /** Smoothstep start/end velocity envelope. */
  ramps?: boolean;
  /** Human-like timestamp jitter instead of a uniform timer. */
  jitterTimestamps?: boolean;
  /** Pen pointerType with smoothly varying pressure. */
  pressure?: boolean;
  /** Autocorrelated (Ornstein-Uhlenbeck) positional noise. */
  smoothNoise?: boolean;
  /** Independent white positional noise, sigma in px. */
  whiteNoiseSigmaPx?: number;
  /** Slow large-scale radius wandering: a deliberately sloppy circle. */
  sloppyRadius?: boolean;
  /**
   * Scale on the sloppy wander's stationary std (default 1 = ~12% of
   * radius). The stealth-wander attack shrinks it to duck under the
   * mid-band wander ceiling of `BROADBAND_RADIUS_WANDER`.
   */
  sloppyScale?: number;
  /**
   * Inverse-omega decoupling: divide the angular-velocity profile by
   * the wander factor, so speed follows the modeled motor program
   * (v = omega * r = profile) instead of tracking the radius. Breaks
   * the radius-speed coupling the wander signature keys on, at the
   * cost of requiring an explicit speed-program model.
   */
  inverseOmega?: boolean;
  /** Split the drawing into this many strokes (pipeline abuse). */
  strokes?: number;
  radiusPx?: number;
  durationMs?: number;
  /**
   * Mean inter-sample interval in ms: attacker-controlled sampling
   * density. The default keeps the 9-12 ms event cadence and the
   * 80-sample floor of the corpus-scale attacks; an explicit value
   * removes the floor, modeling a generator that emits at whatever
   * rate it chooses (regime sweeps only).
   */
  dtMeanMs?: number;
  /** Turns override for regime sweeps (default 1.02-1.14). */
  turns?: number;
}

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/**
 * The component machine. Base behavior is maximally machine-like:
 * constant angular velocity, uniform timestamps, instant start, exact
 * radius. Each option layers one faked human structure on top.
 */
export function generateEvasionCircle(
  opts: EvasionOptions,
): PointerSample[] {
  const rand = mulberry32(opts.seed);
  const cx = 300 + 200 * rand();
  const cy = 250 + 200 * rand();
  const r0 = opts.radiusPx ?? 80 + 70 * rand();
  const T = opts.durationMs ?? 1300 + 900 * rand();
  const turnsRand = 1.02 + 0.12 * rand();
  const turns = opts.turns ?? turnsRand;
  const theta0 = rand() * 2 * Math.PI;
  const dtMeanRand = 9 + 3 * rand();
  const dtMean = opts.dtMeanMs ?? dtMeanRand;
  const nRaw = Math.floor(T / dtMean);
  // An explicit dtMeanMs models an attacker who controls the sampling
  // density, so the corpus-scale 80-sample floor does not apply.
  const n = opts.dtMeanMs !== undefined ? nRaw : Math.max(80, nRaw);

  // --- timestamps -------------------------------------------------
  const ts: number[] = [0];
  for (let i = 0; i < n; i++) {
    let dt = dtMean;
    if (opts.jitterTimestamps) {
      dt = dtMean * (1 + 0.6 * (rand() - 0.5));
      if (rand() < 0.02) dt *= 1.5 + rand();
    }
    ts.push((ts[ts.length - 1] as number) + dt);
  }
  const totalT = ts[ts.length - 1] as number;

  // --- radial wander setup --------------------------------------------
  // Slow random walk for sloppyRadius: stationary std ~12% of radius
  // (scaled by sloppyScale). For the inverse-omega attack the walk
  // must be known before the angular profile is built (omega divides
  // by it), so it is precomputed up front instead of integrated
  // inline.
  const sloppyPhi = 0.995;
  const sloppyScale = opts.sloppyScale ?? 1;
  const sloppyQ = 0.12 * sloppyScale * Math.sqrt(1 - sloppyPhi * sloppyPhi);
  let sloppy = 0;
  const inverseSloppy: number[] = [];
  if (opts.inverseOmega) {
    for (let i = 0; i <= n; i++) {
      sloppy = sloppy * sloppyPhi + gaussian(rand, 0, sloppyQ);
      inverseSloppy.push(sloppy);
    }
    sloppy = 0;
  }

  // --- angular velocity profile ------------------------------------
  // Constant omega, optionally ramped and/or modulated, normalized so
  // the sweep is exact (same trick the human model uses).
  const a1 = 0.15 + 0.25 * rand();
  const a2 = 0.05 + 0.15 * rand();
  const p1 = rand() * 2 * Math.PI;
  const p2 = rand() * 2 * Math.PI;
  const rawOmega: number[] = [];
  for (let i = 0; i < n; i++) {
    const sMid = ((ts[i] as number) + (ts[i + 1] as number)) / 2 / totalT;
    let omega = 1;
    if (opts.ramps) {
      omega *= smoothstep(sMid / 0.12) * smoothstep((1 - sMid) / 0.1);
    }
    if (opts.modulation) {
      omega *= 1 + a1 * Math.sin(2 * Math.PI * sMid + p1)
        + a2 * Math.sin(4 * Math.PI * sMid + p2);
    }
    if (opts.inverseOmega) {
      // THE DECOUPLING: divide by the midpoint wander factor so the
      // arc speed follows the modeled program, not the radius.
      const rMid = 1 + ((inverseSloppy[i] as number) + (inverseSloppy[i + 1] as number)) / 2;
      omega /= Math.max(0.5, rMid);
    }
    rawOmega.push(omega);
  }
  let omegaSum = 0;
  for (let i = 0; i < n; i++) {
    omegaSum += (rawOmega[i] as number) * ((ts[i + 1] as number) - (ts[i] as number));
  }
  const omegaScale = omegaSum > 0 ? (2 * Math.PI * turns) / omegaSum : 1;

  // --- radial profile ------------------------------------------------
  const m1 = rand() < 0.5 ? 1 : 2;
  const w1 = 0.015 + 0.035 * rand();
  const w2 = 0.005 + 0.015 * rand();
  const p3 = rand() * 2 * Math.PI;
  const p4 = rand() * 2 * Math.PI;
  const tremorAmp = 0.004 + 0.006 * rand();
  const tremorHz = 8 + 4 * rand();
  const p5 = rand() * 2 * Math.PI;

  // OU process for smoothNoise: exponential autocorrelation, the
  // property white noise lacks (and NOISE_WITHOUT_STRUCTURE keys on).
  const ouPhi = 0.82; // ~50 ms time constant at ~10 ms steps
  const ouTargetStd = 0.3 + 0.5 * rand();
  const ouQ = ouTargetStd * Math.sqrt(1 - ouPhi * ouPhi);
  let ouX = 0;
  let ouY = 0;

  // --- integrate the path ---------------------------------------------
  const thetas: number[] = [theta0];
  for (let i = 0; i < n; i++) {
    thetas.push(
      (thetas[thetas.length - 1] as number)
      + (rawOmega[i] as number) * omegaScale * ((ts[i + 1] as number) - (ts[i] as number)),
    );
  }

  const strokeCount = Math.max(1, Math.floor(opts.strokes ?? 1));
  const samples: PointerSample[] = [];
  for (let i = 0; i <= n; i++) {
    const t = ts[i] as number;
    const s = t / totalT;
    const theta = thetas[i] as number;

    let r = r0;
    if (opts.wobble) {
      r = r0 * (1 + w1 * Math.sin(2 * Math.PI * m1 * s + p3)
        + w2 * Math.sin(2 * Math.PI * (m1 + 1) * s + p4));
    }
    if (opts.inverseOmega) {
      // Radius follows the precomputed walk (the same sequence omega
      // divided by, keeping v = omega * r exactly on the program).
      r = r0 * (1 + (inverseSloppy[i] as number));
    } else if (opts.sloppyRadius) {
      sloppy = sloppy * sloppyPhi + gaussian(rand, 0, sloppyQ);
      r = r0 * (1 + sloppy);
    }
    if (opts.tremor) {
      r += r0 * tremorAmp * Math.sin(2 * Math.PI * tremorHz * (t / 1000) + p5);
    }

    let x = cx + r * Math.cos(theta);
    let y = cy + r * Math.sin(theta);
    if (opts.smoothNoise) {
      ouX = ouX * ouPhi + gaussian(rand, 0, ouQ);
      ouY = ouY * ouPhi + gaussian(rand, 0, ouQ);
      x += ouX;
      y += ouY;
    }
    const sigma = opts.whiteNoiseSigmaPx ?? 0;
    if (sigma > 0) {
      x += gaussian(rand, 0, sigma);
      y += gaussian(rand, 0, sigma);
    }

    const sample: PointerSample = {
      x,
      y,
      t: 1000 + t,
      stroke: Math.min(strokeCount - 1, Math.floor((s * strokeCount * 0.999))),
    };
    if (opts.pressure) {
      sample.pointerType = "pen";
      sample.pressure = Math.min(1, Math.max(0.05,
        0.45 + 0.18 * Math.sin(2 * Math.PI * 1.3 * s + p5) + gaussian(rand, 0, 0.02)));
    } else {
      sample.pointerType = "mouse";
    }
    samples.push(sample);
  }
  return samples;
}

/**
 * Smooth-spline waypoint attack: the circle approximated by a
 * Catmull-Rom spline through sparse anchors instead of linear chords.
 * Kills the collinear-run signature of linear interpolation while
 * staying a generated path with generated timing.
 */
export function generateEvasionSmoothWaypoint(
  opts: { seed: number; anchors?: number; durationMs?: number },
): PointerSample[] {
  const rand = mulberry32(opts.seed);
  const cx = 300 + 200 * rand();
  const cy = 250 + 200 * rand();
  const r0 = 80 + 70 * rand();
  const T = opts.durationMs ?? 1300 + 900 * rand();
  const anchors = opts.anchors ?? 12 + Math.floor(6 * rand());
  const theta0 = rand() * 2 * Math.PI;
  const n = Math.max(100, Math.floor(T / 10));

  const anchorAt = (k: number): { x: number; y: number } => ({
    x: cx + r0 * Math.cos(theta0 + (2 * Math.PI * k) / anchors),
    y: cy + r0 * Math.sin(theta0 + (2 * Math.PI * k) / anchors),
  });

  // Catmull-Rom spline through the anchors, sampled uniformly in the
  // spline parameter (so speed is smooth but not human-modulated).
  const samples: PointerSample[] = [];
  const dt = T / n;
  for (let i = 0; i <= n; i++) {
    const u = (i / n) * anchors;
    const k = Math.floor(u) % anchors;
    const f = u - Math.floor(u);
    const p0 = anchorAt(k - 1);
    const p1 = anchorAt(k);
    const p2 = anchorAt(k + 1);
    const p3 = anchorAt(k + 2);
    const cr = (a: number, b: number, c: number, d: number): number =>
      0.5 * ((2 * b) + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f
        + (-a + 3 * b - 3 * c + d) * f * f * f);
    samples.push({
      x: cr(p0.x, p1.x, p2.x, p3.x),
      y: cr(p0.y, p1.y, p2.y, p3.y),
      t: 1000 + i * dt,
      pointerType: "mouse",
      stroke: 0,
    });
  }
  return samples;
}

/** The complete human-dynamics synthesis: every component faked. */
export function generateEvasionFullSynthesis(
  seed: number,
): PointerSample[] {
  return generateEvasionCircle({
    seed,
    tremor: true,
    wobble: true,
    modulation: true,
    ramps: true,
    jitterTimestamps: true,
    pressure: true,
  });
}

/**
 * Stealth wander: the sloppy attack with the walk scaled down to sit
 * under the mid-band wander ceiling of `BROADBAND_RADIUS_WANDER`.
 * What it gives up: the shrunken walk provides far less fake
 * amplitude for the radial metrics, so the score rides on whatever
 * structure remains.
 */
export function generateEvasionStealthWander(
  seed: number,
): PointerSample[] {
  return generateEvasionCircle({
    seed,
    sloppyRadius: true,
    sloppyScale: 0.25,
    jitterTimestamps: true,
    ramps: true,
  });
}

/**
 * Inverse-omega decoupling: keeps the full +-12% wander (all the
 * fake-noise amplitude) but divides the angular-velocity profile by
 * it, so speed follows the modeled motor program instead of tracking
 * the radius. The dedicated counter to `BROADBAND_RADIUS_WANDER`:
 * it breaks the radius-speed coupling the signature keys on, at the
 * cost of requiring an explicit ramps+modulation speed model.
 */
export function generateEvasionInverseOmega(
  seed: number,
): PointerSample[] {
  return generateEvasionCircle({
    seed,
    inverseOmega: true,
    jitterTimestamps: true,
    ramps: true,
    modulation: true,
  });
}

/** Full synthesis minus one load-bearing component (ablation). */
export type EvasionAblation =
  | "noTremor"
  | "noWobble"
  | "noModulation"
  | "noRamps"
  | "noJitter";

export function generateEvasionAblation(
  seed: number,
  ablation: EvasionAblation,
): PointerSample[] {
  return generateEvasionCircle({
    seed,
    tremor: ablation !== "noTremor",
    wobble: ablation !== "noWobble",
    modulation: ablation !== "noModulation",
    ramps: ablation !== "noRamps",
    jitterTimestamps: ablation !== "noJitter",
    pressure: true,
  });
}

/** Named single-structure spoofs: one faked structure, rest machine. */
export const EVASION_SINGLE_SPOOFS: Readonly<
  Record<string, (seed: number) => PointerSample[]>
> = {
  tremorOnly: (seed) => generateEvasionCircle({ seed, tremor: true }),
  wobbleOnly: (seed) => generateEvasionCircle({ seed, wobble: true }),
  modulationOnly: (seed) => generateEvasionCircle({ seed, modulation: true }),
  pressureOnly: (seed) => generateEvasionCircle({ seed, pressure: true }),
  timingOnly: (seed) => generateEvasionCircle({ seed, jitterTimestamps: true }),
  smoothNoise: (seed) => generateEvasionCircle({ seed, smoothNoise: true }),
  smoothNoiseTimingRamps: (seed) =>
    generateEvasionCircle({
      seed,
      smoothNoise: true,
      jitterTimestamps: true,
      ramps: true,
    }),
  sloppyGeometry: (seed) => generateEvasionCircle({ seed, sloppyRadius: true }),
  multiStroke: (seed) => generateEvasionCircle({ seed, strokes: 3 }),
  smoothWaypoint: (seed) => generateEvasionSmoothWaypoint({ seed }),
};
