import type { ReviewSessionEvent } from "../review-resource.js";
import {
  candidateForDecision,
  decisionSelectsNoCandidate,
  isClearedWorkbenchDecisionEvent,
  workbenchDecisionDefinitions,
  type ReviewQueueSessionState,
  type ReviewWorkbenchDecision,
} from "./review-queue-session.js";
import { checkEditedValueForItem } from "./edited-value.js";

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
  | "decision-status-mismatch"
  | "decision-resolution-mismatch"
  | "missing-resolution-reason"
  | "edited-value-not-editable"
  | "edited-value-type-mismatch";

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

  const finalDecisionEvents = finalDecisionEventPerItem(events);
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
        // A decision that selects no candidate must reference none.
        const expectedCandidateId = item && !decisionSelectsNoCandidate(item, decision) ? expectedCandidate?.id : undefined;
        const expectedStatus = workbenchDecisionDefinitions[decision].status;

        const referencedCandidateExists = event.spec.candidateId
          ? item?.spec.candidates.some((candidate) => candidate.id === event.spec.candidateId)
          : false;

        if (expectedCandidate && (!event.spec.candidateId || referencedCandidateExists) && event.spec.candidateId !== expectedCandidateId) {
          issues.push({
            ...eventRef,
            code: "decision-candidate-mismatch",
            reviewItemName: itemName,
            candidateId: event.spec.candidateId,
            message: `ReviewSessionEvent ${event.metadata.name} decision ${decision} expects ${expectedCandidateId ? `candidate ${expectedCandidateId}` : "no candidate"}, but references ${event.spec.candidateId ?? "no candidate"}.`,
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

        const expectedResolution = decision === "could-not-confirm" ? "could_not_confirm" : undefined;
        if (event.spec.resolution !== expectedResolution) {
          issues.push({
            ...eventRef,
            code: "decision-resolution-mismatch",
            reviewItemName: itemName,
            candidateId: event.spec.candidateId,
            message: `ReviewSessionEvent ${event.metadata.name} decision ${decision} expects resolution ${expectedResolution ?? "none"}, but references ${event.spec.resolution ?? "no resolution"}.`,
          });
        }
        const editedValue = editedValueFromDecisionEvent(event);
        // Only the item's final decision decides its effectiveValue, so only an
        // edit on that event is refused. An edit a later decision superseded is
        // reported as a warning instead of failing the whole session.
        if (item && decision === "accept-proposed" && editedValue !== undefined && finalDecisionEvents.has(event)) {
          const check = checkEditedValueForItem(item, editedValue);
          if (!check.ok) {
            issues.push({
              ...eventRef,
              code: check.code,
              reviewItemName: itemName,
              candidateId: event.spec.candidateId,
              message: `ReviewSessionEvent ${event.metadata.name}: ${check.message}`,
            });
          }
        }
        if (decision === "could-not-confirm" && !event.spec.resolutionReason?.trim()) {
          issues.push({
            ...eventRef,
            code: "missing-resolution-reason",
            reviewItemName: itemName,
            candidateId: event.spec.candidateId,
            message: `ReviewSessionEvent ${event.metadata.name} decision could-not-confirm requires a non-empty resolutionReason.`,
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

/**
 * A ReviewSessionEvent whose `data.workbenchEditedValue` was rewritten from
 * legacy editor text to its descriptor-typed value during replay (see
 * checkEditedValueForItem). Not an error: the apply result still succeeds, and
 * the warning lets a consumer see that a saved session was normalized.
 */
export type ReviewSessionReplayWarning =
  | {
      readonly code: "edited-value-converted-from-text";
      readonly eventName: string;
      readonly sequence: number;
      readonly reviewItemName: string;
      readonly originalValue: string;
      readonly convertedValue: unknown;
      readonly message: string;
    }
  | {
      /**
       * An edit that would be refused (see checkEditedValueForItem) on a
       * decision event that a later decision for the same item superseded. It
       * never reaches effectiveValue, so it does not fail the session.
       */
      readonly code: "superseded-edited-value-refused";
      readonly eventName: string;
      readonly sequence: number;
      readonly reviewItemName: string;
      readonly refusedCode: "edited-value-not-editable" | "edited-value-type-mismatch";
      readonly editedValue: unknown;
      readonly message: string;
    };

/**
 * Lists the legacy text edits replay converts to typed values, and refused
 * edits that a later decision superseded. Call it only on an event stream that
 * validateReviewSessionEventsForSnapshot accepted.
 */
export function reviewSessionReplayWarningsForSnapshot(
  snapshot: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[],
): ReviewSessionReplayWarning[] {
  const itemsByName = new Map(snapshot.items.map((item) => [item.metadata.name, item]));
  const finalDecisionEvents = finalDecisionEventPerItem(events);
  return events.flatMap((event): ReviewSessionReplayWarning[] => {
    const itemName = event.spec.reviewItemName;
    const item = itemName ? itemsByName.get(itemName) : undefined;
    const editedValue = editedValueFromDecisionEvent(event);
    if (!item || !itemName || editedValue === undefined
      || replayableWorkbenchDecision(event.spec.data?.workbenchDecision) !== "accept-proposed") {
      return [];
    }
    const check = checkEditedValueForItem(item, editedValue);
    if (!check.ok) {
      return finalDecisionEvents.has(event) ? [] : [{
        code: "superseded-edited-value-refused" as const,
        eventName: event.metadata.name,
        sequence: event.spec.sequence,
        reviewItemName: itemName,
        refusedCode: check.code,
        editedValue,
        message: `ReviewSessionEvent ${event.metadata.name} carries an edit a later decision superseded, which would be refused: ${check.message}`,
      }];
    }
    if (!check.convertedFromText || typeof editedValue !== "string") {
      return [];
    }
    return [{
      code: "edited-value-converted-from-text" as const,
      eventName: event.metadata.name,
      sequence: event.spec.sequence,
      reviewItemName: itemName,
      originalValue: editedValue,
      convertedValue: check.value,
      message: `ReviewSessionEvent ${event.metadata.name} stores edited value ${JSON.stringify(editedValue)} as text; replay converted it to ${JSON.stringify(check.value)} per ReviewItem ${itemName}'s value descriptor.`,
    }];
  });
}

/** The last decision event (by sequence, as replay applies them) for each ReviewItem. */
function finalDecisionEventPerItem(events: readonly ReviewSessionEvent[]): Set<ReviewSessionEvent> {
  const lastByItem = new Map<string, ReviewSessionEvent>();
  for (const event of [...events].sort((left, right) => left.spec.sequence - right.spec.sequence)) {
    if ((event.spec.eventType === "decision-changed" || event.spec.eventType === "decision-submitted")
      && event.spec.reviewItemName) {
      lastByItem.set(event.spec.reviewItemName, event);
    }
  }
  return new Set(lastByItem.values());
}

function editedValueFromDecisionEvent(event: ReviewSessionEvent): unknown {
  return (event.spec.eventType === "decision-changed" || event.spec.eventType === "decision-submitted")
    && event.spec.data && "workbenchEditedValue" in event.spec.data
    ? event.spec.data.workbenchEditedValue
    : undefined;
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
