/**
 * Single-use challenge flow for server-side verification.
 *
 * The engine itself is stateless: samples in, verdict out. Replay
 * protection is integration policy, so it lives in this example
 * rather than in the package. `examples/node/challenge-server.mjs`
 * wires this module to `node:http`; this module is the pure half —
 * a token store and timeline validation with no HTTP, no clock
 * reads, and no randomness in the interfaces (`now` is always a
 * parameter), so `test/challenge.test.ts` pins it deterministically.
 *
 * Threat model, concretely: an attacker who recorded a genuine
 * human stroke and replays it. Two independent bars:
 *
 * 1. The challenge token is single-use. `consume()` deletes before
 *    it validates, and `Map.delete` is atomic within one JS tick,
 *    so concurrent submissions cannot both win the same id. Replay
 *    against the original token fails as "unknown".
 * 2. A fresh token does not help either: the submission carries
 *    wall-clock stamps (startedAt/endedAt), which
 *    `validateCaptureTimeline` binds to the challenge's lifetime.
 *    An old recording bears old stamps and fails the window.
 *
 * The samples' `t` values are monotonic-clock ms (performance.now()
 * family) and are never compared to wall time; only the client's
 * epoch stamps are. A splice (old trace, fresh stamps) still has to
 * keep its wall duration consistent with its monotonic duration, or
 * it is rejected as internally inconsistent.
 *
 * Multi-process deployments: keep the same semantics, back the
 * store with Redis or your session DB (`DELETE ... RETURNING`).
 * Production also wants rate limits per IP/session, which are
 * deliberately out of scope for an example.
 */
import { randomUUID } from "node:crypto";

import type { Classification, PointerSample } from "../../src/types.ts";

/** One issued, not-yet-consumed challenge. Epoch ms throughout. */
export interface ChallengeRecord {
  id: string;
  issuedAt: number;
  expiresAt: number;
}

/** Result of consuming a challenge id. */
export type ConsumeResult =
  | { status: "ok"; record: ChallengeRecord }
  | { status: "expired"; record: ChallengeRecord }
  | { status: "unknown" };

/** Store of live challenges. */
export interface ChallengeStore {
  /** Issue a fresh single-use challenge valid for `ttlMs`. */
  issue(now: number, ttlMs: number): ChallengeRecord;
  /** Consume a challenge. `ok` is returned exactly once per id. */
  consume(id: string, now: number): ConsumeResult;
  /** Number of live (unconsumed) challenges. */
  readonly size: number;
}

/**
 * In-memory challenge store. `consume` deletes before validating, so
 * a challenge is spent even when it turns out to be expired — a
 * replay attempt cannot retry an expired token until it succeeds.
 */
export function createChallengeStore(): ChallengeStore {
  const live = new Map<string, ChallengeRecord>();
  return {
    issue(now: number, ttlMs: number): ChallengeRecord {
      // Lazy sweep: abandoned challenges (fetched, never drawn) must
      // not accumulate without bound.
      if (live.size > 512) {
        for (const [id, rec] of live) {
          if (rec.expiresAt <= now) live.delete(id);
        }
      }
      const record: ChallengeRecord = {
        id: randomUUID(),
        issuedAt: now,
        expiresAt: now + ttlMs,
      };
      live.set(record.id, record);
      return record;
    },
    consume(id: string, now: number): ConsumeResult {
      const record = live.get(id);
      if (!record) return { status: "unknown" };
      live.delete(id); // single-use, atomic within the tick, before any validation
      if (now > record.expiresAt) return { status: "expired", record };
      return { status: "ok", record };
    },
    get size(): number {
      return live.size;
    },
  };
}

/** What the client submits alongside its samples. */
export interface CaptureSubmission {
  /** Recorded pointer samples, capture order, monotonic `t`. */
  samples: readonly PointerSample[];
  /** Epoch ms at the first pointerdown (client clock). */
  startedAt: number;
  /** Epoch ms at the final pointerup (client clock). */
  endedAt: number;
}

/** Result of timeline validation. */
export type TimelineVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/** Default clock-skew allowance for client wall-clock stamps. */
export const CLOCK_SKEW_MS = 3000;

/**
 * Bind a submission to its challenge window and to itself.
 *
 * Checks, in order:
 * 1. At least 2 samples with finite wall stamps.
 * 2. The drawing started no earlier than the challenge's issue time
 *    (minus skew) — an old replay fails here even with a fresh token.
 * 3. The drawing ended within the challenge's lifetime (plus skew)
 *    and not in the future beyond skew.
 * 4. `startedAt <= endedAt`.
 * 5. The wall-clock duration agrees with the samples' monotonic
 *    duration within `max(200ms, 20%)` — fresh stamps spliced onto
 *    an old trace must at least be internally consistent.
 */
export function validateCaptureTimeline(
  submission: CaptureSubmission,
  challenge: ChallengeRecord,
  now: number,
  skewMs: number = CLOCK_SKEW_MS,
): TimelineVerdict {
  const { samples, startedAt, endedAt } = submission;
  if (!Array.isArray(samples) || samples.length < 2) {
    return { ok: false, reason: "fewer than 2 samples" };
  }
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return { ok: false, reason: "non-finite wall-clock stamps" };
  }
  if (startedAt < challenge.issuedAt - skewMs) {
    return { ok: false, reason: "drawing started before the challenge was issued" };
  }
  if (endedAt > challenge.expiresAt + skewMs) {
    return { ok: false, reason: "drawing outlived the challenge window" };
  }
  if (endedAt > now + skewMs) {
    return { ok: false, reason: "drawing ended in the future beyond clock skew" };
  }
  if (startedAt > endedAt) {
    return { ok: false, reason: "endedAt before startedAt" };
  }
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  if (!Number.isFinite(first.t) || !Number.isFinite(last.t)) {
    return { ok: false, reason: "non-finite sample timestamps" };
  }
  const wallDuration = endedAt - startedAt;
  const monoDuration = last.t - first.t;
  const tolerance = Math.max(200, 0.2 * wallDuration);
  if (Math.abs(wallDuration - monoDuration) > tolerance) {
    return { ok: false, reason: "wall-clock duration disagrees with sample timestamps" };
  }
  return { ok: true };
}

/** What one stroke may decide. */
export type ServerVerdict = "allow" | "challenge-again";

/**
 * Policy for one stroke's classification: HUMAN_LIKE allows;
 * SUSPICIOUS and INCONCLUSIVE both re-challenge. A single behavioral
 * stroke may pass a session, but it never accuses — escalation to a
 * fallback signal (device attestation, rate limits, a second factor)
 * is the integrator's decision, made on repeated challenge-again
 * outcomes rather than on one drawing.
 */
export function verdictFor(classification: Classification): ServerVerdict {
  return classification === "HUMAN_LIKE" ? "allow" : "challenge-again";
}
