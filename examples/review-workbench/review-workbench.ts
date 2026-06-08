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
  reviewResourceApiVersion,
  type ReviewCandidate,
  type ReviewDecision,
  type ReviewItem,
  type ReviewSession,
  type ReviewSessionEvent,
} from "../../src/review-resource.js";

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
}

export interface ReviewSessionEventStore {
  load(session: ReviewQueueSessionState): readonly ReviewSessionEvent[] | undefined;
  save(session: ReviewQueueSessionState, events: readonly ReviewSessionEvent[]): void;
}

export interface MountReviewWorkbenchOptions {
  readonly eventStore?: ReviewSessionEventStore;
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

export function buildReviewWorkbenchSessionExport(
  session: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[] = buildReviewSessionEvents(session),
): ReviewWorkbenchSessionExport {
  return {
    session: buildReviewSessionResource(session, events),
    events,
    decisions: buildReviewDecisionsFromSession(session),
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

export function renderReviewWorkbenchHtml(state: ReviewWorkbenchState | ReviewQueueSessionState): string {
  if ("items" in state) {
    return renderReviewQueueSessionHtml(state);
  }

  return `
    <section class="workbench-shell" aria-label="Survey review workbench">
      ${renderWorkbenchHeader(state)}
      <div class="content-grid">
        ${renderReviewFocus(state)}
        ${renderCandidateComparison(state)}
        ${renderDecisionColumn(state)}
      </div>
    </section>
  `;
}

function renderReviewQueueSessionHtml(session: ReviewQueueSessionState): string {
  const state = currentReviewWorkbenchState(session);

  return `
    <section class="workbench-shell" aria-label="Survey review workbench">
      ${renderWorkbenchHeader(state)}
      ${renderActiveReviewStrip(session, state)}
      <div class="queue-layout">
        <aside class="queue-panel" aria-label="Review queue">
          ${renderQueueRows(session)}
          ${renderSessionSummary(session)}
        </aside>
        <div class="content-grid">
          ${renderReviewFocus(state)}
          ${renderCandidateComparison(state)}
          ${renderDecisionColumn(state)}
        </div>
      </div>
    </section>
  `;
}

function renderQueueRows(session: ReviewQueueSessionState): string {
  return `
    <section class="queue-list" data-testid="review-queue">
      <div class="queue-head">
        <h2>Review queue</h2>
        <button class="next-button" type="button" data-testid="next-unresolved">Next unresolved</button>
      </div>
      ${session.items.map((item) => renderQueueRow(item, session)).join("")}
    </section>
  `;
}

function renderQueueRow(item: ReviewItem, session: ReviewQueueSessionState): string {
  const status = deriveQueueRowStatus(item, session);
  const isActive = item.metadata.name === session.activeItemName;

  return `
    <button class="queue-row${isActive ? " is-active" : ""}" type="button" data-item-name="${escapeHtml(item.metadata.name)}" data-testid="queue-row" data-queue-status="${status}">
      <span class="queue-row-main">
        <span class="queue-row-title">${escapeHtml(item.metadata.name)}</span>
        <span class="queue-row-target">${escapeHtml(item.spec.target)}</span>
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

function renderActiveReviewStrip(session: ReviewQueueSessionState, state: ReviewWorkbenchState): string {
  const activeIndex = session.items.findIndex((item) => item.metadata.name === session.activeItemName);
  const position = activeIndex >= 0 ? activeIndex + 1 : 1;
  const status = deriveQueueRowStatus(state.item, session);

  return `
    <section class="active-review-strip" data-testid="active-review-strip" aria-label="Active review item">
      <div class="active-review-copy">
        <span class="field-label">Review ${position} of ${session.items.length}</span>
        <strong>${escapeHtml(state.item.metadata.name)}</strong>
        <span>${escapeHtml(state.item.spec.target)}</span>
      </div>
      <div class="active-review-actions">
        <span class="state-label">${escapeHtml(status)}</span>
        <button class="next-button" type="button" data-testid="active-next-unresolved">Next unresolved</button>
      </div>
      <div class="active-review-decisions" aria-label="Quick review decision">
        ${renderDecisionButtons(state)}
      </div>
    </section>
  `;
}

function renderWorkbenchHeader(state: ReviewWorkbenchState): string {
  const current = candidateByRole(state.item, "current");
  const proposed = candidateByRole(state.item, "proposed");

  return `
    <header class="topbar">
      <div>
        <p class="eyebrow">${escapeHtml(String(state.item.metadata.producer?.displayName ?? "Survey"))}</p>
        <h1>Review candidate update</h1>
        <p class="review-question">For <strong>${escapeHtml(state.item.spec.target)}</strong>, decide whether <strong>${escapeHtml(formatValue(proposed.value))}</strong> should replace <strong>${escapeHtml(formatValue(current.value))}</strong>.</p>
      </div>
      <dl class="meta-grid">
        ${metaItem("Item", state.item.metadata.name)}
        ${metaItem("Status", state.item.spec.candidateSetStatus ?? "unresolved")}
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

function renderReviewFocus(state: ReviewWorkbenchState): string {
  const current = candidateByRole(state.item, "current");
  const proposed = candidateByRole(state.item, "proposed");
  const proposedConfidence = proposed.extraction.confidence ?? proposed.confidence;
  const currentConfidence = current.extraction.confidence ?? current.confidence;

  return `
    <section class="review-focus" data-testid="review-focus" aria-label="Active review focus">
      <div class="focus-head">
        <span class="field-label">Active review</span>
        <span class="state-label">${escapeHtml(state.item.spec.candidateSetStatus ?? "unresolved")}</span>
      </div>
      <div class="focus-values">
        ${focusValue("Current", current, currentConfidence, "current")}
        ${focusValue("Proposed", proposed, proposedConfidence, "proposed")}
      </div>
      <dl class="focus-evidence">
        ${fieldItem("Target", state.item.spec.target)}
        ${fieldItem("Proposed source", proposed.source.sourceRef)}
        ${fieldItem("Proposed excerpt", proposed.locator?.excerpt ?? "none", "excerpt")}
      </dl>
    </section>
  `;
}

function focusValue(
  label: string,
  candidate: ReviewCandidate,
  confidence: number | undefined,
  tone: "current" | "proposed",
): string {
  return `
    <div class="focus-value is-${tone}">
      <span class="field-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(formatValue(candidate.value))}</strong>
      <span>${escapeHtml(confidence === undefined ? "confidence unknown" : formatConfidence(confidence))}</span>
    </div>
  `;
}

function renderCandidateComparison(state: ReviewWorkbenchState): string {
  const current = candidateByRole(state.item, "current");
  const proposed = candidateByRole(state.item, "proposed");

  return `
    <section class="candidate-grid" aria-label="Candidate comparison">
      ${renderCandidateCard(current, state)}
      ${renderCandidateCard(proposed, state)}
    </section>
  `;
}

function renderDecisionColumn(state: ReviewWorkbenchState): string {
  return `
    <aside class="decision-column" aria-label="Review decision">
      ${renderDecisionControls(state)}
      ${renderSurfacePreview(state)}
      ${renderDecisionPayload(state)}
    </aside>
  `;
}

function renderDecisionControls(state: ReviewWorkbenchState): string {
  const activeDefinition = state.decision ? workbenchDecisionDefinitions[state.decision] : undefined;

  return `
    <section class="decision-row">
      <label class="field">
        <span class="field-label">Reviewer note</span>
        <textarea id="reviewer-note" data-testid="reviewer-note">${escapeHtml(state.note)}</textarea>
      </label>
      <div class="decision-buttons">
        ${renderDecisionButtons(state)}
      </div>
      <div class="effect" data-testid="decision-effect">
        <span class="field-label">Decision effect</span>
        <span class="field-value">${escapeHtml(activeDefinition?.effect ?? "No decision selected.")}</span>
      </div>
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
    <section class="payload-panel">
      <h2 class="field-label">ReviewDecision payload</h2>
      <pre data-testid="decision-payload">${escapeHtml(JSON.stringify(decision ?? null, null, 2))}</pre>
    </section>
  `;
}

function renderSurfacePreview(state: ReviewWorkbenchState): string {
  const preview = buildSurfaceProjectionPreview(state.item, buildReviewDecision(state));

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
  return renderPreviewSection("Selected canonical claim", "surface-canonical-claim", [
    ["Candidate", preview.canonicalClaim.candidateId],
    ["Claim", preview.canonicalClaim.claimId],
    ["Value", preview.canonicalClaim.value],
    ["Review status", preview.canonicalClaim.status],
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
    ["Candidate set", preview.integrityPosture.candidateSetId],
    ["Raw source", preview.integrityPosture.rawSourceId],
    ["Extraction", preview.integrityPosture.extractionId],
    ["Checksum", preview.integrityPosture.checksum],
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
      ["Candidate", candidate.candidateId],
      ["Value", candidate.value],
    ] as Array<readonly [string, string]>);

  return renderPreviewSection("Unselected candidate history", "surface-candidate-history", rows);
}

function renderSourceEvidence(preview: SurfaceProjectionPreview): string {
  const rows: Array<readonly [string, string]> = [
    ["Source URL", preview.sourceEvidence.sourceRef],
    ["Source ref", preview.sourceEvidence.sourceId],
    ["Excerpt", preview.sourceEvidence.excerpt],
    ["Extraction", preview.sourceEvidence.extractionId],
    ["Extractor", preview.sourceEvidence.extractor],
    ["Observed", preview.sourceEvidence.observedAt],
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
): string {
  return `
    <section class="preview-section${extraClass}" data-testid="${testId}">
      <h3>${escapeHtml(title)}</h3>
      <dl class="field-stack compact">
        ${rows.map(([label, value]) => fieldItem(label, value)).join("")}
      </dl>
    </section>
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
    goToNextUnresolved: (): void => {
      applyNextUnresolvedSessionUpdate(applySessionUpdate, session);
      appendEvent("item-selected");
      persistEvents();
    },
    renderCurrentState: (): void => renderCurrentState(root, session, controller),
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
): void {
  root.innerHTML = renderReviewWorkbenchHtml(session);
  bindReviewerNote(root, controller.updateReviewerNote, controller.currentState, controller.renderCurrentState);
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
  renderCurrentState: () => void,
): void {
  root.querySelector<HTMLTextAreaElement>("[data-testid='reviewer-note']")?.addEventListener("input", (event) => {
    updateReviewerNote((event.target as HTMLTextAreaElement).value);
    refreshDecisionOutputs(root, currentState(), renderCurrentState);
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

function refreshDecisionOutputs(root: HTMLElement, state: ReviewWorkbenchState, renderCurrentState: () => void): void {
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
  wrapper.innerHTML = renderSurfacePreview(state);
  preview.replaceWith(wrapper.firstElementChild as HTMLElement);
}

function producerFeedbackTags(item: ReviewItem): string[] {
  const tags = item.spec.producerPolicy?.feedbackTags;
  return Array.isArray(tags) ? tags.map(String) : [];
}

function renderCandidateCard(candidate: ReviewCandidate, state: ReviewWorkbenchState): string {
  const selectedRole = selectedCandidateRole(state);
  const candidateState = state.decision
    ? candidate.role === selectedRole ? "selected" : "unselected"
    : "pending";
  const cssState = candidateState === "selected" ? " is-selected" : candidateState === "unselected" ? " is-unselected" : "";
  const confidence = candidate.extraction.confidence ?? candidate.confidence;

  return `
    <article class="candidate-card${cssState}" data-testid="candidate-${escapeHtml(candidate.role ?? candidate.id)}" data-outcome="${candidateState}">
      <div class="card-head">
        <div>
          <p class="eyebrow">${escapeHtml(candidate.id)}</p>
          <h2 class="role">${escapeHtml(titleCase(candidate.role ?? "candidate"))}</h2>
        </div>
        <span class="state-label">${escapeHtml(candidateState)}</span>
      </div>
      <div class="candidate-value">
        <span class="field-label">Value</span>
        <p class="field-value">${escapeHtml(formatValue(candidate.value))}</p>
      </div>
      <dl class="field-stack">
        ${fieldItem("Source URL", candidate.source.sourceRef)}
        ${fieldItem("Source ref", candidate.source.sourceId ?? candidate.source.sourceRef)}
        ${fieldItem("Locator", candidate.locator?.locator ?? candidate.locator?.scheme ?? "none")}
        ${fieldItem("Excerpt", candidate.locator?.excerpt ?? "none", "excerpt")}
        ${fieldItem("Extraction confidence", confidence === undefined ? "unknown" : formatConfidence(confidence))}
        ${fieldItem("Extractor", candidate.extraction.extractor ?? "unknown")}
        ${fieldItem("Claim", candidate.claimTarget.claimId ?? candidate.claimTarget.fieldOrBehavior)}
      </dl>
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

function metaItem(label: string, value: string): string {
  return `
    <div class="meta-item">
      <dt class="field-label">${escapeHtml(label)}</dt>
      <dd class="meta-value">${escapeHtml(value)}</dd>
    </div>
  `;
}

function fieldItem(label: string, value: string, extraClass = ""): string {
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

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

if (typeof document !== "undefined") {
  const root = document.querySelector<HTMLElement>("#review-workbench");
  if (root) {
    mountReviewWorkbench(root);
  }
}
