---
status: current
subject: Reviewer Kind
decided: 2026-11-03
evidence:
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/359"
  - kind: doc
    ref: docs/record-contracts.md
  - kind: doc
    ref: src/producer-discipline.ts
---
# Reviewer Kind

A review outcome names its reviewer by `actor`, a label the producer chose. A
host that needs a person to decide certain items, such as routed contradictions
in accumulated memory, could not tell from the record whether a person or
another agent did.

## The host attests a reviewer kind (2026-11-03)

`ReviewOutcome`, `ReviewDecision` and `ReviewSessionEvent` carry
`reviewerKind: "human" | "agent" | "rule"`. The host that authenticated the
reviewer sets it on the session snapshot; the reviewer, the browser and a posted
event cannot. Replay and apply read the kind from the snapshot only, and the
stored event log records the snapshot's value over whatever a poster sent.

The kind decides Surface `confidenceBasis.reviewerAuthority` for a `verified` or
`assumed` claim (`human` is `operator`, `agent` and `rule` are `system`) and is
carried as `metadata.survey.reviewerKind` beside `reviewerKindInferred`. It
extends the one reviewer-authority derivation in `buildSurveyTrustBundle`; there
is no second mechanism. `evidenceStrength` is still driven by the auto-accept
policy actor alone.

A record with no kind keeps the authority it always had (the policy actor is a
rule, any other actor a human) and is marked `reviewerKindInferred: true`. An
inferred human is a default for an unlabelled actor, not an attestation, so a
consumer that requires a human decision refuses it. An unknown value is refused,
and `human` on `auto-accept-policy` is refused as a contradiction. These checks
live in `assertReviewerKind`, called from the gate every review-building and
review-projecting site already used (`assertReviewResolutionConsistency`).

Oversight metrics add `byReviewerKind`; the pooled aggregate is not a measure of
human review. Entity review outcomes carry the kind through the decision they
bind, so it is part of the outcome identity, and their mapping claims project
the same authority.

The kind is per session, so it attests the authenticated principal writing to
it. The MCP server authenticates nobody, so `survey_review_decide` refuses a
session attested human rather than stamp an agent's tool call as a person's.
Producer `confidenceBasis` overrides cannot raise an attested agent or rule to a
human authority. The review proof binds an attested kind (absent kind, same
digest), and calibration counts human labels only.

## Not decided

- Survey does not require a human for any record. Which items need one is the
  host's policy; Survey makes the requirement checkable.
