import type { TrustStatus } from "@kontourai/surface";

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
  actor?: string;
  reviewedAt?: string;
}

export function assertReviewOutcomeDiscipline(input: {
  /** Message subject, e.g. `Claim ${id}` or `Source-of-authority observation ${id}` —
   *  each call site supplies its own noun so error text is unchanged. */
  subject: string;
  status: TrustStatus | undefined;
  review?: ReviewOutcomePosture;
}): void {
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
