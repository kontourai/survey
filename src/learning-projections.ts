import type { Candidate, CandidateSet, ClaimTarget, EscalationRecord, Extraction, ReviewOutcome, SurveyInput } from "./types.js";

export type LearningProjectionKind = "learning.comfort-zone" | "learning.escalation" | "learning.rejected-candidate" | "learning.could-not-confirm";

export type LearningProjectionSignal = "comfort-zone.outside" | "escalation.unresolved" | "rejected-candidate.reason" | "could-not-confirm.reason";

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
  const extractionsById = new Map(input.extractions.map((extraction) => [extraction.id, extraction]));
  const rejectedReviewsByCandidate = groupBy(
    input.reviewOutcomes.filter((reviewOutcome) => reviewOutcome.status === "rejected" && reviewOutcome.candidateId),
    (reviewOutcome) => `${reviewOutcome.candidateSetId}:${reviewOutcome.candidateId}`,
  );
  const projections: LearningProjection[] = [];

  for (const candidateSet of input.candidateSets) {
    for (const candidate of candidateSet.candidates) {
      const rejectedReviews = rejectedReviewsByCandidate.get(`${candidateSet.id}:${candidate.id}`) ?? [];
      const candidateReason = normalizeText(candidate.rejectionReason);
      const reviewOutcome = rejectedReviews[0];
      const reviewRationale = normalizeText(reviewOutcome?.rationale);
      const rejectionReason = candidateReason ?? reviewRationale;
      if (!rejectionReason) continue;

      const claim = claimsByCandidateSet.get(candidateSet.id)?.find((candidateSetClaim) => candidateSetClaim.candidateId === candidate.id);
      const extraction = extractionsById.get(candidate.extractionId);

      projections.push({
        id: `${candidateSet.id}.${candidate.id}.learning.rejected-candidate`,
        kind: "learning.rejected-candidate",
        source: input.source,
        createdAt: reviewOutcome?.reviewedAt ?? extraction?.extractedAt ?? input.generatedAt,
        target: candidateSet.target,
        claimId: claim?.id,
        reviewOutcomeId: reviewOutcome?.id,
        signal: "rejected-candidate.reason",
        severity: "info",
        summary: `Rejected candidate reason: ${rejectionReason}`,
        metadata: {
          rejectedCandidate: rejectedCandidateMetadata({
            candidateSet,
            candidate,
            extraction,
            reviewOutcome,
            claim,
            rejectionReason,
          }),
        },
      });
    }
  }

  for (const reviewOutcome of input.reviewOutcomes) {
    if (reviewOutcome.resolution === "could_not_confirm") {
      const target = candidateSetTargets.get(reviewOutcome.candidateSetId);
      const claim = findClaimForReview(claimsByCandidateSet.get(reviewOutcome.candidateSetId) ?? [], reviewOutcome);
      const resolutionReason = normalizeText(reviewOutcome.resolutionReason) ?? "(no reason recorded)";
      projections.push({
        id: `${reviewOutcome.id}.learning.could-not-confirm`,
        kind: "learning.could-not-confirm",
        source: input.source,
        createdAt: reviewOutcome.reviewedAt ?? input.generatedAt,
        target,
        claimId: claim?.id,
        reviewOutcomeId: reviewOutcome.id,
        signal: "could-not-confirm.reason",
        severity: "attention",
        summary: `Could not confirm: ${resolutionReason}`,
        metadata: {
          couldNotConfirm: {
            reason: resolutionReason,
            ...(reviewOutcome.attemptEvidenceIds?.length
              ? { attemptEvidenceIds: [...reviewOutcome.attemptEvidenceIds] }
              : {}),
          },
        },
      });
    }
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

function rejectedCandidateMetadata(input: {
  candidateSet: CandidateSet;
  candidate: Candidate;
  extraction?: Extraction;
  reviewOutcome?: ReviewOutcome;
  claim?: ClaimTarget;
  rejectionReason: string;
}): Record<string, unknown> {
  return {
    candidateId: input.candidate.id,
    candidateSetId: input.candidateSet.id,
    target: input.candidateSet.target,
    rejectionReason: input.rejectionReason,
    ...(input.reviewOutcome ? { reviewOutcomeId: input.reviewOutcome.id, reviewStatus: input.reviewOutcome.status } : {}),
    ...(input.claim ? { claimId: input.claim.id } : {}),
    ...(input.extraction ? { extractionId: input.extraction.id } : {}),
    ...(input.candidateSet.selectedCandidateId ? { selectedCandidateId: input.candidateSet.selectedCandidateId } : {}),
    ...(input.candidate.rejectionReason ? { candidateRejectionReason: input.candidate.rejectionReason } : {}),
    ...(input.reviewOutcome?.rationale ? { reviewRationale: input.reviewOutcome.rationale } : {}),
  };
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

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
