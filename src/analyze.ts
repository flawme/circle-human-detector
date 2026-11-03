/**
 * Pure analysis entrypoint.
 *
 * This module is Node-safe by construction: it pulls in only the
 * environment-agnostic engine and shared types. It touches no DOM types
 * or APIs, so server-side analysis of samples collected elsewhere
 * imports from here with zero browser baggage.
 *
 * ```ts
 * import { analyzeSamples } from "circle-human-detector/analyze";
 *
 * const result = analyzeSamples(samples, { sensitivity: "balanced" });
 * ```
 */

export { analyzeSamples } from "./engine/analyze.ts";
export { SENSITIVITY_PRESETS } from "./engine/scoring.ts";
export { CircleDetectorError } from "./errors.ts";
export type { ErrorCode } from "./errors.ts";
export type {
  Anomaly,
  AnomalyCode,
  BehavioralMetrics,
  Classification,
  CircleDetectionResult,
  DataQuality,
  DetectorOptions,
  GeometryMetrics,
  KinematicMetrics,
  MetricContribution,
  MetricKey,
  PointerSample,
  PressureMetrics,
  Sensitivity,
  Thresholds,
  TimingMetrics,
} from "./types.ts";
