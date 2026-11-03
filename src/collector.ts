/**
 * Browser pointer-event capture.
 *
 * This layer is a thin translator: DOM pointer events in, environment-
 * agnostic `PointerSample`s out. All analysis lives in the engine, so
 * this module holds no detection logic and can be swapped or replaced
 * by a custom capture pipeline that feeds the same samples.
 *
 * Recommended setup on the drawing surface (CSS):
 *
 * ```css
 * .draw-surface { touch-action: none; }
 * ```
 *
 * `touch-action: none` prevents scrolling/zooming from consuming touch
 * input mid-stroke. No data ever leaves this module: samples are held
 * in memory and released only to the caller via `getSamples()`.
 */

import type { PointerSample } from "./types.ts";

/**
 * Structural view of the pointer events this collector consumes. The
 * browser's `PointerEvent` satisfies it; tests and alternative hosts can
 * supply plain objects with the same fields.
 */
export interface DomPointerEvent {
  type: string;
  clientX: number;
  clientY: number;
  /** Target-relative coordinates; preferred when present. */
  offsetX?: number;
  offsetY?: number;
  /** Monotonic timestamp in milliseconds (event.timeStamp). */
  timeStamp: number;
  pointerId: number;
  pointerType: string;
  pressure: number;
  width?: number;
  height?: number;
}

/**
 * Structural view of the event target this collector attaches to. The
 * browser's `HTMLElement` satisfies it. Pointer capture hooks are
 * optional and used when present so the collector also works with
 * minimal test doubles.
 */
export interface CollectorEventTarget {
  addEventListener(
    type: string,
    listener: (event: DomPointerEvent) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: DomPointerEvent) => void,
  ): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

/** Options for `CircleCollector`. */
export interface CircleCollectorOptions {
  /**
   * Coordinate source:
   * - `"offset"` (default): `event.offsetX/offsetY`, falling back to
   *   `clientX/clientY`. Usually what a drawing surface wants.
   * - `"client"`: raw `clientX/clientY`.
   */
  coordinates?: "offset" | "client";
  /**
   * Buffer to record into. When omitted a private buffer is created;
   * pass one to share a buffer with another collector or component.
   */
  buffer?: SampleBuffer;
}

/**
 * Ordered stroke buffer. Owns the pointerdown/pointerup state machine
 * so DOM capture and manual event feeding share exactly one
 * implementation of stroke semantics:
 *
 * - `pointerdown` begins a stroke (duplicates while drawing are ignored).
 * - Samples are only recorded while a stroke is active.
 * - `pointerup`/`pointercancel` record the final position and close the
 *   stroke; the next `pointerdown` opens stroke index + 1.
 */
export class SampleBuffer {
  private samples: PointerSample[] = [];
  private strokeIndex = 0;
  private drawing = false;

  /** Whether a stroke is currently open. */
  get inStroke(): boolean {
    return this.drawing;
  }

  /** Begin a stroke. Ignored when a stroke is already open. */
  beginStroke(): void {
    if (this.drawing) return;
    this.drawing = true;
  }

  /** Close the open stroke. Ignored when no stroke is open. */
  endStroke(): void {
    if (!this.drawing) return;
    this.drawing = false;
    this.strokeIndex++;
  }

  /** Record a sample into the open stroke. No-op when no stroke is open. */
  add(sample: Omit<PointerSample, "stroke">): void {
    if (!this.drawing) return;
    this.samples.push({ ...sample, stroke: this.strokeIndex });
  }

  /** A copy of the recorded samples, in capture order. */
  getSamples(): PointerSample[] {
    return [...this.samples];
  }

  /** Drop all recorded samples and reset the stroke state. */
  clear(): void {
    this.samples = [];
    this.strokeIndex = 0;
    this.drawing = false;
  }
}

/**
 * Captures pointer events from a target element into a `SampleBuffer`.
 *
 * Tracks the primary pointer only: the first pointerdown while idle
 * owns the stroke, and events from other pointers are ignored until it
 * lifts. Uses pointer capture when the target supports it so a stroke
 * continues even when the pointer leaves the element.
 */
export class CircleCollector {
  private readonly target: CollectorEventTarget;
  private readonly buffer: SampleBuffer;
  private readonly useOffsetCoordinates: boolean;
  private attached = false;
  private activePointerId: number | null = null;

  constructor(target: CollectorEventTarget, options?: CircleCollectorOptions) {
    this.target = target;
    this.buffer = options?.buffer ?? new SampleBuffer();
    this.useOffsetCoordinates = (options?.coordinates ?? "offset") === "offset";
  }

  /** Whether the collector is currently listening. */
  get isAttached(): boolean {
    return this.attached;
  }

  /** The buffer this collector records into. */
  get sampleBuffer(): SampleBuffer {
    return this.buffer;
  }

  /** Start listening for pointer events. Idempotent. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.target.addEventListener("pointerdown", this.onPointerDown);
    this.target.addEventListener("pointermove", this.onPointerMove);
    this.target.addEventListener("pointerup", this.onPointerUp);
    this.target.addEventListener("pointercancel", this.onPointerUp);
  }

  /** Stop listening. Idempotent. Recorded samples are kept.
   *
   * Detaching mid-stroke ends the capture session: the active pointer
   * is forgotten, the open stroke is closed, and recording resumes only
   * after a fresh `pointerdown` once re-attached (a collector that was
   * not listening cannot know whether the physical pointer is still
   * down, so it never merges across a detach).
   */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.activePointerId = null;
    if (this.buffer.inStroke) {
      this.buffer.endStroke();
    }
    this.target.removeEventListener("pointerdown", this.onPointerDown);
    this.target.removeEventListener("pointermove", this.onPointerMove);
    this.target.removeEventListener("pointerup", this.onPointerUp);
    this.target.removeEventListener("pointercancel", this.onPointerUp);
  }

  /** Recorded samples, in capture order. */
  getSamples(): PointerSample[] {
    return this.buffer.getSamples();
  }

  /** Drop all recorded samples and reset capture state. */
  clear(): void {
    this.buffer.clear();
    this.activePointerId = null;
  }

  private readonly onPointerDown = (event: DomPointerEvent): void => {
    if (this.activePointerId !== null) return;
    if (!Number.isFinite(event.pointerId)) return;
    this.activePointerId = event.pointerId;
    this.buffer.beginStroke();
    this.trySetPointerCapture(event.pointerId);
    this.push(event);
  };

  private readonly onPointerMove = (event: DomPointerEvent): void => {
    if (this.activePointerId === null) return;
    if (event.pointerId !== this.activePointerId) return;
    this.push(event);
  };

  private readonly onPointerUp = (event: DomPointerEvent): void => {
    if (this.activePointerId === null) return;
    if (event.pointerId !== this.activePointerId) return;
    this.push(event);
    this.buffer.endStroke();
    this.tryReleasePointerCapture(event.pointerId);
    this.activePointerId = null;
  };

  private push(event: DomPointerEvent): void {
    const x = this.useOffsetCoordinates
      ? (Number.isFinite(event.offsetX) ? (event.offsetX as number) : event.clientX)
      : event.clientX;
    const y = this.useOffsetCoordinates
      ? (Number.isFinite(event.offsetY) ? (event.offsetY as number) : event.clientY)
      : event.clientY;
    // Malformed coordinates (never produced by real DOM events) are
    // skipped defensively rather than corrupting the buffer.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!Number.isFinite(event.timeStamp)) return;
    this.buffer.add({
      x,
      y,
      t: event.timeStamp,
      ...(typeof event.pressure === "number" ? { pressure: event.pressure } : {}),
      ...(typeof event.pointerType === "string"
        ? { pointerType: event.pointerType }
        : {}),
      ...(typeof event.width === "number" ? { width: event.width } : {}),
    });
  }

  private trySetPointerCapture(pointerId: number): void {
    try {
      this.target.setPointerCapture?.(pointerId);
    } catch {
      // Pointer capture is best-effort; some targets reject it while
      // not being in an active pointer session.
    }
  }

  private tryReleasePointerCapture(pointerId: number): void {
    try {
      this.target.releasePointerCapture?.(pointerId);
    } catch {
      // Best-effort, mirroring setPointerCapture.
    }
  }
}
