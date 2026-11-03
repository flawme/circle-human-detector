import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeBehavioralMetrics,
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
} from "../src/engine/metrics.ts";
import { fitCircle } from "../src/engine/circle-fit.ts";
import { computeKinematics } from "../src/engine/kinematics.ts";
import { generateMachineCircle } from "./helpers/generators.ts";
import type { PointerSample } from "../src/types.ts";

describe("human-likeness normalization curves", () => {
  const close = (actual: number, expected: number, eps = 1e-9): void => {
    assert.ok(
      Math.abs(actual - expected) < eps,
      `expected ${expected} +/- ${eps}, got ${actual}`,
    );
  };

  it("anchors map to their documented values", () => {
    // speedModulation
    assert.equal(hlSpeedModulation(0.02), 0);
    close(hlSpeedModulation(0.06), 0.5);
    assert.equal(hlSpeedModulation(0.1), 1);
    // radialWobble
    assert.equal(hlRadialWobble(0.002), 0);
    assert.equal(hlRadialWobble(0.012), 1);
    assert.equal(hlRadialWobble(0.5), 0.45);
    // radialTremor (amplitude blended with temporal structure)
    assert.equal(hlRadialTremor(0.0004, 0), 0);
    assert.equal(hlRadialTremor(0.003, 1), 1);
    // amplitude without temporal structure caps at 0.6
    assert.ok(Math.abs(hlRadialTremor(0.003, 0) - 0.6) < 1e-9);
    // residualAutocorr
    assert.equal(hlResidualAutocorr(0.02), 0);
    assert.equal(hlResidualAutocorr(0.25), 1);
    // timestampIrregularity
    assert.equal(hlTimestampIrregularity(0.004), 0);
    assert.equal(hlTimestampIrregularity(0.04), 1);
    // collinearFreedom
    assert.equal(hlCollinearFreedom(0), 1);
    assert.equal(hlCollinearFreedom(2), 0.6);
    assert.equal(hlCollinearFreedom(4), 0);
    // directionStability
    assert.equal(hlDirectionStability(0), 1);
    assert.equal(hlDirectionStability(0.3), 0);
    // accelerationVariation (cv blended with temporal structure)
    assert.equal(hlAccelerationVariation(0.02, 0), 0);
    assert.equal(hlAccelerationVariation(0.12, 1), 1);
    // variation without temporal structure caps at 0.5
    assert.ok(Math.abs(hlAccelerationVariation(0.12, 0) - 0.5) < 1e-9);
    // pauseNaturalness
    assert.equal(hlPauseNaturalness(0), 1);
    assert.equal(hlPauseNaturalness(1), 0.75);
    assert.equal(hlPauseNaturalness(12), 0.3);
    // pressureVariation
    assert.equal(hlPressureVariation(0.002), 0);
    assert.equal(hlPressureVariation(0.02), 1);
  });

  it("startEndDynamics ramps down at full-speed starts", () => {
    assert.equal(hlStartEndDynamics(0.5, 0.5), 1);
    assert.equal(hlStartEndDynamics(1, 1), 0.6 * 0.1 + 0.4 * 0.15);
    assert.ok(hlStartEndDynamics(1, 1) < 0.2);
  });

  it("angularVelocityVariation blends cv and autocorrelation", () => {
    // constant omega, no structure: fully machine-like
    assert.equal(hlAngularVelocityVariation(0.001, -0.1), 0);
    // smooth structured variation: fully human-consistent
    assert.equal(hlAngularVelocityVariation(0.3, 0.8), 1);
    // cv alone (white noise injected on constant omega) scores halfway
    assert.ok(Math.abs(hlAngularVelocityVariation(0.3, 0) - 0.5) < 1e-12);
  });
});

describe("computeBehavioralMetrics", () => {
  function metricsFor(samples: readonly PointerSample[]) {
    const points = samples.map((s) => ({ x: s.x, y: s.y }));
    const times = samples.map((s) => s.t);
    const fit = fitCircle(points);
    const cx = fit.ok ? fit.cx : points.reduce((a, p) => a + p.x, 0) / points.length;
    const cy = fit.ok ? fit.cy : points.reduce((a, p) => a + p.y, 0) / points.length;
    const kin = computeKinematics(points, times, cx, cy);
    return computeBehavioralMetrics({
      samples: [...samples],
      points,
      times,
      strokeIndices: samples.map((s) => s.stroke ?? 0),
      fit,
      kin,
      pauseMs: 120,
    });
  }

  it("reports near-zero variation for a perfect parametric circle", () => {
    const m = metricsFor(generateMachineCircle({ seed: 7, variant: "parametric" }));
    assert.ok(m.geometry.radiusCv < 1e-9);
    assert.ok(m.geometry.radialResidual < 1e-9);
    assert.ok(m.kinematics.angularVelocityCv < 1e-6);
    assert.ok(m.kinematics.speedModulation < 1e-6);
    assert.ok(m.timing.dtCv < 1e-6);
    assert.ok(Math.abs(m.geometry.coverageTurns - 1) < 1e-6);
    assert.equal(m.pressure.available, false);
  });

  it("computes sweep coverage across more than one turn", () => {
    const m = metricsFor(
      generateMachineCircle({ seed: 3, variant: "parametric", turns: 1.25 }),
    );
    assert.ok(Math.abs(m.geometry.coverageTurns - 1.25) < 0.02);
  });

  it("marks touch pressure usable only for touch/pen", () => {
    const pen = generateMachineCircle({ seed: 5, variant: "parametric" }).map(
      (s): PointerSample => ({
        ...s,
        pointerType: "pen",
        pressure: 0.4 + 0.1 * Math.sin(s.t / 100),
      }),
    );
    const m = metricsFor(pen);
    assert.equal(m.pressure.available, true);
    assert.ok(m.pressure.uniqueValues > 10);

    const mouse = metricsFor(
      generateMachineCircle({ seed: 5, variant: "parametric" }).map(
        (s): PointerSample => ({ ...s, pointerType: "mouse", pressure: 0.5 }),
      ),
    );
    assert.equal(mouse.pressure.available, false);
  });

  it("counts strokes", () => {
    const base = generateMachineCircle({ seed: 9, variant: "parametric" });
    const twoStrokes = base.map((s, i) => ({
      ...s,
      stroke: i < base.length / 2 ? 0 : 1,
    }));
    assert.equal(metricsFor(twoStrokes).strokeCount, 2);
  });
});
