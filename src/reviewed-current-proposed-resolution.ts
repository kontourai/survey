import { reviewedCandidateResolution, type ReviewedCandidateResolutionInput } from "./reviewed-candidate-resolution.js";
import type { SurveyClaimRecord, SurveyObservationInput } from "./builder.js";

export type CurrentProposedCandidateRole = "current" | "proposed";

export interface ReviewedCurrentProposedResolutionInput
  extends Omit<ReviewedCandidateResolutionInput, "observations" | "selectedCandidateId"> {
  currentObservation: SurveyObservationInput;
  proposedObservation: SurveyObservationInput;
  selectedCandidateRole: CurrentProposedCandidateRole;
  selectedClaimId?: string;
}

export function reviewedCurrentProposedResolution(
  input: ReviewedCurrentProposedResolutionInput,
): SurveyClaimRecord[] {
  const currentCandidateId = candidateIdFor(input, "current", input.currentObservation);
  const proposedCandidateId = candidateIdFor(input, "proposed", input.proposedObservation);
  const selectedCandidateId = input.selectedCandidateRole === "current"
    ? currentCandidateId
    : proposedCandidateId;

  return reviewedCandidateResolution({
    ...input,
    selectedCandidateId,
    observations: [
      observationForRole({
        input,
        role: "current",
        candidateId: currentCandidateId,
        observation: input.currentObservation,
      }),
      observationForRole({
        input,
        role: "proposed",
        candidateId: proposedCandidateId,
        observation: input.proposedObservation,
      }),
    ],
  });
}

function observationForRole(input: {
  input: ReviewedCurrentProposedResolutionInput;
  role: CurrentProposedCandidateRole;
  candidateId: string;
  observation: SurveyObservationInput;
}): SurveyObservationInput {
  const selected = input.input.selectedCandidateRole === input.role;

  return {
    ...input.observation,
    candidate: {
      ...input.observation.candidate,
      id: input.candidateId,
      metadata: {
        ...input.observation.candidate?.metadata,
        candidateRole: input.role,
      },
    },
    claim: {
      ...input.observation.claim,
      id: selected && input.input.selectedClaimId
        ? input.input.selectedClaimId
        : input.observation.claim.id,
    },
  };
}

function candidateIdFor(
  input: ReviewedCurrentProposedResolutionInput,
  role: CurrentProposedCandidateRole,
  observation: SurveyObservationInput,
): string {
  return observation.candidate?.id ?? `${input.id}.${role}.candidate`;
}
