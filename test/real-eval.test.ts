import test from "node:test";
import assert from "node:assert/strict";

import { generateHumanCircle, generateMachineCircle } from "./helpers/generators.ts";
import {
  evaluateCaptures,
  formatRealEvalReport,
  parseCaptureFiles,
} from "../scripts/evaluate-real.mts";

/**
 * Pins for the real-capture evaluation flow (examples/browser/collect.html
 * -> scripts/evaluate-real.mts). Everything here is in-memory: no
 * filesystem, no clock. The exported aggregation is what the CLI wraps,
 * so these pins cover consent enforcement, data-quality rejection,
 * matrix math, and the physics-audit wiring without touching a disk.
 */

function humanRaw(seed: number, label = "human"): unknown {
  return {
    label,
    consent: true,
    capturedAt: "2026-01-01T00:00:00.000Z",
    samples: generateHumanCircle({ seed }),
  };
}

function machineRaw(seed: number, label = "machine"): unknown {
  return {
    label,
    consent: true,
    samples: generateMachineCircle({ seed, variant: "parametric" }),
  };
}

/** The standard eight-file set: 4 human captures + 4 machine captures. */
function standardFiles(): { name: string; raw: unknown }[] {
  const files: { name: string; raw: unknown }[] = [];
  for (let seed = 1; seed <= 4; seed++) {
    files.push({ name: `human-${seed}.json`, raw: humanRaw(seed) });
    files.push({ name: `machine-${seed}.json`, raw: machineRaw(seed) });
  }
  return files;
}

test("real-eval: parses valid capture files into labeled entries", () => {
  const { entries, warnings } = parseCaptureFiles(standardFiles());
  assert.equal(warnings.length, 0);
  assert.equal(entries.length, 8);

  const first = entries[0]!;
  assert.equal(first.label, "human");
  assert.equal(first.consent, true);
  assert.equal(first.capturedAt, "2026-01-01T00:00:00.000Z");
  assert.ok(first.samples.length >= 24, "human capture must be analyzable");
  const s = first.samples[0]!;
  assert.equal(typeof s.x, "number");
  assert.equal(typeof s.y, "number");
  assert.equal(typeof s.t, "number");

  // Labels are trimmed so " human " groups with "human".
  const { entries: trimmed } = parseCaptureFiles([
    { name: "padded.json", raw: { label: "  human  ", consent: true, samples: generateHumanCircle({ seed: 7 }) } },
  ]);
  assert.equal(trimmed[0]!.label, "human");
});

test("real-eval: balanced confusion matrices are pinned", () => {
  const { entries } = parseCaptureFiles(standardFiles());
  const report = evaluateCaptures(entries);

  assert.deepEqual(
    report.presets.map((p) => p.sensitivity),
    ["relaxed", "balanced", "strict"],
  );

  const balanced = report.presets[1]!;
  assert.equal(balanced.sensitivity, "balanced");
  assert.deepEqual(
    balanced.matrices.map((m) => m.label),
    ["human", "machine"],
  );

  const human = balanced.matrices[0]!;
  assert.equal(human.total, 4);
  assert.equal(human.humanLike, 4);
  assert.equal(human.suspicious, 0);
  assert.equal(human.inconclusive, 0);
  assert.equal(human.meanScore.toFixed(3), "0.960");
  assert.equal(human.meanConfidence.toFixed(3), "0.699");

  const machine = balanced.matrices[1]!;
  assert.equal(machine.total, 4);
  assert.equal(machine.humanLike, 0);
  assert.equal(machine.suspicious, 4);
  assert.equal(machine.inconclusive, 0);
  assert.equal(machine.meanScore.toFixed(3), "0.000");
});

test("real-eval: human captures stay HUMAN_LIKE at every preset", () => {
  const { entries } = parseCaptureFiles(standardFiles());
  const report = evaluateCaptures(entries);
  for (const preset of report.presets) {
    const human = preset.matrices.find((m) => m.label === "human");
    const machine = preset.matrices.find((m) => m.label === "machine");
    assert.ok(human, `human matrix present at ${preset.sensitivity}`);
    assert.ok(machine, `machine matrix present at ${preset.sensitivity}`);
    assert.equal(human!.humanLike, 4, `${preset.sensitivity}: humans HUMAN_LIKE`);
    assert.equal(human!.suspicious, 0, `${preset.sensitivity}: no human SUSPICIOUS`);
    assert.equal(machine!.suspicious, 4, `${preset.sensitivity}: machines SUSPICIOUS`);
    assert.equal(machine!.humanLike, 0, `${preset.sensitivity}: no machine HUMAN_LIKE`);
  }
});

test("real-eval: consent is a precondition of analysis, with no override", () => {
  const files = [
    { name: "ok.json", raw: humanRaw(1) },
    {
      name: "no-consent.json",
      raw: { label: "human", consent: false, samples: generateHumanCircle({ seed: 9 }) },
    },
    {
      name: "string-consent.json",
      raw: { label: "human", consent: "true", samples: generateHumanCircle({ seed: 10 }) },
    },
  ];
  const { entries, warnings } = parseCaptureFiles(files);
  assert.equal(entries.length, 1, "only the consented capture survives");
  assert.equal(warnings.length, 2);
  for (const w of warnings) {
    assert.match(w.reason, /consent is not true/);
  }
});

test("real-eval: one malformed sample rejects the whole entry", () => {
  const raw = humanRaw(5) as { samples: { x: unknown }[] };
  raw.samples[3]!.x = "oops";
  const { entries, warnings } = parseCaptureFiles([{ name: "broken.json", raw }]);
  assert.equal(entries.length, 0, "no partial entries");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.reason, /sample 3 is not a valid PointerSample/);
});

test("real-eval: empty samples, empty label, and non-objects are rejected", () => {
  const { entries, warnings } = parseCaptureFiles([
    { name: "empty-samples.json", raw: { label: "human", consent: true, samples: [] } },
    { name: "no-label.json", raw: { consent: true, samples: generateHumanCircle({ seed: 11 }) } },
    { name: "blank-label.json", raw: { label: "   ", consent: true, samples: generateHumanCircle({ seed: 12 }) } },
    { name: "not-object.json", raw: [1, 2, 3] },
  ]);
  assert.equal(entries.length, 0);
  assert.equal(warnings.length, 4);
  assert.match(warnings[0]!.reason, /no samples/);
  assert.match(warnings[1]!.reason, /label/);
  assert.match(warnings[2]!.reason, /label/);
  assert.match(warnings[3]!.reason, /not a JSON object/);
});

test("real-eval: optional sample fields survive parsing, unknown fields are dropped", () => {
  const raw = {
    label: "human",
    consent: true,
    samples: [
      { x: 1, y: 2, t: 3, pointerType: "mouse", pressure: 0.5, width: 3, stroke: 0, junk: "drop me" },
      { x: 4, y: 5, t: 6, stroke: 1, pressure: Number.NaN },
    ],
  };
  const { entries, warnings } = parseCaptureFiles([{ name: "opts.json", raw }]);
  assert.equal(warnings.length, 0);
  const first = entries[0]!.samples[0]!;
  assert.equal(first.pointerType, "mouse");
  assert.equal(first.pressure, 0.5);
  assert.equal(first.width, 3);
  assert.equal(first.stroke, 0);
  assert.equal("junk" in first, false, "unknown fields must not reach the engine");
  const second = entries[0]!.samples[1]!;
  assert.equal(second.stroke, 1);
  assert.equal(second.pressure, undefined, "non-finite pressure is dropped, not stored");
});

test("real-eval: physics audit runs the corpus instruments over human captures", () => {
  const { entries } = parseCaptureFiles(standardFiles());
  const { physics } = evaluateCaptures(entries);

  assert.equal(physics.humanLabel, "human");
  assert.equal(physics.humanCaptures, 4);
  assert.equal(physics.measured, 4);
  for (const stats of [physics.slopeRaw, physics.slopeW5, physics.slopeW15, physics.sdnBeta, physics.ldlj]) {
    assert.equal(stats.measured, 4);
    assert.ok(Number.isFinite(stats.p50), "p50 must be finite for a measured instrument");
  }
  // Deterministic for seeds 1-4; pins the measureCorpus conventions
  // (raw/w5/w15 slopes, SDN beta, LDLJ) reaching the report.
  assert.equal(physics.slopeRaw.p50.toFixed(2), "-0.06");
  assert.equal(physics.slopeW5.p50.toFixed(2), "-0.29");
  assert.equal(physics.slopeW15.p50.toFixed(2), "-0.49");
  assert.equal(physics.sdnBeta.p50.toFixed(2), "0.36");
  assert.equal(physics.ldlj.p50.toFixed(2), "-7.87");
});

test("real-eval: physics follows the configured human label only", () => {
  const files = [
    { name: "real-1.json", raw: humanRaw(1, "real-person") },
    { name: "real-2.json", raw: humanRaw(2, "real-person") },
    { name: "bot.json", raw: machineRaw(1) },
  ];
  const { entries } = parseCaptureFiles(files);

  const custom = evaluateCaptures(entries, { humanLabel: "real-person" });
  assert.equal(custom.physics.humanCaptures, 2);
  assert.equal(custom.physics.measured, 2);

  const byDefault = evaluateCaptures(entries);
  assert.equal(byDefault.physics.humanCaptures, 0, "label 'human' matches nothing here");
  assert.equal(byDefault.physics.measured, 0);
  assert.ok(Number.isNaN(byDefault.physics.slopeW15.p50));
});

test("real-eval: empty input produces an explicit empty report", () => {
  const report = evaluateCaptures([]);
  assert.equal(report.totalCaptures, 0);
  assert.equal(report.presets.length, 3);
  for (const preset of report.presets) {
    assert.equal(preset.matrices.length, 0);
  }
  assert.equal(report.physics.humanCaptures, 0);

  const text = formatRealEvalReport(report);
  assert.match(text, /no valid captures/);
  assert.equal(text.includes("Preset relaxed:"), true);
});

test("real-eval: report renders warnings, matrices, and the physics section", () => {
  const { entries } = parseCaptureFiles(standardFiles());
  const report = evaluateCaptures(entries);
  const text = formatRealEvalReport(report, [
    { file: "no-consent.json", reason: "consent is not true — refusing to analyze (no override exists)" },
  ]);

  assert.match(text, /report only/);
  assert.match(text, /Valid captures: 8; skipped files: 1\./);
  assert.match(text, /no-consent\.json: consent is not true/);
  assert.match(text, /Preset balanced:/);
  assert.match(text, /human\s+4\s+4\s+0\s+0\s+0\.960/);
  assert.match(text, /machine\s+4\s+0\s+4\s+0\s+0\.000/);
  assert.match(text, /Physics-law audit over captures labeled "human"/);
  assert.match(text, /-7\.87/);
  assert.match(text, /Do not publish accuracy\s+claims from the synthetic corpus alone\./);
});
