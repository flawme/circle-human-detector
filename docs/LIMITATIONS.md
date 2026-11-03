# Limitations, false positives, and false negatives

Read this before deploying. The library is a behavioral signal with
known blind spots on both sides. It estimates "did this movement look
human-generated", and no behavioral analysis can prove a human was
present.

## False positives (humans flagged as SUSPICIOUS)

Movements the engine may score as machine-consistent even though a
human produced them:

- **Very steady hands.** A human with unusually low tremor and very
  regular timing can drift toward the gray zone. The engine tries to
  leave margin (tremor anchors start at 0.04% of radius, far above any
  real pointer's noise floor), and low confidence produces INCONCLUSIVE
  rather than an accusation — but `strict` sensitivity will flag more
  of these than `balanced`.
- **Assistive input devices.** Head pointers, eye trackers, joystick
  emulators, and some switch-access setups produce movement that does
  not follow wrist/elbow posture modulation. These users can land in
  the gray zone or below it. **Accessibility consequence: never treat
  SUSPICIOUS as proof of a bot; treat it as "fall back to another
  challenge".**
- **Motor disabilities and tremor conditions.** Intentional tremor and
  some movement disorders change the tremor band (frequency and
  amplitude). The engine's tremor detection is deliberately
  wide-band (amplitude + positive autocorrelation) rather than
  tuned to 8-12 Hz, but extreme cases can still shift other metrics.
- **Deliberate slow/careful drawing.** Slow drawing shrinks angular
  velocity variation. The core-region kinematics and the confidence
  gate handle most of this, but a slow, metronome-paced circle drawn
  by a patient human looks statistically like a slow bot. Very slow or
  very finely sampled strokes (median step displacement below 1.5x the
  coordinate noise scale) are a separate case: the engine detects the
  regime (`MOTION_BELOW_NOISE_FLOOR`), stops evaluating per-step
  machine signatures, and typically returns INCONCLUSIVE rather than
  an accusation — but it will not confidently say HUMAN_LIKE either.
- **Capture pipelines that regularize data.** If your framework
  captures positions on a fixed timer (instead of event-driven
  pointermove), timestamps become uniform-ish and coordinates can be
  quantized. Parts of the timing and interpolation evidence then
  describe your pipeline, not the user. Use event-driven capture.

Design mitigation already in the engine: the verdict most often
degrades to INCONCLUSIVE (retry) rather than SUSPICIOUS, anomaly
penalties for weak signals are small, and `MID_STROKE_PAUSES` is a
symbolic penalty precisely because pauses are also an accessibility
pattern.

## False negatives (machines scored as HUMAN_LIKE)

What the engine catches (each with a hard anomaly or a metric designed
for it): naive parametric generation, added white noise, waypoint
interpolation, ramp-wrapped constant-speed generation, uniform
timestamps, instant starts.

What defeats it, in increasing order of attacker effort:

1. **Radius wander with faked timing (the cheap geometric bypass, now
   contained to a narrow-band corner).**
   A circle whose radius wanders slowly (an Ornstein-Uhlenbeck drift
   over +-12%) while angular velocity stays constant, with jittered
   timestamps and start/end ramps, fakes wobble, speed modulation,
   tremor amplitude, and jitter autocorrelation from a single
   low-frequency process. The `BROADBAND_RADIUS_WANDER` signature
   catches it through a coupling the generator cannot hide: injected
   radius wander tracks into speed (v ~ omega * r), destroying the
   low-frequency concentration of a human motor program, while the
   wander never moves the angular rate, which stays machine-steady.
   Measured after the fix: 0/20 seeds pass at `balanced` and `strict`
   across all three variants. Across a 40-seed sweep, exactly one
   narrow-band corner seed per variant still passes — each nearly
   tied to a corpus human on every signature axis, so no threshold on
   those axes removes it without firing on the calibration corpus —
   and high-score seeds can still pass `relaxed` (measured 4/40).
   See
   [EVALUATION.md](EVALUATION.md#evasion-attacks-red-team-corpus).
2. **Inverse-omega decoupling with a modeled motor program.** Keep
   the +-12% wander for all its fake-noise value, but divide the
   angular-velocity profile by it, so speed follows a modeled program
   (ramps plus 1-2 cycle modulation) instead of the radius. This
   defeats `BROADBAND_RADIUS_WANDER` by breaking the coupling it
   measures and passes 39/40 at synthesis-level scores (0.87-0.98).
   What it costs the attacker: an explicit speed-program model plus
   inverse kinematics — five of the synthesis's seven components,
   missing only tremor and pressure, both individually forgiving (see
   the ablation table). Closing it would mean demanding tremor or
   wobble amplitude, which the engine deliberately avoids: assistive
   pointers, styluses, and calm motor profiles are real human input.
   A physics-law audit (see
   [EVALUATION.md](EVALUATION.md#physics-law-audit)) measured the one
   channel that does separate this attack from the calibration
   corpus — movement smoothness: the inverse-omega machine is
   smoother than the human corpus median (log dimensionless jerk
   -8.88 vs -7.86, quartiles disjoint). It stays unshipped for the
   same reason the bypass stays open: the jerk channel is
   derivative-amplified noise, the corpus tails overlap (33 of 2000
   calibration humans are smoother than the jerkiest attack seed),
   and a minimum-jerkiness demand is a tremor-amplitude demand.
   Treat HUMAN_LIKE as one signal among several.
3. **Sampling-regime softness (the calibration envelope as an
   attack surface).** Every signature is calibrated on the corpus
   envelope (110-240 samples per stroke); the emission rate is the
   attacker's choice. Below the 46-step gate of
   `BROADBAND_RADIUS_WANDER` the window holds (0/20 leaks, coarse
   humans never accused, and the inverse-omega attack weakens to
   2/20), but just above the gate — a bare-minimum core, steps
   ~46-75 — the mid-band wander measurement smears below its
   ceiling while confidence clears: the contained wander family
   leaks 11/40 at steps 58 (6/20 pinned in the evasion suite),
   fading to 3/40 by steps 80 and 0/40 at 180. The best separating
   axis has no margin (angular-velocity CV 0.055 against the
   coarse-human minimum 0.057), so the zone is documented, not
   closed — closing it needs coarse-regime calibration on real
   human captures. If you control the capture pipeline, set
   `minSamples: 80` (coarser strokes then return INCONCLUSIVE, the
   honest verdict for low-evidence data).
4. **Sufficiently realistic motion synthesis.** A generator that
   replicates *all* of — autocorrelated tremor-band jitter, smooth
   1-2 cycle radius wobble, posture-driven speed modulation over the
   core of the sweep, ramped start/end, jittered timestamps, and
   varied pressure — satisfies every metric by construction. Measured:
   the full synthesis in the evasion suite passes 20/20; ablating
   speed modulation alone drops it to 6/20, the other components are
   individually forgiving. Behavioral analysis raises the cost of
   automation; it cannot eliminate it.
5. **Replay of recorded human strokes.** A captured genuine stroke,
   replayed with realistic event cadence, is indistinguishable from
   the original by any local analysis. Mitigation is outside this
   library's scope (nonces, single-use challenges, server-side
   session binding); the single-use challenge pattern is
   demonstrated in
   [examples/node/challenge-server.mjs](../examples/node/challenge-server.mjs).
6. **A human in the loop.** CAPTCHA-farm labor defeats every
   behavioral check by definition.

Operational consequence: use the verdict as one signal. Pair it with
rate limiting, attestation, device signals, and — for high-stakes
actions — secondary verification.

## What the engine deliberately does not claim

- **Geometric imperfection does not prove humanity.** A noisy circle
  with machine-consistent dynamics is SUSPICIOUS, not HUMAN_LIKE. The
  engine scores movement structure, not how sloppy the circle is.
- **HUMAN_LIKE is not identity.** It is a statement about movement
  statistics, not about who or what produced them. Never use it as
  authentication.
- **INCONCLUSIVE is a feature.** The engine refuses to guess when data
  is short, ambiguous, or not circle-like. Expect it for very short
  strokes, partial arcs, and adversarial inputs; handle it with a
  retry or fallback challenge.

## Privacy and consent

- The library performs no I/O, ships no telemetry, and stores nothing
  itself; samples live in memory until your code moves them.
- If you transmit samples (e.g., client-to-server analysis), that
  transmission is your policy decision. Disclose it and obtain
  explicit consent: pointer traces can reveal movement
  characteristics of the individual (biometric-adjacent data), and
  free-form drawing can incidentally contain identifying scribbles.
- Store the minimum: scores and verdicts, not raw traces, unless you
  have a documented retention need and consent basis.
- Some jurisdictions classify behavioral/biometric-adjacent data
  specially (e.g., GDPR, BIPA). Your use of this library may fall
  under those regimes; that determination is yours to make.

## Threat model summary

| Threat | Caught? | By |
| --- | --- | --- |
| Naive `dispatchEvent` loop | Yes | Constant angular velocity, uniform timestamps, zero residual |
| White-noise "jitter" | Yes | Autocorrelation metrics + `NOISE_WITHOUT_STRUCTURE` |
| Waypoint interpolation | Yes | Collinear runs, piecewise-constant speed |
| Ramps + jitter + noise (adversarial model) | Contained (INCONCLUSIVE) | Core-region kinematics, correlation structure, confidence gate |
| Coarse-sampling regime evasion (wander family) | Contained below the 46-step gate; documented softness zone above it | Confidence floor + remaining per-step signatures; see [EVALUATION.md](EVALUATION.md#evasion-attacks-red-team-corpus) |
| Full human-dynamics synthesis | No | Accepted limitation; raises attacker cost only |
| Stroke replay | No | Out of scope; needs nonces/single-use challenges — see the challenge example |
| Human CAPTCHA farm labor | No | Out of scope by definition |
