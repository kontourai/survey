# Consumer Integration Guide

Survey is the producer-side contract for reviewable claims before they cross
into Surface. A consumer should be able to keep its product workflow local while
using Survey for the portable source, extraction, candidate, review, and result
records.

The canonical integration path is:

1. Producer creates `ReviewItem` resources from its own queue or reconciliation
   state.
2. Producer mounts the review workbench with a `ReviewQueueSessionState`.
3. Producer persists `ReviewSessionEvent` resources through a product-owned
   event store.
4. Producer exports `ReviewWorkbenchResult` and `ReviewDecision` resources.
5. Producer applies product policy locally and, when appropriate, projects
   Survey records into Surface with `buildSurveyTrustInput`.

Survey should not own the producer queue, auth, tenancy, parser policy, source
ranking policy, final apply semantics, or product field catalog.

## Consumer Adapter Contract

The reusable boundary is intentionally small:

| Step | Producer owns | Survey owns |
| --- | --- | --- |
| Queue | Which product records need review, who can see them, and tenancy/auth rules. | `ReviewQueueSessionState` as the portable queue/session shape. |
| Item | Stable ids, field catalog, candidate ranking, source authority posture, and product policy notes. | `ReviewItem`, `ReviewCandidate`, source, extraction, locator, claim target, and projection hints. |
| Presentation | Human labels, value summaries, and links back to product records, sources, claims, or traces. | `ReviewPresentationAdapter` hooks plus deterministic item/result presentation builders. |
| Events | Durable event storage, optimistic concurrency, and reviewer identity from trusted product context. | `ReviewSessionEvent` resources and replay/validation helpers. |
| Apply | Current-state validation, product policy, mutating writes, audit tables, and downstream jobs. | `ReviewWorkbenchResult` and `ReviewDecision` derived from a pre-decision review snapshot plus persisted events. |
| Surface handoff | Which reviewed observations become claims and when to publish them. | Normal Survey observation/claim records and `buildSurveyTrustInput` projection into Surface. |

`ReviewPresentationAdapter` is display-only. It lets a product explain ids and
values without changing canonical `ReviewItem` data or apply authority.

```ts
import {
  buildReviewItemPresentation,
  buildReviewResultPresentation,
  type ReviewPresentationAdapter,
} from "@kontourai/survey/review-workbench";

const presentationAdapter = {
  labelForTarget: (target) => target === "operatingLicenseCredential"
    ? "Operating license credential"
    : undefined,
  labelForCandidateRole: (role) => role === "current"
    ? "Current managed credential"
    : role === "proposed"
      ? "Registry candidate"
      : undefined,
  summarizeValue: (value) => summarizeCredentialValue(value),
  linkForReviewItem: (item) => ({
    label: typeof item.metadata.producer?.displayName === "string"
      ? item.metadata.producer.displayName
      : "Review item",
    href: `/review/items/${encodeURIComponent(item.metadata.name)}`,
  }),
  linkForSource: (sourceRef) => ({ href: sourceRef }),
  linkForTraceRef: (ref) => ref.kind === "claim"
    ? { label: "Claim target", href: `/claims/${encodeURIComponent(ref.value)}` }
    : undefined,
} satisfies ReviewPresentationAdapter;

const itemPresentation = buildReviewItemPresentation(reviewItem, presentationAdapter);
const resultPresentation = buildReviewResultPresentation(result, reviewItem, presentationAdapter);
```

A server apply path should treat persisted events as the auditable input and
derive results again from the pre-decision review queue snapshot. Browser
exports and presentation payloads are useful for inspection, not write
authority.

```ts
import {
  buildReviewSessionEvents,
  deriveReviewSessionApplyResultForSnapshot,
  persistReviewSessionEvents,
} from "@kontourai/survey/review-workbench";

const currentRecord = await loadCurrentProductRecord(recordId);
const reviewSessionSnapshot = await loadReviewSessionSnapshot(reviewId);
const reviewedSession = buildReviewedSession(reviewSessionSnapshot, reviewerInput);
const eventsToPersist = buildReviewSessionEvents(reviewedSession);
const persisted = await persistReviewSessionEvents({
  session: reviewedSession,
  events: eventsToPersist,
  expectedEventCount: await countPersistedReviewEvents(reviewId),
  persist: ({ events, expectedEventCount }) =>
    saveReviewEvents({ reviewId, events, expectedEventCount }),
});

const applyResult = deriveReviewSessionApplyResultForSnapshot({
  snapshot: reviewSessionSnapshot,
  events: persisted.events,
  requiredResolvedItems: "all",
});
if (!applyResult.ok) {
  throw new Error("Review events do not match the review session snapshot.");
}

for (const result of applyResult.results) {
  assertProductTargetStillMatches(currentRecord, result);
  await applyProductPolicy({
    decision: result.decision,
    selectedCandidateId: result.selectedCandidateId,
    selectedValue: result.selectedValue,
    actorId: auth.user.id,
    appliedAt: new Date().toISOString(),
  });
}
```

Surface projection is still the normal Survey path. A review result tells the
producer which candidate was selected; producer code then emits the reviewed
source/extraction/candidate/review/claim records it wants to publish and calls
`buildSurveyTrustInput`. The workbench also exposes a projection preview for UI
explanation, but that preview is not a separate write path.

`persistReviewSessionEvents` returns the event array accepted for replay. If a
producer's persistence layer canonicalizes or reads back stored resources, its
`persist` callback should return `{ events, eventCount }`; otherwise the
callback must atomically commit exactly the supplied array before returning.

The generic, test-covered workbench example lives at
[`examples/review-workbench/facility-credential-consumer.ts`](../examples/review-workbench/facility-credential-consumer.ts).
It shows a `ReviewItem`, `ReviewPresentationAdapter`, persisted
`ReviewSessionEvent` resources, event replay, derived `ReviewWorkbenchResult`,
and a Surface projection preview without product-specific policy embedded in
Survey.

For the smallest server apply boundary, see
[`examples/review-workbench/server-apply-consumer.ts`](../examples/review-workbench/server-apply-consumer.ts).
That example intentionally keeps the product mutation local: Survey derives the
review result from the pre-decision snapshot and persisted events, while the
consumer validates current state, rejects already-applied results, stamps the
authenticated actor, and prepares its own write.

## Public-Directory Example

A public-directory producer often has an existing value and a proposed value
from a crawl or API ingestion pass. The producer owns what "approve" means, but
Survey can carry the reviewable candidate shape.

```ts
import {
  reviewResourceApiVersion,
  type ReviewItem,
} from "@kontourai/survey";

const registrationStatusReviewItem = {
  apiVersion: reviewResourceApiVersion,
  kind: "ReviewItem",
  metadata: {
    name: "public-record.entity-123.registrationStatus.review-1",
    labels: {
      domain: "public-directory",
      field: "registrationStatus",
    },
  },
  spec: {
    target: "registrationStatus",
    candidateSetStatus: "needs-review",
    producerPolicy: {
      decisionMode: "current-proposed",
    },
    projection: {
      candidateSetId: "public-record.entity-123.registrationStatus.candidates",
    },
    candidates: [
      {
        id: "public-record.entity-123.registrationStatus.current",
        role: "current",
        value: "ACTIVE",
        source: {
          sourceRef: "current-record:entity-123:registrationStatus",
          kind: "manual-entry",
          observedAt: "2026-06-01T12:00:00.000Z",
          locatorScheme: "structured-field",
        },
        locator: {
          scheme: "structured-field",
          locator: "field:registrationStatus",
          excerpt: "Current reviewed value.",
        },
        extraction: {
          extractionId: "public-record.entity-123.registrationStatus.current.extraction",
          target: "registrationStatus",
          confidence: 1,
          extractor: "current-record",
          extractedAt: "2026-06-01T12:00:00.000Z",
        },
        claimTarget: {
          claimId: "public-record.entity-123.registrationStatus.current.claim",
          subjectType: "public-record.entity",
          subjectId: "entity-123",
          surface: "public-directory.profile",
          claimType: "public-data.field",
          fieldOrBehavior: "registrationStatus",
          impactLevel: "medium",
          evidenceType: "human_attestation",
          evidenceMethod: "observation",
          collectedBy: "current-record",
        },
        projection: {
          rawSourceId: "public-record.entity-123.registrationStatus.current.source",
          extractionId: "public-record.entity-123.registrationStatus.current.extraction",
          candidateSetId: "public-record.entity-123.registrationStatus.candidates",
          candidateId: "public-record.entity-123.registrationStatus.current",
          claimId: "public-record.entity-123.registrationStatus.current.claim",
        },
      },
      {
        id: "public-record.entity-123.registrationStatus.proposed",
        role: "proposed",
        value: "WAITLIST",
        confidence: 0.84,
        sourceRank: 1,
        source: {
          sourceRef: "https://records.example.test/entities/123",
          kind: "web-page",
          observedAt: "2026-06-01T12:30:00.000Z",
          locatorScheme: "html",
        },
        locator: {
          scheme: "html",
          locator: "css:#registration-status",
          excerpt: "Registration status: waitlist",
        },
        extraction: {
          extractionId: "public-record.entity-123.registrationStatus.proposed.extraction",
          target: "registrationStatus",
          confidence: 0.84,
          extractor: "example-crawler",
          extractedAt: "2026-06-01T12:30:00.000Z",
        },
        claimTarget: {
          claimId: "public-record.entity-123.registrationStatus.proposed.claim",
          subjectType: "public-record.entity",
          subjectId: "entity-123",
          surface: "public-directory.profile",
          claimType: "public-data.field",
          fieldOrBehavior: "registrationStatus",
          impactLevel: "medium",
          evidenceType: "crawl_observation",
          evidenceMethod: "extraction",
          collectedBy: "example-crawler",
        },
        projection: {
          rawSourceId: "public-record.entity-123.registrationStatus.proposed.source",
          extractionId: "public-record.entity-123.registrationStatus.proposed.extraction",
          candidateSetId: "public-record.entity-123.registrationStatus.candidates",
          candidateId: "public-record.entity-123.registrationStatus.proposed",
          claimId: "public-record.entity-123.registrationStatus.proposed.claim",
        },
      },
    ],
  },
  status: {
    observedCandidateCount: 2,
  },
} satisfies ReviewItem;
```

## Regulated-Rule Example

A regulated-rule producer may also have current and proposed values, but the
review semantics are different. The proposed value may come from an official
publication and the current value may be a managed rule value. Product policy
may allow only "keep current" for a particular conflict until a specialist
resolves it, but the current Survey workbench does not enforce that policy from
`producerPolicy`. The producer must validate supported actions before applying
a `ReviewDecision`.

The same `ReviewItem` contract works because the candidate shape carries typed
values, source posture, locators, evidence type, claim target hints, and
producer policy without Survey deciding the domain result.

```ts
import {
  reviewResourceApiVersion,
  type ReviewItem,
} from "@kontourai/survey";

const ruleConflictReviewItem = {
  apiVersion: reviewResourceApiVersion,
  kind: "ReviewItem",
  metadata: {
    name: "regulated-rule-conflict-standard-threshold",
    labels: {
      domain: "regulated-rule-source",
    },
  },
  spec: {
    target: "standardThreshold",
    candidateSetStatus: "conflict",
    selectedCandidateId: "regulated-rule-conflict-standard-threshold.current",
    rationale: "Extracted source value conflicts with the managed value.",
    producerPolicy: {
      decisionMode: "keep-current",
      policyNote: "Producer validates supported actions before applying a decision.",
      sourceAuthorityProjection: "only-for-selected-source-backed-value",
    },
    projection: {
      candidateSetId: "regulated-rule-conflict-standard-threshold.candidates",
    },
    candidates: [
      {
        id: "regulated-rule-conflict-standard-threshold.current",
        role: "current",
        value: 15000,
        confidence: 1,
        source: {
          sourceRef: "managed-rules://example/2026/standardThreshold",
          kind: "manual-entry",
          observedAt: "2026-06-03T00:00:00.000Z",
          locatorScheme: "structured-field",
        },
        locator: {
          scheme: "structured-field",
          locator: "managed-rules:path=standardThreshold",
          excerpt: "Current managed rule value.",
        },
        extraction: {
          extractionId: "regulated-rule-conflict-standard-threshold.current.extraction",
          target: "standardThreshold",
          confidence: 1,
          extractor: "example-rule-manager",
          extractedAt: "2026-06-03T00:00:00.000Z",
        },
        claimTarget: {
          claimId: "regulated-rule.example.2026.standard-threshold.current",
          subjectType: "regulated-rule-source",
          subjectId: "example:2026:standardThreshold",
          surface: "regulated.rules",
          claimType: "regulated.rule-source-value",
          fieldOrBehavior: "standardThreshold",
          impactLevel: "high",
          evidenceType: "human_attestation",
          evidenceMethod: "attestation",
          collectedBy: "example-rule-manager",
        },
      },
      {
        id: "regulated-rule-conflict-standard-threshold.proposed",
        role: "proposed",
        value: 16000,
        confidence: 0.95,
        source: {
          sourceRef: "https://example.test/regulatory-bulletins/2026-thresholds.pdf",
          kind: "uploaded-document",
          observedAt: "2026-06-03T00:30:00.000Z",
          locatorScheme: "pdf",
        },
        locator: {
          scheme: "pdf",
          locator: "pdf:page=12;section=Standard%20Threshold",
          excerpt: "Example Individual Standard Threshold $16,000",
        },
        extraction: {
          extractionId: "regulated-rule-conflict-standard-threshold.proposed.extraction",
          target: "standardThreshold",
          confidence: 0.95,
          extractor: "example-rule-source-parser",
          extractedAt: "2026-06-03T00:30:00.000Z",
        },
        claimTarget: {
          claimId: "regulated-rule.example.2026.standard-threshold.proposed",
          subjectType: "regulated-rule-source",
          subjectId: "example:2026:standardThreshold",
          surface: "regulated.rules",
          claimType: "regulated.rule-source-value",
          fieldOrBehavior: "standardThreshold",
          impactLevel: "high",
          evidenceType: "policy_rule",
          evidenceMethod: "extraction",
          collectedBy: "example-rule-source-parser",
        },
        producer: {
          sourceAuthority: {
            authorityClass: "official_publication",
            declaredBy: "Example regulatory source registry",
            scope: "standardThreshold rule value for example 2026",
          },
        },
      },
    ],
  },
  status: {
    observedCandidateCount: 2,
    selectedCandidateId: "regulated-rule-conflict-standard-threshold.current",
  },
} satisfies ReviewItem;
```

## Mount The Workbench

The workbench accepts a queue-shaped session. The producer owns how items are
loaded, assigned, filtered, and authorized.

```ts
import {
  createPersistentReviewSessionEventStore,
  mountReviewWorkbench,
} from "@kontourai/survey/review-workbench";
import "@kontourai/survey/review-workbench.css";

const session = {
  items: [registrationStatusReviewItem],
  activeItemName: registrationStatusReviewItem.metadata.name,
  notesByItemName: {},
  decisionsByItemName: {},
  actorId: "reviewer@example.test",
  reviewedAt: new Date().toISOString(),
};

mountReviewWorkbench(document.querySelector("#review")!, session, {
  eventStore: createPersistentReviewSessionEventStore({
    initialEvents,
    persist: ({ events, expectedEventCount }) =>
      saveReviewEvents({ events, expectedEventCount }),
    onStatusChange: (state) => {
      renderPersistenceStatus(state.status);
    },
  }),
});
```

`expectedEventCount` is an optimistic concurrency hint. The producer can reject
a save when another reviewer has already written events for the same review
queue. Survey queues saves and reports persistence status, but the producer
owns the database, conflict response, and retry UX.

## Export Results

Use `buildReviewWorkbenchResultsFromSession` when the producer wants a compact
view of completed review choices for display, audit export, or trusted
in-process code. Use `buildReviewWorkbenchSessionExport` when the producer also
wants the replayable session and event resources.

```ts
import {
  buildReviewWorkbenchResultsFromSession,
  buildReviewWorkbenchSessionExport,
  replayReviewSessionEvents,
} from "@kontourai/survey/review-workbench";

const replayedSession = replayReviewSessionEvents(session, persistedEvents);
const results = buildReviewWorkbenchResultsFromSession(replayedSession);
const exported = buildReviewWorkbenchSessionExport(replayedSession, persistedEvents);

for (const result of results) {
  renderReviewSummary({
    reviewItemName: result.reviewItemName,
    decision: result.decision,
    selectedCandidateId: result.selectedCandidateId,
    selectedValue: result.selectedValue,
    reviewDecision: result.reviewDecision,
    unselectedCandidates: result.unselectedCandidates,
  });
}
```

The producer still decides whether a selected candidate updates a record,
creates a rejected-candidate learning signal, triggers a recomputation, or only
records an audit event. For web mutation routes, use the server-side apply
pattern below instead of trusting browser-computed results.

## Apply Review Results

Survey can derive the selected candidate, review decision resource, and
replayable audit trail. The producer still owns write authority. A server-side
apply path should load the product's current record, rebuild or load the
pre-decision `ReviewItem`/`ReviewSession` snapshot that was presented for
review, replay persisted events against that snapshot, derive
`ReviewWorkbenchResult` values through Survey, validate those values against
the current product state, and only then apply product-specific policy.

For server-side replay, prefer the snapshot-safe apply preparation helper:

```ts
import {
  deriveReviewSessionApplyResultForSnapshot,
} from "@kontourai/survey/review-workbench";

const applyResult = deriveReviewSessionApplyResultForSnapshot({
  snapshot: reviewSessionSnapshot,
  events: persistedEvents,
  requiredResolvedItems: "all",
});

if (!applyResult.ok) {
  throw new Error(applyResult.issues.map((issue) => issue.message).join(" "));
}

for (const result of applyResult.results) {
  assertProductRecordStillMatchesReviewTarget(result);
  applyProductPolicy({
    reviewItemName: result.reviewItemName,
    selectedCandidateId: result.selectedCandidateId,
    selectedValue: result.selectedValue,
    status: result.status,
  });
}
```

Use `requiredResolvedItems: "all"` for full approval flows and `"any"` for
partial apply flows where at least one reviewed item must be ready. Survey
returns replay and completion issues as data so product API routes can choose
their own HTTP status, audit logging, and reviewer-facing copy.

Do not accept browser-submitted `ReviewDecision` resources,
`ReviewWorkbenchSessionExport.results`, or standalone decision fields as write
authority for web mutations. Those payloads are useful for display,
debugging, local trusted scripts, or audit export, but a product server should
derive write results from trusted session state and persisted events. Events
alone are also insufficient when the server cannot reconstruct the reviewed
candidate values; store the reviewed session snapshot or rebuild it from
server-owned data.

Review actor and write time should come from authenticated server context for
mutations. The actor and timestamp in Survey resources describe the review
session, but the product owns authorization, tenancy, reviewer assignment,
write stamps, and conflict handling.

## Project To Surface

Review resources are not a second Surface projection path. When a producer is
ready to expose trust state, it should emit normal Survey observations or claim
records and then call `buildSurveyTrustInput`.

```ts
import {
  buildSurveyTrustInput,
  reviewedCurrentProposedResolution,
  SurveyInputBuilder,
} from "@kontourai/survey";
import { buildTrustReport, validateTrustInput } from "@kontourai/surface";

const surveyInput = new SurveyInputBuilder({
  source: "example-producer.review-session-1",
})
  .addClaimRecords(reviewedCurrentProposedResolution({
    id: "public-record.entity-123.registrationStatus.review-1",
    target: "registrationStatus",
    selectedCandidateRole: "proposed",
    reviewOutcome: {
      status: "verified",
      actor: "reviewer@example.test",
      reviewedAt: new Date().toISOString(),
      rationale: "Source excerpt supports the proposed value.",
    },
    currentObservation,
    proposedObservation,
  }))
  .build();

const report = buildTrustReport(validateTrustInput(
  buildSurveyTrustInput(surveyInput),
));
```

For source-authority claims, prefer
`sourceOfAuthorityObservationBuilder`. For corrected documents or other
multi-candidate cases, prefer `candidateReviewRecord` or the lower-level record
contract when current/proposed semantics do not fit.

## Boundary Checklist

Use this checklist before adding Survey to a producer:

- Product queue state stays product-owned.
- Product auth, tenancy, and reviewer assignment stay product-owned.
- Parser and source ranking policy stay product-owned.
- `ReviewItem` values stay typed; do not pre-stringify values for display.
- `sourceRef`, locator, excerpt, confidence, extractor, and timestamps are
  carried explicitly.
- Source-authority posture is source posture, not Surface `authorityTrace`.
- Verified claims include review actor and review time.
- Missing source context produces a warning or gap; do not invent evidence.
- Product apply code consumes selected candidates or `ReviewWorkbenchResult`
  instead of re-deriving review choices from UI state.
- Product write routes derive results server-side from pre-decision review snapshots plus
  events; they do not trust browser-computed `ReviewDecision` or
  `sessionExport.results` payloads.
- Product write routes stamp mutating actor and time from authenticated server
  context.
- Surface projection uses `buildSurveyTrustInput`, not private review UI state.
