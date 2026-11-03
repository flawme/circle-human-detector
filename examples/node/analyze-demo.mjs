/**
 * Node.js integration example.
 *
 * The realistic server-side use: a browser client captures pointer
 * samples and submits them to your API; the server analyzes the JSON
 * with the pure engine. This demo fabricates two payloads (a
 * human-model stream and a bot stream) and runs the same analysis a
 * request handler would.
 *
 * Run after building:
 *   npm run build
 *   node examples/node/analyze-demo.mjs
 */

import { analyzeSamples } from "../../dist/esm/analyze.js";

/**
 * Demo fixture: a deterministic human-model drawing stream, in the
 * exact shape a browser client would POST
 * (circle-human-detector -> getSamples() -> JSON.stringify()).
 *
 * Movement model: smooth angular-velocity modulation with start/end
 * ramps (integrated, so the sweep is a full revolution), low-frequency
 * radius wobble, an 11 Hz tremor band, and small per-sample jitter.
 */
function makeHumanPayload() {
  const n = 150;
  const T = 1600;
  const sweep = 2 * Math.PI * 1.06;

  // Angular velocity: ramp envelope times a smooth modulation,
  // scaled so the integrated sweep is exactly `sweep` radians.
  const env = (s) => Math.min(1, Math.min(s / 0.12, (1 - s) / 0.1));
  const rawOmega = [];
  for (let i = 0; i < n - 1; i++) {
    const sMid = (i + 0.5) / (n - 1);
    rawOmega.push(env(sMid) * (1 + 0.25 * Math.sin(2 * Math.PI * sMid + 0.4)));
  }
  const dt = T / (n - 1);
  let omegaSum = 0;
  for (const w of rawOmega) omegaSum += w * dt;
  const scale = sweep / omegaSum;

  const thetas = [0];
  for (let i = 0; i < n - 1; i++) {
    thetas.push(thetas[thetas.length - 1] + rawOmega[i] * scale * dt);
  }

  const samples = [];
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    const r =
      110 *
      (1 +
        0.03 * Math.sin(2 * Math.PI * s + 0.7) +
        0.006 * Math.sin(2 * Math.PI * 11 * (T / 1000) * s));
    // Deterministic sub-pixel jitter + timestamp jitter.
    const jx = 0.3 * Math.sin(137 * (i + 3));
    const jy = 0.3 * Math.cos(149 * (i + 3));
    const tj = 2 * Math.sin(i * 2.399963);
    samples.push({
      x: 240 + r * Math.cos(thetas[i]) + jx,
      y: 180 + r * Math.sin(thetas[i]) + jy,
      t: Math.round(1000 + T * s + tj),
      pointerType: "mouse",
      stroke: 0,
    });
  }
  return samples;
}

/** Demo fixture: a naive parametric bot stream. */
function makeBotPayload() {
  const samples = [];
  const r = 90;
  const cx = 260;
  const cy = 200;
  const n = 120;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    samples.push({
      x: cx + r * Math.cos(2 * Math.PI * f),
      y: cy + r * Math.sin(2 * Math.PI * f),
      t: Math.round(1400 * f),
      pointerType: "mouse",
      stroke: 0,
    });
  }
  return samples;
}

function report(label, result) {
  console.log(`\n=== ${label} ===`);
  console.log(`classification : ${result.classification}`);
  console.log(`human-likelihood score : ${result.score.toFixed(3)}`);
  console.log(`confidence     : ${result.confidence.toFixed(3)}`);
  if (result.anomalies.length > 0) {
    console.log(`anomalies      :`);
    for (const a of result.anomalies) {
      console.log(`  - [${a.severity}] ${a.code}`);
    }
  } else {
    console.log(`anomalies      : (none)`);
  }
}

const humanResult = analyzeSamples(makeHumanPayload(), {
  sensitivity: "balanced",
});
report("human-model payload", humanResult);

const botResult = analyzeSamples(makeBotPayload(), {
  sensitivity: "balanced",
});
report("bot payload", botResult);

// In a real API handler (pseudo-code):
//
//   app.post("/api/challenge", (req, res) => {
//     const result = analyzeSamples(req.body.samples, { sensitivity: "balanced" });
//     if (result.classification === "HUMAN_LIKE" && result.confidence > 0.6) {
//       res.json({ pass: true });
//     } else if (result.classification === "SUSPICIOUS") {
//       res.json({ pass: false, reason: "suspicious drawing behavior" });
//     } else {
//       res.json({ pass: false, reason: "inconclusive, please retry" });
//     }
//   });
//
// Note: behavioral signals degrade gracefully — treat INCONCLUSIVE as
// "retry with a fallback challenge", never as an accusation.
