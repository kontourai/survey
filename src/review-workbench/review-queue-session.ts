import { publicDirectoryReviewItemExample, reviewWorkbenchQueueExamples } from "./review-workbench-data.js";
import { assertReviewResolutionConsistency } from "../producer-discipline.js";
import { checkEditedValueForItem } from "./edited-value.js";
import {
  assertSoleCandidateId,
  reviewResourceApiVersion,
  type ReviewCandidate,
  type ReviewDecision,
  type ReviewItem,
  type ReviewSession,
  type ReviewSessionEvent,
  type ReviewSessionEventSpec,
} from "../../src/review-resource.js";

/**
 * The decisions a reviewer can record on a ReviewItem.
 *
 * `select-proposed` chooses one value of a conflict (two or more `proposed`
 * candidates) by candidate id, which the state carries beside the decision
 * (`selectedCandidateId` / `selectedCandidateIdsByItemName`). It is its own
 * kind rather than `accept-proposed` with an id so that the record always says
 * a rival was seen and not chosen, and `accept-proposed` keeps its meaning:
 * accept the one proposed value, refused on a conflict.
 */
export type ReviewWorkbenchDecision = "accept-proposed" | "select-proposed" | "keep-current" | "reject-proposed" | "could-not-confirm";
export type ReviewQueueRowStatus = "pending" | "in-review" | "resolved" | "rejected" | "could-not-confirm" | "escalated";

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
  readonly attemptEvidenceIds?: readonly string[];
  /**
   * The candidate a `select-proposed` decision chose. Required for that
   * decision and ignored for every other one.
   */
  readonly selectedCandidateId?: string;
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
  readonly attemptEvidenceIdsByItemName?: Readonly<Record<string, readonly string[]>>;
  /**
   * The candidate each `select-proposed` decision chose, keyed by ReviewItem
   * name. Additive/optional: sessions stored before this field existed have no
   * `select-proposed` decision and never read it.
   */
  readonly selectedCandidateIdsByItemName?: Readonly<Record<string, string>>;
}

export interface ReviewSessionSummary {
  readonly accepted: number;
  readonly keptCurrent: number;
  readonly rejected: number;
  readonly couldNotConfirm?: number;
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
  "select-proposed": {
    label: "Use this value",
    effect: "The chosen value becomes the verified review outcome; the other proposed values were seen and not chosen.",
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
  "could-not-confirm": {
    label: "Could not confirm",
    effect: "The review round ends without changing or escalating the proposed claim.",
    candidateRole: "proposed",
    status: "proposed",
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
    attemptEvidenceIds: session.attemptEvidenceIdsByItemName?.[item.metadata.name],
    selectedCandidateId: session.selectedCandidateIdsByItemName?.[item.metadata.name],
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
  if (decision === "could-not-confirm") {
    return "could-not-confirm";
  }

  if (decision === "accept-proposed" || decision === "select-proposed" || decision === "keep-current" || item.spec.candidateSetStatus === "resolved") {
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
    if (decision === "accept-proposed" || decision === "select-proposed") {
      return { ...summary, accepted: summary.accepted + 1 };
    }
    if (decision === "keep-current") {
      return { ...summary, keptCurrent: summary.keptCurrent + 1 };
    }
    if (decision === "reject-proposed") {
      return { ...summary, rejected: summary.rejected + 1 };
    }
    if (decision === "could-not-confirm") {
      return { ...summary, couldNotConfirm: (summary.couldNotConfirm ?? 0) + 1 };
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

/**
 * The decision the field card's "keep" control records for a ReviewItem, or
 * `undefined` when the item cannot represent that action at all.
 *
 * Every workbench decision resolves to a candidate role (see
 * {@link workbenchDecisionDefinitions}), so a decision whose role the item does
 * not carry is not recordable — `keep-current` on an item that has no `current`
 * candidate is the case that matters, because that is exactly how an
 * envelope-imported item is modelled (one `proposed` candidate, nothing prior).
 * The card already labels that control "Leave unset" rather than "Keep current";
 * this returns the decision that means the same thing and IS representable:
 * `reject-proposed` — the proposed value is not applied and nothing is set.
 *
 * Deliberately NOT solved by synthesising an empty `current` candidate: that
 * would invent a prior value, with provenance, that the source never had.
 */
export function keepActionDecision(item: ReviewItem, flaggedWrong: boolean): ReviewWorkbenchDecision | undefined {
  // Keeping the current value is recordable only when exactly one candidate is
  // current (see candidateForDecision); rejecting the proposed values is
  // recordable however many there are.
  const count = (role: ReviewCandidate["role"]): number =>
    item.spec.candidates.filter((candidate) => candidate.role === role).length;

  if (flaggedWrong || count("current") === 0) {
    return count("proposed") > 0 ? "reject-proposed" : undefined;
  }

  return count("current") === 1 ? "keep-current" : undefined;
}

/**
 * Decisions that make no candidate the trusted value: rejecting the proposed
 * values and ending the round as could-not-confirm. On an item whose role holds
 * several candidates (conflicting values for one claim) they select none of them.
 */
const VALUE_NEUTRAL_DECISIONS: ReadonlySet<ReviewWorkbenchDecision> = new Set(["reject-proposed", "could-not-confirm"]);

/**
 * The candidate a workbench decision applies to.
 *
 * Selection is by role, so the role has to name exactly one candidate before a
 * decision may trust it. Guarding the render path alone let the workbench emit
 * an undecidable decision through the export path and then present a different
 * candidate's value against it; this is the shared selector all of those go
 * through, which is why the check belongs here rather than at each of them.
 *
 * A decision that would make one of several candidates in its role the trusted
 * value is refused: picking the first would settle the conflict for the
 * reviewer without showing it. A value-neutral decision (reject, could not
 * confirm) on such an item selects none of them. It still returns the first
 * candidate so in-process callers that need one candidate (rendering, the
 * in-memory `ReviewWorkbenchResult`) have one, but that anchor is not recorded:
 * {@link decisionCandidateId} is `undefined` for it, so the decision, its
 * session events and the canonical projection name no candidate.
 */
export function candidateForDecision(
  item: ReviewItem,
  decision: ReviewWorkbenchDecision,
  selectedCandidateId?: string,
): ReviewCandidate {
  if (decision === "select-proposed") {
    const issue = conflictSelectionIssue(item, selectedCandidateId);
    if (issue) {
      throw new Error(issue);
    }
    return item.spec.candidates.find((entry) => entry.id === selectedCandidateId)!;
  }
  const definition = workbenchDecisionDefinitions[decision];
  const matches = item.spec.candidates.filter((entry) => entry.role === definition.candidateRole);
  const candidate = matches[0];

  if (!candidate) {
    throw new Error(`ReviewItem ${item.metadata.name} has no ${definition.candidateRole} candidate.`);
  }
  if (matches.length > 1 && !VALUE_NEUTRAL_DECISIONS.has(decision)) {
    throw new Error(`ReviewItem ${item.metadata.name} has ${matches.length} ${definition.candidateRole} candidates; the ${decision} decision cannot choose between them.`);
  }
  assertSoleCandidateId(item, candidate.id);

  return candidate;
}

/**
 * Why a `select-proposed` decision naming `candidateId` cannot be recorded on
 * this item, or `undefined` when it can.
 *
 * The choice must name, by a unique id, one of the item's `proposed`
 * candidates, and the item must hold at least two of them: choosing "over a
 * rival" on an item with no rival would record a conflict that never existed
 * (use `accept-proposed` there). Proposals excluded at import are not
 * candidates, so they can never be chosen.
 */
export function conflictSelectionIssue(item: ReviewItem, candidateId: string | undefined): string | undefined {
  const proposed = item.spec.candidates.filter((entry) => entry.role === "proposed");
  if (proposed.length < 2) {
    return `ReviewItem ${item.metadata.name} has ${proposed.length} proposed candidate${proposed.length === 1 ? "" : "s"}; select-proposed chooses between conflicting proposed values, so it needs at least two.`;
  }
  if (!candidateId) {
    return `ReviewItem ${item.metadata.name}: select-proposed must name the chosen candidate id.`;
  }
  const matches = item.spec.candidates.filter((entry) => entry.id === candidateId);
  if (matches.length === 0) {
    return `ReviewItem ${item.metadata.name} has no candidate ${candidateId}; select-proposed can only choose one of its proposed candidates.`;
  }
  if (matches.length > 1) {
    return `ReviewItem ${item.metadata.name} has ${matches.length} candidates with id ${candidateId}; candidate ids must be unique.`;
  }
  if (matches[0]!.role !== "proposed") {
    return `ReviewItem ${item.metadata.name} candidate ${candidateId} has role ${matches[0]!.role ?? "none"}; select-proposed can only choose a proposed candidate.`;
  }
  return undefined;
}

/**
 * The proposed candidates a `select-proposed` decision saw and did not choose,
 * in item order. Empty for every other decision.
 */
export function unchosenProposedCandidates(
  item: ReviewItem,
  decision: ReviewWorkbenchDecision,
  selectedCandidateId: string | undefined,
): ReviewCandidate[] {
  return decision === "select-proposed"
    ? item.spec.candidates.filter((entry) => entry.role === "proposed" && entry.id !== selectedCandidateId)
    : [];
}

/** Whether a decision on this item selects no candidate at all (see {@link candidateForDecision}). */
export function decisionSelectsNoCandidate(item: ReviewItem, decision: ReviewWorkbenchDecision): boolean {
  const role = workbenchDecisionDefinitions[decision].candidateRole;
  return VALUE_NEUTRAL_DECISIONS.has(decision) && item.spec.candidates.filter((entry) => entry.role === role).length > 1;
}

/**
 * The candidate id a decision records: the selected candidate's, or
 * `undefined` when the decision selects no candidate.
 */
export function decisionCandidateId(item: ReviewItem, decision: ReviewWorkbenchDecision, selectedCandidateId?: string): string | undefined {
  const candidate = candidateForDecision(item, decision, selectedCandidateId);
  return decisionSelectsNoCandidate(item, decision) ? undefined : candidate.id;
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
  selectedCandidateId?: string,
): unknown {
  const candidate = candidateForDecision(item, decision, selectedCandidateId);
  return decision === "accept-proposed" && editedValue !== undefined ? editedValue : candidate.value;
}

export function selectedCandidateRole(state: ReviewWorkbenchState): ReviewCandidate["role"] | undefined {
  if (!state.decision) {
    return undefined;
  }

  return workbenchDecisionDefinitions[state.decision].candidateRole;
}

function canonicalizeJsonResource<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Review session resources must be JSON-serializable.");
  }
  return JSON.parse(serialized) as T;
}

export function buildReviewSessionResource(
  session: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[] = [],
  sessionName = defaultReviewSessionName,
): ReviewSession {
  const summary = reviewSessionSummary(session);
  const completedAt = summary.unresolved === 0 ? session.reviewedAt : undefined;

  return canonicalizeJsonResource({
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
  });
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
    if (decision === "could-not-confirm" && !note?.trim()) {
      throw new Error(`ReviewItem ${item.metadata.name} could not confirm requires a non-empty reason.`);
    }

    const candidateId = decisionCandidateId(item, decision, session.selectedCandidateIdsByItemName?.[item.metadata.name]);
    const definition = workbenchDecisionDefinitions[decision];
    const reviewDecisionName = `${item.metadata.name}-${decision}`;
    // Carry the reviewer's inline edit in the event itself (accept-proposed
    // only — it is the sole decision where an edited value is meaningful), so
    // that replaying snapshot + events reconstructs editedValuesByItemName and
    // the server apply boundary derives effectiveValue from it. Without this
    // the edit lives only in browser state and never survives replay.
    const editedValue = decision === "accept-proposed" ? session.editedValuesByItemName?.[item.metadata.name] : undefined;
    const attemptEvidenceIds = decision === "could-not-confirm"
      ? session.attemptEvidenceIdsByItemName?.[item.metadata.name]
      : undefined;
    assertReviewResolutionConsistency(`ReviewItem ${item.metadata.name}`, {
      status: definition.status,
      resolution: decision === "could-not-confirm" ? "could_not_confirm" : undefined,
      resolutionReason: decision === "could-not-confirm" ? note : undefined,
      attemptEvidenceIds,
      actor: session.actorId,
      reviewedAt: session.reviewedAt,
    });
    const data: Record<string, unknown> = editedValue !== undefined
      ? { workbenchDecision: decision, workbenchEditedValue: editedValue }
      : { workbenchDecision: decision, ...(attemptEvidenceIds?.length ? { attemptEvidenceIds } : {}) };

    events.push(buildReviewSessionEvent(session, {
      sessionName,
      sequence: events.length + 1,
      eventType: "decision-changed",
      occurredAt: session.reviewedAt,
      reviewItemName: item.metadata.name,
      reviewDecisionName,
      ...(candidateId !== undefined ? { candidateId } : {}),
      status: definition.status,
      ...(decision === "could-not-confirm"
        ? {
            resolution: "could_not_confirm" as const,
            resolutionReason: note,
            ...(attemptEvidenceIds ? { attemptEvidenceIds: [...attemptEvidenceIds] } : {}),
          }
        : {}),
      data,
    }));
    events.push(buildReviewSessionEvent(session, {
      sessionName,
      sequence: events.length + 1,
      eventType: "decision-submitted",
      occurredAt: session.reviewedAt,
      reviewItemName: item.metadata.name,
      reviewDecisionName,
      ...(candidateId !== undefined ? { candidateId } : {}),
      status: definition.status,
      rationale: note,
      ...(decision === "could-not-confirm"
        ? {
            resolution: "could_not_confirm" as const,
            resolutionReason: note,
            ...(attemptEvidenceIds ? { attemptEvidenceIds: [...attemptEvidenceIds] } : {}),
          }
        : {}),
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
        const { [itemName]: _removedAttempts, ...remainingAttempts } = session.attemptEvidenceIdsByItemName ?? {};
        const { [itemName]: _removedSelection, ...remainingSelections } = session.selectedCandidateIdsByItemName ?? {};
        return {
          ...session,
          decisionsByItemName: remainingDecisions,
          editedValuesByItemName: remainingEdits,
          attemptEvidenceIdsByItemName: remainingAttempts,
          ...(session.selectedCandidateIdsByItemName ? { selectedCandidateIdsByItemName: remainingSelections } : {}),
        };
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
      const attemptEvidenceIdsByItemName = { ...session.attemptEvidenceIdsByItemName };
      if (decision === "accept-proposed" && editedValue !== undefined) {
        // Legacy sessions stored typed edits as editor text ("42"); store the
        // descriptor-typed value so effectiveValue is 42. An edit the item does
        // not allow is left as carried: validated replay refuses it before this
        // point (kontourai/survey#278).
        const item = session.items.find((entry) => entry.metadata.name === itemName);
        const check = item ? checkEditedValueForItem(item, editedValue) : undefined;
        editedValuesByItemName[itemName] = check?.ok ? check.value : editedValue;
      } else {
        delete editedValuesByItemName[itemName];
      }
      if (decision === "could-not-confirm" && event.spec.attemptEvidenceIds?.length) {
        attemptEvidenceIdsByItemName[itemName] = [...event.spec.attemptEvidenceIds];
      } else {
        delete attemptEvidenceIdsByItemName[itemName];
      }
      // A choice between conflicting values is the event's candidateId: that
      // id is the authority for select-proposed (validated replay checks it).
      const selectedCandidateIdsByItemName = { ...session.selectedCandidateIdsByItemName };
      if (decision === "select-proposed" && event.spec.candidateId) {
        selectedCandidateIdsByItemName[itemName] = event.spec.candidateId;
      } else {
        delete selectedCandidateIdsByItemName[itemName];
      }
      return {
        ...session,
        decisionsByItemName: {
          ...session.decisionsByItemName,
          [itemName]: decision,
        },
        editedValuesByItemName,
        attemptEvidenceIdsByItemName,
        ...(session.selectedCandidateIdsByItemName || decision === "select-proposed" ? { selectedCandidateIdsByItemName } : {}),
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
  return canonicalizeJsonResource({
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
  });
}

function workbenchDecisionFromEvent(event: ReviewSessionEvent): ReviewWorkbenchDecision | undefined {
  const decision = event.spec.data?.workbenchDecision;
  return typeof decision === "string" && decision in workbenchDecisionDefinitions
    ? decision as ReviewWorkbenchDecision
    : undefined;
}
