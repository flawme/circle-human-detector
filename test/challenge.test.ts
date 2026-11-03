import test from "node:test";
import assert from "node:assert/strict";

import type { PointerSample } from "../src/types.ts";
import {
  CLOCK_SKEW_MS,
  createChallengeStore,
  validateCaptureTimeline,
  verdictFor,
  type ChallengeRecord,
} from "../examples/node/challenge.mts";

/**
 * Pins for the single-use challenge flow
 * (examples/node/challenge.mts, wired to HTTP in
 * examples/node/challenge-server.mjs). Pure logic: every clock value
 * is a parameter, so these pins cover the two replay bars — token
 * single-use and wall-clock window binding — without any network.
 */

function samplesOver(ms: number, count = 50): PointerSample[] {
  const dt = ms / (count - 1);
  return Array.from({ length: count }, (_, i) => ({ x: 100 + i, y: 200 + i, t: i * dt }));
}

function challengeAt(issuedAt: number, ttlMs: number): ChallengeRecord {
  return { id: "challenge-fixture", issuedAt, expiresAt: issuedAt + ttlMs };
}

test("challenge: issue and consume exactly once", () => {
  const store = createChallengeStore();
  const record = store.issue(1_000, 60_000);
  assert.equal(typeof record.id, "string");
  assert.ok(record.id.length > 0);
  assert.equal(record.issuedAt, 1_000);
  assert.equal(record.expiresAt, 61_000);
  assert.equal(store.size, 1);

  const consumed = store.consume(record.id, 2_000);
  assert.equal(consumed.status, "ok");
  assert.deepEqual(consumed.record, record);
  assert.equal(store.size, 0, "consumed challenge leaves the store");

  const replayed = store.consume(record.id, 2_500);
  assert.equal(replayed.status, "unknown", "a consumed id is spent forever");
});

test("challenge: unknown ids and expired challenges", () => {
  const store = createChallengeStore();

  const neverIssued = store.consume("no-such-id", 1_000);
  assert.equal(neverIssued.status, "unknown");

  const short = store.issue(0, 1_000);
  const late = store.consume(short.id, 5_000);
  assert.equal(late.status, "expired");
  assert.deepEqual(late.record, short, "expired consume still returns the record");

  // An expired token is also spent: retrying it never succeeds.
  const retry = store.consume(short.id, 5_100);
  assert.equal(retry.status, "unknown");
});

test("challenge: abandoned challenges are swept lazily", () => {
  const store = createChallengeStore();
  for (let i = 0; i < 600; i++) {
    store.issue(0, 1_000);
  }
  assert.equal(store.size, 600);
  // The next issue after expiry sweeps the backlog down to the live set.
  const fresh = store.issue(10_000, 60_000);
  assert.equal(store.size, 1, "expired challenges must not accumulate");
  assert.equal(store.consume(fresh.id, 10_500).status, "ok");
});

test("challenge: a capture inside the window validates", () => {
  const challenge = challengeAt(10_000, 120_000);
  const verdict = validateCaptureTimeline(
    { samples: samplesOver(1_000), startedAt: 10_500, endedAt: 11_500 },
    challenge,
    15_000,
  );
  assert.deepEqual(verdict, { ok: true });
});

test("challenge: an old recording fails a fresh challenge's window", () => {
  const challenge = challengeAt(10_000, 120_000);
  // Samples and wall stamps from an hour ago, submitted against a
  // challenge issued now: this is the replay case.
  const verdict = validateCaptureTimeline(
    { samples: samplesOver(1_500), startedAt: 1_500, endedAt: 3_000 },
    challenge,
    15_000,
  );
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /before the challenge was issued/);
});

test("challenge: spliced stamps must be internally consistent", () => {
  const challenge = challengeAt(10_000, 120_000);
  // Fresh wall stamps claiming a 1000 ms drawing, samples telling a
  // 5000 ms story: rejected.
  const mismatch = validateCaptureTimeline(
    { samples: samplesOver(5_000), startedAt: 10_500, endedAt: 11_500 },
    challenge,
    15_000,
  );
  assert.equal(mismatch.ok, false);
  assert.match((mismatch as { reason: string }).reason, /duration disagrees/);

  // 20% + 200 ms tolerance: a 150 ms disagreement on a 1000 ms wall
  // duration is accepted (timer/batching slack, not an attack).
  const slack = validateCaptureTimeline(
    { samples: samplesOver(1_150), startedAt: 10_500, endedAt: 11_500 },
    challenge,
    15_000,
  );
  assert.deepEqual(slack, { ok: true });
});

test("challenge: future stamps and outlived windows are rejected", () => {
  const challenge = challengeAt(10_000, 120_000);
  // Ended beyond expiresAt + skew: outlived.
  const outlived = validateCaptureTimeline(
    { samples: samplesOver(1_000), startedAt: 140_000, endedAt: 141_000 },
    challenge,
    145_000,
  );
  assert.equal(outlived.ok, false);
  assert.match((outlived as { reason: string }).reason, /outlived/);

  // Ended beyond now + skew: clock nonsense.
  const future = validateCaptureTimeline(
    { samples: samplesOver(1_000), startedAt: 10_500, endedAt: 60_000 },
    challenge,
    15_000,
  );
  assert.equal(future.ok, false);
  assert.match((future as { reason: string }).reason, /future/);

  // startedAt after endedAt.
  const inverted = validateCaptureTimeline(
    { samples: samplesOver(1_000), startedAt: 11_500, endedAt: 10_500 },
    challenge,
    15_000,
  );
  assert.equal(inverted.ok, false);
  assert.match((inverted as { reason: string }).reason, /endedAt before startedAt/);
});

test("challenge: malformed submissions are rejected, not thrown on", () => {
  const challenge = challengeAt(10_000, 120_000);
  const tooFew = validateCaptureTimeline(
    { samples: samplesOver(10, 1), startedAt: 10_500, endedAt: 11_500 },
    challenge,
    15_000,
  );
  assert.equal(tooFew.ok, false);
  assert.match((tooFew as { reason: string }).reason, /fewer than 2 samples/);

  const nonFinite = validateCaptureTimeline(
    { samples: samplesOver(1_000), startedAt: Number.NaN, endedAt: 11_500 },
    challenge,
    15_000,
  );
  assert.equal(nonFinite.ok, false);
  assert.match((nonFinite as { reason: string }).reason, /non-finite/);
});

test("challenge: the clock-skew allowance is honored", () => {
  const challenge = challengeAt(10_000, 120_000);
  // Started 500 ms before issue: inside the default 3000 ms skew.
  const withinSkew = validateCaptureTimeline(
    { samples: samplesOver(1_000), startedAt: 9_500, endedAt: 10_500 },
    challenge,
    15_000,
  );
  assert.deepEqual(withinSkew, { ok: true });

  // Same submission with a tight 100 ms skew: rejected.
  const tightSkew = validateCaptureTimeline(
    { samples: samplesOver(1_000), startedAt: 9_500, endedAt: 10_500 },
    challenge,
    15_000,
    100,
  );
  assert.equal(tightSkew.ok, false);
  assert.equal(CLOCK_SKEW_MS, 3_000);
});

test("challenge: one stroke can pass, never accuse", () => {
  assert.equal(verdictFor("HUMAN_LIKE"), "allow");
  assert.equal(verdictFor("SUSPICIOUS"), "challenge-again");
  assert.equal(verdictFor("INCONCLUSIVE"), "challenge-again");
});

test("challenge: the full replay path fails on both bars", () => {
  const store = createChallengeStore();
  // An hour ago: a challenge was issued and its token consumed.
  const hourAgo = 60 * 60 * 1000;
  const original = store.issue(1_000, 60_000);
  assert.equal(store.consume(original.id, 2_000).status, "ok");

  // Now: the attacker requests a fresh challenge and submits the old
  // recording against it.
  const fresh = store.issue(hourAgo + 10_000, 120_000);
  const replay = validateCaptureTimeline(
    { samples: samplesOver(1_500), startedAt: 1_500, endedAt: 3_000 },
    fresh,
    hourAgo + 15_000,
  );
  assert.equal(replay.ok, false, "old wall stamps fail the fresh window");

  // And the spent token is spent regardless.
  assert.equal(store.consume(original.id, hourAgo + 15_000).status, "unknown");
  // The fresh token still works for a genuinely new drawing.
  const genuine = validateCaptureTimeline(
    { samples: samplesOver(1_200), startedAt: hourAgo + 11_000, endedAt: hourAgo + 12_200 },
    fresh,
    hourAgo + 15_000,
  );
  assert.deepEqual(genuine, { ok: true });
});
