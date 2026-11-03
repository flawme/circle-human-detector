/**
 * Physics-law audit for the synthetic corpora (informational).
 *
 * Measures how faithfully each modeled corpus reproduces three
 * well-replicated laws of human motor control, and prints the
 * comparison against the published targets:
 *
 *  1. Two-thirds power law (Lacquaniti, Terzuolo & Viviani 1983;
 *     Viviani & Schneider 1991): tangential speed v follows
 *     K * kappa^(-1/3), i.e. the OLS slope of log v on log kappa is
 *     about -1/3 for human drawing. Poles: a generator whose speed is
 *     geometrically coupled (v = omega * r with omega independent of
 *     the wander) and whose kappa is measured on the observed noisy
 *     path drifts toward the noise structure, while a decoupled speed
 *     program gives slope ~ 0. A real motor law is convention-stable;
 *     a coincidence of two independent processes is not.
 *  2. Signal-dependent noise (Harris & Wolpert 1998): motor noise
 *     variance scales with the squared command magnitude, exponent
 *     beta ~ 2 in a log-log regression of speed variance on mean
 *     speed. Additive noise gives beta ~ 0. Speed-domain measurement
 *     is confounded by timestamp jitter (dt noise scales v by v
 *     itself), which is why machine corpora reach beta >> 2 without
 *     any motor system at all.
 *  3. Movement smoothness (Flash & Hogan 1985): human movements
 *     approach a minimum-jerk profile. Reported as LDLJ
 *     -ln(sqrt(T^5 * integral(jerk^2 dt) / L^2)) over the full sweep;
 *     higher = smoother.
 *
 * This module is imported by scripts/evaluate.mjs (printed after the
 * gates, never gating) and by test/physics.test.ts (the documented
 * findings are pinned there). It holds no engine logic; it audits the
 * corpora, not the detector.
 *
 * Conventions match the engine where they overlap: the speed/curvature
 * series are taken over the time-core (15-85% of duration by time),
 * the same core region the engine's kinematic metrics use. Degenerate
 * series (collinear triples, zero-variance windows, non-positive
 * speeds) are skipped per sample, never assumed nonempty.
 */

import type { PointerSample } from "../src/types.ts";
import {
  generateHumanCircle,
  generateMachineCircle,
} from "../test/helpers/generators.ts";
import {
  generateEvasionCircle,
  generateEvasionFullSynthesis,
  generateEvasionAblation,
  generateEvasionStealthWander,
  generateEvasionInverseOmega,
  EVASION_SINGLE_SPOOFS,
} from "../test/helpers/evasion.ts";

// ---------------------------------------------------------------- math

/** Quantile of an ALREADY-SORTED array (linear interpolation). */
export function quantileOf(sortedValues: readonly number[], q: number): number {
  const s = sortedValues;
  if (s.length === 0) return Number.NaN;
  const idx = (s.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const sLo = s[lo]!;
  if (lo === hi) return sLo;
  const sHi = s[hi]!;
  return sLo + (sHi - sLo) * (idx - lo);
}

/** Median-style quantile of an unsorted array. */
function qOf(arr: readonly number[], q: number): number {
  if (arr.length === 0) return Number.NaN;
  return quantileOf([...arr].sort((a, b) => a - b), q);
}

/** Centered moving mean (w odd; w <= 1 = identity). Edges shrink. */
function smoothSeries(arr: readonly number[], w: number): number[] {
  if (w <= 1) return [...arr];
  const half = (w - 1) / 2;
  const out: number[] = new Array<number>(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
      sum += arr[j]!;
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

// ------------------------------------------------- instrument: series

/**
 * Per-point speed and curvature over the time-core (15-85% by time,
 * matching the engine's core convention).
 *
 * Speed at point i is the arc length across the triple (i-1, i, i+1)
 * over its duration; curvature is the reciprocal of the circumscribed
 * circle of the same triple, kappa = 4*Area / (a*b*c).
 *
 * @returns null when the core has fewer than 30 usable points
 *   (degenerate geometry — collinear runs, non-positive steps).
 */
export function coreSeries(samples: readonly PointerSample[]): {
  vs: number[];
  ks: number[];
} | null {
  const n = samples.length;
  if (n < 12) return null;
  const first = samples[0]!;
  const last = samples[n - 1]!;
  const t0 = first.t;
  const T = last.t - t0;
  if (!(T > 0)) return null;
  const lo = t0 + 0.15 * T;
  const hi = t0 + 0.85 * T;
  const stepD: number[] = [];
  const stepDt: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const p0 = samples[i]!;
    const p1 = samples[i + 1]!;
    const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const dt = p1.t - p0.t;
    if (!(dt > 0)) return null;
    stepD.push(d);
    stepDt.push(dt);
  }
  const vs: number[] = [];
  const ks: number[] = [];
  for (let i = 1; i + 1 < n; i++) {
    const p0 = samples[i - 1]!;
    const p1 = samples[i]!;
    const p2 = samples[i + 1]!;
    const tm = (p0.t + p2.t) / 2;
    if (tm < lo || tm > hi) continue;
    const v = (stepD[i - 1]! + stepD[i]!) / (stepDt[i - 1]! + stepDt[i]!);
    if (!(v > 0)) continue;
    const a = stepD[i - 1]!;
    const b = stepD[i]!;
    const c = Math.hypot(p2.x - p0.x, p2.y - p0.y);
    const cross = Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x)); // = 2*Area
    if (!(a > 0 && b > 0 && c > 0) || !(cross > 0)) continue; // collinear triple
    const k = (2 * cross) / (a * b * c);
    if (!(k > 0) || !Number.isFinite(k)) continue;
    vs.push(v);
    ks.push(k);
  }
  if (vs.length < 30) return null;
  return { vs, ks };
}

// --------------------------------------- instrument: power-law slope

/**
 * OLS slope of log v on log kappa (2.5% tail trim on log kappa).
 * Smoothing window w is part of the convention; a physical law is
 * stable across conventions, a coincidence is not.
 */
export function powerLawSlope(
  core: { vs: readonly number[]; ks: readonly number[] },
  w: number,
): { slope: number; r2: number; sdLogK: number } | null {
  const v = smoothSeries(core.vs, w);
  const k = smoothSeries(core.ks, w);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < v.length; i++) {
    const vi = v[i]!;
    const ki = k[i]!;
    if (vi > 0 && ki > 0) pts.push([Math.log(ki), Math.log(vi)]);
  }
  if (pts.length < 30) return null;
  pts.sort((p, q) => p[0] - q[0]);
  const trim = Math.floor(pts.length * 0.025);
  const P = pts.slice(trim, pts.length - trim);
  const n = P.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of P) {
    sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
  }
  const varx = sxx - (sx * sx) / n;
  const vary = syy - (sy * sy) / n;
  const cov = sxy - (sx * sy) / n;
  if (!(varx > 1e-15) || !(vary > 1e-15)) return null;
  const slope = cov / varx;
  const r2 = (cov * cov) / (varx * vary);
  if (!Number.isFinite(slope) || !Number.isFinite(r2)) return null;
  return { slope, r2, sdLogK: Math.sqrt(varx) };
}

// ------------------------------------------- instrument: SDN exponent

/**
 * Signal-dependent-noise exponent: OLS slope of log(variance) on
 * log(mean) across 10 windows of the core speed series, variance
 * detrended per window (removes program ramps). beta ~ 2 =>
 * variance scales with mean^2 (Harris-Wolpert SDN); beta ~ 0 =>
 * additive noise. Requires the mean speed to actually vary across
 * windows (constant-speed corpora return null: beta undefined).
 */
export function sdnExponent(core: { vs: readonly number[] }): number | null {
  const vs = core.vs;
  if (vs.length < 60) return null;
  const W = 10;
  const per = Math.floor(vs.length / W);
  if (per < 6) return null;
  const pts: Array<[number, number]> = [];
  for (let wIdx = 0; wIdx < W; wIdx++) {
    const seg = vs.slice(wIdx * per, (wIdx + 1) * per);
    const n = seg.length;
    const mean = seg.reduce((acc, b) => acc + b, 0) / n;
    if (!(mean > 0)) continue;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    seg.forEach((y, i) => {
      sx += i; sy += y; sxx += i * i; sxy += i * y;
    });
    const denom = n * sxx - sx * sx;
    const a = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
    const b = (sy - a * sx) / n;
    let vr = 0;
    seg.forEach((y, i) => {
      const e = y - (a * i + b);
      vr += e * e;
    });
    vr /= n;
    if (!(vr > 0)) continue;
    pts.push([Math.log(mean), Math.log(vr)]);
  }
  if (pts.length < 5) return null;
  const xs = pts.map((p) => p[0]);
  if (Math.max(...xs) - Math.min(...xs) < 0.08) return null;
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) {
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const varx = sxx - (sx * sx) / n;
  if (!(varx > 1e-12)) return null;
  const beta = (sxy - (sx * sy) / n) / varx;
  return Number.isFinite(beta) ? beta : null;
}

// ----------------------------------------------- instrument: LDLJ

/**
 * Log dimensionless jerk over the full sweep:
 *   LDLJ = -ln( sqrt( T^5 * integral(jerk^2 dt) / L^2 ) )
 * on a 256-point uniform-time resample (successive central
 * differences), L = path length. Higher = smoother. Human movements
 * approach minimum-jerk profiles (Flash & Hogan 1985); the dominant
 * contribution here is derivative-amplified measurement noise, which
 * is exactly why a smoothness *floor* would be a tremor-amplitude
 * demand, not a motor-law test.
 */
export function ldlj(samples: readonly PointerSample[]): number | null {
  const n = samples.length;
  const first = samples[0]!;
  const last = samples[n - 1]!;
  const t0 = first.t;
  const T = last.t - t0;
  if (!(T > 0)) return null;
  const N = 256;
  const h = T / (N - 1);
  const xs: number[] = new Array<number>(N);
  const ys: number[] = new Array<number>(N);
  let j = 0;
  for (let kk = 0; kk < N; kk++) {
    const tt = t0 + kk * h;
    while (j + 2 < n && samples[j + 1]!.t < tt) j++;
    const s0 = samples[j]!;
    const s1 = samples[j + 1]!;
    const dt = s1.t - s0.t;
    const f = dt > 0 ? (tt - s0.t) / dt : 0;
    xs[kk] = s0.x + f * (s1.x - s0.x);
    ys[kk] = s0.y + f * (s1.y - s0.y);
  }
  let L = 0;
  for (let kk = 0; kk + 1 < N; kk++) {
    L += Math.hypot(xs[kk + 1]! - xs[kk]!, ys[kk + 1]! - ys[kk]!);
  }
  if (!(L > 0)) return null;
  const vx: number[] = [];
  const vy: number[] = [];
  for (let kk = 1; kk < N - 1; kk++) {
    vx.push((xs[kk + 1]! - xs[kk - 1]!) / (2 * h));
    vy.push((ys[kk + 1]! - ys[kk - 1]!) / (2 * h));
  }
  const ax: number[] = [];
  const ay: number[] = [];
  for (let kk = 1; kk < vx.length - 1; kk++) {
    ax.push((vx[kk + 1]! - vx[kk - 1]!) / (2 * h));
    ay.push((vy[kk + 1]! - vy[kk - 1]!) / (2 * h));
  }
  let acc = 0;
  let cnt = 0;
  for (let kk = 1; kk < ax.length - 1; kk++) {
    const jx = (ax[kk + 1]! - ax[kk - 1]!) / (2 * h);
    const jy = (ay[kk + 1]! - ay[kk - 1]!) / (2 * h);
    acc += jx * jx + jy * jy;
    cnt++;
  }
  if (cnt < 10) return null;
  const integralJ2 = (acc / cnt) * T;
  const dlj2 = (T * T * T * T * T) * integralJ2 / (L * L);
  if (!(dlj2 > 0)) return null;
  const value = -0.5 * Math.log(dlj2);
  return Number.isFinite(value) ? value : null;
}

// ------------------------------------------------------------ corpora

/** Instrument readings for one corpus (per-seed values, unsorted). */
export interface CorpusResult {
  total: number;
  measured: number;
  slopeRaw: number[];
  slopeW5: number[];
  slopeW15: number[];
  r2W5: number[];
  sdnBeta: number[];
  ldlj: number[];
}

/** One corpus's audit entry. */
export interface PhysicsCorpusMeasurement {
  name: string;
  result: CorpusResult;
}

/**
 * Measure one corpus: run every instrument on seeds 1..n.
 */
export function measureCorpus(
  gen: (seed: number) => PointerSample[],
  n: number,
): CorpusResult {
  const acc: CorpusResult = {
    total: n,
    measured: 0,
    slopeRaw: [],
    slopeW5: [],
    slopeW15: [],
    r2W5: [],
    sdnBeta: [],
    ldlj: [],
  };
  for (let seed = 1; seed <= n; seed++) {
    const samples = gen(seed);
    const core = coreSeries(samples);
    if (core) {
      acc.measured++;
      const raw = powerLawSlope(core, 1);
      const w5 = powerLawSlope(core, 5);
      const w15 = powerLawSlope(core, 15);
      if (raw) acc.slopeRaw.push(raw.slope);
      if (w5) {
        acc.slopeW5.push(w5.slope);
        acc.r2W5.push(w5.r2);
      }
      if (w15) acc.slopeW15.push(w15.slope);
      const beta = sdnExponent(core);
      if (beta !== null) acc.sdnBeta.push(beta);
    }
    const lj = ldlj(samples);
    if (lj !== null) acc.ldlj.push(lj);
  }
  return acc;
}

/**
 * Corpus definitions, sizes matching the session's calibration
 * conventions (2000-seed human calibration; 40-seed attack sweeps).
 */
export function runPhysicsAudit(sizes: {
  human?: number;
  machine?: number;
  attack?: number;
  synth?: number;
} = {}): PhysicsCorpusMeasurement[] {
  const humanN = sizes.human ?? 2000;
  const machineN = sizes.machine ?? 100;
  const attackN = sizes.attack ?? 40;
  const synthN = sizes.synth ?? 20;
  const smoothNoiseTR = EVASION_SINGLE_SPOOFS.smoothNoiseTimingRamps;
  if (!smoothNoiseTR) {
    throw new Error("physics audit: smoothNoiseTimingRamps spoof is missing");
  }
  const corpora: Array<{
    name: string;
    n: number;
    gen: (s: number) => PointerSample[];
  }> = [
    { name: "human", n: humanN, gen: (s) => generateHumanCircle({ seed: s }) },
    { name: "parametric", n: machineN, gen: (s) => generateMachineCircle({ seed: s, variant: "parametric" }) },
    { name: "noisy", n: machineN, gen: (s) => generateMachineCircle({ seed: s, variant: "noisy" }) },
    { name: "waypoint", n: machineN, gen: (s) => generateMachineCircle({ seed: s, variant: "waypoint" }) },
    { name: "adversarial", n: machineN, gen: (s) => generateMachineCircle({ seed: s, variant: "adversarial" }) },
    { name: "sloppy", n: attackN, gen: (s) => generateEvasionCircle({ seed: s, sloppyRadius: true }) },
    { name: "sloppy+jit", n: attackN, gen: (s) => generateEvasionCircle({ seed: s, sloppyRadius: true, jitterTimestamps: true }) },
    { name: "sloppy+jr", n: attackN, gen: (s) => generateEvasionCircle({ seed: s, sloppyRadius: true, jitterTimestamps: true, ramps: true }) },
    { name: "stealth-wander", n: attackN, gen: (s) => generateEvasionStealthWander(s) },
    { name: "invomega-bare", n: attackN, gen: (s) => generateEvasionCircle({ seed: s, inverseOmega: true }) },
    { name: "invomega-ramps", n: attackN, gen: (s) => generateEvasionCircle({ seed: s, inverseOmega: true, ramps: true }) },
    { name: "invomega-prog", n: attackN, gen: (s) => generateEvasionInverseOmega(s) },
    { name: "smoothNoiseTR", n: attackN, gen: (s) => smoothNoiseTR(s) },
    { name: "synthesis", n: synthN, gen: (s) => generateEvasionFullSynthesis(s) },
    { name: "abl-noTremor", n: synthN, gen: (s) => generateEvasionAblation(s, "noTremor") },
    { name: "abl-noWobble", n: synthN, gen: (s) => generateEvasionAblation(s, "noWobble") },
    { name: "abl-noModulation", n: synthN, gen: (s) => generateEvasionAblation(s, "noModulation") },
    { name: "abl-noRamps", n: synthN, gen: (s) => generateEvasionAblation(s, "noRamps") },
    { name: "abl-noJitter", n: synthN, gen: (s) => generateEvasionAblation(s, "noJitter") },
  ];
  return corpora.map((c) => ({ name: c.name, result: measureCorpus(c.gen, c.n) }));
}

// ------------------------------------------------------------- format

function fmt(arr: readonly number[], digits = 2): string {
  if (arr.length === 0) return "n/a";
  return `${qOf(arr, 0.5).toFixed(digits)} [${qOf(arr, 0.05).toFixed(digits)},${qOf(arr, 0.95).toFixed(digits)}]`;
}

/**
 * Render the audit table plus the findings that the documentation
 * claims are pinned against (test/physics.test.ts).
 */
export function formatPhysicsAudit(
  audit: readonly PhysicsCorpusMeasurement[],
): string {
  const pick = (name: string): CorpusResult => {
    const hit = audit.find((a) => a.name === name);
    if (!hit) throw new Error(`physics audit: missing corpus ${name}`);
    return hit.result;
  };
  const human = pick("human");
  const attack = pick("invomega-prog");
  const noMod = pick("abl-noModulation");

  const lines: string[] = [];
  lines.push("physics-law audit (informational - corpus faithfulness, not a detection gate)");
  lines.push("targets: power-law slope ~ -1/3 (Lacquaniti 1983) | SDN beta ~ 2 (Harris-Wolpert 1998) | higher LDLJ = smoother (Flash-Hogan 1985)");
  lines.push("");
  const header =
    "corpus".padEnd(16) +
    "meas".padStart(7) +
    "slope raw".padStart(21) +
    "slope 5pt".padStart(21) +
    "slope 15pt".padStart(21) +
    "R2(5)".padStart(7) +
    "SDN beta".padStart(21) +
    "LDLJ".padStart(21);
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const { name, result: r } of audit) {
    lines.push(
      name.padEnd(16) +
        `${r.measured}/${r.total}`.padStart(7) +
        fmt(r.slopeRaw).padStart(21) +
        fmt(r.slopeW5).padStart(21) +
        fmt(r.slopeW15).padStart(21) +
        (r.r2W5.length > 0 ? qOf(r.r2W5, 0.5).toFixed(2) : "n/a").padStart(7) +
        fmt(r.sdnBeta).padStart(21) +
        fmt(r.ldlj).padStart(21),
    );
  }
  lines.push("");
  lines.push("findings:");
  lines.push(
    `  - two-thirds power law: NOT reproduced by the human model. Its slope is convention-` +
      `unstable (raw ${qOf(human.slopeRaw, 0.5).toFixed(2)} -> 15pt ${qOf(human.slopeW15, 0.5).toFixed(2)}), ` +
      `the signature of phase alignment between independent processes rather than curvature ` +
      `coupling - ablating the speed modulation alone collapses it to ` +
      `${qOf(noMod.slopeW15, 0.5).toFixed(2)}. The inverse-omega attack ` +
      `(median ${qOf(attack.slopeW15, 0.5).toFixed(2)}) sits inside the human 15pt range ` +
      `[${qOf(human.slopeW15, 0.05).toFixed(2)}, ${qOf(human.slopeW15, 0.95).toFixed(2)}] at every convention: ` +
      `no calibrated separation exists. Not shippable as a signature on this corpus.`,
  );
  lines.push(
    `  - signal-dependent noise: NOT reproduced. Human beta p50 ` +
      `${qOf(human.sdnBeta, 0.5).toFixed(2)} (additive noise, Harris-Wolpert would be ~2); ` +
      `machine corpora reach beta >> 2 from timestamp jitter alone, so speed-domain SDN is ` +
      `confounded by timing noise. Corpus-modeling gap, documented in EVALUATION.md.`,
  );
  lines.push(
    `  - smoothness: the inverse-omega attack is smoother than the human corpus median ` +
      `(LDLJ ${qOf(attack.ldlj, 0.5).toFixed(2)} vs ${qOf(human.ldlj, 0.5).toFixed(2)}, quartiles disjoint) ` +
      `but the tails overlap (human min ${Math.min(...human.ldlj).toFixed(2)} vs attack max ` +
      `${Math.max(...attack.ldlj).toFixed(2)}), and the jerk channel is derivative-amplified noise: ` +
      `accusing on smoothness is demanding tremor amplitude, which would misfire on assistive ` +
      `pointers, styluses, and calm motor profiles. Measured, documented, deliberately not shipped.`,
  );
  return lines.join("\n");
}
