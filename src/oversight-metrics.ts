/**
 * Oversight-quality metrics for EU AI Act Art. 14 "effective oversight" / automation-bias evidence.
 *
 * These metrics are INDICATORS, not proof of reviewer cognition. See the Honest Limits section
 * in docs/record-contracts.md. Pace statistics can be gamed; metrics complement (not replace)
 * identity signing and authorizing provenance.
 *
 * All computations are deterministic with injected `now`.
 */

import type { Claim, Evidence, TrustBundle, VerificationEvent } from "@kontourai/surface";
import type { ReviewDecision } from "./review-resource.js";

// ---------------------------------------------------------------------------
// Per-reviewer metrics
// ---------------------------------------------------------------------------

export interface ReviewerOversightMetrics {
  /** Actor id this row belongs to. */
  readonly actorId: string;
  /** Total decisions made by this reviewer in the window. */
  readonly decisionCount: number;
  /**
   * Average decisions per hour, computed as decisionCount / elapsed hours between
   * the first and last reviewedAt timestamp (or 0 when decisionCount < 2).
   */
  readonly decisionsPerHour: number;
  /**
   * Fraction of decisions where the reviewer chose a candidate that differs from
   * the item's pre-selected (proposed) candidate — i.e. the reviewer changed the
   * outcome suggested by the system. Ranges 0–1.
   */
  readonly overrideRate: number;
  /**
   * Fraction of decisions where the authorizing block carries action === "typed",
   * indicating the reviewer also wrote a rationale note. Ranges 0–1.
   */
  readonly typedRationaleRate: number;
  /**
   * Median inter-decision gap in seconds.  Undefined when fewer than 2 decisions.
   */
  readonly medianInterDecisionSeconds: number | undefined;
  /**
   * Fraction of presented items that were decided, when the caller supplies
   * presentedCount. Omitted (undefined) otherwise.
   */
  readonly samplingCoverage: number | undefined;
}

// ---------------------------------------------------------------------------
// Aggregate metrics
// ---------------------------------------------------------------------------

export interface AggregateOversightMetrics {
  /** Total decisions across all reviewers. */
  readonly decisionCount: number;
  /**
   * Average decisions per hour across the full window (first decision to last
   * decision, all reviewers combined).
   */
  readonly decisionsPerHour: number;
  /** Override rate across all decisions. */
  readonly overrideRate: number;
  /** Typed-rationale rate across all decisions. */
  readonly typedRationaleRate: number;
  /** Median inter-decision gap in seconds across all decisions. */
  readonly medianInterDecisionSeconds: number | undefined;
  /**
   * Fraction of presented items decided, when presentedCount was supplied.
   * Omitted otherwise.
   */
  readonly samplingCoverage: number | undefined;
}

// ---------------------------------------------------------------------------
// Full metrics output
// ---------------------------------------------------------------------------

export interface OversightMetrics {
  /** One row per unique actorId found in the decisions. */
  readonly byReviewer: readonly ReviewerOversightMetrics[];
  /** Aggregate across all reviewers. */
  readonly aggregate: AggregateOversightMetrics;
  /** ISO 8601 timestamp of the earliest decision in the window. */
  readonly windowStart: string | undefined;
  /** ISO 8601 timestamp of the latest decision in the window. */
  readonly windowEnd: string | undefined;
  /** Number of calendar days covered by the window (may be fractional). */
  readonly windowDays: number | undefined;
  /** Number of input decisions used for these metrics. */
  readonly inputDecisionCount: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeriveOversightMetricsOptions {
  /** Current time — injected for determinism. */
  readonly now: Date;
  /**
   * Optional rolling window in days. Decisions older than `now - windowDays`
   * are excluded. When omitted all supplied decisions are included.
   */
  readonly windowDays?: number;
  /**
   * Optional total number of items that were PRESENTED to reviewers (the
   * denominator for samplingCoverage). When omitted, samplingCoverage is
   * not computed.
   */
  readonly presentedCount?: number;
}

// ---------------------------------------------------------------------------
// deriveOversightMetrics
// ---------------------------------------------------------------------------

/**
 * Derives per-reviewer and aggregate oversight-quality metrics from a stream
 * of ReviewDecision resources.
 *
 * @param decisions - Array of ReviewDecision Kubernetes-style resources as
 *   produced by the review workbench or adapters.
 * @param options - `now` is required for determinism; `windowDays` and
 *   `presentedCount` are optional.
 */
export function deriveOversightMetrics(
  decisions: readonly ReviewDecision[],
  options: DeriveOversightMetricsOptions,
): OversightMetrics {
  const cutoff = options.windowDays !== undefined
    ? new Date(options.now.getTime() - options.windowDays * 24 * 60 * 60 * 1000)
    : undefined;

  const windowed = cutoff
    ? decisions.filter((d) => {
        const t = d.spec.reviewedAt ? Date.parse(d.spec.reviewedAt) : NaN;
        return !isNaN(t) && t >= cutoff.getTime();
      })
    : [...decisions];

  const inputDecisionCount = windowed.length;

  if (inputDecisionCount === 0) {
    return {
      byReviewer: [],
      aggregate: {
        decisionCount: 0,
        decisionsPerHour: 0,
        overrideRate: 0,
        typedRationaleRate: 0,
        medianInterDecisionSeconds: undefined,
        samplingCoverage: options.presentedCount !== undefined ? 0 : undefined,
      },
      windowStart: undefined,
      windowEnd: undefined,
      windowDays: options.windowDays,
      inputDecisionCount: 0,
    };
  }

  // Group by actor
  const byActor = new Map<string, ReviewDecision[]>();
  for (const d of windowed) {
    const actor = d.spec.actor?.id ?? "unknown";
    const existing = byActor.get(actor) ?? [];
    byActor.set(actor, [...existing, d]);
  }

  // Compute timestamps for window bounds
  const allTimestamps = windowed
    .map((d) => d.spec.reviewedAt ? Date.parse(d.spec.reviewedAt) : NaN)
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b);

  const windowStart = allTimestamps.length > 0 ? new Date(allTimestamps[0]!).toISOString() : undefined;
  const windowEnd = allTimestamps.length > 0 ? new Date(allTimestamps[allTimestamps.length - 1]!).toISOString() : undefined;

  // Per-reviewer rows
  const byReviewer: ReviewerOversightMetrics[] = [];
  for (const [actorId, actorDecisions] of byActor) {
    byReviewer.push(computeReviewerMetrics(actorId, actorDecisions, options.presentedCount));
  }

  // Aggregate
  const aggregate = computeAggregateMetrics(windowed, allTimestamps, options.presentedCount);

  return {
    byReviewer,
    aggregate,
    windowStart,
    windowEnd,
    windowDays: options.windowDays,
    inputDecisionCount,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeReviewerMetrics(
  actorId: string,
  decisions: readonly ReviewDecision[],
  presentedCount: number | undefined,
): ReviewerOversightMetrics {
  const decisionCount = decisions.length;
  const timestamps = decisions
    .map((d) => d.spec.reviewedAt ? Date.parse(d.spec.reviewedAt) : NaN)
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b);

  const decisionsPerHour = computeDecisionsPerHour(decisionCount, timestamps);
  const overrideCount = decisions.filter(isOverrideDecision).length;
  const overrideRate = decisionCount > 0 ? overrideCount / decisionCount : 0;

  const typedCount = decisions.filter(isTypedRationale).length;
  const typedRationaleRate = decisionCount > 0 ? typedCount / decisionCount : 0;

  const medianInterDecisionSeconds = computeMedianInterDecisionSeconds(timestamps);

  const samplingCoverage = presentedCount !== undefined
    ? (presentedCount > 0 ? decisionCount / presentedCount : 0)
    : undefined;

  return {
    actorId,
    decisionCount,
    decisionsPerHour,
    overrideRate,
    typedRationaleRate,
    medianInterDecisionSeconds,
    samplingCoverage,
  };
}

function computeAggregateMetrics(
  decisions: readonly ReviewDecision[],
  sortedTimestamps: readonly number[],
  presentedCount: number | undefined,
): AggregateOversightMetrics {
  const decisionCount = decisions.length;
  const decisionsPerHour = computeDecisionsPerHour(decisionCount, sortedTimestamps);

  const overrideCount = decisions.filter(isOverrideDecision).length;
  const overrideRate = decisionCount > 0 ? overrideCount / decisionCount : 0;

  const typedCount = decisions.filter(isTypedRationale).length;
  const typedRationaleRate = decisionCount > 0 ? typedCount / decisionCount : 0;

  const medianInterDecisionSeconds = computeMedianInterDecisionSeconds(sortedTimestamps);

  const samplingCoverage = presentedCount !== undefined
    ? (presentedCount > 0 ? decisionCount / presentedCount : 0)
    : undefined;

  return {
    decisionCount,
    decisionsPerHour,
    overrideRate,
    typedRationaleRate,
    medianInterDecisionSeconds,
    samplingCoverage,
  };
}

/**
 * A decision is an "override" when the reviewer chose a candidate whose id
 * differs from the item's pre-selected (proposed) candidate.
 *
 * The item's proposed candidate id is carried in
 * `decision.spec.projection.candidateId` when set; if absent we fall back to
 * checking whether the decision status is "rejected" (reviewer rejected the
 * proposal entirely). When neither signal is available the decision is treated
 * as non-override to avoid false positives.
 */
function isOverrideDecision(decision: ReviewDecision): boolean {
  // "rejected" status always means the reviewer disagreed with the proposed value
  if (decision.spec.status === "rejected") {
    return true;
  }
  // If the decision carries a projection hint we can compare candidate ids.
  // The proposed/pre-selected candidate is carried as the projection candidateId
  // in ReviewDecision.spec.projection from the workbench accept-proposed path.
  // When the reviewer keeps-current, the projection candidateId is the current
  // candidate id, which differs from the proposed candidate — that counts as override.
  // We detect this by checking whether the candidateId on the decision spec
  // matches the projection candidateId and neither is undefined.
  const decisionCandidateId = decision.spec.candidateId;
  const projectionCandidateId = decision.spec.projection?.candidateId;
  if (decisionCandidateId && projectionCandidateId && decisionCandidateId !== projectionCandidateId) {
    return true;
  }
  return false;
}

/**
 * A decision carries a "typed" rationale when the authorizing block is an
 * `authorized-action` block with `action === "typed"`, indicating the reviewer
 * explicitly wrote a note.
 */
function isTypedRationale(decision: ReviewDecision): boolean {
  const auth = decision.spec.authorizing;
  return auth?.kind === "authorized-action" && auth.action === "typed";
}

function computeDecisionsPerHour(decisionCount: number, sortedTimestamps: readonly number[]): number {
  if (decisionCount < 2 || sortedTimestamps.length < 2) {
    return 0;
  }
  const first = sortedTimestamps[0]!;
  const last = sortedTimestamps[sortedTimestamps.length - 1]!;
  const elapsedHours = (last - first) / (1000 * 60 * 60);
  if (elapsedHours <= 0) {
    return 0;
  }
  return decisionCount / elapsedHours;
}

function computeMedianInterDecisionSeconds(sortedTimestamps: readonly number[]): number | undefined {
  if (sortedTimestamps.length < 2) {
    return undefined;
  }
  const gaps: number[] = [];
  for (let i = 1; i < sortedTimestamps.length; i++) {
    gaps.push((sortedTimestamps[i]! - sortedTimestamps[i - 1]!) / 1000);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0
    ? ((gaps[mid - 1]! + gaps[mid]!) / 2)
    : gaps[mid]!;
}

// ---------------------------------------------------------------------------
// Claims projection
// ---------------------------------------------------------------------------

/**
 * A single projected oversight-quality claim from the metrics layer.
 * Uses claimType "oversight-quality" per the task specification.
 */
export interface OversightQualityClaim {
  readonly claim: Claim;
  readonly evidence: Evidence;
  readonly event: VerificationEvent;
}

export interface OversightMetricsClaimsSubject {
  /** Surface subject type (e.g. "review-session", "reviewer-actor"). */
  readonly subjectType: string;
  /** Surface subject id (e.g. a session name or actor id). */
  readonly subjectId: string;
  /** Surface name (e.g. "review.oversight"). */
  readonly surface: string;
  /** Actor id to record on events. */
  readonly actor: string;
  /** ISO 8601 timestamp for claim created/updated times. */
  readonly observedAt: string;
  /** Producer identifier for collectedBy field. */
  readonly collectedBy: string;
}

/**
 * Projects oversight metrics as Surface-ready claims.
 *
 * Produces one claim per measurable metric in `aggregate` (per task spec: claimType
 * "oversight-quality", fieldOrBehavior per metric, numeric value). Evidence excerpts
 * summarise the computation inputs (count, window) so Annex-pack rules can apply value
 * predicates.
 *
 * Callers can pass these claims into buildSurveyTrustBundle by constructing a
 * minimal SurveyInput with manual-entry raw sources, or merge the returned Claim /
 * Evidence / VerificationEvent objects directly into an existing TrustBundle.
 *
 * @param metrics - Output of `deriveOversightMetrics`.
 * @param subject - Surface identity for the claims.
 */
export function oversightMetricsToClaims(
  metrics: OversightMetrics,
  subject: OversightMetricsClaimsSubject,
): OversightQualityClaim[] {
  const results: OversightQualityClaim[] = [];

  const windowDesc = metrics.windowStart && metrics.windowEnd
    ? `window ${metrics.windowStart} to ${metrics.windowEnd}`
    : "all available decisions";

  const inputSummary = `${metrics.inputDecisionCount} decisions, ${windowDesc}`;

  const push = (
    fieldOrBehavior: string,
    value: number,
    excerptDetail: string,
  ): void => {
    const claimId = `oversight-quality.${subject.subjectId}.${fieldOrBehavior}`;
    const evidenceId = `${claimId}.evidence`;

    const claim: Claim = {
      id: claimId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      surface: subject.surface,
      claimType: "oversight-quality",
      fieldOrBehavior,
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
        oversightMetrics: {
          inputDecisionCount: metrics.inputDecisionCount,
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
      sourceRef: "oversight-metrics://computed",
      excerptOrSummary: `oversight-quality.${fieldOrBehavior}: ${excerptDetail}; computed from ${inputSummary}`,
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

  const agg = metrics.aggregate;

  push("decisionCount", agg.decisionCount, `total decisions = ${agg.decisionCount}`);
  push("decisionsPerHour", roundTo(agg.decisionsPerHour, 4), `decisions/hr = ${roundTo(agg.decisionsPerHour, 4)}`);
  push("overrideRate", roundTo(agg.overrideRate, 4), `override rate = ${roundTo(agg.overrideRate, 4)} (${countFromRate(agg.overrideRate, agg.decisionCount)} of ${agg.decisionCount} decisions differed from proposed)`);
  push("typedRationaleRate", roundTo(agg.typedRationaleRate, 4), `typed rationale rate = ${roundTo(agg.typedRationaleRate, 4)} (${countFromRate(agg.typedRationaleRate, agg.decisionCount)} of ${agg.decisionCount} decisions had typed note)`);

  if (agg.medianInterDecisionSeconds !== undefined) {
    push("medianInterDecisionSeconds", roundTo(agg.medianInterDecisionSeconds, 2), `median gap between decisions = ${roundTo(agg.medianInterDecisionSeconds, 2)} s`);
  }

  if (agg.samplingCoverage !== undefined) {
    push("samplingCoverage", roundTo(agg.samplingCoverage, 4), `sampling coverage = ${roundTo(agg.samplingCoverage, 4)} (decided / presented)`);
  }

  return results;
}

/**
 * Merges oversight-quality claims into an existing TrustBundle.
 * Convenience wrapper for callers who already have a bundle and want to append
 * oversight metrics without rebuilding from SurveyInput.
 */
export function mergeTrustBundleWithOversightMetrics(
  bundle: TrustBundle,
  claims: readonly OversightQualityClaim[],
): TrustBundle {
  return {
    ...bundle,
    claims: [...bundle.claims, ...claims.map((c) => c.claim)],
    evidence: [...bundle.evidence, ...claims.map((c) => c.evidence)],
    events: [...bundle.events, ...claims.map((c) => c.event)],
  };
}

function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function countFromRate(rate: number, total: number): number {
  return Math.round(rate * total);
}
