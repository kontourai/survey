/**
 * Tests for utteranceToSurveyInput — the utterance → SurveyInput projection.
 *
 * Covers:
 * - Well-formed SurveyInput structure from extracted statements
 * - Full provenance in claim metadata (excerpt, span, extractor name, confidence)
 * - Status discipline: unreviewed extractions project as "proposed" per
 *   statusFor / assertProducerDiscipline rules in to-surface.ts
 * - Integration: buildSurveyTrustBundle accepts the output and produces claims
 * - Edge cases: no statements, statements without spans
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSurveyTrustBundle } from "../src/to-surface.js";
import { utteranceToSurveyInput, referenceUtteranceExtractor } from "../src/agent-utterance.js";
import type { ExtractedStatement } from "../src/agent-utterance.js";
import { getProducerProposal } from "../src/producer-profile.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatements(): ExtractedStatement[] {
  return [
    {
      target: { subjectType: "service", subjectId: "api-gateway", fieldOrBehavior: "uptime" },
      value: "99.9%",
      excerpt: "api-gateway uptime is 99.9%",
      span: { start: 0, end: 26 },
      confidence: 0.85,
    },
    {
      target: { subjectType: "service", subjectId: "db-cluster", fieldOrBehavior: "replication-lag" },
      value: "12ms",
      excerpt: "db-cluster replication-lag is 12ms",
      span: { start: 30, end: 64 },
      confidence: 0.72,
    },
  ];
}

const UTTERANCE = "api-gateway uptime is 99.9%. db-cluster replication-lag is 12ms.";

// ---------------------------------------------------------------------------
// Structure tests
// ---------------------------------------------------------------------------

describe("utteranceToSurveyInput — structure", () => {
  it("produces one RawSource for the entire utterance", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    assert.equal(input.rawSources.length, 1);
    assert.equal(input.rawSources[0]?.kind, "agent-utterance");
    assert.equal(input.rawSources[0]?.locatorScheme, "text-span");
    assert.equal(input.rawSources[0]?.inlineText, UTTERANCE);
    assert.equal(input.rawSources[0]?.metadata?.agentId, "test-agent");
  });

  it("produces one Extraction per statement with locator from span", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    assert.equal(input.extractions.length, 2);
    assert.equal(input.extractions[0]?.locator, "text-span:0-26");
    assert.equal(input.extractions[1]?.locator, "text-span:30-64");
    assert.equal(input.extractions[0]?.extractor, "test-extractor");
    assert.equal(input.extractions[0]?.excerpt, "api-gateway uptime is 99.9%");
  });

  it("produces one CandidateSet per target with needs-review status", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    assert.equal(input.candidateSets.length, 2);
    for (const cs of input.candidateSets) {
      assert.equal(cs.status, "needs-review");
      assert.equal(cs.candidates.length, 1);
    }
  });

  it("produces one ClaimTarget per statement", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    assert.equal(input.claims.length, 2);
    assert.equal(input.claims[0]?.subjectId, "api-gateway");
    assert.equal(input.claims[0]?.fieldOrBehavior, "uptime");
    assert.equal(input.claims[0]?.collectedBy, "test-extractor");
    assert.equal(input.claims[0]?.claimType, "agent-extraction");
    assert.equal(input.claims[0]?.facet, "agent-utterance.profile");
    assert.equal(input.claims[0]?.impactLevel, "low");
  });

  it("reviewOutcomes is empty (unreviewed extractions)", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    assert.equal(input.reviewOutcomes.length, 0);
  });

  it("returns empty SurveyInput for zero extracted statements", () => {
    const input = utteranceToSurveyInput(UTTERANCE, [], {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    assert.equal(input.rawSources.length, 1);
    assert.equal(input.extractions.length, 0);
    assert.equal(input.candidateSets.length, 0);
    assert.equal(input.claims.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Provenance tests
// ---------------------------------------------------------------------------

describe("utteranceToSurveyInput — provenance", () => {
  it("carries excerpt, span, extractor name, and confidence in extraction metadata", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    const meta = input.extractions[0]?.metadata?.agentUtterance as Record<string, unknown> | undefined;
    assert.ok(meta, "agentUtterance metadata should be present");
    assert.equal(meta["excerpt"], "api-gateway uptime is 99.9%");
    assert.equal((meta["span"] as Record<string, number>)["start"], 0);
    assert.equal((meta["span"] as Record<string, number>)["end"], 26);
    assert.equal(meta["extractorName"], "test-extractor");
    assert.equal(meta["confidence"], 0.85);
  });

  it("carries provenance in claim metadata.survey.agentUtterance", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    const claim = input.claims[0]!;
    const survey = claim.metadata?.survey as Record<string, unknown> | undefined;
    assert.ok(survey, "metadata.survey should be present");
    const au = survey["agentUtterance"] as Record<string, unknown> | undefined;
    assert.ok(au, "metadata.survey.agentUtterance should be present");
    assert.equal(au["agentId"], "test-agent");
    assert.equal(au["extractorName"], "test-extractor");
    assert.equal(au["excerpt"], "api-gateway uptime is 99.9%");
    assert.equal(au["confidence"], 0.85);
  });

  it("derives a best-effort locator when span is absent", () => {
    const statements: ExtractedStatement[] = [
      {
        target: { subjectType: "service", subjectId: "api-gateway", fieldOrBehavior: "uptime" },
        value: "99.9%",
        excerpt: "api-gateway uptime is 99.9%",
        // span intentionally omitted
        confidence: 0.5,
      },
    ];

    const input = utteranceToSurveyInput(UTTERANCE, statements, {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    // locator must be non-empty (assertProducerDiscipline requires it for non-manual-entry)
    assert.ok(input.extractions[0]?.locator, "locator should be set even without a span");
    assert.ok(input.extractions[0]!.locator!.startsWith("text-span:"), "locator should be a text-span");
  });
});

// ---------------------------------------------------------------------------
// Status discipline tests
// ---------------------------------------------------------------------------

describe("utteranceToSurveyInput — status discipline (producer rules)", () => {
  it("unreviewed extractions project as proposed claims (not verified/assumed)", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    // Verify no claim explicitly sets verified/assumed (would violate producer discipline)
    for (const claim of input.claims) {
      assert.ok(
        claim.status === undefined || claim.status === "proposed",
        `claim ${claim.id} must not be verified/assumed without review; got ${String(claim.status)}`,
      );
    }
  });

  it("buildSurveyTrustBundle accepts the SurveyInput and produces proposed claims", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    // Must not throw — assertProducerDiscipline must pass
    const bundle = buildSurveyTrustBundle(input);

    assert.equal(bundle.claims.length, 2);
    for (const claim of bundle.claims) {
      assert.equal(claim.status, "proposed", `claim ${claim.id} should be proposed`);
    }
  });

  it("Trust Bundle has evidence with excerpt and locator from extraction", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    const bundle = buildSurveyTrustBundle(input);
    assert.equal(bundle.evidence.length, 2);

    const ev = bundle.evidence[0]!;
    assert.equal(ev.method, "extraction");
    assert.ok(ev.excerptOrSummary, "evidence should have excerptOrSummary");
    assert.equal(ev.sourceLocator, "text-span:0-26");
  });

  it("Trust Bundle metadata carries Survey provenance fields", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    const bundle = buildSurveyTrustBundle(input);
    const claim = bundle.claims[0]!;
    const survey = claim.metadata?.survey as Record<string, unknown> | undefined;

    assert.ok(survey, "claim.metadata.survey should be present in Trust Bundle");
    assert.ok(survey["rawSourceId"], "should carry rawSourceId");
    assert.ok(survey["extractionId"], "should carry extractionId");
    assert.ok(survey["candidateSetId"], "should carry candidateSetId");
  });
});

// ---------------------------------------------------------------------------
// Integration with referenceUtteranceExtractor
// ---------------------------------------------------------------------------

describe("utteranceToSurveyInput — integration with referenceUtteranceExtractor", () => {
  it("round-trips via referenceUtteranceExtractor into a valid SurveyInput", () => {
    const utterance = "myservice status is healthy. mydb latency is 5ms.";
    const extracted = referenceUtteranceExtractor.extract(utterance) as ExtractedStatement[];

    const input = utteranceToSurveyInput(utterance, extracted, {
      agentId: "integration-agent",
      extractorName: referenceUtteranceExtractor.name,
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    assert.ok(input.extractions.length >= 2);
    assert.ok(input.claims.length >= 2);

    const bundle = buildSurveyTrustBundle(input);
    assert.ok(bundle.claims.length >= 2);
    assert.ok(bundle.claims.every((c) => c.status === "proposed"));
  });
});

// ---------------------------------------------------------------------------
// Per-target grouping (Slice 4) — AC1 (equivalence-key pinning via the
// conflict/agreement tests below), AC3, AC4, AC5.
// ---------------------------------------------------------------------------

/**
 * Two statements about the SAME canonical target within one utterance.
 * `firstValue`/`secondValue` let each test control agreement vs. conflict
 * under `utteranceEquivalenceKey`.
 */
function makeSameTargetStatements(firstValue: unknown, secondValue: unknown): ExtractedStatement[] {
  const target = { subjectType: "service", subjectId: "api-gateway", fieldOrBehavior: "status" };
  return [
    {
      target,
      value: firstValue,
      excerpt: "api-gateway status is healthy",
      span: { start: 0, end: 30 },
      confidence: 0.8,
    },
    {
      target,
      value: secondValue,
      excerpt: "api-gateway status is degraded",
      span: { start: 32, end: 63 },
      confidence: 0.75,
    },
  ];
}

const SAME_TARGET_UTTERANCE = "api-gateway status is healthy. api-gateway status is degraded.";

describe("utteranceToSurveyInput — per-target grouping", () => {
  it("repeat target -> one CandidateSet with two Candidates (AC3)", () => {
    const input = utteranceToSurveyInput(SAME_TARGET_UTTERANCE, makeSameTargetStatements("healthy", "healthy"), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    assert.equal(input.candidateSets.length, 1);
    assert.equal(input.candidateSets[0]!.candidates.length, 2);

    // Claims stay one-per-statement even though they share a CandidateSet.
    assert.equal(input.claims.length, 2);
    assert.equal(input.claims[0]!.candidateSetId, input.claims[1]!.candidateSetId);
    assert.notEqual(input.claims[0]!.candidateId, input.claims[1]!.candidateId);

    // to-surface.ts must tolerate the shared-candidateSetId, distinct-candidateId shape.
    const bundle = buildSurveyTrustBundle(input);
    assert.equal(bundle.claims.length, 2);
  });

  it("conflict fires on genuinely different values, and both claims project disputed (AC1, AC4)", () => {
    const input = utteranceToSurveyInput(SAME_TARGET_UTTERANCE, makeSameTargetStatements("healthy", "degraded"), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    assert.equal(input.candidateSets.length, 1);
    assert.equal(input.candidateSets[0]!.status, "conflict");
    assert.equal(input.candidateSets[0]!.selectedCandidateId, undefined);

    const bundle = buildSurveyTrustBundle(input);
    assert.equal(bundle.claims.length, 2);
    for (const claim of bundle.claims) {
      assert.equal(claim.status, "disputed", `claim ${claim.id} should be disputed`);
    }
  });

  it("agreement (including a representation-noise case/whitespace difference) stays needs-review, both claims proposed (AC1, AC5)", () => {
    const input = utteranceToSurveyInput(SAME_TARGET_UTTERANCE, makeSameTargetStatements("Healthy", "  healthy  "), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    assert.equal(input.candidateSets.length, 1);
    assert.equal(input.candidateSets[0]!.status, "needs-review");
    assert.equal(input.candidateSets[0]!.candidates.length, 2);

    const bundle = buildSurveyTrustBundle(input);
    assert.equal(bundle.claims.length, 2);
    for (const claim of bundle.claims) {
      assert.equal(claim.status, "proposed", `claim ${claim.id} should be proposed`);
    }
  });

  it("distinct targets still produce separate CandidateSets (structural no-op control)", () => {
    const input = utteranceToSurveyInput(UTTERANCE, makeStatements(), {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    assert.equal(input.candidateSets.length, 2);
    assert.notEqual(input.candidateSets[0]!.id, input.candidateSets[1]!.id);
  });
});

// ---------------------------------------------------------------------------
// Single-statement parity (black-box confirmation of AC6)
// ---------------------------------------------------------------------------

describe("utteranceToSurveyInput — single-statement parity (black-box)", () => {
  it("a lone statement for a target produces the pre-slice-observable behavior, plus the new per-target candidateSet.id format (AC2, AC6)", () => {
    const statements: ExtractedStatement[] = [
      {
        target: { subjectType: "service", subjectId: "api-gateway", fieldOrBehavior: "uptime" },
        value: "99.9%",
        excerpt: "api-gateway uptime is 99.9%",
        span: { start: 0, end: 26 },
        confidence: 0.85,
      },
    ];

    const agentId = "test-agent";
    const observedAt = "2026-06-10T00:00:00.000Z";
    const input = utteranceToSurveyInput(UTTERANCE, statements, {
      agentId,
      extractorName: "test-extractor",
      now: new Date(observedAt),
    });

    assert.equal(input.candidateSets.length, 1);
    const candidateSet = input.candidateSets[0]!;
    assert.equal(candidateSet.status, "needs-review");
    assert.equal(candidateSet.candidates.length, 1);
    assert.equal(candidateSet.selectedCandidateId, candidateSet.candidates[0]!.id);

    // Only the id FORMAT changed (per-target instead of per-statement) — AC2.
    const sourceId = `agent-utterance:${agentId}:${observedAt}`;
    const targetKey = `${statements[0]!.target.subjectType}/${statements[0]!.target.subjectId}/${statements[0]!.target.fieldOrBehavior}`;
    assert.equal(candidateSet.id, `${sourceId}.target.${targetKey}.candidate-set`);

    const bundle = buildSurveyTrustBundle(input);
    assert.equal(bundle.claims.length, 1);
    assert.equal(bundle.claims[0]!.status, "proposed");
  });
});

// ---------------------------------------------------------------------------
// Typed accessor round-trip (AC8)
// ---------------------------------------------------------------------------

describe("utteranceToSurveyInput — typed accessor round-trip", () => {
  it("getProducerProposal reads back exactly the utterance provenance payload from a projected Candidate", () => {
    const statement: ExtractedStatement = {
      target: { subjectType: "service", subjectId: "api-gateway", fieldOrBehavior: "uptime" },
      value: "99.9%",
      excerpt: "api-gateway uptime is 99.9%",
      span: { start: 0, end: 26 },
      confidence: 0.85,
    };

    const input = utteranceToSurveyInput(UTTERANCE, [statement], {
      agentId: "test-agent",
      extractorName: "test-extractor",
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    const candidate = input.candidateSets[0]!.candidates[0]!;

    interface UtteranceProposalMetadata {
      span?: { start: number; end: number };
      excerpt: string;
      extractorName: string;
      confidence: number;
    }

    const proposal = getProducerProposal<UtteranceProposalMetadata>(candidate);
    assert.deepEqual(proposal, {
      span: statement.span,
      excerpt: statement.excerpt,
      extractorName: "test-extractor",
      confidence: statement.confidence,
    });

    // Exactly one key — the canonical `producerProposal` key, no leftover
    // profile-specific `agentUtterance` key on Candidate.metadata.
    assert.deepEqual(Object.keys(candidate.metadata!), ["producerProposal"]);
  });
});
