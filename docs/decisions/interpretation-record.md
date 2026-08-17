---
status: current
subject: Interpretation Record
decided: 2026-08-17
evidence:
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/259"
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/16"
  - kind: adr
    ref: docs/adr/0003-inquiry-mapping-and-producer-proposals.md
  - kind: doc
    ref: src/to-surface.ts
  - kind: doc
    ref: docs/record-contracts.md
---
# Interpretation Record

## Context

Issue #259 asked for two interpretation layers on every verified claim —
"gleaned" (what this result taught) and "answer impact" (how it moved the
inquiry answer the claim feeds) — producer-side and review-visible. The
nearest existing slots posed a fork the issue deliberately left to an explicit
decision here: add two loose optional free-text fields to the claim/review
records, or generalize the existing `Interpretation` record, which already had
exactly the right shape (producer-authored, claim-bound via
`appliesToClaimId`, review-visible, Surface-projected through
`metadata.survey.interpretations[]`) but was hard-constrained to
policy-standard anchors by `requirePolicyStandardAnchor` in
`src/to-surface.ts`.

## Decision

Generalize the `Interpretation` record; do not add loose free-text fields.

Issue #16 is the controlling prior art: it created the Interpretation record
precisely because "free text lets producers skip the structure the record
should demand" — bare `ReviewOutcome.rationale` had already been found
insufficient for producer judgment. Two new optional string fields would have
recreated that insufficiency one layer up: unanchored, unattributed,
untimestamped prose beside the claim. The record form keeps every reading
claim-bound (`appliesToClaimId`), source-anchored (`anchorsToSourceId` +
`ruleLocator`), attributed (`actor`), and timestamped (`recordedAt`), with
referential integrity enforced at projection.

Concretely:

- `Interpretation.readingKind` is a new optional dimension:
  `"policy-standard"` (the original reading; absent means this, unchanged),
  `"gleaned"`, and `"answerImpact"`.
- `"answerImpact"` readings require the structured
  `answerImpact: "supported" | "narrowed" | "accepted-risk"` field — how the
  result moved the inquiry answer (inquiry-mapping); the field is illegal on
  other kinds, and unknown vocabulary fails projection closed.
- The policy-standard anchor requirement is relaxed ONLY for the new kinds:
  they may anchor to any KNOWN raw source (the result source the producer
  read); the `"policy-standard"` kind keeps its hard anchor exactly as before,
  and unknown anchor references still throw for every kind (#16 R3).
- Projection stays on the established channel: a `survey-interpretation`
  verification event, anchor evidence, and a typed
  `metadata.survey.interpretations[]` entry, which carries `readingKind` /
  `answerImpact` only when explicitly set so legacy projections stay
  byte-identical.
- Every reading is authored judgment and presents as such:
  `buildInterpretationReadingPresentation` stamps the derived
  `provenance: "authored-judgment"` marker and per-kind labels, keeping
  readings visually distinct from machine-observed facts (StatementBadge /
  ADR 0003 §4 discipline; blending is the defect class of #247).
- Additive-optional per the record-contracts versioning policy: no
  `SURVEY_INPUT_CONTRACT_VERSION` bump, and interpretations of any kind never
  enter canonical review-proof bytes (guarded by a proof-bytes-identical
  contract test).

## Deferred work

- Surfacing readings inside the review workbench UI itself (beyond the
  presentation helper) is consumer work; `ReviewItem` resources do not carry
  interpretations today and this decision does not add them.
- Aggregating answer-impact readings into inquiry-level rollups stays with
  consumers; Survey preserves the readings without deciding them.
