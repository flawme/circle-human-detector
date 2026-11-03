import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CircleCollector,
  SampleBuffer,
} from "../src/collector.ts";
import type { DomPointerEvent } from "../src/collector.ts";

/** Minimal event target double with listener bookkeeping. */
class FakeTarget {
  readonly listeners = new Map<string, Set<(e: DomPointerEvent) => void>>();
  readonly capturedPointerIds: number[] = [];
  readonly releasedPointerIds: number[] = [];

  addEventListener(
    type: string,
    listener: (e: DomPointerEvent) => void,
  ): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    (this.listeners.get(type) as Set<(e: DomPointerEvent) => void>).add(listener);
  }

  removeEventListener(
    type: string,
    listener: (e: DomPointerEvent) => void,
  ): void {
    (this.listeners.get(type) as Set<(e: DomPointerEvent) => void>)?.delete(listener);
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointerIds.push(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.releasedPointerIds.push(pointerId);
  }

  dispatch(event: DomPointerEvent): void {
    const set = this.listeners.get(event.type);
    if (set !== undefined) {
      for (const listener of set) listener(event);
    }
  }
}

interface EventSpec {
  x?: number;
  y?: number;
  t?: number;
  pointerId?: number;
  pointerType?: string;
  pressure?: number;
}

function makeEvent(type: string, spec: EventSpec = {}): DomPointerEvent {
  return {
    type,
    clientX: spec.x ?? 0,
    clientY: spec.y ?? 0,
    offsetX: spec.x ?? 0,
    offsetY: spec.y ?? 0,
    timeStamp: spec.t ?? 0,
    pointerId: spec.pointerId ?? 1,
    pointerType: spec.pointerType ?? "mouse",
    pressure: spec.pressure ?? 0.5,
  };
}

function drawStroke(
  target: FakeTarget,
  points: Array<{ x: number; y: number }>,
  t0: number,
  pointerId = 1,
): void {
  target.dispatch(makeEvent("pointerdown", { ...points[0], t: t0, pointerId }));
  for (let i = 1; i < points.length - 1; i++) {
    target.dispatch(
      makeEvent("pointermove", { ...points[i], t: t0 + i * 10, pointerId }),
    );
  }
  target.dispatch(
    makeEvent("pointerup", {
      ...points[points.length - 1] as { x: number; y: number },
      t: t0 + (points.length - 1) * 10,
      pointerId,
    }),
  );
}

describe("SampleBuffer", () => {
  it("records samples only inside a stroke", () => {
    const buffer = new SampleBuffer();
    buffer.add({ x: 1, y: 1, t: 0 }); // no stroke open -> ignored
    assert.equal(buffer.getSamples().length, 0);

    buffer.beginStroke();
    buffer.add({ x: 2, y: 2, t: 1 });
    buffer.endStroke();
    buffer.add({ x: 3, y: 3, t: 2 }); // stroke closed -> ignored

    const samples = buffer.getSamples();
    assert.equal(samples.length, 1);
    assert.equal(samples[0]?.stroke, 0);
  });

  it("increments the stroke index per completed stroke", () => {
    const buffer = new SampleBuffer();
    buffer.beginStroke();
    buffer.add({ x: 0, y: 0, t: 0 });
    buffer.endStroke();
    buffer.beginStroke();
    buffer.add({ x: 5, y: 5, t: 10 });
    buffer.endStroke();

    const samples = buffer.getSamples();
    assert.equal(samples[0]?.stroke, 0);
    assert.equal(samples[1]?.stroke, 1);
  });

  it("ignores duplicate beginStroke and stray endStroke", () => {
    const buffer = new SampleBuffer();
    buffer.beginStroke();
    buffer.beginStroke(); // duplicate down mid-stroke
    buffer.add({ x: 0, y: 0, t: 0 });
    buffer.endStroke();
    buffer.endStroke(); // stray up
    buffer.beginStroke();
    buffer.add({ x: 1, y: 1, t: 5 });

    assert.equal(buffer.getSamples()[1]?.stroke, 1);
  });

  it("clear resets samples and stroke state", () => {
    const buffer = new SampleBuffer();
    buffer.beginStroke();
    buffer.add({ x: 0, y: 0, t: 0 });
    buffer.clear();
    assert.equal(buffer.getSamples().length, 0);
    assert.equal(buffer.inStroke, false);

    buffer.beginStroke();
    buffer.add({ x: 0, y: 0, t: 10 });
    assert.equal(buffer.getSamples()[0]?.stroke, 0);
  });

  it("hands out defensive copies", () => {
    const buffer = new SampleBuffer();
    buffer.beginStroke();
    buffer.add({ x: 0, y: 0, t: 0 });
    const first = buffer.getSamples();
    first.pop();
    assert.equal(buffer.getSamples().length, 1);
  });
});

describe("CircleCollector", () => {
  it("captures a full stroke with down, moves, and up", () => {
    const target = new FakeTarget();
    const collector = new CircleCollector(target);
    collector.attach();

    drawStroke(
      target,
      [
        { x: 0, y: 0 },
        { x: 5, y: 1 },
        { x: 9, y: 4 },
        { x: 12, y: 8 },
        { x: 13, y: 13 },
      ],
      100,
    );

    const samples = collector.getSamples();
    assert.equal(samples.length, 5); // down + 3 moves + up
    assert.equal(samples[0]?.t, 100);
    assert.equal(samples[4]?.t, 140);
    assert.ok(samples.every((s) => s.stroke === 0));
    assert.equal(samples[1]?.pointerType, "mouse");
  });

  it("tracks only the primary pointer during a stroke", () => {
    const target = new FakeTarget();
    const collector = new CircleCollector(target);
    collector.attach();

    target.dispatch(makeEvent("pointerdown", { x: 0, y: 0, t: 0, pointerId: 1 }));
    target.dispatch(makeEvent("pointermove", { x: 2, y: 0, t: 5, pointerId: 2 }));
    target.dispatch(makeEvent("pointerdown", { x: 50, y: 50, t: 6, pointerId: 2 }));
    target.dispatch(makeEvent("pointermove", { x: 4, y: 0, t: 10, pointerId: 1 }));

    const samples = collector.getSamples();
    // down(id1) + move(id1): everything from pointer 2 is ignored.
    assert.equal(samples.length, 2);
    assert.ok(samples.every((s) => s.x < 10));
  });

  it("numbers subsequent strokes with fresh indices", () => {
    const target = new FakeTarget();
    const collector = new CircleCollector(target);
    collector.attach();

    drawStroke(target, [{ x: 0, y: 0 }, { x: 1, y: 1 }], 0);
    drawStroke(target, [{ x: 10, y: 10 }, { x: 11, y: 11 }], 500);

    const samples = collector.getSamples();
    assert.equal(samples.length, 4);
    assert.equal(samples[0]?.stroke, 0);
    assert.equal(samples[3]?.stroke, 1);
  });

  it("ignores events while detached and resumes on attach", () => {
    const target = new FakeTarget();
    const collector = new CircleCollector(target);
    collector.attach();
    target.dispatch(makeEvent("pointerdown", { x: 0, y: 0, t: 0 }));
    collector.detach();

    target.dispatch(makeEvent("pointermove", { x: 5, y: 5, t: 5 }));
    assert.equal(collector.getSamples().length, 1);

    // Re-attaching forgets the interrupted stroke: a bare move records
    // nothing until a fresh pointerdown opens a new session.
    collector.attach();
    target.dispatch(makeEvent("pointermove", { x: 9, y: 9, t: 9 }));
    assert.equal(collector.getSamples().length, 1);

    target.dispatch(makeEvent("pointerdown", { x: 8, y: 8, t: 10 }));
    target.dispatch(makeEvent("pointermove", { x: 9, y: 9, t: 11 }));
    const samples = collector.getSamples();
    assert.equal(samples.length, 3);
    assert.equal(samples[1]?.stroke, 1);
    assert.equal(collector.isAttached, true);
  });

  it("uses client coordinates when configured", () => {
    const target = new FakeTarget();
    const collector = new CircleCollector(target, { coordinates: "client" });
    collector.attach();
    target.dispatch(makeEvent("pointermove", { x: 7, y: 9, t: 1 }));
    // No stroke open, so no sample: use a stroke to observe coordinates.
    target.dispatch(makeEvent("pointerdown", { x: 7, y: 9, t: 2 }));
    const sample = collector.getSamples()[0];
    assert.equal(sample?.x, 7);
    assert.equal(sample?.y, 9);
  });

  it("prefers offset coordinates by default and falls back to client", () => {
    const target = new FakeTarget();
    const collector = new CircleCollector(target);
    collector.attach();

    target.dispatch({
      type: "pointerdown",
      clientX: 100,
      clientY: 200,
      offsetX: 10,
      offsetY: 20,
      timeStamp: 0,
      pointerId: 1,
      pointerType: "mouse",
      pressure: 0.5,
    });
    assert.equal(collector.getSamples()[0]?.x, 10);

    target.dispatch({
      type: "pointermove",
      clientX: 111,
      clientY: 222,
      timeStamp: 1,
      pointerId: 1,
      pointerType: "mouse",
      pressure: 0.5,
    });
    assert.equal(collector.getSamples()[1]?.x, 111);
  });

  it("skips malformed events instead of corrupting the buffer", () => {
    const target = new FakeTarget();
    const collector = new CircleCollector(target);
    collector.attach();

    target.dispatch(makeEvent("pointerdown", { x: 0, y: 0, t: 0 }));
    target.dispatch({
      type: "pointermove",
      clientX: Number.NaN,
      clientY: 0,
      timeStamp: 5,
      pointerId: 1,
      pointerType: "mouse",
      pressure: 0.5,
    });
    target.dispatch({
      type: "pointermove",
      clientX: 3,
      clientY: 3,
      timeStamp: Number.NaN,
      pointerId: 1,
      pointerType: "mouse",
      pressure: 0.5,
    });
    assert.equal(collector.getSamples().length, 1);
  });

  it("uses pointer capture hooks when present", () => {
    const target = new FakeTarget();
    const collector = new CircleCollector(target);
    collector.attach();

    target.dispatch(makeEvent("pointerdown", { x: 0, y: 0, t: 0, pointerId: 7 }));
    assert.deepEqual(target.capturedPointerIds, [7]);
    assert.equal(target.releasedPointerIds.length, 0);

    target.dispatch(makeEvent("pointerup", { x: 1, y: 1, t: 5, pointerId: 7 }));
    assert.deepEqual(target.releasedPointerIds, [7]);
  });

  it("clear drops samples and pointer state", () => {
    const target = new FakeTarget();
    const collector = new CircleCollector(target);
    collector.attach();
    target.dispatch(makeEvent("pointerdown", { x: 0, y: 0, t: 0 }));
    collector.clear();
    assert.equal(collector.getSamples().length, 0);

    // A new stroke after clear starts at index 0 again.
    target.dispatch(makeEvent("pointerdown", { x: 1, y: 1, t: 10 }));
    assert.equal(collector.getSamples()[0]?.stroke, 0);
  });
});
