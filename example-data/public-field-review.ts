import type { SurveyInput } from "../src/index.js";

const generatedAt = "2026-05-31T16:00:00.000Z";

export const publicFieldReviewExample: SurveyInput = {
  source: "survey.example.public-field-review",
  generatedAt,
  rawSources: [
    {
      id: "public-field:source:approved-page",
      kind: "web-page",
      sourceRef: "https://example.test/listings/example-program",
      observedAt: "2026-05-30T18:00:00.000Z",
      fetchedAt: "2026-05-30T18:00:00.000Z",
      locatorScheme: "html",
    },
    {
      id: "public-field:source:proposal-page",
      kind: "web-page",
      sourceRef: "https://example.test/listings/example-program",
      observedAt: "2026-05-31T15:00:00.000Z",
      fetchedAt: "2026-05-31T15:00:00.000Z",
      locatorScheme: "html",
    },
  ],
  extractions: [
    {
      id: "public-field:extraction:approved",
      sourceId: "public-field:source:approved-page",
      target: "availabilityStatus",
      value: "AVAILABLE",
      confidence: 0.91,
      locator: "html:field=availabilityStatus",
      excerpt: "Availability is open for the example program.",
      extractor: "example-field-review",
      extractedAt: "2026-05-30T18:00:00.000Z",
    },
    {
      id: "public-field:extraction:proposal",
      sourceId: "public-field:source:proposal-page",
      target: "availabilityStatus",
      value: "WAITLIST",
      confidence: 0.82,
      locator: "html:field=availabilityStatus",
      excerpt: "Join the waitlist for this listing.",
      extractor: "example-crawl",
      extractedAt: "2026-05-31T15:00:00.000Z",
    },
  ],
  candidateSets: [
    {
      id: "public-field:candidates:current",
      target: "availabilityStatus",
      selectedCandidateId: "public-field:candidate:approved",
      status: "resolved",
      candidates: [
        {
          id: "public-field:candidate:approved",
          extractionId: "public-field:extraction:approved",
          value: "AVAILABLE",
          confidence: 0.91,
        },
      ],
    },
    {
      id: "public-field:candidates:proposal",
      target: "availabilityStatus",
      status: "needs-review",
      candidates: [
        {
          id: "public-field:candidate:proposal",
          extractionId: "public-field:extraction:proposal",
          value: "WAITLIST",
          confidence: 0.82,
        },
      ],
    },
  ],
  reviewOutcomes: [
    {
      id: "public-field:review:approved",
      candidateSetId: "public-field:candidates:current",
      candidateId: "public-field:candidate:approved",
      status: "verified",
      actor: "example-operator",
      reviewedAt: "2026-05-30T18:05:00.000Z",
      rationale: "Operator approved the field source.",
    },
  ],
  claims: [
    {
      id: "public-field.entity-123.availability-status.current",
      candidateSetId: "public-field:candidates:current",
      candidateId: "public-field:candidate:approved",
      subjectType: "public-record.entity",
      subjectId: "entity-123",
      facet: "public-record.profile",
      claimType: "public-data.field",
      fieldOrBehavior: "availabilityStatus",
      impactLevel: "medium",
      collectedBy: "example-field-review",
      metadata: {
        producer: {
          slug: "example-program",
          displayName: "Example Program",
        },
      },
    },
    {
      id: "public-field.entity-123.availability-status.proposal-456",
      candidateSetId: "public-field:candidates:proposal",
      candidateId: "public-field:candidate:proposal",
      subjectType: "public-record.entity",
      subjectId: "entity-123",
      facet: "public-record.profile",
      claimType: "public-data.field-candidate",
      fieldOrBehavior: "availabilityStatus",
      impactLevel: "medium",
      collectedBy: "example-crawl",
      metadata: {
        producer: {
          proposalId: "proposal-456",
          oldValue: "AVAILABLE",
        },
      },
    },
  ],
};
