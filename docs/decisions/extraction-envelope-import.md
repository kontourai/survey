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
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/286"
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/287"
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/289"
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
namespace, source snapshot, complete prepared artifact, optional PDF layout, run, claim target, and
every proposal semantic input. Evidence identity commits complete source
grounding, optional PDF layout, excerpt, and occurrence selection while excluding field/value
semantics, so same-span/different-field proposals remain separate candidates
sharing one visible evidence identity. Resolution attempts add collision-resistant IDs.

The adapter rejects malformed or non-lossless representations before grounding,
and documentation treats all retained proposal values, excerpts, and identities
as potentially review-host-visible.

Proposals are grouped into one review item per claim slot (the claim target's
subject, facet, claim type, field or behavior and claim id, plus the
proposal's path indices), with one candidate per distinct value; two or more
values make the set a conflict, so conflicting values for one claim within one
envelope import cannot both be verified. Across imports (two runs, or one
envelope under two import names) items stay separate; that needs a stable slot
identity (kontourai/fieldwork#52, kontourai/survey#295). Role-based review
decisions refuse to accept one of several proposed values; rejecting all of them
or could-not-confirm stay available and never project verified. Typed partial reasons and per-chunk coverage are validated and
carried to candidates as producer metadata, and a missing proposer confidence
stays missing.

Validated parser-neutral PDF layout and OCR-derived posture are preserved
without changing the exact prepared-text locator. PDF layout requires a prepared
artifact and fails closed when page geometry, ranges, elements, or table cells
are malformed or out of range.

## Compatibility

The adapter is additive. Existing Survey source, extraction, review, workbench,
and producer-policy workflows remain unchanged. Grouping by claim slot changed
item names and item counts for envelopes that repeat a claim (a breaking change
for stored review rounds); single-proposal candidate identities are unchanged.
