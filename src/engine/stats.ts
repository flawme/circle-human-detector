/**
 * Small numeric utilities shared by the analysis engine.
 * Pure functions, no state, no environment access.
 */

/** Arithmetic mean. Returns 0 for an empty series. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample standard deviation (n-1 denominator). Returns 0 for < 2 values. */
export function std(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return Math.sqrt(acc / (n - 1));
}

/**
 * Coefficient of variation (std / |mean|).
 * Returns 0 when the mean is 0 or the series is too short, so a constant
 * series scores 0 variation and never divides by zero.
 */
export function cv(values: readonly number[]): number {
  const m = mean(values);
  if (m === 0) return 0;
  return std(values) / Math.abs(m);
}

/** Median. Returns 0 for an empty series. */
export function median(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    return sorted[mid] as number;
  }
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Clamp x into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Linear ramp: returns 0 at or below `lo`, 1 at or above `hi`,
 * linear in between. `hi <= lo` is rejected by callers' contract.
 */
export function ramp(x: number, lo: number, hi: number): number {
  if (hi <= lo) return x >= hi ? 1 : 0;
  if (x <= lo) return 0;
  if (x >= hi) return 1;
  return (x - lo) / (hi - lo);
}

/**
 * Piecewise-linear curve through (x, value) anchor points, clamped to the
 * first/last value outside the anchor range. Anchor x values must be
 * strictly ascending.
 *
 * All behavioral normalization ("how human-like is this value?") is
 * expressed through these curves so every threshold is inspectable and
 * testable in one place.
 */
export function curve(
  x: number,
  anchors: readonly (readonly [number, number])[],
): number {
  if (anchors.length === 0) return 0;
  const first = anchors[0] as readonly [number, number];
  if (x <= first[0]) return first[1];
  const last = anchors[anchors.length - 1] as readonly [number, number];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i] as readonly [number, number];
    const prev = anchors[i - 1] as readonly [number, number];
    if (x <= a[0]) {
      const t = (x - prev[0]) / (a[0] - prev[0]);
      return prev[1] + t * (a[1] - prev[1]);
    }
  }
  return last[1];
}

/**
 * Lag-1 autocorrelation of a series. Measures whether consecutive
 * deviations from the mean tend to agree (values near 1) or are
 * independent (values near 0). Returns 0 for short or constant series.
 */
export function lag1Autocorr(values: readonly number[]): number {
  const n = values.length;
  if (n < 4) return 0;
  const m = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] as number - m;
    den += d * d;
    if (i > 0) num += d * ((values[i - 1] as number) - m);
  }
  if (den <= 0) return 0;
  return num / den;
}

/**
 * Count distinct values in a series, treating values as equal when they
 * differ by at most `absTol` or `relTol * |value|`.
 */
export function countUnique(
  values: readonly number[],
  relTol: number,
  absTol: number,
): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let unique = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as number;
    const cur = sorted[i] as number;
    const tol = Math.max(absTol, relTol * Math.abs(prev));
    if (Math.abs(cur - prev) > tol) unique++;
  }
  return unique;
}
