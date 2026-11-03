import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clamp,
  countUnique,
  curve,
  cv,
  lag1Autocorr,
  mean,
  median,
  ramp,
  std,
} from "../src/engine/stats.ts";

describe("mean/std/cv", () => {
  it("computes the arithmetic mean", () => {
    assert.equal(mean([1, 2, 3]), 2);
    assert.equal(mean([]), 0);
    assert.equal(mean([-2, 2]), 0);
  });

  it("computes sample standard deviation with n-1 denominator", () => {
    assert.equal(std([1, 3]), Math.sqrt(2));
    assert.equal(std([5, 5, 5]), 0);
    assert.equal(std([]), 0);
    assert.equal(std([1]), 0);
  });

  it("computes coefficient of variation safely", () => {
    assert.equal(cv([2, 2, 2]), 0);
    assert.ok(Math.abs(cv([1, 3]) - Math.sqrt(2) / 2) < 1e-12);
    assert.equal(cv([]), 0);
  });

  it("computes the median", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
  });
});

describe("clamp/ramp/curve", () => {
  it("clamps into range", () => {
    assert.equal(clamp(5, 0, 1), 1);
    assert.equal(clamp(-5, 0, 1), 0);
    assert.equal(clamp(0.5, 0, 1), 0.5);
  });

  it("ramps linearly between anchors", () => {
    assert.equal(ramp(-1, 0, 1), 0);
    assert.equal(ramp(2, 0, 1), 1);
    assert.equal(ramp(0.25, 0, 1), 0.25);
  });

  it("interpolates piecewise-linear curves and clamps outside anchors", () => {
    const anchors: readonly (readonly [number, number])[] = [
      [0, 0],
      [1, 1],
      [2, 0],
    ];
    assert.equal(curve(0.5, anchors), 0.5);
    assert.equal(curve(1.5, anchors), 0.5);
    assert.equal(curve(-1, anchors), 0);
    assert.equal(curve(3, anchors), 0);
    assert.equal(curve(1, anchors), 1);
  });
});

describe("lag1Autocorr", () => {
  it("is high for smooth increasing series", () => {
    const series = Array.from({ length: 20 }, (_, i) => i);
    // Exact lag-1 autocorrelation of a 20-point ramp is ~0.85.
    assert.ok(lag1Autocorr(series) > 0.8, `got ${lag1Autocorr(series)}`);
  });

  it("is near -1 for alternating series", () => {
    const series = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    assert.ok(lag1Autocorr(series) < -0.9);
  });

  it("is 0 for constant or short series", () => {
    assert.equal(lag1Autocorr([3, 3, 3, 3]), 0);
    assert.equal(lag1Autocorr([1, 2]), 0);
    assert.equal(lag1Autocorr([]), 0);
  });
});

describe("countUnique", () => {
  it("merges values within tolerance", () => {
    assert.equal(countUnique([1, 1.0001, 2], 1e-3, 0.01), 2);
    assert.equal(countUnique([1, 2], 1e-3, 0.01), 2);
    assert.equal(countUnique([1, 1, 1], 1e-3, 0.01), 1);
    assert.equal(countUnique([], 1e-3, 0.01), 0);
  });

  it("uses relative tolerance for large values", () => {
    assert.equal(countUnique([1000, 1001], 1e-3, 0.01), 1);
    assert.equal(countUnique([1000, 1020], 1e-3, 0.01), 2);
  });
});
