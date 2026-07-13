/**
 * Worked example: wiring confidence calibration into a downstream consumer.
 *
 * A consumer that owns human review outcomes can close the confidence loop in two
 * places, both shipped in @kontourai/survey (1.10.0):
 *
 *   1. Ground the auto-accept threshold. `deriveCalibration` over a history of
 *      review outcomes yields `suggestedThreshold` — the lowest confidence at
 *      which the extractor's proposals were empirically affirmed often enough.
 *      Feed that number into a producer profile's `autoAcceptMinConfidence`
 *      (see `SchemaMappingOptions.autoAcceptMinConfidence` /
 *      `InquiryMappingOptions.minConfidence`) instead of hand-picking it.
 *
 *   2. Produce calibrated conclusion confidence. Pass the same calibration
 *      `metrics` into `buildSurveyTrustBundle({ calibration: { metrics } })` and
 *      affirmed claims carry `conclusionConfidence.value` = the empirical
 *      affirmation rate for their extractor/field.
 *
 * Calibration is advisory (ADR 0003 §4): the threshold is a suggestion the
 * operator wires into policy, and the produced value never changes claim status.
 *
 * Run: `node dist/examples/calibrated-auto-accept.js`
 */

import {
  buildSurveyTrustBundle,
  deriveCalibration,
  SurveyInputBuilder,
  type CalibrationInput,
} from "../src/index.js";
import type { Candidate, CandidateSet, Extraction, ReviewOutcome } from "../src/types.js";

const EXTRACTOR = "example-extractor";
const FIELD = "registrationStatus";
const HISTORY_AT = "2026-06-01T00:00:00.000Z";
const BATCH_AT = "2026-07-01T00:00:00.000Z";

/**
 * A synthetic history: for this extractor/field, high-confidence proposals were
 * almost always affirmed by reviewers and low-confidence ones were mostly
 * rejected — the pattern that makes an empirical threshold meaningful.
 */
function buildReviewHistory(): CalibrationInput {
  const extractions: Extraction[] = [];
  const candidateSets: CandidateSet[] = [];
  const reviewOutcomes: ReviewOutcome[] = [];
  let n = 0;

  const addSamples = (count: number, confidence: number, affirmed: number): void => {
    for (let i = 0; i < count; i += 1) {
      const key = `h-${n}`;
      n += 1;
      extractions.push({
        id: `${key}-ext`,
        sourceId: `${key}-src`,
        target: FIELD,
        value: "ACTIVE",
        confidence,
        extractor: EXTRACTOR,
        extractedAt: HISTORY_AT,
      });
      const candidate: Candidate = { id: `${key}-cand`, extractionId: `${key}-ext`, value: "ACTIVE", confidence };
      candidateSets.push({
        id: `${key}-cs`,
        target: FIELD,
        status: "resolved",
        selectedCandidateId: candidate.id,
        candidates: [candidate],
      });
      reviewOutcomes.push({
        id: `${key}-ro`,
        candidateSetId: `${key}-cs`,
        candidateId: candidate.id,
        status: i < affirmed ? "verified" : "rejected",
        actor: "example-reviewer",
        reviewedAt: HISTORY_AT,
      });
    }
  };

  addSamples(10, 0.95, 10); // top decile: all affirmed
  addSamples(10, 0.85, 10); // 0.8–0.9: all affirmed
  addSamples(10, 0.75, 5);  // 0.7–0.8: half affirmed → below target, ends the run
  addSamples(10, 0.55, 1);  // 0.5–0.6: mostly rejected

  return { reviewOutcomes, candidateSets, extractions };
}

export interface CalibratedAutoAcceptResult {
  readonly suggestedThreshold: number | undefined;
  readonly groupAccuracy: number | undefined;
  readonly producedValues: ReadonlyArray<number | undefined>;
}

export function runCalibratedAutoAccept(): CalibratedAutoAcceptResult {
  // (1) Derive the empirical calibration curve over the review history.
  const metrics = deriveCalibration(buildReviewHistory(), {
    targetAccuracy: 0.9, // the accuracy the auto-accept threshold must clear
    minBinSamples: 5,    // a decile needs this many samples to ground the threshold
  });
  const suggestedThreshold = metrics.overall.suggestedThreshold;
  const group = metrics.byExtractorField.find((g) => g.extractor === EXTRACTOR && g.field === FIELD);

  // This is the number you feed into your producer profile's auto-accept policy:
  //   surveySchemaMapping(context, extractor, { autoAcceptMinConfidence: suggestedThreshold })
  // Proposals at/above it were empirically affirmed often enough to auto-accept.

  // (2) Produce calibrated conclusion confidence on a new batch of affirmed claims.
  const input = new SurveyInputBuilder({ source: "example-consumer:calibrated", generatedAt: BATCH_AT })
    .addObservation(affirmedObservation("entity-1", 0.85))
    .addObservation(affirmedObservation("entity-2", 0.92))
    .build();

  // Prefer metrics computed over history (not just this batch), so a claim's own
  // outcome does not feed its own value.
  const bundle = buildSurveyTrustBundle(input, { calibration: { metrics, minSamples: 20 } });
  const producedValues = bundle.claims.map((c) => c.conclusionConfidence?.value);

  return { suggestedThreshold, groupAccuracy: group?.empiricalAccuracy, producedValues };
}

function affirmedObservation(subjectId: string, confidence: number) {
  return {
    id: `example.${subjectId}.${FIELD}.current`,
    rawSource: {
      kind: "api-record" as const,
      sourceRef: `records://${subjectId}/registry`,
      observedAt: BATCH_AT,
      locatorScheme: "structured-field" as const,
    },
    extraction: {
      target: FIELD,
      value: "ACTIVE",
      confidence,
      locator: "json:$.registrationStatus",
      extractor: EXTRACTOR,
      extractedAt: BATCH_AT,
    },
    reviewOutcome: { status: "verified" as const, actor: "example-reviewer", reviewedAt: BATCH_AT },
    claim: {
      subjectType: "public-record.entity",
      subjectId,
      facet: "public-record.profile",
      claimType: "public-data.field",
      fieldOrBehavior: FIELD,
      impactLevel: "medium" as const,
      collectedBy: EXTRACTOR,
    },
  };
}

// Run standalone (not when imported by a test).
if (process.argv[1]?.endsWith("calibrated-auto-accept.js")) {
  const result = runCalibratedAutoAccept();
  console.log(JSON.stringify(
    {
      suggestedAutoAcceptThreshold: result.suggestedThreshold,
      empiricalAffirmationRate: result.groupAccuracy,
      producedConclusionConfidenceValues: result.producedValues,
    },
    null,
    2,
  ));
}
