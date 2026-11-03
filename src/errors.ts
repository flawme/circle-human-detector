/**
 * Error codes emitted by this library.
 *
 * `INVALID_OPTIONS` and `INVALID_SAMPLES` are thrown for programming errors:
 * malformed options or structurally invalid input (non-finite coordinates,
 * wrong shapes). Data-quality problems — too few samples, too short a
 * stroke, a shape that is not circle-like — are never thrown; they are
 * reported through `classification: "INCONCLUSIVE"` and the anomaly list.
 */
export type ErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_SAMPLES"
  | "NOT_STARTED"
  | "NOT_RUNNING";

/**
 * Base error class for all errors thrown by this library.
 * Carries a machine-readable `code` alongside the message.
 */
export class CircleDetectorError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CircleDetectorError";
    this.code = code;
  }
}
