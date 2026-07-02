import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateTrustBundle, buildTrustReport } from "@kontourai/surface";
import { buildSurveyTrustBundle, SurveyInputBuilder, fieldObservation, apiRecordSource } from "../src/index.js";
import {
  deriveOversightMetrics,
  oversightMetricsToClaims,
  mergeTrustBundleWithOversightMetrics,
} from "../src/oversight-metrics.js";
import { reviewResourceApiVersion, type ReviewDecision } from "../src/review-resource.js";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeDecision(
  id: string,
  actorId: string,
  reviewedAt: string,
  opts: {
    status?: ReviewDecision["spec"]["status"];
    candidateId?: string;
    projectionCandidateId?: string;
    typed?: boolean;
    rationale?: string;
  } = {},
): ReviewDecision {
  const status = opts.status ?? "verified";
  const candidateId = opts.candidateId ?? `candidate-${id}`;
  const projectionCandidateId = opts.projectionCandidateId ?? candidateId;
  const action: "typed" | "affirmed-control" = opts.typed === true ? "typed" : "affirmed-control";

  return {
    apiVersion: reviewResourceApiVersion,
    kind: "ReviewDecision",
    metadata: { name: `decision-${id}` },
    spec: {
      reviewItemName: `item-${id}`,
      candidateId,
      status,
      actor: { id: actorId },
      reviewedAt,
      rationale: opts.rationale,
      authorizing: {
        kind: "authorized-action",
        promptRef: "review-workbench/decision-card@v1",
        renderedPrompt: `Review item-${id}. Selected decision: ${status}.`,
        action,
        authorityRef: `actor:${actorId}`,
      },
      projection: {
        candidateId: projectionCandidateId,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture: engaged reviewer stream
//
// 5 decisions over ~10 minutes for alice, mixed typed/clicked, some overrides
// ---------------------------------------------------------------------------

const T0 = new Date("2026-06-01T10:00:00.000Z").getTime();
const MIN = 60_000;

const engagedDecisions: ReviewDecision[] = [
  // alice: 3 decisions — 2 minute gaps, 1 typed, 1 override (keep-current via diff candidateId)
  makeDecision("e1", "alice", new Date(T0).toISOString(), { typed: true, rationale: "Looks good to me." }),
  makeDecision("e2", "alice", new Date(T0 + 2 * MIN).toISOString(), {
    candidateId: "candidate-e2-current",
    projectionCandidateId: "candidate-e2-proposed",  // override: chose current over proposed
  }),
  makeDecision("e3", "alice", new Date(T0 + 4 * MIN).toISOString(), { typed: true, rationale: "Checked source." }),
  // bob: 2 decisions — 3 minute gap, 1 override (rejected)
  makeDecision("e4", "bob", new Date(T0 + 1 * MIN).toISOString()),
  makeDecision("e5", "bob", new Date(T0 + 4 * MIN).toISOString(), { status: "rejected" }),
];

// ---------------------------------------------------------------------------
// Fixture: rubber-stamp stream
//
// 40 decisions over 6 minutes by one actor, no overrides, no typed rationale
// ---------------------------------------------------------------------------

const STAMP_T0 = new Date("2026-06-01T09:00:00.000Z").getTime();
const stampDecisions: ReviewDecision[] = Array.from({ length: 40 }, (_, i) =>
  makeDecision(
    `s${i + 1}`,
    "stamp-actor",
    new Date(STAMP_T0 + i * 9_000).toISOString(),   // one every 9 s → ~400/hr
    { candidateId: `candidate-s${i + 1}`, projectionCandidateId: `candidate-s${i + 1}` }, // no override
  ),
);

// ---------------------------------------------------------------------------
// Tests: deriveOversightMetrics
// ---------------------------------------------------------------------------

describe("deriveOversightMetrics", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");

  it("returns zero metrics for empty input", () => {
    const result = deriveOversightMetrics([], { now });
    assert.equal(result.inputDecisionCount, 0);
    assert.equal(result.aggregate.decisionCount, 0);
    assert.equal(result.aggregate.decisionsPerHour, 0);
    assert.equal(result.aggregate.overrideRate, 0);
    assert.equal(result.aggregate.typedRationaleRate, 0);
    assert.equal(result.aggregate.medianInterDecisionSeconds, undefined);
    assert.equal(result.byReviewer.length, 0);
  });

  it("counts decisions correctly", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    assert.equal(result.aggregate.decisionCount, 5);
    assert.equal(result.inputDecisionCount, 5);
  });

  it("produces one row per unique actor", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    const actors = result.byReviewer.map((r) => r.actorId).sort();
    assert.deepEqual(actors, ["alice", "bob"]);
  });

  it("alice: 3 decisions, 2 typed, 1 override", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    const alice = result.byReviewer.find((r) => r.actorId === "alice")!;
    assert.ok(alice);
    assert.equal(alice.decisionCount, 3);
    assert.equal(alice.typedRationaleRate, 2 / 3);
    assert.equal(alice.overrideRate, 1 / 3);
  });

  it("bob: 2 decisions, 0 typed, 1 override (rejected)", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    const bob = result.byReviewer.find((r) => r.actorId === "bob")!;
    assert.ok(bob);
    assert.equal(bob.decisionCount, 2);
    assert.equal(bob.typedRationaleRate, 0);
    assert.equal(bob.overrideRate, 0.5);
  });

  it("aggregate overrideRate: 2 overrides from 5", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    assert.equal(result.aggregate.overrideRate, 2 / 5);
  });

  it("aggregate typedRationaleRate: 2 typed from 5", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    assert.equal(result.aggregate.typedRationaleRate, 2 / 5);
  });

  it("computes medianInterDecisionSeconds correctly for alice", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    const alice = result.byReviewer.find((r) => r.actorId === "alice")!;
    // Gaps: 2 min, 2 min → median = 120 s
    assert.equal(alice.medianInterDecisionSeconds, 120);
  });

  it("computes decisionsPerHour for alice", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    const alice = result.byReviewer.find((r) => r.actorId === "alice")!;
    // 3 decisions over 4 minutes = 45/hr
    assert.ok(alice.decisionsPerHour > 0);
    assert.ok(Math.abs(alice.decisionsPerHour - 45) < 0.01, `expected ~45/hr but got ${alice.decisionsPerHour}`);
  });

  it("respects windowDays to exclude old decisions", () => {
    const farFuture = new Date("2030-01-01T00:00:00.000Z");
    const result = deriveOversightMetrics(engagedDecisions, { now: farFuture, windowDays: 1 });
    // All decisions are from 2026, more than 1 day before 2030 → excluded
    assert.equal(result.inputDecisionCount, 0);
    assert.equal(result.aggregate.decisionCount, 0);
  });

  it("includes decisions within the window", () => {
    // now = same day as decisions, window = 1 day → included
    const nearNow = new Date("2026-06-01T23:00:00.000Z");
    const result = deriveOversightMetrics(engagedDecisions, { now: nearNow, windowDays: 1 });
    assert.equal(result.inputDecisionCount, 5);
  });

  it("samplingCoverage is undefined when presentedCount not supplied", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    assert.equal(result.aggregate.samplingCoverage, undefined);
  });

  it("computes samplingCoverage when presentedCount is supplied", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now, presentedCount: 10 });
    assert.equal(result.aggregate.samplingCoverage, 0.5);  // 5 decided / 10 presented
  });

  it("records windowStart and windowEnd", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    assert.ok(result.windowStart);
    assert.ok(result.windowEnd);
    assert.ok(result.windowStart <= result.windowEnd!);
  });
});

// ---------------------------------------------------------------------------
// Tests: rubber-stamp vs engaged comparison
// ---------------------------------------------------------------------------

describe("rubber-stamp vs engaged fixture contrast", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");

  it("rubber-stamp has 0% override rate", () => {
    const result = deriveOversightMetrics(stampDecisions, { now });
    assert.equal(result.aggregate.overrideRate, 0);
  });

  it("rubber-stamp has 0% typed rationale rate", () => {
    const result = deriveOversightMetrics(stampDecisions, { now });
    assert.equal(result.aggregate.typedRationaleRate, 0);
  });

  it("rubber-stamp has very high decisionsPerHour (≥ 300)", () => {
    const result = deriveOversightMetrics(stampDecisions, { now });
    assert.ok(
      result.aggregate.decisionsPerHour >= 300,
      `expected >= 300/hr but got ${result.aggregate.decisionsPerHour}`,
    );
  });

  it("engaged has non-zero override rate", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    assert.ok(result.aggregate.overrideRate > 0);
  });

  it("engaged has non-zero typed rationale rate", () => {
    const result = deriveOversightMetrics(engagedDecisions, { now });
    assert.ok(result.aggregate.typedRationaleRate > 0);
  });

  it("engaged has lower decisionsPerHour than rubber-stamp", () => {
    const engaged = deriveOversightMetrics(engagedDecisions, { now });
    const stamp = deriveOversightMetrics(stampDecisions, { now });
    assert.ok(
      engaged.aggregate.decisionsPerHour < stamp.aggregate.decisionsPerHour,
      `engaged ${engaged.aggregate.decisionsPerHour}/hr should be < stamp ${stamp.aggregate.decisionsPerHour}/hr`,
    );
  });

  it("rubber-stamp and engaged are clearly distinguishable by overrideRate", () => {
    const engaged = deriveOversightMetrics(engagedDecisions, { now });
    const stamp = deriveOversightMetrics(stampDecisions, { now });
    assert.ok(
      engaged.aggregate.overrideRate > stamp.aggregate.overrideRate,
      `engaged override rate ${engaged.aggregate.overrideRate} should exceed stamp ${stamp.aggregate.overrideRate}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: oversightMetricsToClaims
// ---------------------------------------------------------------------------

describe("oversightMetricsToClaims", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");
  const observedAt = now.toISOString();

  const subject = {
    subjectType: "review-session",
    subjectId: "session-abc",
    facet: "review.oversight",
    actor: "oversight-collector",
    observedAt,
    collectedBy: "oversight-metrics",
  };

  it("produces claims with claimType oversight-quality", () => {
    const metrics = deriveOversightMetrics(engagedDecisions, { now });
    const claimRecords = oversightMetricsToClaims(metrics, subject);

    for (const { claim } of claimRecords) {
      assert.equal(claim.claimType, "oversight-quality");
      assert.equal(claim.subjectType, "review-session");
      assert.equal(claim.subjectId, "session-abc");
    }
  });

  it("produces a claim for each expected metric", () => {
    const metrics = deriveOversightMetrics(engagedDecisions, { now });
    const claimRecords = oversightMetricsToClaims(metrics, subject);
    const fields = claimRecords.map((c) => c.claim.fieldOrBehavior).sort();

    assert.ok(fields.includes("decisionCount"), "missing decisionCount");
    assert.ok(fields.includes("decisionsPerHour"), "missing decisionsPerHour");
    assert.ok(fields.includes("overrideRate"), "missing overrideRate");
    assert.ok(fields.includes("typedRationaleRate"), "missing typedRationaleRate");
    assert.ok(fields.includes("medianInterDecisionSeconds"), "missing medianInterDecisionSeconds");
  });

  it("claim values are numeric", () => {
    const metrics = deriveOversightMetrics(engagedDecisions, { now });
    const claimRecords = oversightMetricsToClaims(metrics, subject);
    for (const { claim } of claimRecords) {
      assert.equal(typeof claim.value, "number", `claim ${claim.fieldOrBehavior} value is not numeric`);
    }
  });

  it("evidence excerpts mention input count and window", () => {
    const metrics = deriveOversightMetrics(engagedDecisions, { now });
    const claimRecords = oversightMetricsToClaims(metrics, subject);
    for (const { evidence } of claimRecords) {
      assert.ok(
        evidence.excerptOrSummary.includes("5 decisions"),
        `evidence excerpt missing decision count: ${evidence.excerptOrSummary}`,
      );
    }
  });

  it("each claim has a corresponding evidence and event", () => {
    const metrics = deriveOversightMetrics(engagedDecisions, { now });
    const claimRecords = oversightMetricsToClaims(metrics, subject);
    for (const { claim, evidence, event } of claimRecords) {
      assert.equal(evidence.claimId, claim.id);
      assert.equal(event.claimId, claim.id);
      assert.ok(event.evidenceIds.includes(evidence.id));
    }
  });

  it("samplingCoverage claim is absent when presentedCount not supplied", () => {
    const metrics = deriveOversightMetrics(engagedDecisions, { now });
    const claimRecords = oversightMetricsToClaims(metrics, subject);
    const fields = claimRecords.map((c) => c.claim.fieldOrBehavior);
    assert.ok(!fields.includes("samplingCoverage"), "samplingCoverage should be absent");
  });

  it("samplingCoverage claim is present when presentedCount is supplied", () => {
    const metrics = deriveOversightMetrics(engagedDecisions, { now, presentedCount: 10 });
    const claimRecords = oversightMetricsToClaims(metrics, subject);
    const fields = claimRecords.map((c) => c.claim.fieldOrBehavior);
    assert.ok(fields.includes("samplingCoverage"), "samplingCoverage should be present");
  });
});

// ---------------------------------------------------------------------------
// Tests: validates via buildSurveyTrustBundle path (mergeTrustBundleWithOversightMetrics)
// ---------------------------------------------------------------------------

describe("buildSurveyTrustBundle integration", () => {
  const now = new Date("2026-06-01T12:00:00.000Z");
  const observedAt = now.toISOString();

  it("merged bundle passes validateTrustBundle for engaged decisions", () => {
    const subject = {
      subjectType: "review-session",
      subjectId: "session-engaged",
      facet: "review.oversight",
      actor: "oversight-collector",
      observedAt,
      collectedBy: "oversight-metrics",
    };

    // Build a minimal trust bundle with a real claim so the bundle is non-empty
    const rawSource = apiRecordSource({
      sourceRef: "oversight-test://source/1",
      observedAt,
      checksum: "abc123",
    });

    const surveyInput = new SurveyInputBuilder({ source: "oversight-test:run-1" })
      .addObservation(fieldObservation({
        id: "oversight-test.entity-1.status.current",
        field: "status",
        value: "ACTIVE",
        rawSource,
        extraction: {
          confidence: 0.9,
          locator: "json:$.status",
          extractor: "oversight-extractor",
          extractedAt: observedAt,
        },
        reviewOutcome: {
          status: "verified",
          actor: "oversight-reviewer",
          reviewedAt: observedAt,
        },
        claim: {
          subjectType: "test-entity",
          subjectId: "entity-1",
          facet: "test.profile",
          claimType: "test-field",
          status: "verified",
          impactLevel: "medium",
          collectedBy: "oversight-extractor",
        },
      }))
      .build();

    const baseBundle = buildSurveyTrustBundle(surveyInput);

    const metrics = deriveOversightMetrics(engagedDecisions, { now });
    const claimRecords = oversightMetricsToClaims(metrics, subject);
    const mergedBundle = mergeTrustBundleWithOversightMetrics(baseBundle, claimRecords);

    // Must not throw
    const validated = validateTrustBundle(mergedBundle);
    const report = buildTrustReport(validated);

    // Original claim + oversight claims
    assert.ok(report.claims.length > 1);
    const oversightClaims = report.claims.filter((c) => c.claimType === "oversight-quality");
    assert.ok(oversightClaims.length >= 4, `expected >= 4 oversight claims, got ${oversightClaims.length}`);
  });

  it("merged bundle passes validateTrustBundle for rubber-stamp decisions", () => {
    const subject = {
      subjectType: "review-session",
      subjectId: "session-stamp",
      facet: "review.oversight",
      actor: "oversight-collector",
      observedAt,
      collectedBy: "oversight-metrics",
    };

    const rawSource = apiRecordSource({
      sourceRef: "oversight-test://source/stamp",
      observedAt,
      checksum: "def456",
    });

    const surveyInput = new SurveyInputBuilder({ source: "oversight-test:stamp-run" })
      .addObservation(fieldObservation({
        id: "oversight-test.stamp.status.current",
        field: "status",
        value: "ACTIVE",
        rawSource,
        extraction: {
          confidence: 0.9,
          locator: "json:$.status",
          extractor: "oversight-extractor",
          extractedAt: observedAt,
        },
        reviewOutcome: {
          status: "verified",
          actor: "oversight-reviewer",
          reviewedAt: observedAt,
        },
        claim: {
          subjectType: "test-entity",
          subjectId: "stamp-1",
          facet: "test.profile",
          claimType: "test-field",
          status: "verified",
          impactLevel: "medium",
          collectedBy: "oversight-extractor",
        },
      }))
      .build();

    const baseBundle = buildSurveyTrustBundle(surveyInput);
    const metrics = deriveOversightMetrics(stampDecisions, { now });
    const claimRecords = oversightMetricsToClaims(metrics, subject);
    const mergedBundle = mergeTrustBundleWithOversightMetrics(baseBundle, claimRecords);

    const validated = validateTrustBundle(mergedBundle);
    const report = buildTrustReport(validated);

    const oversightClaims = report.claims.filter((c) => c.claimType === "oversight-quality");
    assert.ok(oversightClaims.length >= 4);

    // Verify the stamp bundle has 0 overrideRate in claims
    const overrideClaim = oversightClaims.find((c) => c.fieldOrBehavior === "overrideRate");
    assert.ok(overrideClaim);
    assert.equal(overrideClaim.value, 0);
  });

  it("rubber-stamp overrideRate claim is 0; engaged overrideRate claim is > 0", () => {
    const makeSubject = (id: string) => ({
      subjectType: "review-session",
      subjectId: id,
      facet: "review.oversight",
      actor: "oversight-collector",
      observedAt,
      collectedBy: "oversight-metrics",
    });

    const engagedMetrics = deriveOversightMetrics(engagedDecisions, { now });
    const stampMetrics = deriveOversightMetrics(stampDecisions, { now });

    const engagedClaims = oversightMetricsToClaims(engagedMetrics, makeSubject("session-engaged"));
    const stampClaims = oversightMetricsToClaims(stampMetrics, makeSubject("session-stamp"));

    const engagedOverride = engagedClaims.find((c) => c.claim.fieldOrBehavior === "overrideRate")!;
    const stampOverride = stampClaims.find((c) => c.claim.fieldOrBehavior === "overrideRate")!;

    assert.ok(engagedOverride);
    assert.ok(stampOverride);
    assert.ok(
      (engagedOverride.claim.value as number) > (stampOverride.claim.value as number),
      `engaged overrideRate ${engagedOverride.claim.value} should exceed stamp ${stampOverride.claim.value}`,
    );
    assert.equal(stampOverride.claim.value, 0);
  });
});
