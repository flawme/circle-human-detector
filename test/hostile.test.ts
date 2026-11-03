import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { analyzeSamples } from "../src/analyze.ts";
import { generateHumanCircle } from "./helpers/generators.ts";

/**
 * Hostile-input hardening: degenerate, extreme, and malformed payloads
 * must never crash the engine, never leak non-finite numbers into a
 * result, and must degrade to INCONCLUSIVE (or throw CircleDetectorError
 * for structural invalids — covered in analyze.test.ts) rather than
 * produce a confident verdict.
 */

/** Every numeric field anywhere in the result must be finite. */
function assertAllFinite(value: unknown, path = "result"): void {
  const visit = (v: unknown, p: string): void => {
    if (typeof v === "number") {
      assert.ok(Number.isFinite(v), `non-finite number at ${p}: ${v}`);
    } else if (Array.isArray(v)) {
      v.forEach((el, i) => visit(el, `${p}[${i}]`));
    } else if (v !== null && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) visit(val, `${p}.${k}`);
    }
  };
  visit(value, path);
}

describe("hostile degenerate data", () => {
  it("returns INCONCLUSIVE for coincident points with distinct timestamps", () => {
    const samples = Array.from({ length: 24 }, (_, i) => ({
      x: 5,
      y: 5,
      t: i * 30,
    }));
    const r = analyzeSamples(samples);
    assertAllFinite(r);
    assert.equal(r.classification, "INCONCLUSIVE");
    assert.ok(r.anomalies.some((a) => a.code === "NOT_CIRCLE_LIKE"));
  });

  it("returns INCONCLUSIVE for coincident points with identical timestamps", () => {
    const samples = Array.from({ length: 24 }, () => ({ x: 5, y: 5, t: 1000 }));
    const r = analyzeSamples(samples);
    assertAllFinite(r);
    assert.equal(r.classification, "INCONCLUSIVE");
    assert.ok(r.anomalies.some((a) => a.code === "INSUFFICIENT_DURATION"));
  });

  it("survives a single valid sample", () => {
    const r = analyzeSamples([{ x: 10, y: 10, t: 0 }]);
    assertAllFinite(r);
    assert.equal(r.classification, "INCONCLUSIVE");
  });
});

describe("hostile clocks", () => {
  it("survives all-identical timestamps (zero time deltas)", () => {
    const base = generateHumanCircle({ seed: 7 });
    const r = analyzeSamples(base.map((s) => ({ ...s, t: 5000 })));
    assertAllFinite(r);
    assert.equal(r.classification, "INCONCLUSIVE");
  });

  it("survives timestamps flowing backwards", () => {
    const base = generateHumanCircle({ seed: 7 });
    const r = analyzeSamples(
      base.map((s, i) => ({ ...s, t: 10000 - i * 30 })),
    );
    assertAllFinite(r);
    assert.equal(r.classification, "INCONCLUSIVE");
  });

  it("still classifies at epoch-scale timestamps (~1e15)", () => {
    const base = generateHumanCircle({ seed: 7 });
    const r = analyzeSamples(base.map((s, i) => ({ ...s, t: 1e15 + i * 30 })));
    assertAllFinite(r);
    assert.equal(r.classification, "HUMAN_LIKE");
  });
});

describe("hostile optional fields", () => {
  it("drops non-finite pressure instead of leaking it into metrics", () => {
    const base = generateHumanCircle({ seed: 7 });
    const r = analyzeSamples(base.map((s) => ({ ...s, pressure: NaN })));
    assertAllFinite(r);
    // Pressure that is not a usable number must be treated as absent:
    // the verdict matches the same samples with no pressure at all.
    assert.equal(r.classification, "HUMAN_LIKE");
    assert.equal(r.metrics.pressure.available, false);
  });

  it("ignores junk pointerType and non-finite width", () => {
    const base = generateHumanCircle({ seed: 7 });
    const r = analyzeSamples(
      base.map((s) => ({ ...s, width: Infinity, pointerType: "\u0000" })),
    );
    assertAllFinite(r);
    assert.equal(r.classification, "HUMAN_LIKE");
  });
});

describe("extreme scale and pathological size", () => {
  const base = generateHumanCircle({ seed: 7 });

  it("keeps the verdict at 1e6 scale with a 1e9 offset", () => {
    const r = analyzeSamples(
      base.map((s) => ({ ...s, x: s.x * 1e6 + 1e9, y: s.y * 1e6 + 1e9 })),
      { sensitivity: "balanced" },
    );
    assertAllFinite(r);
    assert.equal(r.classification, "HUMAN_LIKE");
  });

  it("keeps the verdict at 1e-3 scale", () => {
    const r = analyzeSamples(
      base.map((s) => ({ ...s, x: s.x * 1e-3, y: s.y * 1e-3 })),
      { sensitivity: "balanced" },
    );
    assertAllFinite(r);
    assert.equal(r.classification, "HUMAN_LIKE");
  });

  it("degrades to INCONCLUSIVE when per-step motion falls below the noise floor", () => {
    // durationMs / dtMeanMs = 60000 / 3 = ~20,000 samples: median step
    // displacement sinks below the coordinate noise scale, so per-step
    // kinematics describe noise, not motion.
    const big = generateHumanCircle({
      seed: 11,
      durationMs: 60_000,
      dtMeanMs: 3,
    });
    // Jittered timestamps make the exact count stochastic; pin a floor.
    assert.ok(big.length >= 15_000, `only ${big.length} samples generated`);
    const started = Date.now();
    const r = analyzeSamples(big);
    const elapsedMs = Date.now() - started;
    assertAllFinite(r);
    // The honest verdict for unresolvable per-step evidence is
    // INCONCLUSIVE, never an accusation.
    assert.equal(r.classification, "INCONCLUSIVE");
    assert.ok(r.score > 0.33, `score ${r.score} must not read as machine-like`);
    const codes: string[] = r.anomalies.map((a) => a.code);
    assert.ok(codes.includes("MOTION_BELOW_NOISE_FLOOR"), `anomalies: ${codes.join(",")}`);
    // The per-step machine signatures are measurement artifacts in this
    // regime and must not fire.
    for (const artifact of [
      "INSTANT_START_VELOCITY",
      "NO_SPEED_MODULATION",
      "EXCESSIVE_DIRECTION_CHANGES",
    ]) {
      assert.ok(!codes.includes(artifact), `${artifact} fired below the noise floor`);
    }
    // Generous bound: only an accidental super-linear regression fails.
    assert.ok(elapsedMs < 5000, `20k-sample analysis took ${elapsedMs}ms`);
  });

  it("never reports the noise-floor anomaly for resolvable strokes", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = analyzeSamples(generateHumanCircle({ seed }));
      const codes = r.anomalies.map((a) => a.code);
      assert.ok(!codes.includes("MOTION_BELOW_NOISE_FLOOR"), `seed ${seed}: ${codes.join(",")}`);
      assert.equal(r.classification, "HUMAN_LIKE");
    }
  });
});
