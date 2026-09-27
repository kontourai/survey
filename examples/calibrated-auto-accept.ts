/**
 * Worked example: EXPERIMENTAL confidence calibration from review history.
 *
 * Calibration summarizes how often reviewers affirmed an extractor's proposals.
 * Both outputs below are experimental descriptive statistics (#279), not
 * validated probabilities or policy:
 *
 *   1. `deriveCalibration` reports per-decile affirmation rates and, only when a
 *      decile has enough samples AND a one-sided 95% Wilson lower bound on its
 *      accuracy clears the target, a `suggestedThreshold`. A thin history gets
 *      no threshold at all. Do not feed `suggestedThreshold` into an auto-accept
 *      policy (`autoAcceptMinConfidence` / `minConfidence`) as-is: it is not an
 *      evaluated gate.
 *
 *   2. `buildSurveyTrustBundle({ calibration: { experimentalConclusionValue:
 *      true, metrics } })` sets `conclusionConfidence.value` on affirmed claims
 *      to their extractor/field GROUP's affirmation rate. Every affirmed claim in
 *      the group gets the same base rate whatever its own confidence, so it is
 *      not a per-claim probability. Without the experimental flag no value is set.
 *
 * Calibration is advisory (ADR 0003 §4): it never changes claim status.
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
function buildReviewHistory(samplesPerDecile: number): CalibrationInput {
  const extractions: Extraction[] = [];
  const candidateSets: CandidateSet[] = [];
  const reviewOutcomes: ReviewOutcome[] = [];
  let seq = 0;

  const addSamples = (count: number, confidence: number, affirmed: number): void => {
    for (let i = 0; i < count; i += 1) {
      const key = `h-${seq}`;
      seq += 1;
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

  const n = samplesPerDecile;
  addSamples(n, 0.95, n);                    // top decile: all affirmed
  addSamples(n, 0.85, n - 1);                // 0.8–0.9: all but one affirmed
  addSamples(n, 0.75, Math.round(n / 2));    // 0.7–0.8: half affirmed → ends the run
  addSamples(n, 0.55, Math.round(n / 10));   // 0.5–0.6: mostly rejected

  return { reviewOutcomes, candidateSets, extractions };
}

export interface CalibratedAutoAcceptResult {
  /** Threshold from a 60-samples-per-decile history (enough evidence). */
  readonly suggestedThreshold: number | undefined;
  /** Threshold from a 10-samples-per-decile history (withheld: too thin). */
  readonly sparseHistoryThreshold: number | undefined;
  readonly groupAccuracy: number | undefined;
  /** Values with the experimental opt-in: the group base rate on each claim. */
  readonly producedValues: ReadonlyArray<number | undefined>;
  /** Values with `calibration` enabled but no experimental opt-in: none. */
  readonly defaultValues: ReadonlyArray<number | undefined>;
}

export function runCalibratedAutoAccept(): CalibratedAutoAcceptResult {
  // (1) Derive the empirical calibration curve over the review history.
  const options = { targetAccuracy: 0.9 }; // default 30-sample floor per decile
  const metrics = deriveCalibration(buildReviewHistory(60), options);
  const suggestedThreshold = metrics.overall.suggestedThreshold;
  const sparseHistoryThreshold = deriveCalibration(buildReviewHistory(10), options).overall.suggestedThreshold;
  const group = metrics.byExtractorField.find((g) => g.extractor === EXTRACTOR && g.field === FIELD);

  // (2) Attach the group affirmation rate to a new batch of affirmed claims.
  const input = new SurveyInputBuilder({ source: "example-consumer:calibrated", generatedAt: BATCH_AT })
    .addObservation(affirmedObservation("entity-1", 0.85))
    .addObservation(affirmedObservation("entity-2", 0.92))
    .build();

  // Prefer metrics computed over history (not just this batch), so a claim's own
  // outcome does not feed its own value.
  const bundle = buildSurveyTrustBundle(input, {
    calibration: { experimentalConclusionValue: true, metrics, minSamples: 20 },
  });
  const producedValues = bundle.claims.map((c) => c.conclusionConfidence?.value);
  const defaultValues = buildSurveyTrustBundle(input, { calibration: { metrics, minSamples: 20 } })
    .claims.map((c) => c.conclusionConfidence?.value);

  return { suggestedThreshold, sparseHistoryThreshold, groupAccuracy: group?.empiricalAccuracy, producedValues, defaultValues };
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
      experimentalSuggestedThreshold: result.suggestedThreshold,
      sparseHistorySuggestedThreshold: result.sparseHistoryThreshold,
      groupAffirmationRate: result.groupAccuracy,
      experimentalConclusionValues: result.producedValues,
      valuesWithoutOptIn: result.defaultValues,
    },
    null,
    2,
  ));
}
