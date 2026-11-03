import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ANOMALY_PENALTIES,
  SENSITIVITY_PRESETS,
  classify,
  computeConfidence,
  resolveOptions,
  scoreBehavior,
} from "../src/engine/scoring.ts";
import { CircleDetectorError } from "../src/errors.ts";
import type {
  Anomaly,
  BehavioralMetrics,
  DataQuality,
  DetectorOptions,
} from "../src/types.ts";

/** A metrics table with every field explicitly overridable. */
function makeMetrics(
  overrides: Partial<{
    omegaCv: number;
    omegaAutocorr: number;
    speedModulation: number;
    radialWobble: number;
    radialResidual: number;
    residualAutocorr: number;
    startRatio: number;
    endRatio: number;
    dtCv: number;
    collinearRun: number;
    directionChanges: number;
    medianStepDistance: number;
    speedLowBandShare: number;
    radialMidBandRms: number;
    accelCv: number;
    accelAutocorr: number;
    pauses: number;
    pressureCv: number;
    pressureAvailable: boolean;
    pressureUnique: number;
    sampleCount: number;
    durationMs: number;
    coverageTurns: number;
  }> = {},
): BehavioralMetrics {
  const n = overrides.sampleCount ?? 120;
  return {
    sampleCount: n,
    strokeCount: 1,
    durationMs: overrides.durationMs ?? 1600,
    droppedSamples: 0,
    geometry: {
      centerX: 0,
      centerY: 0,
      radius: 100,
      fitRmsError: 0.03,
      radiusCv: 0.05,
      coverageTurns: overrides.coverageTurns ?? 1.05,
      closureGapRatio: 0.1,
      radialWobble: overrides.radialWobble ?? 0.03,
      radialResidual: overrides.radialResidual ?? 0.006,
      radialResidualAutocorr: overrides.residualAutocorr ?? 0.6,
      radialMidBandRms: overrides.radialMidBandRms ?? 0.004,
    },
    kinematics: {
      meanSpeed: 0.4,
      speedCv: 0.25,
      speedModulation: overrides.speedModulation ?? 0.3,
      angularVelocityCv: overrides.omegaCv ?? 0.2,
      angularVelocityAutocorr: overrides.omegaAutocorr ?? 0.7,
      accelerationCv: overrides.accelCv ?? 0.5,
      accelerationAutocorr: overrides.accelAutocorr ?? 0.7,
      startSpeedRatio: overrides.startRatio ?? 0.55,
      endSpeedRatio: overrides.endRatio ?? 0.6,
      directionChanges: overrides.directionChanges ?? 0,
      medianStepDistance: overrides.medianStepDistance ?? 5,
      speedLowBandShare: overrides.speedLowBandShare ?? 0.9,
      maxCollinearRun: overrides.collinearRun ?? 0,
      maxConstantSpeedRun: 1,
    },
    timing: {
      dtCv: overrides.dtCv ?? 0.15,
      pauses: overrides.pauses ?? 0,
      pauseMs: 0,
    },
    pressure: {
      available: overrides.pressureAvailable ?? false,
      cv: overrides.pressureCv ?? 0,
      uniqueValues: overrides.pressureUnique ?? 0,
    },
    pointerTypes: ["mouse"],
  };
}

const fullQuality: DataQuality = {
  sufficientSamples: true,
  sufficientDuration: true,
  sufficientCoverage: true,
  circleFitOk: true,
  pressureAvailable: false,
  analyzable: true,
};

describe("resolveOptions", () => {
  it("applies documented defaults", () => {
    const r = resolveOptions();
    assert.equal(r.sensitivity, "balanced");
    assert.equal(r.minSamples, 24);
    assert.equal(r.minDurationMs, 300);
    assert.equal(r.minCoverageTurns, 0.85);
    assert.equal(r.pauseMs, 120);
    assert.deepEqual(r.thresholds, SENSITIVITY_PRESETS.balanced);
  });

  it("merges threshold overrides onto the preset", () => {
    const r = resolveOptions({
      sensitivity: "strict",
      thresholds: { humanThreshold: 0.7 },
    });
    assert.equal(r.thresholds.humanThreshold, 0.7);
    assert.equal(r.thresholds.suspiciousThreshold, SENSITIVITY_PRESETS.strict.suspiciousThreshold);
    assert.equal(r.thresholds.minConfidence, SENSITIVITY_PRESETS.strict.minConfidence);
  });

  it("rejects invalid sensitivity", () => {
    assert.throws(
      () => resolveOptions({ sensitivity: "nope" as DetectorOptions["sensitivity"] }),
      (e: unknown) => e instanceof CircleDetectorError && e.code === "INVALID_OPTIONS",
    );
  });

  it("rejects out-of-range or inverted thresholds", () => {
    assert.throws(
      () => resolveOptions({ thresholds: { humanThreshold: 1.5 } }),
      CircleDetectorError,
    );
    assert.throws(
      () => resolveOptions({ thresholds: { suspiciousThreshold: 0.9, humanThreshold: 0.8 } }),
      CircleDetectorError,
    );
  });

  it("rejects invalid numeric options", () => {
    assert.throws(() => resolveOptions({ minSamples: 3 }), CircleDetectorError);
    assert.throws(() => resolveOptions({ minSamples: 4.5 }), CircleDetectorError);
    assert.throws(() => resolveOptions({ minDurationMs: 0 }), CircleDetectorError);
    assert.throws(() => resolveOptions({ minCoverageTurns: 0 }), CircleDetectorError);
    assert.throws(() => resolveOptions({ minCoverageTurns: 4 }), CircleDetectorError);
    assert.throws(() => resolveOptions({ pauseMs: -1 }), CircleDetectorError);
  });
});

describe("scoreBehavior", () => {
  it("scores human-consistent metrics high", () => {
    const { score } = scoreBehavior(makeMetrics(), []);
    assert.ok(score > 0.8, `expected > 0.8, got ${score}`);
  });

  it("scores parametric machine metrics far below the suspicious threshold", () => {
    const m = makeMetrics({
      omegaCv: 0,
      omegaAutocorr: 0,
      speedModulation: 0,
      radialWobble: 0,
      radialResidual: 0,
      residualAutocorr: 0,
      startRatio: 1,
      endRatio: 1,
      dtCv: 0,
      accelCv: 0,
    });
    const { score } = scoreBehavior(m, []);
    // The residual score comes only from "absence of pathology" metrics
    // (no collinear runs, no reversals, no pauses) that any clean input
    // satisfies. The invariant that matters: comfortably below the
    // balanced suspicious threshold of 0.33.
    assert.ok(score < 0.25, `expected < 0.25, got ${score}`);
  });

  it("applies machine-signature penalties", () => {
    const metrics = makeMetrics();
    const clean = scoreBehavior(metrics, []).score;
    const flagged: Anomaly[] = [
      { code: "CONSTANT_ANGULAR_VELOCITY", severity: "high", detail: "x" },
      { code: "UNIFORM_TIMESTAMPS", severity: "medium", detail: "x" },
    ];
    const penalized = scoreBehavior(metrics, flagged).score;
    const expectedDrop =
      (ANOMALY_PENALTIES.CONSTANT_ANGULAR_VELOCITY ?? 0) +
      (ANOMALY_PENALTIES.UNIFORM_TIMESTAMPS ?? 0);
    assert.ok(Math.abs(clean - penalized - expectedDrop) < 0.01);
  });

  it("excludes pressure from scoring when unavailable and reports a note", () => {
    const { contributions } = scoreBehavior(
      makeMetrics({ pressureAvailable: false }),
      [],
    );
    const pressure = contributions.find((c) => c.key === "pressureVariation");
    assert.ok(pressure !== undefined);
    assert.equal(pressure.weight, 0);
    assert.ok(pressure.note !== undefined);
  });

  it("includes pressure when available", () => {
    const { contributions } = scoreBehavior(
      makeMetrics({ pressureAvailable: true, pressureCv: 0.05, pressureUnique: 40 }),
      [],
    );
    const pressure = contributions.find((c) => c.key === "pressureVariation");
    assert.ok(pressure !== undefined);
    assert.ok((pressure?.weight ?? 0) > 0);
  });
});

describe("computeConfidence", () => {
  it("returns 0 when not analyzable", () => {
    const { contributions } = scoreBehavior(makeMetrics(), []);
    assert.equal(
      computeConfidence(makeMetrics(), contributions, { ...fullQuality, analyzable: false }, resolveOptions(), []),
      0,
    );
  });

  it("grows with sample count and duration", () => {
    const resolved = resolveOptions();
    const small = makeMetrics({ sampleCount: 24, durationMs: 300, coverageTurns: 0.85 });
    const big = makeMetrics({ sampleCount: 150, durationMs: 2000, coverageTurns: 1.05 });
    const c1 = computeConfidence(small, scoreBehavior(small, []).contributions, fullQuality, resolved, []);
    const c2 = computeConfidence(big, scoreBehavior(big, []).contributions, fullQuality, resolved, []);
    assert.ok(c2 > c1);
    assert.ok(c1 > 0);
    assert.ok(c2 <= 1);
  });

  it("floors agreement when a hard machine signature is present", () => {
    const resolved = resolveOptions();
    // Metrics that disagree wildly (one tremor-like outlier among zeros).
    const disagreeing = makeMetrics({
      radialResidual: 0.02,
      residualAutocorr: 0.9,
      omegaCv: 0,
      omegaAutocorr: 0,
      speedModulation: 0,
      radialWobble: 0,
      dtCv: 0,
      startRatio: 1,
      endRatio: 1,
      accelCv: 0,
      accelAutocorr: 0,
    });
    const contributions = scoreBehavior(disagreeing, []).contributions;
    const noAnomaly = computeConfidence(disagreeing, contributions, fullQuality, resolved, []);
    const hardSignature: Anomaly[] = [
      { code: "COLLINEAR_INTERPOLATION", severity: "high", detail: "x" },
    ];
    const withAnomaly = computeConfidence(disagreeing, contributions, fullQuality, resolved, hardSignature);
    assert.ok(withAnomaly > noAnomaly);
    assert.ok(withAnomaly >= 0.75);
  });
});

describe("classify", () => {
  const t = SENSITIVITY_PRESETS.balanced;

  it("classifies by thresholds when confidence permits", () => {
    assert.equal(classify(0.8, 0.9, t, true), "HUMAN_LIKE");
    assert.equal(classify(0.1, 0.9, t, true), "SUSPICIOUS");
    assert.equal(classify(0.4, 0.9, t, true), "INCONCLUSIVE");
  });

  it("forces INCONCLUSIVE on low confidence or unanalyzable data", () => {
    assert.equal(classify(0.8, 0.2, t, true), "INCONCLUSIVE");
    assert.equal(classify(0.1, 0.9, t, false), "INCONCLUSIVE");
  });
});
