import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  currentProposedReviewItem,
  type CurrentProposedCandidateInput,
} from "../src/current-proposed-review-item.js";
import {
  buildReviewWorkbenchResultsFromSession,
  initialReviewQueueSessionState,
} from "../src/review-workbench/review-workbench.js";
import { reviewResourceApiVersion } from "../src/review-resource.js";

function candidate(overrides: Partial<CurrentProposedCandidateInput> & { value: unknown }): CurrentProposedCandidateInput {
  return {
    source: { sourceRef: "https://example.test/listings/entity-123", kind: "web-page", locatorScheme: "html" },
    extraction: { target: "availabilityStatus", extractor: "example-field-review" },
    claimTarget: {
      subjectType: "public-directory.entity",
      subjectId: "entity-123",
      surface: "public-directory.entity-profile",
      claimType: "public-data.field",
      fieldOrBehavior: "availabilityStatus",
      impactLevel: "medium",
    },
    ...overrides,
  };
}

describe("currentProposedReviewItem", () => {
  it("wires the generic current/proposed envelope with deterministic ids", () => {
    const item = currentProposedReviewItem({
      name: "public-directory-availability",
      target: "availabilityStatus",
      labels: { domain: "public-directory" },
      producerMetadata: { displayName: "Example Program", slug: "example-program" },
      rationale: "Operator review required before projecting a verified claim.",
      producerPolicy: { decisionMode: "current-proposed", sourceAuthorityProjection: "only-for-selected-source-backed-value" },
      current: candidate({ value: "AVAILABLE", confidence: 0.91 }),
      proposed: candidate({ value: "WAITLIST", confidence: 0.82 }),
    });

    assert.equal(item.apiVersion, reviewResourceApiVersion);
    assert.equal(item.kind, "ReviewItem");
    assert.equal(item.metadata.name, "public-directory-availability");
    assert.equal(item.spec.candidateSetStatus, "needs-review");
    assert.equal(item.spec.projection?.candidateSetId, "public-directory-availability.candidates");
    assert.equal(item.status?.observedCandidateCount, 2);
    assert.equal(item.status?.selectedCandidateId, undefined);

    const [current, proposed] = item.spec.candidates;
    assert.equal(current?.id, "public-directory-availability.current");
    assert.equal(current?.role, "current");
    assert.equal(current?.projection?.candidateSetId, "public-directory-availability.candidates");
    assert.equal(current?.projection?.candidateId, "public-directory-availability.current");
    assert.equal(proposed?.id, "public-directory-availability.proposed");
    assert.equal(proposed?.role, "proposed");
    assert.equal(item.spec.producerPolicy?.decisionMode, "current-proposed");
  });

  it("passes unmodified through the workbench session and result derivation", () => {
    const item = currentProposedReviewItem({
      name: "public-directory-availability",
      target: "availabilityStatus",
      producerPolicy: { decisionMode: "current-proposed" },
      current: candidate({ value: "AVAILABLE" }),
      proposed: candidate({ value: "WAITLIST" }),
    });

    const session = {
      ...initialReviewQueueSessionState([item]),
      decisionsByItemName: { [item.metadata.name]: "accept-proposed" as const },
    };
    const results = buildReviewWorkbenchResultsFromSession(session);

    assert.equal(results.length, 1);
    assert.equal(results[0]?.reviewItemName, "public-directory-availability");
    assert.equal(results[0]?.selectedCandidateRole, "proposed");
    assert.equal(results[0]?.selectedCandidateId, "public-directory-availability.proposed");
    assert.equal(results[0]?.selectedValue, "WAITLIST");
  });

  it("reproduces a conflict item with the current candidate pre-selected", () => {
    const item = currentProposedReviewItem({
      name: "regulated-rule-conflict",
      target: "ruleConflict",
      candidateSetStatus: "conflict",
      selectedCandidateRole: "current",
      producerPolicy: { decisionMode: "keep-current", sourceAuthorityProjection: "retain-current-only" },
      current: candidate({ value: "RULE_A" }),
      proposed: candidate({ value: "RULE_B" }),
    });

    assert.equal(item.spec.candidateSetStatus, "conflict");
    assert.equal(item.spec.selectedCandidateId, "regulated-rule-conflict.current");
    assert.equal(item.status?.selectedCandidateId, "regulated-rule-conflict.current");
    assert.equal(item.spec.producerPolicy?.decisionMode, "keep-current");
  });
});
