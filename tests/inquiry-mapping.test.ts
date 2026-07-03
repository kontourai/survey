import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TrustBundle } from "@kontourai/surface";
import {
  applyAutoAcceptPolicy,
  applyMappingReview,
  lookupMapping,
  lookupRejectedMapping,
  normalizeQuestion,
  proposalsToCandidateSet,
  referenceMappingProposer,
  referenceUtteranceExtractor,
  resolveQuestion,
  surveyAgentUtterance,
} from "../src/index.js";
import type { InquiryMapping, MappingProposal } from "../src/index.js";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makeBundle(overrides?: Partial<TrustBundle>): TrustBundle {
  return {
    schemaVersion: 3,
    source: "test",
    claims: [
      {
        id: "claim.entity-1.registration-status",
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        facet: "public-record.profile",
        claimType: "public-data.field",
        fieldOrBehavior: "registration-status",
        value: "ACTIVE",
        status: "verified",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "claim.entity-1.coverage-score",
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        facet: "public-record.profile",
        claimType: "public-data.field",
        fieldOrBehavior: "coverage-score",
        value: 95,
        status: "assumed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
    evidence: [],
    policies: [],
    // Verification events are required for deriveClaimStatus to return the
    // correct status. Without them, the status function returns "unknown".
    events: [
      {
        id: "event.registration-status.verified",
        claimId: "claim.entity-1.registration-status",
        status: "verified",
        actor: "reviewer",
        method: "survey-review",
        evidenceIds: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        verifiedAt: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "event.coverage-score.assumed",
        claimId: "claim.entity-1.coverage-score",
        status: "assumed",
        actor: "reviewer",
        method: "survey-assumption",
        evidenceIds: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        verifiedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function makeProposal(overrides: Partial<MappingProposal> & { id: string; question: string }): MappingProposal {
  return {
    proposedTarget: {
      subjectType: "public-record.entity",
      subjectId: "entity-1",
      fieldOrBehavior: "registration-status",
    },
    confidence: 0.8,
    rationale: "test proposal",
    proposedBy: "test-proposer",
    proposedAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeQuestion
// ---------------------------------------------------------------------------

describe("normalizeQuestion", () => {
  it("lowercases the input", () => {
    assert.equal(normalizeQuestion("Is Entity-1 ACTIVE?"), "is entity-1 active");
  });

  it("collapses internal whitespace", () => {
    assert.equal(normalizeQuestion("is  entity-1   active"), "is entity-1 active");
  });

  it("trims leading and trailing whitespace", () => {
    assert.equal(normalizeQuestion("  is entity-1 active  "), "is entity-1 active");
  });

  it("strips terminal punctuation", () => {
    assert.equal(normalizeQuestion("is entity-1 active?"), "is entity-1 active");
    assert.equal(normalizeQuestion("is entity-1 active."), "is entity-1 active");
    assert.equal(normalizeQuestion("is entity-1 active!"), "is entity-1 active");
    assert.equal(normalizeQuestion("is entity-1 active,"), "is entity-1 active");
    assert.equal(normalizeQuestion("is entity-1 active;"), "is entity-1 active");
  });

  it("does not strip punctuation within the question", () => {
    assert.equal(normalizeQuestion("what is entity-1's status"), "what is entity-1's status");
  });

  it("produces the same normalized form for equivalent questions", () => {
    const q1 = normalizeQuestion("Is entity-1 ACTIVE?");
    const q2 = normalizeQuestion("is entity-1 active");
    assert.equal(q1, q2);
  });
});

// ---------------------------------------------------------------------------
// proposalsToCandidateSet
// ---------------------------------------------------------------------------

describe("proposalsToCandidateSet", () => {
  it("projects a single proposal into a needs-review candidate set", () => {
    const proposal = makeProposal({ id: "p1", question: "is entity-1 active" });
    const { candidateSet, candidates } = proposalsToCandidateSet("is entity-1 active", [proposal]);

    assert.equal(candidateSet.status, "needs-review");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.confidence, 0.8);
  });

  it("sets status to conflict when proposals disagree on target", () => {
    const p1 = makeProposal({
      id: "p1",
      question: "entity status",
      proposedTarget: { subjectType: "entity", subjectId: "entity-1", fieldOrBehavior: "registration-status" },
    });
    const p2 = makeProposal({
      id: "p2",
      question: "entity status",
      proposedTarget: { subjectType: "entity", subjectId: "entity-1", fieldOrBehavior: "coverage-score" },
    });

    const { candidateSet } = proposalsToCandidateSet("entity status", [p1, p2]);
    assert.equal(candidateSet.status, "conflict");
  });

  it("sets status to needs-review when proposals agree on target", () => {
    const target = { subjectType: "entity", subjectId: "entity-1", fieldOrBehavior: "registration-status" };
    const p1 = makeProposal({ id: "p1", question: "entity status", proposedTarget: target });
    const p2 = makeProposal({ id: "p2", question: "entity status", proposedTarget: target, confidence: 0.9 });

    const { candidateSet } = proposalsToCandidateSet("entity status", [p1, p2]);
    assert.equal(candidateSet.status, "needs-review");
  });

  it("preserves proposal metadata on candidates", () => {
    const proposal = makeProposal({ id: "p1", question: "is entity-1 active", excerpt: "entity-1 active" });
    const { candidates } = proposalsToCandidateSet("is entity-1 active", [proposal]);
    const meta = candidates[0]?.metadata?.producerProposal as { excerpt?: string; proposedBy?: string } | undefined;

    assert.equal(meta?.excerpt, "entity-1 active");
    assert.equal(meta?.proposedBy, "test-proposer");
  });

  it("produces a needs-review candidate set for an empty proposal list", () => {
    const { candidateSet, candidates } = proposalsToCandidateSet("what is entity-1", []);
    assert.equal(candidateSet.status, "needs-review");
    assert.equal(candidates.length, 0);
  });

  it("sets status to conflict when proposals disagree via rule vs target", () => {
    const p1 = makeProposal({
      id: "p1",
      question: "entity status",
      proposedTarget: { subjectType: "entity", subjectId: "entity-1", fieldOrBehavior: "registration-status" },
      proposedRuleId: undefined,
    });
    const p2: MappingProposal = {
      id: "p2",
      question: "entity status",
      proposedRuleId: "rule.release-ready",
      confidence: 0.7,
      rationale: "test",
      proposedBy: "test",
      proposedAt: "2026-06-10T00:00:00.000Z",
    };

    const { candidateSet } = proposalsToCandidateSet("entity status", [p1, p2]);
    assert.equal(candidateSet.status, "conflict");
  });
});

// ---------------------------------------------------------------------------
// applyAutoAcceptPolicy
// ---------------------------------------------------------------------------

describe("applyAutoAcceptPolicy", () => {
  const target = { subjectType: "entity", subjectId: "entity-1", fieldOrBehavior: "registration-status" };

  it("auto-accepts proposals at or above the min confidence threshold", () => {
    const proposal = makeProposal({ id: "p1", question: "is entity-1 active", proposedTarget: target, confidence: 0.85 });
    const mappings = applyAutoAcceptPolicy([proposal], { minConfidence: 0.85 });

    assert.equal(mappings.length, 1);
    assert.equal(mappings[0]?.status, "assumed");
    assert.equal(mappings[0]?.withinComfortZone, true);
    assert.equal(mappings[0]?.reviewedBy, "auto-accept-policy");
  });

  it("does not auto-accept proposals below the min confidence threshold", () => {
    const proposal = makeProposal({ id: "p1", question: "is entity-1 active", proposedTarget: target, confidence: 0.7 });
    const mappings = applyAutoAcceptPolicy([proposal], { minConfidence: 0.85 });

    assert.equal(mappings.length, 0);
  });

  it("does not auto-accept when proposals disagree (conflict)", () => {
    const p1 = makeProposal({ id: "p1", question: "x", proposedTarget: { ...target }, confidence: 0.9 });
    const p2 = makeProposal({
      id: "p2",
      question: "x",
      proposedTarget: { subjectType: "entity", subjectId: "entity-1", fieldOrBehavior: "coverage-score" },
      confidence: 0.9,
    });
    const mappings = applyAutoAcceptPolicy([p1, p2], { minConfidence: 0.8 });

    assert.equal(mappings.length, 0);
  });

  it("returns empty array for empty proposals", () => {
    assert.equal(applyAutoAcceptPolicy([], { minConfidence: 0.8 }).length, 0);
  });

  it("composes the exact rationale string and reviewedAt (pins byte-identical output post-core-delegation)", () => {
    const proposal = makeProposal({
      id: "p1",
      question: "is entity-1 active",
      proposedTarget: target,
      confidence: 0.85,
      rationale: "test proposal",
      proposedAt: "2026-06-10T00:00:00.000Z",
    });
    const mappings = applyAutoAcceptPolicy([proposal], { minConfidence: 0.85 });

    assert.equal(mappings.length, 1);
    assert.equal(mappings[0]?.rationale, "Auto-accepted: confidence 0.85 >= threshold 0.85. test proposal");
    assert.equal(mappings[0]?.reviewedAt, "2026-06-10T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// applyMappingReview
// ---------------------------------------------------------------------------

describe("applyMappingReview", () => {
  it("produces a verified InquiryMapping from a verified review outcome", () => {
    const question = "is entity-1 active";
    const proposal = makeProposal({ id: "p1", question });
    const { candidateSet, candidates } = proposalsToCandidateSet(question, [proposal]);

    const reviewOutcome = {
      id: "review-1",
      candidateSetId: candidateSet.id,
      candidateId: candidates[0]!.id,
      status: "verified" as const,
      actor: "reviewer@example.test",
      reviewedAt: "2026-06-10T12:00:00.000Z",
      rationale: "Confirmed mapping.",
    };

    const mapping = applyMappingReview(candidateSet, reviewOutcome);

    assert.equal(mapping.status, "verified");
    assert.equal(mapping.reviewedBy, "reviewer@example.test");
    assert.equal(mapping.reviewedAt, "2026-06-10T12:00:00.000Z");
    assert.ok(mapping.target?.fieldOrBehavior === "registration-status");
    assert.equal(mapping.proposalId, "p1");
  });

  it("produces a rejected InquiryMapping from a rejected review outcome", () => {
    const question = "what does entity-1 do";
    const proposal = makeProposal({ id: "p2", question });
    const { candidateSet, candidates } = proposalsToCandidateSet(question, [proposal]);

    const reviewOutcome = {
      id: "review-2",
      candidateSetId: candidateSet.id,
      candidateId: candidates[0]!.id,
      status: "rejected" as const,
      actor: "reviewer@example.test",
      reviewedAt: "2026-06-10T12:01:00.000Z",
      rationale: "Not a relevant mapping.",
    };

    const mapping = applyMappingReview(candidateSet, reviewOutcome);

    assert.equal(mapping.status, "rejected");
    assert.equal(mapping.rationale, "Not a relevant mapping.");
  });
});

// ---------------------------------------------------------------------------
// lookupMapping
// ---------------------------------------------------------------------------

describe("lookupMapping", () => {
  const baseMapping: InquiryMapping = {
    id: "inquiry-mapping.is entity-1 active",
    normalizedQuestion: "is entity-1 active",
    target: { subjectType: "public-record.entity", subjectId: "entity-1", fieldOrBehavior: "registration-status" },
    status: "verified",
    reviewedBy: "reviewer@example.test",
    reviewedAt: "2026-06-10T00:00:00.000Z",
    proposalId: "p1",
  };

  it("returns the mapping on exact normalized-text hit", () => {
    const result = lookupMapping([baseMapping], "is entity-1 active");
    assert.ok(result);
    assert.equal(result.status, "verified");
  });

  it("normalizes the query before lookup (case, whitespace, punctuation)", () => {
    const result = lookupMapping([baseMapping], "Is Entity-1 ACTIVE?");
    assert.ok(result);
  });

  it("returns undefined on miss", () => {
    assert.equal(lookupMapping([baseMapping], "what is entity-1"), undefined);
  });

  it("rejected mappings are remembered but never resolve via lookupMapping", () => {
    const rejected: InquiryMapping = { ...baseMapping, status: "rejected" };
    assert.equal(lookupMapping([rejected], "is entity-1 active"), undefined);
  });

  it("lookupRejectedMapping finds rejected mappings", () => {
    const rejected: InquiryMapping = { ...baseMapping, status: "rejected" };
    const result = lookupRejectedMapping([rejected], "is entity-1 active");
    assert.ok(result);
    assert.equal(result?.status, "rejected");
  });

  it("lookupRejectedMapping returns undefined when mapping is not rejected", () => {
    assert.equal(lookupRejectedMapping([baseMapping], "is entity-1 active"), undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveQuestion — end-to-end
// ---------------------------------------------------------------------------

describe("resolveQuestion", () => {
  it("returns unsupported for a question with no mapping", () => {
    const bundle = makeBundle();
    const record = resolveQuestion(bundle, "what is entity-1 doing", {
      mappings: [],
      now: new Date("2026-06-10T00:00:00.000Z"),
      askedBy: "test-consumer",
    });
    assert.equal(record.outcome, "unsupported");
  });

  it("returns unsupported for a rejected mapping", () => {
    const bundle = makeBundle();
    const rejected: InquiryMapping = {
      id: "inquiry-mapping.is entity-1 active",
      normalizedQuestion: "is entity-1 active",
      target: { subjectType: "public-record.entity", subjectId: "entity-1", fieldOrBehavior: "registration-status" },
      status: "rejected",
      reviewedBy: "reviewer@example.test",
      reviewedAt: "2026-06-10T00:00:00.000Z",
      proposalId: "p1",
    };

    const record = resolveQuestion(bundle, "is entity-1 active", {
      mappings: [rejected],
      now: new Date("2026-06-10T00:00:00.000Z"),
      askedBy: "test-consumer",
    });
    assert.equal(record.outcome, "unsupported");
  });

  it("on mapping hit: live answer recomputes (matched outcome)", () => {
    const bundle = makeBundle();
    const mapping: InquiryMapping = {
      id: "inquiry-mapping.is entity-1 active",
      normalizedQuestion: "is entity-1 active",
      target: { subjectType: "public-record.entity", subjectId: "entity-1", fieldOrBehavior: "registration-status" },
      status: "verified",
      reviewedBy: "reviewer@example.test",
      reviewedAt: "2026-06-10T00:00:00.000Z",
      proposalId: "p1",
    };

    const record = resolveQuestion(bundle, "is entity-1 active", {
      mappings: [mapping],
      now: new Date("2026-06-10T00:00:00.000Z"),
      askedBy: "test-consumer",
    });

    assert.equal(record.outcome, "matched");
    assert.equal(record.answer?.value, "ACTIVE");
    assert.equal(record.answer?.status, "verified");
  });

  it("live answer recomputes with different now across a freshness boundary", () => {
    // Claim with a verification policy that makes it stale after 7 days
    const staleBundleEvents = [
      {
        id: "event.registration-status.verified",
        claimId: "claim.entity-1.registration-status",
        status: "verified" as const,
        actor: "reviewer",
        method: "survey-review",
        evidenceIds: [],
        createdAt: "2026-06-01T00:00:00.000Z",
        verifiedAt: "2026-06-01T00:00:00.000Z",
      },
    ];

    const staleBundle = makeBundle({
      policies: [
        {
          id: "policy.registration-status",
          claimType: "public-data.field",
          requiredEvidence: ["attestation"],
          acceptanceCriteria: [],
          reviewAuthority: "operator",
          validityRule: { kind: "duration", durationDays: 7 },
          stalenessTriggers: [],
          conflictRules: [],
          impactLevel: "medium",
        },
      ],
      events: staleBundleEvents,
    });

    const mapping: InquiryMapping = {
      id: "inquiry-mapping.is entity-1 active",
      normalizedQuestion: "is entity-1 active",
      target: { subjectType: "public-record.entity", subjectId: "entity-1", fieldOrBehavior: "registration-status" },
      status: "verified",
      reviewedBy: "reviewer@example.test",
      reviewedAt: "2026-06-10T00:00:00.000Z",
      proposalId: "p1",
    };

    // Before staleness: claim is verified
    const freshRecord = resolveQuestion(staleBundle, "is entity-1 active", {
      mappings: [mapping],
      now: new Date("2026-06-05T00:00:00.000Z"),
      askedBy: "test-consumer",
    });

    // After staleness boundary: claim becomes stale
    const staleRecord = resolveQuestion(staleBundle, "is entity-1 active", {
      mappings: [mapping],
      now: new Date("2026-06-20T00:00:00.000Z"),
      askedBy: "test-consumer",
    });

    // The mapping is the same; the live answer differs across the freshness boundary
    assert.equal(freshRecord.outcome, "matched");
    assert.equal(staleRecord.outcome, "matched");
    assert.notEqual(freshRecord.answer?.status, staleRecord.answer?.status);
    assert.equal(staleRecord.answer?.status, "stale");
  });
});

// ---------------------------------------------------------------------------
// referenceMappingProposer
// ---------------------------------------------------------------------------

describe("referenceMappingProposer", () => {
  it("proposes a target when question contains subjectId and fieldOrBehavior tokens", () => {
    const bundle = makeBundle();
    const proposals = referenceMappingProposer.propose(
      "what is the registration-status for entity-1",
      { bundle },
    ) as ReturnType<typeof referenceMappingProposer.propose>;

    assert.ok(Array.isArray(proposals));
    const arr = proposals as import("../src/index.js").MappingProposal[];
    assert.ok(arr.length > 0);
    const proposal = arr.find((p) => p.proposedTarget?.subjectId === "entity-1");
    assert.ok(proposal);
  });

  it("returns no proposals when tokens do not match", () => {
    const bundle = makeBundle();
    const proposals = referenceMappingProposer.propose("what is the weather today", { bundle }) as import("../src/index.js").MappingProposal[];
    assert.equal(proposals.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Agent-utterance end-to-end
// ---------------------------------------------------------------------------

describe("surveyAgentUtterance — end-to-end", () => {
  // The reference extractor sets subjectType: "unknown" because subjectType
  // cannot be inferred from text alone. The agent-utterance tests use a
  // bundle whose claims have subjectType: "unknown" to allow direct
  // canonical-key matching.  A production extractor would know the
  // subjectType for its domain and produce the correct canonical target.
  function makeUtteranceBundle(): TrustBundle {
    return {
      schemaVersion: 3,
      source: "test.agent-utterance",
      claims: [
        {
          id: "claim.utterance.entity-1.registration-status",
          subjectType: "unknown",
          subjectId: "entity-1",
          facet: "test.profile",
          claimType: "test.field",
          fieldOrBehavior: "registration-status",
          value: "ACTIVE",
          status: "verified",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "claim.utterance.entity-1.coverage-score",
          subjectType: "unknown",
          subjectId: "entity-1",
          facet: "test.profile",
          claimType: "test.field",
          fieldOrBehavior: "coverage-score",
          value: 95,
          status: "assumed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      evidence: [],
      policies: [],
      events: [
        {
          id: "event.utterance.registration-status.verified",
          claimId: "claim.utterance.entity-1.registration-status",
          status: "verified",
          actor: "reviewer",
          method: "survey-review",
          evidenceIds: [],
          createdAt: "2026-06-01T00:00:00.000Z",
          verifiedAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "event.utterance.coverage-score.assumed",
          claimId: "claim.utterance.entity-1.coverage-score",
          status: "assumed",
          actor: "reviewer",
          method: "survey-assumption",
          evidenceIds: [],
          createdAt: "2026-06-01T00:00:00.000Z",
          verifiedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    };
  }

  it("processes a multi-statement utterance and returns mixed badges (verified + unsupported)", async () => {
    const bundle = makeUtteranceBundle();

    // The utterance contains two statements:
    // 1. "entity-1 registration-status is ACTIVE" — maps to a known claim → verified
    // 2. "entity-2 payment-method is CARD" — no matching claim → unsupported
    const utterance = "entity-1 registration-status is ACTIVE. entity-2 payment-method is CARD.";

    const report = await surveyAgentUtterance(utterance, referenceUtteranceExtractor, {
      bundle,
      now: new Date("2026-06-10T00:00:00.000Z"),
      agentId: "test-agent",
    });

    assert.ok(report.source.kind === "agent-utterance");
    assert.ok(report.statements.length >= 2);

    const verified = report.statements.find((s) => s.badge === "verified");
    const unsupported = report.statements.find((s) => s.badge === "unsupported");

    assert.ok(verified, "expected at least one verified statement");
    assert.ok(unsupported, "expected at least one unsupported statement");
  });

  it("preserves extractor provenance: excerpt, span, and extractor name on records", async () => {
    const bundle = makeUtteranceBundle();
    const utterance = "entity-1 registration-status is ACTIVE";

    const report = await surveyAgentUtterance(utterance, referenceUtteranceExtractor, {
      bundle,
      now: new Date("2026-06-10T00:00:00.000Z"),
      agentId: "test-agent",
    });

    assert.ok(report.statements.length > 0);
    const stmt = report.statements[0]!;
    assert.ok(stmt.excerpt.length > 0, "excerpt should be set");
    assert.ok(stmt.span, "span should be set");
    assert.ok(typeof stmt.span.start === "number");
    assert.ok(typeof stmt.span.end === "number");
    assert.equal(stmt.target.subjectId, "entity-1");
    assert.equal(stmt.target.fieldOrBehavior, "registration-status");
  });

  it("assumed claim produces assumed badge", async () => {
    const bundle = makeUtteranceBundle();
    // coverage-score is "assumed" in the test bundle
    const utterance = "entity-1 coverage-score is 95";

    const report = await surveyAgentUtterance(utterance, referenceUtteranceExtractor, {
      bundle,
      now: new Date("2026-06-10T00:00:00.000Z"),
      agentId: "test-agent",
    });

    const stmt = report.statements.find((s) => s.target.fieldOrBehavior === "coverage-score");
    assert.ok(stmt, "expected a coverage-score statement");
    assert.equal(stmt?.badge, "assumed");
  });

  it("source kind is agent-utterance and locatorScheme is text-span", async () => {
    const bundle = makeUtteranceBundle();
    const report = await surveyAgentUtterance("entity-1 registration-status is ACTIVE", referenceUtteranceExtractor, {
      bundle,
      now: new Date("2026-06-10T00:00:00.000Z"),
      agentId: "test-agent",
    });

    assert.equal(report.source.kind, "agent-utterance");
    assert.equal(report.source.locatorScheme, "text-span");
    assert.equal(report.source.metadata?.agentId, "test-agent");
  });
});

// ---------------------------------------------------------------------------
// referenceUtteranceExtractor — unit tests
// ---------------------------------------------------------------------------

describe("referenceUtteranceExtractor", () => {
  it("extracts a single 'is' statement with span", () => {
    const utterance = "entity-1 registration-status is ACTIVE";
    const results = referenceUtteranceExtractor.extract(utterance) as import("../src/index.js").ExtractedStatement[];

    assert.equal(results.length, 1);
    assert.equal(results[0]?.target.subjectId, "entity-1");
    assert.equal(results[0]?.target.fieldOrBehavior, "registration-status");
    assert.equal(results[0]?.value, "ACTIVE");
    assert.ok(results[0]?.span);
    assert.equal(results[0]?.span?.start, 0);
  });

  it("extracts multiple statements from a multi-sentence utterance", () => {
    const utterance = "entity-1 status is ACTIVE. entity-2 score is 95.";
    const results = referenceUtteranceExtractor.extract(utterance) as import("../src/index.js").ExtractedStatement[];
    assert.ok(results.length >= 2);
  });
});

// ---------------------------------------------------------------------------
// buildMappingReviewItems
// ---------------------------------------------------------------------------

import { buildMappingReviewItems } from "../src/index.js";
import type { ReviewItem } from "../src/index.js";

describe("buildMappingReviewItems", () => {
  it("pins the emitted ReviewItem envelope shape/values for a single non-conflicting proposal", () => {
    const question = "is entity-1 active";
    const proposal = makeProposal({ id: "p1", question });
    const { candidateSet, candidates } = proposalsToCandidateSet(question, [proposal]);

    const result: ReviewItem[] = buildMappingReviewItems([{ candidateSet, candidates }]);

    assert.equal(result.length, 1);
    const item = result[0]!;

    // Envelope
    assert.equal(item.apiVersion, "survey.kontourai.io/v1alpha1");
    assert.equal(item.kind, "ReviewItem");
    assert.equal(item.metadata.name, candidateSet.id);
    assert.equal(item.metadata.labels?.["survey.kontourai.io/kind"], "inquiry-mapping");

    // Spec
    assert.equal(item.spec.target, candidateSet.target);
    assert.equal(item.spec.candidates.length, 1);
    assert.equal(item.spec.candidateSetStatus, candidateSet.status);
    assert.equal(item.spec.rationale, candidateSet.rationale);

    // One candidate, all fields
    const candidate = item.spec.candidates[0]!;
    const expectedCandidate = candidates[0]!;
    assert.equal(candidate.id, expectedCandidate.id);
    assert.equal(candidate.role, "proposed");
    assert.deepEqual(candidate.value, proposal.proposedTarget);
    assert.equal(candidate.confidence, proposal.confidence);
    assert.equal(candidate.source.sourceRef, `inquiry-question:${candidateSet.target}`);
    assert.equal(candidate.source.kind, "inquiry-question");
    assert.equal(candidate.source.observedAt, proposal.proposedAt);
    assert.equal(candidate.source.locatorScheme, "text");
    assert.equal(
      candidate.extraction.target,
      `${proposal.proposedTarget!.subjectType}/${proposal.proposedTarget!.subjectId}/${proposal.proposedTarget!.fieldOrBehavior}`,
    );
    assert.equal(candidate.extraction.confidence, proposal.confidence);
    assert.equal(candidate.extraction.extractor, proposal.proposedBy);
    assert.equal(candidate.extraction.extractedAt, proposal.proposedAt);
    assert.equal(candidate.claimTarget.subjectType, proposal.proposedTarget!.subjectType);
    assert.equal(candidate.claimTarget.subjectId, proposal.proposedTarget!.subjectId);
    assert.equal(candidate.claimTarget.facet, "inquiry.mapping");
    assert.equal(candidate.claimTarget.claimType, "inquiry-mapping");
    assert.equal(candidate.claimTarget.fieldOrBehavior, proposal.proposedTarget!.fieldOrBehavior);
    assert.equal(candidate.claimTarget.impactLevel, "low");
    assert.equal(candidate.projection?.candidateSetId, candidateSet.id);
    assert.equal(candidate.projection?.candidateId, expectedCandidate.id);

    // Status
    assert.equal(item.status?.observedCandidateCount, 1);
  });

  it("produces one ReviewItem per unresolved mapping question, all candidates carried", () => {
    const target = { subjectType: "entity", subjectId: "entity-1", fieldOrBehavior: "registration-status" };
    const p1 = makeProposal({ id: "p1", question: "entity status", proposedTarget: target, confidence: 0.7 });
    const p2 = makeProposal({ id: "p2", question: "entity status", proposedTarget: target, confidence: 0.9 });
    const { candidateSet: cs1, candidates: cands1 } = proposalsToCandidateSet("entity status", [p1, p2]);

    const q2 = "what is entity-2's coverage";
    const p3 = makeProposal({
      id: "p3",
      question: q2,
      proposedTarget: { subjectType: "entity", subjectId: "entity-2", fieldOrBehavior: "coverage-score" },
      confidence: 0.6,
    });
    const { candidateSet: cs2, candidates: cands2 } = proposalsToCandidateSet(q2, [p3]);

    const result = buildMappingReviewItems([
      { candidateSet: cs1, candidates: cands1 },
      { candidateSet: cs2, candidates: cands2 },
    ]);

    assert.equal(result.length, 2);
    assert.equal(result[0]?.spec.candidates.length, 2);
    assert.deepEqual(
      result[0]?.spec.candidates.map((c) => c.id),
      cands1.map((c) => c.id),
    );
    assert.equal(result[1]?.spec.candidates.length, 1);
    assert.equal(result[1]?.spec.candidates[0]?.id, cands2[0]?.id);
  });
});
