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
        producer: {
          sourceAuthority: {
            authorityClass: "public-directory-listing",
            declaredBy: "Example Program public directory",
            scope: "availabilityStatus field on entity-123",
          },
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
          sourceAuthority: {
            authorityClass: "public-directory-listing",
            declaredBy: "Example Program public directory crawler",
            scope: "availabilityStatus field on entity-123",
          },
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

function queueFixture(
  name: string,
  target: string,
  currentValue: string,
  proposedValue: string,
  candidateSetStatus: ReviewItem["spec"]["candidateSetStatus"],
  feedbackTags: string[],
): ReviewItem {
  return {
    ...publicDirectoryReviewItemFixture,
    metadata: {
      ...publicDirectoryReviewItemFixture.metadata,
      name,
    },
    spec: {
      ...publicDirectoryReviewItemFixture.spec,
      target,
      selectedCandidateId: `${name}:candidate:current`,
      candidateSetStatus,
      producerPolicy: {
        feedbackTags,
      },
      rationale: `Fixture-backed local review queue item for ${target}.`,
      candidates: publicDirectoryReviewItemFixture.spec.candidates.map((candidate) => {
        const role = candidate.role ?? "candidate";
        const value = role === "proposed" ? proposedValue : currentValue;

        return {
          ...candidate,
          id: `${name}:candidate:${role}`,
          value,
          source: {
            ...candidate.source,
            sourceId: `${name}:source:${role}`,
          },
          extraction: {
            ...candidate.extraction,
            extractionId: `${name}:extraction:${role}`,
            target,
          },
          claimTarget: {
            ...candidate.claimTarget,
            claimId: `public-field.entity-123.${target}.${role}`,
            fieldOrBehavior: target,
          },
          projection: {
            ...candidate.projection,
            rawSourceId: `${name}:source:${role}`,
            extractionId: `${name}:extraction:${role}`,
            candidateSetId: `${name}:candidate-set`,
            candidateId: `${name}:projection:${role}`,
            reviewOutcomeId: role === "current" && candidateSetStatus === "resolved" ? `${name}:review:resolved` : undefined,
            claimId: `public-field.entity-123.${target}.${role}`,
          },
          producer: {
            ...candidate.producer,
          },
        };
      }),
    },
    status: {
      observedCandidateCount: publicDirectoryReviewItemFixture.status?.observedCandidateCount,
      selectedCandidateId: `${name}:candidate:current`,
      reviewDecisionName: candidateSetStatus === "resolved" ? `${name}-resolved-decision` : undefined,
    },
  };
}

export const reviewWorkbenchQueueFixtures = [
  queueFixture(
    "public-directory-hours",
    "hours",
    "Weekdays 9am-5pm",
    "Weekdays 8am-6pm",
    "needs-review",
    ["hours-change", "crawler-suggested"],
  ),
  queueFixture(
    "public-directory-phone",
    "phoneNumber",
    "+1-555-0100",
    "+1-555-0199",
    "needs-review",
    ["contact-field", "source-conflict"],
  ),
  publicDirectoryReviewItemFixture,
  queueFixture(
    "public-directory-address",
    "streetAddress",
    "100 Main Street",
    "102 Main Street",
    "needs-review",
    ["address-change", "producer-escalation-candidate"],
  ),
  queueFixture(
    "public-directory-license",
    "licenseStatus",
    "ACTIVE",
    "EXPIRED",
    "escalated",
    ["licensing", "manual-review-required"],
  ),
] satisfies ReviewItem[];
