import { facilityCredentialReviewItemExample } from "../../src/review-workbench/review-workbench-data.js";
import {
  deriveReviewSessionApplyResultForSnapshot,
  type ReviewQueueSessionState,
  type ReviewWorkbenchResult,
} from "../../src/review-workbench/review-workbench.js";
import type { ReviewSessionEvent } from "../../src/review-resource.js";

export interface FacilityCredentialRecord {
  readonly id: string;
  readonly credential: unknown;
  readonly appliedReviewItemNames: readonly string[];
}

export type FacilityCredentialApplyPreparation =
  | {
      readonly ok: true;
      readonly mutation: {
        readonly recordId: string;
        readonly credential: unknown;
        readonly reviewItemName: string;
        readonly selectedCandidateId: string;
        readonly actorId: string;
        readonly appliedAt: string;
      };
      readonly result: ReviewWorkbenchResult;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

export function prepareFacilityCredentialServerApply(input: {
  readonly currentRecord: FacilityCredentialRecord;
  readonly reviewSessionSnapshot: ReviewQueueSessionState;
  readonly events: readonly ReviewSessionEvent[];
  readonly actorId: string;
  readonly appliedAt: string;
}): FacilityCredentialApplyPreparation {
  const applyResult = deriveReviewSessionApplyResultForSnapshot({
    snapshot: input.reviewSessionSnapshot,
    events: input.events,
    requiredResolvedItems: "all",
  });

  if (!applyResult.ok) {
    return {
      ok: false,
      message: applyResult.issues.map((issue) => issue.message).join(" "),
    };
  }

  const [result] = applyResult.results;
  if (!result || applyResult.results.length !== 1) {
    return { ok: false, message: "Expected exactly one reviewed credential result." };
  }

  const item = input.reviewSessionSnapshot.items.find((candidate) => candidate.metadata.name === result.reviewItemName);
  if (!item || item.spec.target !== "operatingLicenseCredential") {
    return { ok: false, message: "Review result does not target the credential field." };
  }

  const currentCandidate = item.spec.candidates.find((candidate) => candidate.role === "current");
  if (!currentCandidate || JSON.stringify(currentCandidate.value) !== JSON.stringify(input.currentRecord.credential)) {
    return { ok: false, message: "Current credential no longer matches the review session snapshot." };
  }

  if (input.currentRecord.appliedReviewItemNames.includes(result.reviewItemName)) {
    return { ok: false, message: "Review result was already applied." };
  }

  return {
    ok: true,
    result,
    mutation: {
      recordId: input.currentRecord.id,
      credential: result.selectedValue,
      reviewItemName: result.reviewItemName,
      selectedCandidateId: result.selectedCandidateId,
      actorId: input.actorId,
      appliedAt: input.appliedAt,
    },
  };
}

export const facilityCredentialCurrentRecordExample: FacilityCredentialRecord = {
  id: "facility-credential-record-1",
  credential: facilityCredentialReviewItemExample.spec.candidates.find((candidate) => candidate.role === "current")?.value,
  appliedReviewItemNames: [],
};
