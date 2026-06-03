# Downstream Builder Proof Assessment

Created: 2026-06-03.

This assessment records what the first two downstream
`sourceOfAuthorityObservationBuilder` integrations proved and what should wait
before Survey adds another abstraction.

## Proofs Reviewed

- Public-directory producer proof:
  downstream public-directory PR 20.
- Regulated-rule producer proof:
  downstream regulated-rule PR 17.

Both proofs consume `@kontourai/survey@0.4.3`.

## What The Builder Proved

The builder fits two different source-authority postures without changing
Surface schemas:

- a publisher-owned web page backing a public-directory field
- an official publication backing a regulated rule value

In both producers, Survey records source posture under Surface Evidence
metadata as `sourceAuthority`. Neither producer writes Surface `authorityTrace`
for source posture. That preserves the product boundary: source authority is
about why the producer trusts the source for this claim; Authority Trace remains
for portable actor, credential, role, organization, policy, or system authority.

The builder also made the producer-facing assembly order more legible:

1. observation identity, field, and value
2. declared source-authority posture
3. raw source
4. extraction
5. review outcome when present
6. claim projection
7. producer metadata

This is an improvement over one large object literal because it makes the
trust workflow visible in the call site.

## What Stayed Product-Owned

The downstream proofs confirm that these decisions should stay outside Survey:

- whether a source is appropriate for a product field
- operational review state and queue state
- source discovery, fetch, cache, retry, and parser policy
- claim ids, subject ids, claim types, and product surfaces
- product metadata such as rule path, provider id, proposal id, or field-source
  approval context
- whether a value becomes proposed, verified, assumed, rejected, superseded, or
  left out of the projection

Survey should keep carrying these values, not deciding them.

## Public-Directory Result

The public-directory proof changed `registrationStatus` from a scalar field
observation into a source-authority observation. That is the right direction
because the producer is saying the publisher page is the declared source for
the registration value.

The proof deliberately kept schedules on `repeatedObservation`. Schedule rows
are currently represented as an aggregate repeated-field proof, and moving them
to a source-authority builder would lose repeated-array metadata without proving
per-row lineage. A future schedule proof should first decide whether each row
has independent source/review lineage.

Key validation:

- `sourceAuthority.authorityClass` is `publisher_owned_page`
- Surface evidence carries `metadata.sourceAuthority`
- Surface `authorityTrace` remains empty
- repeated schedule metadata remains under `metadata.survey.repeated`

## Regulated-Rule Result

The regulated-rule proof was mostly a structural API migration. The existing
projection already modeled official publications as source-authority
observations; the builder made that path more explicit while preserving:

- source authority scope
- raw source ids and source references
- PDF locator and extraction metadata
- review outcome
- claim ids and statuses
- product-owned rule metadata

Key validation:

- official-publication source authority still projects to Surface Evidence
  metadata
- manual source override references still remain valid source references
- Surface `authorityTrace` remains empty
- rule manager confirmation still produces reviewed source-authority evidence

## Remaining Friction

The builder improved workflow readability, but downstream producers still repeat
several assembly tasks:

- building source-authority scope objects
- building raw source metadata
- building extraction metadata
- building claim projection objects
- threading product-specific metadata into both claim and Survey metadata

Some repetition is correct because it is product-owned. The important line is
whether repeated code expresses product policy or merely restates Survey shape.

Current judgment:

- Keep source-authority scope explicit for now.
- Keep claim projection explicit for now.
- Keep raw-source helpers as the primary reuse point.
- Do not add a generic product metadata helper yet.

## API Notes

The current builder API is acceptable for the first stable producer-facing
shape.

Keep:

- `sourceOfAuthorityObservationBuilder({ id, field, value })`
- `.withSourceAuthority(...)`
- `.fromSource(...)`
- `.withExtraction(...)`
- `.withReviewOutcome(...)`
- `.forClaim(...)`
- `.withCandidate(...)`
- `.withCandidateSet(...)`
- `.withMetadata(...)`
- `.build()`

Watch:

- `.withReviewOutcome(undefined)` is slightly awkward but useful when the
  producer has a proposed observation without review. Do not replace it until a
  second awkward call pattern appears.
- A `.reviewed(...)` alias may read better, but it would blur whether the input
  is a Survey `ReviewOutcome` shape or product review state. Keep the explicit
  name.
- A staged TypeScript builder could enforce order more strongly, but it would
  make the public API heavier. Runtime validation through the underlying helper
  is sufficient for now.

## Do Not Build Yet

Do not add another Survey abstraction solely because these two proofs exist.
The next abstraction should wait for a repeated downstream pain point.

Not yet:

- `SourceAuthorityScopeBuilder`
- `ProductClaimBuilder`
- generic producer metadata builder
- source-authority-specific repeated-observation builder

## Likely Next Candidate

The next candidate is a reviewed current/proposed resolution builder, not more
source-authority scaffolding.

Reason: the public-directory and regulated-rule proofs both now prove source
authority cleanly. The heavier remaining producer friction appears in review
decisions that compare an existing value with a proposed value, keep both
candidates visible, and project selected/unselected outcomes consistently.

Before building it, collect one more concrete downstream example where the
existing `reviewedCurrentProposedResolution` helper is correct but the call site
is still hard to read or easy to misuse.

## Post-Merge Current/Proposed Inspection

After the first two downstream builder integrations merged, the remaining
current/proposed call sites were inspected.

Public-directory admin review:

- uses `reviewedCurrentProposedResolution`
- owns accept/reject policy
- owns the meaning of keeping the current value
- owns decision-effect metadata and learning-signal metadata
- owns canonical claim promotion and candidate claim ids

Regulated-document correction review:

- uses `reviewedCurrentProposedResolution`
- first detects whether a two-candidate set is truly current/proposed
- owns source-candidate classification
- owns document-specific correction semantics
- falls back to generic reviewed-candidate or candidate-review records when the
  current/proposed shape does not apply

Assessment:

- The existing Survey helper is still doing the generic work: current/proposed
  roles, selected-candidate wiring, candidate-set construction, and review
  outcome wiring.
- The remaining complexity is mostly producer policy, candidate
  classification, and product-specific metadata.
- A new builder would mostly repackage product-owned decisions unless another
  downstream example shows repeated Survey-shape friction.

Decision:

Do not build `ReviewedCurrentProposedResolutionBuilder` yet. Keep
`reviewedCurrentProposedResolution` as the Survey API until one more downstream
call site shows that the helper is correct but still hard to use safely.

## Decision

Treat `sourceOfAuthorityObservationBuilder` as the current recommended
producer-facing API for source-authority observations.

Do not add another Survey builder yet. Use the public-directory and
regulated-rule proofs as the baseline for evaluating the next extraction after
one more downstream call site shows repeated friction.
