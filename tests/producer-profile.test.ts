/**
 * Tests for the Producer Profile core — src/producer-profile.ts.
 *
 * Covers:
 * - Grouping: N proposals for one target -> one Candidate Set with N
 *   candidates, ids/value/confidence copied through.
 * - Empty group: no proposals -> needs-review with an empty candidates array.
 * - The Candidate Conflict rule, both at the projection level and directly
 *   against hasCandidateConflict.
 * - The typed proposal-metadata accessor round-trip, and the canonical
 *   metadata key literal.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRODUCER_PROPOSAL_METADATA_KEY,
  getProducerProposal,
  hasCandidateConflict,
  projectProposalsToCandidateSet,
} from "../src/producer-profile.js";
import type { CandidateSetProposal } from "../src/producer-profile.js";
import type { Candidate } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposal(overrides: Partial<CandidateSetProposal<unknown, unknown>> = {}): CandidateSetProposal {
  return {
    candidateId: "candidate.1",
    extractionId: "extraction.1",
    value: "some-value",
    confidence: 0.9,
    equivalenceKey: "key-a",
    metadata: { note: "default" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// projectProposalsToCandidateSet — grouping
// ---------------------------------------------------------------------------

describe("projectProposalsToCandidateSet — grouping", () => {
  it("builds one Candidate Set with N candidates for N proposals on the same target", () => {
    const proposals: CandidateSetProposal[] = [
      makeProposal({ candidateId: "candidate.1", extractionId: "extraction.1", value: "v1", confidence: 0.7, equivalenceKey: "same" }),
      makeProposal({ candidateId: "candidate.2", extractionId: "extraction.2", value: "v2", confidence: 0.8, equivalenceKey: "same" }),
      makeProposal({ candidateId: "candidate.3", extractionId: "extraction.3", value: "v3", confidence: 0.9, equivalenceKey: "same" }),
    ];

    const { candidateSet, candidates } = projectProposalsToCandidateSet("target-1", proposals, {
      candidateSetId: "candidate-set.target-1",
    });

    assert.equal(candidateSet.target, "target-1");
    assert.equal(candidateSet.id, "candidate-set.target-1");
    assert.equal(candidateSet.candidates.length, 3);
    assert.equal(candidates.length, 3);
    assert.equal(candidates, candidateSet.candidates);

    proposals.forEach((proposal, i) => {
      const candidate = candidates[i]!;
      assert.equal(candidate.id, proposal.candidateId);
      assert.equal(candidate.extractionId, proposal.extractionId);
      assert.equal(candidate.value, proposal.value);
      assert.equal(candidate.confidence, proposal.confidence);
    });
  });

  it("passes candidateSetMetadata and a computed rationale through to the Candidate Set", () => {
    const proposals: CandidateSetProposal[] = [makeProposal({ equivalenceKey: "only" })];

    const { candidateSet } = projectProposalsToCandidateSet("target-2", proposals, {
      candidateSetId: "candidate-set.target-2",
      candidateSetMetadata: { profile: "test" },
      candidateSetRationale: (status) => `status was ${status}`,
    });

    assert.deepEqual(candidateSet.metadata, { profile: "test" });
    assert.equal(candidateSet.rationale, "status was needs-review");
  });

  it("produces needs-review with an empty candidates array for an empty proposal group", () => {
    const { candidateSet, candidates } = projectProposalsToCandidateSet("target-empty", [], {
      candidateSetId: "candidate-set.target-empty",
    });

    assert.equal(candidateSet.status, "needs-review");
    assert.deepEqual(candidateSet.candidates, []);
    assert.deepEqual(candidates, []);
  });
});

// ---------------------------------------------------------------------------
// Candidate Conflict rule
// ---------------------------------------------------------------------------

describe("Candidate Conflict rule", () => {
  it("projectProposalsToCandidateSet: two proposals sharing one equivalenceKey -> needs-review", () => {
    const proposals: CandidateSetProposal[] = [
      makeProposal({ candidateId: "c1", extractionId: "e1", equivalenceKey: "agree" }),
      makeProposal({ candidateId: "c2", extractionId: "e2", equivalenceKey: "agree" }),
    ];

    const { candidateSet } = projectProposalsToCandidateSet("target", proposals, { candidateSetId: "cs" });

    assert.equal(candidateSet.status, "needs-review");
  });

  it("projectProposalsToCandidateSet: two proposals with different equivalenceKeys -> conflict", () => {
    const proposals: CandidateSetProposal[] = [
      makeProposal({ candidateId: "c1", extractionId: "e1", equivalenceKey: "left" }),
      makeProposal({ candidateId: "c2", extractionId: "e2", equivalenceKey: "right" }),
    ];

    const { candidateSet } = projectProposalsToCandidateSet("target", proposals, { candidateSetId: "cs" });

    assert.equal(candidateSet.status, "conflict");
  });

  it("projectProposalsToCandidateSet: a single proposal never conflicts, regardless of equivalenceKey", () => {
    const proposals: CandidateSetProposal[] = [makeProposal({ equivalenceKey: "whatever" })];

    const { candidateSet } = projectProposalsToCandidateSet("target", proposals, { candidateSetId: "cs" });

    assert.equal(candidateSet.status, "needs-review");
  });

  it("identical equivalenceKeys stay needs-review even when values differ in representation", () => {
    const proposals: CandidateSetProposal[] = [
      makeProposal({ candidateId: "c1", extractionId: "e1", value: { relation: "equivalent", conversion: { factor: 1 } }, equivalenceKey: "equivalent" }),
      makeProposal({ candidateId: "c2", extractionId: "e2", value: { relation: "equivalent", conversion: { factor: 2 } }, equivalenceKey: "equivalent" }),
    ];

    const { candidateSet } = projectProposalsToCandidateSet("target", proposals, { candidateSetId: "cs" });

    assert.equal(candidateSet.status, "needs-review");
  });

  it("hasCandidateConflict (unit-level): mirrors the same rule directly against plain fixtures", () => {
    assert.equal(hasCandidateConflict([]), false);
    assert.equal(hasCandidateConflict([{ equivalenceKey: "a" }]), false);
    assert.equal(hasCandidateConflict([{ equivalenceKey: "a" }, { equivalenceKey: "a" }]), false);
    assert.equal(hasCandidateConflict([{ equivalenceKey: "a" }, { equivalenceKey: "b" }]), true);
    assert.equal(
      hasCandidateConflict([{ equivalenceKey: "a" }, { equivalenceKey: "a" }, { equivalenceKey: "b" }]),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Typed proposal-metadata accessor
// ---------------------------------------------------------------------------

describe("getProducerProposal — typed accessor round-trip", () => {
  it("reads back exactly the metadata payload written by projectProposalsToCandidateSet", () => {
    interface TestMetadata {
      proposalId: string;
      note: string;
    }

    const payload: TestMetadata = { proposalId: "p1", note: "test" };
    const proposals: Array<CandidateSetProposal<string, TestMetadata>> = [
      { candidateId: "c1", extractionId: "e1", value: "v1", equivalenceKey: "only", metadata: payload },
    ];

    const { candidates } = projectProposalsToCandidateSet("target", proposals, { candidateSetId: "cs" });

    const roundTripped = getProducerProposal<TestMetadata>(candidates[0]);
    assert.deepEqual(roundTripped, payload);
  });

  it("stores the payload under exactly the canonical metadata key, no other keys", () => {
    const proposals: CandidateSetProposal[] = [makeProposal({ metadata: { note: "pinned" } })];

    const { candidates } = projectProposalsToCandidateSet("target", proposals, { candidateSetId: "cs" });

    assert.deepEqual(Object.keys(candidates[0]!.metadata!), ["producerProposal"]);
  });

  it("returns undefined for an undefined candidate, without throwing", () => {
    assert.equal(getProducerProposal(undefined), undefined);
  });

  it("returns undefined when the candidate has no metadata, without throwing", () => {
    const candidate: Candidate = { id: "c1", extractionId: "e1", value: "v1" };
    assert.equal(getProducerProposal(candidate), undefined);
  });

  it("returns undefined when metadata is present but the canonical key is absent", () => {
    const candidate: Candidate = { id: "c1", extractionId: "e1", value: "v1", metadata: { someOtherKey: "x" } };
    assert.equal(getProducerProposal(candidate), undefined);
  });
});

// ---------------------------------------------------------------------------
// Canonical key literal
// ---------------------------------------------------------------------------

describe("PRODUCER_PROPOSAL_METADATA_KEY", () => {
  it("is the literal \"producerProposal\"", () => {
    assert.equal(PRODUCER_PROPOSAL_METADATA_KEY, "producerProposal");
  });
});

// ---------------------------------------------------------------------------
// Shared auto-accept primitives
// ---------------------------------------------------------------------------

import { AUTO_ACCEPT_ACTOR, AUTO_ACCEPT_WITHIN_COMFORT_ZONE, meetsAutoAcceptThreshold } from "../src/producer-profile.js";

describe("meetsAutoAcceptThreshold", () => {
  it("returns true when confidence is exactly the minConfidence boundary (inclusive >=)", () => {
    assert.equal(meetsAutoAcceptThreshold(0.85, 0.85), true);
  });

  it("returns false when confidence is just below the minConfidence boundary", () => {
    assert.equal(meetsAutoAcceptThreshold(0.84999, 0.85), false);
  });

  it("returns true when confidence is comfortably above the minConfidence boundary", () => {
    assert.equal(meetsAutoAcceptThreshold(0.9, 0.85), true);
  });
});

describe("auto-accept shared literals", () => {
  it("AUTO_ACCEPT_ACTOR is the literal \"auto-accept-policy\"", () => {
    assert.equal(AUTO_ACCEPT_ACTOR, "auto-accept-policy");
  });

  it("AUTO_ACCEPT_WITHIN_COMFORT_ZONE is the literal true", () => {
    assert.equal(AUTO_ACCEPT_WITHIN_COMFORT_ZONE, true);
  });
});

// ---------------------------------------------------------------------------
// evaluateAutoAccept
// ---------------------------------------------------------------------------

import { evaluateAutoAccept } from "../src/producer-profile.js";
import type { AutoAcceptEvidence, AutoAcceptPolicy } from "../src/producer-profile.js";

describe("evaluateAutoAccept", () => {
  const policy: AutoAcceptPolicy = { minConfidence: 0.85 };
  const fallbackTimestamp = "2026-01-01T00:00:00.000Z";

  it("gates on the passed-in evidence's OWN confidence: exactly at the boundary accepts", () => {
    const evidence: AutoAcceptEvidence = { confidence: 0.85 };

    const decision = evaluateAutoAccept(evidence, false, policy, fallbackTimestamp);

    assert.equal(decision.accepted, true);
    assert.equal(decision.confidence, 0.85);
  });

  it("gates on the passed-in evidence's OWN confidence: just below the boundary rejects, regardless of any hypothetical other-group confidence", () => {
    // evaluateAutoAccept only ever sees the accepted evidence's own confidence
    // (0.84999 here) — it has no notion of "other proposals in the group"
    // (e.g. a sibling proposal at 0.95 that the caller did not pass in) and so
    // cannot ride a higher sibling confidence past the threshold. This is the
    // fixed behavior schema-mapping's old group-max gate did not have (see
    // AC3 in the plan / docs/decisions/producer-profile.md).
    const evidence: AutoAcceptEvidence = { confidence: 0.84999 };

    const decision = evaluateAutoAccept(evidence, false, policy, fallbackTimestamp);

    assert.equal(decision.accepted, false);
    assert.equal(decision.confidence, 0.84999);
  });

  it("comfortably above the boundary accepts", () => {
    const evidence: AutoAcceptEvidence = { confidence: 0.95 };

    const decision = evaluateAutoAccept(evidence, false, policy, fallbackTimestamp);

    assert.equal(decision.accepted, true);
  });

  it("hasConflict: true always blocks acceptance, regardless of confidence", () => {
    const evidence: AutoAcceptEvidence = { confidence: 0.99 };

    const decision = evaluateAutoAccept(evidence, true, policy, fallbackTimestamp);

    assert.equal(decision.accepted, false);
  });

  it("composes the rationale citing the gate-clearing confidence and threshold, with no trailing sentence when evidence.rationale is absent", () => {
    const evidence: AutoAcceptEvidence = { confidence: 0.9 };

    const decision = evaluateAutoAccept(evidence, false, { minConfidence: 0.8 }, fallbackTimestamp);

    assert.equal(decision.rationale, "Auto-accepted: confidence 0.9 >= threshold 0.8.");
  });

  it("appends evidence.rationale verbatim when present (!== undefined, not truthiness)", () => {
    const evidence: AutoAcceptEvidence = {
      confidence: 0.9,
      rationale: "Reference extractor: exact field-name match \"email\" with matching type \"string\" across crm and erp.",
    };

    const decision = evaluateAutoAccept(evidence, false, { minConfidence: 0.8 }, fallbackTimestamp);

    assert.equal(
      decision.rationale,
      "Auto-accepted: confidence 0.9 >= threshold 0.8. Reference extractor: exact field-name match \"email\" with matching type \"string\" across crm and erp.",
    );
  });

  it("appends an empty-string evidence.rationale (present via !== undefined check, not dropped by truthiness)", () => {
    const evidence: AutoAcceptEvidence = { confidence: 0.9, rationale: "" };

    const decision = evaluateAutoAccept(evidence, false, { minConfidence: 0.8 }, fallbackTimestamp);

    assert.equal(decision.rationale, "Auto-accepted: confidence 0.9 >= threshold 0.8. ");
  });

  it("rationale is always computed, even when the decision is not accepted", () => {
    const evidence: AutoAcceptEvidence = { confidence: 0.5, rationale: "low confidence proposal" };

    const decision = evaluateAutoAccept(evidence, false, { minConfidence: 0.8 }, fallbackTimestamp);

    assert.equal(decision.accepted, false);
    assert.equal(decision.rationale, "Auto-accepted: confidence 0.5 >= threshold 0.8. low confidence proposal");
  });

  it("reviewedAt uses evidence.proposedAt when present, with reviewedAtSource \"proposedAt\"", () => {
    const evidence: AutoAcceptEvidence = { confidence: 0.9, proposedAt: "2026-02-15T10:30:00.000Z" };

    const decision = evaluateAutoAccept(evidence, false, { minConfidence: 0.8 }, fallbackTimestamp);

    assert.equal(decision.reviewedAt, "2026-02-15T10:30:00.000Z");
    assert.equal(decision.reviewedAtSource, "proposedAt");
  });

  it("reviewedAt falls back to fallbackTimestamp when evidence.proposedAt is absent, with reviewedAtSource \"fallback\"", () => {
    const evidence: AutoAcceptEvidence = { confidence: 0.9 };

    const decision = evaluateAutoAccept(evidence, false, { minConfidence: 0.8 }, fallbackTimestamp);

    assert.equal(decision.reviewedAt, fallbackTimestamp);
    assert.equal(decision.reviewedAtSource, "fallback");
  });

  it("actor is always the literal \"auto-accept-policy\"", () => {
    const evidence: AutoAcceptEvidence = { confidence: 0.9 };

    const decision = evaluateAutoAccept(evidence, false, { minConfidence: 0.8 }, fallbackTimestamp);

    assert.equal(decision.actor, "auto-accept-policy");
  });

  it("withinComfortZone is always true on an accepted decision", () => {
    const evidence: AutoAcceptEvidence = { confidence: 0.9 };

    const decision = evaluateAutoAccept(evidence, false, { minConfidence: 0.8 }, fallbackTimestamp);

    assert.equal(decision.accepted, true);
    assert.equal(decision.withinComfortZone, true);
  });

  it("withinComfortZone is still the literal true even on a not-accepted decision (the literal is unconditional)", () => {
    const evidence: AutoAcceptEvidence = { confidence: 0.1 };

    const decision = evaluateAutoAccept(evidence, false, { minConfidence: 0.8 }, fallbackTimestamp);

    assert.equal(decision.accepted, false);
    assert.equal(decision.withinComfortZone, true);
  });
});
