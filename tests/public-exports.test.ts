import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPromptRef,
  buildCanonicalReviewedTrustInput,
  approveExtractionImprovementProposal,
  buildExtractionImprovementProposal,
  foldExtractionImprovementDispositions,
  buildReviewedLearningUpdateProposal,
  createExtractionEnvelopeResolutionIdentity,
  candidateSetStatusFor,
  confidenceBasisForReview,
  currentProposedReviewItem,
  defineProductVocabulary,
  rejectExtractionImprovementProposal,
  stableId,
  SURVEY_INPUT_CONTRACT_VERSION,
} from "../src/index.js";
import { reviewAuditRowKeys } from "../src/review-workbench/review-workbench.js";

describe("public barrel exports", () => {
  it("re-exports the new producer-kit values from the package root", () => {
    assert.equal(typeof stableId, "function");
    assert.equal(typeof defineProductVocabulary, "function");
    assert.equal(typeof confidenceBasisForReview, "function");
    assert.equal(typeof candidateSetStatusFor, "function");
    assert.equal(typeof buildPromptRef, "function");
    assert.equal(typeof buildCanonicalReviewedTrustInput, "function");
    assert.equal(typeof currentProposedReviewItem, "function");
    assert.equal(typeof buildReviewedLearningUpdateProposal, "function");
    assert.equal(typeof buildExtractionImprovementProposal, "function");
    assert.equal(typeof foldExtractionImprovementDispositions, "function");
    assert.equal(typeof approveExtractionImprovementProposal, "function");
    assert.equal(typeof rejectExtractionImprovementProposal, "function");
    assert.equal(typeof createExtractionEnvelopeResolutionIdentity, "function");
    assert.equal(SURVEY_INPUT_CONTRACT_VERSION, "1");
  });

  it("publishes the audit-row keys a host may hold selectors against", () => {
    // Row labels are display copy; these keys are the addressable contract, so
    // a host never has to slug a label to select one row (kontourai/fieldwork#58).
    assert.ok(Array.isArray(reviewAuditRowKeys));
    assert.ok(reviewAuditRowKeys.length > 0);
    assert.equal(new Set(reviewAuditRowKeys).size, reviewAuditRowKeys.length);
    for (const key of reviewAuditRowKeys) {
      assert.match(key, /^[a-z][a-z0-9-]*$/);
    }
    assert.ok(reviewAuditRowKeys.includes("raw-source-id"));
    assert.ok(reviewAuditRowKeys.includes("locator"));
  });

  it("keeps the re-exported helpers behaving as their module definitions", () => {
    assert.equal(stableId(["a", "B"]), "a.b");
    assert.equal(candidateSetStatusFor("verified"), "resolved");
    assert.equal(candidateSetStatusFor(), "needs-review");
  });
});
