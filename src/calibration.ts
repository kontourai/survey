/**
 * Extraction-confidence calibration from human review outcomes.
 *
 * Survey owns the review chain, so it owns the one signal no eval vendor can
 * publish: for every reviewed candidate, the stated extraction/candidate
 * confidence (the PREDICTION) against the human review decision (the LABEL).
 * Grouping those labeled samples by extractor (and field) and binning by
 * confidence yields an empirical calibration curve — "confidence in [0.8,0.9)
 * from extractor X was affirmed 17/20 times" — plus a calibration gap and an
 * empirically-grounded auto-accept threshold suggestion.
 *
 * ADVISORY ONLY (ADR 0003 §4, proposals-only). Calibration INFORMS policy — the
 * suggested threshold an operator MAY wire into `autoAcceptMinConfidence` — it
 * never decides a claim or mutates a status. Projected claims carry status
 * "proposed", exactly like every other producer proposal.
 *
 * Machine auto-accepts are EXCLUDED by default: an auto-accepted outcome is the
 * threshold accepting its own guess, so counting it as a "correct" label would
 * let the policy validate itself (circular). Only human review outcomes are
 * labeled samples. Set `includeAutoAccepted` to override.
 *
 * All computations are deterministic; `now` + `windowDays` window by `reviewedAt`.
 */

import type { Claim, Evidence, TrustBundle, VerificationEvent } from "@kontourai/surface";
import { AUTO_ACCEPT_ACTOR } from "./producer-profile.js";
import type { Candidate, CandidateSet, Extraction, ReviewOutcome } from "./types.js";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * The three record arrays a calibration derivation reads — a subset of
 * {@link SurveyInput}. Kept narrow so a caller can pass an existing batch's
 * fields directly without constructing a whole SurveyInput.
 */
export interface CalibrationInput {
  readonly reviewOutcomes: readonly ReviewOutcome[];
  readonly candidateSets: readonly CandidateSet[];
  readonly extractions: readonly Extraction[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeriveCalibrationOptions {
  /**
   * Current time — required only when `windowDays` is set (windowing is by
   * `reviewedAt`). Injected for determinism; never read from the wall clock.
   */
  readonly now?: Date;
  /**
   * Optional rolling window in days. Review outcomes whose `reviewedAt` is older
   * than `now - windowDays` are excluded. Requires `now` — setting `windowDays`
   * without `now` throws (rather than silently disabling windowing). When
   * omitted, all supplied outcomes are considered.
   */
  readonly windowDays?: number;
  /** Number of equal-width confidence bins over [0,1]. Default 10 (deciles). */
  readonly binCount?: number;
  /**
   * The empirical accuracy the suggested threshold must clear. Default 0.95.
   * A `suggestedThreshold` is the lowest bin lower-bound at/above which every
   * populated bin's empirical accuracy meets this target.
   */
  readonly targetAccuracy?: number;
  /**
   * A bin needs at least this many samples to count toward `suggestedThreshold`
   * (both to qualify and to disqualify). Default 1. Raise it to avoid grounding
   * a threshold on a bin with too little evidence.
   */
  readonly minBinSamples?: number;
  /**
   * Include machine auto-accepted outcomes (actor === AUTO_ACCEPT_ACTOR) as
   * labeled samples. Default false — see the module note on circularity.
   */
  readonly includeAutoAccepted?: boolean;
}

const DEFAULT_BIN_COUNT = 10;
const DEFAULT_TARGET_ACCURACY = 0.95;
const DEFAULT_MIN_BIN_SAMPLES = 1;

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** One labeled calibration sample: a prediction paired with the human label. */
export interface CalibrationSample {
  /** The extractor that produced the proposed value (or "unknown"). */
  readonly extractor: string;
  /** The extraction target / field the value belongs to. */
  readonly field: string;
  /** The proposed candidate's stated confidence, clamped to [0,1]. */
  readonly predictedConfidence: number;
  /** True iff the human review affirmed the proposed value. */
  readonly correct: boolean;
  /** The review outcome this sample came from. */
  readonly reviewOutcomeId: string;
  /** The candidate set the outcome reviewed. */
  readonly candidateSetId: string;
  /** The outcome's `reviewedAt`, when present. */
  readonly reviewedAt: string | undefined;
}

/** An equal-width confidence bin with its empirical accuracy. */
export interface CalibrationBin {
  /** Inclusive lower bound of the bin. */
  readonly lowerBound: number;
  /** Exclusive upper bound (inclusive at 1.0 for the top bin). */
  readonly upperBound: number;
  readonly sampleCount: number;
  readonly correctCount: number;
  /** correctCount / sampleCount; undefined when the bin has no samples. */
  readonly empiricalAccuracy: number | undefined;
  /** Mean predicted confidence of samples in the bin; undefined when empty. */
  readonly meanPredictedConfidence: number | undefined;
}

/** A calibration rollup for one extractor (and optionally one field). */
export interface CalibrationGroup {
  readonly extractor: string;
  /** The field, or undefined for an extractor-level rollup across all fields. */
  readonly field: string | undefined;
  readonly sampleCount: number;
  readonly correctCount: number;
  /** correctCount / sampleCount; undefined when the group has no samples. */
  readonly empiricalAccuracy: number | undefined;
  /** Mean predicted confidence across the group; undefined when no samples. */
  readonly meanPredictedConfidence: number | undefined;
  /**
   * meanPredictedConfidence − empiricalAccuracy. Positive → overconfident
   * (states more confidence than the humans bear out); negative →
   * underconfident. undefined when the group has no samples.
   */
  readonly calibrationGap: number | undefined;
  /** Per-bin empirical accuracy, ascending by lowerBound. */
  readonly bins: readonly CalibrationBin[];
  /**
   * Lowest bin lowerBound at/above which every populated bin (≥ minBinSamples)
   * meets `targetAccuracy`, scanning the top-contiguous run of qualifying bins.
   * undefined when no bin qualifies — the data does not yet support an empirical
   * auto-accept threshold at that target. ADVISORY: an operator wires this into
   * `autoAcceptMinConfidence`; calibration never sets it.
   */
  readonly suggestedThreshold: number | undefined;
}

export interface CalibrationMetrics {
  /** One rollup per extractor (field === undefined), sorted by extractor. */
  readonly byExtractor: readonly CalibrationGroup[];
  /** One rollup per (extractor, field) pair, sorted by extractor then field. */
  readonly byExtractorField: readonly CalibrationGroup[];
  /** A single rollup across every labeled sample (extractor "*"). */
  readonly overall: CalibrationGroup;
  /** Number of labeled samples used. */
  readonly sampleCount: number;
  /** Outcomes that could not be turned into a labeled sample (see reasons). */
  readonly skippedCount: number;
  /** ISO 8601 timestamp of the earliest labeled sample's `reviewedAt`. */
  readonly windowStart: string | undefined;
  /** ISO 8601 timestamp of the latest labeled sample's `reviewedAt`. */
  readonly windowEnd: string | undefined;
  /** The `windowDays` option echoed back (undefined when not windowed). */
  readonly windowDays: number | undefined;
}

// ---------------------------------------------------------------------------
// deriveCalibration
// ---------------------------------------------------------------------------

/**
 * Derives extractor/field confidence calibration from review outcomes.
 *
 * Each reviewed candidate set contributes one labeled sample: the confidence of
 * the SYSTEM-proposed candidate (`CandidateSet.selectedCandidateId`) as the
 * prediction, and whether the human review affirmed that proposed value as the
 * label. A sample is skipped when it carries no human label or no prediction:
 *
 * - status "proposed" (not yet reviewed);
 * - a machine auto-accept, unless `includeAutoAccepted` is set;
 * - no `selectedCandidateId`, or the selected candidate / its confidence is
 *   missing or non-finite (no prediction to calibrate).
 *
 * A sample is "correct" when the outcome status is verified/assumed AND the
 * reviewer did not switch to a different candidate; "incorrect" when the status
 * is rejected or the reviewer overrode the proposed candidate.
 */
export function deriveCalibration(
  input: CalibrationInput,
  options: DeriveCalibrationOptions = {},
): CalibrationMetrics {
  const binCount = normalizeBinCount(options.binCount);
  const targetAccuracy = options.targetAccuracy ?? DEFAULT_TARGET_ACCURACY;
  const minBinSamples = options.minBinSamples ?? DEFAULT_MIN_BIN_SAMPLES;
  const includeAutoAccepted = options.includeAutoAccepted ?? false;

  const candidateSetById = new Map(input.candidateSets.map((cs) => [cs.id, cs]));
  const candidateById = new Map<string, Candidate>();
  for (const cs of input.candidateSets) {
    for (const c of cs.candidates) candidateById.set(c.id, c);
  }
  const extractionById = new Map(input.extractions.map((e) => [e.id, e]));

  if (options.windowDays !== undefined && options.now === undefined) {
    throw new RangeError("deriveCalibration: `now` is required when `windowDays` is set (windowing is by reviewedAt).");
  }
  const cutoff = options.windowDays !== undefined && options.now !== undefined
    ? options.now.getTime() - options.windowDays * 24 * 60 * 60 * 1000
    : undefined;

  const samples: CalibrationSample[] = [];
  let skippedCount = 0;

  for (const outcome of input.reviewOutcomes) {
    if (cutoff !== undefined) {
      const t = outcome.reviewedAt ? Date.parse(outcome.reviewedAt) : NaN;
      if (isNaN(t) || t < cutoff) {
        skippedCount++;
        continue;
      }
    }

    const sample = toSample(outcome, candidateSetById, candidateById, extractionById, includeAutoAccepted);
    if (sample === undefined) {
      skippedCount++;
      continue;
    }
    samples.push(sample);
  }

  const timestamps = samples
    .map((s) => (s.reviewedAt ? Date.parse(s.reviewedAt) : NaN))
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b);
  const windowStart = timestamps.length > 0 ? new Date(timestamps[0]!).toISOString() : undefined;
  const windowEnd = timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]!).toISOString() : undefined;

  const buildGroup = (extractor: string, field: string | undefined, groupSamples: CalibrationSample[]): CalibrationGroup =>
    computeGroup(extractor, field, groupSamples, binCount, targetAccuracy, minBinSamples);

  // Extractor-level rollups.
  const byExtractorMap = new Map<string, CalibrationSample[]>();
  // (extractor, field) rollups. The key is a JSON-encoded [extractor, field]
  // pair so no in-band delimiter can collide with an extractor/field that
  // contains that delimiter; the extractor and field are carried in the value,
  // never parsed back out of the key.
  const byFieldMap = new Map<string, { extractor: string; field: string; samples: CalibrationSample[] }>();
  for (const s of samples) {
    pushTo(byExtractorMap, s.extractor, s);
    const fieldKey = JSON.stringify([s.extractor, s.field]);
    const existing = byFieldMap.get(fieldKey);
    if (existing) existing.samples.push(s);
    else byFieldMap.set(fieldKey, { extractor: s.extractor, field: s.field, samples: [s] });
  }

  const byExtractor = [...byExtractorMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([extractor, groupSamples]) => buildGroup(extractor, undefined, groupSamples));

  const byExtractorField = [...byFieldMap.values()]
    .sort((a, b) => (a.extractor < b.extractor ? -1 : a.extractor > b.extractor ? 1 : a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
    .map(({ extractor, field, samples: groupSamples }) => buildGroup(extractor, field, groupSamples));

  const overall = buildGroup("*", undefined, samples);

  return {
    byExtractor,
    byExtractorField,
    overall,
    sampleCount: samples.length,
    skippedCount,
    windowStart,
    windowEnd,
    windowDays: options.windowDays,
  };
}

// ---------------------------------------------------------------------------
// Internal: sample construction
// ---------------------------------------------------------------------------

function toSample(
  outcome: ReviewOutcome,
  candidateSetById: Map<string, CandidateSet>,
  candidateById: Map<string, Candidate>,
  extractionById: Map<string, Extraction>,
  includeAutoAccepted: boolean,
): CalibrationSample | undefined {
  // No human label yet.
  if (outcome.status === "proposed") return undefined;
  // Machine auto-accepts are not human labels (circular) unless opted in.
  if (!includeAutoAccepted && outcome.actor === AUTO_ACCEPT_ACTOR) return undefined;

  const candidateSet = candidateSetById.get(outcome.candidateSetId);
  if (candidateSet === undefined) return undefined;

  // The prediction is the SYSTEM-proposed candidate's confidence.
  const proposedId = candidateSet.selectedCandidateId;
  if (proposedId === undefined) return undefined;
  const proposed = candidateById.get(proposedId);
  if (proposed === undefined) return undefined;

  const extraction = proposed.extractionId ? extractionById.get(proposed.extractionId) : undefined;
  const rawConfidence = proposed.confidence ?? extraction?.confidence;
  if (rawConfidence === undefined || !Number.isFinite(rawConfidence)) return undefined;
  const predictedConfidence = clamp01(rawConfidence);

  const extractor = extraction?.extractor ?? "unknown";
  const field = extraction?.target ?? candidateSet.target;

  // The label: did the human affirm the proposed value?
  let correct: boolean;
  if (outcome.status === "rejected") {
    correct = false;
  } else {
    // verified | assumed — an override to a different candidate means the
    // proposed value did NOT stand.
    const overrode = outcome.candidateId !== undefined && outcome.candidateId !== proposedId;
    correct = !overrode;
  }

  return {
    extractor,
    field,
    predictedConfidence,
    correct,
    reviewOutcomeId: outcome.id,
    candidateSetId: outcome.candidateSetId,
    reviewedAt: outcome.reviewedAt,
  };
}

// ---------------------------------------------------------------------------
// Internal: group + bin computation
// ---------------------------------------------------------------------------

function computeGroup(
  extractor: string,
  field: string | undefined,
  samples: readonly CalibrationSample[],
  binCount: number,
  targetAccuracy: number,
  minBinSamples: number,
): CalibrationGroup {
  const sampleCount = samples.length;
  const correctCount = samples.filter((s) => s.correct).length;
  const empiricalAccuracy = sampleCount > 0 ? correctCount / sampleCount : undefined;
  const meanPredictedConfidence = sampleCount > 0
    ? samples.reduce((sum, s) => sum + s.predictedConfidence, 0) / sampleCount
    : undefined;
  const calibrationGap = meanPredictedConfidence !== undefined && empiricalAccuracy !== undefined
    ? meanPredictedConfidence - empiricalAccuracy
    : undefined;

  const bins = computeBins(samples, binCount);
  const suggestedThreshold = computeSuggestedThreshold(bins, targetAccuracy, minBinSamples);

  return {
    extractor,
    field,
    sampleCount,
    correctCount,
    empiricalAccuracy: round(empiricalAccuracy),
    meanPredictedConfidence: round(meanPredictedConfidence),
    calibrationGap: round(calibrationGap),
    bins,
    suggestedThreshold,
  };
}

function computeBins(samples: readonly CalibrationSample[], binCount: number): CalibrationBin[] {
  const width = 1 / binCount;
  const counts = Array.from({ length: binCount }, () => ({ n: 0, correct: 0, sum: 0 }));

  for (const s of samples) {
    const idx = Math.min(binCount - 1, Math.floor(s.predictedConfidence * binCount));
    const bucket = counts[idx]!;
    bucket.n++;
    bucket.sum += s.predictedConfidence;
    if (s.correct) bucket.correct++;
  }

  return counts.map((b, i) => ({
    lowerBound: round(i * width)!,
    upperBound: round((i + 1) * width)!,
    sampleCount: b.n,
    correctCount: b.correct,
    empiricalAccuracy: b.n > 0 ? round(b.correct / b.n) : undefined,
    meanPredictedConfidence: b.n > 0 ? round(b.sum / b.n) : undefined,
  }));
}

/**
 * The suggested threshold is the lowerBound of the lowest bin in the
 * top-contiguous run of bins that each (a) have ≥ minBinSamples and (b) meet
 * targetAccuracy. Scanning from the highest bin down, a populated bin that
 * fails the target — or an under-sampled bin we cannot vouch for — ends the run.
 * undefined when even the top populated bin does not qualify.
 */
function computeSuggestedThreshold(
  bins: readonly CalibrationBin[],
  targetAccuracy: number,
  minBinSamples: number,
): number | undefined {
  let threshold: number | undefined;
  for (let i = bins.length - 1; i >= 0; i--) {
    const bin = bins[i]!;
    if (bin.sampleCount < minBinSamples) break;
    if (bin.empiricalAccuracy === undefined || bin.empiricalAccuracy < targetAccuracy) break;
    threshold = bin.lowerBound;
  }
  return threshold;
}

// ---------------------------------------------------------------------------
// Claims projection (advisory — status "proposed")
// ---------------------------------------------------------------------------

/** A single projected calibration claim triple. */
export interface CalibrationClaim {
  readonly claim: Claim;
  readonly evidence: Evidence;
  readonly event: VerificationEvent;
}

export interface CalibrationClaimsSubject {
  /** Surface subject type (e.g. "extractor"). */
  readonly subjectType: string;
  /** Surface subject id prefix (e.g. a producer or run id). */
  readonly subjectId: string;
  /** Surface facet (e.g. "review.calibration"). */
  readonly facet: string;
  /** Actor id to record on events. */
  readonly actor: string;
  /** ISO 8601 timestamp for claim created/updated times. */
  readonly observedAt: string;
  /** Producer identifier for the evidence `collectedBy` field. */
  readonly collectedBy: string;
}

/**
 * Projects per-extractor calibration as Surface-ready claims (claimType
 * "calibration"). One claim per measurable metric per extractor: empirical
 * accuracy, calibration gap, and — when the data supports it — the suggested
 * auto-accept threshold. Every claim is status "proposed": calibration proposes,
 * it never decides (ADR 0003 §4). Groups with no labeled samples are skipped.
 */
export function calibrationToClaims(
  metrics: CalibrationMetrics,
  subject: CalibrationClaimsSubject,
): CalibrationClaim[] {
  const results: CalibrationClaim[] = [];

  for (const group of metrics.byExtractor) {
    if (group.sampleCount === 0) continue;
    const base = `${sanitize(group.extractor)}`;

    const push = (metric: string, value: number, detail: string): void => {
      const claimId = `calibration.${subject.subjectId}.${base}.${metric}`;
      const evidenceId = `${claimId}.evidence`;

      const claim: Claim = {
        id: claimId,
        subjectType: subject.subjectType,
        subjectId: `${subject.subjectId}.${group.extractor}`,
        facet: subject.facet,
        claimType: "calibration",
        fieldOrBehavior: metric,
        value,
        status: "proposed",
        createdAt: subject.observedAt,
        updatedAt: subject.observedAt,
        impactLevel: "medium",
        confidenceBasis: {
          sourceQuality: "moderate",
          reviewerAuthority: "none",
          evidenceStrength: "weak",
          impactLevel: "medium",
        },
        metadata: {
          calibration: {
            extractor: group.extractor,
            sampleCount: group.sampleCount,
            correctCount: group.correctCount,
            empiricalAccuracy: group.empiricalAccuracy,
            meanPredictedConfidence: group.meanPredictedConfidence,
            calibrationGap: group.calibrationGap,
            suggestedThreshold: group.suggestedThreshold,
            windowStart: metrics.windowStart,
            windowEnd: metrics.windowEnd,
            windowDays: metrics.windowDays,
          },
        },
      };

      const evidence: Evidence = {
        id: evidenceId,
        claimId,
        evidenceType: "attestation",
        method: "extraction",
        sourceRef: "calibration://computed",
        excerptOrSummary:
          `calibration.${metric} for extractor ${group.extractor}: ${detail}; ` +
          `over ${group.correctCount}/${group.sampleCount} affirmed human review outcomes`,
        observedAt: subject.observedAt,
        collectedBy: subject.collectedBy,
      };

      const event: VerificationEvent = {
        id: `${claimId}.event`,
        claimId,
        status: "proposed",
        actor: subject.actor,
        method: "candidate-proposal",
        evidenceIds: [evidenceId],
        createdAt: subject.observedAt,
      };

      results.push({ claim, evidence, event });
    };

    if (group.empiricalAccuracy !== undefined) {
      push("empiricalAccuracy", group.empiricalAccuracy, `empirical accuracy = ${group.empiricalAccuracy}`);
    }
    if (group.calibrationGap !== undefined) {
      push("calibrationGap", group.calibrationGap, `mean confidence − empirical accuracy = ${group.calibrationGap}`);
    }
    if (group.suggestedThreshold !== undefined) {
      push("suggestedThreshold", group.suggestedThreshold, `advisory auto-accept threshold = ${group.suggestedThreshold}`);
    }
  }

  return results;
}

/**
 * Merges calibration claims into an existing TrustBundle. Convenience wrapper
 * mirroring `mergeTrustBundleWithOversightMetrics`.
 */
export function mergeTrustBundleWithCalibration(
  bundle: TrustBundle,
  claims: readonly CalibrationClaim[],
): TrustBundle {
  return {
    ...bundle,
    claims: [...bundle.claims, ...claims.map((c) => c.claim)],
    evidence: [...bundle.evidence, ...claims.map((c) => c.evidence)],
    events: [...bundle.events, ...claims.map((c) => c.event)],
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pushTo<K>(map: Map<K, CalibrationSample[]>, key: K, sample: CalibrationSample): void {
  const existing = map.get(key);
  if (existing) existing.push(sample);
  else map.set(key, [sample]);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function normalizeBinCount(binCount: number | undefined): number {
  if (binCount === undefined) return DEFAULT_BIN_COUNT;
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new RangeError(`binCount must be a positive integer, received ${binCount}`);
  }
  return binCount;
}

function round(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.round(value * 10000) / 10000;
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}
