import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTrustReport, validateTrustInput } from "@kontourai/surface";
import {
  buildSurveyLearningProjections,
  buildSurveyTrustInput,
  type LearningProjection,
  type LearningProjectionKind,
  type SurveyInput,
} from "../src/index.js";

describe("Survey learning projections", () => {
  it("emits a comfort-zone signal from structured review outcome data", () => {
    const input = baseSurveyInput({
      reviewOutcomes: [{
        id: "review.registration-status",
        candidateSetId: "candidate-set.registration-status",
        candidateId: "candidate.registration-status",
        status: "assumed",
        actor: "records-operator",
        reviewedAt: "2026-05-31T15:05:00.000Z",
        rationale: "Assumed from registry source.",
        withinComfortZone: false,
        comfortZoneNote: "Specialist authority should confirm this posture.",
      }],
    });

    const projections = buildSurveyLearningProjections(input);

    assert.equal(projections.length, 1);
    assertLearningKind(projections[0], "learning.comfort-zone");
    assert.equal(projections[0].source, "survey.learning.fixture");
    assert.equal(projections[0].createdAt, "2026-05-31T15:05:00.000Z");
    assert.equal(projections[0].target, "registrationStatus");
    assert.equal(projections[0].claimId, "claim.registration-status");
    assert.equal(projections[0].reviewOutcomeId, "review.registration-status");
    assert.equal(projections[0].signal, "comfort-zone.outside");
    assert.deepEqual(projections[0].metadata?.comfortZone, {
      withinComfortZone: false,
      note: "Specialist authority should confirm this posture.",
    });

    const report = buildTrustReport(validateTrustInput(buildSurveyTrustInput(input)));
    assert.equal(report.events[0]?.notes, "Assumed from registry source.");
    assert.ok(!report.events[0]?.notes?.includes("Specialist authority should confirm"));
  });

  it("does not emit comfort-zone signals when the structured flag is true or absent", () => {
    const trueInput = baseSurveyInput({
      reviewOutcomes: [{
        id: "review.true",
        candidateSetId: "candidate-set.registration-status",
        candidateId: "candidate.registration-status",
        status: "verified",
        actor: "records-operator",
        reviewedAt: "2026-05-31T15:05:00.000Z",
        rationale: "Outside comfort zone: specialist authority should review this posture.",
        withinComfortZone: true,
      }],
    });
    const absentInput = baseSurveyInput({
      reviewOutcomes: [{
        id: "review.absent",
        candidateSetId: "candidate-set.registration-status",
        candidateId: "candidate.registration-status",
        status: "verified",
        actor: "records-operator",
        reviewedAt: "2026-05-31T15:05:00.000Z",
        rationale: "Comfort-zone note: specialist authority should confirm this posture.",
      }],
    });

    assert.deepEqual(buildSurveyLearningProjections(trueInput), []);
    assert.deepEqual(buildSurveyLearningProjections(absentInput), []);
  });

  it("omits claimId when a candidate-specific review outcome does not match a claim", () => {
    const input = baseSurveyInput({
      reviewOutcomes: [{
        id: "review.unmatched-candidate",
        candidateSetId: "candidate-set.registration-status",
        candidateId: "candidate.unclaimed-registration-status",
        status: "assumed",
        actor: "records-operator",
        reviewedAt: "2026-05-31T15:05:00.000Z",
        withinComfortZone: false,
        comfortZoneNote: "Specialist authority should confirm this posture.",
      }],
    });

    const projections = buildSurveyLearningProjections(input);

    assert.equal(projections.length, 1);
    assert.equal(projections[0]?.claimId, undefined);
  });

  it("falls back to the candidate-set claim for candidate-set-level review outcomes", () => {
    const input = baseSurveyInput({
      reviewOutcomes: [{
        id: "review.candidate-set",
        candidateSetId: "candidate-set.registration-status",
        status: "assumed",
        actor: "records-operator",
        reviewedAt: "2026-05-31T15:05:00.000Z",
        withinComfortZone: false,
        comfortZoneNote: "Specialist authority should confirm this posture.",
      }],
    });

    const projections = buildSurveyLearningProjections(input);

    assert.equal(projections.length, 1);
    assert.equal(projections[0]?.claimId, "claim.registration-status");
  });

  it("emits unresolved attached and unattached escalation signals and excludes resolved records", () => {
    const input = baseSurveyInput({
      escalations: [
        {
          id: "escalation.attached",
          target: "registrationStatus",
          dimension: "completeness",
          reason: "Required source was not checked.",
          raisedBy: "adversary-v1",
          raisedAt: "2026-05-31T15:30:00.000Z",
          attachToClaimId: "claim.registration-status",
        },
        {
          id: "escalation.unattached",
          target: "renewalTerms",
          dimension: "framing",
          reason: "The target question was not framed.",
          raisedBy: "adversary-v1",
          raisedAt: "2026-05-31T15:31:00.000Z",
        },
        {
          id: "escalation.resolved",
          target: "registrationStatus",
          dimension: "citation",
          reason: "Citation did not support the claim.",
          raisedBy: "adversary-v1",
          raisedAt: "2026-05-31T15:32:00.000Z",
          attachToClaimId: "claim.registration-status",
          resolvedBy: "observation.registration-status",
        },
      ],
    });

    const projections = buildSurveyLearningProjections(input);

    assert.deepEqual(projections.map((projection) => projection.id), [
      "escalation.attached.learning.escalation",
      "escalation.unattached.learning.escalation",
    ]);
    assert.deepEqual(projections.map((projection) => projection.kind), [
      "learning.escalation",
      "learning.escalation",
    ]);
    assert.equal(projections[0]?.claimId, "claim.registration-status");
    assert.equal(projections[1]?.claimId, undefined);
    assert.deepEqual(projections[0]?.metadata?.escalation, {
      id: "escalation.attached",
      target: "registrationStatus",
      dimension: "completeness",
      reason: "Required source was not checked.",
      raisedBy: "adversary-v1",
      raisedAt: "2026-05-31T15:30:00.000Z",
      attachToClaimId: "claim.registration-status",
      resolved: false,
    });
    assert.deepEqual(projections[1]?.metadata?.escalation, {
      id: "escalation.unattached",
      target: "renewalTerms",
      dimension: "framing",
      reason: "The target question was not framed.",
      raisedBy: "adversary-v1",
      raisedAt: "2026-05-31T15:31:00.000Z",
      resolved: false,
    });
  });

  it("keeps learning projections separate from Surface TrustInput semantics", () => {
    const input = baseSurveyInput({
      escalations: [{
        id: "escalation.attached",
        target: "registrationStatus",
        dimension: "conclusion",
        reason: "The conclusion would not survive specialist challenge.",
        raisedBy: "adversary-v1",
        raisedAt: "2026-05-31T15:30:00.000Z",
        attachToClaimId: "claim.registration-status",
      }],
    });

    const before = buildSurveyTrustInput(input);
    const projections = buildSurveyLearningProjections(input);
    const after = buildSurveyTrustInput(input);
    const report = buildTrustReport(validateTrustInput(after));
    const escalationEvent = report.events.find((event) => event.method === "candidate-escalation");

    assert.deepEqual(after, before);
    assert.equal(projections.length, 1);
    assert.equal(projections[0]?.kind, "learning.escalation");
    assert.ok(escalationEvent, "existing escalation disputed event should remain");
    assert.equal(escalationEvent?.status, "disputed");
    assert.equal(escalationEvent?.claimId, "claim.registration-status");
  });
});

function assertLearningKind(projection: LearningProjection | undefined, kind: LearningProjectionKind): asserts projection is LearningProjection {
  assert.ok(projection, "learning projection should exist");
  assert.equal(projection.kind, kind);
}

function baseSurveyInput(overrides: Partial<SurveyInput> = {}): SurveyInput {
  return {
    source: "survey.learning.fixture",
    generatedAt: "2026-05-31T16:00:00.000Z",
    rawSources: [{
      id: "source.registry",
      kind: "api-record",
      sourceRef: "records://entity-1/registry",
      observedAt: "2026-05-31T15:00:00.000Z",
      locatorScheme: "structured-field",
    }],
    extractions: [{
      id: "extraction.registration-status",
      sourceId: "source.registry",
      target: "registrationStatus",
      value: "ACTIVE",
      confidence: 0.9,
      locator: "json:$.registrationStatus",
      extractor: "records-importer",
      extractedAt: "2026-05-31T15:00:00.000Z",
    }],
    candidateSets: [{
      id: "candidate-set.registration-status",
      target: "registrationStatus",
      status: "resolved",
      selectedCandidateId: "candidate.registration-status",
      candidates: [{
        id: "candidate.registration-status",
        extractionId: "extraction.registration-status",
        value: "ACTIVE",
        confidence: 0.9,
      }],
    }],
    reviewOutcomes: [],
    claims: [{
      id: "claim.registration-status",
      candidateSetId: "candidate-set.registration-status",
      candidateId: "candidate.registration-status",
      subjectType: "public-record.entity",
      subjectId: "entity-1",
      surface: "public-record.profile",
      claimType: "public-data.field",
      fieldOrBehavior: "registrationStatus",
      impactLevel: "medium",
      collectedBy: "records-importer",
    }],
    ...overrides,
  };
}
