# Source-Authority Review Pattern

Survey owns the producer-side pattern for turning source context, extracted
candidates, and human or system review into Surface-ready trust evidence. Use
this pattern when a producer treats a raw source as authoritative for a scoped
target and wants that review trail to be inspectable downstream.

This pattern does not make the source true. It records the producer's source
posture, extraction trail, and review outcome so Surface can expose why a claim
is proposed, assumed, verified, disputed, or stale.

## Product Boundaries

- The producer owns acquisition, parsing, candidate ranking, review UX,
  vertical policy, and operational state.
- Survey owns the portable source -> extraction -> candidate -> review shape
  before the Surface boundary.
- Surface owns claims, evidence, status derivation, dependency behavior,
  trust reports, and public reporting surfaces.
- Separate producer governance or audit systems may verify whether a producer
  workflow followed policy, but they do not replace the Survey record.

## Canonical Flow

1. Capture the raw source.
   Use a source helper such as `uploadedDocumentSource`, `apiRecordSource`,
   `webPageSource`, `manualEntrySource`, or `policyStandardSource`. `sourceRef` may be a URL, local
   file path, API record reference, content-addressed reference, or other
   producer-stable source reference.

2. Extract one or more candidates.
   The producer owns parsing and confidence. Survey carries the target, value,
   locator, excerpt, extractor id, extracted time, and producer metadata.

3. Persist operational state in the producer.
   Keep workflow state such as queue status, selected path, reviewer form
   values, source cache path, and retry/discovery status in the producer's own
   data model. Do not force product-local state into Survey metadata just so it
   can survive.

4. Record the review outcome.
   A verified or assumed source-of-authority observation needs reviewer identity
   and reviewed time. Include a rationale when it clarifies the choice. If the
   reviewer is outside their domain expertise, use the comfort-zone fields
   rather than hiding that signal in prose.

5. Project through Survey.
   Use `sourceOfAuthorityObservationBuilder` for each source-authority value,
   reviewed or proposed, then `buildSurveyTrustInput` to produce Surface
   `TrustInput`.

6. Inspect through Surface.
   Surface reports show claims, evidence, status, gaps, and metadata. Producers
   can pass the resulting report to any product-owned review or reporting
   experience.

## Source Authority vs. Authority Trace

Survey source-authority metadata describes the producer's posture toward the
source. It projects to Surface Evidence metadata under `sourceAuthority`.

Do not project this posture to Surface `authorityTrace`. Authority Trace is for
portable actor, credential, role, organization, policy, or system authority.
For example:

- "The official publication is the source for this regulated rule value"
  belongs in `Evidence.metadata.sourceAuthority`.
- "Reviewer A had the role required to approve regulated rule changes" belongs
  in Surface `authorityTrace` if the producer can emit a portable authority
  record.

## Confirmation Records

When a producer has a confirmation action, keep the operational confirmation
state in the producer system and project the reviewed evidence through Survey.

Recommended producer state:

- current operational status
- source reference
- source locator or section
- source page or structured location when applicable
- extraction confidence
- raw excerpt or observed value context
- confirmed actor
- confirmed time
- confirmation rationale

Recommended Survey projection:

- rebuild a source-of-authority candidate from the saved source context
- attach a `reviewOutcome` with the confirmer, time, status, and rationale
- produce a Surface `TrustInput` with `buildSurveyTrustInput`
- keep `authorityTrace` empty unless a separate actor/system authority record
  exists

If source context is missing, do not invent authority evidence. The producer
may still update operational state, but the Survey projection should produce no
reviewed source-authority claim and should expose a warning or gap to the
operator.

## Derived Claims

Source-of-authority observations are usually inputs, not the final product
decision. Contextual claims should be modeled as derived Surface claims that
depend on source-authority claims and product facts.

Examples:

- "This regulated rule value was extracted from an official publication" is a
  source-of-authority observation.
- "This submission complies with the applicable rule set" is a derived product
  claim.
- "This public record includes a published eligibility range" is a
  source/public-record claim.
- "This record is eligible for a specific requester and date" is a derived
  eligibility claim that depends on published ranges, date, registration, and
  product policy inputs.

## Public Implementation Pattern

A producer-owned confirmation flow keeps operational state in its own status
store, then projects confirmed source context through Survey into Surface
`TrustInput`. Surface validation and report APIs can then inspect the public
claim, evidence, status, gap, and metadata records. Manual file references are
valid source references; they remain source context and do not become Surface
Authority Trace records.

For the first downstream proof assessment across public-directory and
regulated-rule producers, see
[Downstream Builder Proof Assessment](downstream-builder-proof-assessment.md).
