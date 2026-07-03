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
