import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { downstreamPublicDirectoryProposalExample } from "../example-data/downstream-public-directory-proposal.js";
import { downstreamPublicDirectoryProposalToReviewItem } from "../examples/review-workbench/downstream-public-directory-adapter.js";
import {
  buildReviewDecision,
  buildSurfaceProjectionPreview,
  initialReviewWorkbenchState,
  renderReviewWorkbenchHtml,
} from "../src/review-workbench/review-workbench.js";
import { reviewResourceApiVersion, type ReviewCandidate } from "../src/review-resource.js";

describe("downstream public-directory adapter example", () => {
  it("maps a sanitized downstream proposal to a valid ReviewItem", () => {
    const item = downstreamPublicDirectoryProposalToReviewItem(downstreamPublicDirectoryProposalExample);
    const current = candidateByRole(item.spec.candidates, "current");
    const proposed = candidateByRole(item.spec.candidates, "proposed");

    assert.equal(item.apiVersion, reviewResourceApiVersion);
    assert.equal(item.kind, "ReviewItem");
    assert.equal(item.metadata.name, "public-directory-record-123-registrationStatus-proposal-public-456");
    assert.equal(item.spec.target, "registrationStatus");
    assert.equal(item.spec.candidateSetStatus, "resolved");
    assert.equal(item.spec.selectedCandidateId, current.id);
    assert.equal(item.status?.selectedCandidateId, current.id);
    assert.equal(item.spec.producerPolicy?.rejectionSemantics, "selected-current-keeps-existing-value-and-rejects-proposed-candidate");

    assert.equal(current.value, "OPEN");
    assert.equal(current.confidence, 1);
    assert.equal(current.source.sourceRef, "https://example.test/listings/example-program");
    assert.equal(current.locator?.excerpt, "Registration is open for the example program.");
    assert.equal(current.extraction.extractor, "downstream-current-record");
    assert.equal(current.projection?.reviewOutcomeId, "public-directory:review:record-123:registrationStatus:proposal-public-456:keep-current");
    assert.equal(current.producer?.selectedWhenRejected, true);

    assert.equal(proposed.value, "WAITLIST");
    assert.equal(proposed.confidence, 0.82);
    assert.equal(proposed.source.sourceRef, "https://example.test/listings/example-program");
    assert.equal(proposed.locator?.excerpt, "Join the waitlist for this listing.");
    assert.equal(proposed.extraction.extractor, "example-directory-extractor-2026-05");
    assert.equal(proposed.producer?.previousValue, "OPEN");
    assert.ok(item.spec.candidates.every(hasRequiredCandidateEvidence));
  });

  it("omits rejected-proposal metadata for the current candidate on approved proposals", () => {
    const item = downstreamPublicDirectoryProposalToReviewItem({
      ...downstreamPublicDirectoryProposalExample,
      id: "proposal-public-approved",
      status: "APPROVED",
      reviewerNotes: "Accepted proposed registration status.",
      appliedFields: ["registrationStatus"],
    });
    const current = candidateByRole(item.spec.candidates, "current");
    const proposed = candidateByRole(item.spec.candidates, "proposed");

    assert.equal(item.spec.selectedCandidateId, proposed.id);
    assert.equal(item.spec.producerPolicy?.rejectionSemantics, undefined);
    assert.equal(current.projection?.reviewOutcomeId, undefined);
    assert.equal("selectedWhenRejected" in requiredProducer(current), false);
    assert.equal("selectedWhenRejected" in requiredProducer(proposed), false);
  });

  it("keeps pending proposals neutral without selected-current rejection semantics", () => {
    const item = downstreamPublicDirectoryProposalToReviewItem({
      ...downstreamPublicDirectoryProposalExample,
      id: "proposal-public-pending",
      status: "PENDING",
      reviewedAt: null,
      reviewedBy: null,
      reviewerNotes: null,
      appliedFields: [],
      feedbackTags: null,
    });
    const current = candidateByRole(item.spec.candidates, "current");
    const proposed = candidateByRole(item.spec.candidates, "proposed");

    assert.equal(item.spec.candidateSetStatus, "needs-review");
    assert.equal("selectedCandidateId" in item.spec, false);
    assert.equal(item.status ? "selectedCandidateId" in item.status : false, false);
    assert.equal(item.spec.producerPolicy?.rejectionSemantics, undefined);
    assert.equal(item.spec.projection, undefined);
    assert.equal(current.projection?.reviewOutcomeId, undefined);
    assert.equal("selectedWhenRejected" in requiredProducer(current), false);
    assert.equal("selectedWhenRejected" in requiredProducer(proposed), false);
  });

  it("maps skipped proposals as neutral needs-review items without rejection policy", () => {
    const item = downstreamPublicDirectoryProposalToReviewItem({
      ...downstreamPublicDirectoryProposalExample,
      id: "proposal-public-skipped",
      status: "SKIPPED",
      reviewedAt: "2026-06-01T17:20:00.000Z",
      reviewedBy: "review-operator-7",
      reviewerNotes: "Skipped because the source did not provide enough evidence to choose a candidate.",
      appliedFields: [],
      feedbackTags: ["insufficient-source-evidence"],
    });
    const current = candidateByRole(item.spec.candidates, "current");
    const proposed = candidateByRole(item.spec.candidates, "proposed");

    assert.equal(item.spec.candidateSetStatus, "needs-review");
    assert.equal("selectedCandidateId" in item.spec, false);
    assert.equal(item.status ? "selectedCandidateId" in item.status : false, false);
    assert.equal(item.spec.producerPolicy?.rejectionSemantics, undefined);
    assert.equal(item.spec.projection, undefined);
    assert.equal(current.projection?.reviewOutcomeId, undefined);
    assert.equal("selectedWhenRejected" in requiredProducer(current), false);
    assert.equal("selectedWhenRejected" in requiredProducer(proposed), false);
  });

  it("can render through the existing workbench without product branches", () => {
    const item = downstreamPublicDirectoryProposalToReviewItem(downstreamPublicDirectoryProposalExample);
    const html = renderReviewWorkbenchHtml({
      ...initialReviewWorkbenchState(),
      item,
      decision: "reject-proposed",
      note: "Rejected proposed value; current value remains selected.",
    });

    assert.match(html, /Current/);
    assert.match(html, /Proposed/);
    assert.match(html, /OPEN/);
    assert.match(html, /WAITLIST/);
    assert.match(html, /Reject proposed/);
    assert.match(html, /Proposed value is rejected and the current value remains unmodified\./);
    assert.equal(html.toLowerCase().includes(["c", "a", "m", "p", "f", "i", "t"].join("")), false);
    assert.equal(html.toLowerCase().includes(["t", "a", "x", "e", "s"].join("")), false);
  });

  it("builds workbench ReviewDecision payloads for accept proposed, keep current, and reject proposed", () => {
    const item = downstreamPublicDirectoryProposalToReviewItem(downstreamPublicDirectoryProposalExample);
    const current = candidateByRole(item.spec.candidates, "current");
    const proposed = candidateByRole(item.spec.candidates, "proposed");

    const accepted = buildReviewDecision({
      ...initialReviewWorkbenchState(),
      item,
      decision: "accept-proposed",
    });
    const kept = buildReviewDecision({
      ...initialReviewWorkbenchState(),
      item,
      decision: "keep-current",
    });
    const rejected = buildReviewDecision({
      ...initialReviewWorkbenchState(),
      item,
      decision: "reject-proposed",
    });

    assert.equal(accepted?.spec.candidateId, proposed.id);
    assert.equal(accepted?.spec.status, "verified");
    assert.equal(kept?.spec.candidateId, current.id);
    assert.equal(kept?.spec.status, "verified");
    assert.equal(rejected?.spec.candidateId, proposed.id);
    assert.equal(rejected?.spec.status, "rejected");

    const keptPreview = buildSurfaceProjectionPreview(item, kept);
    const rejectedPreview = buildSurfaceProjectionPreview(item, rejected);

    assert.equal(keptPreview?.canonicalClaim.candidateId, current.id);
    assert.equal(keptPreview?.canonicalClaim.value, "OPEN");
    assert.equal(item.spec.selectedCandidateId, current.id);
    assert.equal(rejectedPreview?.canonicalClaim.candidateId, proposed.id);
    assert.equal(rejectedPreview?.canonicalClaim.value, "WAITLIST");
    assert.equal(rejectedPreview?.reviewEvent?.status, "rejected");
  });
});

function candidateByRole(candidates: ReviewCandidate[], role: "current" | "proposed"): ReviewCandidate {
  const candidate = candidates.find((entry) => entry.role === role);
  assert.ok(candidate, `Missing ${role} candidate`);
  return candidate;
}

function requiredProducer(candidate: ReviewCandidate): Record<string, unknown> {
  assert.ok(candidate.producer, `Missing producer metadata for ${candidate.id}`);
  return candidate.producer;
}

function hasRequiredCandidateEvidence(candidate: ReviewCandidate): boolean {
  return Boolean(
    candidate.source.sourceRef
      && candidate.locator?.scheme
      && candidate.locator.excerpt
      && candidate.extraction.target
      && typeof candidate.extraction.confidence === "number"
      && candidate.claimTarget.subjectType
      && candidate.claimTarget.subjectId
      && candidate.claimTarget.fieldOrBehavior
      && candidate.projection?.rawSourceId
      && candidate.projection.extractionId
      && candidate.projection.candidateSetId
      && candidate.projection.candidateId
      && candidate.projection.claimId,
  );
}
