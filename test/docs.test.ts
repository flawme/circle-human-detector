import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SENSITIVITY_PRESETS,
  METRIC_WEIGHTS,
  ANOMALY_PENALTIES,
  resolveOptions,
} from "../src/engine/scoring.ts";
import { analyzeSamples } from "../src/analyze.ts";
import { CircleDetector } from "../src/detector.ts";
import { generateHumanCircle } from "./helpers/generators.ts";

/**
 * Documentation contract tests: the numbers published in README.md and
 * docs/API.md must match the code. If either side changes without the
 * other, these tests fail — the docs are load-bearing.
 */
describe("documented constants match the code", () => {
  it("sensitivity presets match the published tables", () => {
    assert.deepEqual(SENSITIVITY_PRESETS.relaxed, {
      humanThreshold: 0.48,
      suspiciousThreshold: 0.26,
      minConfidence: 0.3,
    });
    assert.deepEqual(SENSITIVITY_PRESETS.balanced, {
      humanThreshold: 0.58,
      suspiciousThreshold: 0.33,
      minConfidence: 0.4,
    });
    assert.deepEqual(SENSITIVITY_PRESETS.strict, {
      humanThreshold: 0.66,
      suspiciousThreshold: 0.4,
      minConfidence: 0.5,
    });
  });

  it("option defaults match the published tables", () => {
    const r = resolveOptions();
    assert.equal(r.minSamples, 24);
    assert.equal(r.minDurationMs, 300);
    assert.equal(r.minCoverageTurns, 0.85);
    assert.equal(r.pauseMs, 120);
    assert.equal(r.sensitivity, "balanced");
  });

  it("metric weights match the published table", () => {
    assert.equal(METRIC_WEIGHTS.angularVelocityVariation, 0.16);
    assert.equal(METRIC_WEIGHTS.speedModulation, 0.16);
    assert.equal(METRIC_WEIGHTS.radialWobble, 0.12);
    assert.equal(METRIC_WEIGHTS.radialTremor, 0.1);
    assert.equal(METRIC_WEIGHTS.residualAutocorrelation, 0.1);
    assert.equal(METRIC_WEIGHTS.startEndDynamics, 0.12);
    assert.equal(METRIC_WEIGHTS.timestampIrregularity, 0.06);
    assert.equal(METRIC_WEIGHTS.collinearFreedom, 0.06);
    assert.equal(METRIC_WEIGHTS.directionStability, 0.04);
    assert.equal(METRIC_WEIGHTS.accelerationVariation, 0.04);
    assert.equal(METRIC_WEIGHTS.pauseNaturalness, 0.04);
    assert.equal(METRIC_WEIGHTS.pressureVariation, 0.05);
  });

  it("anomaly penalties match the published table", () => {
    assert.equal(ANOMALY_PENALTIES.BROADBAND_RADIUS_WANDER, 0.45);
    assert.equal(ANOMALY_PENALTIES.CONSTANT_ANGULAR_VELOCITY, 0.35);
    assert.equal(ANOMALY_PENALTIES.COLLINEAR_INTERPOLATION, 0.3);
    assert.equal(ANOMALY_PENALTIES.PIECEWISE_CONSTANT_SPEED, 0.25);
    assert.equal(ANOMALY_PENALTIES.NOISE_WITHOUT_STRUCTURE, 0.2);
    assert.equal(ANOMALY_PENALTIES.ZERO_RADIAL_RESIDUAL, 0.15);
    assert.equal(ANOMALY_PENALTIES.UNIFORM_TIMESTAMPS, 0.12);
    assert.equal(ANOMALY_PENALTIES.NO_SPEED_MODULATION, 0.1);
    assert.equal(ANOMALY_PENALTIES.INSTANT_START_VELOCITY, 0.1);
    assert.equal(ANOMALY_PENALTIES.PRESSURE_INVARIANT, 0.05);
    assert.equal(ANOMALY_PENALTIES.EXCESSIVE_DIRECTION_CHANGES, 0.05);
    assert.equal(ANOMALY_PENALTIES.MULTIPLE_STROKES, 0.05);
    assert.equal(ANOMALY_PENALTIES.MID_STROKE_PAUSES, 0.02);
  });
});

describe("documented code samples work against the shipped API", () => {
  it("README quick start (browser spec flow) behaves as documented", () => {
    // Mirrors the README facade sample: construct with sensitivity,
    // start, draw, analyze.
    const detector = new CircleDetector({ sensitivity: "balanced" });
    detector.start();

    const samples = generateHumanCircle({ seed: 1 });
    const first = samples[0] as { x: number; y: number; t: number };
    detector.recordEvent({ type: "pointerdown", ...first });
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i] as { x: number; y: number; t: number };
      detector.recordEvent({ type: "pointermove", ...s });
    }
    const last = samples[samples.length - 1] as { x: number; y: number; t: number };
    detector.recordEvent({ type: "pointerup", ...last });

    const result = detector.analyze();
    // The README documents these three fields and the classification
    // semantics.
    assert.ok(typeof result.score === "number" && result.score >= 0 && result.score <= 1);
    assert.ok(typeof result.confidence === "number" && result.confidence >= 0 && result.confidence <= 1);
    assert.equal(result.classification, "HUMAN_LIKE");
  });

  it("README node sample branches on classification as documented", () => {
    const result = analyzeSamples(generateHumanCircle({ seed: 2 }), {
      sensitivity: "balanced",
    });

    // The documented server branch logic must be able to take every
    // documented path for the possible classifications.
    const pass =
      result.classification === "HUMAN_LIKE" && result.confidence > 0.6;
    const reject =
      result.classification === "SUSPICIOUS" ||
      result.classification === "INCONCLUSIVE";
    assert.ok(pass === true || reject === true);
  });
});
