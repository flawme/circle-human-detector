/**
 * Benchmark harness for the detection engine.
 *
 * Runs the engine against a large randomized synthetic corpus and
 * prints a per-class confusion matrix. This validates the engine's
 * behavior on *modeled* humans and generators — it is a regression
 * gate for the detection logic, not a measurement of real-world
 * accuracy (see docs/EVALUATION.md for the methodology and its
 * limits).
 *
 * Usage:
 *   npm run build && node scripts/evaluate.mjs [sensitivity] [trialsPerClass]
 *
 * Exit code 0 when all gates pass, 1 otherwise. Gates:
 *   - human model      : >= 90% HUMAN_LIKE
 *   - parametric/noisy/waypoint: >= 90% SUSPICIOUS, 0% HUMAN_LIKE
 *   - adversarial model: <= 2% HUMAN_LIKE (documented false-negative bound)
 *   - straight line    : 100% INCONCLUSIVE (not a circle)
 *
 * After the gates, an informational physics-law audit is printed
 * (scripts/physics-audit.mts): per-corpus two-thirds power-law slope,
 * signal-dependent-noise exponent, and movement smoothness against
 * published motor-control targets. It validates corpus faithfulness
 * and never affects the exit code.
 */

import { analyzeSamples } from "../dist/esm/index.js";
import {
  generateHumanCircle,
  generateMachineCircle,
  generateStraightLine,
} from "../test/helpers/generators.ts";
import { formatPhysicsAudit, runPhysicsAudit } from "./physics-audit.mts";

const sensitivity = process.argv[2] ?? "balanced";
const trials = Number(process.argv[3] ?? 200);
if (!Number.isInteger(trials) || trials < 1) {
  console.error("trialsPerClass must be a positive integer");
  process.exit(1);
}

/** @typedef {"HUMAN_LIKE"|"SUSPICIOUS"|"INCONCLUSIVE"} Classification */

const classes = {
  human: (seed) => generateHumanCircle({ seed }),
  parametric: (seed) => generateMachineCircle({ seed, variant: "parametric" }),
  noisy: (seed) => generateMachineCircle({ seed, variant: "noisy" }),
  waypoint: (seed) => generateMachineCircle({ seed, variant: "waypoint" }),
  adversarial: (seed) => generateMachineCircle({ seed, variant: "adversarial" }),
  "straight-line": () => generateStraightLine(120),
};

/** @type {Map<string, Record<string, number>>} */
const tally = new Map();
const scoreStats = new Map();

for (const [name, generator] of Object.entries(classes)) {
  /** @type {Record<string, number>} */
  const counts = { HUMAN_LIKE: 0, SUSPICIOUS: 0, INCONCLUSIVE: 0 };
  let scoreSum = 0;
  let confSum = 0;
  for (let seed = 1; seed <= trials; seed++) {
    const result = analyzeSamples(generator(seed), { sensitivity });
    counts[result.classification] = (counts[result.classification] ?? 0) + 1;
    scoreSum += result.score;
    confSum += result.confidence;
  }
  tally.set(name, counts);
  scoreStats.set(name, {
    meanScore: scoreSum / trials,
    meanConfidence: confSum / trials,
  });
}

const pct = (n) => `${((100 * n) / trials).toFixed(1)}%`;

console.log(`\ncircle-human-detector evaluation`);
console.log(`sensitivity=${sensitivity}  trials/class=${trials}\n`);
const header = "class".padEnd(14) + "HUMAN_LIKE".padEnd(14) + "SUSPICIOUS".padEnd(14) + "INCONCLUSIVE".padEnd(14) + "mean score".padEnd(13) + "mean conf";
console.log(header);
console.log("-".repeat(header.length));
for (const [name, counts] of tally) {
  const stats = scoreStats.get(name);
  console.log(
    name.padEnd(14) +
      `${pct(counts.HUMAN_LIKE ?? 0)}`.padEnd(14) +
      `${pct(counts.SUSPICIOUS ?? 0)}`.padEnd(14) +
      `${pct(counts.INCONCLUSIVE ?? 0)}`.padEnd(14) +
      stats.meanScore.toFixed(3).padEnd(13) +
      stats.meanConfidence.toFixed(3),
  );
}

/** @param {string} name @returns {number} */
const humanLikeOf = (name) => (tally.get(name)?.HUMAN_LIKE ?? 0) / trials;
/** @param {string} name @returns {number} */
const suspiciousOf = (name) => (tally.get(name)?.SUSPICIOUS ?? 0) / trials;

const gates = [
  {
    label: "human model classified HUMAN_LIKE >= 90%",
    pass: humanLikeOf("human") >= 0.9,
  },
  {
    label: "parametric classified SUSPICIOUS >= 90%",
    pass: suspiciousOf("parametric") >= 0.9 && humanLikeOf("parametric") === 0,
  },
  {
    label: "noisy classified SUSPICIOUS >= 90%",
    pass: suspiciousOf("noisy") >= 0.9 && humanLikeOf("noisy") === 0,
  },
  {
    label: "waypoint classified SUSPICIOUS >= 90%",
    pass: suspiciousOf("waypoint") >= 0.9 && humanLikeOf("waypoint") === 0,
  },
  {
    label: "adversarial accepted as HUMAN_LIKE <= 2%",
    pass: humanLikeOf("adversarial") <= 0.02,
  },
  {
    label: "straight line INCONCLUSIVE 100%",
    pass: (tally.get("straight-line")?.INCONCLUSIVE ?? 0) / trials === 1,
  },
];

console.log("");
let allPass = true;
for (const gate of gates) {
  const mark = gate.pass ? "PASS" : "FAIL";
  if (!gate.pass) allPass = false;
  console.log(`  [${mark}] ${gate.label}`);
}

console.log(
  allPass
    ? "\nall gates passed"
    : "\ngates failed — engine regression or threshold drift",
);

// Informational physics-law audit (corpus faithfulness; never gates).
console.log("\n" + formatPhysicsAudit(runPhysicsAudit()));

process.exit(allPass ? 0 : 1);
