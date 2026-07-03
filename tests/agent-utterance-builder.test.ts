/**
 * Tests for buildUtteranceRecords — the shared, batched, per-target-grouped
 * Survey record builder used by both utteranceToSurveyInput and
 * surveyAgentUtterance (Slice 4 successor to Slice 1's per-statement
 * buildUtteranceStatementRecords).
 *
 * Covers:
 * - The Source Locator rule (span-first, excerpt-fallback) in all three
 *   branches: span present, span absent + excerpt findable, span absent +
 *   excerpt not findable. Migrated from the old per-statement builder;
 *   expected locator VALUES are unchanged, only the call shape changed
 *   (Part (c) step 1 / AC7).
 * - The returned per-statement record shape (extraction, candidate,
 *   candidateSet), needs-review status, single-candidate grouping, and the
 *   id scheme: `${sourceId}.statement.${idx}.*` for extraction/candidate
 *   (unchanged), `${sourceId}.target.<canonicalTargetKey>.candidate-set` for
 *   candidateSet (new, target-keyed — Part (b) / AC2 / AC13).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUtteranceRecords } from "../src/agent-utterance.js";
import type { ExtractedStatement } from "../src/agent-utterance.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OBSERVED_AT = "2026-06-10T00:00:00.000Z";

function makeStatement(overrides: Partial<ExtractedStatement> = {}): ExtractedStatement {
  return {
    target: { subjectType: "service", subjectId: "api-gateway", fieldOrBehavior: "uptime" },
    value: "99.9%",
    excerpt: "api-gateway uptime is 99.9%",
    confidence: 0.85,
    ...overrides,
  };
}

/**
 * Mirrors the module-private `canonicalTargetKey` in src/agent-utterance.ts
 * (`${subjectType}/${subjectId}/${fieldOrBehavior}`) — not exported (and not
 * exported solely for this test, per the plan), so this test computes the
 * expected string independently from the fixture's known target.
 */
function expectedTargetKey(target: ExtractedStatement["target"]): string {
  return `${target.subjectType}/${target.subjectId}/${target.fieldOrBehavior}`;
}

// ---------------------------------------------------------------------------
// Locator branches
// ---------------------------------------------------------------------------

describe("buildUtteranceRecords — locator branches", () => {
  it("uses text-span:<start>-<end> when a span is present", () => {
    const utterance = "api-gateway uptime is 99.9%. db-cluster replication-lag is 12ms.";
    const statement = makeStatement({ span: { start: 0, end: 26 } });

    const result = buildUtteranceRecords({
      sourceId: "agent-utterance:test-agent:2026-06-10T00:00:00.000Z",
      utterance,
      extracted: [statement],
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    assert.equal(result.records[0]!.extraction.locator, "text-span:0-26");
  });

  it("falls back to the excerpt's actual position when span is absent but excerpt is findable", () => {
    const excerpt = "db-cluster replication-lag is 12ms";
    const utterance = `api-gateway uptime is 99.9%. ${excerpt}.`;
    // Derived, not a copied magic number: the excerpt's real offset in `utterance`.
    const idx = utterance.indexOf(excerpt);
    assert.ok(idx >= 0, "test fixture must contain the excerpt");

    const statement = makeStatement({ excerpt, span: undefined });

    const result = buildUtteranceRecords({
      sourceId: "agent-utterance:test-agent:2026-06-10T00:00:00.000Z",
      utterance,
      extracted: [statement],
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    assert.equal(result.records[0]!.extraction.locator, `text-span:${idx}-${idx + excerpt.length}`);
  });

  it("falls back to text-span:0-<excerpt.length> when span is absent and excerpt is not findable", () => {
    const excerpt = "this excerpt does not appear anywhere in the utterance text";
    const utterance = "api-gateway uptime is 99.9%.";
    assert.equal(utterance.indexOf(excerpt), -1, "test fixture must NOT contain the excerpt");

    const statement = makeStatement({ excerpt, span: undefined });

    const result = buildUtteranceRecords({
      sourceId: "agent-utterance:test-agent:2026-06-10T00:00:00.000Z",
      utterance,
      extracted: [statement],
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    assert.equal(result.records[0]!.extraction.locator, `text-span:0-${excerpt.length}`);
  });
});

// ---------------------------------------------------------------------------
// Record shape (single-statement parity — AC6)
// ---------------------------------------------------------------------------

describe("buildUtteranceRecords — record shape", () => {
  it("returns exactly extraction, candidate, and candidateSet per record", () => {
    const utterance = "api-gateway uptime is 99.9%.";
    const statement = makeStatement({ span: { start: 0, end: 26 } });

    const result = buildUtteranceRecords({
      sourceId: "agent-utterance:test-agent:2026-06-10T00:00:00.000Z",
      utterance,
      extracted: [statement],
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    assert.equal(result.records.length, 1);
    assert.deepEqual(Object.keys(result.records[0]!).sort(), ["candidate", "candidateSet", "extraction"]);
  });

  it("sets candidateSet.status to needs-review with exactly one candidate for a single-statement group (parity)", () => {
    const utterance = "api-gateway uptime is 99.9%.";
    const statement = makeStatement({ span: { start: 0, end: 26 } });

    const result = buildUtteranceRecords({
      sourceId: "agent-utterance:test-agent:2026-06-10T00:00:00.000Z",
      utterance,
      extracted: [statement],
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    const record = result.records[0]!;
    assert.equal(record.candidateSet.status, "needs-review");
    assert.equal(record.candidateSet.candidates.length, 1);
    assert.equal(record.candidateSet.selectedCandidateId, record.candidate.id);
  });

  it("derives extraction/candidate ids from sourceId and idx (${sourceId}.statement.${idx}.*, unchanged), and candidateSet.id from sourceId and canonical target (${sourceId}.target.<key>.candidate-set, new)", () => {
    const utterance = "api-gateway uptime is 99.9%. db-cluster replication-lag is 12ms.";
    const first = makeStatement({ span: { start: 0, end: 26 } });
    const second = makeStatement({
      target: { subjectType: "service", subjectId: "db-cluster", fieldOrBehavior: "replication-lag" },
      value: "12ms",
      excerpt: "db-cluster replication-lag is 12ms",
      span: { start: 30, end: 64 },
      confidence: 0.72,
    });
    const sourceId = "agent-utterance:test-agent:2026-06-10T00:00:00.000Z";

    const result = buildUtteranceRecords({
      sourceId,
      utterance,
      extracted: [first, second],
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    // Unchanged scheme (statement-index keyed) — Part (b) keeps these verbatim.
    // idx is now the statement's position in `extracted[]`, derived internally
    // by buildUtteranceRecords rather than passed in by the caller.
    assert.equal(result.records[0]!.extraction.id, `${sourceId}.statement.0.extraction`);
    assert.equal(result.records[0]!.candidate.id, `${sourceId}.statement.0.candidate`);
    assert.equal(result.records[1]!.extraction.id, `${sourceId}.statement.1.extraction`);
    assert.equal(result.records[1]!.candidate.id, `${sourceId}.statement.1.candidate`);
    // New scheme (target keyed) — sanctioned observable change #1, Part (b)/AC2/AC13.
    assert.equal(
      result.records[0]!.candidateSet.id,
      `${sourceId}.target.${expectedTargetKey(first.target)}.candidate-set`,
    );
    assert.equal(
      result.records[1]!.candidateSet.id,
      `${sourceId}.target.${expectedTargetKey(second.target)}.candidate-set`,
    );
  });
});
