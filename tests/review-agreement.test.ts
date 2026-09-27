/**
 * #290: a `verified`/`assumed` claim must agree with the review it cites.
 *
 * Covers, on the direct `buildSurveyTrustBundle` path:
 * - status: an explicit claim status may not contradict the selected review;
 * - value: a trusted claim may not carry a value nobody reviewed (the
 *   candidate value, or the edit the review records as `metadata.editedValue`);
 * - ordering: when several reviews apply to one candidate, the latest by
 *   `reviewedAt` governs, and an order that cannot be established is refused;
 * and, on the public `reviewedCandidateResolution` /
 * `reviewedCurrentProposedResolution` helpers, that the selected claim status
 * cannot contradict the review outcome.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSurveyTrustBundle,
  fieldObservation,
  manualEntrySource,
  ReviewAgreementError,
  reviewedCandidateResolution,
  reviewedCurrentProposedResolution,
} from "../src/index.js";
import type { ClaimTarget, ReviewOutcome, SurveyInput } from "../src/index.js";

function input(options: { reviews: ReviewOutcome[]; claim?: Partial<ClaimTarget> }): SurveyInput {
  return {
    source: "survey.review-agreement.fixture",
    generatedAt: "2026-09-26T00:00:00.000Z",
    rawSources: [{
      id: "source.1",
      kind: "uploaded-document",
      sourceRef: "documents://entity-1/report.pdf",
      observedAt: "2026-09-20T00:00:00.000Z",
      locatorScheme: "structured-field",
    }],
    extractions: [{
      id: "extraction.1",
      sourceId: "source.1",
      target: "reportedAmount",
      value: 48000,
      confidence: 0.9,
      locator: "structured-field:amount",
      extractor: "document-parser",
      extractedAt: "2026-09-20T00:00:00.000Z",
    }],
    candidateSets: [{
      id: "set.1",
      target: "reportedAmount",
      status: "resolved",
      selectedCandidateId: "candidate.1",
      candidates: [{ id: "candidate.1", extractionId: "extraction.1", value: 48000, confidence: 0.9 }],
    }],
    reviewOutcomes: options.reviews,
    claims: [{
      id: "claim.1",
      candidateSetId: "set.1",
      candidateId: "candidate.1",
      subjectType: "record.entity",
      subjectId: "entity-1",
      facet: "record.profile",
      claimType: "record.field",
      fieldOrBehavior: "reportedAmount",
      impactLevel: "high",
      collectedBy: "document-parser",
      ...options.claim,
    }],
  };
}

function review(overrides: Partial<ReviewOutcome> & { id: string; status: ReviewOutcome["status"] }): ReviewOutcome {
  return {
    candidateSetId: "set.1",
    candidateId: "candidate.1",
    actor: "records-operator",
    reviewedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("claim status agrees with the selected review (#290)", () => {
  it("refuses a verified claim that cites a rejected review", () => {
    const bundleInput = input({
      reviews: [review({ id: "review.rejected", status: "rejected" })],
      claim: { status: "verified" },
    });
    assert.throws(() => buildSurveyTrustBundle(bundleInput), (error: unknown) => {
      assert.ok(error instanceof ReviewAgreementError);
      assert.equal(error.code, "status-mismatch");
      assert.match(error.message, /Claim claim\.1 status verified disagrees with review outcome review\.rejected status rejected/);
      return true;
    });
  });

  it("refuses an assumed claim that cites a verified review", () => {
    const bundleInput = input({
      reviews: [review({ id: "review.verified", status: "verified" })],
      claim: { status: "assumed" },
    });
    assert.throws(() => buildSurveyTrustBundle(bundleInput), { name: "ReviewAgreementError", code: "status-mismatch" });
  });

  it("keeps agreeing claims and non-trusted overrides working", () => {
    const agreeing = buildSurveyTrustBundle(input({
      reviews: [review({ id: "review.verified", status: "verified" })],
      claim: { status: "verified" },
    }));
    assert.equal(agreeing.claims[0]?.status, "verified");

    // Only trusted statuses are pinned to the review: a producer may still
    // withhold trust (e.g. project a reviewed candidate as proposed).
    const withheld = buildSurveyTrustBundle(input({
      reviews: [review({ id: "review.verified", status: "verified" })],
      claim: { status: "proposed" },
    }));
    assert.equal(withheld.claims[0]?.status, "proposed");
  });
});

describe("trusted claim value is the reviewed value (#290)", () => {
  it("refuses a verified claim whose value differs from the reviewed candidate value", () => {
    const bundleInput = input({
      reviews: [review({ id: "review.verified", status: "verified" })],
      claim: { value: 777 },
    });
    assert.throws(() => buildSurveyTrustBundle(bundleInput), (error: unknown) => {
      assert.ok(error instanceof ReviewAgreementError);
      assert.equal(error.code, "value-mismatch");
      assert.match(error.message, /Claim claim\.1 is verified but its value differs from the value reviewed in review\.verified/);
      return true;
    });
  });

  it("accepts an explicit value that equals the candidate value by canonical JSON", () => {
    const bundleInput = input({ reviews: [review({ id: "review.verified", status: "verified" })], claim: { value: 48000 } });
    bundleInput.extractions[0]!.value = { amount: 48000, currency: "USD" };
    bundleInput.candidateSets[0]!.candidates[0]!.value = { amount: 48000, currency: "USD" };
    bundleInput.claims[0]!.value = { currency: "USD", amount: 48000 };
    const bundle = buildSurveyTrustBundle(bundleInput);
    assert.deepEqual(bundle.claims[0]?.value, { currency: "USD", amount: 48000 });
  });

  it("uses an accepted edit as the reviewed value and records the edit on the claim", () => {
    const edited = review({ id: "review.edited", status: "verified", metadata: { workbenchDecision: "accept-proposed", editedValue: 52000 } });
    const bundle = buildSurveyTrustBundle(input({ reviews: [edited], claim: { value: 52000 } }));
    assert.equal(bundle.claims[0]?.value, 52000);
    assert.deepEqual((bundle.claims[0]?.metadata?.survey as { valueEdit?: unknown }).valueEdit, {
      edited: true, originalValue: 48000, reviewOutcomeId: "review.edited",
    });

    // The unedited candidate value is not what the reviewer approved.
    assert.throws(
      () => buildSurveyTrustBundle(input({ reviews: [edited] })),
      { name: "ReviewAgreementError", code: "value-mismatch" },
    );
  });

  it("ignores an editedValue that is not an accepted edit", () => {
    // A bare editedValue (no accept-proposed decision) and an edit on a reject
    // or keep decision do not replace the reviewed value.
    for (const metadata of [
      { editedValue: 777 },
      { workbenchDecision: "reject-proposed", editedValue: 777 },
      { workbenchDecision: "keep-current", editedValue: 777 },
    ]) {
      const forged = review({ id: "review.forged", status: "verified", metadata });
      assert.throws(
        () => buildSurveyTrustBundle(input({ reviews: [forged], claim: { value: 777 } })),
        { name: "ReviewAgreementError", code: "value-mismatch" },
        `metadata ${JSON.stringify(metadata)} must not launder 777`,
      );
      const bundle = buildSurveyTrustBundle(input({ reviews: [forged] }));
      assert.equal(bundle.claims[0]?.value, 48000);
      assert.equal((bundle.claims[0]?.metadata?.survey as { valueEdit?: unknown }).valueEdit, undefined);
    }
  });

  it("does not pin the value of a claim that is not trusted", () => {
    const bundle = buildSurveyTrustBundle(input({
      reviews: [review({ id: "review.rejected", status: "rejected" })],
      claim: { value: 777 },
    }));
    assert.equal(bundle.claims[0]?.status, "rejected");
    assert.equal(bundle.claims[0]?.value, 777);
  });
});

describe("the latest applicable review governs (#290)", () => {
  const earlierVerified = review({ id: "review.1", status: "verified", reviewedAt: "2026-09-21T00:00:00.000Z" });
  const laterRejected = review({ id: "review.2", status: "rejected", reviewedAt: "2026-09-25T00:00:00.000Z" });

  it("projects a later rejection over an earlier verification, whatever the array order", () => {
    for (const reviews of [[earlierVerified, laterRejected], [laterRejected, earlierVerified]]) {
      const bundle = buildSurveyTrustBundle(input({ reviews }));
      assert.equal(bundle.claims[0]?.status, "rejected");
      assert.equal(bundle.claims[0]?.metadata?.survey && (bundle.claims[0].metadata.survey as { reviewOutcomeId?: string }).reviewOutcomeId, "review.2");
    }
  });

  it("refuses a verified claim once a later review rejected it", () => {
    assert.throws(
      () => buildSurveyTrustBundle(input({ reviews: [earlierVerified, laterRejected], claim: { status: "verified" } })),
      { name: "ReviewAgreementError", code: "status-mismatch" },
    );
  });

  it("refuses conflicting reviews at the same latest instant, however it is spelled", () => {
    const sameInstantVerified = review({ id: "review.3", status: "verified", reviewedAt: "2026-09-25T02:00:00+02:00" });
    assert.throws(() => buildSurveyTrustBundle(input({ reviews: [earlierVerified, laterRejected, sameInstantVerified] })), (error: unknown) => {
      assert.ok(error instanceof ReviewAgreementError);
      assert.equal(error.code, "ambiguous-review-order");
      assert.match(error.message, /conflicting review outcomes review\.2, review\.3 at the latest reviewedAt/);
      return true;
    });
  });

  it("treats identical decisions at the same instant as one review", () => {
    const duplicate = review({ id: "review.2-copy", status: "rejected", reviewedAt: "2026-09-25T00:00:00.000Z" });
    const respelled = review({ id: "review.2-respelled", status: "rejected", reviewedAt: "2026-09-25T09:00:00+09:00" });
    for (const reviews of [[earlierVerified, laterRejected, duplicate, respelled], [respelled, duplicate, laterRejected, earlierVerified]]) {
      const bundle = buildSurveyTrustBundle(input({ reviews }));
      assert.equal(bundle.claims[0]?.status, "rejected");
      // Deterministic citation whatever the array order.
      assert.equal((bundle.claims[0]?.metadata?.survey as { reviewOutcomeId?: string }).reviewOutcomeId, "review.2");
    }
  });

  it("refuses to order several reviews when one has no parseable reviewedAt", () => {
    const untimed = review({ id: "review.untimed", status: "proposed", reviewedAt: undefined });
    assert.throws(
      () => buildSurveyTrustBundle(input({ reviews: [earlierVerified, untimed] })),
      { name: "ReviewAgreementError", code: "ambiguous-review-order" },
    );
  });

  it("still accepts a single review without reviewedAt for a non-trusted claim", () => {
    const bundle = buildSurveyTrustBundle(input({ reviews: [review({ id: "review.p", status: "proposed", reviewedAt: undefined })] }));
    assert.equal(bundle.claims[0]?.status, "proposed");
  });
});

describe("reviewed resolution helpers refuse a disagreeing selected status (#290)", () => {
  const observation = (id: string, value: number, status?: ClaimTarget["status"]) => fieldObservation({
    id: `observation.${id}`,
    field: "reportedAmount",
    value,
    rawSource: manualEntrySource({ id: `source.${id}`, sourceRef: `records://entity-1/${id}`, observedAt: "2026-09-20T00:00:00.000Z" }),
    extraction: { locator: "structured-field:amount", extractor: "current-record", extractedAt: "2026-09-20T00:00:00.000Z" },
    claim: {
      id: `claim.${id}`,
      subjectType: "record.entity",
      subjectId: "entity-1",
      facet: "record.profile",
      claimType: "record.field",
      impactLevel: "high",
      collectedBy: "current-record",
      ...(status ? { status } : {}),
    },
  });
  const rejectedOutcome = { status: "rejected" as const, actor: "records-operator", reviewedAt: "2026-09-21T00:00:00.000Z" };

  it("reviewedCurrentProposedResolution refuses selectedClaimStatus verified with a rejected review", () => {
    assert.throws(() => reviewedCurrentProposedResolution({
      id: "set.helper",
      target: "reportedAmount",
      selectedCandidateRole: "proposed",
      reviewOutcome: rejectedOutcome,
      selectedClaimStatus: "verified",
      currentObservation: observation("current", 48000),
      proposedObservation: observation("proposed", 52000),
    }), (error: unknown) => {
      assert.ok(error instanceof ReviewAgreementError);
      assert.equal(error.code, "status-mismatch");
      assert.match(error.message, /selected claim status verified disagrees with review outcome status rejected/);
      return true;
    });
  });

  it("reviewedCandidateResolution refuses a selected observation that carries a disagreeing trusted status", () => {
    assert.throws(() => reviewedCandidateResolution({
      id: "set.helper",
      target: "reportedAmount",
      selectedCandidateId: "observation.proposed.candidate",
      reviewOutcome: rejectedOutcome,
      observations: [observation("current", 48000), observation("proposed", 52000, "verified")],
    }), { name: "ReviewAgreementError", code: "status-mismatch" });
  });

  it("keeps agreeing helper inputs working", () => {
    const records = reviewedCurrentProposedResolution({
      id: "set.helper",
      target: "reportedAmount",
      selectedCandidateRole: "proposed",
      reviewOutcome: { ...rejectedOutcome, status: "verified" },
      selectedClaimStatus: "verified",
      currentObservation: observation("current", 48000),
      proposedObservation: observation("proposed", 52000),
    });
    const selected = records.find((record) => record.claim.id === "claim.proposed");
    assert.equal(selected?.claim.status, "verified");
  });
});
