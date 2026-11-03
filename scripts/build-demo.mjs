/**
 * Build the self-contained interactive demo page.
 *
 * Inlines the compiled engine (dist/esm) into
 * scripts/demo-template.html and writes examples/browser/demo.html as
 * ONE file that runs from file:// with no server and no network: the
 * ESM module graph is flattened into a single classic script.
 *
 * How it flattens:
 * 1. Parse each dist/esm/*.js module's relative imports and
 *    re-exports, topologically order the graph (cycles are an error).
 * 2. Strip import statements, re-export statements, `export` keywords
 *    on declarations, and sourceMappingURL comments.
 * 3. Concatenate in dependency order inside one script tag.
 *
 * Fail-loud safety checks:
 * - duplicate top-level names across modules are refused (a duplicate
 *   `function` would silently shadow in a shared scope)
 * - any import/export syntax that survives stripping fails the build
 * - non-relative specifiers are refused (nothing to inline them from)
 *
 * Run: npm run build:demo  (requires `npm run build` first)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const esmDir = join(root, "dist", "esm");
const templatePath = join(root, "scripts", "demo-template.html");
const outPath = join(root, "examples", "browser", "demo.html");

/** Recursively collect every .js module under dist/esm. */
function collectModules(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectModules(full));
    } else if (entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

/** A parsed module: its source with module syntax stripped. */
function parseModule(file) {
  let source = readFileSync(file, "utf8");

  const deps = [];

  // import { a, b } from "./x.js";  /  import { t } from "./x.js"
  source = source.replace(
    /^import\s+\{[^}]*\}\s+from\s+"([^"]+)";?\s*$/gm,
    (_m, spec) => {
      deps.push(spec);
      return "";
    },
  );
  // import * as ns from "./x.js" (not emitted by tsc here, but refuse
  // to silently mishandle it if it ever appears)
  source = source.replace(
    /^import\s+\*\s+as\s+\S+\s+from\s+"([^"]+)";?\s*$/gm,
    (_m, spec) => {
      deps.push(spec);
      return "";
    },
  );
  // export { a } from "./x.js"; / export * from "./x.js";
  source = source.replace(
    /^export\s+(?:\{[^}]*\}|\*)\s+from\s+"([^"]+)";?\s*$/gm,
    (_m, spec) => {
      deps.push(spec);
      return "";
    },
  );
  // export const/let/var/function/class -> plain declaration
  source = source.replace(/^export\s+(?=(?:const|let|var|function|class)\b)/gm, "");
  // export { a, b }; (pure re-export list of local names)
  source = source.replace(/^export\s+\{[^}]*\};?\s*$/gm, "");
  // sourceMappingURL comments (the .map files are not copied)
  source = source.replace(/^\/\/# sourceMappingURL=.*$/gm, "");

  for (const dep of deps) {
    if (!dep.startsWith("./") && !dep.startsWith("../")) {
      throw new Error(`${relative(root, file)}: non-relative import "${dep}" cannot be inlined`);
    }
    const resolved = resolve(dirname(file), dep);
    if (!resolved.startsWith(esmDir)) {
      throw new Error(`${relative(root, file)}: import "${dep}" escapes dist/esm`);
    }
  }

  return { file, source, deps };
}

/** Post-order DFS over the dependency graph; cycles are an error. */
function topoOrder(modules) {
  const byFile = new Map(modules.map((m) => [m.file, m]));
  const order = [];
  const done = new Set();
  const inProgress = new Set();

  const visit = (file) => {
    if (done.has(file)) return;
    if (inProgress.has(file)) {
      throw new Error(`cyclic import graph involving ${relative(root, file)}`);
    }
    inProgress.add(file);
    const mod = byFile.get(file);
    for (const dep of mod.deps) {
      const resolved = resolve(dirname(file), dep);
      if (!byFile.has(resolved)) {
        throw new Error(`${relative(root, file)}: import "${dep}" not found under dist/esm`);
      }
      visit(resolved);
    }
    inProgress.delete(file);
    done.add(file);
    order.push(mod);
  };

  for (const mod of modules) visit(mod.file);
  return order;
}

/** Refuse duplicate top-level bindings: in one shared scope a repeated
 *  `function` would silently shadow instead of erroring. */
function assertUniqueTopLevelNames(ordered) {
  const owner = new Map();
  for (const mod of ordered) {
    const re = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(mod.source)) !== null) {
      const name = m[1];
      const prev = owner.get(name);
      if (prev !== undefined) {
        throw new Error(
          `duplicate top-level name "${name}" in ${relative(root, mod.file)} (already declared in ${prev}); ` +
            `the flattening would silently shadow one of them`,
        );
      }
      owner.set(name, relative(root, mod.file));
    }
  }
}

/** No module syntax may survive stripping. */
function assertNoModuleSyntaxLeft(bundle) {
  const leftovers = bundle.match(/^import\s.*$|^export\s.*$/gm);
  if (leftovers !== null) {
    throw new Error(
      `module syntax survived stripping: ${JSON.stringify(leftovers.slice(0, 5))}`,
    );
  }
}

// --- main ------------------------------------------------------------

const moduleFiles = collectModules(esmDir);
if (moduleFiles.length === 0) {
  console.error("error: no modules under dist/esm - run `npm run build` first");
  process.exit(1);
}

const modules = moduleFiles.map(parseModule);
const ordered = topoOrder(modules);
assertUniqueTopLevelNames(ordered);

const sections = ordered.map(
  (m) =>
    `// ---- ${relative(root, m.file)} -----------------------------------------\n` +
    m.source.trim(),
);
const bundle =
  "// circle-human-detector engine, flattened from dist/esm by scripts/build-demo.mjs.\n" +
  sections.join("\n\n");

assertNoModuleSyntaxLeft(bundle);

const template = readFileSync(templatePath, "utf8");
const placeholder = "/*__ENGINE_BUNDLE__*/";
if (template.split(placeholder).length !== 2) {
  console.error(`error: ${relative(root, templatePath)} must contain ${placeholder} exactly once`);
  process.exit(1);
}

const wrapped = `/* ENGINE-BEGIN */\n${bundle}\n/* ENGINE-END */`;
const html = template.replace(placeholder, wrapped);
writeFileSync(outPath, html);

const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
console.log(`demo built: ${relative(root, outPath)} (${kb} KB, ${ordered.length} modules)`);
console.log(`  open it directly in a browser - no server needed`);
