import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSurveyTrustBundle, deriveCalibration } from "../src/index.js";
import type { ReviewStatus, SurveyInput } from "../src/types.js";

// ---------------------------------------------------------------------------
// Compact fixture: N reviewed claims for a single (extractor, field), each with
// its own affirm/reject outcome, so the derived calibration group has N samples.
// ---------------------------------------------------------------------------

interface Sample {
  extractor?: string;
  field?: string;
  confidence?: number;
  status?: ReviewStatus;
  override?: boolean;
}

function fixture(samples: Sample[]): SurveyInput {
  const input: SurveyInput = {
    source: "cal-produce.fixture",
    generatedAt: "2026-06-01T00:00:00.000Z",
    rawSources: [],
    extractions: [],
    candidateSets: [],
    reviewOutcomes: [],
    claims: [],
  };
  samples.forEach((s, i) => {
    const extractor = s.extractor ?? "extractor-x";
    const field = s.field ?? "field.a";
    const confidence = s.confidence ?? 0.9;
    const status = s.status ?? "verified";
    input.rawSources.push({
      id: `src-${i}`,
      kind: "api-record",
      sourceRef: `records://e/${i}`,
      observedAt: "2026-06-01T00:00:00.000Z",
      locatorScheme: "structured-field",
    });
    input.extractions.push({
      id: `ext-${i}`,
      sourceId: `src-${i}`,
      target: field,
      value: `v-${i}`,
      confidence,
      locator: "json:$.x",
      extractor,
      extractedAt: "2026-06-01T00:00:00.000Z",
    });
    input.candidateSets.push({
      id: `cs-${i}`,
      target: field,
      status: "resolved",
      selectedCandidateId: `cand-${i}`,
      candidates: [
        { id: `cand-${i}`, extractionId: `ext-${i}`, value: `v-${i}`, confidence },
        { id: `cand-${i}-alt`, extractionId: `ext-${i}`, value: `v-${i}-alt`, confidence: 0.3 },
      ],
    });
    input.reviewOutcomes.push({
      id: `ro-${i}`,
      candidateSetId: `cs-${i}`,
      candidateId: s.override ? `cand-${i}-alt` : `cand-${i}`,
      status,
      actor: "human-reviewer",
      reviewedAt: "2026-06-01T00:00:00.000Z",
    });
    input.claims.push({
      id: `claim-${i}`,
      candidateSetId: `cs-${i}`,
      candidateId: `cand-${i}`,
      subjectType: "entity",
      subjectId: `e-${i}`,
      facet: "profile",
      claimType: "field",
      fieldOrBehavior: field,
      impactLevel: "medium",
      collectedBy: extractor,
    });
  });
  return input;
}

function ccOf(input: SurveyInput, opts?: Parameters<typeof buildSurveyTrustBundle>[1]) {
  const bundle = buildSurveyTrustBundle(input, opts);
  return bundle.claims.map((c) => c.conclusionConfidence);
}

// ---------------------------------------------------------------------------

describe("buildSurveyTrustBundle — conclusionConfidence.value (produce side, #137)", () => {
  it("leaves value unset by default (carry-only, unchanged behavior)", () => {
    const ccs = ccOf(fixture([{ status: "verified" }, { status: "verified" }]));
    // No comfortZone signal and no calibration → no conclusionConfidence at all.
    assert.deepEqual(ccs, [undefined, undefined]);
  });

  it("produces value = empirical affirmation rate on affirmed claims, none on the rejected one", () => {
    // 4 samples for one (extractor, field): 3 affirmed, 1 rejected → group rate 0.75.
    const input = fixture([
      { status: "verified" },
      { status: "verified" },
      { status: "assumed" },
      { status: "rejected" },
    ]);
    const ccs = ccOf(input, { calibration: { minSamples: 4 } });
    // The three affirmed conclusions carry the calibrated rate...
    for (const cc of ccs.slice(0, 3)) {
      assert.equal(cc?.value, 0.75);
      assert.equal(cc?.method, "empirical-review-calibration:extractor-field");
    }
    // ...but the REJECTED conclusion gets no value — value is "probability the
    // conclusion is correct", which must not contradict the human rejection.
    assert.equal(ccs[3], undefined);
  });

  it("treats an override as not-affirmed in the produced rate", () => {
    // 2 samples: one affirmed, one overridden → 0.5.
    const ccs = ccOf(
      fixture([{ status: "verified" }, { status: "verified", override: true }]),
      { calibration: { minSamples: 2 } },
    );
    assert.equal(ccs[0]?.value, 0.5);
  });

  it("leaves value unset when the group is below the sample floor", () => {
    const ccs = ccOf(fixture([{ status: "verified" }, { status: "verified" }]), {
      calibration: { minSamples: 20 },
    });
    assert.deepEqual(ccs, [undefined, undefined]);
  });

  it("falls back to the extractor-level group when the field group is too sparse", () => {
    // Same extractor, two different fields, one affirmed sample each → each field
    // group has 1 sample (below floor 2) but the extractor group has 2 (meets it).
    const input = fixture([
      { extractor: "shared", field: "f1", status: "verified" },
      { extractor: "shared", field: "f2", status: "rejected" },
    ]);
    const ccs = ccOf(input, { calibration: { minSamples: 2 } });
    // The affirmed f1 claim falls back to the extractor-level rate (1 of 2 = 0.5).
    assert.equal(ccs[0]?.value, 0.5);
    assert.equal(ccs[0]?.method, "empirical-review-calibration:extractor");
    // The rejected f2 claim gets no value.
    assert.equal(ccs[1], undefined);
  });

  it("accepts precomputed metrics from a longer history", () => {
    // History: extractor "h" affirmed 8/10 on field.a.
    const history = fixture(
      Array.from({ length: 10 }, (_, i) => ({
        extractor: "h",
        field: "field.a",
        status: (i < 8 ? "verified" : "rejected") as ReviewStatus,
      })),
    );
    const metrics = deriveCalibration({
      reviewOutcomes: history.reviewOutcomes,
      candidateSets: history.candidateSets,
      extractions: history.extractions,
    });

    // Current batch has a single new claim from the same extractor/field.
    const current = fixture([{ extractor: "h", field: "field.a", status: "verified" }]);
    const ccs = ccOf(current, { calibration: { metrics, minSamples: 10 } });
    assert.equal(ccs[0]?.value, 0.8);
    assert.equal(ccs[0]?.method, "empirical-review-calibration:extractor-field");
  });

  it("preserves the carried comfortZone alongside a produced value", () => {
    const input = fixture([{ status: "assumed" }, { status: "assumed" }]);
    // Give the first outcome a comfort-zone signal.
    input.reviewOutcomes[0]!.withinComfortZone = true;
    const ccs = ccOf(input, { calibration: { minSamples: 2 } });
    assert.equal(ccs[0]?.value, 1);
    assert.deepEqual(ccs[0]?.comfortZone, { within: true });
    // The second claim has a value but no comfortZone.
    assert.equal(ccs[1]?.value, 1);
    assert.equal(ccs[1]?.comfortZone, undefined);
  });
});
