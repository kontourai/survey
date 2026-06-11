import assert from "node:assert/strict";
import { test } from "node:test";
import { flowTrustArtifactFromReviewOutcome } from "../src/index.js";

test("projects a verified review outcome into a Flow-consumable trust artifact", () => {
  const artifact = flowTrustArtifactFromReviewOutcome(
    {
      id: "review.round-2",
      candidateSetId: "candidate-set.pricing-faq",
      status: "verified",
      actor: "adversary-v2",
      reviewedAt: "2026-06-10T00:25:00.000Z",
    },
    {
      claimType: "adversarial.review",
      subject: "adversarial-pass.review",
      producer: "survey/adversarial-workbench",
    },
  );

  assert.equal(artifact.schema_version, "0.1");
  assert.equal(artifact.artifact_type, "trust-report");
  assert.equal(artifact.subject, "adversarial-pass.review");
  assert.equal(artifact.producer, "survey/adversarial-workbench");
  assert.equal(artifact.status, "trusted");
  assert.equal(artifact.issued_at, "2026-06-10T00:25:00.000Z");
  assert.deepEqual(artifact.authority_traces, ["survey:review-outcome/review.round-2"]);
  assert.deepEqual(artifact.claims, [
    { type: "adversarial.review", subject: "adversarial-pass.review", status: "trusted" },
  ]);
});

test("rejected reviews project to rejected claims and the status map is overridable", () => {
  const rejected = flowTrustArtifactFromReviewOutcome(
    { id: "review.round-1", candidateSetId: "cs", status: "rejected" },
    { claimType: "adversarial.review", subject: "adversarial-pass.review", producer: "survey/x" },
  );
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.claims[0].status, "rejected");
  assert.ok(rejected.issued_at);

  const mapped = flowTrustArtifactFromReviewOutcome(
    { id: "review.r", candidateSetId: "cs", status: "assumed" },
    { claimType: "t", subject: "s", producer: "p", statusMap: { assumed: "reviewed" } },
  );
  assert.equal(mapped.status, "reviewed");
});

test("requires an outcome id and a mapped status", () => {
  assert.throws(
    () => flowTrustArtifactFromReviewOutcome(
      { id: "", candidateSetId: "cs", status: "verified" },
      { claimType: "t", subject: "s", producer: "p" },
    ),
    /requires a review outcome id/,
  );
});
