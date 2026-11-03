import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  generateHumanCircle,
  generateStraightLine,
} from "./helpers/generators.ts";
import {
  runPhysicsAudit,
  quantileOf,
  coreSeries,
  ldlj,
  type CorpusResult,
} from "../scripts/physics-audit.mts";

/**
 * Physics-law audit pins. The three findings printed by
 * `npm run evaluate` and claimed in docs/EVALUATION.md are measured
 * facts about the corpora, pinned here so corpus or instrument drift
 * moves them visibly. These are NOT detection tests — no engine code
 * is exercised. One deterministic sweep (same seeds and sizes the
 * printed audit uses) is shared by every assertion.
 */
describe("physics-law audit: documented findings are pinned", () => {
  const audit = runPhysicsAudit();
  const by = (name: string): CorpusResult => {
    const hit = audit.find((a) => a.name === name);
    assert.ok(hit, `physics audit: corpus ${name} missing`);
    return hit.result;
  };
  const sorted = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);
  const q = (xs: readonly number[], p: number): number => quantileOf(sorted(xs), p);

  const human = by("human");
  const attack = by("invomega-prog");
  const noMod = by("abl-noModulation");

  it("measures the full calibration corpus (no silent skips)", () => {
    assert.equal(human.measured, human.total);
  });

  it("two-thirds power law: the inverse-omega attack sits inside the human slope range (no separation)", () => {
    // Measured: attack median -0.38, human 15pt range [-0.96, -0.22].
    // The strongest smoothing convention is the best case for a
    // hypothetical separator, and the attack still sits inside.
    const attackP50 = q(attack.slopeW15, 0.5);
    const humanP05 = q(human.slopeW15, 0.05);
    const humanP95 = q(human.slopeW15, 0.95);
    assert.ok(
      attackP50 > humanP05 && attackP50 < humanP95,
      `attack slope ${attackP50.toFixed(2)} should lie inside the human range ` +
        `[${humanP05.toFixed(2)}, ${humanP95.toFixed(2)}] — the law is falsified as a separator otherwise`,
    );
  });

  it("the corpus human's apparent power-law slope is phase alignment, not motor coupling", () => {
    // Removing the speed modulation alone collapses the slope toward
    // zero: the apparent coupling was between two independent
    // processes, not speed responding to curvature.
    const noModP50 = q(noMod.slopeW15, 0.5);
    assert.ok(
      Math.abs(noModP50) < 0.1,
      `noModulation slope ${noModP50.toFixed(2)} should collapse toward 0`,
    );
    // The human slope is also convention-unstable (raw vs 15pt medians
    // differ widely) — a real motor law is convention-stable.
    const rawP50 = q(human.slopeRaw, 0.5);
    const w15P50 = q(human.slopeW15, 0.5);
    assert.ok(
      Math.abs(rawP50 - w15P50) > 0.3,
      `human slope should be convention-unstable (raw ${rawP50.toFixed(2)} vs 15pt ${w15P50.toFixed(2)})`,
    );
  });

  it("signal-dependent noise is not modeled: human SDN beta ~ 0, not the Harris-Wolpert ~2", () => {
    const betaP50 = q(human.sdnBeta, 0.5);
    assert.ok(
      Math.abs(betaP50) < 0.5,
      `human SDN beta ${betaP50.toFixed(2)} should be ~0 (additive noise, not signal-dependent)`,
    );
    assert.ok(
      betaP50 < 1.0,
      "human SDN beta should sit far below the Harris-Wolpert target of ~2",
    );
  });

  it("smoothness separates the inverse-omega attack at the median, but the tails overlap", () => {
    // Measured: attack median -8.88 vs human median -7.86 (the attack
    // is smoother), quartiles disjoint — yet human min -8.72 < attack
    // max -8.52, so a smoothness floor cannot be calibrated to zero
    // false positives even before the accessibility objection (which
    // is why the channel is documented, never shipped).
    const attackP50 = q(attack.ldlj, 0.5);
    const humanP50 = q(human.ldlj, 0.5);
    assert.ok(
      attackP50 < humanP50 - 0.5,
      `attack median ${attackP50.toFixed(2)} should be at least 0.5 smoother than human ${humanP50.toFixed(2)}`,
    );
    const humanMin = sorted(human.ldlj)[0]!;
    const attackMax = sorted(attack.ldlj).at(-1)!;
    assert.ok(
      humanMin < attackMax,
      `tails should overlap: human min ${humanMin.toFixed(2)} < attack max ${attackMax.toFixed(2)}`,
    );
  });

  it("instruments skip degenerate series instead of crashing", () => {
    // Straight line: every triple collinear -> no curvature -> null,
    // never a NaN slope.
    assert.equal(coreSeries(generateStraightLine(120)), null);
    // LDLJ is finite on a real human sample.
    const lj = ldlj(generateHumanCircle({ seed: 1 }));
    assert.ok(typeof lj === "number" && Number.isFinite(lj));
  });
});
