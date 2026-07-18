import { canonicalJson } from "./canonical.js";
import { assertReviewResolutionConsistency } from "../producer-discipline.js";
import {
  candidateForDecision,
  buildReviewSessionEvent,
  buildReviewSessionEvents,
  buildReviewSessionResource,
  currentReviewItem,
  currentReviewWorkbenchState,
  defaultReviewSessionName,
  deriveQueueRowStatus,
  effectiveValueForDecision,
  initialReviewQueueSessionState,
  initialReviewWorkbenchState,
  nextUnresolvedItemName,
  replayReviewSessionEvents,
  reviewSessionSummary,
  reviewWorkbenchSessionStorageKey,
  selectedCandidateRole,
  workbenchDecisionDefinitions,
  type ReviewQueueSessionState,
  type ReviewWorkbenchDecision,
  type ReviewWorkbenchState,
} from "./review-queue-session.js";
import {
  validateReviewSessionEventsForSnapshot,
  type ReviewSessionReplayIssue,
} from "./review-session-replay.js";
import {
  buildSurfaceProjectionPreview,
  formatValue,
  type SurfaceProjectionPreview,
} from "./review-surface-preview.js";
import {
  buildReviewCandidatePresentation,
  buildReviewItemPresentation,
  type ReviewPresentationAdapter,
} from "./review-presentation.js";
import {
  reviewResourceApiVersion,
  type ReviewCandidate,
  type ReviewDecision,
  type ReviewItem,
  type ReviewSession,
  type ReviewSessionEvent,
  type ReviewValueDescriptor,
} from "../review-resource.js";
import { validateAuthorizing, buildAuthorizedActionAuthorizing } from "../review-authorizing.js";
import { humanizeIdentifier } from "./review-presentation.js";

export {
  buildReviewSessionEvents,
  buildReviewSessionEvent,
  buildReviewSessionResource,
  candidateForDecision,
  currentReviewItem,
  currentReviewWorkbenchState,
  defaultReviewSessionName,
  deriveQueueRowStatus,
  initialReviewQueueSessionState,
  initialReviewWorkbenchState,
  nextUnresolvedItemName,
  replayReviewSessionEvents,
  reviewSessionSummary,
  reviewWorkbenchSessionStorageKey,
  selectedCandidateRole,
  workbenchDecisionDefinitions,
  type ReviewQueueRowStatus,
  type ReviewQueueSessionState,
  type ReviewSessionSummary,
  type ReviewWorkbenchDecision,
  type ReviewWorkbenchState,
} from "./review-queue-session.js";
export {
  buildReviewCandidatePresentation,
  buildReviewItemPresentation,
  buildReviewResultPresentation,
  humanizeIdentifier,
  type ReviewCandidatePresentation,
  type ReviewCandidatePresentationContext,
  type ReviewItemPresentation,
  type ReviewItemPresentationContext,
  type ReviewPresentationAdapter,
  type ReviewPresentationLink,
  type ReviewResultPresentation,
  type ReviewTracePresentationContext,
  type ReviewTraceRef,
  type ReviewValuePresentationContext,
} from "./review-presentation.js";
export {
  buildSurfaceProjectionPreview,
  type PreviewAuthorityTrace,
  type PreviewCandidateHistory,
  type PreviewClaim,
  type PreviewIntegrityPosture,
  type PreviewReviewEvent,
  type PreviewSourceAuthority,
  type PreviewSourceEvidence,
  type SurfaceProjectionPreview,
} from "./review-surface-preview.js";
export {
  validateReviewSessionEventsForSnapshot,
  type ReviewSessionReplayIssue,
  type ReviewSessionReplayIssueCode,
} from "./review-session-replay.js";
export {
  assertReviewDecisionModeAllows,
  DecisionModeViolationError,
  validateReviewDecisionMode,
  type ReviewDecisionModeIssue,
  type ReviewDecisionModeIssueCode,
  type ReviewDecisionModeResult,
} from "./producer-decision-mode.js";

export function buildReviewDecision(state: ReviewWorkbenchState): ReviewDecision | undefined {
  if (!state.decision) {
    return undefined;
  }

  const definition = workbenchDecisionDefinitions[state.decision];
  if (state.decision === "could-not-confirm" && !state.note.trim()) {
    throw new Error("Could not confirm requires a non-empty reason.");
  }
  const candidate = candidateForDecision(state.item, state.decision);
  const projection = {
    ...candidate.projection,
    reviewOutcomeId: candidate.projection?.reviewOutcomeId
      ?? `${state.item.metadata.name}:${state.decision}:review-outcome`,
  };

  const reviewDecision: ReviewDecision = {
    apiVersion: reviewResourceApiVersion,
    kind: "ReviewDecision",
    metadata: {
      name: `${state.item.metadata.name}-${state.decision}`,
      labels: state.item.metadata.labels,
      producer: state.item.metadata.producer,
    },
    spec: {
      reviewItemName: state.item.metadata.name,
      candidateId: candidate.id,
      status: definition.status,
      ...(state.decision === "could-not-confirm"
        ? {
            resolution: "could_not_confirm" as const,
            resolutionReason: state.note.trim(),
            ...(state.attemptEvidenceIds?.length ? { attemptEvidenceIds: [...state.attemptEvidenceIds] } : {}),
          }
        : {}),
      actor: {
        id: state.actorId,
      },
      reviewedAt: state.reviewedAt,
      rationale: state.note,
      authorizing: buildDecisionCardAuthorizing(state),
      projection,
      editedValue: state.decision === "accept-proposed" ? state.editedValue : undefined,
    },
    status: {
      appliedToClaimIds: candidate.projection?.claimId ? [candidate.projection.claimId] : undefined,
    },
  };
  assertReviewResolutionConsistency(`ReviewDecision ${reviewDecision.metadata.name}`, {
    status: reviewDecision.spec.status,
    resolution: reviewDecision.spec.resolution,
    resolutionReason: reviewDecision.spec.resolutionReason,
    attemptEvidenceIds: reviewDecision.spec.attemptEvidenceIds,
    actor: reviewDecision.spec.actor?.id,
    reviewedAt: reviewDecision.spec.reviewedAt,
  });
  return reviewDecision;
}

/**
 * Stable versioned prompt identifier for the workbench decision card control.
 * Derived from the component naming convention: <module>/<component>@<version>.
 */
const DECISION_CARD_PROMPT_REF = "review-workbench/decision-card@v1";

/**
 * Constructs the `authorized-action` authorizing block for a workbench decision.
 * On validation failure, emits a console warning and returns undefined so the
 * outcome is recorded without authorizing (transparency-gap-not-blocker per ADR 0004).
 */
function buildDecisionCardAuthorizing(
  state: ReviewWorkbenchState,
): ReviewDecision["spec"]["authorizing"] {
  if (!state.decision) {
    return undefined;
  }

  const targetLabel = humanizeIdentifier(state.item.spec.target);
  const renderedPrompt = decisionCardRenderedPrompt(state, targetLabel);
  // Reviewer note present means the reviewer also typed a rationale — "typed".
  // Control-only affirmation (no note) is "affirmed-control".
  const action: "affirmed-control" | "typed" = state.note?.trim() ? "typed" : "affirmed-control";
  const authorityRef = `actor:${state.actorId}`;

  try {
    const block = buildAuthorizedActionAuthorizing({
      promptRef: DECISION_CARD_PROMPT_REF,
      renderedPrompt,
      action,
      authorityRef,
    });

    const issues = validateAuthorizing(block);
    if (issues.length > 0) {
      console.warn(
        "[survey] buildDecisionCardAuthorizing: authorizing block failed validation — recording outcome without authorizing.",
        issues,
      );
      return undefined;
    }

    return block;
  } catch (err) {
    console.warn(
      "[survey] buildDecisionCardAuthorizing: failed to construct authorizing block — recording outcome without authorizing.",
      err,
    );
    return undefined;
  }
}

/**
 * Derives the exact decision prompt rendered on the workbench decision card
 * for a given review item and decision.
 *
 * Format mirrors the review question shown in the workbench header:
 * "For {target}, decide whether {proposed} should replace {current}."
 * followed by the selected decision label so the block is self-contained.
 */
function decisionCardRenderedPrompt(state: ReviewWorkbenchState, targetLabel: string): string {
  const currentCandidate = state.item.spec.candidates.find((c) => c.role === "current");
  const proposedCandidate = state.item.spec.candidates.find((c) => c.role === "proposed");
  const currentValue = formatValue(currentCandidate?.value ?? "");
  const proposedValue = formatValue(proposedCandidate?.value ?? "");
  const decisionLabel = state.decision ? workbenchDecisionDefinitions[state.decision].label : "";

  return `For ${targetLabel}, decide whether ${proposedValue} should replace ${currentValue}. Selected decision: ${decisionLabel}.`;
}

export interface ReviewWorkbenchSessionExport {
  readonly session: ReviewSession;
  readonly events: readonly ReviewSessionEvent[];
  readonly decisions: readonly ReviewDecision[];
  readonly results: readonly ReviewWorkbenchResult[];
}

export type ReviewSessionApplyResolutionRequirement = "all" | "any" | "none";

export type ReviewSessionApplyIssue =
  | ReviewSessionReplayIssue
  | {
      readonly code: "unresolved-review-item";
      readonly reviewItemName: string;
      readonly message: string;
    }
  | {
      readonly code: "no-resolved-review-items";
      readonly message: string;
    };

export interface DeriveReviewSessionApplyResultForSnapshotOptions {
  readonly snapshot: ReviewQueueSessionState;
  readonly events: readonly ReviewSessionEvent[];
  readonly requiredResolvedItems?: ReviewSessionApplyResolutionRequirement;
}

export type DeriveReviewSessionApplyResultForSnapshotResult =
  | {
      readonly ok: true;
      readonly issues: readonly [];
      readonly unresolvedItemNames: readonly string[];
      readonly replayedSession: ReviewQueueSessionState;
      readonly sessionExport: ReviewWorkbenchSessionExport;
      readonly decisions: readonly ReviewDecision[];
      readonly results: readonly ReviewWorkbenchResult[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly ReviewSessionApplyIssue[];
      readonly unresolvedItemNames: readonly string[];
      readonly replayedSession?: ReviewQueueSessionState;
      readonly sessionExport?: ReviewWorkbenchSessionExport;
      readonly decisions: readonly ReviewDecision[];
      readonly results: readonly ReviewWorkbenchResult[];
    };

export interface ReviewSessionEventStore {
  load(session: ReviewQueueSessionState): readonly ReviewSessionEvent[] | undefined;
  save(session: ReviewQueueSessionState, events: readonly ReviewSessionEvent[]): void;
}

export type ReviewSessionPersistenceStatus = "idle" | "saving" | "saved" | "error";

export interface ReviewSessionPersistenceState {
  readonly status: ReviewSessionPersistenceStatus;
  readonly events: readonly ReviewSessionEvent[];
  readonly error?: unknown;
}

export interface ReviewSessionPersistenceRequest {
  readonly session: ReviewQueueSessionState;
  readonly events: readonly ReviewSessionEvent[];
  readonly expectedEventCount: number;
}

export interface ReviewSessionPersistenceResult {
  readonly events?: readonly ReviewSessionEvent[];
  readonly eventCount?: number;
}

export interface PersistReviewSessionEventsOptions {
  readonly session: ReviewQueueSessionState;
  readonly events: readonly ReviewSessionEvent[];
  readonly expectedEventCount?: number;
  readonly persist: (request: ReviewSessionPersistenceRequest) => Promise<ReviewSessionPersistenceResult | void>;
}

export interface PersistReviewSessionEventsResult {
  readonly events: readonly ReviewSessionEvent[];
  readonly eventCount: number;
}

export interface PersistentReviewSessionEventStoreOptions {
  readonly initialEvents?: readonly ReviewSessionEvent[];
  readonly persist: (request: ReviewSessionPersistenceRequest) => Promise<ReviewSessionPersistenceResult | void>;
  readonly onStatusChange?: (state: ReviewSessionPersistenceState) => void;
}

export interface MountReviewWorkbenchOptions {
  readonly eventStore?: ReviewSessionEventStore;
  readonly presentationAdapter?: ReviewPresentationAdapter;
}

export interface BrowserReviewWorkbenchConfig {
  readonly startState?: ReviewQueueSessionState | ReviewWorkbenchState;
}

export interface ReviewWorkbenchResult {
  readonly reviewItemName: string;
  readonly decision: ReviewWorkbenchDecision;
  readonly selectedCandidate: ReviewCandidate;
  readonly selectedCandidateId: string;
  readonly selectedCandidateRole?: ReviewCandidate["role"];
  /** The selected candidate's original value, unaffected by any reviewer edit. Used
   *  for candidate-identity matching (see `matchingSelectedCandidate`); consumers who
   *  want the reviewer's edited value should read `effectiveValue` instead. */
  readonly selectedValue: unknown;
  readonly selectedDisplayValue: string;
  /** Reviewer-edited override captured for an accept-proposed decision, if the
   *  reviewer changed the proposed value before applying it. Additive/optional. */
  readonly editedValue?: unknown;
  /** The value that should actually be applied: `editedValue` when present (and the
   *  decision selects the proposed candidate), otherwise `selectedValue`. */
  readonly effectiveValue: unknown;
  readonly effectiveDisplayValue: string;
  readonly unselectedCandidates: readonly ReviewCandidate[];
  readonly reviewDecision: ReviewDecision;
  readonly status: ReviewDecision["spec"]["status"];
  readonly rationale?: string;
}

export interface ReviewApplyResultExpectation {
  readonly decision?: ReviewWorkbenchDecision;
  readonly status?: ReviewDecision["spec"]["status"];
  readonly selectedCandidateRole?: ReviewCandidate["role"];
  readonly selectedCandidateId?: string;
  readonly selectedValue?: unknown;
  readonly equals?: (left: unknown, right: unknown) => boolean;
}

export interface ReviewApplyActionMapping<TAction> {
  readonly result: ReviewWorkbenchResult;
  readonly item: ReviewItem;
  readonly action: TAction;
}

export type ReviewApplyActionIssue =
  | {
      readonly code: "unknown-review-item";
      readonly reviewItemName: string;
      readonly message: string;
    }
  | {
      readonly code: "duplicate-review-target";
      readonly target: string;
      readonly message: string;
    }
  | {
      readonly code: "selected-candidate-mismatch";
      readonly reviewItemName: string;
      readonly message: string;
    }
  | {
      readonly code: "unmapped-review-result";
      readonly reviewItemName: string;
      readonly message: string;
    };

export class ReviewApplyActionMappingError extends Error {
  readonly name = "ReviewApplyActionMappingError";
  readonly issues: readonly ReviewApplyActionIssue[];

  constructor(issues: readonly ReviewApplyActionIssue[]) {
    super(`Review apply action mapping failed: ${issues.map((issue) => issue.message).join(" ")}`);
    this.issues = issues;
  }
}

export interface ReviewApplyActionContext {
  readonly result: ReviewWorkbenchResult;
  readonly item: ReviewItem;
  readonly target: ReviewItem["spec"]["target"];
  readonly selectedCandidate: ReviewCandidate;
  readonly unselectedCandidates: readonly ReviewCandidate[];
}

export interface MapReviewWorkbenchResultsToApplyActionsOptions<TAction> {
  readonly results: readonly ReviewWorkbenchResult[];
  readonly items: readonly ReviewItem[];
  readonly requireUniqueTargets?: boolean;
  readonly skip?: (context: ReviewApplyActionContext) => boolean;
  readonly map: (context: ReviewApplyActionContext) => TAction | readonly TAction[] | undefined;
}

export function buildReviewDecisionsFromSession(session: ReviewQueueSessionState): ReviewDecision[] {
  return session.items.flatMap((item) => {
    const decision = session.decisionsByItemName[item.metadata.name];
    if (!decision) {
      return [];
    }

    const reviewDecision = buildReviewDecision(currentReviewWorkbenchState({
      ...session,
      activeItemName: item.metadata.name,
    }));

    return reviewDecision ? [reviewDecision] : [];
  });
}

export function requireReviewResultForItem(
  item: ReviewItem,
  results: readonly ReviewWorkbenchResult[],
): ReviewWorkbenchResult {
  const matching = results.filter((result) => result.reviewItemName === item.metadata.name);
  if (matching.length !== 1) {
    throw new Error(`Expected exactly one resolved Survey result for ${item.metadata.name}.`);
  }
  return matching[0] as ReviewWorkbenchResult;
}

export function assertReviewResultMatches(
  result: ReviewWorkbenchResult,
  expectation: ReviewApplyResultExpectation,
): void {
  if (expectation.decision && result.decision !== expectation.decision) {
    throw new Error(`Review result ${result.reviewItemName} has decision ${result.decision}; expected ${expectation.decision}.`);
  }
  if (expectation.status && result.status !== expectation.status) {
    throw new Error(`Review result ${result.reviewItemName} has status ${result.status}; expected ${expectation.status}.`);
  }
  if (expectation.selectedCandidateRole && result.selectedCandidateRole !== expectation.selectedCandidateRole) {
    throw new Error(
      `Review result ${result.reviewItemName} selected ${result.selectedCandidateRole ?? "unknown"} candidate; expected ${expectation.selectedCandidateRole}.`,
    );
  }
  if (expectation.selectedCandidateId && result.selectedCandidateId !== expectation.selectedCandidateId) {
    throw new Error(
      `Review result ${result.reviewItemName} selected candidate ${result.selectedCandidateId}; expected ${expectation.selectedCandidateId}.`,
    );
  }
  if ("selectedValue" in expectation) {
    const equals = expectation.equals ?? Object.is;
    if (!equals(result.selectedValue, expectation.selectedValue)) {
      throw new Error(`Review result ${result.reviewItemName} selected value does not match the expected value.`);
    }
  }
}

export function mapReviewWorkbenchResultsToApplyActions<TAction>(
  options: MapReviewWorkbenchResultsToApplyActionsOptions<TAction>,
): ReviewApplyActionMapping<TAction>[] {
  const issues = options.requireUniqueTargets ? duplicateTargetIssues(options.items) : [];
  const itemByName = new Map(options.items.map((item) => [item.metadata.name, item]));
  const mappings = options.results.flatMap((result) =>
    mapReviewApplyResultToActions({ result, itemByName, options, issues }));

  if (issues.length > 0) {
    throw new ReviewApplyActionMappingError(issues);
  }

  return mappings;
}

export const mapReviewApplyActions = mapReviewWorkbenchResultsToApplyActions;

function duplicateTargetIssues(items: readonly ReviewItem[]): ReviewApplyActionIssue[] {
  const issues: ReviewApplyActionIssue[] = [];
  const seenTargets = new Set<string>();
  for (const item of items) {
    if (seenTargets.has(item.spec.target)) {
      issues.push({
        code: "duplicate-review-target",
        target: item.spec.target,
        message: `Review target ${item.spec.target} appears on more than one ReviewItem.`,
      });
    }
    seenTargets.add(item.spec.target);
  }
  return issues;
}

function mapReviewApplyResultToActions<TAction>(input: {
  readonly result: ReviewWorkbenchResult;
  readonly itemByName: ReadonlyMap<string, ReviewItem>;
  readonly options: MapReviewWorkbenchResultsToApplyActionsOptions<TAction>;
  readonly issues: ReviewApplyActionIssue[];
}): ReviewApplyActionMapping<TAction>[] {
  if (input.result.decision === "could-not-confirm") {
    return [];
  }
  const context = buildReviewApplyActionContext(input.result, input.itemByName, input.issues);
  if (!context || input.options.skip?.(context)) {
    return [];
  }

  const action = input.options.map(context);
  if (action === undefined) {
    input.issues.push({
      code: "unmapped-review-result",
      reviewItemName: input.result.reviewItemName,
      message: `Review result ${input.result.reviewItemName} did not produce an apply action.`,
    });
    return [];
  }

  return (Array.isArray(action) ? action : [action]).map((entry) => ({
    result: context.result,
    item: context.item,
    action: entry,
  }));
}

function buildReviewApplyActionContext(
  result: ReviewWorkbenchResult,
  itemByName: ReadonlyMap<string, ReviewItem>,
  issues: ReviewApplyActionIssue[],
): ReviewApplyActionContext | undefined {
  const item = itemByName.get(result.reviewItemName);
  if (!item) {
    issues.push({
      code: "unknown-review-item",
      reviewItemName: result.reviewItemName,
      message: `Review result ${result.reviewItemName} does not reference a known ReviewItem.`,
    });
    return undefined;
  }

  const selectedCandidate = matchingSelectedCandidate(item, result);
  if (!selectedCandidate) {
    issues.push({
      code: "selected-candidate-mismatch",
      reviewItemName: result.reviewItemName,
      message: `Review result ${result.reviewItemName} selected candidate does not match the supplied ReviewItem.`,
    });
    return undefined;
  }

  return {
    result,
    item,
    target: item.spec.target,
    selectedCandidate,
    unselectedCandidates: item.spec.candidates.filter((candidate) => candidate.id !== selectedCandidate.id),
  };
}

function matchingSelectedCandidate(
  item: ReviewItem,
  result: ReviewWorkbenchResult,
): ReviewCandidate | undefined {
  const candidate = item.spec.candidates.find((entry) => entry.id === result.selectedCandidateId);
  return candidate
    && candidate.role === result.selectedCandidateRole
    && structuralEqual(candidate.value, result.selectedValue)
    ? candidate
    : undefined;
}

function structuralEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function buildReviewWorkbenchResultsFromSession(session: ReviewQueueSessionState): ReviewWorkbenchResult[] {
  return session.items.flatMap((item) => {
    const decision = session.decisionsByItemName[item.metadata.name];
    if (!decision) {
      return [];
    }

    const state = currentReviewWorkbenchState({
      ...session,
      activeItemName: item.metadata.name,
    });
    const reviewDecision = buildReviewDecision(state);
    if (!reviewDecision) {
      return [];
    }

    const selectedCandidate = candidateForDecision(item, decision);
    const editedValue = decision === "accept-proposed"
      ? session.editedValuesByItemName?.[item.metadata.name]
      : undefined;
    const effectiveValue = effectiveValueForDecision(item, decision, editedValue);

    return [{
      reviewItemName: item.metadata.name,
      decision,
      selectedCandidate,
      selectedCandidateId: selectedCandidate.id,
      selectedCandidateRole: selectedCandidate.role,
      selectedValue: selectedCandidate.value,
      selectedDisplayValue: formatValue(selectedCandidate.value),
      editedValue,
      effectiveValue,
      effectiveDisplayValue: formatValue(effectiveValue),
      unselectedCandidates: item.spec.candidates.filter((candidate) => candidate.id !== selectedCandidate.id),
      reviewDecision,
      status: reviewDecision.spec.status,
      rationale: reviewDecision.spec.rationale,
    }];
  });
}

export function buildReviewWorkbenchSessionExport(
  session: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[] = buildReviewSessionEvents(session),
): ReviewWorkbenchSessionExport {
  return {
    session: buildReviewSessionResource(session, events),
    events,
    decisions: buildReviewDecisionsFromSession(session),
    results: buildReviewWorkbenchResultsFromSession(session),
  };
}

export function replayReviewSessionEventsForSnapshot(
  snapshot: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[],
): ReviewQueueSessionState {
  const issues = validateReviewSessionEventsForSnapshot(snapshot, events);
  if (issues.length > 0) {
    throw new Error(`Review session events do not match the supplied session snapshot: ${issues.map((issue) => issue.message).join(" ")}`);
  }

  return replayReviewSessionEvents(snapshot, events);
}

export function buildReviewWorkbenchSessionExportForSnapshot(
  snapshot: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[],
): ReviewWorkbenchSessionExport {
  const replayedSession = replayReviewSessionEventsForSnapshot(snapshot, events);
  return buildReviewWorkbenchSessionExport(replayedSession, events);
}

export function deriveReviewSessionApplyResultForSnapshot(
  options: DeriveReviewSessionApplyResultForSnapshotOptions,
): DeriveReviewSessionApplyResultForSnapshotResult {
  const requiredResolvedItems = options.requiredResolvedItems ?? "none";
  const replayIssues = validateReviewSessionEventsForSnapshot(options.snapshot, options.events);
  if (replayIssues.length > 0) {
    return {
      ok: false,
      issues: replayIssues,
      unresolvedItemNames: options.snapshot.items.map((item) => item.metadata.name),
      decisions: [],
      results: [],
    };
  }

  const replayedSession = replayReviewSessionEvents(options.snapshot, options.events);
  const sessionExport = buildReviewWorkbenchSessionExport(replayedSession, options.events);
  const resolvedItemNames = new Set(sessionExport.results.map((result) => result.reviewItemName));
  const unresolvedItemNames = options.snapshot.items
    .map((item) => item.metadata.name)
    .filter((itemName) => !resolvedItemNames.has(itemName));
  const issues: ReviewSessionApplyIssue[] = [];

  if (requiredResolvedItems === "all") {
    issues.push(...unresolvedItemNames.map((reviewItemName) => ({
      code: "unresolved-review-item" as const,
      reviewItemName,
      message: `Review item ${reviewItemName} has no resolved review decision.`,
    })));
  }

  if (requiredResolvedItems === "any" && sessionExport.results.length === 0) {
    issues.push({
      code: "no-resolved-review-items",
      message: "Review session has no resolved review decisions.",
    });
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      unresolvedItemNames,
      replayedSession,
      sessionExport,
      decisions: sessionExport.decisions,
      results: sessionExport.results,
    };
  }

  return {
    ok: true,
    issues: [],
    unresolvedItemNames,
    replayedSession,
    sessionExport,
    decisions: sessionExport.decisions,
    results: sessionExport.results,
  };
}

export function createInMemoryReviewSessionEventStore(
  initialEvents: readonly ReviewSessionEvent[] = [],
): ReviewSessionEventStore & { events(): readonly ReviewSessionEvent[] } {
  let savedEvents = [...initialEvents];

  return {
    events: () => [...savedEvents],
    load: () => savedEvents.length > 0 ? [...savedEvents] : undefined,
    save: (_session, events) => {
      savedEvents = [...events];
    },
  };
}

export function createLocalStorageReviewSessionEventStore(
  storage: Pick<Storage, "getItem" | "setItem">,
  keyPrefix = reviewWorkbenchSessionStorageKey,
): ReviewSessionEventStore {
  return {
    load: (session) => {
      const value = storage.getItem(reviewSessionStorageKey(session, keyPrefix));
      if (!value) {
        return undefined;
      }

      try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed as ReviewSessionEvent[] : undefined;
      } catch {
        return undefined;
      }
    },
    save: (session, events) => {
      storage.setItem(reviewSessionStorageKey(session, keyPrefix), JSON.stringify(events));
    },
  };
}

export async function persistReviewSessionEvents(
  options: PersistReviewSessionEventsOptions,
): Promise<PersistReviewSessionEventsResult> {
  const events = [...options.events];
  const result = await options.persist({
    session: options.session,
    events,
    expectedEventCount: options.expectedEventCount ?? 0,
  });
  const persistedEvents = result?.events ? [...result.events] : events;

  return {
    events: persistedEvents,
    eventCount: result?.eventCount ?? persistedEvents.length,
  };
}

export function createPersistentReviewSessionEventStore(
  options: PersistentReviewSessionEventStoreOptions,
): ReviewSessionEventStore & { events(): readonly ReviewSessionEvent[] } {
  let savedEvents: readonly ReviewSessionEvent[] = [...(options.initialEvents ?? [])];
  let lastPersistedSerialized = JSON.stringify(savedEvents);
  let lastPersistedEventCount = savedEvents.length;
  let pendingSave = Promise.resolve();

  const emit = (state: ReviewSessionPersistenceState): void => {
    options.onStatusChange?.(state);
  };

  return {
    events: () => [...savedEvents],
    load: () => savedEvents.length > 0 ? [...savedEvents] : undefined,
    save: (session, events) => {
      const normalizedEvents = [...events];
      const serialized = JSON.stringify(normalizedEvents);
      if (serialized === lastPersistedSerialized) {
        return;
      }

      pendingSave = pendingSave
        .then(async () => {
          if (serialized === lastPersistedSerialized) {
            return;
          }
          emit({ status: "saving", events: normalizedEvents });
          const result = await persistReviewSessionEvents({
            session,
            events: normalizedEvents,
            expectedEventCount: lastPersistedEventCount,
            persist: options.persist,
          });
          savedEvents = result.events;
          lastPersistedSerialized = JSON.stringify(result.events);
          lastPersistedEventCount = result.eventCount;
          emit({ status: "saved", events: result.events });
        })
        .catch((error) => {
          emit({ status: "error", events: normalizedEvents, error });
        });
    },
  };
}

export function renderReviewWorkbenchHtml(
  state: ReviewWorkbenchState | ReviewQueueSessionState,
  _events?: readonly ReviewSessionEvent[],
  options: { readonly presentationAdapter?: ReviewPresentationAdapter } = {},
): string {
  const session = queueSessionFromStartState(state);
  return renderReviewQueueSessionHtml(session, options.presentationAdapter);
}

type FieldCardState = "review" | "accepted" | "kept" | "rejected" | "could-not-confirm";

/**
 * The visual/decision state of a field card, derived from the reviewer's local
 * decision for that ReviewItem, falling back to a producer-declared "resolved"
 * candidate set (e.g. a pre-decided item seeded by the host) as already-kept.
 */
function fieldCardState(item: ReviewItem, decision: ReviewWorkbenchDecision | undefined): FieldCardState {
  if (decision === "accept-proposed") return "accepted";
  if (decision === "keep-current") return "kept";
  if (decision === "reject-proposed") return "rejected";
  if (decision === "could-not-confirm") return "could-not-confirm";
  if (item.spec.candidateSetStatus === "resolved") return "kept";
  return "review";
}

function chipLabel(state: FieldCardState): string {
  switch (state) {
    case "accepted": return "Accepted";
    case "kept": return "Kept current";
    case "rejected": return "Kept — flagged wrong";
    case "could-not-confirm": return "Could not confirm";
    default: return "Needs review";
  }
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

const ARROW_SVG = "<svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" aria-hidden=\"true\"><path d=\"M5 12h14M13 6l6 6-6 6\"/></svg>";
const WARNING_SVG = "<svg width=\"15\" height=\"15\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" aria-hidden=\"true\"><path d=\"M12 9v4M12 17h.01\"/><path d=\"M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z\"/></svg>";

function renderReviewQueueSessionHtml(
  session: ReviewQueueSessionState,
  presentationAdapter: ReviewPresentationAdapter | undefined,
): string {
  const totalCount = session.items.length;
  const decidedCount = session.items.filter((item) => session.decisionsByItemName[item.metadata.name] !== undefined
    || item.spec.candidateSetStatus === "resolved").length;
  const progressPct = totalCount === 0 ? 0 : Math.round((decidedCount / totalCount) * 100);
  const headerItem = session.items[0];
  const producerName = headerItem?.metadata.producer?.displayName;
  const headerTitle = typeof producerName === "string" && producerName.length > 0 ? producerName : "Review queue";

  return `
    <section class="workbench-shell review" data-testid="review-workbench-shell" aria-label="Survey review workbench">
      <header class="rhead">
        <div class="top">
          <div class="subj">
            <p class="eyebrow">Proposed changes</p>
            <h1>${escapeHtml(headerTitle)}</h1>
          </div>
        </div>
        <div class="meta">
          <span><b data-testid="fields-changed-count">${totalCount}</b> field${totalCount === 1 ? "" : "s"} to review</span>
        </div>
        <div class="progress">
          <div class="bar"><i style="width:${progressPct}%"></i></div>
          <span class="ptext"><b data-testid="decided-count">${decidedCount}</b> of <b>${totalCount}</b> decided</span>
          <button class="apply" type="button" data-testid="apply-button"${decidedCount === 0 ? " disabled" : ""}>Apply ${decidedCount} decision${decidedCount === 1 ? "" : "s"}</button>
        </div>
      </header>
      <div class="fields" data-testid="review-fields">
        ${session.items.map((item) => renderFieldCard(item, session, presentationAdapter)).join("")}
      </div>
      ${renderFooterTally(session)}
    </section>
  `;
}

function renderFieldCard(
  item: ReviewItem,
  session: ReviewQueueSessionState,
  presentationAdapter: ReviewPresentationAdapter | undefined,
): string {
  const decision = session.decisionsByItemName[item.metadata.name];
  const state = fieldCardState(item, decision);
  const decided = decision !== undefined;
  const current = item.spec.candidates.find((candidate) => candidate.role === "current");
  const proposed = item.spec.candidates.find((candidate) => candidate.role === "proposed");
  const presentation = buildReviewItemPresentation(item, presentationAdapter);
  const hasCurrentValue = current !== undefined && !isEmptyValue(current.value);
  const kind = hasCurrentValue ? "Update" : "New";
  const keepLabel = hasCurrentValue ? "Keep current" : "Leave unset";
  const editedValue = session.editedValuesByItemName?.[item.metadata.name];
  const proposedPresentationText = proposed
    ? buildReviewCandidatePresentation(item, proposed, presentationAdapter, presentation.targetLabel).valueText
    : "";
  const effectiveProposedText = decision === "accept-proposed" && editedValue !== undefined
    ? String(editedValue)
    : proposedPresentationText;
  const currentPresentationText = current && !isEmptyValue(current.value)
    ? buildReviewCandidatePresentation(item, current, presentationAdapter, presentation.targetLabel).valueText
    : undefined;

  return `
    <section
      class="field"
      data-testid="review-field"
      data-item-name="${escapeHtml(item.metadata.name)}"
      data-field="${escapeHtml(item.spec.target)}"
      data-state="${state}"
      data-decided="${decided ? "1" : "0"}"
      ${decision ? `data-decision="${escapeHtml(decision)}"` : ""}
    >
      <div class="stripe"></div>
      <div class="fbody">
        <div class="frow1">
          <span class="fname">${escapeHtml(presentation.targetLabel)}</span>
          <span class="fkind">${kind}</span>
          <span class="chip ${state} push" data-testid="field-chip">${chipLabel(state)}</span>
        </div>
        ${proposed
          ? renderDiffRow(item, current, proposed, presentation.targetLabel, decided, effectiveProposedText, currentPresentationText)
          : "<p class=\"field-value\">No proposed value is available for this field.</p>"}
        ${proposed ? renderProvenanceRow(item, proposed, presentationAdapter) : ""}
        <div class="decide">
          <button class="btn keep" type="button" data-testid="keep-current" data-item-name="${escapeHtml(item.metadata.name)}">${keepLabel}</button>
          <button class="btn use" type="button" data-testid="use-proposed" data-item-name="${escapeHtml(item.metadata.name)}">Use proposed</button>
          <label class="wrong">
            <input type="checkbox" class="wrongbox" data-testid="wrong-toggle" data-item-name="${escapeHtml(item.metadata.name)}">
            Suggestion was wrong
          </label>
          <button class="btn unconfirmed" type="button" data-testid="could-not-confirm" data-item-name="${escapeHtml(item.metadata.name)}">Could not confirm</button>
        </div>
        <div class="decided">
          <span class="chip ${state}" data-testid="decided-chip">${chipLabel(state)}</span>
          <button class="undo" type="button" data-testid="undo-decision" data-item-name="${escapeHtml(item.metadata.name)}">Change</button>
        </div>
        ${renderAuditDetails(item, current, proposed, session, presentationAdapter)}
      </div>
    </section>
  `;
}

/**
 * Renders the Current → Proposed diff row. The proposed side is editable
 * (via {@link renderProposedValueEditor}) until the field has a decision.
 */
function renderDiffRow(
  item: ReviewItem,
  current: ReviewCandidate | undefined,
  proposed: ReviewCandidate,
  targetLabel: string,
  decided: boolean,
  effectiveProposedText: string,
  currentPresentationText: string | undefined,
): string {
  const isEmpty = currentPresentationText === undefined;
  const currentText = isEmpty ? "Not set" : currentPresentationText;

  return `
    <div class="diff">
      <div class="val current${isEmpty ? " empty" : ""}">
        <div class="vlbl">Current</div>
        <div class="vtext" data-testid="current-value">${escapeHtml(currentText)}</div>
      </div>
      <div class="arrow">${ARROW_SVG}</div>
      <div class="val proposed">
        <div class="vlbl">Proposed</div>
        <div class="vtext" data-value data-testid="proposed-value">${escapeHtml(effectiveProposedText)}</div>
        ${decided || item.spec.editable === false ? "" : renderProposedValueEditor(item, proposed, targetLabel)}
      </div>
    </div>
  `;
}

/**
 * Renders the inline editor for a proposed value.
 *
 * This is intentionally the ONLY place that knows how to edit a proposed value —
 * a single seam so a later cross-repo change (spanning the upstream field-schema
 * owner and downstream consumers) can swap in typed editors — a `<select>` built
 * from an enum's allowed values, or date/number/boolean inputs — driven by an
 * optional neutral value-type descriptor, without touching the rest of the
 * field-card renderer. Survey deliberately has no value-type/enum system of its
 * own (that belongs to the upstream field-schema owner) — but a producer MAY
 * carry a field's declared shape down via the neutral
 * {@link ReviewValueDescriptor} on the item spec. When present, this renders a
 * typed control (an enum `<select>`, a date/number input, a true/false select)
 * and a validation-error slot the mount handler populates before "Use
 * proposed"; when absent, it renders the plain text input, matching the
 * approved mockup.
 */
function renderProposedValueEditor(item: ReviewItem, proposed: ReviewCandidate, targetLabel: string): string {
  const descriptor = item.spec.valueDescriptor;
  const valueText = formatValue(proposed.value);
  const commonAttrs = `
        class="proposed-value-input"
        data-testid="edit-proposed-value"
        data-item-name="${escapeHtml(item.metadata.name)}"
        aria-label="Edit proposed ${escapeHtml(targetLabel)}"`;
  const control = renderTypedProposedControl(descriptor, valueText, commonAttrs);
  return `
    <div class="editrow">
      ${control}
      <span class="ehint">${escapeHtml(proposedEditorHint(descriptor))}</span>
    </div>
    <span class="verr" data-testid="value-error" role="alert" hidden></span>
  `;
}

/**
 * Picks the concrete input control for the proposed-value editor from the
 * neutral value-type descriptor. All variants carry the SAME
 * `data-testid="edit-proposed-value"` and `.value` semantics so the mount
 * handler reads a reviewer's edit uniformly (both `<input>` and `<select>`
 * expose `.value`). Falls back to a plain text input when there is no
 * descriptor, an enum without a declared set, or a free-form type
 * (string/array/object).
 */
function renderTypedProposedControl(
  descriptor: ReviewValueDescriptor | undefined,
  valueText: string,
  commonAttrs: string,
): string {
  switch (descriptor?.type) {
    case "enum": {
      const allowed = descriptor.enumValues ?? [];
      if (allowed.length === 0) break;
      // Keep an out-of-set current value selectable rather than silently
      // rewriting it — the reviewer sees exactly what was proposed.
      const leadingOption = allowed.includes(valueText)
        ? ""
        : `<option value="${escapeHtml(valueText)}" selected>${escapeHtml(valueText === "" ? "(unset)" : valueText)}</option>`;
      const options = allowed
        .map((opt) => `<option value="${escapeHtml(opt)}"${opt === valueText ? " selected" : ""}>${escapeHtml(opt)}</option>`)
        .join("");
      return `<select${commonAttrs}>${leadingOption}${options}</select>`;
    }
    case "boolean": {
      const options = ["true", "false"]
        .map((opt) => `<option value="${opt}"${opt === valueText ? " selected" : ""}>${opt}</option>`)
        .join("");
      return `<select${commonAttrs}>${options}</select>`;
    }
    case "date":
      return `<input type="date"${commonAttrs} value="${escapeHtml(toDateInputValue(valueText))}">`;
    case "number":
      return `<input type="number" inputmode="decimal"${commonAttrs} value="${escapeHtml(valueText)}">`;
    default:
      break;
  }
  return `<input type="text"${commonAttrs} value="${escapeHtml(valueText)}">`;
}

/** The trailing editor hint, keyed to the declared value type. */
function proposedEditorHint(descriptor: ReviewValueDescriptor | undefined): string {
  switch (descriptor?.type) {
    case "enum":
      return "choose one";
    case "boolean":
      return "true / false";
    case "date":
      return "date";
    case "number":
      return "number";
    default:
      return "editable";
  }
}

/** Normalizes an arbitrary value string to the `YYYY-MM-DD` an `<input type="date">` accepts. */
function toDateInputValue(text: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString().slice(0, 10);
}

/**
 * Validates a reviewer's raw (string) edit of a proposed value against the
 * field's neutral {@link ReviewValueDescriptor}, returning a human-readable
 * error message when the value violates the declared type/enum constraint, or
 * `undefined` when it is acceptable — including when there is no descriptor or
 * the type carries no single-line constraint (string/array/object). This is a
 * FORMAT check only: it never coerces or rewrites the value (the workbench
 * stores the reviewer's string edit unchanged, as it did before typed editors).
 */
export function validateProposedValue(
  descriptor: ReviewValueDescriptor | undefined,
  rawValue: string,
): string | undefined {
  if (!descriptor) return undefined;
  const value = rawValue.trim();
  switch (descriptor.type) {
    case "number":
      if (value === "") return "Enter a number.";
      return Number.isFinite(Number(value)) ? undefined : `"${rawValue}" is not a number.`;
    case "boolean":
      if (value === "") return "Choose true or false.";
      return value === "true" || value === "false" ? undefined : `"${rawValue}" is not true or false.`;
    case "date":
      if (value === "") return "Enter a date.";
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : `"${rawValue}" is not a valid date (YYYY-MM-DD).`;
    case "enum": {
      const allowed = descriptor.enumValues ?? [];
      if (allowed.length === 0) return undefined; // nothing declared to enforce
      return allowed.includes(value) ? undefined : `Choose one of: ${allowed.join(", ")}.`;
    }
    default:
      return undefined;
  }
}

function renderProvenanceRow(
  item: ReviewItem,
  proposed: ReviewCandidate,
  presentationAdapter: ReviewPresentationAdapter | undefined,
): string {
  const excerpt = proposed.locator?.excerpt;
  if (!excerpt) {
    return `
      <div class="prov">
        <div class="noprov" data-testid="no-source-flag">
          ${WARNING_SVG}
          <span class="tag">No source</span>
          <span>This value has no supporting excerpt — verify before accepting.</span>
        </div>
      </div>
    `;
  }

  const confidence = proposed.extraction.confidence ?? proposed.confidence;
  const presentation = buildReviewCandidatePresentation(item, proposed, presentationAdapter);
  const sourceLinkHtml = presentation.sourceLink
    ? `<a href="${escapeHtml(presentation.sourceLink.href)}">${escapeHtml(presentation.sourceLink.label ?? presentation.sourceText)}</a>`
    : escapeHtml(presentation.sourceText);

  return `
    <div class="prov">
      ${confidence === undefined ? "" : renderConfidenceMeter(confidence)}
      <div class="excerpt" data-testid="proposed-excerpt">
        <q>${escapeHtml(excerpt)}</q>
        <span class="from">from ${sourceLinkHtml}</span>
      </div>
    </div>
  `;
}

function renderConfidenceMeter(confidence: number): string {
  const clamped = Math.max(0, Math.min(1, confidence));
  const pct = Math.round(clamped * 100);
  const isMid = clamped < 0.85;

  return `
    <div class="conf" data-testid="confidence-meter">
      <span>Confidence</span>
      <span class="meter${isMid ? " mid" : ""}"><i style="width:${pct}%"></i></span>
      <span class="pct">${clamped.toFixed(2)}</span>
    </div>
  `;
}

/**
 * The single collapsed power-user/audit surface per field card: reviewer note,
 * decision effect, candidate/claim/source ids, and (once a decision has been made)
 * the Surface projection preview and the raw ReviewDecision payload. Everything
 * here is secondary detail tucked behind one `<details>` toggle, kept off the
 * primary review surface.
 */
function renderAuditDetails(
  item: ReviewItem,
  current: ReviewCandidate | undefined,
  proposed: ReviewCandidate | undefined,
  session: ReviewQueueSessionState,
  presentationAdapter: ReviewPresentationAdapter | undefined,
): string {
  const decision = session.decisionsByItemName[item.metadata.name];
  const note = session.notesByItemName[item.metadata.name] ?? "";
  const definition = decision ? workbenchDecisionDefinitions[decision] : undefined;
  const state: ReviewWorkbenchState = {
    item,
    note,
    decision,
    editedValue: session.editedValuesByItemName?.[item.metadata.name],
    reviewedAt: session.reviewedAt,
    actorId: session.actorId,
  };
  const reviewDecisionPayload = buildReviewDecision(state);
  const preview = buildSurfaceProjectionPreview(item, reviewDecisionPayload, presentationAdapter);

  return `
    <details class="audit-details" data-testid="audit-details">
      <summary>Audit details</summary>
      <div class="audit-body">
        <label class="note-field">
          <span class="field-label">Reviewer note</span>
          <textarea data-testid="reviewer-note" data-item-name="${escapeHtml(item.metadata.name)}">${escapeHtml(note)}</textarea>
        </label>
        ${definition ? `<p class="field-value"><span class="field-label">Decision effect</span> ${escapeHtml(definition.effect)}</p>` : ""}
        ${renderProducerFeedbackTags(item)}
        <dl class="field-stack compact">
          ${current ? fieldItem("Current candidate ID", current.id) : ""}
          ${proposed ? fieldItem("Proposed candidate ID", proposed.id) : ""}
          ${proposed ? fieldItem("Claim ID", proposed.claimTarget.claimId ?? proposed.claimTarget.fieldOrBehavior) : ""}
          ${proposed ? fieldItem("Raw Source ID", proposed.source.sourceId ?? proposed.source.sourceRef) : ""}
          ${proposed?.locator ? fieldItem("Locator", proposed.locator.locator ?? proposed.locator.scheme) : ""}
          ${proposed?.extraction.model ? fieldItem("Model", proposed.extraction.model) : ""}
          ${proposed ? fieldItem("Extractor", proposed.extraction.extractor ?? "unknown") : ""}
          ${proposed ? fieldItem("Extracted at", proposed.extraction.extractedAt ?? "unknown") : ""}
        </dl>
        ${preview
          ? `<div class="preview-section-grid">${renderSurfacePreviewSections(preview)}</div><p class="preview-disclaimer preview-disclaimer-footer">${escapeHtml(preview.postureDisclaimer)}</p>`
          : "<p class=\"preview-disclaimer\">No decision recorded yet — pick an option above to preview the saved record.</p>"}
        ${reviewDecisionPayload
          ? `<details class="reference-details">
          <summary>Saved record (JSON)</summary>
          <pre data-testid="decision-payload">${escapeHtml(JSON.stringify(reviewDecisionPayload, null, 2))}</pre>
        </details>`
          : ""}
      </div>
    </details>
  `;
}

function renderProducerFeedbackTags(item: ReviewItem): string {
  const tags = item.spec.producerPolicy?.feedbackTags;
  if (!Array.isArray(tags) || tags.length === 0) {
    return "";
  }

  return `
    <div class="note-field">
      <span class="field-label">Producer feedback tags</span>
      <p class="field-value">${tags.map((tag) => escapeHtml(tag)).join(", ")}</p>
    </div>
  `;
}

function renderFooterTally(session: ReviewQueueSessionState): string {
  const counts: Record<FieldCardState, number> = { review: 0, accepted: 0, kept: 0, rejected: 0, "could-not-confirm": 0 };
  for (const item of session.items) {
    const state = fieldCardState(item, session.decisionsByItemName[item.metadata.name]);
    counts[state] += 1;
  }

  return `
    <footer class="foot" data-testid="review-tally">
      <div class="tally">
        <span>Accepted <b data-testid="tally-accepted">${counts.accepted}</b></span>
        <span>Kept <b data-testid="tally-kept">${counts.kept}</b></span>
        <span>Flagged <b data-testid="tally-rejected">${counts.rejected}</b></span>
        <span>Unconfirmed <b data-testid="tally-could-not-confirm">${counts["could-not-confirm"]}</b></span>
        <span>Remaining <b data-testid="tally-review">${counts.review}</b></span>
      </div>
    </footer>
  `;
}

function renderSurfacePreviewSections(preview: SurfaceProjectionPreview): string {
  return [
    renderCandidateHistory(preview),
    renderSourceEvidence(preview),
    renderReviewEvent(preview),
    renderIntegrityPosture(preview),
    renderAuthorityTrace(preview),
  ].join("");
}

function renderReviewEvent(preview: SurfaceProjectionPreview): string {
  return `
    <section class="preview-section" data-testid="surface-review-event">
      <h3>${escapeHtml("Review event")}</h3>
      <dl class="field-stack compact">
        ${fieldItem("Actor", preview.reviewEvent?.actor ?? "unknown")}
        ${fieldItem("Reviewed at", preview.reviewEvent?.reviewedAt ?? "not recorded")}
        ${fieldItem("Status", preview.reviewEvent?.status ?? "pending")}
        ${fieldItem("Rationale", preview.reviewEvent?.rationale ?? "No reviewer rationale provided.", "rationale-clamp")}
        ${fieldItem("Outcome", preview.reviewEvent?.reviewOutcomeId ?? "not provided")}
      </dl>
    </section>
  `;
}

function renderIntegrityPosture(preview: SurfaceProjectionPreview): string {
  return renderPreviewSection("Integrity posture", "surface-integrity-posture", [
    ["Checksum", preview.integrityPosture.checksum],
  ], undefined, [
    ["Candidate set ID", preview.integrityPosture.candidateSetId],
    ["Raw source ID", preview.integrityPosture.rawSourceId],
    ["Extraction ID", preview.integrityPosture.extractionId],
  ]);
}

function renderAuthorityTrace(preview: SurfaceProjectionPreview): string {
  return renderPreviewSection("Authority trace", "surface-authority-trace", [
    ["Status", preview.authorityTrace.label],
    ["Detail", preview.authorityTrace.detail],
  ], preview.authorityTrace.status === "empty" ? " is-neutral" : "");
}

function renderCandidateHistory(preview: SurfaceProjectionPreview): string {
  if (preview.candidateHistory.length === 0) {
    return renderPreviewSection("Unselected candidate history", "surface-candidate-history", [["History", "No unselected candidates."]], undefined, []);
  }

  const VISIBLE_COUNT = 3;
  const total = preview.candidateHistory.length;
  const visibleCandidates = preview.candidateHistory.slice(0, VISIBLE_COUNT);
  const overflowCandidates = preview.candidateHistory.slice(VISIBLE_COUNT);

  const renderHistoryRows = (candidates: typeof preview.candidateHistory): string =>
    candidates.flatMap((candidate) => [
      fieldItem("History", candidate.historyLabel),
      fieldItem("Value", candidate.value),
    ]).join("");

  const referenceRows = preview.candidateHistory.map((candidate) =>
    fieldItem("Candidate ID", candidate.candidateId),
  ).join("");

  const overflowHtml = overflowCandidates.length > 0
    ? `<div class="history-overflow">${renderHistoryRows(overflowCandidates)}</div>`
    : "";

  const expanderHtml = overflowCandidates.length > 0
    ? `<button class="history-expand-btn" type="button" data-history-expand aria-expanded="false">
         <span class="expand-label">view all (${total})</span>
         <span class="collapse-label">show less</span>
       </button>`
    : "";

  return `
    <section class="preview-section" data-testid="surface-candidate-history">
      <h3>${escapeHtml("Unselected candidate history")}</h3>
      <div class="history-expander" data-history-expander>
        <dl class="field-stack compact">
          ${renderHistoryRows(visibleCandidates)}
          ${overflowHtml}
        </dl>
        ${expanderHtml}
      </div>
      ${preview.candidateHistory.length > 0 ? `<details class="reference-details">
        <summary>IDs and trace links</summary>
        <dl class="field-stack compact">${referenceRows}</dl>
      </details>` : ""}
    </section>
  `;
}

function renderSourceEvidence(preview: SurfaceProjectionPreview): string {
  const clampedExcerptHtml = fieldItemClamped("Excerpt", preview.sourceEvidence.excerpt, "excerpt");

  return `
    <section class="preview-section" data-testid="surface-source-evidence">
      <h3>${escapeHtml("Raw Source")}</h3>
      <dl class="field-stack compact">
        ${fieldItem("Source Reference", preview.sourceEvidence.sourceRef)}
        ${clampedExcerptHtml}
        ${fieldItem("Extractor", preview.sourceEvidence.extractor)}
        ${fieldItem("Observed", preview.sourceEvidence.observedAt)}
        ${preview.sourceEvidence.sourceAuthority ? [
          fieldItem("Source authority class", preview.sourceEvidence.sourceAuthority.authorityClass),
          fieldItem("Declared by", preview.sourceEvidence.sourceAuthority.declaredBy),
          fieldItem("Authority scope", preview.sourceEvidence.sourceAuthority.scope),
        ].join("") : ""}
      </dl>
      ${renderReferenceDetails([
        ["Raw Source ID", preview.sourceEvidence.sourceId],
        ["Extraction ID", preview.sourceEvidence.extractionId],
      ])}
    </section>
  `;
}

function renderPreviewSection(
  title: string,
  testId: string,
  rows: ReadonlyArray<readonly [string, string]>,
  extraClass = "",
  references: ReadonlyArray<readonly [string, string]> = [],
): string {
  return `
    <section class="preview-section${extraClass}" data-testid="${testId}">
      <h3>${escapeHtml(title)}</h3>
      <dl class="field-stack compact">
        ${rows.map(([label, value]) => fieldItem(label, value)).join("")}
      </dl>
      ${references.length > 0 ? renderReferenceDetails(references) : ""}
    </section>
  `;
}

function renderReferenceDetails(references: ReadonlyArray<readonly [string, string]>): string {
  return `
    <details class="reference-details">
      <summary>IDs and trace links</summary>
      <dl class="field-stack compact">
        ${references.map(([label, value]) => fieldItem(label, value)).join("")}
      </dl>
    </details>
  `;
}

export function mountReviewWorkbench(
  root: HTMLElement,
  startState: ReviewQueueSessionState | ReviewWorkbenchState = initialReviewQueueSessionState(),
  options: MountReviewWorkbenchOptions = {},
): void {
  const controller = createReviewWorkbenchController(root, startState, options);

  controller.renderCurrentState();
}

interface ReviewWorkbenchController {
  renderCurrentState(): void;
}

interface ReviewWorkbenchControllerBindings extends ReviewWorkbenchController {
  currentSession(): ReviewQueueSessionState;
  currentSessionExport(): ReviewWorkbenchSessionExport;
  setDecision(itemName: string, decision: ReviewWorkbenchDecision, rawEditedValue?: string): void;
  clearDecision(itemName: string): void;
  updateReviewerNote(itemName: string, note: string): void;
}

function createReviewWorkbenchController(
  root: HTMLElement,
  startState: ReviewQueueSessionState | ReviewWorkbenchState,
  options: MountReviewWorkbenchOptions,
): ReviewWorkbenchController {
  const baseSession = queueSessionFromStartState(startState);
  const eventStore = options.eventStore ?? browserReviewSessionEventStore();
  let events = eventStore?.load(baseSession) ?? [];
  let session = events.length > 0 ? replayReviewSessionEvents(baseSession, events) : baseSession;

  const persistEvents = (): void => {
    eventStore?.save(session, events);
  };

  const appendEvent = (
    eventType: ReviewSessionEvent["spec"]["eventType"],
    itemName: string | undefined,
    dataOverride?: Record<string, unknown>,
  ): void => {
    const item = itemName ? session.items.find((entry) => entry.metadata.name === itemName) : undefined;
    const decision = itemName ? session.decisionsByItemName[itemName] : undefined;
    const candidate = item && decision ? candidateForDecision(item, decision) : undefined;
    const definition = decision ? workbenchDecisionDefinitions[decision] : undefined;
    const note = itemName ? session.notesByItemName[itemName] : undefined;
    // Carry the reviewer's inline edit in the event (accept-proposed only), so
    // it survives replay and the server apply boundary derives the edited
    // effectiveValue from snapshot + events alone. setDecision updates the
    // session before this runs, so the edit is already in state.
    const editedValue = itemName && decision === "accept-proposed" ? session.editedValuesByItemName?.[itemName] : undefined;
    const attemptEvidenceIds = itemName && decision === "could-not-confirm"
      ? session.attemptEvidenceIdsByItemName?.[itemName]
      : undefined;
    const defaultData = decision
      ? (editedValue !== undefined
        ? { workbenchDecision: decision, workbenchEditedValue: editedValue }
        : { workbenchDecision: decision, ...(attemptEvidenceIds?.length ? { attemptEvidenceIds } : {}) })
      : undefined;

    events = [
      ...events,
      buildReviewSessionEvent(session, {
        sessionName: defaultReviewSessionName,
        sequence: events.length + 1,
        eventType,
        occurredAt: session.reviewedAt,
        reviewItemName: itemName,
        reviewDecisionName: item && decision ? `${item.metadata.name}-${decision}` : undefined,
        candidateId: candidate?.id,
        status: definition?.status,
        ...(decision === "could-not-confirm"
          ? {
              resolution: "could_not_confirm" as const,
              resolutionReason: note?.trim(),
              ...(attemptEvidenceIds ? { attemptEvidenceIds: [...attemptEvidenceIds] } : {}),
            }
          : {}),
        rationale: note,
        data: dataOverride ?? defaultData,
      }),
    ];
  };

  const applySessionUpdate = (update: (current: ReviewQueueSessionState) => ReviewQueueSessionState): void => {
    session = update(session);
  };

  const setDecision = (itemName: string, decision: ReviewWorkbenchDecision, rawEditedValue?: string): void => {
    if (decision === "could-not-confirm" && !session.notesByItemName[itemName]?.trim()) {
      throw new Error("Could not confirm requires a non-empty reason.");
    }
    applySessionUpdate((current) => {
      const item = current.items.find((entry) => entry.metadata.name === itemName);
      const proposed = item?.spec.candidates.find((candidate) => candidate.role === "proposed");
      const originalText = proposed ? formatValue(proposed.value) : undefined;
      const nextEditedValuesByItemName: Record<string, unknown> = { ...current.editedValuesByItemName };

      if (decision === "accept-proposed" && rawEditedValue !== undefined && rawEditedValue !== originalText) {
        nextEditedValuesByItemName[itemName] = rawEditedValue;
      } else {
        delete nextEditedValuesByItemName[itemName];
      }

      return {
        ...current,
        activeItemName: itemName,
        decisionsByItemName: { ...current.decisionsByItemName, [itemName]: decision },
        editedValuesByItemName: nextEditedValuesByItemName,
      };
    });
    appendEvent("decision-changed", itemName);
    persistEvents();
  };

  const clearDecision = (itemName: string): void => {
    applySessionUpdate((current) => {
      const remainingDecisions = { ...current.decisionsByItemName };
      delete remainingDecisions[itemName];
      const remainingEdits: Record<string, unknown> = { ...current.editedValuesByItemName };
      delete remainingEdits[itemName];
      const remainingAttemptEvidenceIds = { ...current.attemptEvidenceIdsByItemName };
      delete remainingAttemptEvidenceIds[itemName];

      return {
        ...current,
        activeItemName: itemName,
        decisionsByItemName: remainingDecisions,
        editedValuesByItemName: remainingEdits,
        attemptEvidenceIdsByItemName: remainingAttemptEvidenceIds,
      };
    });
    appendEvent("decision-changed", itemName, { workbenchDecision: null });
    persistEvents();
  };

  const updateReviewerNote = (itemName: string, note: string): void => {
    applySessionUpdate((current) => ({
      ...current,
      notesByItemName: { ...current.notesByItemName, [itemName]: note },
    }));
    appendEvent("note-changed", itemName);
    persistEvents();
  };

  const controller: ReviewWorkbenchControllerBindings = {
    currentSession: () => session,
    currentSessionExport: () => buildReviewWorkbenchSessionExport(session, events),
    renderCurrentState: () => renderCurrentState(root, session, controller, options.presentationAdapter),
    setDecision,
    clearDecision,
    updateReviewerNote,
  };

  return controller;
}

function browserReviewSessionEventStore(): ReviewSessionEventStore | undefined {
  if (typeof window === "undefined" || !window.localStorage) {
    return undefined;
  }

  return createLocalStorageReviewSessionEventStore(window.localStorage);
}

function reviewSessionStorageKey(session: ReviewQueueSessionState, keyPrefix: string): string {
  const itemNames = buildReviewSessionResource(session).spec.reviewItemNames.join(",");
  return `${keyPrefix}:${itemNames}`;
}

function renderCurrentState(
  root: HTMLElement,
  session: ReviewQueueSessionState,
  controller: ReviewWorkbenchControllerBindings,
  presentationAdapter?: ReviewPresentationAdapter,
): void {
  root.innerHTML = renderReviewWorkbenchHtml(session, undefined, { presentationAdapter });
  bindFieldCardInteractions(root, controller);
  bindApplyButton(root, controller);
  bindClampToggles(root);
  bindHistoryExpanders(root);
}

function queueSessionFromStartState(
  startState: ReviewQueueSessionState | ReviewWorkbenchState,
): ReviewQueueSessionState {
  if ("items" in startState) {
    return startState;
  }

  return {
    items: [startState.item],
    activeItemName: startState.item.metadata.name,
    notesByItemName: startState.note ? { [startState.item.metadata.name]: startState.note } : {},
    decisionsByItemName: startState.decision ? { [startState.item.metadata.name]: startState.decision } : {},
    editedValuesByItemName: startState.editedValue !== undefined
      ? { [startState.item.metadata.name]: startState.editedValue }
      : {},
    ...(startState.attemptEvidenceIds?.length
      ? { attemptEvidenceIdsByItemName: { [startState.item.metadata.name]: [...startState.attemptEvidenceIds] } }
      : {}),
    reviewedAt: startState.reviewedAt,
    actorId: startState.actorId,
  };
}

function bindFieldCardInteractions(root: HTMLElement, controller: ReviewWorkbenchControllerBindings): void {
  root.querySelectorAll<HTMLButtonElement>("[data-testid='use-proposed']").forEach((button) => {
    button.addEventListener("click", () => {
      const itemName = button.dataset.itemName ?? "";
      const field = button.closest<HTMLElement>("[data-testid='review-field']");
      const input = field?.querySelector<HTMLInputElement | HTMLSelectElement>("[data-testid='edit-proposed-value']");
      const descriptor = controller
        .currentSession()
        .items.find((entry) => entry.metadata.name === itemName)?.spec.valueDescriptor;
      const error = validateProposedValue(descriptor, input?.value ?? "");
      const errorEl = field?.querySelector<HTMLElement>("[data-testid='value-error']");
      if (error) {
        // Block the decision and surface the reason inline; the transient DOM
        // message survives until the next interaction (no re-render on reject).
        if (errorEl) {
          errorEl.textContent = error;
          errorEl.hidden = false;
        }
        input?.focus?.();
        return;
      }
      if (errorEl) {
        errorEl.textContent = "";
        errorEl.hidden = true;
      }
      controller.setDecision(itemName, "accept-proposed", input?.value);
      controller.renderCurrentState();
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-testid='keep-current']").forEach((button) => {
    button.addEventListener("click", () => {
      const itemName = button.dataset.itemName ?? "";
      const field = button.closest<HTMLElement>("[data-testid='review-field']");
      const wrong = field?.querySelector<HTMLInputElement>("[data-testid='wrong-toggle']");
      const decision: ReviewWorkbenchDecision = wrong?.checked ? "reject-proposed" : "keep-current";
      controller.setDecision(itemName, decision);
      controller.renderCurrentState();
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-testid='could-not-confirm']").forEach((button) => {
    button.addEventListener("click", () => {
      const itemName = button.dataset.itemName ?? "";
      const note = controller.currentSession().notesByItemName[itemName]?.trim() ?? "";
      const field = button.closest<HTMLElement>("[data-testid='review-field']");
      const textarea = field?.querySelector<HTMLTextAreaElement>("[data-testid='reviewer-note']");
      if (!note) {
        textarea?.setCustomValidity?.("A reason is required when you could not confirm.");
        textarea?.reportValidity?.();
        textarea?.focus();
        return;
      }
      textarea?.setCustomValidity?.("");
      controller.setDecision(itemName, "could-not-confirm");
      controller.renderCurrentState();
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-testid='undo-decision']").forEach((button) => {
    button.addEventListener("click", () => {
      controller.clearDecision(button.dataset.itemName ?? "");
      controller.renderCurrentState();
    });
  });

  root.querySelectorAll<HTMLTextAreaElement>("[data-testid='reviewer-note']").forEach((textarea) => {
    textarea.addEventListener("input", () => {
      textarea.setCustomValidity?.("");
      const itemName = textarea.dataset.itemName ?? "";
      controller.updateReviewerNote(itemName, textarea.value);
      refreshAuditPayloadForItem(textarea, controller, itemName);
    });
  });
}

function bindApplyButton(root: HTMLElement, controller: ReviewWorkbenchControllerBindings): void {
  const button = root.querySelector<HTMLButtonElement>("[data-testid='apply-button']");
  button?.addEventListener("click", () => {
    if (typeof CustomEvent !== "function" || typeof root.dispatchEvent !== "function") {
      return;
    }

    root.dispatchEvent(new CustomEvent("survey:review-workbench-apply", {
      bubbles: true,
      composed: true,
      detail: {
        session: controller.currentSession(),
        sessionExport: controller.currentSessionExport(),
      },
    }));
  });
}

/**
 * After a reviewer-note keystroke, patch just that field's decision-payload `<pre>`
 * in place instead of a full re-render — a full re-render would close the audit
 * `<details>` and drop focus/caret position on every keystroke.
 */
function refreshAuditPayloadForItem(
  textarea: HTMLTextAreaElement,
  controller: ReviewWorkbenchControllerBindings,
  itemName: string,
): void {
  const field = textarea.closest<HTMLElement>("[data-testid='review-field']");
  const payload = field?.querySelector<HTMLElement>("[data-testid='decision-payload']");
  if (!payload) {
    return;
  }

  const session = controller.currentSession();
  const item = session.items.find((entry) => entry.metadata.name === itemName);
  if (!item) {
    return;
  }

  const state: ReviewWorkbenchState = {
    item,
    note: textarea.value,
    decision: session.decisionsByItemName[itemName],
    editedValue: session.editedValuesByItemName?.[itemName],
    reviewedAt: session.reviewedAt,
    actorId: session.actorId,
  };
  payload.textContent = JSON.stringify(buildReviewDecision(state) ?? null, null, 2);
}

function bindClampToggles(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-clamp-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const clampContainer = button.closest("[data-clamp]");
      if (!clampContainer) return;
      const expanded = clampContainer.classList.toggle("is-expanded");
      button.setAttribute("aria-expanded", String(expanded));
      button.textContent = expanded ? "less" : "more";
    });
  });
}

function bindHistoryExpanders(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-history-expand]").forEach((button) => {
    button.addEventListener("click", () => {
      const expander = button.closest("[data-history-expander]");
      if (!expander) return;
      const expanded = expander.classList.toggle("is-expanded");
      button.setAttribute("aria-expanded", String(expanded));
    });
  });
}

function fieldItemClamped(label: string, value: unknown, extraClass = ""): string {
  return `
    <div class="kv ${extraClass}">
      <dt class="field-label">${escapeHtml(label)}</dt>
      <div class="excerpt-clamp" data-clamp>
        <dd class="field-value">${escapeHtml(value)}</dd>
        <button class="clamp-toggle" type="button" data-clamp-toggle aria-expanded="false">more</button>
      </div>
    </div>
  `;
}

function fieldItem(label: string, value: unknown, extraClass = ""): string {
  return `
    <div class="kv ${extraClass}">
      <dt class="field-label">${escapeHtml(label)}</dt>
      <dd class="field-value">${escapeHtml(value)}</dd>
    </div>
  `;
}

function escapeHtml(value: unknown): string {
  return formatValue(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}


export function browserReviewWorkbenchStartState(): ReviewQueueSessionState | ReviewWorkbenchState | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const config = window.kontourSurveyReviewWorkbench;
  if (!config) {
    return undefined;
  }

  if (isReviewQueueSessionState(config) || isReviewWorkbenchState(config)) {
    return config;
  }

  const configuredStartState = config.startState;
  return isReviewQueueSessionState(configuredStartState) || isReviewWorkbenchState(configuredStartState)
    ? configuredStartState
    : undefined;
}

function isReviewQueueSessionState(value: unknown): value is ReviewQueueSessionState {
  if (!isRecord(value)
    || !Array.isArray(value.items)
    || typeof value.activeItemName !== "string"
    || !isStringRecord(value.notesByItemName)
    || !isStringRecord(value.decisionsByItemName)
    || typeof value.reviewedAt !== "string"
    || typeof value.actorId !== "string") {
    return false;
  }

  return value.items.length > 0
    && value.items.every(isReviewItem)
    && value.items.some((item) => item.metadata.name === value.activeItemName);
}

function isReviewWorkbenchState(value: unknown): value is ReviewWorkbenchState {
  return isRecord(value)
    && isReviewItem(value.item)
    && typeof value.note === "string"
    && typeof value.reviewedAt === "string"
    && typeof value.actorId === "string";
}

function isReviewItem(value: unknown): value is ReviewItem {
  return isRecord(value)
    && value.apiVersion === reviewResourceApiVersion
    && value.kind === "ReviewItem"
    && isResourceMetadata(value.metadata)
    && isReviewItemSpec(value.spec);
}

function isResourceMetadata(value: unknown): value is ReviewItem["metadata"] {
  return isRecord(value) && typeof value.name === "string" && value.name.length > 0;
}

function isReviewItemSpec(value: unknown): value is ReviewItem["spec"] {
  return isRecord(value)
    && typeof value.target === "string"
    && Array.isArray(value.candidates)
    && value.candidates.length > 0
    && value.candidates.every(isReviewCandidate);
}

function isReviewCandidate(value: unknown): value is ReviewCandidate {
  return isRecord(value)
    && typeof value.id === "string"
    && isRecord(value.source)
    && typeof value.source.sourceRef === "string"
    && isRecord(value.extraction)
    && typeof value.extraction.target === "string"
    && isRecord(value.claimTarget)
    && typeof value.claimTarget.subjectType === "string"
    && typeof value.claimTarget.subjectId === "string"
    && typeof value.claimTarget.facet === "string"
    && typeof value.claimTarget.claimType === "string"
    && typeof value.claimTarget.fieldOrBehavior === "string"
    && typeof value.claimTarget.impactLevel === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

declare global {
  interface Window {
    kontourSurveyReviewWorkbench?: BrowserReviewWorkbenchConfig | ReviewQueueSessionState | ReviewWorkbenchState;
  }
}
