import type { SurveyInput } from "../src/index.js";

const generatedAt = "2026-05-31T16:00:00.000Z";

export const taxW2CorrectedFixture: SurveyInput = {
  source: "survey.fixture.tax.w2-corrected",
  generatedAt,
  rawSources: [
    {
      id: "tax:source:w2-original",
      kind: "uploaded-document",
      sourceRef: "taxes://documents/w2-original.pdf",
      observedAt: "2026-02-01T12:00:00.000Z",
      checksum: "sha256:original",
      locatorScheme: "pdf",
    },
    {
      id: "tax:source:w2-corrected",
      kind: "uploaded-document",
      sourceRef: "taxes://documents/w2-corrected.pdf",
      observedAt: "2026-03-01T12:00:00.000Z",
      checksum: "sha256:corrected",
      locatorScheme: "pdf",
    },
  ],
  extractions: [
    w2Extraction("original:wages", "tax:source:w2-original", "w2.wages", 82000, "pdf:page=1;box=1"),
    w2Extraction("original:withholding", "tax:source:w2-original", "w2.federalIncomeTaxWithheld", 8600, "pdf:page=1;box=2"),
    w2Extraction("corrected:wages", "tax:source:w2-corrected", "w2.wages", 84000, "pdf:page=1;box=1"),
    w2Extraction("corrected:withholding", "tax:source:w2-corrected", "w2.federalIncomeTaxWithheld", 9100, "pdf:page=1;box=2"),
  ],
  candidateSets: [
    w2CandidateSet("wages", "original:wages", 82000, "corrected:wages", 84000),
    w2CandidateSet("withholding", "original:withholding", 8600, "corrected:withholding", 9100),
  ],
  reviewOutcomes: [],
  claims: [
    w2Claim("tax.hh-1.2025.w2.wages.original", "wages", "original:wages", "w2.wages", "superseded"),
    w2Claim("tax.hh-1.2025.w2.federal-withholding.original", "withholding", "original:withholding", "w2.federalIncomeTaxWithheld", "superseded"),
    w2Claim("tax.hh-1.2025.w2.wages.corrected", "wages", "corrected:wages", "w2.wages", "proposed"),
    w2Claim("tax.hh-1.2025.w2.federal-withholding.corrected", "withholding", "corrected:withholding", "w2.federalIncomeTaxWithheld", "proposed"),
  ],
  derivedClaims: [
    {
      id: "tax.hh-1.2025.withholding-position.current",
      subjectType: "tax.household-year",
      subjectId: "hh-1:2025",
      surface: "tax.return-prep",
      claimType: "tax.derived-position",
      fieldOrBehavior: "withholdingPosition",
      value: {
        wages: 84000,
        federalIncomeTaxWithheld: 9100,
        position: "withholding-present",
      },
      status: "proposed",
      impactLevel: "high",
      inputClaimIds: [
        { claimId: "tax.hh-1.2025.w2.wages.corrected", role: "wage-input", supportStrength: "strong" },
        { claimId: "tax.hh-1.2025.w2.federal-withholding.corrected", role: "withholding-input", supportStrength: "strong" },
      ],
      createdAt: generatedAt,
      updatedAt: generatedAt,
      evidenceSummary: "Derived withholding position from corrected W-2 wages and federal withholding.",
      sourceRef: "taxes://households/hh-1/years/2025/resolved-facts/w2",
      collectedBy: "survey-tax-fixture",
    },
    {
      id: "tax.hh-1.2025.withholding-position.original",
      subjectType: "tax.household-year",
      subjectId: "hh-1:2025",
      surface: "tax.return-prep",
      claimType: "tax.derived-position",
      fieldOrBehavior: "withholdingPosition",
      value: {
        wages: 82000,
        federalIncomeTaxWithheld: 8600,
        position: "withholding-present",
      },
      status: "stale",
      impactLevel: "high",
      inputClaimIds: [
        { claimId: "tax.hh-1.2025.w2.wages.original", role: "wage-input", supportStrength: "strong" },
        { claimId: "tax.hh-1.2025.w2.federal-withholding.original", role: "withholding-input", supportStrength: "strong" },
      ],
      createdAt: generatedAt,
      updatedAt: generatedAt,
      evidenceSummary: "Prior withholding position derived from original W-2 values.",
      sourceRef: "taxes://households/hh-1/years/2025/resolved-facts/w2",
      collectedBy: "survey-tax-fixture",
    },
  ],
};

function w2Extraction(id: string, sourceId: string, target: string, value: number, locator: string) {
  return {
    id: `tax:extraction:${id}`,
    sourceId,
    target,
    value,
    confidence: 0.96,
    locator,
    excerpt: `${target}=${value}`,
    extractor: "tax-w2-parser",
    extractedAt: generatedAt,
  };
}

function w2CandidateSet(target: string, originalId: string, originalValue: number, correctedId: string, correctedValue: number) {
  return {
    id: `tax:candidates:${target}`,
    target: `w2.${target}`,
    selectedCandidateId: `tax:candidate:${correctedId}`,
    status: "needs-review" as const,
    rationale: "Corrected W-2 supersedes the original source but still needs taxpayer review.",
    candidates: [
      {
        id: `tax:candidate:${originalId}`,
        extractionId: `tax:extraction:${originalId}`,
        value: originalValue,
        confidence: 0.96,
        sourceRank: 2,
      },
      {
        id: `tax:candidate:${correctedId}`,
        extractionId: `tax:extraction:${correctedId}`,
        value: correctedValue,
        confidence: 0.96,
        sourceRank: 1,
      },
    ],
  };
}

function w2Claim(id: string, target: string, candidateId: string, fieldOrBehavior: string, status: "proposed" | "superseded") {
  return {
    id,
    candidateSetId: `tax:candidates:${target}`,
    candidateId: `tax:candidate:${candidateId}`,
    subjectType: "tax.household-year",
    subjectId: "hh-1:2025",
    surface: "tax.return-prep",
    claimType: "tax.source-fact",
    fieldOrBehavior,
    status,
    impactLevel: "high" as const,
    collectedBy: "tax-w2-parser",
  };
}
