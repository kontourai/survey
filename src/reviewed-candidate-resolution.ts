import { candidateReviewRecord, type SurveyClaimRecord, type SurveyObservationInput } from "./builder.js";
import type { CandidateSet, ClaimTarget, ReviewOutcome } from "./types.js";
import { ReviewAgreementError } from "./to-surface.js";

export interface ReviewedCandidateResolutionInput {
  id: string;
  target: string;
  observations: SurveyObservationInput[];
  selectedCandidateId: string;
  rationale?: string;
  metadata?: Record<string, unknown>;
  status?: CandidateSet["status"];
  reviewOutcome: Omit<ReviewOutcome, "id" | "candidateSetId" | "candidateId"> & {
    id?: string;
    candidateId?: string;
  };
  selectedClaimStatus?: ClaimTarget["status"];
  unselectedClaimStatus?: ClaimTarget["status"];
}

export function reviewedCandidateResolution(input: ReviewedCandidateResolutionInput): SurveyClaimRecord[] {
  return candidateReviewRecord({
    id: input.id,
    target: input.target,
    selectedCandidateId: input.selectedCandidateId,
    status: input.status ?? candidateSetStatusForReview(input.reviewOutcome.status),
    rationale: input.rationale,
    metadata: input.metadata,
    reviewOutcome: {
      ...input.reviewOutcome,
      candidateId: input.reviewOutcome.candidateId ?? input.selectedCandidateId,
    },
    observations: input.observations.map((observation) => {
      const status = observation.claim.status ?? claimStatusForObservation(input, observation);
      if (observationCandidateId(observation) === input.selectedCandidateId) assertSelectedStatusAgrees(input, status);
      return { ...observation, claim: { ...observation.claim, status } };
    }),
  });
}

function claimStatusForObservation(
  input: ReviewedCandidateResolutionInput,
  observation: SurveyObservationInput,
): ClaimTarget["status"] {
  if (observationCandidateId(observation) === input.selectedCandidateId) {
    return input.selectedClaimStatus ?? input.reviewOutcome.status;
  }
  return input.unselectedClaimStatus ?? "superseded";
}

/** A trusted selected claim must carry the status its review decided. */
function assertSelectedStatusAgrees(input: ReviewedCandidateResolutionInput, status: ClaimTarget["status"]): void {
  if ((status === "verified" || status === "assumed") && status !== input.reviewOutcome.status) {
    throw new ReviewAgreementError(
      "status-mismatch",
      `Candidate set ${input.id} selected claim status ${status} disagrees with review outcome status ${input.reviewOutcome.status}`,
    );
  }
}

function observationCandidateId(observation: SurveyObservationInput): string {
  return observation.candidate?.id ?? `${observation.id}.candidate`;
}

function candidateSetStatusForReview(status: ReviewOutcome["status"]): CandidateSet["status"] {
  if (status === "proposed") return "needs-review";
  return "resolved";
}
