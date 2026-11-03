/**
 * Server-side verification example: single-use challenges with
 * replay protection.
 *
 * This is the concrete version of the pseudo-code at the bottom of
 * examples/node/analyze-demo.mjs: the browser requests a challenge,
 * draws a circle, and submits the samples; the server consumes the
 * single-use token, binds the capture to the challenge window, and
 * runs the analysis with the pure engine. A recorded stroke that is
 * replayed fails twice over — its token is spent, and against a
 * fresh token its wall-clock stamps predate the challenge.
 *
 * Run:
 *   npm run build          # the engine is imported from dist
 *   node examples/node/challenge-server.mjs
 *   # open http://localhost:8787
 *
 * Requirements: Node >= 24 (this file imports the typed .mts module
 * via native type stripping). Zero dependencies beyond Node
 * builtins and this package's built engine.
 *
 * Example-grade, on purpose: the token store is in-memory (swap in
 * Redis for multi-process), there are no per-IP rate limits, and the
 * client page is served same-origin (no CORS). The pure half lives
 * in examples/node/challenge.mts and is pinned by
 * test/challenge.test.ts.
 */
import { createServer } from "node:http";

import { analyzeSamples } from "../../dist/esm/analyze.js";
import {
  createChallengeStore,
  validateCaptureTimeline,
  verdictFor,
} from "./challenge.mts";

const PORT = Number(process.env.PORT ?? 8787);
const CHALLENGE_TTL_MS = 120_000;
const MAX_BODY_BYTES = 512 * 1024;
const SENSITIVITY = "balanced";

const store = createChallengeStore();

/** Read and JSON-parse a request body, capped at MAX_BODY_BYTES. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Pause, do not destroy: the 413 response still has to
        // reach the client over this socket.
        aborted = true;
        req.pause();
        resolve({ status: 413, error: "request body too large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        resolve({ status: 200, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ status: 400, error: "request body is not valid JSON" });
      }
    });
    req.on("error", () => {
      if (!aborted) resolve({ status: 400, error: "request stream error" });
    });
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendPage(res) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(CLIENT_PAGE);
}

async function handleChallenge(res) {
  const now = Date.now();
  const challenge = store.issue(now, CHALLENGE_TTL_MS);
  sendJson(res, 200, {
    challengeId: challenge.id,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    ttlMs: CHALLENGE_TTL_MS,
  });
}

async function handleVerify(req, res) {
  const read = await readJsonBody(req);
  if (read.status !== 200) {
    sendJson(res, read.status, { error: read.error });
    return;
  }
  const body = read.json;
  const now = Date.now();

  // Consume FIRST: single-use is enforced even when the submission
  // later fails validation, so nothing can be retried against the
  // same token.
  const consumed = store.consume(
    typeof body?.challengeId === "string" ? body.challengeId : "",
    now,
  );
  if (consumed.status === "unknown") {
    // Unknown covers both "never issued" and "already used"; the
    // response is identical so nothing leaks which one it was.
    sendJson(res, 409, { error: "challenge unknown or already used" });
    return;
  }
  if (consumed.status === "expired") {
    sendJson(res, 410, { error: "challenge expired; request a new one" });
    return;
  }

  const timeline = validateCaptureTimeline(
    {
      samples: Array.isArray(body?.samples) ? body.samples : [],
      startedAt: typeof body?.startedAt === "number" ? body.startedAt : Number.NaN,
      endedAt: typeof body?.endedAt === "number" ? body.endedAt : Number.NaN,
    },
    consumed.record,
    now,
  );
  if (!timeline.ok) {
    sendJson(res, 422, { error: timeline.reason });
    return;
  }

  const result = analyzeSamples(
    Array.isArray(body?.samples) ? body.samples : [],
    { sensitivity: SENSITIVITY },
  );
  sendJson(res, 200, {
    classification: result.classification,
    score: result.score,
    confidence: result.confidence,
    verdict: verdictFor(result.classification),
    anomalies: result.anomalies.map((a) => a.code),
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const done = (status) =>
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} -> ${status}`);

  if (req.method === "GET" && url.pathname === "/") {
    sendPage(res);
    done(200);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/challenge") {
    handleChallenge(res).then(() => done(res.statusCode), (err) => {
      console.error(err);
      sendJson(res, 500, { error: "internal error" });
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/verify") {
    handleVerify(req, res).then(() => done(res.statusCode), (err) => {
      console.error(err);
      sendJson(res, 500, { error: "internal error" });
    });
    return;
  }
  sendJson(res, 404, { error: "not found" });
  done(404);
});

server.listen(PORT, () => {
  console.log(`challenge example listening on http://localhost:${PORT}`);
  console.log(`sensitivity=${SENSITIVITY} ttl=${CHALLENGE_TTL_MS}ms`);
});

/**
 * The client page. Unlike examples/browser/collect.html this page
 * TRANSMITS what it records: the samples go to THIS server for
 * analysis. The consent gate says so explicitly before any listener
 * is attached. No template literals inside (the whole page is one).
 */
const CLIENT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Circle verification - single-use challenge example</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1a1d23; background: #f6f7f9; }
  .wrap { max-width: 680px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #5b6372; margin: 0 0 18px; }
  .gate { position: fixed; inset: 0; background: rgba(246,247,249,.97); display: flex;
          align-items: center; justify-content: center; padding: 16px; z-index: 10; }
  .gate[hidden] { display: none; }
  .card { background: #fff; border: 1px solid #d8dde6; border-radius: 10px;
          padding: 22px 24px; max-width: 520px; max-height: 100%; overflow: auto; }
  .card h2 { font-size: 16px; margin: 0 0 10px; }
  .card ul { margin: 0 0 14px; padding-left: 20px; }
  .card li { margin-bottom: 8px; }
  .panel { background: #fff; border: 1px solid #d8dde6; border-radius: 10px;
           padding: 18px 20px; margin-bottom: 16px; }
  canvas { display: block; width: 100%; max-width: 440px; aspect-ratio: 1/1;
           border: 1px solid #d8dde6; border-radius: 8px; background: #fff;
           touch-action: none; cursor: crosshair; }
  button { font: inherit; padding: 7px 14px; border: 1px solid #d8dde6; border-radius: 6px;
           background: #fff; cursor: pointer; }
  button.primary { background: #0b5cad; border-color: #0b5cad; color: #fff; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; }
  #status { color: #5b6372; font-variant-numeric: tabular-nums; }
  #verdict { margin: 10px 0 0; min-height: 1.4em; overflow-wrap: anywhere; }
  #verdict.ok { color: #0a7d33; }
  #verdict.bad { color: #a11212; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Circle verification</h1>
  <p class="sub">Single-use challenge example for
    <code>circle-human-detector</code>: the server issues one
    challenge per drawing and analyzes it server-side.</p>

  <div id="gate" class="gate">
    <div class="card">
      <h2>Before recording starts</h2>
      <ul>
        <li><strong>What is captured:</strong> pointer x/y positions,
          timestamps, pressure and pointer type while you draw.</li>
        <li><strong>Where it goes:</strong> unlike the offline
          collector page, this example <strong>sends your samples to
          this server</strong> for analysis. Nothing is stored; the
          samples are analyzed in memory and discarded.</li>
        <li><strong>Consent gate:</strong> no listener exists before
          this click. Withdraw stops recording and deletes what was
          recorded.</li>
      </ul>
      <button id="consent" class="primary">I consent - start</button>
    </div>
  </div>

  <div id="app" hidden>
    <div class="panel">
      <div id="status">requesting challenge...</div>
      <div class="row"><canvas id="surface" width="440" height="440"
        aria-label="Drawing surface: draw a circle"></canvas></div>
      <p class="sub">Draw a circle in one smooth motion, at least one
        full turn.</p>
      <div class="row">
        <button id="submit" class="primary" disabled>Submit</button>
        <button id="clear">Clear</button>
        <button id="withdraw">Withdraw consent</button>
      </div>
      <p id="verdict" aria-live="polite"></p>
    </div>
  </div>
</div>

<script>
(function () {
  "use strict";
  var gate = document.getElementById("gate");
  var app = document.getElementById("app");
  var statusEl = document.getElementById("status");
  var surface = document.getElementById("surface");
  var submitBtn = document.getElementById("submit");
  var clearBtn = document.getElementById("clear");
  var withdrawBtn = document.getElementById("withdraw");
  var verdictEl = document.getElementById("verdict");
  var ctx = surface.getContext("2d");

  var recording = false;
  var samples = [];
  var strokeIndex = 0;
  var drawing = false;
  var activePointerId = null;
  var startedAt = 0;
  var endedAt = 0;
  var lastX = 0, lastY = 0;
  var challenge = null;
  var countdownTimer = null;

  function setStatus(text) { statusEl.textContent = text; }
  function setVerdict(text, cls) {
    verdictEl.textContent = text;
    verdictEl.className = cls || "";
  }

  function updateStatus() {
    var n = samples.length;
    var dur = n >= 2 ? Math.round(samples[n - 1].t - samples[0].t) : 0;
    setStatus(n + " samples / " + dur + " ms / stroke " + strokeIndex);
  }

  function record(event, stroke) {
    if (!recording) return;
    var rect = surface.getBoundingClientRect();
    var x = event.clientX - rect.left;
    var y = event.clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!Number.isFinite(event.timeStamp)) return;
    var s = { x: x, y: y, t: event.timeStamp, stroke: stroke };
    if (event.pointerType) s.pointerType = event.pointerType;
    if (typeof event.pressure === "number") s.pressure = event.pressure;
    samples.push(s);
  }

  function onDown(event) {
    if (!recording) return;
    if (activePointerId !== null) return;
    activePointerId = event.pointerId;
    drawing = true;
    if (samples.length === 0) startedAt = Date.now();
    try { surface.setPointerCapture(event.pointerId); } catch (e) {}
    record(event, strokeIndex);
    var rect = surface.getBoundingClientRect();
    lastX = event.clientX - rect.left;
    lastY = event.clientY - rect.top;
    updateStatus();
  }

  function onMove(event) {
    if (!recording || !drawing) return;
    if (event.pointerId !== activePointerId) return;
    record(event, strokeIndex);
    var rect = surface.getBoundingClientRect();
    var x = event.clientX - rect.left;
    var y = event.clientY - rect.top;
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastX = x; lastY = y;
    updateStatus();
  }

  function onUp(event) {
    if (!recording || !drawing) return;
    if (event.pointerId !== activePointerId) return;
    record(event, strokeIndex);
    strokeIndex++;
    endedAt = Date.now();
    drawing = false;
    activePointerId = null;
    try { surface.releasePointerCapture(event.pointerId); } catch (e) {}
    submitBtn.disabled = challenge === null || samples.length < 2;
    updateStatus();
  }

  function attach() {
    surface.addEventListener("pointerdown", onDown);
    surface.addEventListener("pointermove", onMove);
    surface.addEventListener("pointerup", onUp);
    surface.addEventListener("pointercancel", onUp);
  }

  function detach() {
    surface.removeEventListener("pointerdown", onDown);
    surface.removeEventListener("pointermove", onMove);
    surface.removeEventListener("pointerup", onUp);
    surface.removeEventListener("pointercancel", onUp);
  }

  function resetAttempt() {
    samples = [];
    strokeIndex = 0;
    drawing = false;
    activePointerId = null;
    ctx.clearRect(0, 0, surface.width, surface.height);
    submitBtn.disabled = true;
    updateStatus();
  }

  function stopCountdown() {
    if (countdownTimer !== null) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function requestChallenge() {
    setStatus("requesting challenge...");
    fetch("/api/challenge", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        challenge = data;
        updateStatus();
        stopCountdown();
        countdownTimer = setInterval(function () {
          var left = Math.max(0, Math.round((challenge.expiresAt - Date.now()) / 1000));
          if (left <= 0) {
            stopCountdown();
            setStatus("challenge expired - it will be refreshed with your next submit");
          } else {
            setStatus(samples.length + " samples / stroke " + strokeIndex +
              " / challenge expires in " + left + "s");
          }
        }, 1000);
      })
      .catch(function (err) {
        setStatus("could not reach the server: " + err);
      });
  }

  document.getElementById("consent").addEventListener("click", function () {
    if (recording) return;
    recording = true;
    attach();
    gate.hidden = true;
    app.hidden = false;
    requestChallenge();
  });

  withdrawBtn.addEventListener("click", function () {
    recording = false;
    detach();
    resetAttempt();
    challenge = null;
    stopCountdown();
    setVerdict("", "");
    app.hidden = true;
    gate.hidden = false;
  });

  clearBtn.addEventListener("click", function () {
    if (!recording) return;
    resetAttempt();
    setVerdict("", "");
  });

  submitBtn.addEventListener("click", function () {
    if (!recording || challenge === null) return;
    if (samples.length < 2) return;
    submitBtn.disabled = true;
    setVerdict("verifying...", "");
    var payload = {
      challengeId: challenge.challengeId,
      samples: samples,
      startedAt: startedAt,
      endedAt: endedAt
    };
    fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
      .then(function (out) {
        if (out.status === 200) {
          if (out.body.verdict === "allow") {
            setVerdict("Verified: " + out.body.classification +
              " (score " + Number(out.body.score).toFixed(3) +
              ", confidence " + Number(out.body.confidence).toFixed(3) + ")", "ok");
          } else {
            setVerdict("Not verified: " + out.body.classification +
              (out.body.anomalies && out.body.anomalies.length
                ? " [" + out.body.anomalies.join(", ") + "]" : "") +
              " - please draw again.", "bad");
          }
          // The token is consumed either way; get a fresh challenge.
          requestChallenge();
          resetAttempt();
        } else {
          setVerdict("Rejected (" + out.status + "): " + (out.body.error || "unknown error"), "bad");
          if (out.status !== 422) { requestChallenge(); resetAttempt(); }
        }
      })
      .catch(function (err) {
        setVerdict("request failed: " + err, "bad");
        submitBtn.disabled = false;
      });
  });
})();
</script>
</body>
</html>
`;
