/**
 * Behavioral metric computation and normalization.
 *
 * Two layers live here:
 *
 * 1. `computeBehavioralMetrics` derives the raw metric table from samples,
 *    a fitted circle, and step kinematics. Every metric is
 *    scale/position-invariant (ratios and coefficients of variation), so
 *    the same thresholds apply to a 40px phone circle and a 400px desktop
 *    circle.
 *
 * 2. The `hl*` (human-likeness) functions normalize one raw metric into
 *    [0, 1] where 1 is human-consistent and 0 is machine-consistent.
 *    Each is a piecewise-linear curve with explicit anchors, so every
 *    threshold is inspectable, documented, and unit-testable.
 *
 * Deliberate design rule: no single metric is trusted. Noise can fake
 * amplitude, so amplitude-based metrics (tremor, velocity variation) are
 * paired with correlation-based ones (lag-1 autocorrelation) that
 * distinguish temporally structured human jitter from injected white
 * noise, and machine signatures carry separate penalty weight.
 */

import type {
  BehavioralMetrics,
  GeometryMetrics,
  KinematicMetrics,
  MetricKey,
  PointerSample,
  PressureMetrics,
  TimingMetrics,
} from "../types.ts";
import type { CircleFitResult } from "./circle-fit.ts";
import type { KinematicsResult } from "./kinematics.ts";
import {
  directionChangeCount,
  findPauses,
  longestCollinearRun,
  longestConstantRun,
  smoothSeries,
  speedModulation,
  unwrapAngles,
} from "./kinematics.ts";
import {
  countUnique,
  curve,
  cv,
  lag1Autocorr,
  mean,
  median,
  std,
} from "./stats.ts";

/** Human-readable labels for the scored metrics. */
export const METRIC_LABELS: Record<MetricKey, string> = {
  angularVelocityVariation: "Angular velocity variation",
  speedModulation: "Speed modulation over the sweep",
  radialWobble: "Low-frequency radius wobble",
  radialTremor: "High-frequency radial jitter",
  residualAutocorrelation: "Temporal correlation of jitter",
  startEndDynamics: "Start/end speed ramps",
  timestampIrregularity: "Timestamp irregularity",
  collinearFreedom: "Absence of collinear interpolation",
  directionStability: "Direction stability",
  accelerationVariation: "Acceleration variation",
  pauseNaturalness: "Pause naturalness",
  pressureVariation: "Pressure variation",
};

// ---------------------------------------------------------------------------
// Normalization curves.
// Anchors are (value, human-likeness) pairs, piecewise-linear in between.
// Rationale for each anchor set is documented in docs/API.md.
// ---------------------------------------------------------------------------

/**
 * Angular velocity variation. Humans modulate angular speed smoothly
 * (CV ~0.08..0.6). Perfect parametric machines sit near 0; extreme
 * jitter scores below 1 but never 0 (jitter is not machine evidence).
 */
export function hlAngularVelocityVariation(
  omegaCv: number,
  omegaAutocorr: number,
): number {
  const cvPart = curve(omegaCv, [
    [0.02, 0],
    [0.08, 1],
    [0.6, 1],
    [1.5, 0.45],
  ]);
  // Structured (smooth) variation is positively autocorrelated; white
  // noise injected onto a constant-speed generator is not. Autocorr 0
  // (constant or independent noise) scores 0.
  const corrPart = curve(omegaAutocorr, [
    [0.02, 0],
    [0.25, 1],
    [1.5, 1],
  ]);
  return 0.5 * cvPart + 0.5 * corrPart;
}

/** Systematic speed variation across the sweep; machines stay near 0. */
export function hlSpeedModulation(m: number): number {
  return curve(m, [
    [0.02, 0],
    [0.1, 1],
    [3, 1],
  ]);
}

/** Low-frequency radius modulation; exact parametric circles have none. */
export function hlRadialWobble(w: number): number {
  return curve(w, [
    [0.002, 0],
    [0.012, 1],
    [0.2, 1],
    [0.5, 0.45],
  ]);
}

/**
 * High-frequency radial jitter amplitude (tremor / tracking noise),
 * blended with its temporal structure. Amplitude alone can be faked by
 * injecting noise; temporally structured jitter cannot, so amplitude
 * without autocorrelation only reaches 0.6.
 */
export function hlRadialTremor(
  residual: number,
  residualAutocorr: number,
): number {
  const ampPart = curve(residual, [
    [0.0004, 0],
    [0.003, 1],
    [2, 1],
  ]);
  const corrPart = curve(residualAutocorr, [
    [0.02, 0],
    [0.25, 1],
    [1.5, 1],
  ]);
  return 0.6 * ampPart + 0.4 * corrPart;
}

/**
 * Temporal structure of the radial residual. Human jitter and smooth
 * path error are positively autocorrelated; Gaussian noise added by a
 * generator is not. This is the primary noise-vs-tremor discriminator.
 */
export function hlResidualAutocorr(a: number): number {
  return curve(a, [
    [0.02, 0],
    [0.25, 1],
    [1.5, 1],
  ]);
}

/**
 * Start/end speed behavior. Humans ramp into and out of a stroke;
 * constant-speed generators start and end at full speed (ratio ~1).
 */
export function hlStartEndDynamics(
  startRatio: number,
  endRatio: number,
): number {
  const start = curve(startRatio, [
    [0.75, 1],
    [0.93, 0.9],
    [0.99, 0.1],
  ]);
  const end = curve(endRatio, [
    [0.75, 1],
    [0.93, 0.85],
    [0.99, 0.15],
  ]);
  return 0.6 * start + 0.4 * end;
}

/**
 * Inter-sample interval irregularity. Real input pipelines deliver
 * events with OS-level jitter; scripted loops emit near-uniform dt.
 * Deliberately low weight: capture loops (requestAnimationFrame,
 * coalesced events) can also produce fairly regular timestamps, and a
 * generator can trivially add jitter, so this is corroborating evidence
 * only.
 */
export function hlTimestampIrregularity(dtCv: number): number {
  return curve(dtCv, [
    [0.004, 0],
    [0.04, 1],
    [3, 1],
  ]);
}

/** Absence of exactly-collinear equal-step runs (waypoint interpolation). */
export function hlCollinearFreedom(maxRun: number): number {
  return curve(maxRun, [
    [0, 1],
    [2, 0.6],
    [4, 0],
    [99, 0],
  ]);
}

/**
 * Direction stability. Humans draw circles without genuine reversals;
 * a value below 1 is unusual but weakly informative, so weight is low.
 */
export function hlDirectionStability(changeRatio: number): number {
  return curve(changeRatio, [
    [0, 1],
    [0.02, 0.8],
    [0.08, 0.25],
    [0.3, 0],
  ]);
}

/**
 * Tangential acceleration variation, blended with its temporal
 * structure. Constant-speed machines sit near 0; white noise produces
 * variation without correlation and stops at 0.5; smooth human
 * acceleration profiles vary and are autocorrelated.
 */
export function hlAccelerationVariation(
  accelCv: number,
  accelAutocorr: number,
): number {
  const cvPart = curve(accelCv, [
    [0.02, 0],
    [0.12, 1],
    [4, 1],
  ]);
  const corrPart = curve(accelAutocorr, [
    [0.02, 0],
    [0.25, 1],
    [1.5, 1],
  ]);
  return 0.5 * cvPart + 0.5 * corrPart;
}

/**
 * Pause naturalness. Mid-stroke pauses are unusual for machines AND
 * common for some humans (deliberate, careful, or assistive input), so
 * the floor stays high and the penalty is symbolic.
 */
export function hlPauseNaturalness(pauseCount: number): number {
  return curve(pauseCount, [
    [0, 1],
    [1, 0.75],
    [4, 0.5],
    [12, 0.3],
  ]);
}

/**
 * Pressure variation, only scored for touch/pen with real pressure.
 * Constant pressure across a long stroke is mildly machine-like, but
 * some hardware reports constant pressure — low weight, anomaly only.
 */
export function hlPressureVariation(pressureCv: number): number {
  return curve(pressureCv, [
    [0.002, 0],
    [0.02, 1],
    [2, 1],
  ]);
}

// ---------------------------------------------------------------------------
// Raw metric table.
// ---------------------------------------------------------------------------

/** Inputs to `computeBehavioralMetrics`. */
export interface MetricsInputs {
  /** Samples surviving timestamp-dedupe, in chronological order. */
  samples: readonly PointerSample[];
  /** xy of each kept sample, parallel to `samples`. */
  points: readonly { x: number; y: number }[];
  /** Timestamps of each kept sample, parallel to `samples`. */
  times: readonly number[];
  /** Stroke index of each kept sample, parallel to `samples`. */
  strokeIndices: readonly number[];
  fit: CircleFitResult;
  kin: KinematicsResult;
  /** Configured within-stroke pause threshold in ms. */
  pauseMs: number;
}

/**
 * Compute the full behavioral metric table. Never throws; degenerate
 * inputs yield zeroed metrics (the orchestrator reports them through
 * data quality instead).
 */
export function computeBehavioralMetrics(
  input: MetricsInputs,
): BehavioralMetrics {
  const { samples, points, times, strokeIndices, fit, kin, pauseMs } = input;
  const n = samples.length;

  // Reference center: fitted circle center when the fit is usable,
  // otherwise the centroid (so downstream math never sees NaN).
  let cx = 0;
  let cy = 0;
  if (fit.ok) {
    cx = fit.cx;
    cy = fit.cy;
  } else {
    for (const p of points) {
      cx += p.x;
      cy += p.y;
    }
    if (n > 0) {
      cx /= n;
      cy /= n;
    }
  }

  // --- Geometry ---
  const radii: number[] = [];
  for (const p of points) {
    radii.push(Math.hypot(p.x - cx, p.y - cy));
  }
  const refRadius = fit.ok ? fit.r : mean(radii);
  const safeRadius = refRadius > 0 ? refRadius : 1;

  const smoothed = smoothSeries(radii, Math.max(5, Math.round(0.12 * n)));
  const residual: number[] = [];
  for (let i = 0; i < n; i++) {
    residual.push((radii[i] as number) - (smoothed[i] as number));
  }

  // Low-frequency wobble: amplitude of the best-fit sinusoid at 1-2
  // cycles across the sweep, measured over sector-averaged radius.
  // Sector averaging plus a narrow-band projection makes white noise
  // contribute ~nothing (noise spreads across all frequencies), while
  // human arm wobble concentrates at 1-2 cycles per revolution.
  const unwrapped = unwrapAngles(kin.angle);
  const radialWobble = radialWobbleAmplitude(radii, unwrapped, safeRadius);

  const radialResidual = std(residual) / safeRadius;
  const radialResidualAutocorr = lag1Autocorr(residual);
  const radiusCv = cv(radii);

  // Coverage: swept angle per stroke, summed (multi-stroke circles add up).
  // Step i connects samples i and i+1, so stroke membership compares
  // strokeIndices[i] with strokeIndices[i+1].
  const steps = kin.dAngle.length;
  let coverageTurns = 0;
  for (let i = 0; i < steps; i++) {
    const sameStroke =
      (strokeIndices[i + 1] as number) === (strokeIndices[i] as number);
    if (sameStroke) {
      coverageTurns += kin.dAngle[i] as number;
    }
    // Cross-stroke steps do not accumulate sweep.
  }
  const coverageTurnsAbs = Math.abs(coverageTurns) / (2 * Math.PI);

  // Core region: the middle 70% of the sweep by time. Start/end ramps
  // are shared structure — humans accelerate into a stroke and good
  // generators copy that — so the discriminative kinematics are
  // measured between the ramps, where human speed keeps varying with
  // hand posture and a ramp-wrapped constant-speed generator is flat.
  const t0 = n > 0 ? (times[0] as number) : 0;
  const tN = n > 0 ? (times[n - 1] as number) : 0;
  const totalT = tN - t0 > 0 ? tN - t0 : 1;
  const coreIdx: number[] = [];
  for (let i = 0; i < steps; i++) {
    const sMid = ((times[i] as number) + (times[i + 1] as number)) / 2;
    const frac = (sMid - t0) / totalT;
    if (frac >= 0.15 && frac <= 0.85) coreIdx.push(i);
  }
  const useCore = coreIdx.length >= 8;

  // Step-domain spectral pair over the core region (speed program
  // concentration + radius mid-band wander). Both series are
  // step-indexed with length = core steps, so cycle k means k
  // oscillations across the core sweep.
  const coreSpeeds: number[] = [];
  const coreStepRadii: number[] = [];
  for (const i of coreIdx) {
    coreSpeeds.push(kin.speed[i] as number);
    coreStepRadii.push(
      ((radii[i] as number) + (radii[i + 1] as number)) / 2,
    );
  }
  const spectral = coreSpectrum(coreSpeeds, coreStepRadii, safeRadius);

  const first = points[0];
  const last = points.length > 0 ? points[points.length - 1] : undefined;
  const closureGapRatio =
    first !== undefined && last !== undefined
      ? Math.hypot(last.x - first.x, last.y - first.y) / safeRadius
      : 0;

  const geometry: GeometryMetrics = {
    centerX: fit.ok ? fit.cx : 0,
    centerY: fit.ok ? fit.cy : 0,
    radius: fit.ok ? fit.r : 0,
    fitRmsError: fit.ok ? fit.rmsError : 0,
    radiusCv,
    coverageTurns: coverageTurnsAbs,
    closureGapRatio,
    radialWobble,
    radialResidual,
    radialResidualAutocorr,
    radialMidBandRms: spectral.radialMidBandRms,
  };

  // --- Kinematics ---
  const coreOmega = useCore
    ? coreIdx.map((i) => kin.omega[i] as number)
    : kin.omega;
  const coreAccel = useCore
    ? coreIdx
        .filter((i) => i < kin.accel.length)
        .map((i) => kin.accel[i] as number)
    : kin.accel;

  const speedMean = mean(kin.speed);
  const speedStd = std(kin.speed);
  const meanAbsAccel = mean(coreAccel.map(Math.abs));
  const accelStd = std(coreAccel);
  const startK = Math.max(1, Math.ceil(0.1 * steps));
  const endK = Math.max(1, Math.ceil(0.1 * steps));
  const startSpeedRatio =
    steps > 0 && speedMean > 0
      ? mean(kin.speed.slice(0, startK)) / speedMean
      : 0;
  const endSpeedRatio =
    steps > 0 && speedMean > 0
      ? mean(kin.speed.slice(steps - endK)) / speedMean
      : 0;

  const directionChanges = directionChangeCount(kin.dAngle);
  const maxCollinearRun = longestCollinearRun(points);
  const maxConstantSpeedRun = longestConstantRun(kin.speed, 1e-9);
  // Median per-step displacement (px): a resolution probe for per-step
  // kinematics. When a stroke is sampled so finely (high-rate device,
  // getCoalescedEvents feeding) or drawn so slowly that the typical
  // step is at the coordinate noise floor, per-step speed/direction
  // measurements describe noise, not motion.
  const stepDistances: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as { x: number; y: number };
    const b = points[i] as { x: number; y: number };
    stepDistances.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  const medianStepDistance = median(stepDistances);
  // Speed modulation is indexed by step: align angles to steps (angle at
  // each step's midpoint) so both series have length n-1, then restrict
  // to the core region for the same reason as the other kinematics.
  const stepAngles: number[] = [];
  for (let i = 0; i + 1 < unwrapped.length; i++) {
    stepAngles.push(((unwrapped[i] as number) + (unwrapped[i + 1] as number)) / 2);
  }
  const modulation = speedModulation(
    useCore ? coreIdx.map((i) => stepAngles[i] as number) : stepAngles,
    useCore ? coreIdx.map((i) => kin.speed[i] as number) : kin.speed,
  );

  const kinematics: KinematicMetrics = {
    meanSpeed: speedMean,
    speedCv: speedMean > 0 ? speedStd / speedMean : 0,
    speedModulation: modulation,
    angularVelocityCv: cv(coreOmega),
    angularVelocityAutocorr: lag1Autocorr(coreOmega),
    accelerationCv: meanAbsAccel > 0 ? accelStd / meanAbsAccel : 0,
    accelerationAutocorr: lag1Autocorr(coreAccel),
    startSpeedRatio,
    endSpeedRatio,
    directionChanges,
    medianStepDistance,
    speedLowBandShare: spectral.speedLowBandShare,
    maxCollinearRun,
    maxConstantSpeedRun,
  };

  // --- Timing ---
  const pauseFlags = findPauses(kin.dt, pauseMs);
  let pauses = 0;
  let pauseTotalMs = 0;
  for (let i = 0; i < pauseFlags.length; i++) {
    // Step i connects samples i and i+1; only within-stroke gaps count
    // as pauses (between strokes is already covered by MULTIPLE_STROKES).
    const sameStroke =
      (strokeIndices[i + 1] as number) === (strokeIndices[i] as number);
    if ((pauseFlags[i] as boolean) && sameStroke) {
      pauses++;
      pauseTotalMs += kin.dt[i] as number;
    }
  }

  const timing: TimingMetrics = {
    dtCv: cv(kin.dt),
    pauses,
    pauseMs: pauseTotalMs,
  };

  // --- Pressure ---
  const pressureValues: number[] = [];
  const pointerTypes = new Set<string>();
  for (const s of samples) {
    if (typeof s.pointerType === "string") pointerTypes.add(s.pointerType);
    if (typeof s.pressure === "number" && Number.isFinite(s.pressure)) {
      pressureValues.push(s.pressure);
    }
  }
  const types = [...pointerTypes];
  const touchLike =
    types.length > 0 && types.every((t) => t === "touch" || t === "pen");
  const positivePressure = pressureValues.filter((p) => p > 0).length;
  const pressureAvailable =
    touchLike &&
    pressureValues.length === n &&
    n > 0 &&
    positivePressure >= 0.8 * n;

  const pressure: PressureMetrics = {
    available: pressureAvailable,
    cv: pressureAvailable ? cv(pressureValues) : 0,
    uniqueValues: pressureAvailable
      ? countUnique(pressureValues, 1e-3, 1e-4)
      : 0,
  };

  // --- Strokes ---
  const strokeSet = new Set<number>();
  for (const s of strokeIndices) strokeSet.add(s);

  const durationMs = n >= 2 ? (times[n - 1] as number) - (times[0] as number) : 0;

  return {
    sampleCount: n,
    strokeCount: strokeSet.size > 0 ? strokeSet.size : n > 0 ? 1 : 0,
    durationMs,
    droppedSamples: 0, // filled in by the orchestrator
    geometry,
    kinematics,
    timing,
    pressure,
    pointerTypes: types,
  };
}

/**
 * Low-frequency radius-wobble amplitude: the larger of the best-fit
 * sinusoid amplitudes at 1 and 2 cycles across the sweep, measured over
 * sector-averaged radius, divided by the reference radius.
 *
 * Narrow-band by construction: white noise injected into a generated
 * circle spreads its energy across all frequencies and averages out of
 * the sector means, contributing negligible amplitude, while natural
 * arm wobble concentrates at 1-2 cycles per revolution.
 *
 * Returns 0 when there are too few samples or sectors to project
 * meaningfully.
 */
function radialWobbleAmplitude(
  radii: readonly number[],
  unwrappedAngles: readonly number[],
  radius: number,
): number {
  const n = radii.length;
  if (n < 12) return 0;

  let lo = Infinity;
  let hi = -Infinity;
  for (const a of unwrappedAngles) {
    if (a < lo) lo = a;
    if (a > hi) hi = a;
  }
  const span = hi - lo;
  if (!(span > 0)) return 0;

  const sectors = 12;
  const sums = new Array<number>(sectors).fill(0);
  const counts = new Array<number>(sectors).fill(0);
  const overallMean = mean(radii);
  for (let i = 0; i < n; i++) {
    const a = unwrappedAngles[i] as number;
    const r = radii[i] as number;
    const idx = Math.min(
      sectors - 1,
      Math.floor(((a - lo) / span) * sectors),
    );
    sums[idx] = (sums[idx] as number) + (r - overallMean);
    counts[idx] = (counts[idx] as number) + 1;
  }

  // Collect populated sector profiles: s in [0, 1] across the sweep,
  // y = sector mean deviation.
  const ss: number[] = [];
  const ys: number[] = [];
  for (let j = 0; j < sectors; j++) {
    const c = counts[j] as number;
    if (c > 0) {
      ss.push((j + 0.5) / sectors);
      ys.push((sums[j] as number) / c);
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

  return Math.max(amp(1), amp(2)) / radius;
}

/**
 * Step-domain spectral shape over the core region, feeding the
 * `BROADBAND_RADIUS_WANDER` conjunction signature.
 *
 * Humans concentrate speed variation at 1-2 cycles per sweep: the motor
 * program (acceleration ramp plus posture-driven modulation) is smooth
 * and slow, so nearly all speed-spectrum energy sits at the lowest
 * cycles. A generated circle whose radius carries injected broadband
 * wander cannot reproduce that while holding angular velocity constant:
 * the arc term makes speed track radius (`v ~= omega * r(t)`), so the
 * wander's mid-band spectrum leaks into speed and the 1-2 cycle share
 * collapses.
 *
 * Neither component separates on its own — humans with a weak motor
 * program exist (measured low-band share down to ~0.40 across 2000
 * corpus seeds) and so do humans with sizable mid-band radius deviation
 * (up to ~15.7 per mille of radius) — but the two tails never co-occur,
 * because both derive from the same motor system: a quiet speed program
 * comes with quiet radius, and a wobbly radius comes with a strong
 * coherent program. Zero of 2000 corpus seeds sit below 0.55 low-band
 * share while above 10 per mille mid-band RMS; the broadband
 * radius-wander evasion family sits there by construction (27-32 of 40
 * seeds per variant), while its narrow-band members converge toward
 * human-like wobble and escape (documented residual bypass).
 *
 * @returns `speedLowBandShare`: share of speed-spectrum energy at 1-2
 *   cycles (1 when the speed series is flat or too short to project,
 *   so the conjunction never fires on degenerate input).
 *   `radialMidBandRms`: RMS radius deviation at 4-9 cycles relative to
 *   `radius` (0 when the series is too short).
 */
function coreSpectrum(
  speeds: readonly number[],
  stepRadii: readonly number[],
  radius: number,
): { speedLowBandShare: number; radialMidBandRms: number } {
  const m = speeds.length;
  if (m < 32 || stepRadii.length !== m || !(radius > 0)) {
    return { speedLowBandShare: 1, radialMidBandRms: 0 };
  }
  const maxK = Math.min(40, Math.floor(m / 2) - 1);
  if (maxK < 9) {
    return { speedLowBandShare: 1, radialMidBandRms: 0 };
  }

  // Mean-removed direct DFT power at one cycle: p(k) = |X_k|^2 / m^2.
  // The mean only contributes to cycle 0, but subtracting it keeps the
  // accumulation numerically clean when deviations are small.
  const power = (x: readonly number[], xMean: number, k: number): number => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < m; i++) {
      const a = (2 * Math.PI * k * i) / m;
      const d = (x[i] as number) - xMean;
      re += d * Math.cos(a);
      im -= d * Math.sin(a);
    }
    return (re * re + im * im) / (m * m);
  };

  const speedMean = mean(speeds);
  let total = 0;
  let low = 0;
  for (let k = 1; k <= maxK; k++) {
    const p = power(speeds, speedMean, k);
    total += p;
    if (k <= 2) low += p;
  }
  // A flat speed series has no spectral shape; report a coherent share
  // so this pair never accuses on it (NO_SPEED_MODULATION covers
  // constant speed).
  const speedLowBandShare = total > 1e-12 ? low / total : 1;

  const radiusMean = mean(stepRadii);
  let mid = 0;
  for (let k = 4; k <= 9; k++) {
    mid += power(stepRadii, radiusMean, k);
  }
  return { speedLowBandShare, radialMidBandRms: Math.sqrt(2 * mid) / radius };
}
