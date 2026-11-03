/**
 * Sensitivity presets for the detection engine.
 *
 * - `relaxed`: requires stronger machine evidence before flagging an
 *   interaction as suspicious. Use when false accusations are costly.
 * - `balanced`: default operating point.
 * - `strict`: flags more borderline interactions as suspicious. Use when
 *   missed bots are costlier than challenged humans; expect more
 *   INCONCLUSIVE verdicts for real users.
 */
export type Sensitivity = "relaxed" | "balanced" | "strict";

/**
 * Final classification of an analyzed interaction.
 *
 * - `HUMAN_LIKE`: behavioral evidence is consistent with human movement.
 *   This is a probabilistic signal, never proof of humanity.
 * - `SUSPICIOUS`: behavioral evidence contains machine signatures or is
 *   strongly inconsistent with natural human movement.
 * - `INCONCLUSIVE`: data is insufficient or metrics disagree too much to
 *   make a responsible call either way.
 */
export type Classification = "HUMAN_LIKE" | "SUSPICIOUS" | "INCONCLUSIVE";

/**
 * One captured pointer position during drawing.
 *
 * Coordinates are in drawing-surface pixels; `t` is a millisecond
 * timestamp from a monotonic clock (`performance.now()` in browsers,
 * `Date.now()` or any monotonic source elsewhere). Samples must be in
 * chronological order; samples with non-increasing timestamps are treated
 * as data-quality defects and dropped (see `DataQuality.droppedSamples`).
 */
export interface PointerSample {
  /** X coordinate in surface pixels. */
  x: number;
  /** Y coordinate in surface pixels. */
  y: number;
  /** Monotonic timestamp in milliseconds. */
  t: number;
  /** Normalized pressure 0..1, when the device reports it. */
  pressure?: number;
  /** Pointer hardware category: `"mouse"`, `"touch"`, `"pen"`, or custom. */
  pointerType?: string;
  /** Contact width in pixels, when the device reports it. */
  width?: number;
  /**
   * Stroke index: `0` for the first stroke, incremented after each
   * pointerup. Omit for single-stroke data.
   */
  stroke?: number;
}

/** Classification thresholds; see `DetectorOptions.thresholds`. */
export interface Thresholds {
  /**
   * Score at or above this is classified HUMAN_LIKE (when confidence
   * permits). Range (0, 1].
   */
  humanThreshold: number;
  /**
   * Score at or below this is classified SUSPICIOUS (when confidence
   * permits). Must be strictly below `humanThreshold`.
   */
  suspiciousThreshold: number;
  /**
   * Confidence below this forces INCONCLUSIVE regardless of score.
   * Range [0, 1).
   */
  minConfidence: number;
}

/** Options accepted by `analyzeSamples` and the `CircleDetector` facade. */
export interface DetectorOptions {
  /** Sensitivity preset. Default `"balanced"`. */
  sensitivity?: Sensitivity;
  /** Per-field overrides on top of the sensitivity preset. */
  thresholds?: Partial<Thresholds>;
  /**
   * Minimum sample count for an analyzable interaction.
   * Default 24. Must be >= 5.
   */
  minSamples?: number;
  /**
   * Minimum drawing duration in milliseconds for an analyzable
   * interaction. Default 300. Must be > 0.
   */
  minDurationMs?: number;
  /**
   * Minimum swept angle in full turns (1 turn = 2*pi radians) for the
   * gesture to count as a circle attempt. Default 0.85.
   * Must be in (0, 3].
   */
  minCoverageTurns?: number;
  /**
   * Gap in milliseconds that counts as a pause within a stroke
   * (and must also exceed 2.5x the median inter-sample gap).
   * Default 120. Must be > 0.
   */
  pauseMs?: number;
}

/** Machine signature / data-quality anomaly codes. */
export type AnomalyCode =
  | "INSUFFICIENT_SAMPLES"
  | "INSUFFICIENT_DURATION"
  | "INCOMPLETE_CIRCLE"
  | "NOT_CIRCLE_LIKE"
  | "MULTIPLE_STROKES"
  | "CONSTANT_ANGULAR_VELOCITY"
  | "UNIFORM_TIMESTAMPS"
  | "COLLINEAR_INTERPOLATION"
  | "PIECEWISE_CONSTANT_SPEED"
  | "ZERO_RADIAL_RESIDUAL"
  | "INSTANT_START_VELOCITY"
  | "NO_SPEED_MODULATION"
  | "EXCESSIVE_DIRECTION_CHANGES"
  | "MID_STROKE_PAUSES"
  | "PRESSURE_INVARIANT"
  | "NOISE_WITHOUT_STRUCTURE"
  | "BROADBAND_RADIUS_WANDER"
  | "MOTION_BELOW_NOISE_FLOOR";

/** One detected anomaly with human-readable context. */
export interface Anomaly {
  code: AnomalyCode;
  /** How strongly this anomaly weighs toward machine-generation or against data usability. */
  severity: "low" | "medium" | "high";
  /** Human-readable explanation including the observed value. */
  detail: string;
}

/** Circle-geometry metrics, all normalized so they are scale-invariant. */
export interface GeometryMetrics {
  /** Fitted circle center X in surface pixels. */
  centerX: number;
  /** Fitted circle center Y in surface pixels. */
  centerY: number;
  /** Fitted circle radius in pixels. */
  radius: number;
  /** RMS radial residual / radius. Small for circle-like shapes. */
  fitRmsError: number;
  /** Coefficient of variation of the radius over the sweep. */
  radiusCv: number;
  /** Swept angle in full turns (1.0 = exactly one revolution). */
  coverageTurns: number;
  /** Distance between first and last point / radius. */
  closureGapRatio: number;
  /** Low-frequency radius modulation amplitude / radius. */
  radialWobble: number;
  /** High-frequency radius residual std / radius (tremor/jitter proxy). */
  radialResidual: number;
  /**
   * Lag-1 autocorrelation of the radial residual. Human jitter and
   * smooth-path error are temporally correlated; injected white noise is
   * not. Values near 0 are consistent with synthetic noise.
   */
  radialResidualAutocorr: number;
  /**
   * RMS radius deviation at 4-9 cycles per sweep, relative to the
   * fitted radius, measured over the core region. Natural arm wobble
   * concentrates at 1-2 cycles and tremor at the high end, so a large
   * mid-band amplitude indicates broadband radius wander of the kind
   * produced by scripted noise added to a generated path. Calibrated as
   * a conjunction with `KinematicMetrics.speedLowBandShare` (see
   * `BROADBAND_RADIUS_WANDER`); on its own its tails overlap the human
   * corpus.
   */
  radialMidBandRms: number;
}

/** Movement-dynamics metrics. */
export interface KinematicMetrics {
  /** Mean speed in pixels/ms. */
  meanSpeed: number;
  /** Coefficient of variation of per-step speed. */
  speedCv: number;
  /**
   * Systematic speed variation across angular position
   * ((max bin mean - min bin mean) / overall mean over 6 angle bins).
   * Human drawing speed varies with hand posture; constant-speed
   * machines stay near 0.
   */
  speedModulation: number;
  /** Coefficient of variation of per-step angular velocity. */
  angularVelocityCv: number;
  /**
   * Lag-1 autocorrelation of per-step angular velocity. Smooth human
   * modulation is positively correlated; white noise injected onto a
   * constant-speed generator is not.
   */
  angularVelocityAutocorr: number;
  /** Coefficient of variation of per-step tangential acceleration. */
  accelerationCv: number;
  /** Lag-1 autocorrelation of per-step tangential acceleration. */
  accelerationAutocorr: number;
  /** Mean speed of the first 10% of steps / overall mean speed. */
  startSpeedRatio: number;
  /** Mean speed of the last 10% of steps / overall mean speed. */
  endSpeedRatio: number;
  /** Count of genuine direction reversals along the sweep. */
  directionChanges: number;
  /**
   * Median per-step displacement in pixels. Compared against the
   * coordinate noise scale to decide whether per-step kinematics are
   * resolvable at the captured sampling density.
   */
  medianStepDistance: number;
  /**
   * Share of the per-step speed spectrum's energy at 1-2 cycles per
   * sweep, measured over the core region. Human speed variation is
   * dominated by a smooth motor program (ramp plus posture modulation),
   * so most speed energy sits at the lowest cycles; a generator whose
   * speed is `omega * r(t)` inherits the broadband spectrum of injected
   * radius noise instead. Calibrated as a conjunction with
   * `GeometryMetrics.radialMidBandRms` (see `BROADBAND_RADIUS_WANDER`).
   * Reported as 1 when the speed series is flat or too short to
   * project meaningfully.
   */
  speedLowBandShare: number;
  /** Longest run of consecutive exactly-collinear point triples. */
  maxCollinearRun: number;
  /** Longest run of consecutive identical per-step speeds. */
  maxConstantSpeedRun: number;
}

/** Timing metrics. */
export interface TimingMetrics {
  /** Coefficient of variation of inter-sample intervals. */
  dtCv: number;
  /** Pauses within strokes. */
  pauses: number;
  /** Total within-stroke pause time in milliseconds. */
  pauseMs: number;
}

/** Pressure metrics; only meaningful for touch/pen with real pressure. */
export interface PressureMetrics {
  /** Whether usable pressure data exists (touch/pen with varying values). */
  available: boolean;
  /** Coefficient of variation of pressure. 0 when unavailable. */
  cv: number;
  /** Distinct pressure values observed (relative tolerance). */
  uniqueValues: number;
}

/** Full behavioral metric table reported in the result. */
export interface BehavioralMetrics {
  sampleCount: number;
  strokeCount: number;
  /** t_last - t_first in milliseconds. */
  durationMs: number;
  /** Samples dropped for non-increasing timestamps. */
  droppedSamples: number;
  geometry: GeometryMetrics;
  kinematics: KinematicMetrics;
  timing: TimingMetrics;
  pressure: PressureMetrics;
  /** Distinct pointer types observed in the samples. */
  pointerTypes: string[];
}

/** Stable identifiers for the scored behavioral metrics. */
export type MetricKey =
  | "angularVelocityVariation"
  | "speedModulation"
  | "radialWobble"
  | "radialTremor"
  | "residualAutocorrelation"
  | "startEndDynamics"
  | "timestampIrregularity"
  | "collinearFreedom"
  | "directionStability"
  | "accelerationVariation"
  | "pauseNaturalness"
  | "pressureVariation";

/** One metric's contribution to the final score. */
export interface MetricContribution {
  key: MetricKey;
  /** Human-readable metric name. */
  label: string;
  /** Normalized human-likeness of this metric, 0 (machine-like) .. 1 (human-like). */
  value: number;
  /** Effective weight in the aggregate (0 when the metric was unavailable). */
  weight: number;
  /** Optional context, e.g. why a metric was excluded. */
  note?: string;
}

/** Data sufficiency summary. `analyzable` false forces INCONCLUSIVE. */
export interface DataQuality {
  sufficientSamples: boolean;
  sufficientDuration: boolean;
  /** Swept angle met the configured minimum. */
  sufficientCoverage: boolean;
  /** The fitted shape is circle-like (fit succeeded, sane residuals). */
  circleFitOk: boolean;
  /** Pressure data was usable for scoring. */
  pressureAvailable: boolean;
  /** True when the interaction can be classified at all. */
  analyzable: boolean;
}

/** Result of analyzing one circle-drawing interaction. */
export interface CircleDetectionResult {
  /**
   * Human-likelihood estimate in [0, 1]: the weighted mean of per-metric
   * human-likeness minus machine-signature penalties. It is a heuristic
   * signal, not a probability.
   */
  score: number;
  /**
   * Confidence in the classification in [0, 1], derived from data
   * sufficiency and agreement between metrics. Below the configured
   * minimum the verdict is INCONCLUSIVE by construction.
   */
  confidence: number;
  classification: Classification;
  /** Detected anomalies; empty when nothing notable was found. */
  anomalies: Anomaly[];
  /** Raw behavioral metrics for transparency and downstream tuning. */
  metrics: BehavioralMetrics;
  /** Per-metric human-likeness and weights used to compute `score`. */
  contributions: MetricContribution[];
  /** Data sufficiency report. */
  dataQuality: DataQuality;
}
