---
status: current
subject: Confidence Calibration from Review Outcomes
decided: 2026-07-12
evidence:
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/114"
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/137"
  - kind: adr
    ref: docs/adr/0003-inquiry-mapping-and-producer-proposals.md
  - kind: doc
    ref: src/calibration.ts
---
# Confidence Calibration from Review Outcomes

## Context

Every reviewed candidate in Survey is a labeled calibration sample: the
system-proposed candidate carried a stated confidence (the prediction), and the
human review either affirmed or overturned that value (the label). No eval
vendor can publish a calibration curve, because none of them own the review
outcomes — Survey does. Issue #114 framed the opening and the two design
questions this record answers: **where the calibration computation lives**, and
**how a calibration curve may feed auto-accept thresholds without violating
ADR 0003 §4 (proposals-only)**.

## Decision

**Calibration is a pure Survey-side derivation over review outcomes**
(`src/calibration.ts`: `deriveCalibration`), not a consumer-side computation.
Survey owns the source → extraction → candidate → review chain, so the labeled
samples live here and every downstream consumer reuses one derivation rather
than each re-deriving from its own store. The module mirrors
`oversight-metrics.ts`: a pure `deriveX` returning a metrics object plus an
`xToClaims` projection, deterministic with an injected `now` for windowing.

The derivation:

- **Prediction** = the confidence of the *system-proposed* candidate
  (`CandidateSet.selectedCandidateId`), falling back to its extraction's
  confidence. An outcome with no selected candidate or no finite confidence is
  skipped — there is no prediction to calibrate.
- **Label** = whether the human affirmed the proposed value. `verified`/`assumed`
  with no override → correct; `rejected` or an override to a different candidate
  → incorrect.
- **Grouping** by extractor and by (extractor, field); confidence is binned into
  equal-width deciles with per-bin empirical accuracy, a group **calibration gap**
  (mean stated confidence − empirical accuracy; positive = overconfident), and a
  **suggested threshold**.

### Two hard constraints

1. **Advisory only (ADR 0003 §4).** Calibration *informs* policy; it never
   decides. The `suggestedThreshold` is the lowest decile lower-bound whose
   top-contiguous run of populated bins clears a target accuracy — an operator
   MAY wire it into `autoAcceptMinConfidence` (`evaluateAutoAccept`), but
   calibration itself sets nothing. Projected claims carry status `proposed`,
   exactly like every other producer proposal.

2. **Human labels only.** Machine auto-accepts (`actor === AUTO_ACCEPT_ACTOR`)
   are excluded by default: an auto-accepted outcome is the threshold accepting
   its own guess, so counting it as a "correct" label would let the policy
   validate itself. `includeAutoAccepted` overrides this for offline analysis.

## Producing `conclusionConfidence.value` (#137)

The derivation's empirical accuracy is the natural calibrated conclusion
probability, so `buildSurveyTrustBundle` now *produces* it. With the
`calibration` option enabled, an **affirmed** claim's `conclusionConfidence.value`
is set to the affirmation rate of its extractor's proposals — the finer
(extractor, field) group when it clears a sample floor, else the extractor-level
group, else left unset (an ungrounded claim gets no number). `method` records
which granularity produced the value. This is the "produce" side of the confidence
loop: Survey previously only *carried* `comfortZone` and left `value` unset.

`conclusionConfidence.value` is "probability the conclusion is correct", so it is
produced **only for affirmed conclusions** (status `verified`/`assumed`).
Attaching an affirmation rate to a `rejected` (or not-yet-reviewed) conclusion
would assert the opposite of what the human decided, so those claims get no value.

Two honesty constraints hold here too:

- **Sample floor** (default 20) — below it, `value` stays unset rather than
  emitting a poorly-grounded number.
- **Prefer a longer history** — callers SHOULD pass precomputed `metrics` derived
  over more than the current batch; the batch-derived fallback is a convenience
  and carries a mild self-reference (a claim's own outcome is one sample in the
  group that sets its value). Either way this only enriches the emitted
  confidence; it never changes claim `status` (ADR 0003 §4).

## Deferred work

- **Consumer wiring** — a downstream consumer reading `suggestedThreshold` into
  its `autoAcceptMinConfidence` policy (still an operator decision, never automatic).
