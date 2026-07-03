/**
 * Tests for buildUtteranceStatementRecords — the shared per-statement Survey
 * record builder used by both utteranceToSurveyInput and surveyAgentUtterance.
 *
 * Covers:
 * - The Source Locator rule (span-first, excerpt-fallback) in all three
 *   branches: span present, span absent + excerpt findable, span absent +
 *   excerpt not findable.
 * - The returned UtteranceStatementRecords shape (extraction, candidate,
 *   candidateSet), needs-review status, single-candidate grouping, and the
 *   `${sourceId}.statement.${idx}.*` id scheme.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUtteranceStatementRecords } from "../src/agent-utterance.js";
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

// ---------------------------------------------------------------------------
// Locator branches
// ---------------------------------------------------------------------------

describe("buildUtteranceStatementRecords — locator branches", () => {
  it("uses text-span:<start>-<end> when a span is present", () => {
    const utterance = "api-gateway uptime is 99.9%. db-cluster replication-lag is 12ms.";
    const statement = makeStatement({ span: { start: 0, end: 26 } });

    const records = buildUtteranceStatementRecords({
      sourceId: "agent-utterance:test-agent:2026-06-10T00:00:00.000Z",
      idx: 0,
      statement,
      utterance,
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    assert.equal(records.extraction.locator, "text-span:0-26");
  });

  it("falls back to the excerpt's actual position when span is absent but excerpt is findable", () => {
    const excerpt = "db-cluster replication-lag is 12ms";
    const utterance = `api-gateway uptime is 99.9%. ${excerpt}.`;
    // Derived, not a copied magic number: the excerpt's real offset in `utterance`.
    const idx = utterance.indexOf(excerpt);
    assert.ok(idx >= 0, "test fixture must contain the excerpt");

    const statement = makeStatement({ excerpt, span: undefined });

    const records = buildUtteranceStatementRecords({
      sourceId: "agent-utterance:test-agent:2026-06-10T00:00:00.000Z",
      idx: 1,
      statement,
      utterance,
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    assert.equal(records.extraction.locator, `text-span:${idx}-${idx + excerpt.length}`);
  });

  it("falls back to text-span:0-<excerpt.length> when span is absent and excerpt is not findable", () => {
    const excerpt = "this excerpt does not appear anywhere in the utterance text";
    const utterance = "api-gateway uptime is 99.9%.";
    assert.equal(utterance.indexOf(excerpt), -1, "test fixture must NOT contain the excerpt");

    const statement = makeStatement({ excerpt, span: undefined });

    const records = buildUtteranceStatementRecords({
      sourceId: "agent-utterance:test-agent:2026-06-10T00:00:00.000Z",
      idx: 2,
      statement,
      utterance,
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    assert.equal(records.extraction.locator, `text-span:0-${excerpt.length}`);
  });
});

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

describe("buildUtteranceStatementRecords — record shape", () => {
  it("returns exactly extraction, candidate, and candidateSet", () => {
    const utterance = "api-gateway uptime is 99.9%.";
    const statement = makeStatement({ span: { start: 0, end: 26 } });

    const records = buildUtteranceStatementRecords({
      sourceId: "agent-utterance:test-agent:2026-06-10T00:00:00.000Z",
      idx: 0,
      statement,
      utterance,
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    assert.deepEqual(Object.keys(records).sort(), ["candidate", "candidateSet", "extraction"]);
  });

  it("sets candidateSet.status to needs-review with exactly one candidate", () => {
    const utterance = "api-gateway uptime is 99.9%.";
    const statement = makeStatement({ span: { start: 0, end: 26 } });

    const records = buildUtteranceStatementRecords({
      sourceId: "agent-utterance:test-agent:2026-06-10T00:00:00.000Z",
      idx: 0,
      statement,
      utterance,
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    assert.equal(records.candidateSet.status, "needs-review");
    assert.equal(records.candidateSet.candidates.length, 1);
    assert.equal(records.candidateSet.selectedCandidateId, records.candidate.id);
  });

  it("derives ids from sourceId and idx following the ${sourceId}.statement.${idx}.* scheme", () => {
    const utterance = "api-gateway uptime is 99.9%.";
    const statement = makeStatement({ span: { start: 0, end: 26 } });
    const sourceId = "agent-utterance:test-agent:2026-06-10T00:00:00.000Z";
    const idx = 3;

    const records = buildUtteranceStatementRecords({
      sourceId,
      idx,
      statement,
      utterance,
      extractorName: "test-extractor",
      observedAt: OBSERVED_AT,
    });

    assert.equal(records.extraction.id, `${sourceId}.statement.${idx}.extraction`);
    assert.equal(records.candidate.id, `${sourceId}.statement.${idx}.candidate`);
    assert.equal(records.candidateSet.id, `${sourceId}.statement.${idx}.candidate-set`);
  });
});
