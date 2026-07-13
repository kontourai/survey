import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateTrustBundle } from "@kontourai/surface";
import {
  buildSurveyTrustBundle,
  SurveyInputBuilder,
  fieldObservation,
  apiRecordSource,
  deriveCalibration,
  calibrationToClaims,
  mergeTrustBundleWithCalibration,
  type CalibrationInput,
} from "../src/index.js";
import { AUTO_ACCEPT_ACTOR } from "../src/producer-profile.js";
import type { Candidate, CandidateSet, Extraction, ReviewOutcome, ReviewStatus } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

interface ChainOpts {
  extractor?: string;
  target?: string;
  /** Confidence carried on the proposed candidate. */
  confidence?: number;
  /** Confidence carried on the extraction (fallback when candidate has none). */
  extractionConfidence?: number;
  /** Omit the candidate confidence so the extraction fallback is exercised. */
  candidateConfidenceUnset?: boolean;
  status?: ReviewStatus;
  /** When true the reviewer picks the alternative candidate (an override). */
  override?: boolean;
  /** Omit selectedCandidateId (no system prediction). */
  noSelected?: boolean;
  actor?: string;
  reviewedAt?: string;
}

interface Chain {
  extractions: Extraction[];
  candidateSet: CandidateSet;
  reviewOutcome: ReviewOutcome;
}

function chain(id: string, opts: ChainOpts = {}): Chain {
  const extractor = opts.extractor ?? "extractor-x";
  const target = opts.target ?? "field.a";
  const extraction: Extraction = {
    id: `ext-${id}`,
    sourceId: `src-${id}`,
    target,
    value: `value-${id}`,
    confidence: opts.extractionConfidence,
    extractor,
    extractedAt: opts.reviewedAt ?? "2026-07-01T00:00:00.000Z",
  };
  const proposed: Candidate = {
    id: `cand-${id}`,
    extractionId: `ext-${id}`,
    value: `value-${id}`,
    confidence: opts.candidateConfidenceUnset ? undefined : (opts.confidence ?? 0.9),
  };
  const alt: Candidate = {
    id: `cand-${id}-alt`,
    extractionId: `ext-${id}`,
    value: `value-${id}-alt`,
    confidence: 0.4,
  };
  const candidateSet: CandidateSet = {
    id: `cs-${id}`,
    target,
    candidates: [proposed, alt],
    selectedCandidateId: opts.noSelected ? undefined : proposed.id,
    status: "resolved",
  };
  const reviewOutcome: ReviewOutcome = {
    id: `ro-${id}`,
    candidateSetId: candidateSet.id,
    candidateId: opts.override ? alt.id : proposed.id,
    status: opts.status ?? "verified",
    actor: opts.actor ?? "human-reviewer",
    reviewedAt: opts.reviewedAt ?? "2026-07-01T00:00:00.000Z",
  };
  return { extractions: [extraction], candidateSet, reviewOutcome };
}

function inputFrom(chains: Chain[]): CalibrationInput {
  return {
    extractions: chains.flatMap((c) => c.extractions),
    candidateSets: chains.map((c) => c.candidateSet),
    reviewOutcomes: chains.map((c) => c.reviewOutcome),
  };
}

// ---------------------------------------------------------------------------
// Labeling
// ---------------------------------------------------------------------------

describe("deriveCalibration — labeling", () => {
  it("labels an affirmed proposal correct and a rejection/override incorrect", () => {
    const m = deriveCalibration(inputFrom([
      chain("1", { status: "verified" }),
      chain("2", { status: "assumed" }),
      chain("3", { status: "rejected" }),
      chain("4", { status: "verified", override: true }),
    ]));

    assert.equal(m.overall.sampleCount, 4);
    assert.equal(m.overall.correctCount, 2); // #1, #2
    assert.equal(m.overall.empiricalAccuracy, 0.5);
  });

  it("skips proposed (unreviewed) outcomes", () => {
    const m = deriveCalibration(inputFrom([
      chain("1", { status: "verified" }),
      chain("2", { status: "proposed" }),
    ]));
    assert.equal(m.overall.sampleCount, 1);
    assert.equal(m.skippedCount, 1);
  });

  it("excludes machine auto-accepts by default, includes them when opted in", () => {
    const chains = [
      chain("1", { status: "verified", actor: "human-reviewer" }),
      chain("2", { status: "assumed", actor: AUTO_ACCEPT_ACTOR }),
    ];
    const excluded = deriveCalibration(inputFrom(chains));
    assert.equal(excluded.overall.sampleCount, 1);
    assert.equal(excluded.skippedCount, 1);

    const included = deriveCalibration(inputFrom(chains), { includeAutoAccepted: true });
    assert.equal(included.overall.sampleCount, 2);
  });

  it("skips outcomes with no prediction (no selected candidate or no confidence)", () => {
    const m = deriveCalibration(inputFrom([
      chain("1", { status: "verified" }),
      chain("2", { status: "verified", noSelected: true }),
      chain("3", { status: "verified", candidateConfidenceUnset: true }),
    ]));
    assert.equal(m.overall.sampleCount, 1);
    assert.equal(m.skippedCount, 2);
  });

  it("falls back to extraction confidence when the candidate carries none", () => {
    const m = deriveCalibration(inputFrom([
      chain("1", { status: "verified", candidateConfidenceUnset: true, extractionConfidence: 0.85 }),
    ]));
    assert.equal(m.overall.sampleCount, 1);
    assert.equal(m.overall.meanPredictedConfidence, 0.85);
  });
});

// ---------------------------------------------------------------------------
// Grouping + gap
// ---------------------------------------------------------------------------

describe("deriveCalibration — grouping and calibration gap", () => {
  it("groups by extractor and by (extractor, field)", () => {
    const m = deriveCalibration(inputFrom([
      chain("1", { extractor: "a", target: "f1", status: "verified" }),
      chain("2", { extractor: "a", target: "f2", status: "rejected" }),
      chain("3", { extractor: "b", target: "f1", status: "verified" }),
    ]));

    assert.deepEqual(m.byExtractor.map((g) => g.extractor), ["a", "b"]);
    const a = m.byExtractor.find((g) => g.extractor === "a")!;
    assert.equal(a.sampleCount, 2);
    assert.equal(a.correctCount, 1);

    assert.equal(m.byExtractorField.length, 3);
    const af2 = m.byExtractorField.find((g) => g.extractor === "a" && g.field === "f2")!;
    assert.equal(af2.empiricalAccuracy, 0); // the one rejected sample
  });

  it("keeps (extractor, field) groups distinct even when names contain spaces/quotes", () => {
    // Would collide under any naive in-band delimiter (space, etc.).
    const m = deriveCalibration(inputFrom([
      chain("1", { extractor: "ext a", target: "f b", status: "verified" }),
      chain("2", { extractor: "ext", target: 'a"f b', status: "rejected" }),
    ]));
    assert.equal(m.byExtractorField.length, 2);
    const g1 = m.byExtractorField.find((g) => g.extractor === "ext a" && g.field === "f b")!;
    const g2 = m.byExtractorField.find((g) => g.extractor === "ext" && g.field === 'a"f b')!;
    assert.equal(g1.sampleCount, 1);
    assert.equal(g1.correctCount, 1);
    assert.equal(g2.sampleCount, 1);
    assert.equal(g2.correctCount, 0);
  });

  it("reports a positive gap for overconfidence, negative for underconfidence", () => {
    // High stated confidence, all rejected → overconfident (gap > 0).
    const over = deriveCalibration(inputFrom([
      chain("1", { confidence: 0.95, status: "rejected" }),
      chain("2", { confidence: 0.95, status: "rejected" }),
    ]));
    assert.ok(over.overall.calibrationGap! > 0);

    // Low stated confidence, all affirmed → underconfident (gap < 0).
    const under = deriveCalibration(inputFrom([
      chain("3", { confidence: 0.2, status: "verified" }),
      chain("4", { confidence: 0.2, status: "verified" }),
    ]));
    assert.ok(under.overall.calibrationGap! < 0);
  });
});

// ---------------------------------------------------------------------------
// Binning + suggested threshold
// ---------------------------------------------------------------------------

describe("deriveCalibration — bins and suggested threshold", () => {
  it("places samples in the correct decile bin", () => {
    const m = deriveCalibration(inputFrom([
      chain("1", { confidence: 0.05, status: "verified" }),
      chain("2", { confidence: 0.85, status: "verified" }),
      chain("3", { confidence: 1.0, status: "verified" }),
    ]));
    const bins = m.overall.bins;
    assert.equal(bins.length, 10);
    assert.equal(bins[0]!.sampleCount, 1); // 0.05 → [0,0.1)
    assert.equal(bins[8]!.sampleCount, 1); // 0.85 → [0.8,0.9)
    assert.equal(bins[9]!.sampleCount, 1); // 1.0 clamps into the top bin [0.9,1]
  });

  it("suggests the threshold where the top-contiguous bins meet the target accuracy", () => {
    // Top two deciles perfect; the 0.7 decile has a failure → threshold 0.8.
    const chains = [
      chain("h1", { confidence: 0.95, status: "verified" }),
      chain("h2", { confidence: 0.95, status: "verified" }),
      chain("m1", { confidence: 0.85, status: "verified" }),
      chain("m2", { confidence: 0.85, status: "verified" }),
      chain("l1", { confidence: 0.75, status: "verified" }),
      chain("l2", { confidence: 0.75, status: "rejected" }), // 0.7-decile accuracy = 0.5
    ];
    const m = deriveCalibration(inputFrom(chains), { targetAccuracy: 0.95 });
    assert.equal(m.overall.suggestedThreshold, 0.8);
  });

  it("returns undefined when even the top populated bin misses the target", () => {
    const m = deriveCalibration(inputFrom([
      chain("1", { confidence: 0.95, status: "rejected" }),
    ]), { targetAccuracy: 0.95 });
    assert.equal(m.overall.suggestedThreshold, undefined);
  });

  it("does not ground a threshold on an under-sampled bin", () => {
    const chains = [
      chain("h1", { confidence: 0.95, status: "verified" }),
      chain("h2", { confidence: 0.95, status: "verified" }),
    ];
    // minBinSamples 3 means the 2-sample top bin cannot vouch for a threshold.
    const m = deriveCalibration(inputFrom(chains), { minBinSamples: 3 });
    assert.equal(m.overall.suggestedThreshold, undefined);
  });
});

// ---------------------------------------------------------------------------
// Windowing + empty
// ---------------------------------------------------------------------------

describe("deriveCalibration — windowing and empty input", () => {
  it("excludes outcomes older than the window", () => {
    const m = deriveCalibration(inputFrom([
      chain("recent", { status: "verified", reviewedAt: "2026-07-10T00:00:00.000Z" }),
      chain("old", { status: "verified", reviewedAt: "2026-01-01T00:00:00.000Z" }),
    ]), { now: new Date("2026-07-12T00:00:00.000Z"), windowDays: 30 });

    assert.equal(m.overall.sampleCount, 1);
    assert.equal(m.windowStart, "2026-07-10T00:00:00.000Z");
    assert.equal(m.windowDays, 30);
  });

  it("throws when windowDays is set without now", () => {
    assert.throws(
      () => deriveCalibration(inputFrom([chain("1", { status: "verified" })]), { windowDays: 30 }),
      /now.* is required when .windowDays/,
    );
  });

  it("returns an empty overall group for empty input", () => {
    const m = deriveCalibration({ reviewOutcomes: [], candidateSets: [], extractions: [] });
    assert.equal(m.overall.sampleCount, 0);
    assert.equal(m.overall.empiricalAccuracy, undefined);
    assert.equal(m.overall.suggestedThreshold, undefined);
    assert.equal(m.byExtractor.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Claims projection
// ---------------------------------------------------------------------------

describe("calibrationToClaims", () => {
  const subject = {
    subjectType: "extractor",
    subjectId: "run-1",
    facet: "review.calibration",
    actor: "survey-calibration",
    observedAt: "2026-07-12T00:00:00.000Z",
    collectedBy: "survey",
  };

  it("projects advisory proposed claims per extractor", () => {
    const m = deriveCalibration(inputFrom([
      chain("h1", { extractor: "a", confidence: 0.95, status: "verified" }),
      chain("h2", { extractor: "a", confidence: 0.95, status: "verified" }),
    ]));
    const claims = calibrationToClaims(m, subject);

    assert.ok(claims.length >= 2); // empiricalAccuracy + suggestedThreshold at least
    for (const { claim } of claims) {
      assert.equal(claim.status, "proposed"); // never decides (ADR 0003 §4)
      assert.equal(claim.claimType, "calibration");
    }
    assert.ok(claims.some((c) => c.claim.fieldOrBehavior === "empiricalAccuracy"));
    assert.ok(claims.some((c) => c.claim.fieldOrBehavior === "suggestedThreshold"));
  });

  it("produces a bundle that validates when merged", () => {
    const rawSource = apiRecordSource({
      sourceRef: "cal-test://source/1",
      observedAt: subject.observedAt,
      checksum: "abc123",
    });
    const surveyInput = new SurveyInputBuilder({ source: "cal-test:run-1" })
      .addObservation(fieldObservation({
        id: "cal-test.entity-1.color.current",
        field: "color",
        value: "blue",
        rawSource,
        extraction: {
          confidence: 0.9,
          locator: "json:$.color",
          extractor: "cal-extractor",
          extractedAt: subject.observedAt,
        },
        reviewOutcome: {
          status: "verified",
          actor: "cal-reviewer",
          reviewedAt: subject.observedAt,
        },
        claim: {
          subjectType: "test-entity",
          subjectId: "entity-1",
          facet: "test.profile",
          claimType: "test-field",
          status: "verified",
          impactLevel: "medium",
          collectedBy: "cal-extractor",
        },
      }))
      .build();
    const baseBundle = buildSurveyTrustBundle(surveyInput);

    const m = deriveCalibration(inputFrom([
      chain("1", { extractor: "a", confidence: 0.9, status: "verified" }),
    ]));
    const claims = calibrationToClaims(m, subject);
    const merged = mergeTrustBundleWithCalibration(baseBundle, claims);

    // Must not throw and must add the calibration claims on top of the base claim.
    const validated = validateTrustBundle(merged);
    assert.ok(validated.claims.some((c) => c.claimType === "calibration"));
  });
});
