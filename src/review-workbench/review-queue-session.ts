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
}

export interface ReviewQueueSessionState {
  readonly items: readonly ReviewItem[];
  readonly activeItemName: string;
  readonly notesByItemName: Readonly<Record<string, string>>;
  readonly decisionsByItemName: Readonly<Record<string, ReviewWorkbenchDecision>>;
  readonly reviewedAt: string;
  readonly actorId: string;
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
    const data = { workbenchDecision: decision };

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
      const decision = workbenchDecisionFromEvent(event);
      return decision
        ? {
            ...session,
            decisionsByItemName: {
              ...session.decisionsByItemName,
              [event.spec.reviewItemName]: decision,
            },
          }
        : session;
    }

    return session;
  }, startState);
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
