import type { TrustStatus } from "@kontourai/surface";
import type { CandidateSetStatus, ReviewResolution } from "./types.js";

/**
 * Producer Discipline core — CONTEXT.md "Producer Discipline" /
 * "Source-of-Authority Observation".
 *
 * The one piece of the review-discipline rule proven identical, field by
 * field, across both existing enforcement points (2026-07 exploration):
 *   - src/to-surface.ts's assertProducerDiscipline (verified/assumed claims)
 *   - src/source-of-authority-observation.ts's assertVerifiedPosture
 *     (verified/assumed source-of-authority observations)
 * Both require, in the same relative order, when status is "verified" or
 * "assumed": (1) a review outcome exists, (2) it has a reviewer (actor),
 * (3) it has a reviewedAt time — with identical error text modulo the
 * subject noun ("Claim X" vs. "Source-of-authority observation X"), which
 * each call site supplies.
 *
 * The two sites' SOURCE LOCATOR requirements are NOT identical (to-surface
 * gates on rawSource.kind !== "manual-entry" regardless of status;
 * source-of-authority-observation gates on status verified/assumed
 * regardless of rawSource.kind, with no manual-entry exemption), and
 * source-of-authority-observation has an additional sourceRef check
 * to-surface does not have. Both stay call-site-local — this module does
 * not decide them.
 *
 * Module-internal seam (like src/producer-profile.ts): consumed by
 * relative import from src/to-surface.ts and
 * src/source-of-authority-observation.ts, NOT re-exported from
 * src/index.ts.
 */

export interface ReviewOutcomePosture {
  status?: TrustStatus;
  actor?: string;
  reviewedAt?: string;
  resolution?: ReviewResolution;
  resolutionReason?: string;
  attemptEvidenceIds?: readonly string[];
}

/** Explicit review resolutions refine (but may not contradict) status:
 * accepted -> verified/assumed; rejected -> rejected; held -> any non-rejected
 * pre-existing posture; could_not_confirm -> proposed/assumed with reviewer,
 * time, and reason. */
export function assertReviewResolutionConsistency(subject: string, review: ReviewOutcomePosture): void {
  if (review.resolution === undefined) return;

  const statusAllowed = review.resolution === "accepted"
    ? review.status === "verified" || review.status === "assumed"
    : review.resolution === "rejected"
      ? review.status === "rejected"
      : review.resolution === "held"
        ? review.status === "verified" || review.status === "assumed" || review.status === "proposed"
        : review.status === "proposed" || review.status === "assumed";
  if (!statusAllowed) {
    throw new Error(`${subject} review resolution ${review.resolution} cannot use status ${review.status ?? "undefined"}`);
  }

  if (review.resolution !== "could_not_confirm") return;
  if (!review.resolutionReason?.trim()) {
    throw new Error(`${subject} review resolution could_not_confirm requires a non-empty resolutionReason`);
  }
  if (!review.actor?.trim()) {
    throw new Error(`${subject} review resolution could_not_confirm requires a review actor`);
  }
  if (!review.reviewedAt?.trim()) {
    throw new Error(`${subject} review resolution could_not_confirm requires reviewedAt`);
  }
}

export function assertReviewOutcomeDiscipline(input: {
  /** Message subject, e.g. `Claim ${id}` or `Source-of-authority observation ${id}` —
   *  each call site supplies its own noun so error text is unchanged. */
  subject: string;
  status: TrustStatus | undefined;
  review?: ReviewOutcomePosture;
  /** Candidate-set conflict/escalation is an independent pre-review posture.
   * A could-not-confirm round must preserve it as disputed, never downgrade it. */
  candidateSetStatus?: CandidateSetStatus;
}): void {
  if (input.review) {
    assertReviewResolutionConsistency(input.subject, input.review);
  }
  if (
    input.review?.resolution === "could_not_confirm"
    && (input.status === "verified" || input.status === "rejected")
  ) {
    throw new Error(`${input.subject} review resolution could_not_confirm cannot use status ${input.status}`);
  }
  if (
    input.review?.resolution === "could_not_confirm"
    && (input.candidateSetStatus === "conflict" || input.candidateSetStatus === "escalated")
    && input.status !== "disputed"
  ) {
    throw new Error(`${input.subject} review resolution could_not_confirm cannot mask ${input.candidateSetStatus} as ${input.status}`);
  }
  if (input.status !== "verified" && input.status !== "assumed") return;
  if (!input.review) {
    throw new Error(`${input.subject} cannot be ${input.status} without a review outcome`);
  }
  if (!input.review.actor) {
    throw new Error(`${input.subject} cannot be ${input.status} without review actor authority`);
  }
  if (!input.review.reviewedAt) {
    throw new Error(`${input.subject} cannot be ${input.status} without reviewedAt`);
  }
}
