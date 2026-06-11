# Adversarial Passes And Learning Projections

Survey records adversarial review rounds and projects what reviewers actually corrected into learning signals. This is the producer-side half of the adversarial-review pattern: [Kontour Flow](https://kontourai.github.io/flow/gates-and-route-back.html#pattern-adversarial-review-with-a-defect-budget) owns the orchestration — route-back budgets and transition accounting — while Survey owns the per-round review evidence those gates consume.

## Adversarial passes

Producers that run a second adversarial pass — whether an LLM judge, a rules
engine, or a second human reviewer — emit their output into Survey as a normal
producer pass with a distinct `extractor` id. Survey does not know or care that
a second pass ran; it sees two producers disagreeing on the same target, which
is exactly what `conflict` and escalation records are for.

Two patterns cover the adversary's output:

**Conflicting candidate.** The adversary disagrees with the first-pass extraction
value. Add the adversary's extraction as a second candidate to the same candidate
set using `candidateReviewRecord` with `status: "conflict"`. Survey projects the
conflict to a `disputed` claim in Surface.

```ts
import { candidateReviewRecord, fieldObservation, SurveyInputBuilder } from "@kontourai/survey";

const records = candidateReviewRecord({
  id: "candidate-set.entity-1.registration-status",
  target: "registrationStatus",
  status: "conflict",
  rationale: "First pass and adversary disagree; human review required.",
  observations: [
    fieldObservation({
      id: "observation.entity-1.status.first-pass",
      field: "registrationStatus",
      value: "ACTIVE",
      rawSource: {
        kind: "api-record",
        sourceRef: "records://entity-1/registry",
        observedAt: new Date().toISOString(),
        locatorScheme: "structured-field",
      },
      extraction: {
        confidence: 0.91,
        locator: "json:$.registrationStatus",
        extractor: "agent-v1",
        extractedAt: new Date().toISOString(),
      },
      candidate: { id: "candidate.first-pass", confidence: 0.91 },
      claim: {
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        impactLevel: "high",
        collectedBy: "agent-v1",
      },
    }),
    fieldObservation({
      id: "observation.entity-1.status.adversary",
      field: "registrationStatus",
      value: "INACTIVE",
      rawSource: {
        kind: "api-record",
        sourceRef: "records://entity-1/registry",
        observedAt: new Date().toISOString(),
        locatorScheme: "structured-field",
      },
      extraction: {
        confidence: 0.84,
        locator: "json:$.registrationStatus",
        extractor: "adversary-v1",
        extractedAt: new Date().toISOString(),
      },
      candidate: { id: "candidate.adversary", confidence: 0.84 },
      claim: {
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        impactLevel: "high",
        collectedBy: "adversary-v1",
      },
    }),
  ],
});
```

**Framing challenge.** The adversary identifies a target that was not addressed
at all — a missed standard, an unconsidered alternative, or a misframed question.
Use `addEscalation` to record the challenge. Attach it to the closest relevant
claim with `attachToClaimId`; Survey projects it as an additional `disputed`
verification event on that claim so the reviewer sees it prominently.

```ts
import { SurveyInputBuilder, fieldObservation } from "@kontourai/survey";

const builder = new SurveyInputBuilder({ source: "example-producer:run-2" });

// First-pass observation
builder.addObservation(fieldObservation({ /* ... */ }));

// Adversary raises a framing challenge
builder.addEscalation({
  id: "escalation.entity-1.fair-value.completeness",
  target: "fairValue",
  dimension: "completeness",
  reason: "Measurement standard Level 3 inputs were not documented; sensitivity range and unobservable input assumptions are missing.",
  raisedBy: "adversary-v1",
  raisedAt: new Date().toISOString(),
  attachToClaimId: "claim.entity-1.fair-value",
});
```

If a subsequent first-pass or human-review pass resolves the challenge, set
`resolvedBy` to the id of the observation that closes it. Survey will not project
a `disputed` event for resolved escalations.

Escalation dimensions follow the adversary's attack surface: `framing` (wrong
question framed), `completeness` (missing standards, alternatives, or evidence),
`conclusion` (reasoning would not survive challenge), and `citation` (cited
sources do not support the claims attached to them).

Framing challenges without an `attachToClaimId` are carried in `SurveyInput`
for producer tooling but are not projected to Surface. If the adversary cannot
identify a target claim to attach a framing challenge to, emit a candidate set
with `status: "escalated"` for the affected target — that projects to `disputed`
in Surface with a `candidate-escalation` event.


## Learning projections

Use `buildSurveyLearningProjections(input)` when producer or review tooling needs
workflow/evaluation signals without changing Surface `TrustBundle`.

```ts
import {
  buildSurveyLearningProjections,
  buildSurveyTrustBundle,
} from "@kontourai/survey";

const learning = buildSurveyLearningProjections(surveyInput);
const trustBundle = buildSurveyTrustBundle(surveyInput);
```

Learning projections are product-neutral `learning.*` records. Survey emits
`learning.rejected-candidate` from structured candidate rejection data such as
non-empty `Candidate.rejectionReason` values or a candidate-specific
`ReviewOutcome.status === "rejected"` outcome with rationale. When both exist,
Survey emits one rejected-candidate projection enriched with candidate and
review outcome context.
Ordinary rejected candidates do not emit `learning.comfort-zone`.

Survey also emits `learning.comfort-zone` from structured
`ReviewOutcome.withinComfortZone === false` data and `learning.escalation` from
unresolved `EscalationRecord`s, including unattached records that producer
tooling can route but Surface cannot attach to a claim event.

These projections are producer/review workflow and evaluation signals. They are
not claims about truth or veracity, not Surface claim status, not evidence, and
not verification events. Calling `buildSurveyLearningProjections` does not alter
`buildSurveyTrustBundle`, trust status derivation, or escalation event projection.
