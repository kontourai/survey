> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# Reviewed Current/Proposed Resolution

Survey will treat a reviewed current/proposed decision as a generic producer-side candidate-resolution pattern and provide a `reviewedCurrentProposedResolution(...)` helper as a specialization of `reviewedCandidateResolution(...)`. The helper belongs in Survey because it shapes a producer's current candidate, proposed candidate, selected candidate, and Review Outcome before the Surface boundary; producers still own review workflow, selected role, statuses, rationale, and domain-specific metadata.

Considered alternatives: keeping the pattern in each producer would preserve maximum flexibility but repeat the same candidate plumbing and make integrations less disciplined; moving it into Surface would blur the boundary because Surface evaluates claims and evidence after projection rather than owning producer-side candidate roles or review workflow.

The helper owns the generic Survey shape: current/proposed candidate roles, candidate set construction, selected candidate wiring, Review Outcome wiring, and role metadata. The caller owns producer policy and Surface vocabulary: selected role, review actor and timing, rationale, review status, selected and unselected claim statuses, raw sources, source locators, extraction confidence, claim type, subject, surface, and domain metadata such as proposal identifiers or learning signals.

The helper accepts full Survey observations for the current and proposed candidates rather than shorthand values. Observation authoring remains with existing helpers such as field and repeated observations, while reviewed current/proposed resolution only combines producer-authored observations into one reviewed candidate decision.

The public API should use `selectedCandidateRole` for the current/proposed choice so the selection is read as a candidate-set decision, not a user, workflow, or authorization role. For claim identity, the helper may accept one optional selected claim id to promote the selected candidate into the producer's canonical Surface claim. The unselected observation keeps the claim id supplied by the caller, so producers can keep losing candidates as candidate-specific history without Survey inventing identifiers or owning domain semantics.

The helper should not hard-code producer policy for claim statuses. It may default the selected claim status from the Review Outcome and default the unselected claim status to `superseded`, matching the generic reviewed candidate resolution behavior, while allowing callers to override statuses such as `rejected` when their producer workflow requires it.
