import {
  candidateForDecision,
  buildReviewSessionEvent,
  buildReviewSessionEvents,
  buildReviewSessionResource,
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
  type ReviewQueueSessionState,
  type ReviewWorkbenchDecision,
  type ReviewWorkbenchState,
} from "./review-queue-session.js";
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
} from "../review-resource.js";

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

export function buildReviewDecision(state: ReviewWorkbenchState): ReviewDecision | undefined {
  if (!state.decision) {
    return undefined;
  }

  const definition = workbenchDecisionDefinitions[state.decision];
  const candidate = candidateForDecision(state.item, state.decision);
  const projection = {
    ...candidate.projection,
    reviewOutcomeId: candidate.projection?.reviewOutcomeId
      ?? `${state.item.metadata.name}:${state.decision}:review-outcome`,
  };

  return {
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
      actor: {
        id: state.actorId,
      },
      reviewedAt: state.reviewedAt,
      rationale: state.note,
      projection,
    },
    status: {
      appliedToClaimIds: candidate.projection?.claimId ? [candidate.projection.claimId] : undefined,
    },
  };
}

export interface ReviewWorkbenchSessionExport {
  readonly session: ReviewSession;
  readonly events: readonly ReviewSessionEvent[];
  readonly decisions: readonly ReviewDecision[];
  readonly results: readonly ReviewWorkbenchResult[];
}

export type ReviewSessionReplayIssueCode =
  | "unknown-active-item"
  | "unknown-review-item"
  | "unknown-candidate";

export interface ReviewSessionReplayIssue {
  readonly code: ReviewSessionReplayIssueCode;
  readonly eventName: string;
  readonly sequence: number;
  readonly reviewItemName?: string;
  readonly candidateId?: string;
  readonly message: string;
}

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
  readonly eventCount?: number;
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
  readonly selectedValue: unknown;
  readonly selectedDisplayValue: string;
  readonly unselectedCandidates: readonly ReviewCandidate[];
  readonly reviewDecision: ReviewDecision;
  readonly status: ReviewDecision["spec"]["status"];
  readonly rationale?: string;
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

    return [{
      reviewItemName: item.metadata.name,
      decision,
      selectedCandidate,
      selectedCandidateId: selectedCandidate.id,
      selectedCandidateRole: selectedCandidate.role,
      selectedValue: selectedCandidate.value,
      selectedDisplayValue: formatValue(selectedCandidate.value),
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

export function validateReviewSessionEventsForSnapshot(
  snapshot: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[],
): ReviewSessionReplayIssue[] {
  const itemsByName = new Map(snapshot.items.map((item) => [item.metadata.name, item]));

  return events.flatMap((event) => {
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

export function createPersistentReviewSessionEventStore(
  options: PersistentReviewSessionEventStoreOptions,
): ReviewSessionEventStore & { events(): readonly ReviewSessionEvent[] } {
  let savedEvents = [...(options.initialEvents ?? [])];
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
          const result = await options.persist({
            session,
            events: normalizedEvents,
            expectedEventCount: lastPersistedEventCount,
          });
          savedEvents = normalizedEvents;
          lastPersistedSerialized = serialized;
          lastPersistedEventCount = result?.eventCount ?? normalizedEvents.length;
          emit({ status: "saved", events: normalizedEvents });
        })
        .catch((error) => {
          emit({ status: "error", events: normalizedEvents, error });
        });
    },
  };
}

export function renderReviewWorkbenchHtml(
  state: ReviewWorkbenchState | ReviewQueueSessionState,
  events?: readonly ReviewSessionEvent[],
  options: { readonly presentationAdapter?: ReviewPresentationAdapter } = {},
): string {
  if ("items" in state) {
    return renderReviewQueueSessionHtml(state, events, options.presentationAdapter);
  }

  return `
    <section class="workbench-shell" aria-label="Survey review workbench">
      ${renderWorkbenchHeader(state, options.presentationAdapter)}
      <div class="content-grid">
        ${renderReviewFocus(state, options.presentationAdapter)}
        ${renderDecisionColumn(state, options.presentationAdapter)}
        ${renderCandidateComparison(state, options.presentationAdapter)}
      </div>
    </section>
  `;
}

function renderReviewQueueSessionHtml(
  session: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[] | undefined,
  presentationAdapter: ReviewPresentationAdapter | undefined,
): string {
  const state = currentReviewWorkbenchState(session);
  const sessionExport = buildReviewWorkbenchSessionExport(session, events);

  return `
    <section class="workbench-shell" aria-label="Survey review workbench">
      ${renderWorkbenchHeader(state, presentationAdapter)}
      ${renderActiveReviewStrip(session, state, presentationAdapter)}
      <div class="queue-layout">
        <aside class="queue-panel" aria-label="Review queue">
          ${renderQueueRows(session, presentationAdapter)}
          ${renderSessionSummary(session)}
          ${renderSessionAudit(session, sessionExport)}
        </aside>
        <div class="content-grid">
          ${renderReviewFocus(state, presentationAdapter)}
          ${renderDecisionColumn(state, presentationAdapter)}
          ${renderCandidateComparison(state, presentationAdapter)}
        </div>
      </div>
    </section>
  `;
}

function renderSessionAudit(session: ReviewQueueSessionState, sessionExport: ReviewWorkbenchSessionExport): string {
  const lastEvents = sessionExport.events.slice(-6);
  const replayed = replayReviewSessionEvents({
    ...session,
    activeItemName: session.items[0]?.metadata.name ?? session.activeItemName,
    notesByItemName: {},
    decisionsByItemName: {},
  }, sessionExport.events);
  const replayMatchesSession = sameStringRecord(replayed.decisionsByItemName, session.decisionsByItemName)
    && sameStringRecord(replayed.notesByItemName, session.notesByItemName);

  return `
    <section class="session-audit" data-testid="session-audit" aria-label="Review session audit trail">
      <div class="session-audit-head">
        <div>
          <span class="field-label">ReviewSession</span>
          <h2>${escapeHtml(sessionExport.session.metadata.name)}</h2>
        </div>
        <span class="state-label">${escapeHtml(replayMatchesSession ? "replay ok" : "replay drift")}</span>
      </div>
      <dl class="summary-grid audit-grid">
        ${metaItem("Events", String(sessionExport.events.length))}
        ${metaItem("Decisions", String(sessionExport.decisions.length))}
        ${metaItem("Active item", sessionExport.session.status?.activeItemName ?? "none")}
        ${metaItem("Actor", sessionExport.session.spec.actor?.id ?? "unknown")}
      </dl>
      <ol class="session-event-list" data-testid="session-event-list">
        ${lastEvents.length === 0
          ? "<li><span class=\"field-label\">No events</span><span>No persisted review activity yet.</span></li>"
          : lastEvents.map(renderSessionEventRow).join("")}
      </ol>
      <details class="session-export" data-testid="session-export">
        <summary>Session export</summary>
        <pre>${escapeHtml(JSON.stringify(sessionExport, null, 2))}</pre>
      </details>
    </section>
  `;
}

function sameStringRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function renderSessionEventRow(event: ReviewSessionEvent): string {
  const target = event.spec.reviewItemName ?? event.spec.activeItemName ?? event.spec.sessionName;
  const detail = [
    event.spec.status,
    event.spec.candidateId,
    event.spec.rationale,
  ].filter(Boolean).join(" - ");

  return `
    <li>
      <span class="event-sequence">${escapeHtml(String(event.spec.sequence).padStart(2, "0"))}</span>
      <span>
        <strong>${escapeHtml(event.spec.eventType)}</strong>
        <small>${escapeHtml(target)}${detail ? ` - ${escapeHtml(detail)}` : ""}</small>
      </span>
    </li>
  `;
}

function renderQueueRows(session: ReviewQueueSessionState, presentationAdapter?: ReviewPresentationAdapter): string {
  return `
    <section class="queue-list" data-testid="review-queue">
      <div class="queue-head">
        <h2>Review queue</h2>
        <button class="next-button" type="button" data-testid="next-unresolved">Next unresolved</button>
      </div>
      ${session.items.map((item) => renderQueueRow(item, session, presentationAdapter)).join("")}
    </section>
  `;
}

function renderQueueRow(
  item: ReviewItem,
  session: ReviewQueueSessionState,
  presentationAdapter?: ReviewPresentationAdapter,
): string {
  const status = deriveQueueRowStatus(item, session);
  const isActive = item.metadata.name === session.activeItemName;
  const presentation = buildReviewItemPresentation(item, presentationAdapter);

  return `
    <button class="queue-row${isActive ? " is-active" : ""}" type="button" data-item-name="${escapeHtml(item.metadata.name)}" data-testid="queue-row" data-queue-status="${status}">
      <span class="queue-row-main">
        <span class="queue-row-title">${escapeHtml(presentation.targetLabel)}</span>
        <span class="queue-row-target">${escapeHtml(item.metadata.name)}</span>
      </span>
      <span class="state-label">${escapeHtml(status)}</span>
    </button>
  `;
}

function renderSessionSummary(session: ReviewQueueSessionState): string {
  const summary = reviewSessionSummary(session);

  return `
    <section class="session-summary" data-testid="session-summary">
      <h2>Session summary</h2>
      <dl class="summary-grid">
        ${metaItem("Accepted", String(summary.accepted))}
        ${metaItem("Kept current", String(summary.keptCurrent))}
        ${metaItem("Rejected", String(summary.rejected))}
        ${metaItem("Escalated", String(summary.escalated))}
        ${metaItem("Unresolved", String(summary.unresolved))}
      </dl>
    </section>
  `;
}

function renderActiveReviewStrip(
  session: ReviewQueueSessionState,
  state: ReviewWorkbenchState,
  presentationAdapter?: ReviewPresentationAdapter,
): string {
  const activeIndex = session.items.findIndex((item) => item.metadata.name === session.activeItemName);
  const position = activeIndex >= 0 ? activeIndex + 1 : 1;
  const status = deriveQueueRowStatus(state.item, session);
  const presentation = buildReviewItemPresentation(state.item, presentationAdapter);

  return `
    <section class="active-review-strip" data-testid="active-review-strip" aria-label="Active review item">
      <div class="active-review-copy">
        <span class="field-label">Review ${position} of ${session.items.length}</span>
        <strong>${escapeHtml(presentation.targetLabel)}</strong>
        <span>${escapeHtml(state.item.metadata.name)}</span>
      </div>
      <div class="active-review-actions">
        <span class="state-label">${escapeHtml(status)}</span>
        <button class="next-button" type="button" data-testid="active-next-unresolved">Next unresolved</button>
      </div>
    </section>
  `;
}

function renderWorkbenchHeader(state: ReviewWorkbenchState, presentationAdapter?: ReviewPresentationAdapter): string {
  const current = candidateByRole(state.item, "current");
  const proposed = candidateByRole(state.item, "proposed");
  const presentation = buildReviewItemPresentation(state.item, presentationAdapter);
  const currentPresentation = buildReviewCandidatePresentation(state.item, current, presentationAdapter, presentation.targetLabel);
  const proposedPresentation = buildReviewCandidatePresentation(state.item, proposed, presentationAdapter, presentation.targetLabel);

  return `
    <header class="topbar">
      <div>
        <p class="eyebrow">${escapeHtml(String(state.item.metadata.producer?.displayName ?? "Survey"))}</p>
        <h1>Review candidate update</h1>
        <p class="review-question">For <strong>${escapeHtml(presentation.targetLabel)}</strong>, decide whether <strong>${escapeHtml(proposedPresentation.valueText)}</strong> should replace <strong>${escapeHtml(currentPresentation.valueText)}</strong>.</p>
      </div>
      <dl class="meta-grid">
        ${metaItem("Item", state.item.metadata.name)}
        ${metaItem("Status", presentation.statusLabel)}
        ${metaItem("Selected", state.item.spec.selectedCandidateId ?? "none")}
        ${metaItem("Candidate count", String(state.item.status?.observedCandidateCount ?? state.item.spec.candidates.length))}
      </dl>
    </header>
  `;
}

function renderReviewMain(state: ReviewWorkbenchState): string {
  return `
    <div class="review-main">
      ${renderReviewFocus(state)}
      ${renderCandidateComparison(state)}
    </div>
  `;
}

function renderReviewFocus(state: ReviewWorkbenchState, presentationAdapter?: ReviewPresentationAdapter): string {
  const current = candidateByRole(state.item, "current");
  const proposed = candidateByRole(state.item, "proposed");
  const proposedConfidence = proposed.extraction.confidence ?? proposed.confidence;
  const currentConfidence = current.extraction.confidence ?? current.confidence;
  const presentation = buildReviewItemPresentation(state.item, presentationAdapter);

  return `
    <section class="review-focus" data-testid="review-focus" aria-label="Active review focus">
      <div class="focus-head">
        <span class="field-label">Active review</span>
        <span class="state-label">${escapeHtml(presentation.statusLabel)}</span>
      </div>
      <div class="focus-values">
        ${focusValue(state.item, current, currentConfidence, "current", presentationAdapter, presentation.targetLabel)}
        ${focusValue(state.item, proposed, proposedConfidence, "proposed", presentationAdapter, presentation.targetLabel)}
      </div>
      <dl class="focus-evidence">
        ${fieldItem("Target", presentation.targetLabel)}
        ${fieldItem("Proposed source", proposed.source.sourceRef)}
        ${fieldItem("Proposed excerpt", proposed.locator?.excerpt ?? "none", "excerpt")}
      </dl>
    </section>
  `;
}

function focusValue(
  item: ReviewItem,
  candidate: ReviewCandidate,
  confidence: number | undefined,
  tone: "current" | "proposed",
  presentationAdapter: ReviewPresentationAdapter | undefined,
  targetLabel: string,
): string {
  const presentation = buildReviewCandidatePresentation(item, candidate, presentationAdapter, targetLabel);
  return `
    <div class="focus-value is-${tone}">
      <span class="field-label">${escapeHtml(presentation.roleLabel)}</span>
      <strong>${escapeHtml(presentation.valueText)}</strong>
      <span>${escapeHtml(confidence === undefined ? "confidence unknown" : formatConfidence(confidence))}</span>
    </div>
  `;
}

function renderCandidateComparison(state: ReviewWorkbenchState, presentationAdapter?: ReviewPresentationAdapter): string {
  const current = candidateByRole(state.item, "current");
  const proposed = candidateByRole(state.item, "proposed");

  return `
    <section class="candidate-grid" aria-label="Candidate comparison">
      ${renderCandidateCard(current, state, presentationAdapter)}
      ${renderCandidateCard(proposed, state, presentationAdapter)}
    </section>
  `;
}

function renderDecisionColumn(state: ReviewWorkbenchState, presentationAdapter?: ReviewPresentationAdapter): string {
  return `
    <aside class="decision-column" aria-label="Review decision">
      ${renderDecisionControls(state)}
      ${renderSurfacePreview(state, presentationAdapter)}
      ${renderDecisionPayload(state)}
    </aside>
  `;
}

function renderDecisionControls(state: ReviewWorkbenchState): string {
  const activeDefinition = state.decision ? workbenchDecisionDefinitions[state.decision] : undefined;

  return `
    <section class="decision-row">
      <div class="decision-buttons">
        ${renderDecisionButtons(state)}
      </div>
      <div class="effect" data-testid="decision-effect">
        <span class="field-label">Decision effect</span>
        <span class="field-value">${escapeHtml(activeDefinition?.effect ?? "No decision selected.")}</span>
      </div>
      <label class="field">
        <span class="field-label">Reviewer note</span>
        <textarea id="reviewer-note" data-testid="reviewer-note">${escapeHtml(state.note)}</textarea>
      </label>
      ${renderFeedbackTags(state)}
    </section>
  `;
}

function renderFeedbackTags(state: ReviewWorkbenchState): string {
  const tags = producerFeedbackTags(state.item);

  return `
    <div class="feedback-tags" data-testid="producer-feedback-tags">
      <span class="field-label">Producer feedback tags</span>
      <div class="tag-row">
        ${tags.length === 0 ? "<span class=\"tag is-empty\">none</span>" : tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
      </div>
    </div>
  `;
}

function renderDecisionButtons(state: ReviewWorkbenchState): string {
  return Object.entries(workbenchDecisionDefinitions).map(([key, definition]) => `
    <button class="decision-button${state.decision === key ? " is-active" : ""}" type="button" data-decision="${key}">
      ${escapeHtml(definition.label)}
    </button>
  `).join("");
}

function renderDecisionPayload(state: ReviewWorkbenchState): string {
  const decision = buildReviewDecision(state);

  return `
    <details class="payload-panel">
      <summary class="field-label">ReviewDecision payload</summary>
      <pre data-testid="decision-payload">${escapeHtml(JSON.stringify(decision ?? null, null, 2))}</pre>
    </details>
  `;
}

function renderSurfacePreview(state: ReviewWorkbenchState, presentationAdapter?: ReviewPresentationAdapter): string {
  const preview = buildSurfaceProjectionPreview(state.item, buildReviewDecision(state), presentationAdapter);

  return preview ? renderPopulatedSurfacePreview(preview) : renderPendingSurfacePreview();
}

function renderPendingSurfacePreview(): string {
  return `
    <section class="surface-preview" data-testid="surface-preview" aria-label="Surface preview">
      <div class="surface-head">
        <h2>Surface preview</h2>
        <span class="state-label">pending</span>
      </div>
      <p class="preview-disclaimer">Choose a review decision to preview the source and review posture that would project toward Surface. Survey does not validate real-world truth.</p>
    </section>
  `;
}

function renderPopulatedSurfacePreview(preview: SurfaceProjectionPreview): string {
  return `
    <section class="surface-preview" data-testid="surface-preview" aria-label="Surface preview">
      <div class="surface-head">
        <h2>Surface preview</h2>
        <span class="state-label">local preview</span>
      </div>
      <p class="preview-disclaimer" data-testid="surface-preview-disclaimer">${escapeHtml(preview.postureDisclaimer)}</p>
      <div class="preview-section-grid">
        ${renderSurfacePreviewSections(preview)}
      </div>
    </section>
  `;
}

function renderSurfacePreviewSections(preview: SurfaceProjectionPreview): string {
  return [
    renderCanonicalClaim(preview),
    renderCandidateHistory(preview),
    renderSourceEvidence(preview),
    renderReviewEvent(preview),
    renderIntegrityPosture(preview),
    renderAuthorityTrace(preview),
  ].join("");
}

function renderCanonicalClaim(preview: SurfaceProjectionPreview): string {
  return renderPreviewSection("Selected claim", "surface-canonical-claim", [
    ["Value", preview.canonicalClaim.value],
    ["Review status", preview.canonicalClaim.status],
  ], undefined, [
    ["Candidate ID", preview.canonicalClaim.candidateId],
    ["Claim ID", preview.canonicalClaim.claimId],
  ]);
}

function renderReviewEvent(preview: SurfaceProjectionPreview): string {
  return renderPreviewSection("Review event", "surface-review-event", [
    ["Actor", preview.reviewEvent?.actor ?? "unknown"],
    ["Reviewed at", preview.reviewEvent?.reviewedAt ?? "not recorded"],
    ["Status", preview.reviewEvent?.status ?? "pending"],
    ["Rationale", preview.reviewEvent?.rationale ?? "No reviewer rationale provided."],
    ["Outcome", preview.reviewEvent?.reviewOutcomeId ?? "not provided"],
  ]);
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
  const rows: Array<readonly [string, string]> = preview.candidateHistory.length === 0
    ? [["History", "No unselected candidates."]]
    : preview.candidateHistory.flatMap((candidate) => [
      ["History", candidate.historyLabel],
      ["Value", candidate.value],
    ] as Array<readonly [string, string]>);
  const references: Array<readonly [string, string]> = preview.candidateHistory.flatMap((candidate) => [
    ["Candidate ID", candidate.candidateId],
  ] as Array<readonly [string, string]>);

  return renderPreviewSection("Unselected candidate history", "surface-candidate-history", rows, undefined, references);
}

function renderSourceEvidence(preview: SurfaceProjectionPreview): string {
  const rows: Array<readonly [string, string]> = [
    ["Source URL", preview.sourceEvidence.sourceRef],
    ["Excerpt", preview.sourceEvidence.excerpt],
    ["Extractor", preview.sourceEvidence.extractor],
    ["Observed", preview.sourceEvidence.observedAt],
  ];
  const references: Array<readonly [string, string]> = [
    ["Source ID", preview.sourceEvidence.sourceId],
    ["Extraction ID", preview.sourceEvidence.extractionId],
  ];

  if (preview.sourceEvidence.sourceAuthority) {
    rows.push(
      ["Source authority class", preview.sourceEvidence.sourceAuthority.authorityClass],
      ["Declared by", preview.sourceEvidence.sourceAuthority.declaredBy],
      ["Authority scope", preview.sourceEvidence.sourceAuthority.scope],
    );
  }

  return renderPreviewSection("Source evidence", "surface-source-evidence", rows);
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

  const appendEvent = (eventType: ReviewSessionEvent["spec"]["eventType"]): void => {
    const state = currentReviewWorkbenchState(session);
    const decision = state.decision;
    const candidate = decision ? candidateForDecision(state.item, decision) : undefined;
    const definition = decision ? workbenchDecisionDefinitions[decision] : undefined;

    events = [
      ...events,
      buildReviewSessionEvent(session, {
        sessionName: defaultReviewSessionName,
        sequence: events.length + 1,
        eventType,
        occurredAt: session.reviewedAt,
        reviewItemName: state.item.metadata.name,
        activeItemName: eventType === "item-selected" ? session.activeItemName : undefined,
        reviewDecisionName: decision ? `${state.item.metadata.name}-${decision}` : undefined,
        candidateId: candidate?.id,
        status: definition?.status,
        rationale: state.note,
        data: decision ? { workbenchDecision: decision } : undefined,
      }),
    ];
  };

  const applySessionUpdate = (update: (current: ReviewQueueSessionState) => ReviewQueueSessionState): void => {
    session = update(session);
  };

  const selectDecision = (decision: ReviewWorkbenchDecision): void => {
    applySessionUpdate((current) => ({
      ...current,
      decisionsByItemName: {
        ...current.decisionsByItemName,
        [currentReviewItem(current).metadata.name]: decision,
      },
    }));
    appendEvent("decision-changed");
    persistEvents();
  };

  const controller = {
    currentState: (): ReviewWorkbenchState => currentReviewWorkbenchState(session),
    currentSession: (): ReviewQueueSessionState => session,
    currentSessionExport: (): ReviewWorkbenchSessionExport => buildReviewWorkbenchSessionExport(session, events),
    goToNextUnresolved: (): void => {
      applyNextUnresolvedSessionUpdate(applySessionUpdate, session);
      appendEvent("item-selected");
      persistEvents();
    },
    renderCurrentState: (): void => renderCurrentState(root, session, controller, options.presentationAdapter),
    selectDecision,
    selectQueueItem: (itemName: string): void => {
      applySessionUpdate((current) => ({ ...current, activeItemName: itemName }));
      appendEvent("item-selected");
      persistEvents();
    },
    updateReviewerNote: (note: string): void => {
      applyReviewerNoteSessionUpdate(applySessionUpdate, session, note);
      appendEvent("note-changed");
      persistEvents();
    },
  };

  return controller;
}

interface ReviewWorkbenchControllerBindings extends ReviewWorkbenchController {
  currentState(): ReviewWorkbenchState;
  currentSession(): ReviewQueueSessionState;
  currentSessionExport(): ReviewWorkbenchSessionExport;
  goToNextUnresolved(): void;
  selectDecision(decision: ReviewWorkbenchDecision): void;
  selectQueueItem(itemName: string): void;
  updateReviewerNote(note: string): void;
}

function applyReviewerNoteSessionUpdate(
  applySessionUpdate: (update: (current: ReviewQueueSessionState) => ReviewQueueSessionState) => void,
  session: ReviewQueueSessionState,
  note: string,
): void {
  const itemName = currentReviewItem(session).metadata.name;
  applySessionUpdate((current) => ({
    ...current,
    notesByItemName: {
      ...current.notesByItemName,
      [itemName]: note,
    },
  }));
}

function applyNextUnresolvedSessionUpdate(
  applySessionUpdate: (update: (current: ReviewQueueSessionState) => ReviewQueueSessionState) => void,
  session: ReviewQueueSessionState,
): void {
  const next = nextUnresolvedItemName(session);
  if (next) {
    applySessionUpdate((current) => ({ ...current, activeItemName: next }));
  }
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
  root.innerHTML = renderReviewWorkbenchHtml(session, controller.currentSessionExport().events, { presentationAdapter });
  bindReviewerNote(
    root,
    controller.updateReviewerNote,
    controller.currentState,
    controller.currentSession,
    controller.currentSessionExport,
    controller.renderCurrentState,
    presentationAdapter,
  );
  bindDecisionButtons(root, (decision) => {
    controller.selectDecision(decision);
    controller.renderCurrentState();
  });
  bindQueueRows(root, (itemName) => {
    controller.selectQueueItem(itemName);
    controller.renderCurrentState();
  });
  bindNextUnresolved(root, () => {
    controller.goToNextUnresolved();
    controller.renderCurrentState();
  });
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
    reviewedAt: startState.reviewedAt,
    actorId: startState.actorId,
  };
}

function bindReviewerNote(
  root: HTMLElement,
  updateReviewerNote: (note: string) => void,
  currentState: () => ReviewWorkbenchState,
  currentSession: () => ReviewQueueSessionState,
  currentSessionExport: () => ReviewWorkbenchSessionExport,
  renderCurrentState: () => void,
  presentationAdapter?: ReviewPresentationAdapter,
): void {
  root.querySelector<HTMLTextAreaElement>("[data-testid='reviewer-note']")?.addEventListener("input", (event) => {
    updateReviewerNote((event.target as HTMLTextAreaElement).value);
    refreshDecisionOutputs(root, currentState(), renderCurrentState, presentationAdapter);
    refreshSessionAudit(root, currentSession(), currentSessionExport(), renderCurrentState);
  });
}

function bindDecisionButtons(root: HTMLElement, selectDecision: (decision: ReviewWorkbenchDecision) => void): void {
  root.querySelectorAll<HTMLButtonElement>("[data-decision]").forEach((button) => {
    button.addEventListener("click", () => {
      selectDecision(button.dataset.decision as ReviewWorkbenchDecision);
    });
  });
}

function bindQueueRows(root: HTMLElement, selectQueueItem: (itemName: string) => void): void {
  root.querySelectorAll<HTMLButtonElement>("[data-item-name]").forEach((button) => {
    button.addEventListener("click", () => {
      selectQueueItem(button.dataset.itemName ?? "");
      scrollActiveReviewIntoView(root);
    });
  });
}

function bindNextUnresolved(root: HTMLElement, goToNextUnresolved: () => void): void {
  root
    .querySelectorAll<HTMLButtonElement>("[data-testid='next-unresolved'], [data-testid='active-next-unresolved']")
    .forEach((button) => {
      button.addEventListener("click", () => {
        goToNextUnresolved();
        scrollActiveReviewIntoView(root);
      });
    });
}

function scrollActiveReviewIntoView(root: HTMLElement): void {
  if (typeof window === "undefined" || !window.matchMedia("(max-width: 980px)").matches) {
    return;
  }

  root.querySelector<HTMLElement>("[data-testid='active-review-strip']")?.scrollIntoView({
    block: "start",
    behavior: "smooth",
  });
}

function refreshDecisionOutputs(
  root: HTMLElement,
  state: ReviewWorkbenchState,
  renderCurrentState: () => void,
  presentationAdapter?: ReviewPresentationAdapter,
): void {
  const payload = root.querySelector<HTMLElement>("[data-testid='decision-payload']");
  if (payload) {
    payload.textContent = JSON.stringify(buildReviewDecision(state) ?? null, null, 2);
  }

  const preview = root.querySelector<HTMLElement>("[data-testid='surface-preview']");
  if (!preview) {
    return;
  }

  if (typeof document === "undefined") {
    renderCurrentState();
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderSurfacePreview(state, presentationAdapter);
  preview.replaceWith(wrapper.firstElementChild as HTMLElement);
}

function refreshSessionAudit(
  root: HTMLElement,
  session: ReviewQueueSessionState,
  sessionExport: ReviewWorkbenchSessionExport,
  renderCurrentState: () => void,
): void {
  const audit = root.querySelector<HTMLElement>("[data-testid='session-audit']");
  if (!audit) {
    return;
  }

  if (typeof document === "undefined") {
    renderCurrentState();
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderSessionAudit(session, sessionExport);
  audit.replaceWith(wrapper.firstElementChild as HTMLElement);
}

function producerFeedbackTags(item: ReviewItem): string[] {
  const tags = item.spec.producerPolicy?.feedbackTags;
  return Array.isArray(tags) ? tags.map(formatValue) : [];
}

function renderCandidateCard(
  candidate: ReviewCandidate,
  state: ReviewWorkbenchState,
  presentationAdapter?: ReviewPresentationAdapter,
): string {
  const selectedRole = selectedCandidateRole(state);
  const candidateState = state.decision
    ? candidate.role === selectedRole ? "selected" : "unselected"
    : "pending";
  const cssState = candidateState === "selected" ? " is-selected" : candidateState === "unselected" ? " is-unselected" : "";
  const confidence = candidate.extraction.confidence ?? candidate.confidence;
  const itemPresentation = buildReviewItemPresentation(state.item, presentationAdapter);
  const presentation = buildReviewCandidatePresentation(state.item, candidate, presentationAdapter, itemPresentation.targetLabel);

  return `
    <article class="candidate-card${cssState}" data-testid="candidate-${escapeHtml(candidate.role ?? candidate.id)}" data-outcome="${candidateState}">
      <div class="card-head">
        <div>
          <p class="eyebrow">${escapeHtml(candidate.role === "proposed" ? "incoming value" : candidate.role === "current" ? "existing value" : "candidate")}</p>
          <h2 class="role">${escapeHtml(presentation.roleLabel)}</h2>
        </div>
        <span class="state-label">${escapeHtml(candidateState)}</span>
      </div>
      <div class="candidate-value">
        <span class="field-label">${escapeHtml(presentation.valueLabel)}</span>
        <p class="field-value">${escapeHtml(presentation.valueText)}</p>
      </div>
      <dl class="field-stack">
        ${fieldItem("Source URL", presentation.sourceText)}
        ${fieldItem("Locator", candidate.locator?.locator ?? candidate.locator?.scheme ?? "none")}
        ${fieldItem("Excerpt", candidate.locator?.excerpt ?? "none", "excerpt")}
        ${fieldItem("Extraction confidence", confidence === undefined ? "unknown" : formatConfidence(confidence))}
        ${fieldItem("Extractor", candidate.extraction.extractor ?? "unknown")}
      </dl>
      <details class="reference-details">
        <summary>IDs and trace links</summary>
        <dl class="field-stack compact">
          ${presentation.traceRefs.map((ref) => fieldItem(ref.label, ref.value)).join("")}
        </dl>
      </details>
    </article>
  `;
}

function candidateByRole(item: ReviewItem, role: "current" | "proposed"): ReviewCandidate {
  const candidate = item.spec.candidates.find((entry) => entry.role === role);
  if (!candidate) {
    throw new Error(`ReviewItem ${item.metadata.name} has no ${role} candidate.`);
  }

  return candidate;
}

function metaItem(label: string, value: unknown): string {
  return `
    <div class="meta-item">
      <dt class="field-label">${escapeHtml(label)}</dt>
      <dd class="meta-value">${escapeHtml(value)}</dd>
    </div>
  `;
}

function fieldItem(label: string, value: unknown, extraClass = ""): string {
  return `
    <div class="field ${extraClass}">
      <dt class="field-label">${escapeHtml(label)}</dt>
      <dd class="field-value">${escapeHtml(value)}</dd>
    </div>
  `;
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}% (${value.toFixed(2)})`;
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
    && typeof value.claimTarget.surface === "string"
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
