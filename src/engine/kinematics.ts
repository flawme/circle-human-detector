/**
 * Per-step movement kinematics: time deltas, speeds, unwrapped angles,
 * angular velocities, and the discrete "machine signature" detectors
 * (collinear runs, constant-speed runs, direction reversals).
 *
 * All functions are pure and environment-agnostic.
 */

interface Point2D {
  x: number;
  y: number;
}

/** Step-level kinematics for an ordered sample sequence. */
export interface KinematicsResult {
  /** dt[i] = t[i+1] - t[i], seconds-free milliseconds. Length n-1. */
  dt: number[];
  /** Euclidean step length. Length n-1. */
  chord: number[];
  /** chord / dt. Length n-1. */
  speed: number[];
  /** (speed[i] - speed[i-1]) / mean of adjacent dts. Length n-2. */
  accel: number[];
  /** atan2 of each point relative to the reference center. Length n. */
  angle: number[];
  /**
   * Angular step between consecutive points, reduced to (-pi, pi] and
   * adjusted so the sweep accumulates (see unwrapStep). Length n-1.
   */
  dAngle: number[];
  /** dAngle / dt. Length n-1. */
  omega: number[];
}

/** Smallest dt we ever divide by; guards duplicate timestamps. */
const MIN_DT = 1e-6;

/**
 * Reduce an angular difference to (-pi, pi]. Dense pointer samples always
 * move less than half a revolution per step, so this accumulates a full
 * sweep correctly without a separate unwrapping pass.
 */
export function principalAngle(d: number): number {
  const twoPi = 2 * Math.PI;
  let a = d % twoPi;
  if (a > Math.PI) a -= twoPi;
  if (a <= -Math.PI) a += twoPi;
  return a;
}

/**
 * Unwrap a sequence of principal-value angles into a continuous sequence
 * (each consecutive difference in (-pi, pi]). Useful for coverage checks.
 */
export function unwrapAngles(angles: readonly number[]): number[] {
  if (angles.length === 0) return [];
  const out: number[] = [angles[0] as number];
  for (let i = 1; i < angles.length; i++) {
    const prev = out[i - 1] as number;
    const cur = angles[i] as number;
    out.push(prev + principalAngle(cur - prev));
  }
  return out;
}

/**
 * Compute step kinematics for ordered samples relative to a center point
 * (the fitted circle center). Callers guarantee finite inputs.
 */
export function computeKinematics(
  points: readonly Point2D[],
  times: readonly number[],
  cx: number,
  cy: number,
): KinematicsResult {
  const n = points.length;
  const dt: number[] = [];
  const chord: number[] = [];
  const speed: number[] = [];
  const angle: number[] = [];
  const dAngle: number[] = [];
  const omega: number[] = [];

  for (let i = 0; i < n; i++) {
    const p = points[i] as Point2D;
    angle.push(Math.atan2(p.y - cy, p.x - cx));
  }

  for (let i = 1; i < n; i++) {
    const a = points[i - 1] as Point2D;
    const b = points[i] as Point2D;
    const d = Math.max(MIN_DT, (times[i] as number) - (times[i - 1] as number));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const c = Math.sqrt(dx * dx + dy * dy);
    const da = principalAngle(
      (angle[i] as number) - (angle[i - 1] as number),
    );
    dt.push(d);
    chord.push(c);
    speed.push(c / d);
    dAngle.push(da);
    omega.push(da / d);
  }

  const accel: number[] = [];
  for (let i = 1; i < speed.length; i++) {
    const ds = (speed[i] as number) - (speed[i - 1] as number);
    const dtAvg = ((dt[i - 1] as number) + (dt[i] as number)) / 2;
    accel.push(ds / Math.max(MIN_DT, dtAvg));
  }

  return { dt, chord, speed, accel, angle, dAngle, omega };
}

/**
 * Flag within-stroke pauses: a gap counts when it is at least `pauseMs`
 * and at least 2.5x the median inter-sample gap, so a slow but continuous
 * capture rate is never misread as pausing.
 */
export function findPauses(
  dt: readonly number[],
  pauseMs: number,
): boolean[] {
  const sorted = [...dt].sort((a, b) => a - b);
  const med = sorted.length > 0 ? (sorted[Math.floor(sorted.length / 2)] as number) : 0;
  return dt.map((d) => d >= pauseMs && d >= 2.5 * med && d > med);
}

/**
 * Centered moving average with a window shrunk near the edges.
 * `window` is rounded to odd and clamped to the series length.
 */
export function smoothSeries(
  values: readonly number[],
  window: number,
): number[] {
  const n = values.length;
  if (n === 0) return [];
  let w = Math.max(1, Math.round(window));
  if (w % 2 === 0) w += 1;
  const half = (w - 1) / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    for (let j = lo; j <= hi; j++) {
      sum += values[j] as number;
      count++;
    }
    out.push(sum / count);
  }
  return out;
}

/**
 * Longest run of consecutive point triples that are exactly collinear
 * with equal step lengths — the signature of linear interpolation
 * between waypoints. Both conditions are required so dense arcs of a
 * genuine curve (small but nonzero turning) never trigger it.
 *
 * Returns the number of consecutive qualifying triples.
 */
export function longestCollinearRun(
  points: readonly Point2D[],
  opts?: { areaTol?: number; chordTol?: number },
): number {
  const areaTol = opts?.areaTol ?? 1e-6;
  const chordTol = opts?.chordTol ?? 0.02;
  const n = points.length;
  let best = 0;
  let run = 0;
  for (let i = 1; i + 1 < n; i++) {
    const a = points[i - 1] as Point2D;
    const b = points[i] as Point2D;
    const c = points[i + 1] as Point2D;
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const vx = c.x - b.x;
    const vy = c.y - b.y;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu <= 0 || lv <= 0) {
      run = 0;
      continue;
    }
    // |u x v| / (|u||v|) = sin(angle between segments): 0 when collinear.
    const sinAngle = Math.abs(ux * vy - uy * vx) / (lu * lv);
    const chordRatio = Math.abs(lu - lv) / (lu + lv);
    if (sinAngle < areaTol && chordRatio < chordTol) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * Longest run of consecutive values that are identical within a relative
 * tolerance — the signature of piecewise-constant generated data.
 */
export function longestConstantRun(
  values: readonly number[],
  relTol: number,
): number {
  const n = values.length;
  if (n < 2) return 0;
  let best = 0;
  let run = 0;
  const scale = Math.max(...values.map((v) => Math.abs(v)));
  for (let i = 1; i < n; i++) {
    const prev = values[i - 1] as number;
    const cur = values[i] as number;
    const tol = relTol * Math.max(scale, 1e-12);
    if (Math.abs(cur - prev) <= tol) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * Count genuine direction reversals: sign flips of the angular step where
 * both steps exceed 30% of the median step magnitude, so noise around
 * zero-crossing samples never inflates the count.
 */
export function directionChangeCount(dAngle: readonly number[]): number {
  const n = dAngle.length;
  if (n < 2) return 0;
  const sorted = dAngle.map(Math.abs).sort((a, b) => a - b);
  const med = sorted[Math.floor(n / 2)] as number;
  if (med <= 0) return 0;
  let count = 0;
  for (let i = 1; i < n; i++) {
    const prev = dAngle[i - 1] as number;
    const cur = dAngle[i] as number;
    if (prev * cur < 0) {
      if (Math.abs(prev) > 0.3 * med && Math.abs(cur) > 0.3 * med) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Systematic speed variation across angular position: the largest
 * best-fit sinusoid amplitude at 1-3 cycles across the sweep, measured
 * over a 12-sector speed profile, divided by the overall mean speed.
 *
 * Human drawing speed varies with hand posture around the circle
 * (typical amplitudes 0.15..0.5). The narrow-band projection is what
 * makes this noise-robust: white positional noise inflates the raw
 * spread of sector means but contributes almost nothing to any single
 * low harmonic, so injected noise cannot fake systematic modulation.
 *
 * Returns 0 for short series, constant speed, or degenerate angles.
 */
export function speedModulation(
  angle: readonly number[],
  speed: readonly number[],
): number {
  const n = angle.length;
  if (n < 12 || speed.length !== n) return 0;

  let lo = Infinity;
  let hi = -Infinity;
  for (const a of angle) {
    if (a < lo) lo = a;
    if (a > hi) hi = a;
  }
  const span = hi - lo;
  if (!(span > 0)) return 0;

  let overall = 0;
  for (const v of speed) overall += v;
  overall /= n;
  if (!(overall > 0)) return 0;

  const sectors = 12;
  const sums = new Array<number>(sectors).fill(0);
  const counts = new Array<number>(sectors).fill(0);
  for (let i = 0; i < n; i++) {
    const a = angle[i] as number;
    const v = speed[i] as number;
    const idx = Math.min(sectors - 1, Math.floor(((a - lo) / span) * sectors));
    sums[idx] = (sums[idx] as number) + v;
    counts[idx] = (counts[idx] as number) + 1;
  }

  const ss: number[] = [];
  const ys: number[] = [];
  for (let j = 0; j < sectors; j++) {
    const c = counts[j] as number;
    if (c > 0) {
      ss.push((j + 0.5) / sectors);
      ys.push((sums[j] as number) / c - overall);
    }
  }
  if (ys.length < 6) return 0;

  const amp = (cycles: number): number => {
    let cosSum = 0;
    let sinSum = 0;
    for (let i = 0; i < ys.length; i++) {
      const s = ss[i] as number;
      const y = ys[i] as number;
      cosSum += y * Math.cos(2 * Math.PI * cycles * s);
      sinSum += y * Math.sin(2 * Math.PI * cycles * s);
    }
    return (2 * Math.hypot(cosSum, sinSum)) / ys.length;
  };

  return Math.max(amp(1), amp(2), amp(3)) / overall;
}
