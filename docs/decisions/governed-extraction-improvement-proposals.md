---
status: current
subject: Extraction Improvement Proposal
decided: 2026-07-22
evidence:
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/157"
  - kind: doc
    ref: docs/record-contracts.md
  - kind: doc
    ref: src/extraction-improvement-proposal.ts
---
# Extraction Improvement Proposal

## Decision

Survey represents reviewed extraction improvements as immutable, data-only
proposals. The proposal references an upstream-owned task by version, digest,
and example digests instead of defining or storing a second task-spec contract.
It derives complete extraction/import, proposal, review, source snapshot,
prepared-artifact, and excerpt-locator lineage only after verifying joins among
the canonical import, generated review item, review decision, and concrete
Survey review outcome. Each canonical record is included by digest.

The producer must supply a structured diagnosis. An accepted extraction may
request a grounded positive example or guidance affirmation; a bad extraction
may request an example addition or guidance update; insufficient source evidence
requests source remediation and cannot claim that a task change is warranted.
Survey does not infer a diagnosis from reviewer rationale.

Approval emits a separate producer activation request, never a live activation.
It references the immutable draft, a new task-spec version, and the exact prior
task target for rollback. Example remedies require a strict example-digest
superset; guidance remedies require a change-proof digest. Approval and
rejection carry the same draft-derived disposition key, which producer stores
must keep unique so conflicting terminal outcomes are machine-detectable.
Survey performs no task storage, task mutation, or runtime import from the
task-owning package.

## Compatibility

This API is additive. Existing Survey review, learning projection, source,
extraction, and TrustInput behavior remains unchanged when it is not called.
