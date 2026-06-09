# Consumer Adapter Abstraction Assessment

Created: 2026-06-08.

This assessment compares two downstream-shaped Survey consumers to decide
whether Survey should add a generic review adapter builder now.

## Consumers Compared

The first consumer shape is a public-directory review queue. It compares a
current managed value with a proposed value from a crawl or API ingestion pass.
The product owns proposal status, approval behavior, rejection semantics,
learning feedback, partial apply behavior, field labels, and record identity.

The second consumer shape is a regulated-rule conflict queue. It compares a
current managed rule value with a proposed value extracted from a source
document. The product owns rule paths, jurisdiction or period metadata, source
registry policy, supported actions, and whether a conflict can be resolved by
keeping the current value.

Both consumers can emit ordinary `ReviewItem` resources without Survey importing
downstream code or vocabulary.

## Shared Survey Shape

Both consumer shapes repeat some Survey-compatible structure:

- `ReviewItem` resource envelope
- `metadata.name` and grouping labels
- `spec.target`
- `candidateSetStatus`
- `producerPolicy`
- current/proposed candidate roles
- typed `candidate.value`
- source references with kind, observed time, and locator scheme
- locator and excerpt context
- extraction target, confidence, extractor, and extracted time
- `claimTarget` hints for Surface projection
- optional projection ids for raw source, extraction, candidate set, candidate,
  review outcome, and claim

This shared structure is real. It is why the workbench can render both cases
without product-specific branches.

## Important Differences

The repeated object shape does not yet mean Survey should hide the construction
behind one generic builder.

Key differences:

- The public-directory consumer's proposed source is usually a web page or API
  record, while the regulated-rule consumer's proposed source is often an
  uploaded document or policy-standard source.
- The public-directory consumer can support accepting the proposed value,
  keeping the current value, rejecting the proposed value, and partial field
  apply. The regulated-rule conflict flow may only support keeping current
  until a specialist workflow resolves the source conflict.
- Evidence types differ. Public-directory proposed values often use
  `crawl_observation`; regulated-rule candidates often use `policy_rule`.
- Impact levels and source-authority posture differ. Regulated-rule values are
  commonly high-impact and may include official-publication posture.
- Product metadata differs. Proposal ids, record ids, rule paths, source pages,
  source sections, source registry ids, feedback tags, and apply behavior are
  product-owned.
- Candidate ids and claim ids are product identity policy. Survey should carry
  them, not decide them.

These differences are domain policy, not Survey-shape friction.

## Current Judgment

Do not add a generic `ReviewItemBuilder` or
`CurrentProposedReviewItemBuilder` yet.

The current repeated code is mostly explicit boundary work:

- the producer names the review item
- the producer declares source identity
- the producer declares extraction and locator context
- the producer chooses claim target ids
- the producer declares product policy and apply semantics

Hiding those fields too early would make integrations look easier while moving
product policy into Survey. That would weaken the product boundary.

## Worth Keeping

Keep these APIs as the recommended integration surface:

- `ReviewItem` and `ReviewDecision` resource contracts
- `mountReviewWorkbench`
- `createPersistentReviewSessionEventStore`
- `buildReviewWorkbenchResultsFromSession`
- `buildReviewWorkbenchSessionExport`
- `reviewedCurrentProposedResolution`
- `candidateReviewRecord`
- `sourceOfAuthorityObservationBuilder`
- raw-source helpers such as `webPageSource`, `uploadedDocumentSource`,
  `manualEntrySource`, `apiRecordSource`, and `policyStandardSource`

These APIs cover the generic pieces without owning producer policy.

## Extraction Opportunities

Survey can still improve developer experience without adding a broad builder.

Good candidates:

- more guide-level examples showing how to build `ReviewItem` resources
- snapshot-safe review session replay helpers that reject events pointing at
  items or candidates outside the supplied reviewed snapshot
- small validation helpers for review resources if multiple producers start
  emitting malformed resources
- source descriptor reuse if producers repeatedly rebuild the same raw source
  and source-authority scope across many observations
- result-to-Survey-record examples showing how `ReviewWorkbenchResult` feeds
  `reviewedCurrentProposedResolution`

Poor candidates right now:

- a builder that chooses ids
- a builder that chooses evidence type
- a builder that interprets producer proposal status
- a builder that decides accept/reject/apply behavior
- a builder that assumes all reviews are current/proposed pairs
- a builder that treats source-authority posture as actor authority

## Next Proof Needed

Before adding another public builder, collect one more producer call site where:

- the producer already has product policy factored out
- `ReviewItem` construction is still hard to read or easy to misuse
- repeated code is mostly Survey shape, not source policy or apply semantics
- the same helper would fit public-directory and regulated-rule consumers

If that proof appears, shape the smallest helper around the repeated mechanical
piece. If the repeated piece still includes product ids, source policy, evidence
type, or apply behavior, keep it local to the producer.

The first post-proof helper is intentionally narrower than a builder:
`validateReviewSessionEventsForSnapshot`,
`replayReviewSessionEventsForSnapshot`, and
`buildReviewWorkbenchSessionExportForSnapshot` only check that replayed review
events still point at items and candidates in the supplied reviewed snapshot.
They do not choose ids, decide product apply behavior, authorize the write, or
compare reviewed values with the producer's current record.

## Decision

Survey should document the generic consumer path now and defer any new review
adapter builder until a third proof shows repeated, policy-free Survey-shape
friction.
