/**
 * circle-human-detector
 *
 * Behavioral detection of human vs machine-generated circle drawing.
 *
 * The full public surface: the `CircleDetector` facade, the DOM
 * collector, and the pure analysis engine. Server-side code that only
 * needs to analyze already-collected samples should import from
 * `circle-human-detector/analyze` instead — it pulls in no browser
 * types at all.
 */

export * from "./analyze.ts";
export * from "./collector.ts";
export * from "./detector.ts";
