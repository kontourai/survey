import type { SurveyInput } from "../src/index.js";

const generatedAt = "2026-05-31T16:00:00.000Z";

export const correctedDocumentCandidatesFixture: SurveyInput = {
  source: "survey.fixture.corrected-document-candidates",
  generatedAt,
  rawSources: [
    {
      id: "document:source:original",
      kind: "uploaded-document",
      sourceRef: "documents://original-statement.pdf",
      observedAt: "2026-02-01T12:00:00.000Z",
      checksum: "sha256:original",
      locatorScheme: "pdf",
    },
    {
      id: "document:source:corrected",
      kind: "uploaded-document",
      sourceRef: "documents://corrected-statement.pdf",
      observedAt: "2026-03-01T12:00:00.000Z",
      checksum: "sha256:corrected",
      locatorScheme: "pdf",
    },
  ],
  extractions: [
    documentExtraction("original:amount", "document:source:original", "statement.totalAmount", 82000, "pdf:page=1;box=1"),
    documentExtraction("original:credit", "document:source:original", "statement.creditAmount", 8600, "pdf:page=1;box=2"),
    documentExtraction("corrected:amount", "document:source:corrected", "statement.totalAmount", 84000, "pdf:page=1;box=1"),
    documentExtraction("corrected:credit", "document:source:corrected", "statement.creditAmount", 9100, "pdf:page=1;box=2"),
  ],
  candidateSets: [
    documentCandidateSet("amount", "original:amount", 82000, "corrected:amount", 84000),
    documentCandidateSet("credit", "original:credit", 8600, "corrected:credit", 9100),
  ],
  reviewOutcomes: [],
  claims: [
    documentClaim("document.entity-1.statement.amount.original", "amount", "original:amount", "statement.totalAmount", "superseded"),
    documentClaim("document.entity-1.statement.credit.original", "credit", "original:credit", "statement.creditAmount", "superseded"),
    documentClaim("document.entity-1.statement.amount.corrected", "amount", "corrected:amount", "statement.totalAmount", "proposed"),
    documentClaim("document.entity-1.statement.credit.corrected", "credit", "corrected:credit", "statement.creditAmount", "proposed"),
  ],
  derivedClaims: [
    {
      id: "document.entity-1.statement-position.current",
      subjectType: "verified-record.period",
      subjectId: "entity-1:2026",
      surface: "document-review",
      claimType: "derived-field",
      fieldOrBehavior: "statementPosition",
      value: {
        totalAmount: 84000,
        creditAmount: 9100,
        position: "credit-present",
      },
      status: "proposed",
      impactLevel: "high",
      inputClaimIds: [
        { claimId: "document.entity-1.statement.amount.corrected", role: "amount-input", supportStrength: "strong" },
        { claimId: "document.entity-1.statement.credit.corrected", role: "credit-input", supportStrength: "strong" },
      ],
      createdAt: generatedAt,
      updatedAt: generatedAt,
      evidenceSummary: "Derived statement position from corrected source fields.",
      sourceRef: "documents://entities/entity-1/periods/2026/resolved-fields/statement",
      collectedBy: "survey-document-fixture",
    },
    {
      id: "document.entity-1.statement-position.original",
      subjectType: "verified-record.period",
      subjectId: "entity-1:2026",
      surface: "document-review",
      claimType: "derived-field",
      fieldOrBehavior: "statementPosition",
      value: {
        totalAmount: 82000,
        creditAmount: 8600,
        position: "credit-present",
      },
      status: "stale",
      impactLevel: "high",
      inputClaimIds: [
        { claimId: "document.entity-1.statement.amount.original", role: "amount-input", supportStrength: "strong" },
        { claimId: "document.entity-1.statement.credit.original", role: "credit-input", supportStrength: "strong" },
      ],
      createdAt: generatedAt,
      updatedAt: generatedAt,
      evidenceSummary: "Prior statement position derived from original source fields.",
      sourceRef: "documents://entities/entity-1/periods/2026/resolved-fields/statement",
      collectedBy: "survey-document-fixture",
    },
  ],
};

function documentExtraction(id: string, sourceId: string, target: string, value: number, locator: string) {
  return {
    id: `document:extraction:${id}`,
    sourceId,
    target,
    value,
    confidence: 0.96,
    locator,
    excerpt: `${target}=${value}`,
    extractor: "document-field-parser",
    extractedAt: generatedAt,
  };
}

function documentCandidateSet(target: string, originalId: string, originalValue: number, correctedId: string, correctedValue: number) {
  return {
    id: `document:candidates:${target}`,
    target: `statement.${target}`,
    selectedCandidateId: `document:candidate:${correctedId}`,
    status: "needs-review" as const,
    rationale: "Corrected document supersedes the original source but still needs review.",
    candidates: [
      {
        id: `document:candidate:${originalId}`,
        extractionId: `document:extraction:${originalId}`,
        value: originalValue,
        confidence: 0.96,
        sourceRank: 2,
      },
      {
        id: `document:candidate:${correctedId}`,
        extractionId: `document:extraction:${correctedId}`,
        value: correctedValue,
        confidence: 0.96,
        sourceRank: 1,
      },
    ],
  };
}

function documentClaim(id: string, target: string, candidateId: string, fieldOrBehavior: string, status: "proposed" | "superseded") {
  return {
    id,
    candidateSetId: `document:candidates:${target}`,
    candidateId: `document:candidate:${candidateId}`,
    subjectType: "verified-record.period",
    subjectId: "entity-1:2026",
    surface: "document-review",
    claimType: "source-field",
    fieldOrBehavior,
    status,
    impactLevel: "high" as const,
    collectedBy: "document-field-parser",
  };
}
