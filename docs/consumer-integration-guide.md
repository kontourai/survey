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
`ReviewItem` snapshot that was reviewed, replay persisted events against that
snapshot, derive `ReviewWorkbenchResult` values through Survey, validate those
values against the current product state, and only then apply product-specific
policy.

For server-side replay, prefer the snapshot-safe helpers:

```ts
import {
  buildReviewWorkbenchSessionExportForSnapshot,
  validateReviewSessionEventsForSnapshot,
} from "@kontourai/survey/review-workbench";

const issues = validateReviewSessionEventsForSnapshot(reviewedSnapshot, persistedEvents);
if (issues.length > 0) {
  throw new Error("Review events no longer match the reviewed snapshot.");
}

const exported = buildReviewWorkbenchSessionExportForSnapshot(
  reviewedSnapshot,
  persistedEvents,
);

for (const result of exported.results) {
  assertProductRecordStillMatchesReviewTarget(result);
  applyProductPolicy({
    reviewItemName: result.reviewItemName,
    selectedCandidateId: result.selectedCandidateId,
    selectedValue: result.selectedValue,
    status: result.status,
  });
}
```

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
- Product write routes derive results server-side from reviewed snapshots plus
  events; they do not trust browser-computed `ReviewDecision` or
  `sessionExport.results` payloads.
- Product write routes stamp mutating actor and time from authenticated server
  context.
- Surface projection uses `buildSurveyTrustInput`, not private review UI state.
