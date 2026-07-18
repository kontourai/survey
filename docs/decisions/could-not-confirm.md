---
status: current
subject: Could Not Confirm Review Outcome
decided: 2026-07-17
evidence:
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/147"
  - kind: doc
    ref: src/types.ts
  - kind: doc
    ref: src/review-proof.ts
---
# Could Not Confirm Review Outcome

## Context

A reviewer may make a diligent attempt without obtaining enough evidence to
accept, reject, or honestly escalate a candidate. Encoding that non-answer as
rejection, verification, or disputed projection changes the meaning of the
claim and contaminates confidence calibration with a label the reviewer did not
provide.

## Decision

`ReviewOutcome.resolution` is an additive terminal-resolution field. Existing
outcomes may omit it and retain status-inference behavior. The
`could_not_confirm` resolution requires a non-empty `resolutionReason`, may
carry `attemptEvidenceIds`, and is illegal with `verified` or `rejected` status.
It records actor and review time, but preserves the claim's pre-review proposed
or assumed status.
All explicit resolutions are status-checked: accepted requires verified or
assumed, rejected requires rejected, and held permits only non-rejected retained
postures.

Could-not-confirm is terminal for the review round, not the candidate set. It
does not create escalation, product apply actions, or a new Surface posture.
Projection is equivalent to the unreviewed path; attempt evidence and review
timing stay out of the bundle, and `{ reviewProofs: true }` deliberately omits a
Surface integrity anchor for this resolution. Canonical review proof v3 commits the resolution,
reason, and attempt ids while v1 and v2 proofs remain verifiable.

`could-not-confirm` deliberately bypasses `producerPolicy.decisionMode` because
that policy constrains candidate-selection actions and this resolution produces
none. Oversight metrics still count these decisions in `decisionCount` and
reviewer-behavior rates such as `overrideRate`; those metrics describe reviewer
activity, not correctness calibration.

Calibration excludes these outcomes from both numerator and denominator.
Survey learning projections emit `learning.could-not-confirm` so producers can
aggregate repeated unconfirmable targets without treating the signal as truth,
rejection, or comfort-zone posture.

## Deferred work

- Aggregation and threshold policy for repeated unconfirmables remains producer-owned.
