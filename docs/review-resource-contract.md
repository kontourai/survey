# Review Resource Contract

Survey review resources are producer-neutral envelopes for UI prototypes and
adapter tests. They sit beside the existing record contract and keep Survey out
of producer policy, queue state, reviewer form state, and product-specific
field catalogs.

Each resource uses a Kubernetes-inspired shape:

```ts
{
  apiVersion: "survey.kontourai.io/v1alpha1",
  kind: "ReviewItem" | "ReviewDecision",
  metadata: { name, labels, annotations, producer },
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

`ReviewSession` is intentionally not part of this contract. A session quickly
turns into queue position, assignment, retry, lock, or workflow state. Producers
can group `ReviewItem` resources in their own systems without Survey owning
operational semantics.

## Ownership

Producers own acquisition, parsing, candidate ranking, review UX, vertical
policy, field catalogs, reviewer assignment, and operational state. Survey owns
the portable source, extraction, candidate, review, claim target, and projection
record shapes needed to build Surface `TrustInput`.

Field ownership:

| Field area | Owner | Notes |
| --- | --- | --- |
| `metadata.name`, `labels`, `annotations` | producer | Stable producer identity and grouping labels. |
| `metadata.producer`, `spec.producerPolicy`, `candidate.producer` | producer | Domain context and policy hints; Survey treats these as opaque data. |
| `candidate.source` | producer declares, Survey maps | Maps to `RawSource` when an adapter emits Survey records. |
| `candidate.locator`, `candidate.extraction` | producer declares, Survey maps | Maps to `Extraction`, including locator, excerpt, confidence, extractor, and extracted time. |
| `candidate.role`, `spec.selectedCandidateId` | producer declares | Survey does not enforce current/proposed-only policy. |
| `candidate.claimTarget` | shared boundary | Producer identifies the desired Surface claim target; Survey preserves compatible `ClaimTarget` fields. |
| `ReviewDecision.spec` | producer reviewer event | Maps to `ReviewOutcome` without bringing producer queues into Survey. |
| `projection` hints | Survey-readable | Optional ids linking resources to `RawSource`, `Extraction`, `CandidateSet`, `ReviewOutcome`, and `ClaimTarget` records. |

## Mapping To Survey Records

| Resource field | Survey record |
| --- | --- |
| `ReviewCandidate.source.sourceRef`, `kind`, `observedAt`, `checksum`, `locatorScheme` | `RawSource` |
| `ReviewCandidate.extraction.target`, `confidence`, `extractor`, `extractedAt` plus `locator` | `Extraction` |
| `ReviewItem.spec.target`, `candidates`, `selectedCandidateId`, `candidateSetStatus`, `rationale` | `CandidateSet` and `Candidate` |
| `ReviewDecision.spec.status`, `actor`, `reviewedAt`, `rationale`, `evidenceIds`, `withinComfortZone` | `ReviewOutcome` |
| `ReviewCandidate.claimTarget` | `ClaimTarget` |
| `projection` | Optional id bridge for tests and adapters |

Adapters should emit normal `SurveyInput` records and then call
`buildSurveyTrustInput`. Review resources are a durable neutral contract for
review payloads, not a second Surface projection path.

## Fixtures

The public-directory fixture demonstrates a current/proposed field review. The
regulated-document fixture demonstrates multi-candidate source-version and
computed roles without requiring current/proposed semantics. Both fixtures are
plain serializable TypeScript objects and avoid private downstream product
names.

## Prototype

See [`review-workbench-prototype.md`](review-workbench-prototype.md) for the
fixture-backed browser prototype that renders a browser-safe copy of the
public-directory `ReviewItem`, guarded against drift from the canonical fixture,
and emits local in-memory `ReviewDecision` payloads for accept proposed, keep
current, and reject proposed decisions.
