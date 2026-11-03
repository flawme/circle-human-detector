import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CircleDetector } from "../src/detector.ts";
import { CircleDetectorError } from "../src/errors.ts";
import {
  generateHumanCircle,
  generateMachineCircle,
} from "./helpers/generators.ts";
import type { DomPointerEvent } from "../src/collector.ts";
import type { PointerSample } from "../src/types.ts";

/** Replays PointerSample[] through recordEvent (down + moves + up). */
function replay(detector: CircleDetector, samples: readonly PointerSample[]): void {
  if (samples.length === 0) return;
  const first = samples[0] as PointerSample;
  detector.recordEvent({
    type: "pointerdown",
    x: first.x,
    y: first.y,
    t: first.t,
    pointerType: first.pointerType,
    pressure: first.pressure,
  });
  for (let i = 1; i < samples.length - 1; i++) {
    const s = samples[i] as PointerSample;
    detector.recordEvent({
      type: "pointermove",
      x: s.x,
      y: s.y,
      t: s.t,
      pointerType: s.pointerType,
      pressure: s.pressure,
    });
  }
  const last = samples[samples.length - 1] as PointerSample;
  detector.recordEvent({
    type: "pointerup",
    x: last.x,
    y: last.y,
    t: last.t,
    pointerType: last.pointerType,
    pressure: last.pressure,
  });
}

/** Minimal event target double. */
class FakeTarget {
  readonly listeners = new Map<string, Set<(e: DomPointerEvent) => void>>();

  addEventListener(type: string, listener: (e: DomPointerEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    (this.listeners.get(type) as Set<(e: DomPointerEvent) => void>).add(listener);
  }

  removeEventListener(type: string, listener: (e: DomPointerEvent) => void): void {
    (this.listeners.get(type) as Set<(e: DomPointerEvent) => void>)?.delete(listener);
  }

  dispatch(event: DomPointerEvent): void {
    const set = this.listeners.get(event.type);
    if (set !== undefined) {
      for (const listener of set) listener(event);
    }
  }
}

describe("CircleDetector: spec API (manual feeding, no DOM)", () => {
  it("follows the documented start/record/analyze flow", () => {
    const detector = new CircleDetector({ sensitivity: "balanced" });
    detector.start();

    const samples = generateHumanCircle({ seed: 3 });
    replay(detector, samples);

    const result = detector.analyze();
    assert.equal(result.classification, "HUMAN_LIKE");
    assert.equal(result.metrics.sampleCount, samples.length);
    assert.equal(result.metrics.strokeCount, 1);
  });

  it("flags machine replays as SUSPICIOUS", () => {
    const detector = new CircleDetector({ sensitivity: "balanced" });
    detector.start();
    replay(detector, generateMachineCircle({ seed: 5, variant: "parametric" }));
    assert.equal(detector.analyze().classification, "SUSPICIOUS");
  });

  it("throws NOT_STARTED when recording before start()", () => {
    const detector = new CircleDetector();
    assert.throws(
      () => detector.recordEvent({ type: "pointerdown", x: 0, y: 0, t: 0 }),
      (e: unknown) => e instanceof CircleDetectorError && e.code === "NOT_STARTED",
    );
  });

  it("throws NOT_STARTED after stop()", () => {
    const detector = new CircleDetector();
    detector.start();
    detector.stop();
    assert.throws(
      () => detector.recordEvent({ type: "pointerdown", x: 0, y: 0, t: 0 }),
      (e: unknown) => e instanceof CircleDetectorError && e.code === "NOT_STARTED",
    );
    assert.equal(detector.running, false);
  });

  it("start() resets captured samples", () => {
    const detector = new CircleDetector();
    detector.start();
    replay(detector, generateHumanCircle({ seed: 8 }));
    assert.ok(detector.getSamples().length > 0);

    detector.start();
    assert.equal(detector.getSamples().length, 0);
    const result = detector.analyze();
    assert.equal(result.classification, "INCONCLUSIVE");
    assert.equal(result.anomalies[0]?.code, "INSUFFICIENT_SAMPLES");
  });

  it("reset() clears samples but keeps the detector running", () => {
    const detector = new CircleDetector();
    detector.start();
    detector.recordEvent({ type: "pointerdown", x: 0, y: 0, t: 0 });
    detector.reset();
    assert.equal(detector.getSamples().length, 0);
    assert.equal(detector.running, true);

    detector.recordEvent({ type: "pointermove", x: 1, y: 0, t: 1 });
    assert.equal(detector.getSamples().length, 0); // no stroke open
  });
});

describe("CircleDetector: event semantics", () => {
  it("ignores moves outside a stroke and ups without a down", () => {
    const detector = new CircleDetector();
    detector.start();

    detector.recordEvent({ type: "pointermove", x: 5, y: 5, t: 1 });
    detector.recordEvent({ type: "pointerup", x: 6, y: 6, t: 2 });
    assert.equal(detector.getSamples().length, 0);

    detector.recordEvent({ type: "pointerdown", x: 0, y: 0, t: 3 });
    detector.recordEvent({ type: "pointermove", x: 1, y: 0, t: 4 });
    assert.equal(detector.getSamples().length, 2);
  });

  it("numbers manual strokes like the collector does", () => {
    const detector = new CircleDetector();
    detector.start();

    detector.recordEvent({ type: "pointerdown", x: 0, y: 0, t: 0 });
    detector.recordEvent({ type: "pointerup", x: 1, y: 1, t: 5 });
    detector.recordEvent({ type: "pointerdown", x: 2, y: 2, t: 10 });
    detector.recordEvent({ type: "pointerup", x: 3, y: 3, t: 15 });

    const samples = detector.getSamples();
    assert.equal(samples[0]?.stroke, 0);
    assert.equal(samples[3]?.stroke, 1);
    assert.equal(detector.analyze().metrics.strokeCount, 2);
  });

  it("rejects malformed events with INVALID_SAMPLES", () => {
    const detector = new CircleDetector();
    detector.start();

    assert.throws(
      () =>
        detector.recordEvent({
          type: "wheel" as ManualTypeCast,
          x: 0,
          y: 0,
          t: 0,
        }),
      (e: unknown) => e instanceof CircleDetectorError && e.code === "INVALID_SAMPLES",
    );
    assert.throws(
      () => detector.recordEvent({ type: "pointermove", x: Number.NaN, y: 0, t: 0 }),
      CircleDetectorError,
    );
    assert.throws(
      () => detector.recordEvent({ type: "pointermove", x: 0, y: 0, t: Number.NaN }),
      CircleDetectorError,
    );
  });

  it("defaults timestamps to a monotonic clock", () => {
    const detector = new CircleDetector();
    detector.start();
    detector.recordEvent({ type: "pointerdown", x: 0, y: 0 });
    detector.recordEvent({ type: "pointermove", x: 1, y: 0 });

    const samples = detector.getSamples();
    assert.equal(samples.length, 2);
    assert.ok(typeof (samples[0] as PointerSample).t === "number");
    assert.ok((samples[1] as PointerSample).t >= (samples[0] as PointerSample).t);
  });
});

type ManualTypeCast = "pointerdown" | "pointermove" | "pointerup" | "pointercancel";

describe("CircleDetector: DOM capture mode", () => {
  function domDraw(target: FakeTarget, samples: readonly PointerSample[]): void {
    for (const s of samples) {
      target.dispatch({
        type: s === samples[0] ? "pointerdown" : s === samples[samples.length - 1] ? "pointerup" : "pointermove",
        clientX: s.x,
        clientY: s.y,
        offsetX: s.x,
        offsetY: s.y,
        timeStamp: s.t,
        pointerId: 1,
        pointerType: "mouse",
        pressure: 0.5,
      });
    }
  }

  it("captures strokes from a target element end to end", () => {
    const target = new FakeTarget();
    const detector = new CircleDetector({ target, sensitivity: "balanced" });
    detector.start();

    domDraw(target, generateHumanCircle({ seed: 12 }));
    const result = detector.analyze();
    assert.equal(result.classification, "HUMAN_LIKE");

    detector.stop();
    target.dispatch({
      type: "pointermove",
      clientX: 1,
      clientY: 1,
      timeStamp: 99999,
      pointerId: 1,
      pointerType: "mouse",
      pressure: 0.5,
    });
    const afterStop = detector.getSamples().length;
    detector.start(); // resets and re-attaches
    assert.equal(detector.getSamples().length, 0);
    assert.equal(detector.running, true);
    assert.ok(afterStop > 0);
  });

  it("validates options at construction time", () => {
    const target = new FakeTarget();
    assert.throws(
      () => new CircleDetector({ target, sensitivity: "nope" as never }),
      (e: unknown) => e instanceof CircleDetectorError && e.code === "INVALID_OPTIONS",
    );
    assert.throws(
      () => new CircleDetector({ target, minSamples: 2 }),
      CircleDetectorError,
    );
  });

  it("analyze() accepts per-call overrides without recapture", () => {
    const target = new FakeTarget();
    const detector = new CircleDetector({ target, sensitivity: "balanced" });
    detector.start();
    domDraw(target, generateMachineCircle({ seed: 21, variant: "parametric" }));

    const balanced = detector.analyze();
    const strict = detector.analyze({ sensitivity: "strict" });
    assert.equal(balanced.classification, "SUSPICIOUS");
    assert.equal(strict.classification, "SUSPICIOUS");
    assert.deepEqual(balanced.metrics, strict.metrics);
  });
});
