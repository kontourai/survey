import { publicDirectoryReviewItemExample, reviewWorkbenchQueueExamples } from "./review-workbench-data.js";
import {
  reviewResourceApiVersion,
  type ReviewCandidate,
  type ReviewDecision,
  type ReviewItem,
  type ReviewSession,
  type ReviewSessionEvent,
  type ReviewSessionEventSpec,
} from "../../src/review-resource.js";

export type ReviewWorkbenchDecision = "accept-proposed" | "keep-current" | "reject-proposed";
export type ReviewQueueRowStatus = "pending" | "in-review" | "resolved" | "rejected" | "escalated";

export const reviewWorkbenchSessionStorageKey = "kontourai.survey.review-workbench.session-events.v1";
export const defaultReviewSessionName = "review-workbench-session";

export interface ReviewWorkbenchState {
  readonly item: ReviewItem;
  readonly note: string;
  readonly decision?: ReviewWorkbenchDecision;
  readonly reviewedAt: string;
  readonly actorId: string;
  /**
   * Reviewer-edited override for the item's proposed value (inline edit in the
   * field-diff card). Additive/optional: undefined means no edit was made and the
   * proposed candidate's original value applies.
   */
  readonly editedValue?: unknown;
}

export interface ReviewQueueSessionState {
  readonly items: readonly ReviewItem[];
  readonly activeItemName: string;
  readonly notesByItemName: Readonly<Record<string, string>>;
  readonly decisionsByItemName: Readonly<Record<string, ReviewWorkbenchDecision>>;
  readonly reviewedAt: string;
  readonly actorId: string;
  /**
   * Reviewer-edited overrides for proposed values, keyed by ReviewItem name.
   * Additive/optional: a session built before this field existed behaves exactly
   * as before (every lookup resolves to undefined, meaning "use the candidate's
   * original value").
   */
  readonly editedValuesByItemName?: Readonly<Record<string, unknown>>;
}

export interface ReviewSessionSummary {
  readonly accepted: number;
  readonly keptCurrent: number;
  readonly rejected: number;
  readonly escalated: number;
  readonly unresolved: number;
}

interface DecisionDefinition {
  readonly label: string;
  readonly effect: string;
  readonly candidateRole: "current" | "proposed";
  readonly status: ReviewDecision["spec"]["status"];
}

export const workbenchDecisionDefinitions = {
  "accept-proposed": {
    label: "Accept proposed",
    effect: "Proposed value becomes the verified review outcome.",
    candidateRole: "proposed",
    status: "verified",
  },
  "keep-current": {
    label: "Keep current",
    effect: "Current value remains the verified review outcome.",
    candidateRole: "current",
    status: "verified",
  },
  "reject-proposed": {
    label: "Reject proposed",
    effect: "Proposed value is rejected and the current value remains unmodified.",
    candidateRole: "proposed",
    status: "rejected",
  },
} satisfies Record<ReviewWorkbenchDecision, DecisionDefinition>;

export function initialReviewWorkbenchState(item: ReviewItem = publicDirectoryReviewItemExample): ReviewWorkbenchState {
  return {
    item,
    note: "",
    decision: undefined,
    reviewedAt: "2026-06-04T00:00:00.000Z",
    actorId: "review-workbench-operator",
  };
}

export function initialReviewQueueSessionState(
  items: readonly ReviewItem[] = reviewWorkbenchQueueExamples,
): ReviewQueueSessionState {
  return {
    items,
    activeItemName: items[0]?.metadata.name ?? "",
    notesByItemName: {},
    decisionsByItemName: {},
    editedValuesByItemName: {},
    reviewedAt: "2026-06-04T00:00:00.000Z",
    actorId: "review-workbench-operator",
  };
}

export function currentReviewWorkbenchState(session: ReviewQueueSessionState): ReviewWorkbenchState {
  const item = currentReviewItem(session);

  return {
    item,
    note: session.notesByItemName[item.metadata.name] ?? "",
    decision: session.decisionsByItemName[item.metadata.name],
    editedValue: session.editedValuesByItemName?.[item.metadata.name],
    reviewedAt: session.reviewedAt,
    actorId: session.actorId,
  };
}

export function currentReviewItem(session: ReviewQueueSessionState): ReviewItem {
  const item = session.items.find((entry) => entry.metadata.name === session.activeItemName) ?? session.items[0];
  if (!item) {
    throw new Error("Review queue session has no ReviewItems.");
  }

  return item;
}

export function deriveQueueRowStatus(item: ReviewItem, session: ReviewQueueSessionState): ReviewQueueRowStatus {
  const decision = session.decisionsByItemName[item.metadata.name];
  if (decision === "reject-proposed") {
    return "rejected";
  }

  if (decision === "accept-proposed" || decision === "keep-current" || item.spec.candidateSetStatus === "resolved") {
    return "resolved";
  }

  if (item.spec.candidateSetStatus === "escalated") {
    return "escalated";
  }

  if (item.metadata.name === session.activeItemName) {
    return "in-review";
  }

  return "pending";
}

export function nextUnresolvedItemName(session: ReviewQueueSessionState): string | undefined {
  const activeIndex = session.items.findIndex((item) => item.metadata.name === session.activeItemName);
  const orderedItems = [
    ...session.items.slice(Math.max(activeIndex, 0) + 1),
    ...session.items.slice(0, Math.max(activeIndex, 0) + 1),
  ];

  return orderedItems.find((item) => deriveQueueRowStatus(item, session) === "pending")?.metadata.name;
}

export function reviewSessionSummary(session: ReviewQueueSessionState): ReviewSessionSummary {
  return session.items.reduce<ReviewSessionSummary>((summary, item) => {
    const decision = session.decisionsByItemName[item.metadata.name];
    if (decision === "accept-proposed") {
      return { ...summary, accepted: summary.accepted + 1 };
    }
    if (decision === "keep-current") {
      return { ...summary, keptCurrent: summary.keptCurrent + 1 };
    }
    if (decision === "reject-proposed") {
      return { ...summary, rejected: summary.rejected + 1 };
    }
    if (item.spec.candidateSetStatus === "escalated") {
      return { ...summary, escalated: summary.escalated + 1 };
    }
    if (item.spec.candidateSetStatus === "resolved") {
      return { ...summary, accepted: summary.accepted + 1 };
    }

    return { ...summary, unresolved: summary.unresolved + 1 };
  }, {
    accepted: 0,
    keptCurrent: 0,
    rejected: 0,
    escalated: 0,
    unresolved: 0,
  });
}

export function candidateForDecision(item: ReviewItem, decision: ReviewWorkbenchDecision): ReviewCandidate {
  const definition = workbenchDecisionDefinitions[decision];
  const candidate = item.spec.candidates.find((entry) => entry.role === definition.candidateRole);

  if (!candidate) {
    throw new Error(`ReviewItem ${item.metadata.name} has no ${definition.candidateRole} candidate.`);
  }

  return candidate;
}

/**
 * The value that should actually be applied for a decision: the reviewer's inline
 * edit when one was made for an accept-proposed decision, otherwise the selected
 * candidate's original value. Consumers reading `ReviewWorkbenchResult` should
 * prefer `effectiveValue`/`effectiveDisplayValue`, which are already computed with
 * this rule; this helper exists for callers deriving the value from raw session
 * state directly.
 */
export function effectiveValueForDecision(
  item: ReviewItem,
  decision: ReviewWorkbenchDecision,
  editedValue?: unknown,
): unknown {
  const candidate = candidateForDecision(item, decision);
  return decision === "accept-proposed" && editedValue !== undefined ? editedValue : candidate.value;
}

export function selectedCandidateRole(state: ReviewWorkbenchState): ReviewCandidate["role"] | undefined {
  if (!state.decision) {
    return undefined;
  }

  return workbenchDecisionDefinitions[state.decision].candidateRole;
}

export function buildReviewSessionResource(
  session: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[] = [],
  sessionName = defaultReviewSessionName,
): ReviewSession {
  const summary = reviewSessionSummary(session);
  const completedAt = summary.unresolved === 0 ? session.reviewedAt : undefined;

  return {
    apiVersion: reviewResourceApiVersion,
    kind: "ReviewSession",
    metadata: {
      name: sessionName,
    },
    spec: {
      reviewItemNames: session.items.map((item) => item.metadata.name),
      actor: {
        id: session.actorId,
      },
      startedAt: session.reviewedAt,
      completedAt,
    },
    status: {
      activeItemName: session.activeItemName,
      eventCount: events.length,
      decisionCount: Object.keys(session.decisionsByItemName).length,
    },
  };
}

export function buildReviewSessionEvents(
  session: ReviewQueueSessionState,
  sessionName = defaultReviewSessionName,
): ReviewSessionEvent[] {
  const events: ReviewSessionEvent[] = [
    buildReviewSessionEvent(session, {
      sessionName,
      sequence: 1,
      eventType: "session-started",
      occurredAt: session.reviewedAt,
    }),
    buildReviewSessionEvent(session, {
      sessionName,
      sequence: 2,
      eventType: "item-selected",
      occurredAt: session.reviewedAt,
      activeItemName: session.activeItemName,
      reviewItemName: session.activeItemName,
    }),
  ];

  for (const item of session.items) {
    const note = session.notesByItemName[item.metadata.name];
    if (note) {
      events.push(buildReviewSessionEvent(session, {
        sessionName,
        sequence: events.length + 1,
        eventType: "note-changed",
        occurredAt: session.reviewedAt,
        reviewItemName: item.metadata.name,
        rationale: note,
      }));
    }

    const decision = session.decisionsByItemName[item.metadata.name];
    if (!decision) {
      continue;
    }

    const candidate = candidateForDecision(item, decision);
    const definition = workbenchDecisionDefinitions[decision];
    const reviewDecisionName = `${item.metadata.name}-${decision}`;
    // Carry the reviewer's inline edit in the event itself (accept-proposed
    // only — it is the sole decision where an edited value is meaningful), so
    // that replaying snapshot + events reconstructs editedValuesByItemName and
    // the server apply boundary derives effectiveValue from it. Without this
    // the edit lives only in browser state and never survives replay.
    const editedValue = decision === "accept-proposed" ? session.editedValuesByItemName?.[item.metadata.name] : undefined;
    const data: Record<string, unknown> = editedValue !== undefined
      ? { workbenchDecision: decision, workbenchEditedValue: editedValue }
      : { workbenchDecision: decision };

    events.push(buildReviewSessionEvent(session, {
      sessionName,
      sequence: events.length + 1,
      eventType: "decision-changed",
      occurredAt: session.reviewedAt,
      reviewItemName: item.metadata.name,
      reviewDecisionName,
      candidateId: candidate.id,
      status: definition.status,
      data,
    }));
    events.push(buildReviewSessionEvent(session, {
      sessionName,
      sequence: events.length + 1,
      eventType: "decision-submitted",
      occurredAt: session.reviewedAt,
      reviewItemName: item.metadata.name,
      reviewDecisionName,
      candidateId: candidate.id,
      status: definition.status,
      rationale: note,
      data,
    }));
  }

  if (reviewSessionSummary(session).unresolved === 0) {
    events.push(buildReviewSessionEvent(session, {
      sessionName,
      sequence: events.length + 1,
      eventType: "session-completed",
      occurredAt: session.reviewedAt,
    }));
  }

  return events;
}

export function replayReviewSessionEvents(
  startState: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[],
): ReviewQueueSessionState {
  const sortedEvents = [...events].sort((left, right) => left.spec.sequence - right.spec.sequence);

  return sortedEvents.reduce<ReviewQueueSessionState>((session, event) => {
    if (event.spec.eventType === "item-selected") {
      const activeItemName = event.spec.activeItemName ?? event.spec.reviewItemName;
      return activeItemName && session.items.some((item) => item.metadata.name === activeItemName)
        ? { ...session, activeItemName }
        : session;
    }

    if (event.spec.eventType === "note-changed" && event.spec.reviewItemName) {
      return {
        ...session,
        notesByItemName: {
          ...session.notesByItemName,
          [event.spec.reviewItemName]: event.spec.rationale ?? "",
        },
      };
    }

    if ((event.spec.eventType === "decision-changed" || event.spec.eventType === "decision-submitted")
      && event.spec.reviewItemName) {
      const itemName = event.spec.reviewItemName;
      if (isClearedWorkbenchDecisionEvent(event)) {
        const { [itemName]: _removedDecision, ...remainingDecisions } = session.decisionsByItemName;
        const { [itemName]: _removedEdit, ...remainingEdits } = session.editedValuesByItemName ?? {};
        return { ...session, decisionsByItemName: remainingDecisions, editedValuesByItemName: remainingEdits };
      }

      const decision = workbenchDecisionFromEvent(event);
      if (!decision) {
        return session;
      }
      // Restore the inline edit the event carried (accept-proposed only); any
      // other decision, or an accept with no carried edit, clears a stale edit
      // for this item so effectiveValue can't fall back to an edit the
      // reviewer moved away from.
      const editedValue = workbenchEditedValueFromEvent(event);
      const editedValuesByItemName = { ...session.editedValuesByItemName };
      if (decision === "accept-proposed" && editedValue !== undefined) {
        editedValuesByItemName[itemName] = editedValue;
      } else {
        delete editedValuesByItemName[itemName];
      }
      return {
        ...session,
        decisionsByItemName: {
          ...session.decisionsByItemName,
          [itemName]: decision,
        },
        editedValuesByItemName,
      };
    }

    return session;
  }, startState);
}

/**
 * Extracts a decision event's carried inline edit, or `undefined` when the
 * event carries none. The edit rides `data.workbenchEditedValue`.
 */
function workbenchEditedValueFromEvent(event: ReviewSessionEvent): unknown {
  return event.spec.data && "workbenchEditedValue" in event.spec.data
    ? event.spec.data.workbenchEditedValue
    : undefined;
}

/**
 * Detects the explicit "clear this ReviewItem's decision" replay signal (emitted
 * by the workbench's "Change" / undo control): a decision event whose
 * `data.workbenchDecision` is the literal `null` sentinel, as opposed to `undefined`
 * (no decision info present — event is ignored by replay, same as before this
 * feature existed).
 */
export function isClearedWorkbenchDecisionEvent(event: ReviewSessionEvent): boolean {
  return event.spec.data !== undefined
    && "workbenchDecision" in event.spec.data
    && event.spec.data.workbenchDecision === null;
}

export function buildReviewSessionEvent(
  session: ReviewQueueSessionState,
  spec: Omit<ReviewSessionEventSpec, "actor">,
): ReviewSessionEvent {
  return {
    apiVersion: reviewResourceApiVersion,
    kind: "ReviewSessionEvent",
    metadata: {
      name: `${spec.sessionName}-${String(spec.sequence).padStart(4, "0")}-${spec.eventType}`,
    },
    spec: {
      ...spec,
      actor: {
        id: session.actorId,
      },
    },
  };
}

function workbenchDecisionFromEvent(event: ReviewSessionEvent): ReviewWorkbenchDecision | undefined {
  const decision = event.spec.data?.workbenchDecision;
  return typeof decision === "string" && decision in workbenchDecisionDefinitions
    ? decision as ReviewWorkbenchDecision
    : undefined;
}
