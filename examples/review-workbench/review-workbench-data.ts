import { reviewResourceApiVersion, type ReviewItem } from "../../src/review-resource.js";

// Browser-safe mirror of fixtures/public-directory-review-resource.ts.
// scripts/check-review-workbench.cjs fails if this data drifts from the canonical fixture.
export const publicDirectoryReviewItemFixture = {
  apiVersion: reviewResourceApiVersion,
  kind: "ReviewItem",
  metadata: {
    name: "public-directory-availability",
    labels: {
      domain: "public-directory",
    },
    producer: {
      displayName: "Example Program",
      slug: "example-program",
    },
  },
  spec: {
    target: "availabilityStatus",
    selectedCandidateId: "public-directory:candidate:current",
    candidateSetStatus: "resolved",
    rationale: "Reviewed public directory field and retained the current value.",
    candidates: [
      {
        id: "public-directory:candidate:current",
        role: "current",
        value: "AVAILABLE",
        confidence: 0.91,
        source: {
          sourceId: "public-field:source:approved-page",
          sourceRef: "https://example.test/listings/example-program",
          kind: "web-page",
          observedAt: "2026-05-30T18:00:00.000Z",
          fetchedAt: "2026-05-30T18:00:00.000Z",
          locatorScheme: "html",
        },
        locator: {
          scheme: "html",
          locator: "html:field=availabilityStatus",
          excerpt: "Availability is open for the example program.",
        },
        extraction: {
          extractionId: "public-field:extraction:approved",
          target: "availabilityStatus",
          confidence: 0.91,
          extractor: "example-field-review",
          extractedAt: "2026-05-30T18:00:00.000Z",
        },
        claimTarget: {
          claimId: "public-field.entity-123.availability-status.current",
          subjectType: "public-record.entity",
          subjectId: "entity-123",
          surface: "public-record.profile",
          claimType: "public-data.field",
          fieldOrBehavior: "availabilityStatus",
          impactLevel: "medium",
          collectedBy: "example-field-review",
        },
        projection: {
          rawSourceId: "public-field:source:approved-page",
          extractionId: "public-field:extraction:approved",
          candidateSetId: "public-field:candidates:current",
          candidateId: "public-field:candidate:approved",
          reviewOutcomeId: "public-field:review:approved",
          claimId: "public-field.entity-123.availability-status.current",
        },
      },
      {
        id: "public-directory:candidate:proposed",
        role: "proposed",
        value: "WAITLIST",
        confidence: 0.82,
        source: {
          sourceId: "public-field:source:proposal-page",
          sourceRef: "https://example.test/listings/example-program",
          kind: "web-page",
          observedAt: "2026-05-31T15:00:00.000Z",
          fetchedAt: "2026-05-31T15:00:00.000Z",
          locatorScheme: "html",
        },
        locator: {
          scheme: "html",
          locator: "html:field=availabilityStatus",
          excerpt: "Join the waitlist for this listing.",
        },
        extraction: {
          extractionId: "public-field:extraction:proposal",
          target: "availabilityStatus",
          confidence: 0.82,
          extractor: "example-crawl",
          extractedAt: "2026-05-31T15:00:00.000Z",
        },
        claimTarget: {
          claimId: "public-field.entity-123.availability-status.proposal-456",
          subjectType: "public-record.entity",
          subjectId: "entity-123",
          surface: "public-record.profile",
          claimType: "public-data.field-candidate",
          fieldOrBehavior: "availabilityStatus",
          impactLevel: "medium",
          collectedBy: "example-crawl",
        },
        projection: {
          rawSourceId: "public-field:source:proposal-page",
          extractionId: "public-field:extraction:proposal",
          candidateSetId: "public-field:candidates:proposal",
          candidateId: "public-field:candidate:proposal",
          claimId: "public-field.entity-123.availability-status.proposal-456",
        },
        producer: {
          proposalId: "proposal-456",
          oldValue: "AVAILABLE",
        },
      },
    ],
  },
  status: {
    observedCandidateCount: 2,
    selectedCandidateId: "public-directory:candidate:current",
    reviewDecisionName: "public-directory-availability-operator-decision",
  },
} satisfies ReviewItem;
