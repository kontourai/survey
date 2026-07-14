import type { ReviewSessionEvent } from "../review-resource.js";
import {
  candidateForDecision,
  isClearedWorkbenchDecisionEvent,
  workbenchDecisionDefinitions,
  type ReviewQueueSessionState,
  type ReviewWorkbenchDecision,
} from "./review-queue-session.js";

export type ReviewSessionReplayIssueCode =
  | "invalid-sequence"
  | "duplicate-sequence"
  | "non-contiguous-sequence"
  | "unknown-active-item"
  | "unknown-review-item"
  | "unknown-candidate"
  | "missing-review-item"
  | "invalid-workbench-decision"
  | "decision-candidate-mismatch"
  | "decision-status-mismatch";

export interface ReviewSessionReplayIssue {
  readonly code: ReviewSessionReplayIssueCode;
  readonly eventName: string;
  readonly sequence: number;
  readonly reviewItemName?: string;
  readonly candidateId?: string;
  readonly message: string;
}

export function validateReviewSessionEventsForSnapshot(
  snapshot: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[],
): ReviewSessionReplayIssue[] {
  const itemsByName = new Map(snapshot.items.map((item) => [item.metadata.name, item]));
  const sequenceIssues = validateEventSequence(events);

  const replayIssues = events.flatMap((event) => {
    const issues: ReviewSessionReplayIssue[] = [];
    const activeItemName = event.spec.activeItemName;
    const reviewItemName = event.spec.reviewItemName;
    const itemName = reviewItemName ?? activeItemName;
    const eventRef = {
      eventName: event.metadata.name,
      sequence: event.spec.sequence,
    };

    if (activeItemName && !itemsByName.has(activeItemName)) {
      issues.push({
        ...eventRef,
        code: "unknown-active-item",
        reviewItemName: activeItemName,
        message: `ReviewSessionEvent ${event.metadata.name} references active item ${activeItemName}, but the supplied session snapshot does not contain that ReviewItem.`,
      });
    }

    if (reviewItemName && !itemsByName.has(reviewItemName)) {
      issues.push({
        ...eventRef,
        code: "unknown-review-item",
        reviewItemName,
        message: `ReviewSessionEvent ${event.metadata.name} references review item ${reviewItemName}, but the supplied session snapshot does not contain that ReviewItem.`,
      });
    }

    if ((event.spec.eventType === "decision-changed" || event.spec.eventType === "decision-submitted")
      && !reviewItemName) {
      issues.push({
        ...eventRef,
        code: "missing-review-item",
        message: `ReviewSessionEvent ${event.metadata.name} is a decision event but does not reference a ReviewItem.`,
      });
    }

    if ((event.spec.eventType === "decision-changed" || event.spec.eventType === "decision-submitted")
      && isClearedWorkbenchDecisionEvent(event)) {
      // Explicit "clear this ReviewItem's decision" signal (undo). No candidate/status
      // expectations apply — the event carries no selected candidate.
    } else if (event.spec.eventType === "decision-changed" || event.spec.eventType === "decision-submitted") {
      const decision = replayableWorkbenchDecision(event.spec.data?.workbenchDecision);
      if (!decision) {
        issues.push({
          ...eventRef,
          code: "invalid-workbench-decision",
          reviewItemName,
          candidateId: event.spec.candidateId,
          message: `ReviewSessionEvent ${event.metadata.name} is a decision event but does not include a replayable workbench decision.`,
        });
      } else if (itemName && itemsByName.has(itemName)) {
        const item = itemsByName.get(itemName);
        const expectedCandidate = item ? candidateForDecision(item, decision) : undefined;
        const expectedStatus = workbenchDecisionDefinitions[decision].status;

        const referencedCandidateExists = event.spec.candidateId
          ? item?.spec.candidates.some((candidate) => candidate.id === event.spec.candidateId)
          : false;

        if (expectedCandidate && (!event.spec.candidateId || referencedCandidateExists) && event.spec.candidateId !== expectedCandidate.id) {
          issues.push({
            ...eventRef,
            code: "decision-candidate-mismatch",
            reviewItemName: itemName,
            candidateId: event.spec.candidateId,
            message: `ReviewSessionEvent ${event.metadata.name} decision ${decision} expects candidate ${expectedCandidate.id}, but references ${event.spec.candidateId ?? "no candidate"}.`,
          });
        }

        if (event.spec.status !== expectedStatus) {
          issues.push({
            ...eventRef,
            code: "decision-status-mismatch",
            reviewItemName: itemName,
            candidateId: event.spec.candidateId,
            message: `ReviewSessionEvent ${event.metadata.name} decision ${decision} expects status ${expectedStatus}, but references ${event.spec.status ?? "no status"}.`,
          });
        }
      }
    }

    if (event.spec.candidateId && itemName && itemsByName.has(itemName)) {
      const item = itemsByName.get(itemName);
      const hasCandidate = item?.spec.candidates.some((candidate) => candidate.id === event.spec.candidateId);
      if (!hasCandidate) {
        issues.push({
          ...eventRef,
          code: "unknown-candidate",
          reviewItemName: itemName,
          candidateId: event.spec.candidateId,
          message: `ReviewSessionEvent ${event.metadata.name} references candidate ${event.spec.candidateId}, but ReviewItem ${itemName} in the supplied session snapshot does not contain that candidate.`,
        });
      }
    }

    return issues;
  });

  return [...sequenceIssues, ...replayIssues];
}

function replayableWorkbenchDecision(value: unknown): ReviewWorkbenchDecision | undefined {
  return typeof value === "string" && value in workbenchDecisionDefinitions
    ? value as ReviewWorkbenchDecision
    : undefined;
}

function validateEventSequence(events: readonly ReviewSessionEvent[]): ReviewSessionReplayIssue[] {
  const issues: ReviewSessionReplayIssue[] = [];
  const seen = new Map<number, string>();

  events.forEach((event, index) => {
    const sequence = event.spec.sequence;
    const eventRef = {
      eventName: event.metadata.name,
      sequence,
    };

    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      issues.push({
        ...eventRef,
        code: "invalid-sequence",
        message: `ReviewSessionEvent ${event.metadata.name} has invalid sequence ${String(sequence)}. Sequences must be positive safe integers.`,
      });
      return;
    }

    const duplicateOf = seen.get(sequence);
    if (duplicateOf) {
      issues.push({
        ...eventRef,
        code: "duplicate-sequence",
        message: `ReviewSessionEvent ${event.metadata.name} reuses sequence ${sequence} from ${duplicateOf}.`,
      });
    } else {
      seen.set(sequence, event.metadata.name);
    }

    const expected = index + 1;
    if (sequence !== expected) {
      issues.push({
        ...eventRef,
        code: "non-contiguous-sequence",
        message: `ReviewSessionEvent ${event.metadata.name} has sequence ${sequence}, but canonical event streams must be ordered and contiguous from 1; expected ${expected}.`,
      });
    }
  });

  return issues;
}
