# Next Proof Backlog

Created: 2026-06-03.

This backlog tracks evidence Survey needs before adding more producer-facing
abstractions. These are proof targets, not implementation commitments.

## Why This Exists

The first source-authority builder proofs showed that
`sourceOfAuthorityObservationBuilder` is useful across public-directory and
regulated-rule producers. They also showed that the remaining friction is not
automatically Survey's to absorb.

Before adding another builder or helper, Survey should require one more
downstream proof that the pain is repeated Survey-shape friction rather than
producer policy, candidate classification, or product metadata.

## Proof 1: Current/Proposed Review Friction

Question: does Survey need a `ReviewedCurrentProposedResolutionBuilder`, or is
`reviewedCurrentProposedResolution` already the right API?

Collect a third call site where:

- the workflow compares an existing value and a proposed value
- both candidates should remain inspectable
- a review selects one candidate
- the existing helper is semantically correct
- the call site is still hard to read or easy to misuse after product-specific
  policy is factored out

Do not count friction that comes from:

- product approval policy
- learning-signal metadata
- canonical claim id policy
- candidate classification
- source-specific parsing

Exit criteria:

- If the third proof shows repeated Survey-shape boilerplate, shape a builder.
- If the third proof is still product policy, keep the existing helper.

## Proof 2: Per-Row Repeated Source Authority

Question: when does a repeated field need source-authority lineage per item
instead of aggregate repeated-field lineage?

Collect a producer example where:

- repeated items have independent source references or locators
- individual rows can be accepted, rejected, superseded, or disputed
- row-level evidence matters to downstream inspection
- aggregate repeated-array metadata is not enough

Do not build a source-authority-specific repeated helper until the producer can
show independent row identity and review lineage.

Exit criteria:

- If item-level lineage repeats across producers, consider a repeated
  source-authority observation pattern.
- If only one producer needs it, keep the shape local and project through
  existing observation helpers.

## Proof 3: Portable Authority Trace

Question: what does it look like when a producer can emit real Surface
`authorityTrace` records in addition to Survey source-authority posture?

Collect a producer example where:

- reviewer, role, organization, credential, policy, or system authority is
  available as portable data
- that authority can be verified independently of source posture
- the producer can connect authority evidence to review outcome or claim events
- `Evidence.metadata.sourceAuthority` still remains source posture, not actor
  authority

Do not populate `authorityTrace` from source authority alone.

Exit criteria:

- If a producer can emit portable actor/system authority, document the mapping
  and decide whether Survey needs a helper.
- If authority is only local workflow state, keep it in producer metadata and
  leave `authorityTrace` empty.

## Proof 4: Source Descriptor Reuse

Question: do producers repeatedly rebuild the same source descriptor, raw
source, and source-authority scope by hand?

Collect examples where:

- source descriptor metadata is stable across multiple observations
- many observations share the same source posture
- producers repeat source scope and raw-source metadata mechanically
- the repeated data is not product policy

Do not build a generic source descriptor helper if the repeated shape includes
product-specific policy or naming.

Exit criteria:

- If reuse is mostly mechanical, consider a source descriptor helper.
- If reuse is mostly product policy, keep it explicit.

## Committed Follow-Up: Rejected Candidate Learning Projection

Question: should Survey add a first-class `learning.rejected-candidate`
projection for ordinary candidate/extraction rejection feedback?

The downstream public-directory 0.4.4 proof showed a real gap. Producers need a
Survey-native way to route and evaluate rejected proposed values, but ordinary
rejection is not the same as reviewer authority/domain discomfort. The first
attempt to reuse `learning.comfort-zone` for every rejected proposal was
incorrect because `withinComfortZone: false` means the reviewer explicitly
recorded that a different authority or domain specialist should confirm the
conclusion.

Shape an additive projection that:

- emits from structured rejected-candidate or rejected-review data, such as
  `Candidate.rejectionReason` and/or a rejected `ReviewOutcome`
- does not require `withinComfortZone: false`
- keeps `learning.comfort-zone` limited to explicit comfort-zone posture
- keeps `learning.escalation` limited to unresolved escalation records
- carries product-neutral candidate, candidate-set, claim, review outcome,
  reason, source, and target references

Exit criteria:

- ordinary rejected candidates can produce rejected-candidate learning without
  emitting `learning.comfort-zone`
- rejected candidates with explicit `withinComfortZone: false` keep the
  comfort-zone signal distinct from rejected-candidate feedback
- downstream producers no longer need product-local projection glue for this
  generic learning case

## Committed Follow-Up: Review Apply Contract Hardening

Question: what else should Survey provide so downstream products can safely
apply reviewed results without rebuilding workbench mechanics or trusting
browser payloads?

The first public-directory and regulated-rule review proofs showed the same
boundary: Survey can derive selected candidates, review decisions, session
resources, and replayable events, but the product server owns authorization,
current-state validation, write policy, persistence, and audit stamps. The
important repeated friction was not a generic apply builder. It was the need to
replay events against a reviewed session snapshot before deriving write inputs.

Survey now exposes the narrow snapshot-safe replay/export helpers:
`replayReviewSessionEventsForSnapshot`, `deriveReviewSessionApplyResultForSnapshot`,
`validateReviewSessionEventsForSnapshot`, and the server-review-session module
(`createServerReviewSessionRecord`, `hashReviewSessionSnapshot`,
`assertServerReviewSessionFreshness`, `assertServerReviewSessionEvents`,
`deriveServerReviewSessionApplyResult`).

These helpers are implemented, tested, and exercised by the consumer examples at
`examples/review-workbench/facility-credential-consumer.ts` and
`examples/review-workbench/server-apply-consumer.ts`. Future work should stay
inside that policy-free lane.

Shape additive improvements only when they:

- validate or replay Survey review resources without deciding product policy
- make stale item or candidate references visible before product mutation
- preserve the distinction between trusted server replay and display-only
  browser exports
- help products map `ReviewWorkbenchResult` into Survey claim records or Surface
  transparency without applying values for them
- keep mutating actor, time, tenancy, authorization, and persistence in the
  producer

Do not build:

- a helper that applies selected values to product records
- a helper that chooses accept, reject, keep-current, or partial-apply policy
- a helper that treats browser-submitted `ReviewDecision` or
  `sessionExport.results` as authoritative for web writes
- a helper that stamps authenticated write actor or write time

Exit criteria:

- at least one more producer uses the snapshot-safe replay/export helpers
  without product-specific glue inside Survey
- the next integration can delete local session replay validation, not local
  product apply policy
- product documentation or UI can point from an applied value back to the Survey
  session, event trail, and derived result that justified the write

## Current Priority

1. Rejected candidate learning projection.
2. Review apply contract hardening.
3. Current/proposed review friction.
4. Per-row repeated source authority.
5. Portable Authority Trace.
6. Source descriptor reuse.

This order reflects current evidence. Reorder it when downstream integrations
produce stronger pain signals.

## Non-Goals

- Do not add builders because object literals are long.
- Do not hide product policy in Survey.
- Do not make Surface own producer-side review workflow.
- Do not infer veracity from source posture.
- Do not populate `authorityTrace` without portable authority evidence.
- Do not model ordinary rejected candidates as comfort-zone failures.
