import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeKinematics,
  directionChangeCount,
  findPauses,
  longestCollinearRun,
  longestConstantRun,
  principalAngle,
  speedModulation,
  smoothSeries,
  unwrapAngles,
} from "../src/engine/kinematics.ts";

const TAU = 2 * Math.PI;

describe("principalAngle", () => {
  it("keeps small values unchanged", () => {
    assert.ok(Math.abs(principalAngle(0.1) - 0.1) < 1e-12);
    assert.ok(Math.abs(principalAngle(-0.1) + 0.1) < 1e-12);
  });

  it("wraps values beyond pi into (-pi, pi]", () => {
    assert.ok(Math.abs(principalAngle(3.5) - (3.5 - TAU)) < 1e-12);
    assert.ok(Math.abs(principalAngle(-Math.PI - 0.1) - (Math.PI - 0.1)) < 1e-12);
    assert.ok(Math.abs(principalAngle(TAU + 0.2) - 0.2) < 1e-12);
  });
});

describe("unwrapAngles", () => {
  it("accumulates across the branch cut for increasing sweeps", () => {
    // 3.0 -> 3.3 is a normal step; 3.3 -> 0.1 crosses +pi and must
    // continue upward: principal(0.1 - 3.3) = -3.2 + 2*pi = 3.0832.
    const unwrapped = unwrapAngles([3.0, 3.3, 0.1]);
    assert.ok(Math.abs((unwrapped[0] as number) - 3.0) < 1e-12);
    assert.ok(Math.abs((unwrapped[1] as number) - 3.3) < 1e-12);
    assert.ok(
      Math.abs((unwrapped[2] as number) - (3.3 + (0.1 - 3.3 + 2 * Math.PI))) < 1e-9,
    );
  });

  it("treats a backward jump across the cut as a small negative step", () => {
    const unwrapped = unwrapAngles([0.1, 6.2]);
    // principal(6.2 - 0.1) = 6.1 - 2*pi = -0.1832: a backward step.
    assert.ok(Math.abs((unwrapped[1] as number) - (0.1 + (6.1 - 2 * Math.PI))) < 1e-9);
  });

  it("returns input when no wrapping is needed", () => {
    assert.deepEqual(unwrapAngles([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]);
  });
});

describe("computeKinematics", () => {
  it("computes exact kinematics for uniform circular motion", () => {
    const r = 10;
    const points = [0, 1, 2, 3].map((i) => {
      const a = (TAU * i) / 4;
      return { x: r * Math.cos(a), y: r * Math.sin(a) };
    });
    const times = [0, 1, 2, 3];
    const kin = computeKinematics(points, times, 0, 0);

    assert.equal(kin.dt.length, 3);
    assert.equal(kin.speed.length, 3);
    assert.equal(kin.omega.length, 3);
    assert.equal(kin.accel.length, 2);

    const chord = r * Math.SQRT2;
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs((kin.dt[i] as number) - 1) < 1e-12);
      assert.ok(Math.abs((kin.chord[i] as number) - chord) < 1e-9);
      assert.ok(Math.abs((kin.speed[i] as number) - chord) < 1e-9);
      assert.ok(Math.abs((kin.dAngle[i] as number) - TAU / 4) < 1e-12);
      assert.ok(Math.abs((kin.omega[i] as number) - TAU / 4) < 1e-12);
    }
    // Constant speed means zero acceleration.
    assert.ok(kin.accel.every((a) => Math.abs(a) < 1e-9));
  });

  it("treats identical timestamps with a floor instead of dividing by zero", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
    const kin = computeKinematics(points, [5, 5, 6], 0, 0);
    assert.ok(Number.isFinite(kin.speed[0] as number));
    assert.ok((kin.speed[0] as number) > 0);
  });
});

describe("findPauses", () => {
  it("flags gaps above the threshold and median multiple", () => {
    const flags = findPauses([10, 10, 200, 10], 120);
    assert.deepEqual(flags, [false, false, true, false]);
  });

  it("does not flag uniformly slow capture as pauses", () => {
    assert.deepEqual(findPauses([150, 150, 150], 120), [false, false, false]);
  });
});

describe("smoothSeries", () => {
  it("leaves constant series unchanged", () => {
    assert.deepEqual(smoothSeries([1, 1, 1], 3), [1, 1, 1]);
  });

  it("spreads impulses with edge shrink", () => {
    const out = smoothSeries([0, 3, 0], 3);
    assert.ok(Math.abs((out[0] as number) - 1.5) < 1e-12);
    assert.ok(Math.abs((out[1] as number) - 1) < 1e-12);
    assert.ok(Math.abs((out[2] as number) - 1.5) < 1e-12);
  });
});

describe("longestCollinearRun", () => {
  it("counts equal-step collinear triples", () => {
    const pts = Array.from({ length: 6 }, (_, i) => ({ x: i, y: 0 }));
    // 6 points => 4 interior triples, all collinear with equal steps.
    assert.equal(longestCollinearRun(pts), 4);
  });

  it("requires equal step lengths, not just collinearity", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 5, y: 0 },
      { x: 6, y: 0 },
    ];
    assert.equal(longestCollinearRun(pts), 0);
  });

  it("returns 0 for dense circular arcs", () => {
    const pts = Array.from({ length: 50 }, (_, i) => {
      const a = (TAU * i) / 50;
      return { x: 100 * Math.cos(a), y: 100 * Math.sin(a) };
    });
    assert.equal(longestCollinearRun(pts), 0);
  });
});

describe("longestConstantRun", () => {
  it("finds the longest identical run", () => {
    assert.equal(longestConstantRun([5, 5, 5, 6, 5], 1e-9), 2);
    assert.equal(longestConstantRun([1, 1.0000000001, 1], 1e-9), 2);
    assert.equal(longestConstantRun([1, 2, 3], 1e-9), 0);
    assert.equal(longestConstantRun([4], 1e-9), 0);
  });
});

describe("directionChangeCount", () => {
  it("counts genuine reversals only", () => {
    assert.equal(directionChangeCount([0.1, 0.1, -0.2, 0.1]), 2);
  });

  it("ignores noise-level sign flips", () => {
    assert.equal(directionChangeCount([0.1, -0.001, 0.1]), 0);
  });

  it("returns 0 for monotone sweeps", () => {
    const d = Array.from({ length: 50 }, () => 0.12);
    assert.equal(directionChangeCount(d), 0);
  });
});

describe("speedModulation", () => {
  it("captures systematic speed variation with angle", () => {
    const n = 120;
    const angle: number[] = [];
    const speed: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = i / n;
      angle.push(s * TAU);
      speed.push(1 + 0.6 * Math.sin(s * TAU));
    }
    // Harmonic projection recovers ~the sinusoid amplitude.
    const m = speedModulation(angle, speed);
    assert.ok(m > 0.5, `expected > 0.5, got ${m}`);
    assert.ok(m < 0.7, `expected < 0.7, got ${m}`);
  });

  it("is 0 for constant speed", () => {
    const n = 60;
    const angle = Array.from({ length: n }, (_, i) => (i / n) * TAU);
    const speed = Array.from({ length: n }, () => 3.5);
    assert.equal(speedModulation(angle, speed), 0);
  });

  it("does not credit noise spread as modulation", () => {
    const n = 120;
    const angle: number[] = [];
    const speed: number[] = [];
    for (let i = 0; i < n; i++) {
      angle.push((i / n) * TAU);
      // Alternating high-frequency noise uncorrelated with angle.
      speed.push(1 + (i % 2 === 0 ? 0.5 : -0.5));
    }
    // Alternating per-sample noise lands in the highest harmonics, not
    // in the 1-3 cycle projection the metric reads.
    assert.ok(speedModulation(angle, speed) < 0.2);
  });
});
