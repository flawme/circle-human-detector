/**
 * Scoring, thresholds, and classification.
 *
 * The final score has two additive parts:
 *
 *   score = weighted_mean(per-metric human-likeness) - machine_penalties
 *
 * The weighted mean rewards natural variation that a generator would have
 * to deliberately fake; the penalties punish machine signatures that no
 * natural hand produces (exactly constant angular velocity, collinear
 * interpolation runs, uniform timestamps, ...). Both parts are visible in
 * the result (`contributions` and `anomalies`), so every verdict can be
 * explained after the fact.
 *
 * Confidence is deliberately conservative: it combines data sufficiency
 * with cross-metric agreement, and a low confidence forces INCONCLUSIVE
 * no matter how confident the score looks.
 */

import type {
  Anomaly,
  AnomalyCode,
  BehavioralMetrics,
  Classification,
  DataQuality,
  DetectorOptions,
  MetricContribution,
  MetricKey,
  Sensitivity,
  Thresholds,
} from "../types.ts";
import { CircleDetectorError } from "../errors.ts";
import {
  hlAccelerationVariation,
  hlAngularVelocityVariation,
  hlCollinearFreedom,
  hlDirectionStability,
  hlPauseNaturalness,
  hlPressureVariation,
  hlRadialTremor,
  hlRadialWobble,
  hlResidualAutocorr,
  hlSpeedModulation,
  hlStartEndDynamics,
  hlTimestampIrregularity,
  METRIC_LABELS,
} from "./metrics.ts";
import { clamp, ramp, std } from "./stats.ts";

/**
 * Classification thresholds per sensitivity preset.
 *
 * The band between `suspiciousThreshold` and `humanThreshold` is the
 * gray zone: it classifies INCONCLUSIVE rather than guessing.
 */
export const SENSITIVITY_PRESETS: Record<Sensitivity, Thresholds> = {
  relaxed: {
    humanThreshold: 0.48,
    suspiciousThreshold: 0.26,
    minConfidence: 0.3,
  },
  balanced: {
    humanThreshold: 0.58,
    suspiciousThreshold: 0.33,
    minConfidence: 0.4,
  },
  strict: {
    humanThreshold: 0.66,
    suspiciousThreshold: 0.4,
    minConfidence: 0.5,
  },
};

/**
 * Weights of the behavioral metrics. They sum to 1 without pressure;
 * when usable pressure data exists, pressureVariation joins and the
 * aggregate renormalizes.
 *
 * Rationale, roughly: movement dynamics (velocity/acceleration
 * structure) carry the signal; geometry noise carries the least;
 * timestamp regularity and direction stability are corroborating only,
 * because both are environment-sensitive and trivially fakeable.
 */
export const METRIC_WEIGHTS: Record<MetricKey, number> = {
  angularVelocityVariation: 0.16,
  speedModulation: 0.16,
  radialWobble: 0.12,
  radialTremor: 0.1,
  residualAutocorrelation: 0.1,
  startEndDynamics: 0.12,
  timestampIrregularity: 0.06,
  collinearFreedom: 0.06,
  directionStability: 0.04,
  accelerationVariation: 0.04,
  pauseNaturalness: 0.04,
  pressureVariation: 0.05,
};

/**
 * Score penalties applied when a machine-signature anomaly is present.
 * Applied after the weighted mean, so a single hard signature can pull
 * a noisy-but-otherwise-human-looking interaction below the suspicious
 * threshold.
 */
export const ANOMALY_PENALTIES: Partial<Record<AnomalyCode, number>> = {
  // Heaviest penalty in the table by design: the conjunction was
  // calibrated so no human-corpus seed can fire it (0 of 2000), so a
  // false accusation has no measured support, and the size guarantees
  // that even a perfect 1.0 base score cannot clear the balanced
  // human threshold once the signature is present (1.0 - 0.45 = 0.55
  // < 0.58).
  BROADBAND_RADIUS_WANDER: 0.45,
  CONSTANT_ANGULAR_VELOCITY: 0.35,
  COLLINEAR_INTERPOLATION: 0.3,
  PIECEWISE_CONSTANT_SPEED: 0.25,
  NOISE_WITHOUT_STRUCTURE: 0.2,
  ZERO_RADIAL_RESIDUAL: 0.15,
  UNIFORM_TIMESTAMPS: 0.12,
  NO_SPEED_MODULATION: 0.1,
  INSTANT_START_VELOCITY: 0.1,
  PRESSURE_INVARIANT: 0.05,
  EXCESSIVE_DIRECTION_CHANGES: 0.05,
  MULTIPLE_STROKES: 0.05,
  MID_STROKE_PAUSES: 0.02,
};

/** Severity labels reported alongside anomalies. */
export const ANOMALY_SEVERITY: Record<AnomalyCode, "low" | "medium" | "high"> = {
  INSUFFICIENT_SAMPLES: "high",
  INSUFFICIENT_DURATION: "high",
  INCOMPLETE_CIRCLE: "high",
  NOT_CIRCLE_LIKE: "high",
  MULTIPLE_STROKES: "low",
  CONSTANT_ANGULAR_VELOCITY: "high",
  UNIFORM_TIMESTAMPS: "medium",
  COLLINEAR_INTERPOLATION: "high",
  PIECEWISE_CONSTANT_SPEED: "high",
  ZERO_RADIAL_RESIDUAL: "high",
  INSTANT_START_VELOCITY: "medium",
  NO_SPEED_MODULATION: "medium",
  EXCESSIVE_DIRECTION_CHANGES: "low",
  MID_STROKE_PAUSES: "low",
  PRESSURE_INVARIANT: "low",
  NOISE_WITHOUT_STRUCTURE: "high",
  BROADBAND_RADIUS_WANDER: "high",
  MOTION_BELOW_NOISE_FLOOR: "medium",
};

/** Fully-validated options with defaults applied. */
export interface ResolvedOptions {
  sensitivity: Sensitivity;
  thresholds: Thresholds;
  minSamples: number;
  minDurationMs: number;
  minCoverageTurns: number;
  pauseMs: number;
}

/**
 * Validate options and apply defaults. Throws `CircleDetectorError` with
 * code `INVALID_OPTIONS` on malformed input so misconfiguration fails
 * loudly at the boundary instead of silently changing behavior.
 */
export function resolveOptions(options?: DetectorOptions): ResolvedOptions {
  const o = options ?? {};
  if (typeof o !== "object" || o === null) {
    throw new CircleDetectorError(
      "INVALID_OPTIONS",
      "options must be an object when provided",
    );
  }

  const sensitivity: Sensitivity = o.sensitivity ?? "balanced";
  if (!(sensitivity in SENSITIVITY_PRESETS)) {
    throw new CircleDetectorError(
      "INVALID_OPTIONS",
      `sensitivity must be one of "relaxed", "balanced", "strict" (got ${JSON.stringify(sensitivity)})`,
    );
  }
  const thresholds: Thresholds = { ...SENSITIVITY_PRESETS[sensitivity] };
  if (o.thresholds !== undefined) {
    const t = o.thresholds;
    for (const key of ["humanThreshold", "suspiciousThreshold", "minConfidence"] as const) {
      const v = t[key];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new CircleDetectorError(
          "INVALID_OPTIONS",
          `thresholds.${key} must be a finite number in [0, 1]`,
        );
      }
      thresholds[key] = v;
    }
    if (thresholds.suspiciousThreshold >= thresholds.humanThreshold) {
      throw new CircleDetectorError(
        "INVALID_OPTIONS",
        "thresholds.suspiciousThreshold must be strictly below thresholds.humanThreshold",
      );
    }
  }

  const minSamples = o.minSamples ?? 24;
  if (
    typeof minSamples !== "number" ||
    !Number.isInteger(minSamples) ||
    minSamples < 5
  ) {
    throw new CircleDetectorError(
      "INVALID_OPTIONS",
      "minSamples must be an integer >= 5",
    );
  }

  const minDurationMs = o.minDurationMs ?? 300;
  if (typeof minDurationMs !== "number" || !Number.isFinite(minDurationMs) || minDurationMs <= 0) {
    throw new CircleDetectorError(
      "INVALID_OPTIONS",
      "minDurationMs must be a finite number > 0",
    );
  }

  const minCoverageTurns = o.minCoverageTurns ?? 0.85;
  if (
    typeof minCoverageTurns !== "number" ||
    !Number.isFinite(minCoverageTurns) ||
    minCoverageTurns <= 0 ||
    minCoverageTurns > 3
  ) {
    throw new CircleDetectorError(
      "INVALID_OPTIONS",
      "minCoverageTurns must be a finite number in (0, 3]",
    );
  }

  const pauseMs = o.pauseMs ?? 120;
  if (typeof pauseMs !== "number" || !Number.isFinite(pauseMs) || pauseMs <= 0) {
    throw new CircleDetectorError(
      "INVALID_OPTIONS",
      "pauseMs must be a finite number > 0",
    );
  }

  return { sensitivity, thresholds, minSamples, minDurationMs, minCoverageTurns, pauseMs };
}

/**
 * Aggregate per-metric human-likeness into the final score and the
 * per-metric contribution table.
 *
 * Metrics that cannot be computed from the provided data (fewer than
 * two samples) are excluded from the weighted mean with an explanatory
 * note, never defaulted — an empty interaction must not inherit the
 * "absence of pathology" score of metrics like pause naturalness.
 */
export function scoreBehavior(
  metrics: BehavioralMetrics,
  anomalies: readonly Anomaly[],
): { score: number; contributions: MetricContribution[] } {
  const k = metrics.kinematics;
  const steps = Math.max(0, metrics.sampleCount - 1);
  const scorable = metrics.sampleCount >= 2 && steps > 0;

  const values: Array<{ key: MetricKey; value: number; note?: string }> = [
    {
      key: "angularVelocityVariation",
      value: hlAngularVelocityVariation(k.angularVelocityCv, k.angularVelocityAutocorr),
    },
    { key: "speedModulation", value: hlSpeedModulation(k.speedModulation) },
    { key: "radialWobble", value: hlRadialWobble(metrics.geometry.radialWobble) },
    { key: "radialTremor", value: hlRadialTremor(metrics.geometry.radialResidual, metrics.geometry.radialResidualAutocorr) },
    {
      key: "residualAutocorrelation",
      value: hlResidualAutocorr(metrics.geometry.radialResidualAutocorr),
    },
    {
      key: "startEndDynamics",
      value: hlStartEndDynamics(k.startSpeedRatio, k.endSpeedRatio),
    },
    { key: "timestampIrregularity", value: hlTimestampIrregularity(metrics.timing.dtCv) },
    { key: "collinearFreedom", value: hlCollinearFreedom(k.maxCollinearRun) },
    {
      key: "directionStability",
      value: hlDirectionStability(steps > 0 ? k.directionChanges / steps : 1),
    },
    { key: "accelerationVariation", value: hlAccelerationVariation(k.accelerationCv, k.accelerationAutocorr) },
    { key: "pauseNaturalness", value: hlPauseNaturalness(metrics.timing.pauses) },
  ];

  const pressureAvailable = metrics.pressure.available;
  values.push({
    key: "pressureVariation",
    value: pressureAvailable ? hlPressureVariation(metrics.pressure.cv) : 0,
    note: pressureAvailable
      ? undefined
      : "no usable pressure data (mouse or absent); metric excluded from scoring",
  });

  let weightSum = 0;
  let weighted = 0;
  const contributions: MetricContribution[] = [];
  for (const entry of values) {
    const excluded = !scorable;
    const isPressure = entry.key === "pressureVariation";
    const weight = excluded || (isPressure && !pressureAvailable) ? 0 : METRIC_WEIGHTS[entry.key];
    weightSum += weight;
    weighted += weight * entry.value;
    const note = excluded
      ? "not computable from the provided data; metric excluded from scoring"
      : entry.note;
    contributions.push({
      key: entry.key,
      label: METRIC_LABELS[entry.key],
      value: round4(entry.value),
      weight: round4(weight),
      ...(note !== undefined ? { note } : {}),
    });
  }

  let score = weightSum > 0 ? weighted / weightSum : 0;
  for (const a of anomalies) {
    const penalty = ANOMALY_PENALTIES[a.code];
    if (penalty !== undefined) {
      score -= penalty;
    }
  }
  score = clamp(score, 0, 1);

  return { score: round4(score), contributions };
}

/**
 * Metrics that actually separate human from machine behavior.
 *
 * `collinearFreedom`, `directionStability`, and `pauseNaturalness` are
 * deliberately excluded from the cross-metric agreement term: they are
 * "absence of pathology" checks that any well-formed input (human or
 * bot) satisfies, so including them would depress the confidence of
 * cleanly machine-like data and make obvious bots classify
 * INCONCLUSIVE.
 */
const DISCRIMINATIVE_METRICS: ReadonlySet<MetricKey> = new Set([
  "angularVelocityVariation",
  "speedModulation",
  "radialWobble",
  "radialTremor",
  "residualAutocorrelation",
  "startEndDynamics",
  "timestampIrregularity",
  "accelerationVariation",
  "pressureVariation",
]);

/**
 * Machine signatures that real input pipelines cannot produce. When at
 * least one is present, the evidence for machine generation is
 * unambiguous in that direction, so the cross-metric agreement term is
 * floored — hard signatures are consensus for SUSPICIOUS, not
 * disagreement against it.
 */
const HARD_MACHINE_SIGNATURES: ReadonlySet<AnomalyCode> = new Set([
  "CONSTANT_ANGULAR_VELOCITY",
  "COLLINEAR_INTERPOLATION",
  "PIECEWISE_CONSTANT_SPEED",
  "ZERO_RADIAL_RESIDUAL",
]);

/**
 * Confidence in [0, 1]: data sufficiency crossed with cross-metric
 * agreement. Zero when the interaction is not analyzable.
 *
 * Agreement is floored at 0.75 when a hard machine signature is
 * present: geometric byproducts of a generator (for example the chord
 * sagitta of waypoint interpolation) can mimic tremor on one metric,
 * and that single outlier must not demote an otherwise unambiguous
 * machine verdict to INCONCLUSIVE.
 */
export function computeConfidence(
  metrics: BehavioralMetrics,
  contributions: readonly MetricContribution[],
  quality: DataQuality,
  resolved: ResolvedOptions,
  anomalies: readonly Anomaly[],
): number {
  if (!quality.analyzable) return 0;

  const sufficiency =
    0.45 * ramp((metrics.sampleCount - resolved.minSamples) / (3 * resolved.minSamples), 0, 1) +
    0.3 * ramp((metrics.durationMs - resolved.minDurationMs) / (3 * resolved.minDurationMs), 0, 1) +
    0.25 * ramp(
      (metrics.geometry.coverageTurns - resolved.minCoverageTurns) / 0.45,
      0,
      1,
    );

  const scored = contributions
    .filter((c) => c.weight > 0 && DISCRIMINATIVE_METRICS.has(c.key))
    .map((c) => c.value);
  let agreement = clamp(1 - std(scored) / 0.4, 0, 1);
  const hasHardSignature = anomalies.some((a) => HARD_MACHINE_SIGNATURES.has(a.code));
  if (hasHardSignature) {
    agreement = Math.max(agreement, 0.75);
  }

  return round4(clamp(0.45 * sufficiency + 0.55 * agreement, 0, 1));
}

/**
 * Final classification from score, confidence, and thresholds.
 * Everything unanalyzable or low-confidence is INCONCLUSIVE; the band
 * between thresholds is INCONCLUSIVE too — the detector never guesses.
 */
export function classify(
  score: number,
  confidence: number,
  thresholds: Thresholds,
  analyzable: boolean,
): Classification {
  if (!analyzable) return "INCONCLUSIVE";
  if (confidence < thresholds.minConfidence) return "INCONCLUSIVE";
  if (score >= thresholds.humanThreshold) return "HUMAN_LIKE";
  if (score <= thresholds.suspiciousThreshold) return "SUSPICIOUS";
  return "INCONCLUSIVE";
}

/** Round to 4 decimals for stable, deterministic JSON output. */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
