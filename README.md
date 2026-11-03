# circle-human-detector

Behavioral analysis of circle-drawing interactions: estimates whether a
"draw a circle" gesture was produced by a human hand or a machine, from
pointer movement dynamics rather than geometric perfection.

**What this is:** a probabilistic behavioral signal — one input among
several you might use in a bot-mitigation stack.

**What this is not:** proof of humanity, a CAPTCHA solver, or a
replacement for attestation-based verification. A geometrically
imperfect circle does not prove a human drew it; a machine that models
human dynamics can evade any behavioral check. See
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) before deploying.

- TypeScript-first, strict types, zero runtime dependencies
- Dual ESM + CommonJS builds with generated `.d.ts`
- Browser collector (mouse / touch / pen via Pointer Events) and a pure,
  Node-compatible analysis engine
- Deterministic, explainable verdicts: every result carries the metric
  table and anomaly list that produced it
- No data collection, no network calls, no telemetry — samples stay in
  memory until you decide what to do with them

## Install

```sh
npm install circle-human-detector
```

## Quick start (browser)

```ts
import { CircleDetector } from "circle-human-detector";

const detector = new CircleDetector({
  target: document.querySelector<HTMLCanvasElement>("#draw-surface"),
  sensitivity: "balanced",
});

detector.start();

// The user draws a circle with mouse, finger, or stylus...

canvas.addEventListener("pointerup", () => {
  const result = detector.analyze();
  console.log(result.classification); // "HUMAN_LIKE" | "SUSPICIOUS" | "INCONCLUSIVE"
  console.log(result.score);          // 0..1 human-likelihood
  console.log(result.confidence);      // 0..1 confidence in the verdict
  console.log(result.anomalies);       // machine signatures / data-quality notes
});
```

The drawing surface needs `touch-action: none` so touch strokes are not
consumed by scrolling:

```css
#draw-surface { touch-action: none; }
```

A complete working demo lives in
[examples/browser](examples/browser/index.html). Serve from the
**repo root** (the example imports `../../dist/esm/index.js`, which
only resolves when the package root is the docroot):

```sh
npm run build
python3 -m http.server 8000   # run from the repo root
# open http://localhost:8000/examples/browser/index.html
```

For a self-contained interactive playground — one file, opens straight
from disk, no server, no network — build the demo page:

```sh
npm run build:demo
# then open examples/browser/demo.html in a browser
```

Draw a circle with mouse, touch, or pen, or replay scripted/noisy
synthetic bots, and watch the verdict, detected signals, and
per-metric contributions update. The engine is inlined into the page
by `scripts/build-demo.mjs`, so the demo always reflects the current
build.

Two more runnable flows ship with the examples:

- **Offline capture for real datasets**:
  [`examples/browser/collect.html`](examples/browser/collect.html) —
  consent-gated, zero network, exports labeled JSON per drawing.
  The collection plan is in
  [docs/CAPTURE-CAMPAIGN.md](docs/CAPTURE-CAMPAIGN.md).
- **Server-side verification with replay protection**:
  `examples/node/challenge-server.mjs` — single-use challenge
  tokens, wall-clock window binding, analysis on the server. The
  concrete version of the `/api/challenge` pseudo-code below.

## Quick start (Node, pure analysis)

The analysis engine has no DOM dependency. Analyze samples collected
elsewhere — for example, submitted by a browser client to your API:

```ts
import { analyzeSamples } from "circle-human-detector/analyze";

app.post("/api/challenge", (req, res) => {
  const result = analyzeSamples(req.body.samples, {
    sensitivity: "balanced",
  });

  if (result.classification === "HUMAN_LIKE" && result.confidence > 0.6) {
    res.json({ pass: true });
  } else if (result.classification === "SUSPICIOUS") {
    res.json({ pass: false, reason: "suspicious drawing behavior" });
  } else {
    // INCONCLUSIVE: too little or too ambiguous data. Ask the user to
    // retry, or fall back to another challenge. Never treat it as an
    // accusation.
    res.json({ pass: false, reason: "inconclusive, please retry" });
  }
});
```

A runnable version is in
[examples/node/analyze-demo.mjs](examples/node/analyze-demo.mjs).
For the full verification flow — single-use challenge tokens,
wall-clock window binding, replay rejection — run
[examples/node/challenge-server.mjs](examples/node/challenge-server.mjs):

```sh
npm run build
node examples/node/challenge-server.mjs
# open http://localhost:8787
```

## The result object

```ts
interface CircleDetectionResult {
  /** Human-likelihood in [0, 1]. A heuristic signal, not a probability. */
  score: number;
  /** Confidence in [0, 1]. Below the sensitivity preset's minimum the
   *  verdict is INCONCLUSIVE by construction. */
  confidence: number;
  classification: "HUMAN_LIKE" | "SUSPICIOUS" | "INCONCLUSIVE";
  /** Machine signatures and data-quality findings, with details. */
  anomalies: Anomaly[];
  /** Raw behavioral metrics for transparency and downstream tuning. */
  metrics: BehavioralMetrics;
  /** Per-metric human-likeness values and weights behind `score`. */
  contributions: MetricContribution[];
  /** Whether the data was sufficient to attempt classification. */
  dataQuality: DataQuality;
}
```

Classification semantics:

| Classification | Meaning |
| --- | --- |
| `HUMAN_LIKE` | Movement dynamics are consistent with a human. Probabilistic evidence, never proof. |
| `SUSPICIOUS` | Machine signatures present, or dynamics strongly inconsistent with natural movement. |
| `INCONCLUSIVE` | Insufficient data, ambiguous metrics, or a shape that is not circle-like. The detector refuses to guess. |

## Sensitivity presets

| Preset | HUMAN_LIKE at | SUSPICIOUS at or below | Minimum confidence |
| --- | --- | --- | --- |
| `relaxed` | score >= 0.48 | 0.26 | 0.30 |
| `balanced` | score >= 0.58 | 0.33 | 0.40 |
| `strict` | score >= 0.66 | 0.40 | 0.50 |

Scores between the two thresholds are the gray zone: INCONCLUSIVE. All
thresholds are overridable (`thresholds` option), along with the data
floors (`minSamples` = 24, `minDurationMs` = 300, `minCoverageTurns` =
0.85) and the pause threshold (`pauseMs` = 120). See
[docs/API.md](docs/API.md#detectoroptions) for the full list.

## How detection works

Two independent evidence channels, both visible in every result:

1. **Weighted human-likeness metrics.** Angular-velocity variation,
   systematic speed modulation across the sweep, low-frequency radius
   wobble, start/end speed ramps, tremor amplitude, and more. Each is
   normalized to 0..1 through explicit, inspectable piecewise-linear
   curves and combined by weight. Amplitude-only metrics are blended
   with their temporal autocorrelation, because injected white noise
   fakes amplitude but not structure.

2. **Machine-signature anomalies with penalties.** Hard signatures no
   natural input pipeline produces: exactly-constant angular velocity,
   collinear interpolation runs, piecewise-constant speed, uniform
   timestamps, zero radial residual, jitter amplitude without temporal
   structure, and broadband radius wander whose coupling into speed
   betrays a constant-omega generator. Each subtracts a fixed penalty
   from the score.

Geometric imperfection alone never proves anything: a noisy circle with
machine-consistent dynamics still classifies SUSPICIOUS, and a clean
circle drawn by a skilled human still passes on its dynamics. The
confidence term combines data sufficiency with cross-metric agreement —
when metrics disagree, the verdict is INCONCLUSIVE rather than a guess.

The full metric reference, weights, and anomaly catalog are in
[docs/API.md](docs/API.md).

## Benchmark

```
npm run evaluate
```

Runs the engine against a 200-trial-per-class randomized synthetic
corpus (seeded, reproducible) and gates the result:

| Class | HUMAN_LIKE | SUSPICIOUS | INCONCLUSIVE | Mean score | Mean conf |
| --- | --- | --- | --- | --- | --- |
| Human movement model | 100% | 0% | 0% | 0.965 | 0.690 |
| Parametric generator | 0% | 100% | 0% | 0.000 | 0.783 |
| Noisy generator | 0% | 100% | 0% | 0.018 | 0.561 |
| Waypoint interpolation | 0% | 100% | 0% | 0.000 | 0.787 |
| Adversarial generator | 0% | 2.5% | 97.5% | 0.253 | 0.382 |
| Straight line (not a circle) | 0% | 0% | 100% | 0.000 | 0.000 |

These numbers validate the engine against *modeled* humans and
generators — a regression gate, not a real-world accuracy measurement.
The same command also prints an informational physics-law audit:
each corpus's two-thirds power-law slope, signal-dependent-noise
exponent, and movement smoothness, measured against published
motor-control targets.
To evaluate against real captures, collect them with
`examples/browser/collect.html` — a consent-gated page that runs from
`file://` and makes zero network requests — and run
`npm run evaluate:real -- <folder>` for per-preset per-label confusion
matrices plus the same physics audit over your labeled captures.
Methodology, and how to replace the synthetic corpus with consented
real captures: [docs/EVALUATION.md](docs/EVALUATION.md).

## Privacy and consent

- The library collects nothing on its own: samples exist in memory,
  for as long as you hold them.
- It performs no network I/O and ships no telemetry.
- If you transmit drawing data anywhere (e.g., to your API for
  server-side analysis), that is **your** policy decision: disclose it
  and obtain consent. Pointer traces can be biometric-adjacent data
  (movement characteristics), so treat them accordingly.
- See [docs/LIMITATIONS.md](docs/LIMITATIONS.md#privacy-and-consent).

## Development

```sh
npm run typecheck   # strict tsc over src + test + scripts + examples/node
npm run build       # dist/esm + dist/cjs + declarations
npm test            # unit + integration suite (node:test, zero deps)
npm run evaluate    # synthetic-corpus benchmark with gates
npm run evaluate:real -- <folder>  # labeled real-capture report
```

Requirements: Node >= 24 for development (TypeScript type stripping for
tests); the published package runs on Node >= 18 and any modern
browser.

## License

MIT — see [LICENSE](LICENSE).

Created by [flawme](https://github.com/flawme).
