# Review Resource Contract

Survey review resources are producer-neutral envelopes for UI prototypes and
adapter tests. They sit beside the existing record contract and keep Survey out
of producer policy, queue state, reviewer form state, and product-specific
field catalogs.

Each resource uses a Kubernetes-inspired shape:

```ts
{
  apiVersion: "survey.kontourai.io/v1alpha1",
  kind: "ReviewItem" | "ReviewDecision" | "ReviewSession" | "ReviewSessionEvent",
  metadata: { name, uid?, labels?, annotations?, producer? },
  spec: { ...producer-declared intent },
  status: { ...Survey-readable observation hints }
}
```

## Resources

`ReviewItem` describes one reviewable target and its candidates. It carries
source references, locator or excerpt context, extraction confidence, candidate
roles, claim target hints, and optional projection hints for Survey records.
Roles include `current` and `proposed`, but also neutral roles such as
`alternative`, `source-version`, and `computed` so regulated-document reviews
do not have to pretend every comparison is a current/proposed pair.

`ReviewCandidate` is embedded inside `ReviewItem`. It is intentionally not a
top-level resource because candidate lifecycle belongs to the producer and the
portable contract only needs the serializable candidate payload.

`ReviewDecision` describes the reviewer decision for a `ReviewItem`: candidate,
status, actor, reviewed time, rationale, evidence ids, comfort-zone notes, and
projection hints.

`ReviewSession` is a portable envelope for one review session. It carries the
session snapshot hash, item count, event count, and status so downstream systems
can validate replay without importing workbench mechanics. A session does not own
queue position, assignment, retry, lock, or workflow state — those remain in the
producer's own system.

`ReviewSessionEvent` is a single event in a review session, such as a decision,
undo, or session-complete marker. Events are replayed against the session
snapshot to derive the final apply result. See
[`consumer-integration-guide.md`](consumer-integration-guide.md) for the full
replay and apply boundary.

## Ownership

Producers own acquisition, parsing, candidate ranking, review UX, vertical
policy, field catalogs, reviewer assignment, and operational state. Survey owns
the portable source, extraction, candidate, review, claim target, and projection
record shapes needed to build a Surface Trust Bundle.

Field ownership:

| Field area | Owner | Notes |
| --- | --- | --- |
| `metadata.name`, `labels`, `annotations` | producer | Stable producer identity and grouping labels. |
| `metadata.producer`, `spec.producerPolicy`, `candidate.producer` | producer | Domain context and policy hints; Survey treats these as opaque data. |
| `candidate.source` | producer declares, Survey maps | Maps to `RawSource` when an adapter emits Survey records. |
| `candidate.locator`, `candidate.extraction` | producer declares, Survey maps | Maps to `Extraction`, including locator, excerpt, confidence, extractor, and extracted time. |
| `candidate.role`, `spec.selectedCandidateId` | producer declares | Survey does not enforce current/proposed-only policy. |
| `candidate.rejectionReason` | producer declares | Optional rationale for a candidate the producer already treats as non-selected, superseded, or rejected; Survey records it without ranking candidates or defining rejection policy. A rejection reason is not a comfort-zone signal by itself. |
| `candidate.claimTarget` | shared boundary | Producer identifies the desired Surface claim target; Survey preserves compatible `ClaimTarget` fields. |
| `ReviewDecision.spec` | producer reviewer event | Maps to `ReviewOutcome` without bringing producer queues into Survey. |
| `projection` hints | Survey-readable | Optional ids linking resources to `RawSource`, `Extraction`, `CandidateSet`, `ReviewOutcome`, and `ClaimTarget` records. |

## Mapping To Survey Records

| Resource field | Survey record |
| --- | --- |
| `ReviewCandidate.source.sourceRef`, `kind`, `observedAt`, `checksum`, `locatorScheme` | `RawSource` |
| `ReviewCandidate.extraction.target`, `confidence`, `extractor`, `extractedAt` plus `locator` | `Extraction` |
| `ReviewItem.spec.target`, `candidates`, `selectedCandidateId`, `candidateSetStatus`, `rationale`, `candidate.rejectionReason` | `CandidateSet` and `Candidate` |
| `ReviewDecision.spec.status`, `actor`, `reviewedAt`, `rationale`, `evidenceIds`, `withinComfortZone` | `ReviewOutcome` |
| `ReviewCandidate.claimTarget` | `ClaimTarget` |
| `projection` | Optional id bridge for tests and adapters |
| `ReviewSession.spec.snapshot`, `itemCount`, `eventCount` | Replay envelope for session validation |
| `ReviewSessionEvent.spec.type`, `reviewItemName`, `candidateId`, `status`, `actor` | Replayable event log for derive/apply |

Session resource mapping and the snapshot-safe replay/export helpers are covered
in detail in [`consumer-integration-guide.md`](consumer-integration-guide.md).

Adapters should emit normal `SurveyInput` records and then call
`buildSurveyTrustBundle`. Review resources are a durable neutral contract for
review payloads, not a second Surface projection path.

Rejected candidates and comfort-zone review posture are separate signals.
Ordinary rejected-candidate feedback should stay on the candidate/review record
and, when Survey supports it, project as rejected-candidate learning. It should
not be modeled as `withinComfortZone: false` just to produce
`learning.comfort-zone`. Use `withinComfortZone: false` only when the reviewer
explicitly records that the conclusion is outside their authority or domain
comfort and needs a different authority to confirm.

## Examples

The public-directory example demonstrates a current/proposed field review. The
regulated-document example demonstrates multi-candidate source-version and
computed roles without requiring current/proposed semantics. Both examples are
plain serializable TypeScript objects and avoid private downstream product
names.

## Prototype

See [`review-workbench-prototype.md`](review-workbench-prototype.md) for the
example-backed browser prototype that renders a browser-safe copy of the
public-directory `ReviewItem`, guarded against drift from the canonical example,
and emits local in-memory `ReviewDecision` payloads for accept proposed, keep
current, and reject proposed decisions.

See [`consumer-integration-guide.md`](consumer-integration-guide.md) for the
recommended consumer path from `ReviewItem` construction through persisted
review events, exported results, and optional Surface projection. A generic
review adapter builder is deliberately deferred until another producer proof
shows repeated, policy-free Survey-shape friction.

## Collection provenance

A `ReviewDecision` can carry an `authorizing` block inside its spec (mapped
from `ReviewOutcome.authorizing`). This block records how the reviewer was asked
and what action they took — the testimony provenance that makes a decision
self-contained for downstream admissibility checks.

Three kinds are admissible: `explicit-statement` (reviewer typed a free-form
statement), `exchange` (a prompt was shown and the reviewer responded — both
halves required), and `authorized-action` (reviewer clicked a named action
against a versioned prompt; requires `promptRef`, `renderedPrompt`, `action`,
and `authorityRef`).

**Vertical UIs inherit correct collection by using the workbench.** A UI that
renders `ReviewItem` candidates and emits `ReviewDecision` payloads through
Survey's workbench automatically produces correctly structured `authorized-action`
blocks. The provenance logic lives in the workbench boundary, not in the vertical
UI, so consumer products do not need to re-implement it. The `authorizing` field
is optional; existing records without it remain valid.

Validation is available via `validateAuthorizing(block)` from
`@kontourai/survey`. It returns structured issues for transparency-gap reporting;
it does not hard-block decisions. Gaps are flagged for human review, never
silently resolved by model judgment.
