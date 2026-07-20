import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPromptRef,
  buildReviewedLearningUpdateProposal,
  createExtractionEnvelopeResolutionIdentity,
  candidateSetStatusFor,
  confidenceBasisForReview,
  currentProposedReviewItem,
  defineProductVocabulary,
  stableId,
  SURVEY_INPUT_CONTRACT_VERSION,
} from "../src/index.js";

describe("public barrel exports", () => {
  it("re-exports the new producer-kit values from the package root", () => {
    assert.equal(typeof stableId, "function");
    assert.equal(typeof defineProductVocabulary, "function");
    assert.equal(typeof confidenceBasisForReview, "function");
    assert.equal(typeof candidateSetStatusFor, "function");
    assert.equal(typeof buildPromptRef, "function");
    assert.equal(typeof currentProposedReviewItem, "function");
    assert.equal(typeof buildReviewedLearningUpdateProposal, "function");
    assert.equal(typeof createExtractionEnvelopeResolutionIdentity, "function");
    assert.equal(SURVEY_INPUT_CONTRACT_VERSION, "1");
  });

  it("keeps the re-exported helpers behaving as their module definitions", () => {
    assert.equal(stableId(["a", "B"]), "a.b");
    assert.equal(candidateSetStatusFor("verified"), "resolved");
    assert.equal(candidateSetStatusFor(), "needs-review");
  });
});
