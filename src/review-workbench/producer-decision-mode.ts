import type { ReviewDecisionMode, ReviewItem } from "../review-resource.js";
import type { ReviewWorkbenchResult } from "./review-workbench.js";

export type ReviewDecisionModeIssueCode =
  | "unknown-decision-mode"
  | "decision-not-allowed"
  | "candidate-not-in-item";

export interface ReviewDecisionModeIssue {
  readonly code: ReviewDecisionModeIssueCode;
  readonly message: string;
}

/**
 * The subset of a {@link ReviewWorkbenchResult} a decision-mode check inspects.
 */
export type ReviewDecisionModeResult = Pick<
  ReviewWorkbenchResult,
  "decision" | "selectedCandidateId" | "selectedCandidateRole"
>;

const KNOWN_DECISION_MODES: ReadonlySet<string> = new Set<ReviewDecisionMode>([
  "keep-current",
  "current-proposed",
  "free-select",
]);

/**
 * Validates a review result against the item's declared `producerPolicy.decisionMode`.
 *
 * Returns an empty array when the item declares no `producerPolicy` or no
 * `decisionMode` (the default, un-enforced posture). For a known mode it checks:
 *   `keep-current`     — only a `keep-current` decision is admissible.
 *   `current-proposed` — only the current or proposed candidate role may be selected.
 *   `free-select`      — the selected candidate must be one declared on the item.
 * An unrecognized `decisionMode` string fails closed with a single
 * `unknown-decision-mode` issue.
 */
export function validateReviewDecisionMode(
  item: ReviewItem,
  result: ReviewDecisionModeResult,
): ReviewDecisionModeIssue[] {
  const decisionMode = item.spec.producerPolicy?.decisionMode;
  if (decisionMode === undefined) {
    return [];
  }

  if (!KNOWN_DECISION_MODES.has(decisionMode)) {
    return [{
      code: "unknown-decision-mode",
      message: `ReviewItem ${item.metadata.name} declares an unrecognized producerPolicy.decisionMode '${String(decisionMode)}'.`,
    }];
  }

  if (decisionMode === "keep-current") {
    if (result.decision !== "keep-current") {
      return [{
        code: "decision-not-allowed",
        message: `ReviewItem ${item.metadata.name} declares decisionMode 'keep-current'; decision '${result.decision}' is not allowed.`,
      }];
    }
    return [];
  }

  if (decisionMode === "current-proposed") {
    if (result.selectedCandidateRole !== "current" && result.selectedCandidateRole !== "proposed") {
      return [{
        code: "decision-not-allowed",
        message: `ReviewItem ${item.metadata.name} declares decisionMode 'current-proposed'; selected candidate role '${result.selectedCandidateRole ?? "unknown"}' is not current or proposed.`,
      }];
    }
    return [];
  }

  // free-select: the selected candidate must be one declared on the item.
  if (!item.spec.candidates.some((candidate) => candidate.id === result.selectedCandidateId)) {
    return [{
      code: "candidate-not-in-item",
      message: `ReviewItem ${item.metadata.name} declares decisionMode 'free-select'; selected candidate '${result.selectedCandidateId}' is not declared on the item.`,
    }];
  }
  return [];
}

export class DecisionModeViolationError extends Error {
  readonly name = "DecisionModeViolationError";
  readonly issues: readonly ReviewDecisionModeIssue[];

  constructor(reviewItemName: string, issues: readonly ReviewDecisionModeIssue[]) {
    super(`ReviewItem ${reviewItemName} violates its declared producerPolicy.decisionMode: ${issues.map((issue) => issue.message).join(" ")}`);
    this.issues = issues;
  }
}

/**
 * Asserts a review result satisfies the item's declared decision mode, throwing
 * a {@link DecisionModeViolationError} otherwise. Mirrors the
 * validate-then-assert idiom in `review-authorizing.ts`.
 */
export function assertReviewDecisionModeAllows(
  item: ReviewItem,
  result: ReviewDecisionModeResult,
): void {
  const issues = validateReviewDecisionMode(item, result);
  if (issues.length > 0) {
    throw new DecisionModeViolationError(item.metadata.name, issues);
  }
}
