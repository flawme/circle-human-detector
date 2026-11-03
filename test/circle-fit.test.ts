import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fitCircle } from "../src/engine/circle-fit.ts";

function circlePoints(
  cx: number,
  cy: number,
  r: number,
  n: number,
): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

describe("fitCircle", () => {
  it("recovers a perfect circle to machine precision", () => {
    const fit = fitCircle(circlePoints(310, -50, 137, 100));
    assert.equal(fit.ok, true);
    assert.ok(Math.abs(fit.cx - 310) < 1e-6);
    assert.ok(Math.abs(fit.cy - -50) < 1e-6);
    assert.ok(Math.abs(fit.r - 137) < 1e-6);
    assert.ok(fit.rmsError < 1e-10);
  });

  it("recovers a noisy circle approximately", () => {
    const pts = circlePoints(50, 80, 120, 200).map((p, i) => ({
      x: p.x + Math.sin(i * 12.9898) * 2,
      y: p.y + Math.cos(i * 78.233) * 2,
    }));
    const fit = fitCircle(pts);
    assert.equal(fit.ok, true);
    assert.ok(Math.abs(fit.cx - 50) < 3);
    assert.ok(Math.abs(fit.cy - 80) < 3);
    assert.ok(Math.abs(fit.r - 120) / 120 < 0.03);
    assert.ok(fit.rmsError > 0 && fit.rmsError < 0.05);
  });

  it("rejects fewer than 3 points", () => {
    assert.equal(fitCircle([]).ok, false);
    assert.equal(fitCircle([{ x: 0, y: 0 }]).ok, false);
    assert.equal(
      fitCircle([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]).ok,
      false,
    );
  });

  it("rejects collinear points", () => {
    const line = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 2 * i }));
    assert.equal(fitCircle(line).ok, false);
  });

  it("rejects coincident points", () => {
    const same = Array.from({ length: 5 }, () => ({ x: 7, y: 9 }));
    assert.equal(fitCircle(same).ok, false);
  });
});
