import { reviewResourceApiVersion, type ReviewItem } from "../review-resource.js";

// Browser-safe mirror of example-data/public-directory-review-resource.ts.
// scripts/check-review-workbench.cjs fails if this data drifts from the canonical example.
export const publicDirectoryReviewItemExample = {
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

export const regulatedRuleConflictReviewItemExample = {
  apiVersion: reviewResourceApiVersion,
  kind: "ReviewItem",
  metadata: {
    name: "regulated-rule-conflict-standard-threshold",
    labels: {
      domain: "regulated-rule-source",
    },
    producer: {
      displayName: "Regulated Rule Review",
      jurisdiction: "example-jurisdiction",
      reportingPeriod: "2026",
    },
  },
  spec: {
    target: "standardThreshold",
    selectedCandidateId: "regulated-rule-conflict-standard-threshold:candidate:current",
    candidateSetStatus: "conflict",
    rationale: "A newly extracted source candidate conflicts with the currently managed rule value.",
    projection: {
      candidateSetId: "regulated-rule-conflict-standard-threshold:candidate-set",
    },
    producerPolicy: {
      decisionMode: "keep-current",
      sourceAuthorityProjection: "only-for-selected-source-backed-value",
      feedbackTags: ["rule-conflict", "source-extraction-review"],
    },
    candidates: [
      {
        id: "regulated-rule-conflict-standard-threshold:candidate:current",
        role: "current",
        value: 15000,
        confidence: 1,
        source: {
          sourceId: "regulated-rule-conflict-standard-threshold:source:current",
          sourceRef: "survey-example://rules/example-jurisdiction/2026/standardThreshold",
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
          extractionId: "regulated-rule-conflict-standard-threshold:extraction:current",
          target: "standardThreshold",
          confidence: 1,
          extractor: "example-rule-manager",
          extractedAt: "2026-06-03T00:00:00.000Z",
        },
        claimTarget: {
          claimId: "regulated-rule.example-jurisdiction.2026.standard-threshold.current",
          subjectType: "regulated-rule-source",
          subjectId: "example-jurisdiction:2026:standardThreshold",
          surface: "regulated.rules",
          claimType: "regulated.rule-source-value",
          fieldOrBehavior: "standardThreshold",
          impactLevel: "high",
          evidenceType: "human_attestation",
          evidenceMethod: "attestation",
          collectedBy: "example-rule-manager",
        },
        projection: {
          rawSourceId: "regulated-rule-conflict-standard-threshold:source:current",
          extractionId: "regulated-rule-conflict-standard-threshold:extraction:current",
          candidateSetId: "regulated-rule-conflict-standard-threshold:candidate-set",
          candidateId: "regulated-rule-conflict-standard-threshold:projection:current",
          claimId: "regulated-rule.example-jurisdiction.2026.standard-threshold.current",
        },
        producer: {
          status: "current-managed-value",
        },
      },
      {
        id: "regulated-rule-conflict-standard-threshold:candidate:proposed",
        role: "proposed",
        value: 16000,
        confidence: 0.95,
        sourceRank: 1,
        source: {
          sourceId: "regulated-rule-conflict-standard-threshold:source:proposed",
          sourceRef: "https://example.test/regulatory-bulletins/2026-thresholds.pdf",
          kind: "uploaded-document",
          observedAt: "2026-06-03T00:30:00.000Z",
          locatorScheme: "pdf",
        },
        locator: {
          scheme: "pdf",
          locator: "pdf:page=12;section=Standard%20Threshold;path=standardThreshold",
          excerpt: "Example Individual Standard Threshold $16,000",
        },
        extraction: {
          extractionId: "regulated-rule-conflict-standard-threshold:extraction:proposed",
          target: "standardThreshold",
          confidence: 0.95,
          extractor: "example-rule-source-parser",
          extractedAt: "2026-06-03T00:30:00.000Z",
        },
        claimTarget: {
          claimId: "regulated-rule.example-jurisdiction.2026.standard-threshold.proposed",
          subjectType: "regulated-rule-source",
          subjectId: "example-jurisdiction:2026:standardThreshold",
          surface: "regulated.rules",
          claimType: "regulated.rule-source-value",
          fieldOrBehavior: "standardThreshold",
          impactLevel: "high",
          evidenceType: "policy_rule",
          evidenceMethod: "extraction",
          collectedBy: "example-rule-source-parser",
        },
        projection: {
          rawSourceId: "regulated-rule-conflict-standard-threshold:source:proposed",
          extractionId: "regulated-rule-conflict-standard-threshold:extraction:proposed",
          candidateSetId: "regulated-rule-conflict-standard-threshold:candidate-set",
          candidateId: "regulated-rule-conflict-standard-threshold:projection:proposed",
          claimId: "regulated-rule.example-jurisdiction.2026.standard-threshold.proposed",
        },
        producer: {
          sourceSection: "Standard Threshold",
          sourcePage: 12,
          sourceAuthority: {
            authorityClass: "official_publication",
            declaredBy: "Example regulatory source registry",
            scope: "standardThreshold rule value for example-jurisdiction 2026",
          },
        },
      },
    ],
  },
  status: {
    observedCandidateCount: 2,
    selectedCandidateId: "regulated-rule-conflict-standard-threshold:candidate:current",
  },
} satisfies ReviewItem;

export const facilityCredentialReviewItemExample = {
  apiVersion: reviewResourceApiVersion,
  kind: "ReviewItem",
  metadata: {
    name: "facility-credential-review-operating-license",
    labels: {
      domain: "facility-credential",
      workflow: "credential-review",
    },
    producer: {
      displayName: "Facility Credential Review",
      slug: "facility-credential-review",
    },
  },
  spec: {
    target: "operatingLicenseCredential",
    selectedCandidateId: "facility-credential-review-operating-license:candidate:current",
    candidateSetStatus: "needs-review",
    rationale: "A source-of-authority registry update may supersede the currently managed facility credential snapshot.",
    projection: {
      candidateSetId: "facility-credential-review-operating-license:candidate-set",
    },
    producerPolicy: {
      decisionMode: "current-proposed",
      sourceAuthorityProjection: "only-for-selected-source-backed-value",
      feedbackTags: ["credential-review", "authority-backed-registry", "nested-value"],
    },
    candidates: [
      {
        id: "facility-credential-review-operating-license:candidate:current",
        role: "current",
        value: {
          licenseNumber: "FAC-2025-1042",
          status: "active",
          issuedAt: "2025-01-15",
          expiresAt: "2026-01-15",
          permittedServices: ["day-program", "after-school-care"],
          inspections: [
            { date: "2025-11-20", outcome: "passed", findingCount: 0 },
          ],
        },
        confidence: 0.98,
        source: {
          sourceId: "facility-credential-review-operating-license:source:managed-record",
          sourceRef: "survey-example://facility-credentials/facility-42/current",
          kind: "manual-entry",
          observedAt: "2026-01-02T16:00:00.000Z",
          locatorScheme: "structured-field",
        },
        locator: {
          scheme: "structured-field",
          locator: "facilityCredentials[path=operatingLicense]",
          excerpt: "Managed facility credential FAC-2025-1042 is active through 2026-01-15.",
        },
        extraction: {
          extractionId: "facility-credential-review-operating-license:extraction:current",
          target: "operatingLicenseCredential",
          confidence: 0.98,
          extractor: "credential-record-manager",
          extractedAt: "2026-01-02T16:00:00.000Z",
        },
        claimTarget: {
          claimId: "facility-credential.facility-42.operating-license.current",
          subjectType: "facility",
          subjectId: "facility-42",
          surface: "facility.credential-profile",
          claimType: "facility.credential",
          fieldOrBehavior: "operatingLicenseCredential",
          impactLevel: "high",
          evidenceType: "human_attestation",
          evidenceMethod: "attestation",
          collectedBy: "credential-record-manager",
        },
        projection: {
          rawSourceId: "facility-credential-review-operating-license:source:managed-record",
          extractionId: "facility-credential-review-operating-license:extraction:current",
          candidateSetId: "facility-credential-review-operating-license:candidate-set",
          candidateId: "facility-credential-review-operating-license:projection:current",
          claimId: "facility-credential.facility-42.operating-license.current",
        },
        producer: {
          credentialSystem: "managed-record",
        },
      },
      {
        id: "facility-credential-review-operating-license:candidate:proposed",
        role: "proposed",
        value: {
          licenseNumber: "FAC-2026-1042",
          status: "active",
          issuedAt: "2026-01-16",
          expiresAt: "2027-01-15",
          permittedServices: ["day-program", "after-school-care", "summer-session"],
          inspections: [
            { date: "2026-01-10", outcome: "passed", findingCount: 1 },
            { date: "2026-01-12", outcome: "corrected", findingCount: 0 },
          ],
        },
        confidence: 0.93,
        sourceRank: 1,
        source: {
          sourceId: "facility-credential-review-operating-license:source:registry",
          sourceRef: "https://example.test/facility-registry/facility-42/license",
          kind: "api-record",
          observedAt: "2026-01-17T14:45:00.000Z",
          fetchedAt: "2026-01-17T14:45:00.000Z",
          locatorScheme: "structured-field",
        },
        locator: {
          scheme: "structured-field",
          locator: "/facilityCredentials/operatingLicense",
          excerpt: "License FAC-2026-1042 active through 2027-01-15; permitted services include summer-session.",
        },
        extraction: {
          extractionId: "facility-credential-review-operating-license:extraction:registry",
          target: "operatingLicenseCredential",
          confidence: 0.93,
          extractor: "credential-registry-sync",
          extractedAt: "2026-01-17T14:45:00.000Z",
        },
        claimTarget: {
          claimId: "facility-credential.facility-42.operating-license.registry",
          subjectType: "facility",
          subjectId: "facility-42",
          surface: "facility.credential-profile",
          claimType: "facility.credential-candidate",
          fieldOrBehavior: "operatingLicenseCredential",
          impactLevel: "high",
          evidenceType: "source_excerpt",
          evidenceMethod: "extraction",
          collectedBy: "credential-registry-sync",
        },
        projection: {
          rawSourceId: "facility-credential-review-operating-license:source:registry",
          extractionId: "facility-credential-review-operating-license:extraction:registry",
          candidateSetId: "facility-credential-review-operating-license:candidate-set",
          candidateId: "facility-credential-review-operating-license:projection:registry",
          claimId: "facility-credential.facility-42.operating-license.registry",
        },
        producer: {
          credentialSystem: "source-of-authority-registry",
          sourceAuthority: {
            authorityClass: "facility-credential-registry",
            declaredBy: "Example Facility Registry",
            scope: "Operating license credential for facility-42",
          },
        },
      },
    ],
  },
  status: {
    observedCandidateCount: 2,
    selectedCandidateId: "facility-credential-review-operating-license:candidate:current",
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
    ...publicDirectoryReviewItemExample,
    metadata: {
      ...publicDirectoryReviewItemExample.metadata,
      name,
    },
    spec: {
      ...publicDirectoryReviewItemExample.spec,
      target,
      selectedCandidateId: `${name}:candidate:current`,
      candidateSetStatus,
      producerPolicy: {
        feedbackTags,
      },
      rationale: `Example-backed local review queue item for ${target}.`,
      candidates: publicDirectoryReviewItemExample.spec.candidates.map((candidate) => {
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
      observedCandidateCount: publicDirectoryReviewItemExample.status?.observedCandidateCount,
      selectedCandidateId: `${name}:candidate:current`,
      reviewDecisionName: candidateSetStatus === "resolved" ? `${name}-resolved-decision` : undefined,
    },
  };
}

export const reviewWorkbenchQueueExamples = [
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
  publicDirectoryReviewItemExample,
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
  regulatedRuleConflictReviewItemExample,
] satisfies ReviewItem[];
