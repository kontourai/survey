---
status: current
subject: Extraction Envelope Import
decided: 2026-07-20
evidence:
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/156"
  - kind: doc
    ref: docs/extraction-envelope-import.md
  - kind: doc
    ref: src/extraction-envelope.ts
---
# Extraction Envelope Import

## Decision

Survey consumes the upstream-owned `traverse-extraction-result` version 1
contract through a structural adapter. It does not define a competing primary
extraction envelope and does not add a runtime dependency on the producing
library. A test-only dependency and canonical fixture catch contract drift.

Survey wraps the validated envelope unchanged in an `ExtractionEnvelopeImport`
resource and stores Survey-specific source kind and claim-target mappings beside
it. Grounded imports project proposed `ReviewItem` candidates. Every
non-grounded prepared-artifact state remains a typed diagnostic and projects no
candidate.

Candidate, extraction, and resolution identities commit the producer/import
namespace, source snapshot, complete prepared artifact, run, claim target, and
every proposal semantic input. Evidence identity commits complete source
grounding, excerpt, and occurrence selection while excluding field/value
semantics, so same-span/different-field proposals remain separate candidates
sharing one visible evidence identity. Resolution attempts add collision-resistant IDs.

The adapter rejects malformed or non-lossless representations before grounding,
and documentation treats all retained proposal values, excerpts, and identities
as potentially review-host-visible.

## Compatibility

The adapter is additive. Existing Survey source, extraction, review, workbench,
and producer-policy workflows remain unchanged.
