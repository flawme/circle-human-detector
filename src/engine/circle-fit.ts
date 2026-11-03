/**
 * Algebraic circle fitting (Kasa method).
 *
 * Fits x^2 + y^2 + D*x + E*y + F = 0 to the samples with linear least
 * squares via the normal equations, solved with Cramer's rule. This is
 * the standard closed-form circle fit: fast, deterministic, and good
 * enough for a reference shape — the detector never treats fit residuals
 * as proof of humanity, so suboptimality of the fit under heavy noise is
 * acceptable.
 */

/** Result of fitting a circle to a set of 2D points. */
export interface CircleFitResult {
  /** False when the fit is degenerate (too few / collinear / coincident points). */
  ok: boolean;
  cx: number;
  cy: number;
  /** Radius in the same units as the input coordinates. 0 when `ok` is false. */
  r: number;
  /**
   * RMS of (distance to center - radius), divided by radius.
   * 0 when `ok` is false.
   */
  rmsError: number;
}

interface Point2D {
  x: number;
  y: number;
}

/**
 * Fit a circle to points. Never throws; degenerate configurations
 * (fewer than 3 points, coincident or exactly collinear points) return
 * `ok: false` with zeroed fields.
 */
export function fitCircle(points: readonly Point2D[]): CircleFitResult {
  const fail: CircleFitResult = { ok: false, cx: 0, cy: 0, r: 0, rmsError: 0 };
  const n = points.length;
  if (n < 3) return fail;

  // Sums for the normal equations.
  let Sx = 0;
  let Sy = 0;
  let Sxx = 0;
  let Syy = 0;
  let Sxy = 0;
  let Sxz = 0; // sum of x * (x^2 + y^2)
  let Syz = 0; // sum of y * (x^2 + y^2)
  let Sz = 0; // sum of (x^2 + y^2)
  for (const p of points) {
    const z = p.x * p.x + p.y * p.y;
    Sx += p.x;
    Sy += p.y;
    Sxx += p.x * p.x;
    Syy += p.y * p.y;
    Sxy += p.x * p.y;
    Sxz += p.x * z;
    Syz += p.y * z;
    Sz += z;
  }

  // Normal matrix M * [D, E, F]^T = [-Sxz, -Syz, -Sz]^T
  // M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]]
  const a11 = Sxx;
  const a12 = Sxy;
  const a13 = Sx;
  const a21 = Sxy;
  const a22 = Syy;
  const a23 = Sy;
  const a31 = Sx;
  const a32 = Sy;
  const a33 = n;

  const det =
    a11 * (a22 * a33 - a23 * a32) -
    a12 * (a21 * a33 - a23 * a31) +
    a13 * (a21 * a32 - a22 * a31);

  // Scale of the problem, used for a dimensionless degeneracy threshold.
  // For n points on a circle of radius r, det(M) ~ n^3 * r^4 *independent
  // of where the circle sits relative to the origin* (expand the normal
  // matrix around the mean: the constant terms cancel). So the reference
  // scale must come from the points' own spread, not their distance from
  // the origin, or small circles drawn far from the origin get rejected.
  const mx = Sx / n;
  const my = Sy / n;
  let vxx = 0;
  let vyy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    vxx += dx * dx;
    vyy += dy * dy;
  }
  const spread2 = (vxx + vyy) / n; // ~ r^2 for a circle
  if (!(spread2 > 0) || !Number.isFinite(det)) return fail;
  const detThreshold = 1e-9 * n * n * n * spread2 * spread2;
  if (Math.abs(det) <= detThreshold) return fail;

  const b1 = -Sxz;
  const b2 = -Syz;
  const b3 = -Sz;

  // Cramer's rule: replace the corresponding column with b.
  const detD =
    b1 * (a22 * a33 - a23 * a32) -
    a12 * (b2 * a33 - a23 * b3) +
    a13 * (b2 * a32 - a22 * b3);
  const detE =
    a11 * (b2 * a33 - a23 * b3) -
    b1 * (a21 * a33 - a23 * a31) +
    a13 * (a21 * b3 - b2 * a31);
  const detF =
    a11 * (a22 * b3 - b2 * a32) -
    a12 * (a21 * b3 - b2 * a31) +
    b1 * (a21 * a32 - a22 * a31);

  const D = detD / det;
  const E = detE / det;
  const F = detF / det;

  const cx = -D / 2;
  const cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  if (!Number.isFinite(r2) || r2 <= 0) return fail;
  const r = Math.sqrt(r2);

  // Relative RMS residual of distances to the fitted radius.
  let sumSq = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.sqrt(dx * dx + dy * dy) - r;
    sumSq += d * d;
  }
  const rmsError = Math.sqrt(sumSq / n) / r;

  return { ok: true, cx, cy, r, rmsError };
}
