import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInterpretationReadingPresentation } from "../src/index.js";

// #259: interpretation readings are authored judgment and must present as
// such — visually distinct from machine-observed facts (StatementBadge /
// ADR 0003 §4 discipline; blending the two is the defect class of #247).
describe("interpretation reading presentation", () => {
  const base = {
    ruleLocator: "json:$.runResult.status",
    reading: "The run record showed the check completing.",
    actor: "producer-operator",
    recordedAt: "2026-08-17T12:04:00.000Z",
  };

  it("presents a gleaned reading under the authored-judgment marking", () => {
    const presentation = buildInterpretationReadingPresentation({
      ...base,
      interpretationId: "interpretation.example.gleaned",
      readingKind: "gleaned",
    });

    assert.equal(presentation.interpretationId, "interpretation.example.gleaned");
    assert.equal(presentation.readingKind, "gleaned");
    assert.equal(presentation.kindLabel, "Gleaned from results");
    assert.equal(presentation.provenance, "authored-judgment");
    assert.equal(presentation.provenanceLabel, "Authored judgment");
    assert.equal(presentation.answerImpact, undefined);
    assert.equal(presentation.answerImpactLabel, undefined);
    assert.equal(presentation.reading, base.reading);
  });

  it("presents every answer-impact value with its own label", () => {
    const expected: Array<[string, string]> = [
      ["supported", "Supported the answer"],
      ["narrowed", "Narrowed the answer"],
      ["accepted-risk", "Accepted as a risk"],
    ];
    for (const [answerImpact, label] of expected) {
      const presentation = buildInterpretationReadingPresentation({
        ...base,
        interpretationId: `interpretation.example.${answerImpact}`,
        readingKind: "answerImpact",
        answerImpact,
      });
      assert.equal(presentation.kindLabel, "Answer impact");
      assert.equal(presentation.answerImpact, answerImpact);
      assert.equal(presentation.answerImpactLabel, label);
      assert.equal(presentation.provenance, "authored-judgment");
    }
  });

  it("defaults an absent readingKind to the policy-standard reading and accepts record ids", () => {
    const presentation = buildInterpretationReadingPresentation({
      ...base,
      id: "interpretation.example.legacy",
    });
    assert.equal(presentation.interpretationId, "interpretation.example.legacy");
    assert.equal(presentation.readingKind, "policy-standard");
    assert.equal(presentation.kindLabel, "Policy-standard reading");
    assert.equal(presentation.provenance, "authored-judgment");
  });

  it("fails closed instead of rendering unknown vocabulary or incoherent shapes", () => {
    assert.throws(
      () => buildInterpretationReadingPresentation({ ...base, id: "i.unknown-kind", readingKind: "vibes" }),
      /unknown readingKind vibes/,
    );
    assert.throws(
      () => buildInterpretationReadingPresentation({
        ...base,
        id: "i.unknown-impact",
        readingKind: "answerImpact",
        answerImpact: "changed-everything",
      }),
      /unknown answerImpact changed-everything/,
    );
    assert.throws(
      () => buildInterpretationReadingPresentation({ ...base, id: "i.impact-missing", readingKind: "answerImpact" }),
      /requires an answerImpact value/,
    );
    assert.throws(
      () => buildInterpretationReadingPresentation({ ...base, id: "i.impact-misplaced", readingKind: "gleaned", answerImpact: "supported" }),
      /sets answerImpact but readingKind is gleaned/,
    );
    assert.throws(
      () => buildInterpretationReadingPresentation({ ...base }),
      /requires an id or interpretationId/,
    );
  });
});
