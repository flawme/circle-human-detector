/**
 * CircleDetector — the facade over collection + analysis.
 *
 * Two usage modes share one implementation:
 *
 * 1. DOM capture (browser): pass a `target` element; `start()` attaches
 *    a pointer-event collector to it and `analyze()` scores what was
 *    drawn.
 *
 *    ```ts
 *    const detector = new CircleDetector({ target: canvas, sensitivity: "balanced" });
 *    detector.start();
 *    // user draws...
 *    const result = detector.analyze();
 *    ```
 *
 * 2. Manual feeding (browser or Node): omit `target` and forward
 *    pointer events yourself.
 *
 *    ```ts
 *    const detector = new CircleDetector({ sensitivity: "balanced" });
 *    detector.start();
 *    detector.recordEvent({ type: "pointerdown", x: 10, y: 10, t: 0 });
 *    // ...pointermove events...
 *    detector.recordEvent({ type: "pointerup", x: 40, y: 12, t: 900 });
 *    const result = detector.analyze();
 *    ```
 *
 * The detector never throws on data-quality problems; those surface as
 * `classification: "INCONCLUSIVE"` with reasons in `anomalies`. It
 * throws only for programming errors (invalid options, malformed
 * events, feeding before `start()`).
 */

import type {
  CircleDetectionResult,
  DetectorOptions,
  PointerSample,
} from "./types.ts";
import { CircleDetectorError } from "./errors.ts";
import { analyzeSamples } from "./engine/analyze.ts";
import { resolveOptions } from "./engine/scoring.ts";
import {
  CircleCollector,
  SampleBuffer,
} from "./collector.ts";
import type { CollectorEventTarget } from "./collector.ts";

/** Options accepted by the `CircleDetector` facade. */
export interface CircleDetectorOptions extends DetectorOptions {
  /**
   * Element to capture pointer events from. When provided, `start()`
   * attaches a collector to it and strokes drawn on it are captured
   * automatically. Omit to feed events manually via `recordEvent`.
   */
  target?: CollectorEventTarget;
  /**
   * Coordinate source for DOM capture.
   * - `"offset"` (default): `offsetX/offsetY` (target-relative),
   *   falling back to `clientX/clientY`.
   * - `"client"`: raw `clientX/clientY`.
   */
  coordinates?: "offset" | "client";
}

/**
 * A pointer event fed manually via `recordEvent`. Mirrors the fields of
 * a DOM `PointerEvent` that matter for analysis. `t` is optional and
 * defaults to a monotonic clock reading (`performance.now()` when
 * available); supply it explicitly when replaying a recorded stream.
 */
export interface ManualPointerEvent {
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel";
  x: number;
  y: number;
  /** Monotonic timestamp in milliseconds. Defaults to now(). */
  t?: number;
  /** Normalized pressure 0..1 when available. */
  pressure?: number;
  /** Pointer hardware category: `"mouse"`, `"touch"`, `"pen"`. */
  pointerType?: string;
  width?: number;
}

/** Monotonic clock in milliseconds; `performance.now()` when available. */
function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/** Event types the facade accepts. */
const EVENT_TYPES: ReadonlySet<string> = new Set([
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
]);

/**
 * Collects and analyzes one circle-drawing interaction.
 *
 * The facade is deliberately small: it owns a sample buffer, optionally
 * wires a DOM collector into it, and delegates all scoring to
 * `analyzeSamples`. Classification behavior and error contracts are
 * documented on the engine.
 */
export class CircleDetector {
  private readonly options: CircleDetectorOptions;
  private readonly buffer = new SampleBuffer();
  private readonly collector: CircleCollector | null;
  private runningState = false;

  constructor(options: CircleDetectorOptions = {}) {
    // Validate eagerly so misconfiguration surfaces at construction,
    // not at analyze() time.
    resolveOptions(options);
    this.options = options;
    this.collector =
      options.target !== undefined
        ? new CircleCollector(options.target, {
            buffer: this.buffer,
            coordinates: options.coordinates ?? "offset",
          })
        : null;
  }

  /** Whether the detector is running (accepting events). */
  get running(): boolean {
    return this.runningState;
  }

  /** Samples captured so far, in order. */
  getSamples(): readonly PointerSample[] {
    return this.buffer.getSamples();
  }

  /**
   * Begin a new interaction: clears any previously captured samples and
   * (when constructed with a `target`) attaches the DOM collector.
   * Idempotent.
   */
  start(): void {
    this.buffer.clear();
    if (this.collector !== null) {
      this.collector.clear();
      this.collector.attach();
    }
    this.runningState = true;
  }

  /**
   * Stop accepting events. Detaches the DOM collector when present.
   * Already-captured samples are kept for `analyze()`. Idempotent.
   */
  stop(): void {
    if (this.collector !== null) {
      this.collector.detach();
    }
    this.runningState = false;
  }

  /**
   * Clear captured samples without changing the running state.
   * Call between attempts on the same surface.
   */
  reset(): void {
    this.buffer.clear();
  }

  /**
   * Feed one pointer event manually (no-DOM mode). Mirrors collector
   * semantics: `pointerdown` opens a stroke, moves record only while a
   * stroke is open, `pointerup`/`pointercancel` close it.
   *
   * @throws {CircleDetectorError} code `NOT_STARTED` before `start()`.
   * @throws {CircleDetectorError} code `INVALID_SAMPLES` when the event
   *   has an unknown `type` or non-finite coordinates/timestamp.
   */
  recordEvent(event: ManualPointerEvent): void {
    if (!this.runningState) {
      throw new CircleDetectorError(
        "NOT_STARTED",
        "recordEvent() was called before start(); call start() first",
      );
    }
    if (typeof event !== "object" || event === null || !EVENT_TYPES.has(event.type)) {
      throw new CircleDetectorError(
        "INVALID_SAMPLES",
        `recordEvent() expects type "pointerdown" | "pointermove" | "pointerup" | "pointercancel" (got ${JSON.stringify(
          (event as { type?: unknown } | null)?.type,
        )})`,
      );
    }
    if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) {
      throw new CircleDetectorError(
        "INVALID_SAMPLES",
        `recordEvent() expects finite x and y (got x=${String(event.x)}, y=${String(event.y)})`,
      );
    }
    const t = event.t ?? nowMs();
    if (!Number.isFinite(t)) {
      throw new CircleDetectorError(
        "INVALID_SAMPLES",
        `recordEvent() expects a finite t when provided (got ${String(t)})`,
      );
    }

    const sample: Omit<PointerSample, "stroke"> = {
      x: event.x,
      y: event.y,
      t,
      ...(event.pressure !== undefined ? { pressure: event.pressure } : {}),
      ...(event.pointerType !== undefined ? { pointerType: event.pointerType } : {}),
      ...(event.width !== undefined ? { width: event.width } : {}),
    };

    switch (event.type) {
      case "pointerdown":
        this.buffer.beginStroke();
        this.buffer.add(sample);
        break;
      case "pointermove":
        this.buffer.add(sample);
        break;
      case "pointerup":
      case "pointercancel":
        if (this.buffer.inStroke) {
          this.buffer.add(sample);
          this.buffer.endStroke();
        }
        break;
    }
  }

  /**
   * Analyze the captured interaction.
   *
   * Uses the constructor's sensitivity/threshold settings; pass
   * `override` to score the same samples under different settings
   * without recapturing.
   */
  analyze(override?: DetectorOptions): CircleDetectionResult {
    const merged: DetectorOptions = {
      sensitivity: this.options.sensitivity,
      thresholds: this.options.thresholds,
      minSamples: this.options.minSamples,
      minDurationMs: this.options.minDurationMs,
      minCoverageTurns: this.options.minCoverageTurns,
      pauseMs: this.options.pauseMs,
      ...override,
    };
    return analyzeSamples(this.buffer.getSamples(), merged);
  }
}
