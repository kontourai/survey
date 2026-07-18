import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertReviewDecisionModeAllows,
  DecisionModeViolationError,
  validateReviewDecisionMode,
  type ReviewDecisionModeResult,
} from "../src/review-workbench/review-workbench.js";
import { publicDirectoryReviewItemExample } from "../example-data/public-directory-review-resource.js";
import type { ProducerPolicy, ReviewItem } from "../src/review-resource.js";

const currentCandidateId = "public-directory:candidate:current";
const proposedCandidateId = "public-directory:candidate:proposed";

function itemWithPolicy(producerPolicy?: ProducerPolicy): ReviewItem {
  return {
    ...publicDirectoryReviewItemExample,
    spec: {
      ...publicDirectoryReviewItemExample.spec,
      ...(producerPolicy ? { producerPolicy } : {}),
    },
  };
}

function result(overrides: Partial<ReviewDecisionModeResult>): ReviewDecisionModeResult {
  return {
    decision: "accept-proposed",
    selectedCandidateId: proposedCandidateId,
    selectedCandidateRole: "proposed",
    ...overrides,
  };
}

describe("validateReviewDecisionMode", () => {
  it("is a no-op when the item declares no producerPolicy", () => {
    assert.deepEqual(validateReviewDecisionMode(itemWithPolicy(), result({})), []);
  });

  it("is a no-op when producerPolicy has no decisionMode", () => {
    const item = itemWithPolicy({ feedbackTags: ["accuracy"] });
    assert.deepEqual(validateReviewDecisionMode(item, result({})), []);
  });

  it("allows a keep-current decision under decisionMode keep-current", () => {
    const item = itemWithPolicy({ decisionMode: "keep-current" });
    const issues = validateReviewDecisionMode(item, result({
      decision: "keep-current",
      selectedCandidateId: currentCandidateId,
      selectedCandidateRole: "current",
    }));
    assert.deepEqual(issues, []);
  });

  it("rejects a non-keep-current decision under decisionMode keep-current", () => {
    const item = itemWithPolicy({ decisionMode: "keep-current" });
    const issues = validateReviewDecisionMode(item, result({ decision: "accept-proposed" }));
    assert.deepEqual(issues.map((issue) => issue.code), ["decision-not-allowed"]);
  });

  it("deliberately allows could-not-confirm regardless of producer decisionMode", () => {
    for (const decisionMode of ["keep-current", "current-proposed", "free-select"] as const) {
      assert.deepEqual(validateReviewDecisionMode(
        itemWithPolicy({ decisionMode }),
        result({ decision: "could-not-confirm" }),
      ), [], decisionMode);
    }
  });

  it("allows every workbench decision under decisionMode current-proposed", () => {
    const item = itemWithPolicy({ decisionMode: "current-proposed" });
    assert.deepEqual(validateReviewDecisionMode(item, result({ decision: "accept-proposed", selectedCandidateRole: "proposed" })), []);
    assert.deepEqual(validateReviewDecisionMode(item, result({ decision: "keep-current", selectedCandidateId: currentCandidateId, selectedCandidateRole: "current" })), []);
    assert.deepEqual(validateReviewDecisionMode(item, result({ decision: "reject-proposed", selectedCandidateRole: "proposed" })), []);
  });

  it("rejects a non-current/proposed candidate role under decisionMode current-proposed", () => {
    const item = itemWithPolicy({ decisionMode: "current-proposed" });
    const issues = validateReviewDecisionMode(item, result({ selectedCandidateRole: "alternative" }));
    assert.deepEqual(issues.map((issue) => issue.code), ["decision-not-allowed"]);
  });

  it("allows any declared candidate under decisionMode free-select", () => {
    const item = itemWithPolicy({ decisionMode: "free-select" });
    assert.deepEqual(validateReviewDecisionMode(item, result({ selectedCandidateId: currentCandidateId })), []);
    assert.deepEqual(validateReviewDecisionMode(item, result({ selectedCandidateId: proposedCandidateId })), []);
  });

  it("rejects an undeclared candidate under decisionMode free-select", () => {
    const item = itemWithPolicy({ decisionMode: "free-select" });
    const issues = validateReviewDecisionMode(item, result({ selectedCandidateId: "not-in-item" }));
    assert.deepEqual(issues.map((issue) => issue.code), ["candidate-not-in-item"]);
  });

  it("fails closed on an unrecognized decisionMode regardless of the result", () => {
    const item = itemWithPolicy({ decisionMode: "something-else" } as unknown as ProducerPolicy);
    assert.deepEqual(
      validateReviewDecisionMode(item, result({ decision: "keep-current" })).map((issue) => issue.code),
      ["unknown-decision-mode"],
    );
    assert.deepEqual(
      validateReviewDecisionMode(item, result({ decision: "accept-proposed" })).map((issue) => issue.code),
      ["unknown-decision-mode"],
    );
  });
});

describe("assertReviewDecisionModeAllows", () => {
  it("does not throw for an allowed decision", () => {
    const item = itemWithPolicy({ decisionMode: "keep-current" });
    assert.doesNotThrow(() => assertReviewDecisionModeAllows(item, result({
      decision: "keep-current",
      selectedCandidateId: currentCandidateId,
      selectedCandidateRole: "current",
    })));
  });

  it("throws DecisionModeViolationError for a disallowed decision", () => {
    const item = itemWithPolicy({ decisionMode: "keep-current" });
    assert.throws(
      () => assertReviewDecisionModeAllows(item, result({ decision: "accept-proposed" })),
      (error: unknown) =>
        error instanceof DecisionModeViolationError
        && error.issues[0]?.code === "decision-not-allowed",
    );
  });
});
