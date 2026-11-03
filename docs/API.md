# API reference

`circle-human-detector` ships three entry points:

| Import | Module format | Contents |
| --- | --- | --- |
| `circle-human-detector` | ESM / CJS | Full public surface: `CircleDetector`, collector, engine, types. |
| `circle-human-detector/analyze` | ESM / CJS | Pure analysis engine + types. No DOM types at all — import this on the server. |
| `circle-human-detector/collector` | ESM / CJS | DOM capture layer (`CircleCollector`, `SampleBuffer`, DOM event types). |

---

## CircleDetector

The facade: collects a drawing interaction and scores it.

```ts
import { CircleDetector } from "circle-human-detector";
```

### Constructor

```ts
new CircleDetector(options?: CircleDetectorOptions)
```

Options are validated eagerly: invalid values throw
`CircleDetectorError` with code `INVALID_OPTIONS` at construction, not
at analysis time.

### CircleDetectorOptions

Extends [`DetectorOptions`](#detectoroptions) with:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `target` | `CollectorEventTarget` | — | Element to capture pointer events from. Omit for manual `recordEvent` feeding. |
| `coordinates` | `"offset" \| "client"` | `"offset"` | DOM coordinate source. `"offset"` uses `offsetX/offsetY` (target-relative) and falls back to `clientX/clientY`. |

### Methods

| Method | Behavior |
| --- | --- |
| `start()` | Clear any previous samples; attach the DOM collector (when `target` was given); enter the running state. Idempotent. |
| `stop()` | Detach the collector; leave the running state. Recorded samples are kept for `analyze()`. Idempotent. |
| `reset()` | Clear samples without changing the running state. Use between attempts on the same surface. |
| `recordEvent(event: ManualPointerEvent)` | Feed one pointer event (no-DOM mode). Mirrors collector stroke semantics: `pointerdown` opens a stroke, moves record only while a stroke is open, `pointerup`/`pointercancel` close it. |
| `analyze(override?: DetectorOptions)` | Score the captured samples. `override` re-scores the same samples under different settings without recapture. |
| `getSamples()` | The captured `PointerSample[]`, in order. |

`recordEvent` throws `CircleDetectorError`:

- code `NOT_STARTED` — called before `start()` or after `stop()`;
- code `INVALID_SAMPLES` — unknown event `type`, or non-finite
  coordinates/timestamp.

### ManualPointerEvent

```ts
interface ManualPointerEvent {
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel";
  x: number;
  y: number;
  /** Monotonic timestamp in ms. Defaults to performance.now(). */
  t?: number;
  pressure?: number;      // 0..1, when available
  pointerType?: string;   // "mouse" | "touch" | "pen"
  width?: number;          // contact width in px, when available
}
```

### Example (spec flow)

```ts
const detector = new CircleDetector({ sensitivity: "balanced" });
detector.start();

detector.recordEvent({ type: "pointerdown", x: 100, y: 120, t: 0 });
detector.recordEvent({ type: "pointermove", x: 110, y: 122, t: 12 });
// ...more moves...
detector.recordEvent({ type: "pointerup", x: 98, y: 118, t: 1450 });

const result = detector.analyze();
```

---

## analyzeSamples (pure engine)

```ts
import { analyzeSamples } from "circle-human-detector/analyze";

function analyzeSamples(
  samples: readonly PointerSample[],
  options?: DetectorOptions,
): CircleDetectionResult;
```

Environment-agnostic: no DOM types, no I/O, fully deterministic (same
input + options produce an identical result). Safe to call on
untrusted-but-structurally-valid sample arrays.

### Error contract

| Situation | Behavior |
| --- | --- |
| `samples` is not an array, or a sample has non-finite `x`/`y`/`t` | throws `CircleDetectorError` (`INVALID_SAMPLES`) with the offending index |
| Malformed options | throws `CircleDetectorError` (`INVALID_OPTIONS`) |
| Too few samples, too short, not circle-like, incomplete sweep, duplicate timestamps | never throws: the verdict is `INCONCLUSIVE` with the reason in `anomalies` |

Samples with non-increasing timestamps are dropped and counted in
`metrics.droppedSamples` (they are a data-quality defect, not a caller
bug).

### DetectorOptions

| Option | Type | Default | Constraint | Description |
| --- | --- | --- | --- | --- |
| `sensitivity` | `"relaxed" \| "balanced" \| "strict"` | `"balanced"` | — | Preset; see [Thresholds](#thresholds-and-presets). |
| `thresholds` | `Partial<Thresholds>` | preset values | each in [0, 1]; `suspiciousThreshold < humanThreshold` | Per-field preset overrides. |
| `minSamples` | `number` | `24` | integer >= 5 | Minimum samples for an analyzable interaction. |
| `minDurationMs` | `number` | `300` | > 0 | Minimum drawing duration (ms). |
| `minCoverageTurns` | `number` | `0.85` | in (0, 3] | Minimum swept angle in full turns to count as a circle. |
| `pauseMs` | `number` | `120` | > 0 | Gap that counts as a within-stroke pause (also requires >= 2.5x the median gap). |

### Thresholds

```ts
interface Thresholds {
  humanThreshold: number;      // score >= this -> HUMAN_LIKE (confidence permitting)
  suspiciousThreshold: number; // score <= this -> SUSPICIOUS (confidence permitting)
  minConfidence: number;       // confidence below this forces INCONCLUSIVE
}
```

### Thresholds and presets

Exported as `SENSITIVITY_PRESETS`:

| Preset | `humanThreshold` | `suspiciousThreshold` | `minConfidence` |
| --- | --- | --- | --- |
| `relaxed` | 0.48 | 0.26 | 0.30 |
| `balanced` | 0.58 | 0.33 | 0.40 |
| `strict` | 0.66 | 0.40 | 0.50 |

Scores between `suspiciousThreshold` and `humanThreshold` classify
`INCONCLUSIVE` — the detector refuses to guess in the gray zone.

---

## CircleDetectionResult

```ts
interface CircleDetectionResult {
  score: number;             // [0, 1] human-likelihood heuristic
  confidence: number;        // [0, 1]; 0 when not analyzable
  classification: Classification;
  anomalies: Anomaly[];
  metrics: BehavioralMetrics;
  contributions: MetricContribution[];
  dataQuality: DataQuality;
}

type Classification = "HUMAN_LIKE" | "SUSPICIOUS" | "INCONCLUSIVE";
```

`score` = weighted mean of per-metric human-likeness (see below), minus
anomaly penalties, clamped to [0, 1].

`confidence` = 0.45 x data sufficiency + 0.55 x cross-metric agreement.
Sufficiency ramps with sample count, duration, and angular coverage
above their configured floors. Agreement is the spread of the
discriminative metric values (metrics that separate human from machine;
trivially-satisfied checks like "no direction reversals" do not vote).
When a hard machine signature is present, agreement is floored at 0.75:
a single geometric artifact (for example the chord sagitta of waypoint
interpolation mimicking tremor) must not demote an otherwise unambiguous
machine verdict.

### Anomaly

```ts
interface Anomaly {
  code: AnomalyCode;
  severity: "low" | "medium" | "high";
  detail: string; // includes the observed value
}
```

### AnomalyCode catalog

Data quality (no score penalty; they explain or gate the verdict):

| Code | Meaning |
| --- | --- |
| `INSUFFICIENT_SAMPLES` | Fewer samples than `minSamples`. |
| `INSUFFICIENT_DURATION` | Shorter than `minDurationMs`. |
| `INCOMPLETE_CIRCLE` | Swept angle below `minCoverageTurns`. |
| `NOT_CIRCLE_LIKE` | Fit failed or residuals far beyond any circle (RMS > 40% of radius, or radius CV > 0.6). |
| `MOTION_BELOW_NOISE_FLOOR` | Median per-step displacement is below 1.5x the coordinate noise scale (radial residual x fitted radius). The stroke was drawn so slowly, or sampled so finely (e.g. coalesced high-rate events), that per-step speed and direction describe noise rather than motion. Per-step machine signatures are not evaluated; the verdict rests on aggregate evidence and typically lands in the gray band (INCONCLUSIVE). |

Machine signatures (each subtracts a penalty from the score):

| Code | Severity | Penalty | Meaning |
| --- | --- | --- | --- |
| `BROADBAND_RADIUS_WANDER` | high | 0.45 | Radius wander in the 4-9 cycle band (RMS above 1% of radius) whose speed program is either incoherent (under 55% of speed-spectrum energy at 1-2 cycles) or paired with near-steady angular velocity, or machine-steady rotation (angular velocity CV < 6%) with an incoherent program. A constant-omega generator's injected radius noise tracks into its own speed; humans pair wobble with a coherent motor program and posture-driven angular variation. Zero of 2000 calibration seeds fire it. |
| `CONSTANT_ANGULAR_VELOCITY` | high | 0.35 | Angular velocity CV < 1.2% over 24+ steps. Natural angular speed varies with hand posture. |
| `COLLINEAR_INTERPOLATION` | high | 0.30 | 4+ consecutive exactly-collinear, equal-step point triples: linear interpolation between waypoints. |
| `PIECEWISE_CONSTANT_SPEED` | high | 0.25 | 10+ consecutive identical per-step speeds. Natural motion never holds speed exactly constant. |
| `NOISE_WITHOUT_STRUCTURE` | high | 0.20 | Jitter amplitude in the human band but no temporal autocorrelation, and no natural radius wobble: synthetic noise on a generated path. |
| `ZERO_RADIAL_RESIDUAL` | high | 0.15 | Radial jitter < 0.02% of radius across 40+ samples. Real input pipelines always show sub-pixel noise. |
| `UNIFORM_TIMESTAMPS` | medium | 0.12 | Inter-sample interval CV < 0.4%. Real event delivery jitters. Corroborating evidence only (rAF-style capture can also look regular). |
| `NO_SPEED_MODULATION` | medium | 0.10 | No systematic speed variation across angular position over 30+ steps. |
| `INSTANT_START_VELOCITY` | medium | 0.10 | First 10% of steps already at ~full mean speed. Humans accelerate into a stroke. |
| `PRESSURE_INVARIANT` | low | 0.05 | Touch/pen pressure identical for every sample (20+). Some hardware reports constant pressure — hence low severity. |
| `EXCESSIVE_DIRECTION_CHANGES` | low | 0.05 | More genuine angular reversals than circling motion allows. |
| `MULTIPLE_STROKES` | low | 0.05 | Drawing completed in several strokes (unusual for a circle, but human-plausible). |
| `MID_STROKE_PAUSES` | low | 0.02 | Pauses within a stroke (also seen with deliberate or assistive input — symbolic penalty). |

The three per-step signatures (`NO_SPEED_MODULATION`,
`INSTANT_START_VELOCITY`, `EXCESSIVE_DIRECTION_CHANGES`) are not
evaluated when `MOTION_BELOW_NOISE_FLOOR` is present: below the noise
floor they are measurement artifacts of noise, not machine evidence.
`BROADBAND_RADIUS_WANDER` respects the same noise floor and needs 46+
steps, because its speed-spectrum components are calibrated on at least
32 core-region steps. Machine corpora run well above the noise floor
(measured minimum 2.8x the gate across 200 seeds per generator
variant), so no genuine machine signature loses its trigger.

### BehavioralMetrics

Raw metric values, grouped. All spatial values are scale- and
position-invariant (ratios and coefficients of variation), so the same
thresholds apply to a 40px phone circle and a 400px desktop circle.

- `sampleCount`, `strokeCount`, `durationMs`, `droppedSamples`,
  `pointerTypes`
- `geometry`: fitted center/radius, `fitRmsError`, `radiusCv`,
  `coverageTurns`, `closureGapRatio`, `radialWobble`,
  `radialResidual`, `radialResidualAutocorr`, `radialMidBandRms`
- `kinematics`: `meanSpeed`, `speedCv`, `speedModulation`,
  `angularVelocityCv`, `angularVelocityAutocorr`, `accelerationCv`,
  `accelerationAutocorr`, `startSpeedRatio`, `endSpeedRatio`,
  `directionChanges`, `medianStepDistance`, `speedLowBandShare`,
  `maxCollinearRun`, `maxConstantSpeedRun`
- `timing`: `dtCv`, `pauses`, `pauseMs`
- `pressure`: `available`, `cv`, `uniqueValues`

Kinematic variation metrics are computed over the **core region** of
the sweep (the middle 70% by time): start/end ramps are shared structure
— humans accelerate into strokes and competent generators copy that —
so the discriminative evidence is measured between the ramps.

### Metric weights

`contributions` reports each metric's normalized human-likeness and
effective weight:

| Metric | Weight | Reads |
| --- | --- | --- |
| `angularVelocityVariation` | 0.16 | Angular speed CV blended with its temporal autocorrelation (noise fakes CV, not structure). |
| `speedModulation` | 0.16 | Largest low-harmonic amplitude of the sector speed profile (narrow-band: noise cannot fake systematic modulation). |
| `radialWobble` | 0.12 | 1-2 cycle radius modulation amplitude, sector-averaged. |
| `radialTremor` | 0.10 | High-frequency radial jitter amplitude, blended with its autocorrelation. |
| `residualAutocorrelation` | 0.10 | Lag-1 autocorrelation of the radial residual — the primary tremor-vs-injected-noise discriminator. |
| `startEndDynamics` | 0.12 | Speed ramp into and out of the stroke. |
| `timestampIrregularity` | 0.06 | Inter-sample interval CV. Corroborating only: capture loops also look regular, and jitter is trivially fakeable. |
| `collinearFreedom` | 0.06 | Absence of collinear interpolation runs. |
| `directionStability` | 0.04 | Absence of genuine direction reversals. |
| `accelerationVariation` | 0.04 | Acceleration CV blended with its autocorrelation. |
| `pauseNaturalness` | 0.04 | Mid-stroke pauses (deliberate/assistive input is common — soft penalty). |
| `pressureVariation` | 0.05 | Only scored when usable touch/pen pressure exists; otherwise excluded and weights renormalize. |

### DataQuality

```ts
interface DataQuality {
  sufficientSamples: boolean;
  sufficientDuration: boolean;
  sufficientCoverage: boolean;
  circleFitOk: boolean;
  pressureAvailable: boolean;
  analyzable: boolean; // all of the above; false forces INCONCLUSIVE
}
```

---

## PointerSample

The unit of captured data, in both browser and server contexts:

```ts
interface PointerSample {
  x: number;           // surface pixels
  y: number;
  t: number;           // ms, monotonic
  pressure?: number;   // 0..1 when the device reports it
  pointerType?: string; // "mouse" | "touch" | "pen"
  width?: number;      // contact width in px when reported
  stroke?: number;     // stroke index; collector sets it automatically
}
```

---

## Errors

```ts
class CircleDetectorError extends Error {
  code: "INVALID_OPTIONS" | "INVALID_SAMPLES" | "NOT_STARTED" | "NOT_RUNNING";
  message: string;
}
```

All errors are programmer errors: malformed options or input shapes.
Data-quality problems never throw — they downgrade the verdict.

---

## Collector layer

`import { CircleCollector, SampleBuffer } from "circle-human-detector/collector";`

Use these directly when the facade is not a fit (custom targets, custom
event routing, capture in one place and analyze in another).

### CircleCollector

```ts
new CircleCollector(target: CollectorEventTarget, options?: {
  coordinates?: "offset" | "client"; // default "offset"
  buffer?: SampleBuffer;             // default: private buffer
})
```

| Member | Behavior |
| --- | --- |
| `attach()` / `detach()` | Start/stop listening. Detaching mid-stroke ends the capture session: the open stroke is closed and a fresh `pointerdown` is required after re-attaching. Idempotent. |
| `getSamples()` | Captured samples in order. |
| `clear()` | Drop samples and reset capture state. |
| `isAttached` | Whether currently listening. |
| `sampleBuffer` | The buffer being recorded into. |

Capture semantics:

- listens for `pointerdown` / `pointermove` / `pointerup` /
  `pointercancel` (Pointer Events);
- tracks the primary pointer only: the first pointerdown while idle owns
  the stroke, others are ignored until it lifts;
- uses `setPointerCapture`/`releasePointerCapture` when the target
  supports it, so strokes continue outside the element bounds;
- malformed events (non-finite coordinates/timestamps) are skipped
  defensively rather than corrupting the buffer.

### SampleBuffer

The stroke state machine, shared by the collector and the facade:

| Member | Behavior |
| --- | --- |
| `beginStroke()` | Open a stroke (ignored when one is open). |
| `add(sample)` | Record a sample into the open stroke (no-op when none). |
| `endStroke()` | Close the stroke; the next `beginStroke()` gets index + 1. |
| `inStroke` | Whether a stroke is open. |
| `getSamples()` | Defensive copy of the samples. |
| `clear()` | Drop everything, reset stroke state. |

### CollectorEventTarget / DomPointerEvent

Structural interfaces (the browser's `HTMLElement` and `PointerEvent`
satisfy them), so tests and alternative hosts can pass plain objects:

```ts
interface CollectorEventTarget {
  addEventListener(type: string, listener: (event: DomPointerEvent) => void): void;
  removeEventListener(type: string, listener: (event: DomPointerEvent) => void): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

interface DomPointerEvent {
  type: string;
  clientX: number;
  clientY: number;
  offsetX?: number;
  offsetY?: number;
  timeStamp: number;
  pointerId: number;
  pointerType: string;
  pressure: number;
  width?: number;
}
```

### CSS requirement

Give the drawing surface `touch-action: none`, or touch strokes will
be consumed by scrolling before they reach the collector:

```css
.draw-surface { touch-action: none; }
```
