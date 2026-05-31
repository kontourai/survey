import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTrustReport, validateTrustInput } from "@kontourai/surface";
import { campfitRegistrationStatusFixture } from "../fixtures/campfit-registration-status.js";
import { taxW2CorrectedFixture } from "../fixtures/tax-w2-corrected.js";
import { buildSurveyTrustInput } from "../src/index.js";

describe("Survey Surface projection", () => {
  it("projects Campfit registration status into valid Surface trust input", () => {
    const input = buildSurveyTrustInput(campfitRegistrationStatusFixture);
    const valid = validateTrustInput(input);
    const report = buildTrustReport(valid);

    assert.equal(report.claims.length, 2);
    assert.equal(report.evidence.length, 2);
    assert.equal(report.summary.byStatus.verified, 1);
    assert.equal(report.summary.byStatus.proposed, 1);
    assert.equal(report.claims[0]?.metadata?.survey && typeof report.claims[0].metadata.survey, "object");
  });

  it("projects corrected tax W-2 candidates and preserves derived recompute pressure", () => {
    const input = buildSurveyTrustInput(taxW2CorrectedFixture);
    const valid = validateTrustInput(input);
    const report = buildTrustReport(valid);

    assert.equal(report.claims.length, 6);
    assert.ok(report.summary.byStatus.superseded >= 2);
    assert.equal(report.summary.byStatus.proposed, 3);
    assert.ok(report.changeRecords.some((record) => record.reason === "input-superseded"));
  });

  it("rejects verified claims without review authority", () => {
    const broken = structuredClone(campfitRegistrationStatusFixture);
    broken.reviewOutcomes = [];
    broken.claims[0] = { ...broken.claims[0], status: "verified" };

    assert.throws(
      () => buildSurveyTrustInput(broken),
      /cannot be verified without a review outcome/,
    );
  });

  it("rejects non-manual source claims without locators", () => {
    const broken = structuredClone(campfitRegistrationStatusFixture);
    broken.extractions[0] = { ...broken.extractions[0], locator: undefined };

    assert.throws(
      () => buildSurveyTrustInput(broken),
      /needs a source locator/,
    );
  });
});
