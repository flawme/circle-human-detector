/**
 * Browser integration example.
 *
 * The full capture-to-verdict loop with the CircleDetector facade:
 * the detector attaches its own pointer listeners to the canvas,
 * collects samples while the user draws, and `analyze()` returns the
 * verdict after the stroke ends.
 *
 * Requires the package build first (the import points at dist/):
 *   npm run build
 *
 * Serve from the REPO ROOT, not this folder — example.js imports
 * "../../dist/esm/index.js", which only resolves when the package
 * root is the docroot:
 *   cd ../..                          # repo root
 *   python3 -m http.server 8000       # or: npx serve .
 *   # then open http://localhost:8000/examples/browser/index.html
 */

import { CircleDetector } from "../../dist/esm/index.js";

const canvas = document.getElementById("surface");
const sensitivitySelect = document.getElementById("sensitivity");
const clearButton = document.getElementById("clear");
const verdictBox = document.getElementById("verdict");
const barsBox = document.getElementById("bars");
const anomaliesBox = document.getElementById("anomalies");
const anomalyList = document.getElementById("anomaly-list");

const ctx = canvas.getContext("2d");
ctx.lineWidth = 2;
ctx.lineCap = "round";
ctx.strokeStyle = "#2a2a2a";

const detector = new CircleDetector({
  target: canvas,
  sensitivity: "balanced",
});

// Mirror the captured stroke onto the canvas while drawing.
canvas.addEventListener("pointerdown", (e) => {
  ctx.beginPath();
  ctx.moveTo(e.offsetX, e.offsetY);
});
canvas.addEventListener("pointermove", (e) => {
  if (e.buttons > 0) {
    ctx.lineTo(e.offsetX, e.offsetY);
    ctx.stroke();
  }
});

// When a stroke ends, score what was drawn.
canvas.addEventListener("pointerup", () => {
  // Require a reasonable amount of motion before scoring.
  if (detector.getSamples().length < 10) return;
  const result = detector.analyze({
    sensitivity: sensitivitySelect.value,
  });
  render(result);
});

clearButton.addEventListener("click", () => {
  detector.reset();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  hideResult();
});

function render(result) {
  verdictBox.hidden = false;
  verdictBox.textContent = result.classification;
  verdictBox.className = `verdict ${result.classification}`;

  barsBox.hidden = false;
  setBar("score-bar", "score-value", result.score);
  setBar("conf-bar", "conf-value", result.confidence);

  anomaliesBox.hidden = result.anomalies.length === 0;
  anomalyList.replaceChildren(
    ...result.anomalies.map((a) => {
      const li = document.createElement("li");
      li.textContent = `[${a.severity}] ${a.code} — ${a.detail}`;
      return li;
    }),
  );
}

function setBar(barId, valueId, value) {
  document.getElementById(barId).style.width = `${(value * 100).toFixed(1)}%`;
  document.getElementById(valueId).textContent = value.toFixed(3);
}

function hideResult() {
  verdictBox.hidden = true;
  barsBox.hidden = true;
  anomaliesBox.hidden = true;
}

detector.start();
