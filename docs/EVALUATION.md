# Evaluation methodology and recorded results

## What the benchmark measures — and what it does not

`npm run evaluate` scores the engine against a **synthetic corpus**: a
seeded, reproducible set of generated drawing streams. It answers:

> Does the engine behave as designed on modeled humans and modeled
> generators?

It does **not** answer "what accuracy will I see against real bots and
real users". Synthetic humans are a movement model with known
parameters; real humans are far more diverse (see
[LIMITATIONS.md](LIMITATIONS.md)). The benchmark is a regression gate:
if a change to the engine shifts these numbers, it changed detection
behavior, and the change should be justified.

## Corpus

All generators are seeded (`mulberry32`) and live in
`test/helpers/generators.ts`. 200 trials per class by default;
parameters are randomized per trial within these models:

| Class | Model |
| --- | --- |
| Human | Smooth angular-velocity modulation (1 and 2 cycles per sweep, amplitude 0.15-0.40), start/end speed ramps, low-frequency radius wobble (1-2 cycles, 1.5-5%), center drift, 8-12 Hz physiological tremor, sub-pixel white noise, timestamp jitter with occasional coalescing hiccups. 110-240 samples, 1.02-1.18 turns. |
| Parametric bot | Exact circle, constant angular velocity, uniform timestamps, no ramps. The naive generator. |
| Noisy bot | Parametric plus 0.5-2 px white positional noise. Amplitude fakes jitter; the jitter is temporally independent. |
| Waypoint bot | Sparse anchors (16-24) with straight-line interpolation between them (6-9 sub-steps per arc): exactly-collinear equal-step runs. |
| Adversarial bot | Parametric plus start/end ramps, timestamp jitter (CV ~0.17), and 0.5-1.5 px white noise. Models a generator author who has read the obvious signatures: it evades every hard anomaly but still lacks tremor structure, radius wobble, and posture-driven speed modulation. |
| Straight line | Not a circle: verifies non-circle input gates to INCONCLUSIVE. |

## Recorded results

Engine version 1.0.0, `sensitivity: "balanced"`, 200 trials per class
(the exact output of `npm run evaluate` on the recorded commit):

```
class          HUMAN_LIKE   SUSPICIOUS   INCONCLUSIVE   mean score   mean conf
---------------------------------------------------------------------------
human          100.0%       0.0%         0.0%           0.965        0.690
parametric     0.0%         100.0%       0.0%           0.000        0.783
noisy          0.0%         100.0%       0.0%           0.018        0.561
waypoint       0.0%         100.0%       0.0%           0.000        0.787
adversarial    0.0%         2.5%         97.5%          0.253        0.382
straight-line  0.0%         0.0%         100.0%         0.000        0.000
```

Gates enforced by the script (exit code 1 on failure):

- human model: >= 90% HUMAN_LIKE
- parametric / noisy / waypoint: >= 90% SUSPICIOUS and 0% HUMAN_LIKE
- adversarial: <= 2% HUMAN_LIKE — the documented false-negative bound
  on a generator that deliberately replicates ramp and timing behavior
- straight line: 100% INCONCLUSIVE

Reading the numbers honestly:

- The naive and mid-tier generators are caught at 100% with high
  confidence.
- The adversarial model is **contained, not convicted**: 97.5% lands in
  INCONCLUSIVE (metrics disagree), 2.5% in SUSPICIOUS, 0% accepted as
  HUMAN_LIKE. Containment is the correct outcome for a borderline
  evader — the engine refuses to certify it either way.
- A generator that additionally replicates autocorrelated tremor,
  smooth radius wobble, and posture-driven speed modulation would
  score as human on these metrics. That evasion is possible is an
  accepted limitation of all behavioral detection, documented in
  [LIMITATIONS.md](LIMITATIONS.md#false-negatives-machines-scored-as-human_like).

## Evasion attacks (red-team corpus)

Beyond the corpus above, a dedicated evasion suite
(`test/evasion.test.ts`, generators in `test/helpers/evasion.ts`)
attacks the engine with machines built to defeat it rather than to
represent common practice. Every generator is seeded; the numbers
below are measured at `sensitivity: "balanced"`, seeds 1-20 unless
noted, and are pinned by tests so any engine change moves them
visibly.

| Attack | What it fakes | Result |
| --- | --- | --- |
| Single spoofs (7 variants) | Exactly one human structure (tremor, wobble, speed modulation, pressure, timestamp jitter, autocorrelated noise, spline path) on an otherwise machine base | 0/20 HUMAN_LIKE each. No single faked structure rescues a machine. |
| Structure-free stack | Autocorrelated noise + timestamp jitter + ramps: every amplitude structure, no posture dynamics | 0/20 HUMAN_LIKE; 19/20 INCONCLUSIVE, 1/20 accused outright by the steady-rotation path of `BROADBAND_RADIUS_WANDER`. |
| Multi-stroke split | The circle drawn in 3 strokes (pipeline abuse) | 0/20 HUMAN_LIKE, all flagged `MULTIPLE_STROKES`. |
| Sloppy geometry | Radius wanders +-12% at constant angular velocity on a fixed timer | 1/20 leak at balanced (the leak still carries `UNIFORM_TIMESTAMPS`); 0/20 at strict. The coupling signature fires on 38/40 seeds across the wider sweep. |
| Wander + jitter | The sloppy attack plus human-like timestamp jitter | Contained: 0/20 at balanced and strict (was 14/20 and 6/20 before `BROADBAND_RADIUS_WANDER`). |
| Wander + jitter + ramps | Plus start/end ramps: the last machine signatures removed | Contained: 0/20 at balanced and strict (was 18/20 and 12/20). One narrow-band corner seed in 40 still passes; `relaxed` leaks 4/40. |
| Stealth wander | The wander walk scaled down to duck under the signature's mid-band ceiling | 3/40 leak at balanced, 0/40 at strict. Shrinking the walk gives up the fake amplitude: `NO_SPEED_MODULATION` fires on most seeds, and no scale restores the pre-patch pass rate (best case 8/40 at 40% scale). |
| Inverse-omega decoupling | Angular velocity divided by the walk, so speed follows a modeled program instead of the radius | Without a modeled speed program: 0/40 (a ramp envelope is flat across the core region, so the signature fires on every seed). With ramps + 1-2 cycle modulation: 39/40 pass at 0.87-0.98. The documented successor bypass. |
| Regime evasion (coarse sampling) | The wander family re-emitted at attacker-chosen sampling density — below the signature's 46-step gate, or in the softness zone just above it | Window (steps 24-45): contained 0/20, and the boundary attack weakens to 2/20 there. Softness zone (steps ~46-75): the wander family leaks 11/40 at the peak cell (steps 58; signature fires 20/40 vs 37-40/40 at steps 80+), fading to 3/40 by steps 80 and 0/40 at 180. Documented regime boundary — see below. |
| Full synthesis | Every measured structure synthesized (tremor, wobble, modulation, ramps, jitter, pressure) | 20/20 HUMAN_LIKE. The documented fundamental limit, now measured. |

Ablating the full synthesis shows which structures are load-bearing:
removing speed modulation drops containment to 6/20; removing tremor,
wobble, ramps, or jitter individually still passes 20/20 — the top
band is soft, and only modulation is individually decisive.

**Why the wander attack is contained.** The radius wander fakes
wobble, speed modulation, tremor amplitude, and jitter
autocorrelation from one low-frequency process, so every *single*
axis overlaps the human corpus: that was measured directly
(angular-velocity CV, sector radius-speed correlation, radius CV,
log dimensionless jerk, mid-band radius amplitude, speed-radius
correlation — every candidate's tails overlap; the last two were
checked over a 2000-seed corpus). What holds is a *conjunction*:
with constant angular velocity, the injected wander tracks into the
generator's own speed (`v ~ omega * r`), destroying the concentration
of speed-spectrum energy at 1-2 cycles that a human motor program
produces, while the wander never moves the angular rate itself.
Humans occupy every single-axis extreme but never the conjunction —
a quiet speed program comes with quiet radius, a wobbly radius with
a strong coherent program, because all of it derives from one motor
system. `BROADBAND_RADIUS_WANDER` fires on zero of 2000 calibration
seeds on either of its two paths and its 0.45 penalty means even a
perfect 1.0 base score cannot clear the balanced threshold.

What remains after the fix, measured across 40 seeds per variant:
exactly one narrow-band corner seed per variant still passes (sloppy
seed 2, wander+jitter seed 29, wander+jitter+ramps seed 26). Each is
nearly tied to a corpus human on every signature axis — no threshold
on those axes removes them without firing on the calibration corpus.
Escaping the signature requires tuning the wander slow and small
(toward human wobble) *and* accepting that the weakened fake noise
no longer lifts the score as high; the surviving seeds score
0.62-0.88 against a 0.98 synthesis.

**What the signature costs the attacker (measured by re-attack).** Two
counter-attacks were built against the signature directly. Shrinking
the walk under the ceiling (stealth wander) trades away the fake
amplitude that defeats the radial metrics — at 15% scale the attack
dies outright (`NO_SPEED_MODULATION` fires on every seed), and the
best scale leaks 8/40 at depressed scores. Decoupling speed from
radius (inverse-omega: divide the angular-velocity profile by the
walk) keeps the full wander but is fully contained unless the
attacker also models a 1-2 cycle speed modulation over the core
region — ramps alone are flat there, so the decoupled profile is
caught. With the full motor program the attack passes 39/40 at
synthesis-level scores (0.87-0.98), which is why it is documented as
the successor bypass rather than half-fixed: closing it would mean
demanding tremor or wobble amplitude, and the engine deliberately
does not accuse on motor-steadiness (assistive pointers, styluses,
and calm motor profiles are real human input).

**Regime evasion: the calibration envelope is an attack surface.**
Every signature above is calibrated on the corpus envelope
(110-240 samples, 1.1-2.4s sweeps) — but sampling density is the
attacker's choice, and `BROADBAND_RADIUS_WANDER` is gated at
steps >= 46 because the core spectrum needs the 32 core steps it was
calibrated on. Measured across the envelope boundary (all seeded;
`dtMeanMs` on the component machine models the attacker's emission
rate):

- **Below the gate (steps 24-45) the window holds.** The wander
  family stays at 0/20 there: the signature is off and the spectrum
  falls back to human-looking values, but the confidence floor
  (coarse cores carry less evidence) and the remaining per-step
  signatures contain it. The inverse-omega boundary attack also
  weakens in the window (2/20 — its fake motor program needs samples
  to register), and coarse humans are never accused: 0 SUSPICIOUS
  over 2000 coarse-calibration seeds, 723/2000 still pass at
  `balanced`, the rest are INCONCLUSIVE via the confidence gate —
  the correct verdict for low-evidence data.
- **Just above the gate (steps ~46-75) the signature softens.** At a
  bare-minimum core the walk's mid-band wander smears below the
  10-per-mille ceiling while confidence clears the floor: the wander
  family leaks 11/40 at steps 58 (6/20 over the pinned seed range),
  against its documented 1/40 at corpus scale. The leak fades to
  3/40 by steps 80 and 0/40 at 180. The best separating axis —
  angular-velocity CV < 0.055 — fires on zero of 1869 in-zone coarse
  humans but sits 0.002 above their measured minimum (0.057), and the
  one leaker above that threshold (CV 0.082) is inside the human
  range entirely. No margin, no signature: the zone is pinned as a
  BOUNDARY in the evasion suite instead.
- **Operational lever.** If you control the capture pipeline, raise
  the floor rather than trust the zone: `minSamples: 80` in the
  `analyzeSamples` options (or refusing challenges with fewer
  samples) keeps every submission inside the calibrated envelope,
  where wander containment is 0/20 and the leak rate is 1/40;
  coarser strokes return INCONCLUSIVE.

**Operational guidance.** `balanced` and `strict` now contain the
whole wander family on the 20-seed corpora; `relaxed` still passes
high-score wander seeds (4/40) because its 0.48 threshold sits below
what the 0.45 penalty can drag a 0.93+ score to — use it only where
false positives are costlier than misses. The corner seeds above and
the full synthesis remain as documented false negatives, so pair
behavioral detection with nonces, single-use challenges, rate limits,
or attestation — local behavioral analysis raises the cost of
automation; it cannot eliminate it.

## Physics-law audit

`npm run evaluate` ends with an informational physics-law audit
(`scripts/physics-audit.mts`): every corpus is measured against three
well-replicated laws of human motor control. The audit validates the
*corpora*, not the detector — it never affects the exit code, and its
findings are pinned in `test/physics.test.ts` so corpus or instrument
drift moves them visibly.

| Law | Published target | Instrument |
| --- | --- | --- |
| Two-thirds power law (Lacquaniti, Terzuolo & Viviani 1983) | Drawing speed follows `v = K * kappa^(-1/3)`: the OLS slope of log speed on log curvature is about -1/3 | Per-point speed and 3-point circumscribed curvature over the time-core (15-85% by time), slope at three smoothing conventions (raw / 5-pt / 15-pt) |
| Signal-dependent noise (Harris & Wolpert 1998) | Motor noise variance scales with the squared command magnitude: log-log exponent beta ~ 2 | Detrended within-window speed variance regressed on window mean speed |
| Movement smoothness (Flash & Hogan 1985) | Human movements approach minimum-jerk profiles | LDLJ = -ln(sqrt(T^5 * integral jerk^2 dt / L^2)) over the full sweep; higher = smoother |

Measured findings (seeded and reproducible; 2000-seed human corpus,
40-seed attack sweeps):

- **The human model does not reproduce the two-thirds power law.**
  Its slope is convention-unstable (-0.05 raw, -0.30 at 5-point, -0.47
  at 15-point smoothing) — the signature of phase alignment between
  two independent processes, not of speed responding to curvature.
  Direct evidence: ablating the speed modulation alone collapses the
  slope to -0.01. The inverse-omega attack (median -0.38 at 15-point)
  sits inside the human range [-0.96, -0.22] at every convention, so
  no threshold on this axis separates the documented successor bypass
  from the calibration corpus. Making the human model obey the law
  and then accusing law-violators would be self-fulfilling — it
  tests the generator, not the human. The law becomes calibratable
  only with real captures.
- **Signal-dependent noise is not modeled either.** The human corpus
  beta p50 is 0.03 — additive noise, where Harris-Wolpert predicts
  ~2. Machine corpora reach beta >> 2 from timestamp jitter alone (dt
  noise scales speed by itself), so a speed-domain SDN measure is
  confounded by timing noise even on real captures;
  position-domain noise would be the cleaner instrument. Documented
  corpus-modeling gap, not a signature.
- **The one separating channel is smoothness — deliberately not
  shipped.** The inverse-omega attack is smoother than the human
  corpus median (LDLJ -8.88 vs -7.86, quartiles disjoint): the only
  measured axis that separates the successor bypass from the corpus
  at all. It is rejected twice over. The tails overlap — 33 of 2000
  calibration humans (1.65%) are smoother than the jerkiest attack
  seed — so a smoothness floor accuses real people, and calm motor
  profiles, styluses, and assistive pointers lie beyond the corpus
  model entirely. And the jerk channel is derivative-amplified
  measurement noise: a smoothness floor is a tremor-amplitude
  demand, the exact accessibility move the engine rejects
  ([LIMITATIONS.md](LIMITATIONS.md#false-negatives-machines-scored-as-human_like), item 2).

The upgrade path is real-data collection: the instruments are
deterministic and reusable, and a consented real-human corpus run
through the same functions would make laws 1 and 2 calibratable —
moving the physics from an audit to a signature family. See
[How to evaluate against real data](#how-to-evaluate-against-real-data).

## How to evaluate against real data

The synthetic corpus is a placeholder for real captures. The package
ships the collection and evaluation flow for replacing it (device
targets and per-participant protocol:
[CAPTURE-CAMPAIGN.md](CAPTURE-CAMPAIGN.md)):

1. **Capture with consent.** Open
   [`examples/browser/collect.html`](../examples/browser/collect.html) —
   a self-contained page that runs straight from `file://` with no
   server, no build, and zero network requests. It records nothing
   until an explicit consent click attaches the pointer listeners;
   the Withdraw button detaches them and deletes every recorded
   sample. Draw a circle and export it as one JSON file per attempt:
   `{ label, consent, capturedAt, samples }`, where each sample is a
   `PointerSample` (`x`, `y`, `t`, `pointerType`, `pressure`,
   `stroke`).
2. **Label both sides.** Keep the default label `human` for real
   captures; produce machine captures with your own generators or
   scripted replays in the same file shape. Only files with
   `consent: true` are ever analyzed — the evaluator skips everything
   else with a named warning and has no override flag, by design
   ([LIMITATIONS.md](LIMITATIONS.md#privacy-and-consent)). Pointer
   traces are biometric-adjacent; collect under a real notice and
   share captures only with datasets you trust.
3. **Evaluate the folder.** `npm run evaluate:real -- <folder>`
   classifies every valid capture at all three sensitivity presets
   and prints a per-label confusion matrix per preset (counts of
   HUMAN_LIKE / SUSPICIOUS / INCONCLUSIVE, mean score and mean
   confidence). It also runs the physics-law audit over the captures
   labeled `human`: two-thirds power-law slope (raw / w5 / w15
   smoothing), SDN exponent, and LDLJ smoothness — the same
   instruments as the corpus audit above, now over your real
   captures. The command is report-only: it never gates and never
   tunes.
4. **Tune against your costs.** Choose the preset (or override
   thresholds via the `thresholds` option) that places your
   false-positive and false-negative rates at your product's
   acceptable operating point, then re-run both `npm run
   evaluate:real` on the capture folder and `npm run evaluate` on
   the synthetic gates: the seeded corpus is the regression baseline,
   your captures are the ground truth.
5. **Re-run after every engine upgrade.**

The capture-page export and the evaluator share one contract, pinned
in-memory by `test/real-eval.test.ts`: malformed captures and
non-consented files are skipped with named warnings, never silently
analyzed.

Do not publish accuracy claims from the synthetic corpus alone.
