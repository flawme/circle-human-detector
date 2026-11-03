/**
 * Real-capture evaluation: a folder of labeled capture files in, per
 * preset confusion matrices plus a physics-law audit out.
 *
 * Companion to `examples/browser/collect.html`, which exports capture
 * files of this shape (see the page header for the exact contract):
 *
 *   {
 *     "label": "human",
 *     "consent": true,
 *     "capturedAt": "2026-01-01T00:00:00.000Z",
 *     "samples": [{ "x": 240, "y": 100, "t": 123.4, "stroke": 0, ... }]
 *   }
 *
 * Usage:
 *
 *   npm run evaluate:real -- <captures-folder>
 *
 * Behavior:
 * - Consent is a precondition of analysis. Files whose `consent` is
 *   not exactly `true` are skipped with a warning; there is no flag to
 *   override this, on purpose (see docs/LIMITATIONS.md, privacy).
 * - Every preset (relaxed / balanced / strict) classifies every valid
 *   capture via `analyzeSamples`; results are per-label confusion
 *   matrices with mean score and confidence.
 * - Captures labeled `human` (configurable via the aggregation's
 *   `humanLabel` option) additionally run the physics-law audit
 *   instruments from `scripts/physics-audit.mts` — the 2/3 power-law
 *   slope, the SDN exponent, and LDLJ smoothness — against the
 *   published targets, mirroring `measureCorpus` conventions exactly.
 *
 * This tool is REPORT-ONLY: it never gates and never tunes. It exists
 * so threshold changes can be calibrated against real captures rather
 * than the synthetic corpus alone; do not publish accuracy claims
 * from the synthetic corpus by itself.
 *
 * The engine is imported from `src` (not `dist`) so this module and its
 * tests run without a build step; `src` is type-stripping-safe and is
 * typechecked alongside this file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { analyzeSamples } from "../src/engine/analyze.ts";
import type { Classification, PointerSample, Sensitivity } from "../src/types.ts";
import {
  coreSeries,
  ldlj,
  powerLawSlope,
  quantileOf,
  sdnExponent,
} from "./physics-audit.mts";

// ---------------------------------------------------------------- types

/** One validated capture file. `consent` is `true` by construction:
 *  the parser refuses everything else. */
export interface LabeledCapture {
  /** Free-text label, e.g. `"human"` or `"machine"`. */
  label: string;
  /** Always `true`; enforced by `parseCaptureFiles`. */
  consent: true;
  /** ISO timestamp when present in the file. */
  capturedAt?: string;
  /** Recorded pointer samples in capture order. */
  samples: PointerSample[];
}

/** Why one file was excluded from the analysis. */
export interface CaptureWarning {
  file: string;
  reason: string;
}

/** Classification tally for one label under one preset. */
export interface LabelMatrix {
  label: string;
  total: number;
  humanLike: number;
  suspicious: number;
  inconclusive: number;
  /** Mean `score` over the label's captures (0 when none). */
  meanScore: number;
  /** Mean `confidence` over the label's captures (0 when none). */
  meanConfidence: number;
}

/** All labels' matrices under one sensitivity preset. */
export interface PresetReport {
  sensitivity: Sensitivity;
  matrices: LabelMatrix[];
}

/** Percentile summary of one physics instrument. `NaN` when nothing
 *  was measurable (degenerate geometry or too few core points). */
export interface InstrumentStats {
  measured: number;
  p05: number;
  p50: number;
  p95: number;
}

/** Physics-law audit over the human-labeled captures. */
export interface PhysicsSummary {
  /** Label treated as human; `"human"` unless configured otherwise. */
  humanLabel: string;
  /** Captures carrying that label. */
  humanCaptures: number;
  /** Captures with a usable kinematic core (time-core 15-85%). */
  measured: number;
  slopeRaw: InstrumentStats;
  slopeW5: InstrumentStats;
  slopeW15: InstrumentStats;
  sdnBeta: InstrumentStats;
  ldlj: InstrumentStats;
}

/** Full result of aggregating a capture set. */
export interface RealEvalReport {
  /** Number of valid (consented, well-formed) captures analyzed. */
  totalCaptures: number;
  /** Relaxed, balanced, strict — in that order. */
  presets: PresetReport[];
  physics: PhysicsSummary;
}

/** Output of parsing raw capture files: entries plus skip reasons. */
export interface CaptureParseResult {
  entries: LabeledCapture[];
  warnings: CaptureWarning[];
}

const PRESETS: readonly Sensitivity[] = ["relaxed", "balanced", "strict"];

// -------------------------------------------------------------- parsing

type ParseOutcome =
  | { ok: true; entry: LabeledCapture }
  | { ok: false; reason: string };

/**
 * Validate one raw capture value. Required: object shape, `consent`
 * exactly `true`, a non-empty string label, a non-empty samples array
 * whose every element is a `PointerSample` (finite `x`, `y`, `t`).
 * Unknown extra fields on a sample are dropped; known optional fields
 * (`pointerType`, `pressure`, `width`, `stroke`) are kept when their
 * type is usable.
 */
function parseOneCapture(raw: unknown): ParseOutcome {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const r = raw as Record<string, unknown>;
  if (r["consent"] !== true) {
    return {
      ok: false,
      reason: "consent is not true — refusing to analyze (no override exists)",
    };
  }
  const labelRaw = r["label"];
  if (typeof labelRaw !== "string" || labelRaw.trim() === "") {
    return { ok: false, reason: "missing or empty label" };
  }
  const samplesRaw = r["samples"];
  if (!Array.isArray(samplesRaw) || samplesRaw.length === 0) {
    return { ok: false, reason: "no samples" };
  }
  const samples: PointerSample[] = [];
  const rawList = samplesRaw as unknown[];
  for (let i = 0; i < rawList.length; i++) {
    const sample = toSample(rawList[i]);
    if (!sample) {
      return {
        ok: false,
        reason: `sample ${i} is not a valid PointerSample (finite x, y, t required)`,
      };
    }
    samples.push(sample);
  }
  const capturedAt = r["capturedAt"];
  const entry: LabeledCapture = {
    label: labelRaw.trim(),
    consent: true,
    samples,
    ...(typeof capturedAt === "string" ? { capturedAt } : {}),
  };
  return { ok: true, entry };
}

function toSample(raw: unknown): PointerSample | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const x = r["x"];
  const y = r["y"];
  const t = r["t"];
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  const sample: PointerSample = { x, y, t };
  const pointerType = r["pointerType"];
  if (typeof pointerType === "string" && pointerType !== "") {
    sample.pointerType = pointerType;
  }
  const pressure = r["pressure"];
  if (typeof pressure === "number" && Number.isFinite(pressure)) {
    sample.pressure = pressure;
  }
  const width = r["width"];
  if (typeof width === "number" && Number.isFinite(width) && width > 0) {
    sample.width = width;
  }
  const stroke = r["stroke"];
  if (typeof stroke === "number" && Number.isFinite(stroke)) {
    sample.stroke = stroke;
  }
  return sample;
}

/**
 * Parse raw capture values (already JSON-decoded) into validated
 * entries. Pure: no filesystem, no clock, no engine calls. Malformed
 * or non-consented inputs are excluded and reported as warnings, so
 * one bad file never sinks a capture run.
 */
export function parseCaptureFiles(
  files: readonly { name: string; raw: unknown }[],
): CaptureParseResult {
  const entries: LabeledCapture[] = [];
  const warnings: CaptureWarning[] = [];
  for (const file of files) {
    const outcome = parseOneCapture(file.raw);
    if (outcome.ok) {
      entries.push(outcome.entry);
    } else {
      warnings.push({ file: file.name, reason: outcome.reason });
    }
  }
  return { entries, warnings };
}

// ---------------------------------------------------------- aggregation

interface LabelTally {
  scores: number[];
  confidences: number[];
  counts: Record<Classification, number>;
}

function confusionMatrices(
  entries: readonly LabeledCapture[],
  sensitivity: Sensitivity,
): LabelMatrix[] {
  const byLabel = new Map<string, LabelTally>();
  for (const entry of entries) {
    const result = analyzeSamples(entry.samples, { sensitivity });
    let tally = byLabel.get(entry.label);
    if (!tally) {
      tally = {
        scores: [],
        confidences: [],
        counts: { HUMAN_LIKE: 0, SUSPICIOUS: 0, INCONCLUSIVE: 0 },
      };
      byLabel.set(entry.label, tally);
    }
    tally.scores.push(result.score);
    tally.confidences.push(result.confidence);
    tally.counts[result.classification]++;
  }
  return [...byLabel.keys()].sort().map((label) => {
    const tally = byLabel.get(label);
    if (!tally) {
      throw new Error(`evaluate-real: lost tally for label ${label}`);
    }
    const n = tally.scores.length;
    const mean = (xs: number[]): number =>
      n === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / n;
    return {
      label,
      total: n,
      humanLike: tally.counts["HUMAN_LIKE"],
      suspicious: tally.counts["SUSPICIOUS"],
      inconclusive: tally.counts["INCONCLUSIVE"],
      meanScore: mean(tally.scores),
      meanConfidence: mean(tally.confidences),
    };
  });
}

function statsOf(values: readonly number[]): InstrumentStats {
  if (values.length === 0) {
    return { measured: 0, p05: Number.NaN, p50: Number.NaN, p95: Number.NaN };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    measured: sorted.length,
    p05: quantileOf(sorted, 0.05),
    p50: quantileOf(sorted, 0.5),
    p95: quantileOf(sorted, 0.95),
  };
}

/**
 * Physics-law audit over the human-labeled captures, mirroring
 * `measureCorpus` in `scripts/physics-audit.mts`: slopes at the three
 * smoothing conventions (raw / w5 / w15) and SDN from the kinematic
 * core, LDLJ from the full sample series, nulls skipped per
 * instrument.
 */
function physicsSummary(
  entries: readonly LabeledCapture[],
  humanLabel: string,
): PhysicsSummary {
  const humans = entries.filter((entry) => entry.label === humanLabel);
  const slopeRaw: number[] = [];
  const slopeW5: number[] = [];
  const slopeW15: number[] = [];
  const sdnBeta: number[] = [];
  const ldljValues: number[] = [];
  let measured = 0;
  for (const entry of humans) {
    const core = coreSeries(entry.samples);
    if (core) {
      measured++;
      const raw = powerLawSlope(core, 1);
      const w5 = powerLawSlope(core, 5);
      const w15 = powerLawSlope(core, 15);
      if (raw) slopeRaw.push(raw.slope);
      if (w5) slopeW5.push(w5.slope);
      if (w15) slopeW15.push(w15.slope);
      const beta = sdnExponent(core);
      if (beta !== null) sdnBeta.push(beta);
    }
    const lj = ldlj(entry.samples);
    if (lj !== null) ldljValues.push(lj);
  }
  return {
    humanLabel,
    humanCaptures: humans.length,
    measured,
    slopeRaw: statsOf(slopeRaw),
    slopeW5: statsOf(slopeW5),
    slopeW15: statsOf(slopeW15),
    sdnBeta: statsOf(sdnBeta),
    ldlj: statsOf(ldljValues),
  };
}

/**
 * Aggregate validated captures into per-preset confusion matrices and
 * the physics-law audit. Pure: no filesystem, no clock.
 */
export function evaluateCaptures(
  entries: readonly LabeledCapture[],
  options: { humanLabel?: string } = {},
): RealEvalReport {
  const humanLabel = options.humanLabel ?? "human";
  return {
    totalCaptures: entries.length,
    presets: PRESETS.map((sensitivity) => ({
      sensitivity,
      matrices: confusionMatrices(entries, sensitivity),
    })),
    physics: physicsSummary(entries, humanLabel),
  };
}

// ------------------------------------------------------------ formatting

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function num(x: number, width: number, digits = 2): string {
  return (Number.isFinite(x) ? x.toFixed(digits) : "n/a").padStart(width);
}

function statLine(name: string, s: InstrumentStats): string {
  return `    ${pad(name, 6)} p05 ${num(s.p05, 7)}  p50 ${num(s.p50, 7)}  p95 ${num(s.p95, 7)}   (${s.measured} measured)`;
}

/** Render the full report. Pure: takes the aggregation result plus the
 *  parse warnings; produces the exact text the CLI prints. */
export function formatRealEvalReport(
  report: RealEvalReport,
  warnings: readonly CaptureWarning[] = [],
): string {
  const lines: string[] = [];
  lines.push("Real-capture evaluation — report only, nothing here gates or tunes.");
  lines.push("");
  lines.push(`Valid captures: ${report.totalCaptures}; skipped files: ${warnings.length}.`);

  if (warnings.length > 0) {
    lines.push("Skipped:");
    for (const w of warnings) {
      lines.push(`  ${w.file}: ${w.reason}`);
    }
    lines.push("");
  }

  for (const preset of report.presets) {
    lines.push(`Preset ${preset.sensitivity}:`);
    if (preset.matrices.length === 0) {
      lines.push("  no valid captures");
      lines.push("");
      continue;
    }
    const labelWidth = Math.max(
      "label".length + 2,
      ...preset.matrices.map((m) => m.label.length + 2),
    );
    // Each header segment matches the width of the data cell below it:
    // n is 5 wide, HL/SUSP/INCL 6, score/conf 9 (right-aligned).
    const header =
      "    n" + "    HL" + "  SUSP" + "  INCL" + "    score" + "  " + "     conf";
    lines.push(`  ${pad("label", labelWidth)}${header}`);
    for (const m of preset.matrices) {
      lines.push(
        `  ${pad(m.label, labelWidth)}${String(m.total).padStart(5)}${String(m.humanLike).padStart(6)}` +
          `${String(m.suspicious).padStart(6)}${String(m.inconclusive).padStart(6)}` +
          `${num(m.meanScore, 9, 3)}  ${num(m.meanConfidence, 9, 3)}`,
      );
    }
    lines.push("");
  }

  const p = report.physics;
  lines.push(
    `Physics-law audit over captures labeled "${p.humanLabel}" (${p.humanCaptures} captures, ${p.measured} with a usable core):`,
  );
  if (p.humanCaptures === 0) {
    lines.push("  none present — audit skipped.");
  } else {
    lines.push("  2/3 power law (target slope -1/3, Lacquaniti et al. 1983):");
    lines.push(statLine("raw", p.slopeRaw));
    lines.push(statLine("w5", p.slopeW5));
    lines.push(statLine("w15", p.slopeW15));
    lines.push("  SDN exponent (target beta ~ 2, Harris & Wolpert 1998):");
    lines.push(statLine("beta", p.sdnBeta));
    lines.push("  LDLJ smoothness (Flash & Hogan 1985; synthetic-human corpus median -7.86):");
    lines.push(statLine("ldlj", p.ldlj));
    lines.push("");
    lines.push(
      "  A published law that real humans in this set violate is not a usable",
    );
    lines.push(
      "  detector signature; the synthetic corpus already violates the first",
    );
    lines.push(
      '  two (docs/EVALUATION.md, "Physics-law audit").',
    );
  }
  lines.push("");
  lines.push(
    "Calibrate thresholds against these matrices, then re-validate with",
  );
  lines.push(
    "`npm run evaluate` (synthetic-corpus gates). Do not publish accuracy",
  );
  lines.push("claims from the synthetic corpus alone.");
  lines.push("");
  return lines.join("\n");
}

// ------------------------------------------------------------------ CLI

/** Run the CLI over a captures folder. Returns the process exit code:
 *  0 report produced, 1 unreadable folder, 2 usage error. */
export function main(argv: readonly string[]): number {
  const folder = argv[0];
  if (folder === undefined) {
    process.stderr.write("usage: npm run evaluate:real -- <captures-folder>\n");
    return 2;
  }
  let names: string[];
  try {
    const st = statSync(folder);
    if (!st.isDirectory()) {
      process.stderr.write(`evaluate-real: ${folder} is not a directory\n`);
      return 1;
    }
    names = readdirSync(folder)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (err) {
    process.stderr.write(
      `evaluate-real: cannot read folder ${folder}: ${(err as Error).message}\n`,
    );
    return 1;
  }
  const readWarnings: CaptureWarning[] = [];
  const parsed: { name: string; raw: unknown }[] = [];
  for (const name of names) {
    try {
      parsed.push({ name, raw: JSON.parse(readFileSync(join(folder, name), "utf8")) });
    } catch (err) {
      const message = (err as Error).message.replace(/\s+/g, " ").slice(0, 120);
      readWarnings.push({ file: name, reason: `unreadable or invalid JSON: ${message}` });
    }
  }
  const { entries, warnings } = parseCaptureFiles(parsed);
  const report = evaluateCaptures(entries);
  process.stdout.write(formatRealEvalReport(report, [...readWarnings, ...warnings]));
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exitCode = main(process.argv.slice(2));
}
