import type { ClaimTarget, EscalationRecord, ReviewOutcome, SurveyInput } from "./types.js";

export type LearningProjectionKind = "learning.comfort-zone" | "learning.escalation";

export type LearningProjectionSignal = "comfort-zone.outside" | "escalation.unresolved";

export type LearningProjectionSeverity = "info" | "attention";

export interface LearningProjection {
  id: string;
  kind: LearningProjectionKind;
  source: string;
  createdAt: string;
  target?: string;
  claimId?: string;
  reviewOutcomeId?: string;
  escalationId?: string;
  signal: LearningProjectionSignal;
  severity?: LearningProjectionSeverity;
  summary: string;
  metadata?: Record<string, unknown>;
}

export function buildSurveyLearningProjections(input: SurveyInput): LearningProjection[] {
  const claimsByCandidateSet = groupBy(input.claims, (claim) => claim.candidateSetId);
  const candidateSetTargets = new Map(input.candidateSets.map((candidateSet) => [candidateSet.id, candidateSet.target]));
  const projections: LearningProjection[] = [];

  for (const reviewOutcome of input.reviewOutcomes) {
    if (reviewOutcome.withinComfortZone !== false) continue;

    const target = candidateSetTargets.get(reviewOutcome.candidateSetId);
    const claim = findClaimForReview(claimsByCandidateSet.get(reviewOutcome.candidateSetId) ?? [], reviewOutcome);
    const note = reviewOutcome.comfortZoneNote;

    projections.push({
      id: `${reviewOutcome.id}.learning.comfort-zone`,
      kind: "learning.comfort-zone",
      source: input.source,
      createdAt: reviewOutcome.reviewedAt ?? input.generatedAt,
      target,
      claimId: claim?.id,
      reviewOutcomeId: reviewOutcome.id,
      signal: "comfort-zone.outside",
      severity: "attention",
      summary: note ? `Review outcome is outside comfort zone: ${note}` : "Review outcome is outside comfort zone.",
      metadata: {
        comfortZone: {
          withinComfortZone: false,
          ...(note ? { note } : {}),
        },
      },
    });
  }

  for (const escalation of input.escalations ?? []) {
    if (escalation.resolvedBy) continue;

    projections.push({
      id: `${escalation.id}.learning.escalation`,
      kind: "learning.escalation",
      source: input.source,
      createdAt: escalation.raisedAt,
      target: escalation.target,
      claimId: escalation.attachToClaimId,
      escalationId: escalation.id,
      signal: "escalation.unresolved",
      severity: "attention",
      summary: `Unresolved ${escalation.dimension} escalation: ${escalation.reason}`,
      metadata: {
        escalation: unresolvedEscalationMetadata(escalation),
      },
    });
  }

  return projections;
}

function findClaimForReview(claims: ClaimTarget[], reviewOutcome: ReviewOutcome): ClaimTarget | undefined {
  if (reviewOutcome.candidateId) {
    return claims.find((claim) => claim.candidateId === reviewOutcome.candidateId);
  }
  return claims[0];
}

function unresolvedEscalationMetadata(escalation: EscalationRecord): Record<string, unknown> {
  return {
    id: escalation.id,
    target: escalation.target,
    dimension: escalation.dimension,
    reason: escalation.reason,
    raisedBy: escalation.raisedBy,
    raisedAt: escalation.raisedAt,
    ...(escalation.attachToClaimId ? { attachToClaimId: escalation.attachToClaimId } : {}),
    resolved: false,
    ...(escalation.metadata ? { metadata: escalation.metadata } : {}),
  };
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}
