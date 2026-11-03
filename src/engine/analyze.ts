/**
 * Analysis orchestration: one pure pass from samples to a verdict.
 *
 * Contract:
 * - Structurally invalid input (non-array, non-finite x/y/t) throws
 *   `CircleDetectorError` with code INVALID_SAMPLES: that is a caller
 *   bug and must fail loudly.
 * - Data-quality problems (too few samples, too short, not circle-like,
 *   non-monotonic timestamps) never throw: they drop data or downgrade
 *   the verdict to INCONCLUSIVE, with the reason in `anomalies`.
 * - Deterministic: the same samples + options produce an identical
 *   result, byte for byte.
 */

import type {
  Anomaly,
  AnomalyCode,
  CircleDetectionResult,
  DataQuality,
  DetectorOptions,
  PointerSample,
} from "../types.ts";
import { CircleDetectorError } from "../errors.ts";
import { fitCircle } from "./circle-fit.ts";
import { computeKinematics } from "./kinematics.ts";
import { computeBehavioralMetrics } from "./metrics.ts";
import {
  ANOMALY_SEVERITY,
  classify,
  computeConfidence,
  resolveOptions,
  scoreBehavior,
} from "./scoring.ts";

/** Gate for geometry sanity below which the shape is not circle-like. */
const MAX_FIT_RMS_ERROR = 0.4;
/** Radius CV above which the shape is not circle-like. */
const MAX_RADIUS_CV = 0.6;
/**
 * A stroke whose median per-step displacement is below this multiple of
 * the coordinate noise scale (radial residual x fitted radius) is
 * noise-dominated: per-step speeds and directions describe the noise,
 * not the motion. The three per-step machine signatures are measurement
 * artifacts there, so they are not evaluated; the verdict degrades to
 * the gray band (INCONCLUSIVE) instead of accusing on unresolvable
 * evidence. Machine corpora run well above this ratio (measured minimum
 * 2.78 across 200 seeds per variant), so no machine signature loses
 * its trigger in practice.
 */
const MIN_STEP_NOISE_RATIO = 1.5;
/**
 * Below this share of speed-spectrum energy at 1-2 cycles per sweep
 * (core region), the stroke lacks the smooth low-frequency motor
 * program humans always produce. Calibration on the shipped
 * time-based core region, 2000-seed human corpus: minimum share 0.403,
 * but every seed below 0.55 pairs it with mid-band radius RMS at or
 * under 8 per mille, so the wander paths below never fire on the
 * corpus. The radius-wander evasion family's broadband members sit
 * deep below this floor (shares down to 0.04).
 */
const SPEED_LOW_BAND_SHARE_MIN = 0.55;
/**
 * Share floor for the machine-steady rotation path. Humans whose
 * angular velocity is unusually steady still keep a coherent speed
 * program; requiring a non-coherent program here is what keeps the
 * path from accusing atypical-but-human strokes of steady rotation.
 */
const SPEED_LOW_BAND_SHARE_BROAD = 0.75;
/**
 * Above this RMS radius deviation at 4-9 cycles per sweep (fraction of
 * the fitted radius), the radius carries broadband wander rather than
 * natural wobble-plus-tremor. Calibration: 2000-seed human corpus
 * maximum 15.7 per mille, but every seed above 10 per mille carries a
 * coherent speed program (share >= 0.564).
 */
const RADIAL_MID_BAND_RMS_MAX = 0.01;
/**
 * Tighter mid-band wander ceiling for the near-steady-omega leg: the
 * single corpus seed with steady-ish rotation and 10+ per mille
 * mid-band (seed 397: omega CV 0.0985) peaks at 10.8 per mille, so
 * the steady-omega leg only fires above 11.
 */
const RADIAL_MID_BAND_RMS_STEADY = 0.011;
/**
 * Angular velocity CV below which rotation is machine-steady. Humans
 * modulate angular speed with hand posture; a generator with radius
 * wander holds omega constant (the wander moves the radius, never the
 * angular rate). Calibration: 2000-seed human corpus minimum omega CV
 * 0.0637 (p01 0.0934); the wander family's slow corner sits at
 * 0.018-0.058.
 */
const MACHINE_OMEGA_CV = 0.06;
/**
 * Omega CV ceiling for the steady-rotation leg of the wander path:
 * the human seeds nearest this corner (omega CV 0.0985-0.12) all carry
 * mid-band radius RMS at or under 10.8 per mille, so wander above 11
 * per mille with omega below 0.10 is unambiguous.
 */
const STEADY_OMEGA_CV = 0.1;

/**
 * Analyze a captured circle-drawing interaction.
 *
 * @param samples Chronologically ordered pointer samples.
 * @param options Sensitivity and threshold configuration.
 * @throws {CircleDetectorError} code `INVALID_SAMPLES` when `samples` is
 *   not an array or a sample has non-finite `x`, `y`, or `t`.
 * @throws {CircleDetectorError} code `INVALID_OPTIONS` when options are
 *   malformed.
 */
export function analyzeSamples(
  samples: readonly PointerSample[],
  options?: DetectorOptions,
): CircleDetectionResult {
  const resolved = resolveOptions(options);
  validateSamples(samples);

  // Drop samples with non-increasing timestamps (client clock defects,
  // replayed events). Counted, not fatal.
  const kept: PointerSample[] = [];
  let dropped = 0;
  let lastT = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    if (s.t > lastT) {
      kept.push(s);
      lastT = s.t;
    } else {
      dropped++;
    }
  }

  const points = kept.map((s) => ({ x: s.x, y: s.y }));
  const times = kept.map((s) => s.t);
  const strokeIndices = kept.map((s) => (typeof s.stroke === "number" && Number.isFinite(s.stroke) ? Math.max(0, Math.floor(s.stroke)) : 0));

  const fit = fitCircle(points);

  // Center for angular math: fitted center, or centroid when the fit
  // degenerated (angles from the centroid are meaningless for coverage,
  // but the math stays finite and data quality gates the verdict).
  let cx = 0;
  let cy = 0;
  if (fit.ok) {
    cx = fit.cx;
    cy = fit.cy;
  } else if (kept.length > 0) {
    for (const p of points) {
      cx += p.x;
      cy += p.y;
    }
    cx /= kept.length;
    cy /= kept.length;
  }

  const kin = computeKinematics(points, times, cx, cy);
  const metrics = computeBehavioralMetrics({
    samples: kept,
    points,
    times,
    strokeIndices,
    fit,
    kin,
    pauseMs: resolved.pauseMs,
  });
  metrics.droppedSamples = dropped;

  const steps = kept.length - 1;
  const geometryOk =
    fit.ok && fit.rmsError <= MAX_FIT_RMS_ERROR && metrics.geometry.radiusCv <= MAX_RADIUS_CV;

  const quality: DataQuality = {
    sufficientSamples: kept.length >= resolved.minSamples,
    sufficientDuration: metrics.durationMs >= resolved.minDurationMs,
    sufficientCoverage: metrics.geometry.coverageTurns >= resolved.minCoverageTurns,
    circleFitOk: geometryOk,
    pressureAvailable: metrics.pressure.available,
    analyzable: false,
  };
  quality.analyzable =
    quality.sufficientSamples &&
    quality.sufficientDuration &&
    quality.sufficientCoverage &&
    quality.circleFitOk;

  const anomalies = collectAnomalies(kept.length, steps, metrics, quality, resolved);

  const { score, contributions } = scoreBehavior(metrics, anomalies);
  const confidence = computeConfidence(metrics, contributions, quality, resolved, anomalies);
  const classification = classify(score, confidence, resolved.thresholds, quality.analyzable);

  return {
    score,
    confidence,
    classification,
    anomalies,
    metrics,
    contributions,
    dataQuality: quality,
  };
}

/** Validate sample shape. Non-finite coordinates or timestamps throw. */
function validateSamples(samples: readonly PointerSample[]): void {
  if (!Array.isArray(samples)) {
    throw new CircleDetectorError(
      "INVALID_SAMPLES",
      "samples must be an array of PointerSample objects",
    );
  }
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as PointerSample;
    if (typeof s !== "object" || s === null) {
      throw new CircleDetectorError(
        "INVALID_SAMPLES",
        `samples[${i}] must be an object`,
      );
    }
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.t)) {
      throw new CircleDetectorError(
        "INVALID_SAMPLES",
        `samples[${i}] must have finite x, y, and t (got x=${String(s.x)}, y=${String(s.y)}, t=${String(s.t)})`,
      );
    }
  }
}

/**
 * Assemble the anomaly list. Data-quality anomalies always report;
 * machine-signature checks only run with enough steps to be meaningful,
 * and angle-dependent ones additionally require a usable circle fit.
 */
function collectAnomalies(
  sampleCount: number,
  steps: number,
  metrics: CircleDetectionResult["metrics"],
  quality: DataQuality,
  resolved: ReturnType<typeof resolveOptions>,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const add = (code: AnomalyCode, detail: string): void => {
    anomalies.push({ code, severity: ANOMALY_SEVERITY[code], detail });
  };

  const k = metrics.kinematics;
  const g = metrics.geometry;

  if (!quality.sufficientSamples) {
    add(
      "INSUFFICIENT_SAMPLES",
      `${sampleCount} samples captured; at least ${resolved.minSamples} required for analysis`,
    );
  }
  if (!quality.sufficientDuration) {
    add(
      "INSUFFICIENT_DURATION",
      `drawing duration ${metrics.durationMs.toFixed(0)}ms is below the ${resolved.minDurationMs}ms minimum`,
    );
  }
  if (!quality.sufficientCoverage) {
    add(
      "INCOMPLETE_CIRCLE",
      `swept angle ${g.coverageTurns.toFixed(2)} turns is below the ${resolved.minCoverageTurns} required to count as a circle`,
    );
  }
  if (!quality.circleFitOk) {
    const reason = !fitOk(metrics)
      ? "circle fit failed (points are degenerate)"
      : `shape is not circle-like (fit RMS error ${(g.fitRmsError * 100).toFixed(1)}% of radius, radius CV ${(g.radiusCv * 100).toFixed(1)}%)`;
    add("NOT_CIRCLE_LIKE", reason);
  }
  if (metrics.strokeCount > 1) {
    add(
      "MULTIPLE_STROKES",
      `drawing was completed in ${metrics.strokeCount} strokes; single continuous strokes are typical`,
    );
  }

  // Per-step kinematics are only meaningful when the median step
  // displacement stands clear of the coordinate noise floor. A failed
  // fit yields no usable noise scale, so it never suppresses anything
  // (quality gates handle degenerate shapes separately).
  const noiseScalePx = g.radius > 0 ? g.radialResidual * g.radius : 0;
  const stepResolvable = k.medianStepDistance >= MIN_STEP_NOISE_RATIO * noiseScalePx;
  if (!stepResolvable && steps >= 16) {
    add(
      "MOTION_BELOW_NOISE_FLOOR",
      `median step displacement ${k.medianStepDistance.toFixed(2)}px is below ${MIN_STEP_NOISE_RATIO}x the coordinate noise scale (${noiseScalePx.toFixed(2)}px); per-step kinematic evidence is unresolvable, so per-step machine signatures are not evaluated`,
    );
  }

  // Machine signatures that do not need a usable circle fit.
  if (steps >= 20 && metrics.timing.dtCv < 0.004) {
    add(
      "UNIFORM_TIMESTAMPS",
      `inter-sample intervals are near-uniform (CV ${(metrics.timing.dtCv * 100).toFixed(2)}%); real input pipelines show more jitter`,
    );
  }
  if (k.maxCollinearRun >= 4) {
    add(
      "COLLINEAR_INTERPOLATION",
      `${k.maxCollinearRun} consecutive exactly-collinear equal-step point triples; consistent with linear interpolation between waypoints`,
    );
  }
  if (steps >= 24 && k.maxConstantSpeedRun >= 10) {
    add(
      "PIECEWISE_CONSTANT_SPEED",
      `longest run of identical per-step speeds is ${k.maxConstantSpeedRun} steps; natural motion does not hold speed exactly constant`,
    );
  }
  if (stepResolvable && steps >= 16 && k.startSpeedRatio > 0.98) {
    add(
      "INSTANT_START_VELOCITY",
      `first samples move at ${(k.startSpeedRatio * 100).toFixed(0)}% of mean speed; humans accelerate into a stroke`,
    );
  }
  if (metrics.timing.pauses >= 1) {
    add(
      "MID_STROKE_PAUSES",
      `${metrics.timing.pauses} pause(s) within strokes (${metrics.timing.pauseMs.toFixed(0)}ms total); unusual for machines, also seen with deliberate or assistive input`,
    );
  }
  if (metrics.pressure.available && metrics.pressure.uniqueValues === 1 && sampleCount >= 20) {
    add(
      "PRESSURE_INVARIANT",
      "pressure is reported but identical for every sample; real touch/pen pressure usually varies (some hardware reports constant pressure)",
    );
  }

  // Signatures that depend on angular geometry.
  if (quality.circleFitOk) {
    if (steps >= 24 && k.angularVelocityCv < 0.012) {
      add(
        "CONSTANT_ANGULAR_VELOCITY",
        `angular velocity is near-constant (CV ${(k.angularVelocityCv * 100).toFixed(2)}%); human angular speed varies with hand posture`,
      );
    }
    if (stepResolvable && steps >= 30 && k.speedModulation < 0.02) {
      add(
        "NO_SPEED_MODULATION",
        `speed does not vary with angular position (modulation ${(k.speedModulation * 100).toFixed(1)}%); human drawing speed varies around the circle`,
      );
    }
    if (sampleCount >= 40 && g.radialResidual < 0.0002) {
      add(
        "ZERO_RADIAL_RESIDUAL",
        `radial jitter is ${(g.radialResidual * 100).toFixed(4)}% of radius across ${sampleCount} samples; real pointers always show sub-pixel noise`,
      );
    }
    if (stepResolvable && steps >= 20 && k.directionChanges > Math.max(3, 0.06 * steps)) {
      add(
        "EXCESSIVE_DIRECTION_CHANGES",
        `${k.directionChanges} genuine direction reversals across the sweep; circling motion should be mostly monotonic in angle`,
      );
    }
    // White noise on an otherwise clean path: jitter amplitude in the
    // human band, but no temporal structure behind it and no smooth
    // radius wobble. Natural hand jitter is autocorrelated and humans
    // always leave some low-frequency wobble; independent noise on a
    // generated circle shows neither.
    if (
      sampleCount >= 40 &&
      g.radialResidual > 0.0015 &&
      g.radialResidualAutocorr < 0.1 &&
      g.radialWobble < 0.01
    ) {
      add(
        "NOISE_WITHOUT_STRUCTURE",
        `radial jitter (amplitude ${(g.radialResidual * 100).toFixed(2)}% of radius) has no temporal structure (autocorrelation ${g.radialResidualAutocorr.toFixed(2)}) and the radius shows no natural wobble; consistent with synthetic noise added to a generated path`,
      );
    }
    // Radius-wander evasion attacks inject smooth broadband noise into
    // the radius to defeat the residual-based signatures above. The
    // injected wander betrays the generator on two coupled axes: with
    // a constant angular velocity the wander tracks into speed
    // (v ~= omega * r(t)), destroying the concentration of speed
    // energy at 1-2 cycles that a human motor program produces, and
    // the wander never moves the angular rate itself, so omega stays
    // machine-steady where humans vary it with hand posture. Neither
    // axis separates alone, and neither does any pair: the corpus
    // contains humans at every single-axis extreme. What holds is the
    // conjunction — zero of 2000 calibration seeds fall on either path
    // — because a quiet speed program comes with quiet radius and a
    // wobbly radius comes with a strong coherent program: all of it
    // derives from one motor system, and a generator fakes one axis at
    // a time. Requires 46+ steps so the core-region spectrum has the
    // 32 steps it is calibrated on.
    if (stepResolvable && steps >= 46) {
      const broadbandWander =
        g.radialMidBandRms > RADIAL_MID_BAND_RMS_MAX &&
        (k.speedLowBandShare < SPEED_LOW_BAND_SHARE_MIN ||
          (k.angularVelocityCv < STEADY_OMEGA_CV &&
            g.radialMidBandRms > RADIAL_MID_BAND_RMS_STEADY));
      const steadyRotation =
        k.angularVelocityCv < MACHINE_OMEGA_CV &&
        k.speedLowBandShare < SPEED_LOW_BAND_SHARE_BROAD;
      if (broadbandWander || steadyRotation) {
        add(
          "BROADBAND_RADIUS_WANDER",
          `radius carries broadband wander (mid-band RMS ${(g.radialMidBandRms * 1000).toFixed(1)} per mille of radius) with only ${(k.speedLowBandShare * 100).toFixed(1)}% of speed energy at 1-2 cycles and angular velocity CV ${(k.angularVelocityCv * 100).toFixed(2)}%; a human motor program is dominated by smooth low-frequency speed variation and posture-driven angular variation, and never pairs wander on this scale with either signature`,
        );
      }
    }
  }

  return anomalies;
}

/** Whether the circle fit itself succeeded (mirrors the quality gate). */
function fitOk(metrics: CircleDetectionResult["metrics"]): boolean {
  return metrics.geometry.radius > 0;
}
