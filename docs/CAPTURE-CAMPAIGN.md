# Capture campaign: replacing the synthetic corpus with real humans

Every threshold in this package is calibrated against a synthetic
human model, and the physics-law audit proved that model does not
reproduce two of the three published motor laws
([EVALUATION.md](EVALUATION.md#physics-law-audit)). The real
false-positive rate across devices, motor abilities, and pointer
types is the one number standing between this package and a
production accuracy claim. This document is the plan for getting
that number.

## What you need

- [`examples/browser/collect.html`](../examples/browser/collect.html):
  open it directly from disk (`file://`). No server, no install, no
  network. It records nothing before consent and exports one labeled
  JSON file per drawing.
- One folder per device class on your disk.
- Participants, and their informed consent.

## The protocol (per participant)

1. **Consent first.** The page's own gate states what is captured
   (x/y positions, millisecond timestamps, pressure, pointer type),
   that nothing is transmitted, and that withdrawal purges everything.
   Let participants read it; drawing starts only after they click.
2. **Ten comfortable circles** at their natural speed. Label stays
   `human` (the default).
3. **Five fast circles**: one full turn in about a second. This is
   not a gimmick: browsers sample pointer input at frame rate
   (~60-120 events/second), so a fast one-second circle yields as few
   as 30-60 samples — the engine's coarse-sampling window, the exact
   regime where the regime-evasion study found the calibration
   envelope is an attack surface
   ([EVALUATION.md](EVALUATION.md)). Fast circles from real humans
   are the calibration data for that window; nobody has any yet.
4. **Five slow circles** (2-3+ seconds): probes the other tail —
   pauses, tremor, drift, `MID_STROKE_PAUSES` behavior.
5. **On touch and pen**: these matter beyond count. The engine's
   pressure metrics only activate with real pressure variation, so
   pen and touch captures exercise a metric the mouse corpus never
   touches.
6. **Accessibility, when possible**: a few participants using
   assistive pointers, or with tremor, turn the accessibility claims
   in [LIMITATIONS.md](LIMITATIONS.md) from policy into measurement.
   Never exclude a participant because their circles look unusual;
   that is exactly the data the engine must not accuse.

## Device matrix and round-1 targets

| Device class | Participants | Circles each | Round-1 strokes |
| --- | --- | --- | --- |
| Mouse (desktop) | 30+ | 20 | 600+ |
| Touch (phone/tablet) | 20+ | 20 | 400+ |
| Pen/stylus | 10+ | 20 | 200+ |

These are minimums for a first calibration read, not statistical
proof. More seeds beat cleverness; the synthetic calibration used
2000.

## Folder layout and evaluation

One flat folder per device class, every export dropped in with the
label left at `human`:

```text
captures/
  mouse/    # all mouse participants, all speed variants
  touch/
  pen/
```

Then, per class, from the repo root:

```sh
npm run evaluate:real -- captures/mouse
npm run evaluate:real -- captures/touch
npm run evaluate:real -- captures/pen
```

Separate folders give you per-device matrices — the false-positive
rate on a stylus is a different question from the rate on a trackpad,
and the tooling keeps them separate.

## Consent and data hygiene

- The export carries no identity: `label` (a free-text grouping tag),
  `consent`, `capturedAt`, `samples`. No user agent, no IP, no
  session id. Keep it that way; do not enrich the files.
- collect.html transmits nothing. The JSON lands on the
  participant's disk; they choose which files to send you.
- Tell participants what the data is for and who will see it before
  they draw. Keep raw files only as long as the round needs them,
  and honor withdrawal: the page purges on Withdraw, and a
  participant who asks to be dropped afterwards should be.
- The evaluator refuses any file whose `consent` is not `true`, with
  no override. Keep that invariant on your side too.

## Reading the results

- **Human SUSPICIOUS should read 0** at every preset. Any real human
  flagged SUSPICIOUS is a finding: file the capture, look at its
  anomalies and contributions, and understand it before tuning
  anything. One real-human false accusation outweighs a hundred
  clean passes.
- **INCONCLUSIVE rates per device class** are the
  graceful-degradation cost: mouse vs touch vs pen. High
  INCONCLUSIVE with zero SUSPICIOUS is the engine declining to
  accuse; that is the intended behavior, but its rate is your UX
  cost and you should know it.
- **Physics audit** (runs automatically over captures labeled
  `human`): if real-human `slopeW15` approaches the -1/3 target and
  SDN beta approaches 2, the two laws the synthetic corpus falsified
  become calibratable signature candidates. They are deliberately
  not signatures today.
- **Fast circles**: if any land SUSPICIOUS, the coarse-sampling
  window is not holding against real humans. The synthetic study
  says the window holds but with zero margin
  ([EVALUATION.md](EVALUATION.md)); this is the measurement that
  either confirms that or moves `minSamples`.

## Discipline: baseline first, tune second

Round 1 is a baseline. Freeze the thresholds, collect, read. If the
matrices justify tuning, tune on round 1, then collect a round 2 and
validate the tuned thresholds on data that had no influence on them.
Never tune and claim from the same round.

## What this campaign cannot give you

- **Bot-side realism**: the machine side of your matrices is only as
  good as the generators you feed it. The shipped evasion corpus
  already covers the known families
  ([EVALUATION.md](EVALUATION.md#evasion-attacks-red-team-corpus));
  prefer reading human-side numbers from this campaign.
- **Adversarial guarantees**: the synthesis and replay limits in
  [LIMITATIONS.md](LIMITATIONS.md) apply regardless of corpus size.
  A larger human corpus makes the calibration honest, not the
  adversary helpless.
