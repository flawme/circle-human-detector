// Post-build step for the dual ESM/CJS layout.
//
// 1. dist/cjs must be marked "type": "commonjs" so Node treats the CJS build
//    as CommonJS even though the package root is "type": "module".
// 2. Verifies that both builds emitted every public entrypoint, so a broken
//    build fails loudly instead of publishing half a package.

import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

writeFileSync(
  join(root, "dist", "cjs", "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
  "utf8",
);

const requiredArtifacts = [
  "dist/esm/index.js",
  "dist/esm/index.d.ts",
  "dist/cjs/index.js",
  "dist/cjs/index.d.ts",
  "dist/cjs/package.json",
  "dist/esm/analyze.js",
  "dist/esm/analyze.d.ts",
  "dist/cjs/analyze.js",
  "dist/esm/collector.js",
  "dist/esm/collector.d.ts",
  "dist/cjs/collector.js",
];

const missing = requiredArtifacts.filter((rel) => !existsSync(join(root, rel)));
if (missing.length > 0) {
  console.error("build incomplete, missing artifacts:");
  for (const rel of missing) {
    console.error("  " + rel);
  }
  process.exit(1);
}

console.log("build finalized: dist/esm (ESM) + dist/cjs (CJS) with declarations");
