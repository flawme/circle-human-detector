import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { analyzeSamples } from "../src/analyze.ts";
import type { PointerSample } from "../src/types.ts";
import { generateHumanCircle } from "./helpers/generators.ts";
import {
  EVASION_SINGLE_SPOOFS,
  generateEvasionAblation,
  generateEvasionCircle,
  generateEvasionFullSynthesis,
  generateEvasionInverseOmega,
  generateEvasionStealthWander,
} from "./helpers/evasion.ts";

/**
 * Evasion attack suite: every generator here is a machine built to
 * DEFEAT the detector, not to represent common practice. The pins
 * record what the engine actually does today, measured in the probe
 * behind these tests. Some pins are containment bounds (0 HUMAN_LIKE);
 * a few are boundary pins that document a measured bypass — they are
 * marked clearly, and an engine improvement that changes those numbers
 * should update the pin and the docs together.
 *
 * See docs/EVALUATION.md ("Evasion attacks") for the methodology and
 * docs/LIMITATIONS.md for what each bypass class means operationally.
 */

const SEEDS = 20;

/** Look up a named spoof generator, failing loudly on a typo. */
function spoofGen(name: string): (seed: number) => readonly PointerSample[] {
  const gen = EVASION_SINGLE_SPOOFS[name];
  assert.ok(gen !== undefined, `unknown evasion spoof: ${name}`);
  return gen;
}

function sweep(
  gen: (seed: number) => readonly PointerSample[],
  sensitivity: "relaxed" | "balanced" | "strict" = "balanced",
): { humanLike: number; suspicious: number; inconclusive: number } {
  const counts = { humanLike: 0, suspicious: 0, inconclusive: 0 };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = analyzeSamples(gen(seed), { sensitivity });
    if (r.classification === "HUMAN_LIKE") counts.humanLike++;
    else if (r.classification === "SUSPICIOUS") counts.suspicious++;
    else counts.inconclusive++;
  }
  return counts;
}

describe("evasion: control", () => {
  it("the human corpus still classifies HUMAN_LIKE", () => {
    const counts = sweep((seed) => generateHumanCircle({ seed }));
    assert.equal(counts.humanLike, SEEDS);
  });
});

describe("evasion: faking one structure never rescues a machine", () => {
  // The design rule under attack: no single metric is trusted. Each
  // generator fakes exactly one human structure on an otherwise
  // machine-like base (constant angular velocity, uniform timer,
  // instant start, exact radius).
  for (const name of [
    "tremorOnly",
    "wobbleOnly",
    "modulationOnly",
    "pressureOnly",
    "timingOnly",
    "smoothNoise",
    "smoothWaypoint",
  ] as const) {
    it(`${name}: 0/${SEEDS} HUMAN_LIKE at balanced`, () => {
      const gen = spoofGen(name);
      const counts = sweep(gen);
      assert.equal(
        counts.humanLike,
        0,
        `faking one structure leaked: ${JSON.stringify(counts)}`,
      );
    });
  }

  it("multiStroke: contained and flagged as MULTIPLE_STROKES", () => {
    const gen = spoofGen("multiStroke");
    const counts = sweep(gen);
    assert.equal(counts.humanLike, 0);
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = analyzeSamples(gen(seed));
      assert.ok(
        r.anomalies.some((a) => a.code === "MULTIPLE_STROKES"),
        `seed ${seed}: MULTIPLE_STROKES not reported`,
      );
    }
  });
});

describe("evasion: the strongest structure-free attack is partially accused", () => {
  // Autocorrelated noise + human-like timestamp jitter + ramps: every
  // "amplitude" structure faked, but no posture dynamics. The
  // machine-steady rotation path of BROADBAND_RADIUS_WANDER now
  // accuses a minority of seeds outright (measured 1/20, seed 3); the
  // rest stay in the gray band: refuse to guess, not accuse without
  // structure.
  const gen = spoofGen("smoothNoiseTimingRamps");

  it("0/20 HUMAN_LIKE at balanced, at most 1/20 accused outright", () => {
    const counts = sweep(gen);
    assert.equal(counts.humanLike, 0);
    assert.ok(
      counts.suspicious <= 1,
      `${counts.suspicious}/20 accused outright (measured 1); update this pin and the docs`,
    );
  });
});

describe("evasion: sloppy geometry with machine dynamics", () => {
  // A deliberately sloppy circle: radius wanders +-12% while angular
  // velocity stays constant on a fixed timer. This attacks the package's
  // core promise: an imperfect circle must not read as human. The
  // coupling signature catches 38/40 seeds across the sweep; the one
  // 20-seed leak (seed 2: narrow-band wander on a uniform timer)
  // still carries the uniform-timestamp signature.
  it("at balanced: at most 1/20 leak, and every leak still carries UNIFORM_TIMESTAMPS", () => {
    let leaks = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = analyzeSamples(
        generateEvasionCircle({ seed, sloppyRadius: true }),
        { sensitivity: "balanced" },
      );
      if (r.classification === "HUMAN_LIKE") {
        leaks++;
        assert.ok(
          r.anomalies.some((a) => a.code === "UNIFORM_TIMESTAMPS"),
          `leaking seed ${seed} lost the uniform-timestamp signature`,
        );
      }
    }
    assert.ok(leaks <= 1, `${leaks}/20 sloppy-geometry seeds leaked (was 4 before BROADBAND_RADIUS_WANDER)`);
  });

  it("at strict: fully contained (0/20 HUMAN_LIKE)", () => {
    const counts = sweep(
      (seed) => generateEvasionCircle({ seed, sloppyRadius: true }),
      "strict",
    );
    assert.equal(counts.humanLike, 0);
  });
});

describe("evasion: radius wander with faked timing is contained by the coupling signature", () => {
  // wander + jitter + ramps was the strongest documented bypass
  // (14/20 and 18/20 at balanced, 12/20 at strict) before the
  // BROADBAND_RADIUS_WANDER signature paired speed-program
  // coherence, mid-band radius wander, and angular-velocity
  // steadiness. The signature fires on the broadband members
  // (38-39 of 40 seeds per variant). What remains is a narrow-band
  // corner: one seed per variant whose component triple sits nearly
  // on top of a corpus human's. Those pins are marked BOUNDARY and
  // documented in docs/EVALUATION.md and docs/LIMITATIONS.md; an
  // engine change that moves them should update the docs together.
  const wanderJitter = (seed: number) =>
    generateEvasionCircle({ seed, sloppyRadius: true, jitterTimestamps: true });
  const wanderJitterRamps = (seed: number) =>
    generateEvasionCircle({
      seed,
      sloppyRadius: true,
      jitterTimestamps: true,
      ramps: true,
    });
  const leaksOver40 = (
    gen: (seed: number) => readonly PointerSample[],
    sensitivity: "relaxed" | "balanced" | "strict" = "balanced",
  ): number => {
    let leaks = 0;
    for (let seed = 1; seed <= 40; seed++) {
      if (analyzeSamples(gen(seed), { sensitivity }).classification === "HUMAN_LIKE") {
        leaks++;
      }
    }
    return leaks;
  };

  it("wander+jitter: contained at balanced (0/20)", () => {
    const counts = sweep(wanderJitter);
    assert.equal(
      counts.humanLike,
      0,
      `bypass returned: ${counts.humanLike}/20; update this pin and the docs`,
    );
  });

  it("wander+jitter+ramps: contained at balanced and strict (0/20)", () => {
    assert.equal(sweep(wanderJitterRamps).humanLike, 0);
    assert.equal(sweep(wanderJitterRamps, "strict").humanLike, 0);
  });

  it("BOUNDARY: exactly one narrow-band corner seed per variant leaks across 40 seeds", () => {
    // Measured: sloppy seed 2, wander+jitter seed 29,
    // wander+jitter+ramps seed 26 — each nearly tied to a corpus human
    // on every signature axis, so no threshold on those axes separates
    // them without firing on the calibration corpus.
    assert.equal(
      leaksOver40((seed) => generateEvasionCircle({ seed, sloppyRadius: true })),
      1,
    );
    assert.equal(leaksOver40(wanderJitter), 1);
    assert.equal(leaksOver40(wanderJitterRamps), 1);
  });
});

describe("evasion: signature-aware counter-attacks", () => {
  // Attacks built AFTER BROADBAND_RADIUS_WANDER shipped, by an
  // attacker who knows exactly what it measures. They quantify what
  // the signature forces the attacker to build. Measured over 40
  // seeds (wider than the 20-seed pins above because these attacks
  // tune a free parameter, and the seed sweep samples its effect).
  const countHumanLike = (
    gen: (seed: number) => readonly PointerSample[],
    sensitivity: "relaxed" | "balanced" | "strict" = "balanced",
  ): number => {
    let n = 0;
    for (let seed = 1; seed <= 40; seed++) {
      if (analyzeSamples(gen(seed), { sensitivity }).classification === "HUMAN_LIKE") {
        n++;
      }
    }
    return n;
  };

  it("stealth wander (walk scaled under the ceiling) stays mostly contained", () => {
    // Shrinking the walk ducks the mid-band ceiling but gives up the
    // fake amplitude the radial metrics were feeding on: the walk can
    // no longer fake speed modulation (NO_SPEED_MODULATION fires on
    // most seeds). No scale restores the pre-patch pass rate.
    assert.ok(countHumanLike(generateEvasionStealthWander) <= 3);
    assert.equal(countHumanLike(generateEvasionStealthWander, "strict"), 0);
  });

  it("inverse-omega decoupling without a modeled speed program is fully contained", () => {
    // The decoupling alone is caught: a ramp envelope is flat across
    // the core region, so the core speed spectrum carries no motor
    // program and the signature fires. Measured 0/40 with ramps only
    // and 0/40 bare.
    const rampsOnly = (seed: number) =>
      generateEvasionCircle({
        seed,
        inverseOmega: true,
        jitterTimestamps: true,
        ramps: true,
      });
    const bare = (seed: number) =>
      generateEvasionCircle({ seed, inverseOmega: true, jitterTimestamps: true });
    assert.equal(countHumanLike(rampsOnly), 0);
    assert.equal(countHumanLike(bare), 0);
  });

  it("BOUNDARY: inverse-omega decoupling with a modeled motor program passes", () => {
    // Adding a 1-2 cycle speed modulation over the core breaks the
    // coupling without giving it back: speed follows the modeled
    // program, angular velocity inherits the walk's smooth variation,
    // and the result scores 0.87-0.98 like the synthesis. This is the
    // documented successor to the wander bypass: evading the coupling
    // signature requires implementing an explicit motor program
    // (jitter + ramps + modulation + inverse kinematics), five of the
    // synthesis's seven components. See docs/LIMITATIONS.md.
    assert.ok(
      countHumanLike(generateEvasionInverseOmega) >= 35,
      "inverse-omega motor-program bypass rate dropped; update this pin and the docs",
    );
  });
});

describe("evasion: attacker-controlled sampling density (regime evasion)", () => {
  // The corpus calibrates every signature at 110-240 samples over
  // 1.1-2.4s sweeps, but the emission rate is the attacker's choice:
  // dtMeanMs on the component machine models a generator emitting at
  // whatever rate it likes. Two regimes, measured (see
  // docs/EVALUATION.md, "Regime evasion"):
  //  - the window BELOW the 46-step gate of BROADBAND_RADIUS_WANDER
  //    (steps 24-45): the signature is off and the core spectrum
  //    falls back to human-looking values, but the confidence floor
  //    and the remaining per-step signatures hold the line.
  //  - the softness zone just above the gate (steps ~46-75): a
  //    bare-minimum core smears the walk's mid-band wander below the
  //    10-per-mille ceiling while confidence clears the floor, so
  //    the contained wander family partially regains its pre-patch
  //    pass rate. The best separating axis (angular-velocity CV
  //    < 0.055) fires on zero of 1869 in-zone coarse humans but sits
  //    0.002 above their measured minimum — no margin, so this is a
  //    documented regime boundary, not a signature.
  const windowCell = { durationMs: 600, dtMeanMs: 14 };
  const softCell = { durationMs: 2000, dtMeanMs: 34 };

  it("window below the signature gate holds: wander family 0/20 at balanced and strict", () => {
    const families = [
      (seed: number) => generateEvasionCircle({ seed, sloppyRadius: true, ...windowCell }),
      (seed: number) =>
        generateEvasionCircle({ seed, sloppyRadius: true, jitterTimestamps: true, ...windowCell }),
      (seed: number) =>
        generateEvasionCircle({
          seed,
          sloppyRadius: true,
          jitterTimestamps: true,
          ramps: true,
          ...windowCell,
        }),
    ];
    for (const gen of families) {
      assert.equal(sweep(gen).humanLike, 0);
      assert.equal(sweep(gen, "strict").humanLike, 0);
    }
  });

  it("window weakens the inverse-omega boundary attack (measured 2/20)", () => {
    const gen = (seed: number) =>
      generateEvasionCircle({
        seed,
        inverseOmega: true,
        jitterTimestamps: true,
        ramps: true,
        modulation: true,
        ...windowCell,
      });
    assert.ok(
      sweep(gen).humanLike <= 4,
      "inverse-omega stopped weakening in the coarse window; update this pin and the docs",
    );
  });

  it("coarse humans in the window are never accused and still pass", () => {
    const gen = (seed: number) => generateHumanCircle({ seed, ...windowCell });
    assert.equal(sweep(gen).suspicious, 0);
    assert.equal(sweep(gen, "strict").suspicious, 0);
    assert.ok(
      sweep(gen).humanLike >= 15,
      "coarse humans stopped passing in the window; update this pin and the docs",
    );
  });

  it("BOUNDARY: the softness zone above the gate partially restores the wander bypass", () => {
    // Measured at steps ~58 (T=2000ms, dt=34ms): 6/20 HUMAN_LIKE at
    // balanced (seeds 4, 5, 11, 17, 18, 19), 2/20 at strict; the
    // signature fires on only 20/40 seeds there vs 37-40/40 at steps
    // 80+. The leak fades to 3/40 by steps 80, 1-2/40 by steps
    // 120-140, and 0/40 at 180. Closing it needs coarse-regime
    // calibration on real humans; on the synthetic corpus every
    // separating leg either fires on humans or has no margin.
    const wanderJitterRampsSoft = (seed: number) =>
      generateEvasionCircle({
        seed,
        sloppyRadius: true,
        jitterTimestamps: true,
        ramps: true,
        ...softCell,
      });
    const wanderJitterSoft = (seed: number) =>
      generateEvasionCircle({ seed, sloppyRadius: true, jitterTimestamps: true, ...softCell });
    assert.ok(
      sweep(wanderJitterRampsSoft).humanLike >= 3,
      "softness-zone wander leak fell below the documented floor; update this pin and the docs",
    );
    assert.ok(sweep(wanderJitterRampsSoft, "strict").humanLike >= 1);
    assert.ok(sweep(wanderJitterSoft).humanLike >= 1);
  });

  it("even in the softness zone the fixed-timer variant stays caught", () => {
    const gen = (seed: number) => generateEvasionCircle({ seed, sloppyRadius: true, ...softCell });
    assert.equal(sweep(gen).humanLike, 0);
  });
});

describe("evasion: full human-dynamics synthesis is the documented limit", () => {
  // BOUNDARY PIN. A generator that synthesizes every measured human
  // structure (tremor, wobble, modulation, ramps, timestamp jitter,
  // pressure) is behaviorally indistinguishable from a human by
  // design: the engine's own human corpus is exactly such a
  // synthesis. docs/LIMITATIONS.md names this as the fundamental
  // limit of local behavioral analysis; the mitigation is outside
  // this library (nonces, single-use challenges, session binding).
  it("full synthesis passes as HUMAN_LIKE (20/20)", () => {
    const counts = sweep((seed) => generateEvasionFullSynthesis(seed));
    assert.equal(counts.humanLike, SEEDS);
  });

  it("removing speed modulation breaks containment (measured 6/20 HUMAN_LIKE)", () => {
    const counts = sweep((seed) => generateEvasionAblation(seed, "noModulation"));
    assert.ok(
      counts.humanLike <= 8,
      `noModulation containment degraded to ${counts.humanLike}/20`,
    );
  });

  it("removing any other single component still passes (the top band is soft)", () => {
    // Measured: noTremor, noWobble, noRamps, noJitter all remain
    // 20/20 HUMAN_LIKE. This documents that a synthesis missing one
    // non-modulation structure is still behaviorally human-consistent
    // under the current metrics. If a future metric makes these
    // components load-bearing, update this pin and the docs.
    for (const ablation of ["noTremor", "noWobble", "noRamps", "noJitter"] as const) {
      const counts = sweep((seed) => generateEvasionAblation(seed, ablation));
      assert.equal(counts.humanLike, SEEDS);
    }
  });
});
