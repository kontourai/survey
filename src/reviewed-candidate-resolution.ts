import { candidateReviewRecord, type SurveyClaimRecord, type SurveyObservationInput } from "./builder.js";
import type { CandidateSet, ClaimTarget, ReviewOutcome } from "./types.js";

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
    observations: input.observations.map((observation) => ({
      ...observation,
      claim: {
        ...observation.claim,
        status: observation.claim.status ?? claimStatusForObservation(input, observation),
      },
    })),
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

function observationCandidateId(observation: SurveyObservationInput): string {
  return observation.candidate?.id ?? `${observation.id}.candidate`;
}

function candidateSetStatusForReview(status: ReviewOutcome["status"]): CandidateSet["status"] {
  if (status === "proposed") return "needs-review";
  return "resolved";
}
