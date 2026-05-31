import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTrustReport, validateTrustInput } from "@kontourai/surface";
import { correctedDocumentCandidatesFixture } from "../fixtures/corrected-document-candidates.js";
import { publicFieldReviewFixture } from "../fixtures/public-field-review.js";
import { buildSurveyTrustInput, SurveyInputBuilder } from "../src/index.js";

describe("Survey Surface projection", () => {
  it("projects a reviewed public field into valid Surface trust input", () => {
    const input = buildSurveyTrustInput(publicFieldReviewFixture);
    const valid = validateTrustInput(input);
    const report = buildTrustReport(valid);

    assert.equal(report.claims.length, 2);
    assert.equal(report.evidence.length, 2);
    assert.equal(report.summary.byStatus.verified, 1);
    assert.equal(report.summary.byStatus.proposed, 1);
    assert.equal(report.claims[0]?.metadata?.survey && typeof report.claims[0].metadata.survey, "object");
  });

  it("projects corrected document candidates and preserves derived recompute pressure", () => {
    const input = buildSurveyTrustInput(correctedDocumentCandidatesFixture);
    const valid = validateTrustInput(input);
    const report = buildTrustReport(valid);

    assert.equal(report.claims.length, 6);
    assert.ok(report.summary.byStatus.superseded >= 2);
    assert.equal(report.summary.byStatus.proposed, 3);
    assert.ok(report.changeRecords.some((record) => record.reason === "input-superseded"));
  });

  it("rejects verified claims without review authority", () => {
    const broken = structuredClone(publicFieldReviewFixture);
    broken.reviewOutcomes = [];
    broken.claims[0] = { ...broken.claims[0], status: "verified" };

    assert.throws(
      () => buildSurveyTrustInput(broken),
      /cannot be verified without a review outcome/,
    );
  });

  it("rejects non-manual source claims without locators", () => {
    const broken = structuredClone(publicFieldReviewFixture);
    broken.extractions[0] = { ...broken.extractions[0], locator: undefined };

    assert.throws(
      () => buildSurveyTrustInput(broken),
      /needs a source locator/,
    );
  });

  it("builds Survey input through the record builder", () => {
    const input = new SurveyInputBuilder({
        source: "survey.builder.fixture",
        generatedAt: "2026-05-31T16:00:00.000Z",
      })
      .addClaimRecord({
        rawSource: publicFieldReviewFixture.rawSources[0]!,
        extraction: publicFieldReviewFixture.extractions[0]!,
        candidateSet: publicFieldReviewFixture.candidateSets[0]!,
        reviewOutcome: publicFieldReviewFixture.reviewOutcomes[0]!,
        claim: publicFieldReviewFixture.claims[0]!,
      })
      .build();

    const report = buildTrustReport(validateTrustInput(buildSurveyTrustInput(input)));
    assert.equal(report.summary.byStatus.verified, 1);
  });

  it("builds a single claim observation without manual link IDs", () => {
    const input = new SurveyInputBuilder({
      source: "survey.observation.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    })
      .addObservation({
        id: "observation.entity-1.availability",
        rawSource: {
          kind: "web-page",
          sourceRef: "https://example.test/listing",
          observedAt: "2026-05-31T15:00:00.000Z",
          locatorScheme: "html",
        },
        extraction: {
          target: "availabilityStatus",
          value: "AVAILABLE",
          confidence: 0.9,
          locator: "html:field=availabilityStatus",
          excerpt: "Availability is open.",
          extractor: "example-crawler",
          extractedAt: "2026-05-31T15:00:00.000Z",
        },
        reviewOutcome: {
          status: "verified",
          actor: "example-operator",
          reviewedAt: "2026-05-31T15:05:00.000Z",
        },
        claim: {
          subjectType: "public-record.entity",
          subjectId: "entity-1",
          surface: "public-record.profile",
          claimType: "public-data.field",
          fieldOrBehavior: "availabilityStatus",
          impactLevel: "medium",
          collectedBy: "example-crawler",
        },
      })
      .build();

    const report = buildTrustReport(validateTrustInput(buildSurveyTrustInput(input)));
    assert.equal(report.summary.byStatus.verified, 1);
    const surveyMetadata = report.claims[0]?.metadata?.survey as { candidateSetId?: string } | undefined;
    assert.equal(surveyMetadata?.candidateSetId, "observation.entity-1.availability.candidates");
  });
});
