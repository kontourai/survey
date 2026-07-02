import type { ReviewItem } from "../src/index.js";
import { reviewResourceApiVersion } from "../src/index.js";

export const regulatedDocumentReviewItemExample = {
  apiVersion: reviewResourceApiVersion,
  kind: "ReviewItem",
  metadata: {
    name: "regulated-document-statement-position",
    labels: {
      domain: "regulated-document",
    },
    producer: {
      documentFamily: "example-statement",
      reportingPeriod: "2026",
    },
  },
  spec: {
    target: "statementPosition",
    candidateSetStatus: "needs-review",
    selectedCandidateId: "document:candidate:statement-position:current",
    rationale: "Computed candidates are presented as source versions, not current/proposed UI policy.",
    candidates: [
      {
        id: "document:candidate:statement-position:original",
        role: "source-version",
        value: {
          totalAmount: 82000,
          creditAmount: 8600,
          position: "credit-present",
        },
        confidence: 0.96,
        sourceRank: 2,
        source: {
          sourceId: "document:source:statement-position:original",
          sourceRef: "documents://entities/entity-1/periods/2026/resolved-fields/statement",
          kind: "manual-entry",
          observedAt: "2026-05-31T16:00:00.000Z",
          locatorScheme: "structured-field",
        },
        locator: {
          scheme: "structured-field",
          excerpt: "original statement position from source fields.",
        },
        extraction: {
          extractionId: "document:extraction:statement-position:original",
          target: "statementPosition",
          confidence: 0.96,
          extractor: "statement-position-rule",
          extractedAt: "2026-05-31T16:00:00.000Z",
        },
        claimTarget: {
          claimId: "document.entity-1.statement-position.original",
          subjectType: "verified-record.period",
          subjectId: "entity-1:2026",
          facet: "document-review",
          claimType: "computed-field",
          fieldOrBehavior: "statementPosition",
          impactLevel: "high",
          evidenceType: "calculation_trace",
          evidenceMethod: "validation",
          collectedBy: "survey-document-example",
          derivedFrom: [
            "document.entity-1.statement.amount.original",
            "document.entity-1.statement.credit.original",
          ],
        },
        projection: {
          rawSourceId: "document:source:statement-position:original",
          extractionId: "document:extraction:statement-position:original",
          candidateSetId: "document:candidates:statement-position:original",
          candidateId: "document:candidate:statement-position:original",
          claimId: "document.entity-1.statement-position.original",
        },
      },
      {
        id: "document:candidate:statement-position:current",
        role: "computed",
        value: {
          totalAmount: 84000,
          creditAmount: 9100,
          position: "credit-present",
        },
        confidence: 0.96,
        sourceRank: 1,
        source: {
          sourceId: "document:source:statement-position:current",
          sourceRef: "documents://entities/entity-1/periods/2026/resolved-fields/statement",
          kind: "manual-entry",
          observedAt: "2026-05-31T16:00:00.000Z",
          locatorScheme: "structured-field",
        },
        locator: {
          scheme: "structured-field",
          excerpt: "current statement position from source fields.",
        },
        extraction: {
          extractionId: "document:extraction:statement-position:current",
          target: "statementPosition",
          confidence: 0.96,
          extractor: "statement-position-rule",
          extractedAt: "2026-05-31T16:00:00.000Z",
        },
        claimTarget: {
          claimId: "document.entity-1.statement-position.current",
          subjectType: "verified-record.period",
          subjectId: "entity-1:2026",
          facet: "document-review",
          claimType: "computed-field",
          fieldOrBehavior: "statementPosition",
          impactLevel: "high",
          evidenceType: "calculation_trace",
          evidenceMethod: "validation",
          collectedBy: "survey-document-example",
          derivedFrom: [
            "document.entity-1.statement.amount.corrected",
            "document.entity-1.statement.credit.corrected",
          ],
        },
        projection: {
          rawSourceId: "document:source:statement-position:current",
          extractionId: "document:extraction:statement-position:current",
          candidateSetId: "document:candidates:statement-position:current",
          candidateId: "document:candidate:statement-position:current",
          claimId: "document.entity-1.statement-position.current",
        },
      },
    ],
  },
  status: {
    observedCandidateCount: 2,
    selectedCandidateId: "document:candidate:statement-position:current",
  },
} satisfies ReviewItem;
