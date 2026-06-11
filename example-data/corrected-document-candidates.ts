import type { SurveyInput } from "../src/index.js";

const generatedAt = "2026-05-31T16:00:00.000Z";

export const correctedDocumentCandidatesExample: SurveyInput = {
  source: "survey.example.corrected-document-candidates",
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
    computationSource("current"),
    computationSource("original"),
  ],
  extractions: [
    documentExtraction("original:amount", "document:source:original", "statement.totalAmount", 82000, "pdf:page=1;box=1"),
    documentExtraction("original:credit", "document:source:original", "statement.creditAmount", 8600, "pdf:page=1;box=2"),
    documentExtraction("corrected:amount", "document:source:corrected", "statement.totalAmount", 84000, "pdf:page=1;box=1"),
    documentExtraction("corrected:credit", "document:source:corrected", "statement.creditAmount", 9100, "pdf:page=1;box=2"),
    computationExtraction("current", 84000, 9100),
    computationExtraction("original", 82000, 8600),
  ],
  candidateSets: [
    documentCandidateSet("amount", "original:amount", 82000, "corrected:amount", 84000),
    documentCandidateSet("credit", "original:credit", 8600, "corrected:credit", 9100),
    computationCandidateSet("current", 84000, 9100),
    computationCandidateSet("original", 82000, 8600),
  ],
  reviewOutcomes: [],
  claims: [
    documentClaim("document.entity-1.statement.amount.original", "amount", "original:amount", "statement.totalAmount", "superseded"),
    documentClaim("document.entity-1.statement.credit.original", "credit", "original:credit", "statement.creditAmount", "superseded"),
    documentClaim("document.entity-1.statement.amount.corrected", "amount", "corrected:amount", "statement.totalAmount", "proposed"),
    documentClaim("document.entity-1.statement.credit.corrected", "credit", "corrected:credit", "statement.creditAmount", "proposed"),
    computationClaim("current", "proposed", [
      "document.entity-1.statement.amount.corrected",
      "document.entity-1.statement.credit.corrected",
    ]),
    computationClaim("original", "stale", [
      "document.entity-1.statement.amount.original",
      "document.entity-1.statement.credit.original",
    ]),
  ],
};

function statementPosition(totalAmount: number, creditAmount: number) {
  return {
    totalAmount,
    creditAmount,
    position: "credit-present",
  };
}

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

function computationSource(id: "current" | "original") {
  return {
    id: `document:source:statement-position:${id}`,
    kind: "manual-entry" as const,
    sourceRef: "documents://entities/entity-1/periods/2026/resolved-fields/statement",
    observedAt: generatedAt,
    locatorScheme: "structured-field" as const,
  };
}

function computationExtraction(id: "current" | "original", totalAmount: number, creditAmount: number) {
  return {
    id: `document:extraction:statement-position:${id}`,
    sourceId: `document:source:statement-position:${id}`,
    target: "statementPosition",
    value: statementPosition(totalAmount, creditAmount),
    confidence: 0.96,
    extractor: "statement-position-rule",
    extractedAt: generatedAt,
    excerpt: `${id} statement position from source fields.`,
  };
}

function computationCandidateSet(id: "current" | "original", totalAmount: number, creditAmount: number) {
  return {
    id: `document:candidates:statement-position:${id}`,
    target: "statementPosition",
    selectedCandidateId: `document:candidate:statement-position:${id}`,
    status: "needs-review" as const,
    rationale: "Statement position is computed from statement amount and credit fields.",
    candidates: [
      {
        id: `document:candidate:statement-position:${id}`,
        extractionId: `document:extraction:statement-position:${id}`,
        value: statementPosition(totalAmount, creditAmount),
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

function computationClaim(id: "current" | "original", status: "proposed" | "stale", inputClaimIds: string[]) {
  const roles = ["amount-input", "credit-input"];
  return {
    id: `document.entity-1.statement-position.${id}`,
    candidateSetId: `document:candidates:statement-position:${id}`,
    candidateId: `document:candidate:statement-position:${id}`,
    subjectType: "verified-record.period",
    subjectId: "entity-1:2026",
    surface: "document-review",
    claimType: "computed-field",
    fieldOrBehavior: "statementPosition",
    status,
    impactLevel: "high" as const,
    evidenceType: "calculation_trace" as const,
    evidenceMethod: "validation" as const,
    collectedBy: "survey-document-example",
    eventMethod: "rule-application",
    derivedFrom: inputClaimIds,
    derivationEdges: inputClaimIds.map((inputClaimId, index) => ({
      inputClaimId,
      method: "rule-application" as const,
      role: roles[index],
      supportStrength: "strong" as const,
    })),
  };
}
