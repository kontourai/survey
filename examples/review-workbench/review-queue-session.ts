import { publicDirectoryReviewItemFixture, reviewWorkbenchQueueFixtures } from "./review-workbench-data.js";
import { type ReviewCandidate, type ReviewDecision, type ReviewItem } from "../../src/review-resource.js";

export type ReviewWorkbenchDecision = "accept-proposed" | "keep-current" | "reject-proposed";
export type ReviewQueueRowStatus = "pending" | "in-review" | "resolved" | "rejected" | "escalated";

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

export function initialReviewWorkbenchState(item: ReviewItem = publicDirectoryReviewItemFixture): ReviewWorkbenchState {
  return {
    item,
    note: "",
    decision: undefined,
    reviewedAt: "2026-06-04T00:00:00.000Z",
    actorId: "review-workbench-operator",
  };
}

export function initialReviewQueueSessionState(
  items: readonly ReviewItem[] = reviewWorkbenchQueueFixtures,
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
