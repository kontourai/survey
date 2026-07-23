import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCanonicalReviewedTrustInput,
  buildSurveyTrustBundle,
  currentProposedReviewItem,
} from "../src/index.js";
import {
  buildReviewWorkbenchResultsFromSession,
  initialReviewQueueSessionState,
} from "../src/review-workbench/review-workbench.js";
import type { ReviewWorkbenchDecision } from "../src/review-workbench/review-queue-session.js";

function reviewed(decision: ReviewWorkbenchDecision, editedValue?: unknown) {
  const item = currentProposedReviewItem({
    name: "availability-review",
    target: "availabilityStatus",
    projection: { candidateSetId: "availability.candidates", claimId: "availability.claim" },
    current: {
      value: "AVAILABLE",
      confidence: 0.94,
      sourceRank: 1,
      source: {
        sourceId: "directory-current",
        sourceRef: "https://example.test/current",
        kind: "web-page",
        observedAt: "2026-07-20T00:00:00.000Z",
        checksum: "sha256:current",
        locatorScheme: "html",
      },
      locator: { scheme: "html", locator: "#availability", excerpt: "Available" },
      extraction: {
        extractionId: "availability.current.extraction",
        target: "availabilityStatus",
        confidence: 0.94,
        extractor: "directory-parser",
        model: "parser-v2",
        extractedAt: "2026-07-20T00:01:00.000Z",
      },
      claimTarget: {
        subjectType: "directory.entity",
        subjectId: "entity-123",
        facet: "directory.profile",
        claimType: "directory.field",
        fieldOrBehavior: "availabilityStatus",
        impactLevel: "medium",
        evidenceType: "source_excerpt",
        evidenceMethod: "extraction",
        collectedBy: "directory-producer",
      },
      projection: { rawSourceId: "directory-current", extractionId: "availability.current.extraction" },
    },
    proposed: {
      value: "WAITLIST",
      confidence: 0.82,
      sourceRank: 2,
      rejectionReason: "Retained when the proposal is rejected.",
      source: {
        sourceId: "directory-proposed",
        sourceRef: "https://example.test/proposed",
        kind: "web-page",
        observedAt: "2026-07-21T00:00:00.000Z",
        checksum: "sha256:proposed",
        locatorScheme: "html",
      },
      locator: { scheme: "html", locator: "#availability", excerpt: "Waitlist" },
      extraction: {
        extractionId: "availability.proposed.extraction",
        target: "availabilityStatus",
        confidence: 0.82,
        extractor: "directory-parser",
        model: "parser-v3",
        extractedAt: "2026-07-21T00:01:00.000Z",
      },
      claimTarget: {
        claimId: "availability.claim",
        subjectType: "directory.entity",
        subjectId: "entity-123",
        facet: "directory.profile",
        claimType: "directory.field",
        fieldOrBehavior: "availabilityStatus",
        impactLevel: "medium",
        evidenceType: "source_excerpt",
        evidenceMethod: "extraction",
        collectedBy: "directory-producer",
      },
      projection: {
        rawSourceId: "directory-proposed",
        extractionId: "availability.proposed.extraction",
        reviewOutcomeId: "availability.review",
        claimId: "availability.claim",
      },
    },
  });
  const session = {
    ...initialReviewQueueSessionState([item]),
    actorId: "reviewer-7",
    reviewedAt: "2026-07-22T12:00:00.000Z",
    decisionsByItemName: { [item.metadata.name]: decision },
    notesByItemName: { [item.metadata.name]: decision === "could-not-confirm" ? "The cited page was unavailable." : "Checked the cited field." },
    attemptEvidenceIdsByItemName: decision === "could-not-confirm"
      ? { [item.metadata.name]: ["attempt.fetch"] }
      : {},
    editedValuesByItemName: editedValue === undefined ? {} : { [item.metadata.name]: editedValue },
  };
  return { item, result: buildReviewWorkbenchResultsFromSession(session)[0]! };
}

describe("buildCanonicalReviewedTrustInput", () => {
  for (const [decision, status, value] of [
    ["accept-proposed", "verified", "WAITLIST"],
    ["keep-current", "verified", "AVAILABLE"],
    ["reject-proposed", "rejected", "WAITLIST"],
    ["could-not-confirm", "proposed", "WAITLIST"],
  ] as const) {
    it(`canonically projects ${decision}`, () => {
      const { item, result } = reviewed(decision);
      const projected = buildCanonicalReviewedTrustInput({
        source: "directory-review/session-42",
        generatedAt: "2026-07-22T12:00:01.000Z",
        projectionContextId: "session-42",
        items: [item],
        results: [result],
      });

      assert.equal(projected.projectionContextId, "session-42");
      assert.equal(projected.surveyInput.claims[0]?.status, status);
      assert.equal(projected.surveyInput.claims[0]?.value, value);
      assert.equal(projected.surveyInput.reviewOutcomes[0]?.status, status);
      assert.equal(projected.surveyInput.reviewOutcomes[0]?.actor, "reviewer-7");
      assert.equal(projected.surveyInput.reviewOutcomes[0]?.reviewedAt, "2026-07-22T12:00:00.000Z");
      assert.equal(projected.surveyInput.candidateSets[0]?.selectedCandidateId, result.selectedCandidateId);
      assert.equal(projected.surveyInput.extractions.length, 2);
      assert.equal(projected.surveyInput.rawSources.length, 2);

      const bundle = buildSurveyTrustBundle(projected.surveyInput, {
        projectionContextId: projected.projectionContextId,
      });
      assert.equal(bundle.claims[0]?.status, status);
      assert.equal(bundle.claims[0]?.value, value);
    });
  }

  it("uses the edited effective value without erasing original extraction provenance", () => {
    const { item, result } = reviewed("accept-proposed", "WAITLISTED");
    const projected = buildCanonicalReviewedTrustInput({
      source: "directory-review/session-43",
      generatedAt: "2026-07-22T12:00:01.000Z",
      projectionContextId: "session-43",
      items: [item],
      results: [result],
    });

    assert.equal(projected.surveyInput.claims[0]?.value, "WAITLISTED");
    assert.equal(projected.surveyInput.candidateSets[0]?.candidates[1]?.value, "WAITLIST");
    assert.equal(projected.surveyInput.extractions[1]?.value, "WAITLIST");
    assert.equal(projected.surveyInput.reviewOutcomes[0]?.metadata?.editedValue, "WAITLISTED");
  });

  it("fails closed when a result no longer matches its canonical ReviewItem", () => {
    const { item, result } = reviewed("accept-proposed");
    assert.throws(() => buildCanonicalReviewedTrustInput({
      source: "directory-review/session-44",
      generatedAt: "2026-07-22T12:00:01.000Z",
      projectionContextId: "session-44",
      items: [item],
      results: [{
        ...result,
        selectedCandidate: {
          ...result.selectedCandidate,
          extraction: { ...result.selectedCandidate.extraction, target: "differentTarget" },
        },
      }],
    }), /selected candidate does not match/i);
  });

  it("fails closed on duplicate projection ids with divergent provenance", () => {
    const first = reviewed("accept-proposed");
    const second = reviewed("keep-current");
    second.item.spec.candidates[0]!.source.sourceRef = "https://example.test/tampered";
    assert.throws(() => buildCanonicalReviewedTrustInput({
      source: "directory-review/session-45",
      generatedAt: "2026-07-22T12:00:01.000Z",
      projectionContextId: "session-45",
      items: [first.item, { ...second.item, metadata: { ...second.item.metadata, name: "second-review" } }],
      results: [first.result, {
        ...second.result,
        reviewItemName: "second-review",
        reviewDecision: {
          ...second.result.reviewDecision,
          spec: { ...second.result.reviewDecision.spec, reviewItemName: "second-review" },
        },
      }],
    }), /conflicting raw source.*directory-current/i);
  });
});
