import type { SurveyInput } from "../src/index.js";

const generatedAt = "2026-05-31T16:00:00.000Z";

export const campfitRegistrationStatusFixture: SurveyInput = {
  source: "survey.fixture.campfit.registration-status",
  generatedAt,
  rawSources: [
    {
      id: "campfit:source:keystone-site",
      kind: "web-page",
      sourceRef: "https://example.test/camps/keystone-summer",
      observedAt: "2026-05-30T18:00:00.000Z",
      fetchedAt: "2026-05-30T18:00:00.000Z",
      locatorScheme: "html",
    },
    {
      id: "campfit:source:keystone-crawl-2",
      kind: "web-page",
      sourceRef: "https://example.test/camps/keystone-summer",
      observedAt: "2026-05-31T15:00:00.000Z",
      fetchedAt: "2026-05-31T15:00:00.000Z",
      locatorScheme: "html",
    },
  ],
  extractions: [
    {
      id: "campfit:extraction:registration-status:approved",
      sourceId: "campfit:source:keystone-site",
      target: "registrationStatus",
      value: "OPEN",
      confidence: 0.91,
      locator: "html:field=registrationStatus",
      excerpt: "Registration is open for Keystone Summer Camp.",
      extractor: "campfit-field-review",
      extractedAt: "2026-05-30T18:00:00.000Z",
    },
    {
      id: "campfit:extraction:registration-status:proposal",
      sourceId: "campfit:source:keystone-crawl-2",
      target: "registrationStatus",
      value: "WAITLIST",
      confidence: 0.82,
      locator: "html:field=registrationStatus",
      excerpt: "Join the waitlist for this session.",
      extractor: "campfit-crawl",
      extractedAt: "2026-05-31T15:00:00.000Z",
    },
  ],
  candidateSets: [
    {
      id: "campfit:candidates:registration-status:current",
      target: "registrationStatus",
      selectedCandidateId: "campfit:candidate:registration-status:approved",
      status: "resolved",
      candidates: [
        {
          id: "campfit:candidate:registration-status:approved",
          extractionId: "campfit:extraction:registration-status:approved",
          value: "OPEN",
          confidence: 0.91,
        },
      ],
    },
    {
      id: "campfit:candidates:registration-status:proposal",
      target: "registrationStatus",
      status: "needs-review",
      candidates: [
        {
          id: "campfit:candidate:registration-status:proposal",
          extractionId: "campfit:extraction:registration-status:proposal",
          value: "WAITLIST",
          confidence: 0.82,
        },
      ],
    },
  ],
  reviewOutcomes: [
    {
      id: "campfit:review:registration-status:approved",
      candidateSetId: "campfit:candidates:registration-status:current",
      candidateId: "campfit:candidate:registration-status:approved",
      status: "verified",
      actor: "campfit-admin",
      reviewedAt: "2026-05-30T18:05:00.000Z",
      rationale: "Operator approved the field source.",
    },
  ],
  claims: [
    {
      id: "campfit.camp-123.registration-status.current",
      candidateSetId: "campfit:candidates:registration-status:current",
      candidateId: "campfit:candidate:registration-status:approved",
      subjectType: "public-directory.camp",
      subjectId: "camp-123",
      surface: "public-directory.camp-profile",
      claimType: "public-data.field",
      fieldOrBehavior: "registrationStatus",
      impactLevel: "medium",
      collectedBy: "campfit-field-review",
      metadata: {
        campfit: {
          campSlug: "keystone-summer",
          campName: "Keystone Summer Camp",
        },
      },
    },
    {
      id: "campfit.camp-123.registration-status.proposal-456",
      candidateSetId: "campfit:candidates:registration-status:proposal",
      candidateId: "campfit:candidate:registration-status:proposal",
      subjectType: "public-directory.camp",
      subjectId: "camp-123",
      surface: "public-directory.camp-profile",
      claimType: "public-data.field-candidate",
      fieldOrBehavior: "registrationStatus",
      impactLevel: "medium",
      collectedBy: "campfit-crawl",
      metadata: {
        campfit: {
          proposalId: "proposal-456",
          oldValue: "OPEN",
        },
      },
    },
  ],
};
