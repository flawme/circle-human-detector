// Diagnostic: per-seed corpus results with weakest contributions.
// Scratch tooling for engine tuning; not part of the shipped package.

import { analyzeSamples } from "../src/analyze.ts";
import {
  generateHumanCircle,
  generateMachineCircle,
} from "../test/helpers/generators.ts";
import type { MachineVariant } from "../test/helpers/generators.ts";

function report(label: string, result: ReturnType<typeof analyzeSamples>): void {
  const weakest = [...result.contributions]
    .filter((c) => c.weight > 0)
    .sort((a, b) => a.value - b.value)
    .slice(0, 4)
    .map((c) => `${c.key}=${c.value.toFixed(2)}`)
    .join(" ");
  const anomalies = result.anomalies.map((a) => a.code).join(",") || "-";
  console.log(
    `${label}: ${result.classification.padEnd(12)} score=${result.score.toFixed(3)} conf=${result.confidence.toFixed(2)} | ${weakest} | ${anomalies}`,
  );
}

const mode = process.argv[2] ?? "human";
const seeds = Number(process.argv[3] ?? 40);

for (let seed = 1; seed <= seeds; seed++) {
  if (mode === "human") {
    report(`human-${String(seed).padStart(2, "0")}`, analyzeSamples(generateHumanCircle({ seed })));
  } else {
    const variants = new Set<MachineVariant>(["parametric", "noisy", "waypoint", "adversarial"]);
    if (!variants.has(mode as MachineVariant)) {
      throw new Error(`unknown mode: ${mode}`);
    }
    report(
      `${mode}-${String(seed).padStart(2, "0")}`,
      analyzeSamples(generateMachineCircle({ seed, variant: mode as MachineVariant })),
    );
  }
}
