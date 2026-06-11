import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTrustReport, validateTrustBundle } from "@kontourai/surface";
import { correctedDocumentCandidatesFixture } from "../fixtures/corrected-document-candidates.js";
import {
  publicDirectoryReviewDecisionFixture,
  publicDirectoryReviewItemFixture,
} from "../fixtures/public-directory-review-resource.js";
import { publicFieldReviewFixture } from "../fixtures/public-field-review.js";
import { regulatedDocumentReviewItemFixture } from "../fixtures/regulated-document-review-resource.js";
import {
  buildSurveyTrustBundle,
  type CandidateSet,
  type ClaimTarget,
  type Extraction,
  type RawSource,
  reviewResourceApiVersion,
  type ReviewCandidate,
  type ReviewDecision,
  type ReviewItem,
  type ReviewOutcome,
  type ReviewSession,
  type ReviewSessionEvent,
  type SurveyInput,
} from "../src/index.js";

describe("Review resource contract", () => {
  it("exports serializable ReviewItem and ReviewDecision resources", () => {
    const item: ReviewItem = JSON.parse(JSON.stringify(publicDirectoryReviewItemFixture));
    const decision: ReviewDecision = JSON.parse(JSON.stringify(publicDirectoryReviewDecisionFixture));

    assert.equal(item.apiVersion, reviewResourceApiVersion);
    assert.equal(item.kind, "ReviewItem");
    assert.equal(decision.kind, "ReviewDecision");
    assert.equal(decision.spec.reviewItemName, item.metadata.name);
    assert.ok(item.spec.candidates.every(hasRequiredCandidateEvidence));
  });

  it("exports serializable ReviewSession and ReviewSessionEvent resources", () => {
    const session: ReviewSession = {
      apiVersion: reviewResourceApiVersion,
      kind: "ReviewSession",
      metadata: {
        name: "example-review-session",
      },
      spec: {
        reviewItemNames: [publicDirectoryReviewItemFixture.metadata.name],
        actor: {
          id: "reviewer-1",
        },
        startedAt: "2026-06-04T00:00:00.000Z",
      },
      status: {
        activeItemName: publicDirectoryReviewItemFixture.metadata.name,
        eventCount: 1,
        decisionCount: 0,
      },
    };
    const event: ReviewSessionEvent = {
      apiVersion: reviewResourceApiVersion,
      kind: "ReviewSessionEvent",
      metadata: {
        name: "example-review-session-0001-session-started",
      },
      spec: {
        sessionName: session.metadata.name,
        sequence: 1,
        eventType: "session-started",
        occurredAt: "2026-06-04T00:00:00.000Z",
        actor: {
          id: "reviewer-1",
        },
      },
      status: {
        replayed: true,
      },
    };

    assert.equal(session.apiVersion, reviewResourceApiVersion);
    assert.equal(session.kind, "ReviewSession");
    assert.equal(event.kind, "ReviewSessionEvent");
    assert.equal(event.spec.sessionName, session.metadata.name);
  });

  it("validates a public-directory current/proposed review resource against existing records", () => {
    const item = publicDirectoryReviewItemFixture;
    const roles = new Set(item.spec.candidates.map((candidate) => candidate.role));
    const current = item.spec.candidates.find((candidate) => candidate.role === "current");
    const proposed = item.spec.candidates.find((candidate) => candidate.role === "proposed");

    assert.deepEqual(roles, new Set(["current", "proposed"]));
    assert.ok(current);
    assert.ok(proposed);

    assertReviewCandidateMapsToSurveyRecord(current, publicFieldReviewFixture);
    assertReviewCandidateMapsToSurveyRecord(proposed, publicFieldReviewFixture);
    assertReviewDecisionMapsToSurveyRecord(publicDirectoryReviewDecisionFixture, publicFieldReviewFixture);

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(publicFieldReviewFixture)));
    assert.equal(report.summary.byStatus.verified, 1);
    assert.equal(report.summary.byStatus.proposed, 1);
  });

  it("validates a regulated-document multi-candidate resource without current/proposed roles", () => {
    const item = regulatedDocumentReviewItemFixture;
    const roles: Array<string | undefined> = item.spec.candidates.map((candidate) => candidate.role);

    assert.equal(item.spec.candidates.length, 2);
    assert.deepEqual(roles, ["source-version", "computed"]);
    assert.equal(roles.includes("current"), false);
    assert.equal(roles.includes("proposed"), false);
    assert.ok(item.spec.candidates.every((candidate) => candidate.claimTarget.derivedFrom?.length === 2));

    item.spec.candidates.forEach((candidate) => {
      assertReviewCandidateMapsToSurveyRecord(candidate, correctedDocumentCandidatesFixture);
    });

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(correctedDocumentCandidatesFixture)));
    assert.ok(report.claims.some((claim) => claim.id === item.spec.candidates[0]?.projection?.claimId));
    assert.ok(report.claims.some((claim) => claim.id === item.spec.candidates[1]?.projection?.claimId));
  });
});

function hasRequiredCandidateEvidence(candidate: ReviewCandidate): boolean {
  return Boolean(
    candidate.source.sourceRef
      && candidate.locator?.scheme
      && candidate.locator.excerpt
      && candidate.extraction.target
      && typeof candidate.extraction.confidence === "number"
      && candidate.claimTarget.subjectType
      && candidate.claimTarget.subjectId
      && candidate.claimTarget.fieldOrBehavior,
  );
}

function assertReviewCandidateMapsToSurveyRecord(candidate: ReviewCandidate, surveyInput: SurveyInput): void {
  const projection = candidate.projection;
  assert.ok(projection?.rawSourceId);
  assert.ok(projection.extractionId);
  assert.ok(projection.candidateSetId);
  assert.ok(projection.candidateId);
  assert.ok(projection.claimId);

  const rawSource = findById<RawSource>(surveyInput.rawSources, projection.rawSourceId, "raw source");
  assert.equal(candidate.source.sourceId, rawSource.id);
  assert.equal(candidate.source.sourceRef, rawSource.sourceRef);
  assert.equal(candidate.source.kind, rawSource.kind);
  assert.equal(candidate.source.observedAt, rawSource.observedAt);
  assert.equal(candidate.source.fetchedAt, rawSource.fetchedAt);
  assert.equal(candidate.source.locatorScheme, rawSource.locatorScheme);

  const extraction = findById<Extraction>(surveyInput.extractions, projection.extractionId, "extraction");
  assert.equal(extraction.sourceId, rawSource.id);
  assert.equal(candidate.extraction.extractionId, extraction.id);
  assert.equal(candidate.extraction.target, extraction.target);
  assert.equal(candidate.extraction.confidence, extraction.confidence);
  assert.equal(candidate.extraction.extractor, extraction.extractor);
  assert.equal(candidate.extraction.extractedAt, extraction.extractedAt);
  assert.equal(candidate.locator?.locator, extraction.locator);
  assert.equal(candidate.locator?.excerpt, extraction.excerpt);
  assert.deepEqual(candidate.value, extraction.value);
  assert.equal(candidate.confidence, extraction.confidence);

  const candidateSet = findById<CandidateSet>(surveyInput.candidateSets, projection.candidateSetId, "candidate set");
  const surveyCandidate = findById(candidateSet.candidates, projection.candidateId, "candidate");
  assert.equal(candidateSet.target, candidate.extraction.target);
  assert.equal(surveyCandidate.extractionId, extraction.id);
  assert.deepEqual(surveyCandidate.value, candidate.value);
  assert.equal(surveyCandidate.confidence, candidate.confidence);
  assert.equal(surveyCandidate.rejectionReason, candidate.rejectionReason);

  const claim = findById<ClaimTarget>(surveyInput.claims, projection.claimId, "claim");
  assert.equal(candidate.claimTarget.claimId, claim.id);
  assert.equal(claim.candidateSetId, candidateSet.id);
  assert.equal(claim.candidateId, surveyCandidate.id);
  assert.equal(candidate.claimTarget.subjectType, claim.subjectType);
  assert.equal(candidate.claimTarget.subjectId, claim.subjectId);
  assert.equal(candidate.claimTarget.surface, claim.surface);
  assert.equal(candidate.claimTarget.claimType, claim.claimType);
  assert.equal(candidate.claimTarget.fieldOrBehavior, claim.fieldOrBehavior);
  assert.equal(candidate.claimTarget.impactLevel, claim.impactLevel);
  assert.equal(candidate.claimTarget.evidenceType, claim.evidenceType);
  assert.equal(candidate.claimTarget.evidenceMethod, claim.evidenceMethod);
  assert.equal(candidate.claimTarget.collectedBy, claim.collectedBy);
  assert.deepEqual(candidate.claimTarget.derivedFrom, claim.derivedFrom);

  const reviewOutcome = surveyInput.reviewOutcomes.find(
    (outcome) => outcome.candidateSetId === candidateSet.id && outcome.candidateId === surveyCandidate.id,
  );
  if (projection.reviewOutcomeId) {
    assert.equal(projection.reviewOutcomeId, reviewOutcome?.id);
  } else {
    assert.equal(reviewOutcome, undefined);
  }
}

function assertReviewDecisionMapsToSurveyRecord(decision: ReviewDecision, surveyInput: SurveyInput): void {
  const projection = decision.spec.projection;
  assert.ok(projection?.reviewOutcomeId);
  assert.ok(projection.candidateSetId);
  assert.ok(projection.candidateId);
  assert.ok(projection.claimId);

  const outcome = findById<ReviewOutcome>(surveyInput.reviewOutcomes, projection.reviewOutcomeId, "review outcome");
  assert.equal(decision.spec.status, outcome.status);
  assert.equal(decision.spec.actor?.id, outcome.actor);
  assert.equal(decision.spec.reviewedAt, outcome.reviewedAt);
  assert.equal(decision.spec.rationale, outcome.rationale);
  assert.equal(projection.candidateSetId, outcome.candidateSetId);
  assert.equal(projection.candidateId, outcome.candidateId);

  const claim = findById<ClaimTarget>(surveyInput.claims, projection.claimId, "claim");
  assert.equal(claim.candidateSetId, outcome.candidateSetId);
  assert.equal(claim.candidateId, outcome.candidateId);
  assert.deepEqual(decision.status?.appliedToClaimIds, [claim.id]);
}

function findById<T extends { id: string }>(records: T[], id: string, label: string): T {
  const record = records.find((candidate) => candidate.id === id);
  assert.ok(record, `Missing ${label}: ${id}`);
  return record;
}
