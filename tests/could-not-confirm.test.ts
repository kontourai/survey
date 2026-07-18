import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicFieldReviewExample } from "../example-data/public-field-review.js";
import {
  buildSurveyLearningProjections,
  buildSurveyTrustBundle,
  deriveCalibration,
  type SurveyInput,
} from "../src/index.js";

function couldNotConfirmInput(status: "proposed" | "assumed" | "verified" | "rejected" = "proposed"): SurveyInput {
  const input = structuredClone(publicFieldReviewExample);
  input.reviewOutcomes = [{
    ...input.reviewOutcomes[0]!,
    status,
    resolution: "could_not_confirm",
    resolutionReason: "The authoritative registry was unavailable after two attempts.",
    attemptEvidenceIds: ["attempt.registry.second", "attempt.registry.first"],
  }];
  return input;
}

describe("could-not-confirm review outcomes", () => {
  it("projects exactly like an unreviewed proposed claim, including with review proofs enabled", () => {
    const unconfirmed = couldNotConfirmInput();
    const unreviewed = structuredClone(unconfirmed);
    unreviewed.reviewOutcomes = [];

    const projected = buildSurveyTrustBundle(unconfirmed);
    const baseline = buildSurveyTrustBundle(unreviewed);

    assert.deepEqual(projected, baseline);
    assert.equal(projected.claims[0]?.status, "proposed");
    assert.equal(projected.claims[0]?.updatedAt, unconfirmed.generatedAt);
    assert.equal(projected.claims[0]?.metadata?.survey && (projected.claims[0].metadata.survey as Record<string, unknown>).reviewOutcomeId, undefined);
    assert.equal(projected.events[0]?.actor, unconfirmed.claims[0]?.collectedBy);
    assert.equal(projected.events[0]?.verifiedAt, undefined);

    const withProof = buildSurveyTrustBundle(unconfirmed, { reviewProofs: true });
    const unreviewedWithProof = buildSurveyTrustBundle(unreviewed, { reviewProofs: true });
    assert.deepEqual(withProof, unreviewedWithProof);
    assert.equal(withProof.claims[0]?.currentIntegrityAnchor, undefined);
    assert.equal(
      withProof.claims.some((claim) => claim.currentIntegrityAnchor?.observedAt === unconfirmed.reviewOutcomes[0]?.reviewedAt),
      false,
    );
  });

  it("preserves an existing assumed status without treating the non-answer as a new verification", () => {
    const input = couldNotConfirmInput("assumed");
    input.claims[0]!.status = "assumed";

    const projected = buildSurveyTrustBundle(input);

    assert.equal(projected.claims[0]?.status, "assumed");
    assert.equal(projected.claims[0]?.updatedAt, input.generatedAt);
    assert.equal(projected.events[0]?.createdAt, input.generatedAt);
  });

  it("keeps the orthogonal comfort-zone signal intact", () => {
    const input = couldNotConfirmInput();
    input.reviewOutcomes[0]!.withinComfortZone = false;
    input.reviewOutcomes[0]!.comfortZoneNote = "A registry specialist should retry this review.";

    const projected = buildSurveyTrustBundle(input);

    assert.deepEqual(projected.claims[0]?.conclusionConfidence?.comfortZone, {
      within: false,
      reason: "A registry specialist should retry this review.",
    });
    assert.deepEqual(
      projected.claims[0]?.metadata?.survey
        && (projected.claims[0].metadata.survey as Record<string, unknown>).comfortZone,
      { withinComfortZone: false, note: "A registry specialist should retry this review." },
    );
    assert.equal(projected.events[0]?.actor, input.claims[0]?.collectedBy);
  });

  it("preserves conflict and escalated candidate-set posture as disputed", () => {
    for (const candidateSetStatus of ["conflict", "escalated"] as const) {
      const input = couldNotConfirmInput();
      input.candidateSets[0]!.status = candidateSetStatus;

      const projected = buildSurveyTrustBundle(input);

      assert.equal(projected.claims[0]?.status, "disputed", candidateSetStatus);
      assert.equal(projected.events[0]?.status, "disputed", candidateSetStatus);
    }
  });

  it("rejects missing reasons, reviewer identity/timing, and verified/rejected statuses", () => {
    const missingReason = couldNotConfirmInput();
    missingReason.reviewOutcomes[0]!.resolutionReason = "   ";
    assert.throws(() => buildSurveyTrustBundle(missingReason), /non-empty resolutionReason/);

    assert.throws(() => buildSurveyTrustBundle(couldNotConfirmInput("verified")), /cannot use status verified/);
    assert.throws(() => buildSurveyTrustBundle(couldNotConfirmInput("rejected")), /cannot use status rejected/);

    const projectedUpgrade = couldNotConfirmInput();
    projectedUpgrade.claims[0]!.status = "verified";
    assert.throws(() => buildSurveyTrustBundle(projectedUpgrade), /cannot use status verified/);

    const missingActor = couldNotConfirmInput();
    missingActor.reviewOutcomes[0]!.actor = "";
    assert.throws(() => buildSurveyTrustBundle(missingActor), /requires a review actor/);

    const missingReviewedAt = couldNotConfirmInput();
    missingReviewedAt.reviewOutcomes[0]!.reviewedAt = "";
    assert.throws(() => buildSurveyTrustBundle(missingReviewedAt), /requires reviewedAt/);
  });

  it("rejects contradictory explicit resolution and status pairs", () => {
    const cases = [
      { resolution: "accepted" as const, status: "rejected" as const },
      { resolution: "accepted" as const, status: "proposed" as const },
      { resolution: "rejected" as const, status: "verified" as const },
      { resolution: "held" as const, status: "rejected" as const },
    ];

    for (const { resolution, status } of cases) {
      const input = structuredClone(publicFieldReviewExample);
      input.reviewOutcomes[0] = { ...input.reviewOutcomes[0]!, resolution, status };
      assert.throws(
        () => buildSurveyTrustBundle(input),
        new RegExp(`resolution ${resolution} cannot use status ${status}`),
      );
    }
  });

  it("excludes non-answers from calibration and emits a distinct learning signal", () => {
    const input = couldNotConfirmInput();
    const metrics = deriveCalibration({
      reviewOutcomes: input.reviewOutcomes,
      candidateSets: input.candidateSets,
      extractions: input.extractions,
    });

    assert.equal(metrics.sampleCount, 0);
    assert.equal(metrics.skippedCount, 1);

    const learning = buildSurveyLearningProjections(input);
    const signal = learning.find((projection) => projection.kind === "learning.could-not-confirm");
    assert.equal(signal?.signal, "could-not-confirm.reason");
    assert.equal(signal?.summary, "Could not confirm: The authoritative registry was unavailable after two attempts.");
    assert.deepEqual(signal?.metadata?.couldNotConfirm, {
      reason: "The authoritative registry was unavailable after two attempts.",
      attemptEvidenceIds: ["attempt.registry.second", "attempt.registry.first"],
    });
  });

  it("uses a safe learning fallback when an unvalidated input omits the reason", () => {
    const input = couldNotConfirmInput();
    input.reviewOutcomes[0]!.resolutionReason = undefined;

    const signal = buildSurveyLearningProjections(input)
      .find((projection) => projection.kind === "learning.could-not-confirm");

    assert.equal(signal?.summary, "Could not confirm: (no reason recorded)");
    assert.deepEqual(signal?.metadata?.couldNotConfirm, {
      reason: "(no reason recorded)",
      attemptEvidenceIds: ["attempt.registry.second", "attempt.registry.first"],
    });
  });
});
