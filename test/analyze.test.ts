import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { analyzeSamples } from "../src/analyze.ts";
import { CircleDetectorError } from "../src/errors.ts";
import {
  generateHumanCircle,
  generateMachineCircle,
  generateStraightLine,
  rotateSamples,
  scaleSamples,
  translateSamples,
} from "./helpers/generators.ts";
import type { AnomalyCode, PointerSample } from "../src/types.ts";

/** Number of corpus trials per class in the integration sweep. */
const TRIALS = 40;

function codes(result: { anomalies: Array<{ code: AnomalyCode }> }): Set<AnomalyCode> {
  return new Set(result.anomalies.map((a) => a.code));
}

describe("analyzeSamples: synthetic corpus", () => {
  it("classifies human-model circles as HUMAN_LIKE", () => {
    const failures: number[] = [];
    for (let seed = 1; seed <= TRIALS; seed++) {
      const result = analyzeSamples(generateHumanCircle({ seed }));
      if (result.classification !== "HUMAN_LIKE") failures.push(seed);
    }
    assert.deepEqual(failures, [], `seeds that failed HUMAN_LIKE: ${failures.join(", ")}`);
  });

  it("classifies parametric machine circles as SUSPICIOUS", () => {
    for (let seed = 1; seed <= TRIALS; seed++) {
      const result = analyzeSamples(generateMachineCircle({ seed, variant: "parametric" }));
      assert.equal(
        result.classification,
        "SUSPICIOUS",
        `parametric seed ${seed} scored ${result.score} (conf ${result.confidence})`,
      );
      assert.ok(codes(result).has("CONSTANT_ANGULAR_VELOCITY"));
      assert.ok(codes(result).has("UNIFORM_TIMESTAMPS"));
    }
  });

  it("classifies noisy machine circles as SUSPICIOUS despite injected noise", () => {
    for (let seed = 1; seed <= TRIALS; seed++) {
      const result = analyzeSamples(generateMachineCircle({ seed, variant: "noisy" }));
      assert.equal(
        result.classification,
        "SUSPICIOUS",
        `noisy seed ${seed} scored ${result.score} (conf ${result.confidence})`,
      );
    }
  });

  it("classifies waypoint-interpolated circles as SUSPICIOUS", () => {
    for (let seed = 1; seed <= TRIALS; seed++) {
      const result = analyzeSamples(generateMachineCircle({ seed, variant: "waypoint" }));
      assert.equal(
        result.classification,
        "SUSPICIOUS",
        `waypoint seed ${seed} scored ${result.score} (conf ${result.confidence})`,
      );
      assert.ok(codes(result).has("COLLINEAR_INTERPOLATION"));
    }
  });

  it("never classifies the adversarial generator as HUMAN_LIKE", () => {
    for (let seed = 1; seed <= TRIALS; seed++) {
      const result = analyzeSamples(generateMachineCircle({ seed, variant: "adversarial" }));
      assert.notEqual(
        result.classification,
        "HUMAN_LIKE",
        `adversarial seed ${seed} scored ${result.score} (conf ${result.confidence})`,
      );
    }
  });
});

describe("analyzeSamples: data quality", () => {
  it("returns INCONCLUSIVE for empty input", () => {
    const result = analyzeSamples([]);
    assert.equal(result.classification, "INCONCLUSIVE");
    assert.equal(result.score, 0);
    assert.equal(result.confidence, 0);
    assert.ok(codes(result).has("INSUFFICIENT_SAMPLES"));
    assert.equal(result.dataQuality.analyzable, false);
  });

  it("returns INCONCLUSIVE below the sample floor", () => {
    const short = generateHumanCircle({ seed: 42 }).slice(0, 12);
    const result = analyzeSamples(short);
    assert.equal(result.classification, "INCONCLUSIVE");
    assert.ok(codes(result).has("INSUFFICIENT_SAMPLES"));
  });

  it("returns INCONCLUSIVE for a too-short interaction in time", () => {
    const quick = generateHumanCircle({ seed: 11, durationMs: 120, dtMeanMs: 4 });
    const result = analyzeSamples(quick);
    assert.equal(result.classification, "INCONCLUSIVE");
    assert.ok(codes(result).has("INSUFFICIENT_DURATION"));
  });

  it("returns INCONCLUSIVE for a non-circle shape", () => {
    const result = analyzeSamples(generateStraightLine(100));
    assert.equal(result.classification, "INCONCLUSIVE");
    assert.ok(codes(result).has("NOT_CIRCLE_LIKE"));
  });

  it("returns INCONCLUSIVE for an incomplete arc", () => {
    const arc = generateMachineCircle({ seed: 5, variant: "parametric", turns: 0.6 });
    const result = analyzeSamples(arc);
    assert.equal(result.classification, "INCONCLUSIVE");
    assert.ok(codes(result).has("INCOMPLETE_CIRCLE"));
  });

  it("counts dropped samples with non-increasing timestamps", () => {
    const samples = generateMachineCircle({ seed: 5, variant: "parametric" });
    const mangled: PointerSample[] = [...samples];
    const mid = Math.floor(samples.length / 2);
    const midT = (samples[mid] as PointerSample).t;
    mangled.splice(mid, 0, { ...(samples[mid] as PointerSample), t: midT });
    const result = analyzeSamples(mangled);
    assert.equal(result.metrics.droppedSamples, 1);
    assert.equal(result.metrics.sampleCount, samples.length);
  });

  it("flags multi-stroke drawings", () => {
    const samples = generateHumanCircle({ seed: 21 });
    const half = Math.floor(samples.length / 2);
    const two = samples.map((s, i) => ({ ...s, stroke: i < half ? 0 : 1 }));
    const result = analyzeSamples(two);
    assert.ok(codes(result).has("MULTIPLE_STROKES"));
  });
});

describe("analyzeSamples: pressure", () => {
  it("flags constant pressure on touch/pen", () => {
    const samples = generateHumanCircle({ seed: 33 }).map((s) => ({
      ...s,
      pointerType: "touch",
      pressure: 0.5,
    }));
    const result = analyzeSamples(samples);
    assert.ok(codes(result).has("PRESSURE_INVARIANT"));
    assert.equal(result.metrics.pressure.available, true);
  });

  it("does not flag varying pressure", () => {
    const samples = generateHumanCircle({ seed: 33, includePressure: true, pointerType: "pen" });
    const result = analyzeSamples(samples);
    assert.ok(!codes(result).has("PRESSURE_INVARIANT"));
    assert.equal(result.metrics.pressure.available, true);
  });

  it("ignores mouse pressure entirely", () => {
    const samples = generateHumanCircle({ seed: 33 }).map((s) => ({
      ...s,
      pointerType: "mouse",
      pressure: 0.5,
    }));
    const result = analyzeSamples(samples);
    assert.equal(result.metrics.pressure.available, false);
    assert.ok(!codes(result).has("PRESSURE_INVARIANT"));
  });
});

describe("analyzeSamples: determinism and invariance", () => {
  it("is deterministic for identical input", () => {
    const samples = generateHumanCircle({ seed: 77 });
    const a = analyzeSamples(samples, { sensitivity: "strict" });
    const b = analyzeSamples(samples, { sensitivity: "strict" });
    assert.deepEqual(a, b);
  });

  it("classification is stable under translation, uniform scaling, and rotation", () => {
    const samples = generateHumanCircle({ seed: 5 });
    const base = analyzeSamples(samples);

    const translated = analyzeSamples(translateSamples(samples, 5000, -3000));
    assert.equal(translated.classification, base.classification);
    assert.ok(Math.abs(translated.score - base.score) < 0.05);

    const scaled = analyzeSamples(scaleSamples(samples, 4.2));
    assert.equal(scaled.classification, base.classification);
    assert.ok(Math.abs(scaled.score - base.score) < 0.05);

    const rotated = analyzeSamples(rotateSamples(samples, 1.234));
    assert.equal(rotated.classification, base.classification);
    assert.ok(Math.abs(rotated.score - base.score) < 0.05);
  });

  it("sensitivity presets move the verdict monotonically", () => {
    // Build a borderline case: adversarial machine with human-ish tweaks.
    const samples = generateMachineCircle({ seed: 14, variant: "adversarial" });
    const relaxed = analyzeSamples(samples, { sensitivity: "relaxed" });
    const strict = analyzeSamples(samples, { sensitivity: "strict" });
    // Whatever each preset says, HUMAN_LIKE under strict implies not
    // suspicious under relaxed (threshold ordering is monotone).
    if (strict.classification === "HUMAN_LIKE") {
      assert.notEqual(relaxed.classification, "SUSPICIOUS");
    }
  });
});

describe("analyzeSamples: error handling", () => {
  it("throws INVALID_SAMPLES for non-array input", () => {
    assert.throws(
      () => analyzeSamples(undefined as unknown as PointerSample[]),
      (e: unknown) => e instanceof CircleDetectorError && e.code === "INVALID_SAMPLES",
    );
    assert.throws(
      () => analyzeSamples("nope" as unknown as PointerSample[]),
      CircleDetectorError,
    );
  });

  it("throws INVALID_SAMPLES for non-finite coordinates or timestamps", () => {
    assert.throws(
      () => analyzeSamples([{ x: Number.NaN, y: 0, t: 0 }]),
      (e: unknown) => e instanceof CircleDetectorError && e.code === "INVALID_SAMPLES",
    );
    assert.throws(() => analyzeSamples([{ x: 0, y: 0, t: Number.POSITIVE_INFINITY }]), CircleDetectorError);
    assert.throws(() => analyzeSamples([{ x: 0, y: undefined, t: 0 } as unknown as PointerSample]), CircleDetectorError);
  });

  it("throws INVALID_OPTIONS for malformed options", () => {
    const samples = generateHumanCircle({ seed: 1 });
    assert.throws(
      () => analyzeSamples(samples, { sensitivity: "nope" as never }),
      (e: unknown) => e instanceof CircleDetectorError && e.code === "INVALID_OPTIONS",
    );
    assert.throws(() => analyzeSamples(samples, { minSamples: 2 }), CircleDetectorError);
  });

  it("reports which sample index is malformed", () => {
    const samples = generateHumanCircle({ seed: 2 });
    (samples[10] as PointerSample).t = Number.NaN;
    assert.throws(
      () => analyzeSamples(samples),
      (e: unknown) =>
        e instanceof CircleDetectorError &&
        e.code === "INVALID_SAMPLES" &&
        (e.message as string).includes("10"),
    );
  });
});
