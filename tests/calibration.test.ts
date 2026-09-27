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
  reviewedCurrentProposedResolution,
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
  /** Omit selectedCandidateId (the reviewer pick then comes from the outcome). */
  noSelected?: boolean;
  /** Omit the proposed-role marker, so the proposal cannot be determined. */
  unmarked?: boolean;
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
    ...(opts.unmarked ? {} : { metadata: { candidateRole: "proposed" } }),
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

/** `count` chains at one confidence; the last `rejected` of them are rejected. */
function many(prefix: string, count: number, opts: ChainOpts, rejected = 0): Chain[] {
  return Array.from({ length: count }, (_, i) =>
    chain(`${prefix}${i}`, { ...opts, status: i < count - rejected ? "verified" : "rejected" }));
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

  it("skips outcomes with no prediction (proposal not determinable or no confidence)", () => {
    const m = deriveCalibration(inputFrom([
      chain("1", { status: "verified" }),
      chain("2", { status: "verified", unmarked: true }),
      chain("3", { status: "verified", candidateConfidenceUnset: true }),
    ]));
    assert.equal(m.overall.sampleCount, 1);
    assert.equal(m.skippedCount, 2);
  });

  it("finds the proposal by role, not selectedCandidateId", () => {
    const m = deriveCalibration(inputFrom([chain("1", { status: "verified", noSelected: true })]));
    assert.equal(m.overall.sampleCount, 1);
    assert.equal(m.overall.correctCount, 1);
  });

  it("falls back to extraction confidence when the candidate carries none", () => {
    const m = deriveCalibration(inputFrom([
      chain("1", { status: "verified", candidateConfidenceUnset: true, extractionConfidence: 0.85 }),
    ]));
    assert.equal(m.overall.sampleCount, 1);
    assert.equal(m.overall.meanPredictedConfidence, 0.85);
  });
});

describe("deriveCalibration — label source (#279)", () => {
  const at = "2026-09-02T00:00:00.000Z";
  const observation = (i: number, role: "current" | "proposed", confidence: number | undefined, value: number) => ({
    id: `o${i}.${role}`,
    rawSource: { kind: "api-record" as const, sourceRef: `records://${i}/${role}`, observedAt: at, locatorScheme: "structured-field" as const },
    extraction: { target: "fee", value, confidence, locator: "json:$.fee", extractor: "llm", extractedAt: at },
    claim: {
      id: `claim.${i}.${role}`, subjectType: "entity", subjectId: `e${i}`, facet: "profile",
      claimType: "field", fieldOrBehavior: "fee", impactLevel: "medium" as const, collectedBy: "llm",
    },
  });

  it("scores keep-current as a miss for the proposal (25 accept / 25 keep-current → 0.5)", () => {
    const builder = new SurveyInputBuilder({ source: "calibration.label-source", generatedAt: at });
    for (let i = 0; i < 50; i++) {
      builder.addClaimRecords(reviewedCurrentProposedResolution({
        id: `resolution.${i}`,
        target: "fee",
        currentObservation: observation(i, "current", 0.99, 1),
        proposedObservation: observation(i, "proposed", 0.95, 2),
        selectedCandidateRole: i < 25 ? "proposed" : "current",
        unselectedClaimStatus: "rejected",
        reviewOutcome: { status: "verified", actor: "alice", reviewedAt: at },
      }));
    }
    const input = builder.build();
    // The builder records the reviewer's pick as selectedCandidateId.
    assert.ok(input.candidateSets.slice(25).every((cs) => cs.selectedCandidateId?.endsWith(".current.candidate")));

    const m = deriveCalibration(input);
    assert.equal(m.sampleCount, 50);
    assert.equal(m.overall.correctCount, 25);
    assert.equal(m.overall.empiricalAccuracy, 0.5);
    // Every prediction is the proposed candidate's confidence, never the current one's.
    assert.equal(m.overall.meanPredictedConfidence, 0.95);
    assert.equal(m.overall.suggestedThreshold, undefined);
  });

  it("reads the canonical projection's `role` marker the same way", () => {
    const extraction: Extraction = { id: "e", sourceId: "s", target: "fee", value: 2, confidence: 0.95, extractor: "llm", extractedAt: at };
    const candidateSet: CandidateSet = {
      id: "cs",
      target: "fee",
      status: "resolved",
      selectedCandidateId: "current", // the reviewer's pick on the canonical path
      candidates: [
        { id: "current", extractionId: "e", value: 1, metadata: { role: "current" } },
        { id: "proposed", extractionId: "e", value: 2, confidence: 0.95, metadata: { role: "proposed" } },
      ],
    };
    const m = deriveCalibration({
      extractions: [extraction],
      candidateSets: [candidateSet],
      reviewOutcomes: [{ id: "r", candidateSetId: "cs", candidateId: "current", status: "verified", actor: "alice", reviewedAt: at }],
    });
    assert.equal(m.sampleCount, 1);
    assert.equal(m.overall.correctCount, 0);
  });

  it("skips a multi-candidate set with no single proposed candidate", () => {
    const m = deriveCalibration({
      extractions: [{ id: "e", sourceId: "s", target: "fee", value: 1, confidence: 0.9, extractor: "llm", extractedAt: at }],
      candidateSets: [{
        id: "cs", target: "fee", status: "resolved", selectedCandidateId: "current",
        candidates: [
          { id: "current", extractionId: "e", value: 1, confidence: 0.9, metadata: { candidateRole: "current" } },
          { id: "alt", extractionId: "e", value: 2, confidence: 0.5, metadata: { role: "alternative" } },
        ],
      }],
      reviewOutcomes: [{ id: "r", candidateSetId: "cs", candidateId: "current", status: "verified", actor: "alice", reviewedAt: at }],
    });
    assert.equal(m.sampleCount, 0);
    assert.equal(m.skippedCount, 1);
  });

  it("samples a one-candidate set whatever its role", () => {
    // One candidate leaves no reviewer pick to confuse with a proposal: the
    // review affirmed or rejected that value. Covers CandidateRole values and a
    // free-form producer role.
    const roles: Array<Record<string, unknown> | undefined> = [
      { role: "computed" }, { role: "source-version" }, { role: "current" },
      { candidateRole: "primary" }, { role: "proposed" }, undefined,
    ];
    const m = deriveCalibration({
      extractions: [{ id: "e", sourceId: "s", target: "fee", value: 1, confidence: 0.9, extractor: "llm", extractedAt: at }],
      candidateSets: roles.map((metadata, i) => ({
        id: `cs${i}`, target: "fee", status: "resolved" as const, selectedCandidateId: `c${i}`,
        candidates: [{ id: `c${i}`, extractionId: "e", value: 1, confidence: 0.9, ...(metadata ? { metadata } : {}) }],
      })),
      reviewOutcomes: roles.map((_, i) => ({
        id: `r${i}`, candidateSetId: `cs${i}`, candidateId: `c${i}`,
        status: i === 0 ? ("rejected" as const) : ("verified" as const), actor: "alice", reviewedAt: at,
      })),
    });
    assert.equal(m.sampleCount, 6);
    assert.equal(m.skippedCount, 0);
    assert.equal(m.overall.correctCount, 5);
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
    // Top two deciles: 60/60 affirmed (Wilson lower bound 0.9569 ≥ 0.95); the
    // 0.7 decile is half affirmed → threshold 0.8.
    const chains = [
      ...many("h", 60, { confidence: 0.95 }),
      ...many("m", 60, { confidence: 0.85 }),
      ...many("l", 60, { confidence: 0.75 }, 30),
    ];
    const m = deriveCalibration(inputFrom(chains), { targetAccuracy: 0.95 });
    assert.equal(m.overall.suggestedThreshold, 0.8);
    assert.equal(m.overall.bins[9]!.sampleCount, 60);
    assert.equal(m.overall.bins[9]!.accuracyLowerBound, 0.9569);
  });

  it("withholds a threshold grounded on one sample (#279 repro)", () => {
    const m = deriveCalibration(inputFrom([chain("1", { confidence: 0.95, status: "verified" })]));
    assert.equal(m.sampleCount, 1);
    assert.equal(m.overall.empiricalAccuracy, 1);
    assert.equal(m.overall.suggestedThreshold, undefined);
  });

  it("applies the default 30-sample bin floor", () => {
    // A low target the Wilson bound clears easily, so only the floor decides.
    const opts = { targetAccuracy: 0.5 };
    assert.equal(deriveCalibration(inputFrom(many("a", 29, { confidence: 0.95 })), opts).overall.suggestedThreshold, undefined);
    assert.equal(deriveCalibration(inputFrom(many("b", 30, { confidence: 0.95 })), opts).overall.suggestedThreshold, 0.9);
  });

  it("requires the Wilson lower bound, not the point estimate, to meet the target", () => {
    // Floor disabled (1) so only the bound decides. All-affirmed bins have point
    // accuracy 1; the one-sided 95% Wilson bound is n / (n + z²) = n / (n + 2.7055).
    const opts = { targetAccuracy: 0.95, minBinSamples: 1 };
    const at51 = deriveCalibration(inputFrom(many("a", 51, { confidence: 0.95 })), opts).overall;
    assert.equal(at51.bins[9]!.empiricalAccuracy, 1);
    assert.equal(at51.bins[9]!.accuracyLowerBound, 0.9496);
    assert.equal(at51.suggestedThreshold, undefined);
    const at52 = deriveCalibration(inputFrom(many("b", 52, { confidence: 0.95 })), opts).overall;
    assert.equal(at52.bins[9]!.accuracyLowerBound, 0.9505);
    assert.equal(at52.suggestedThreshold, 0.9);
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
    // minBinSamples 3 means the 2-sample top bin cannot vouch for a threshold
    // (a target of 0 takes the Wilson bound out of play).
    const m = deriveCalibration(inputFrom(chains), { minBinSamples: 3, targetAccuracy: 0 });
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
    const m = deriveCalibration(inputFrom(many("h", 60, { extractor: "a", confidence: 0.95 })));
    const claims = calibrationToClaims(m, subject);

    assert.ok(claims.length >= 2); // empiricalAccuracy + suggestedThreshold at least
    for (const { claim } of claims) {
      assert.equal(claim.status, "proposed"); // never decides (ADR 0003 §4)
      assert.equal(claim.claimType, "calibration");
    }
    assert.ok(claims.some((c) => c.claim.fieldOrBehavior === "empiricalAccuracy"));
    assert.ok(claims.some((c) => c.claim.fieldOrBehavior === "suggestedThreshold"));
  });

  it("emits no suggestedThreshold claim when the evidence is too thin", () => {
    const m = deriveCalibration(inputFrom(many("h", 2, { extractor: "a", confidence: 0.95 })));
    const claims = calibrationToClaims(m, subject);
    assert.ok(claims.some((c) => c.claim.fieldOrBehavior === "empiricalAccuracy"));
    assert.ok(!claims.some((c) => c.claim.fieldOrBehavior === "suggestedThreshold"));
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
