import { publicDirectoryReviewItemFixture } from "./review-workbench-data.js";
import {
  reviewResourceApiVersion,
  type ReviewCandidate,
  type ReviewDecision,
  type ReviewItem,
} from "../../src/review-resource.js";

export type ReviewWorkbenchDecision = "accept-proposed" | "keep-current" | "reject-proposed";

export interface ReviewWorkbenchState {
  readonly item: ReviewItem;
  readonly note: string;
  readonly decision?: ReviewWorkbenchDecision;
  readonly reviewedAt: string;
  readonly actorId: string;
}

export interface SurfaceProjectionPreview {
  readonly canonicalClaim: PreviewClaim;
  readonly candidateHistory: PreviewCandidateHistory[];
  readonly sourceEvidence: PreviewSourceEvidence;
  readonly reviewEvent?: PreviewReviewEvent;
  readonly integrityPosture: PreviewIntegrityPosture;
  readonly authorityTrace: PreviewAuthorityTrace;
  readonly postureDisclaimer: string;
}

export interface PreviewClaim {
  readonly candidateId: string;
  readonly claimId: string;
  readonly value: string;
  readonly status: string;
}

export interface PreviewCandidateHistory {
  readonly candidateId: string;
  readonly value: string;
  readonly historyLabel: string;
}

export interface PreviewSourceEvidence {
  readonly sourceRef: string;
  readonly sourceId: string;
  readonly excerpt: string;
  readonly extractionId: string;
  readonly extractor: string;
  readonly observedAt: string;
  readonly sourceAuthority?: PreviewSourceAuthority;
}

export interface PreviewSourceAuthority {
  readonly authorityClass: string;
  readonly declaredBy: string;
  readonly scope: string;
}

export interface PreviewReviewEvent {
  readonly actor: string;
  readonly reviewedAt: string;
  readonly status: string;
  readonly rationale: string;
  readonly reviewOutcomeId: string;
}

export interface PreviewIntegrityPosture {
  readonly candidateSetId: string;
  readonly rawSourceId: string;
  readonly extractionId: string;
  readonly checksum: string;
}

export interface PreviewAuthorityTrace {
  readonly status: "empty" | "provided";
  readonly label: string;
  readonly detail: string;
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

export function candidateForDecision(item: ReviewItem, decision: ReviewWorkbenchDecision): ReviewCandidate {
  const definition = workbenchDecisionDefinitions[decision];
  const candidate = item.spec.candidates.find((entry) => entry.role === definition.candidateRole);

  if (!candidate) {
    throw new Error(`ReviewItem ${item.metadata.name} has no ${definition.candidateRole} candidate.`);
  }

  return candidate;
}

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

export function buildSurfaceProjectionPreview(
  item: ReviewItem,
  decision: ReviewDecision | undefined,
): SurfaceProjectionPreview | undefined {
  const selectedCandidate = selectedPreviewCandidate(item, decision);
  if (!selectedCandidate || !decision) {
    return undefined;
  }

  const projection = decision.spec.projection ?? selectedCandidate.projection;

  return {
    canonicalClaim: buildPreviewClaim(selectedCandidate, decision, projection),
    candidateHistory: buildCandidateHistory(item, selectedCandidate),
    sourceEvidence: buildSourceEvidence(selectedCandidate),
    reviewEvent: buildReviewEvent(decision, projection),
    integrityPosture: buildIntegrityPosture(item, selectedCandidate, projection),
    authorityTrace: portableAuthorityTrace(selectedCandidate.producer?.authorityTrace),
    postureDisclaimer: postureDisclaimer(),
  };
}

function selectedPreviewCandidate(
  item: ReviewItem,
  decision: ReviewDecision | undefined,
): ReviewCandidate | undefined {
  if (!decision?.spec.candidateId) {
    return undefined;
  }

  const candidate = item.spec.candidates.find((entry) => entry.id === decision.spec.candidateId);
  if (!candidate) {
    throw new Error(`ReviewItem ${item.metadata.name} has no candidate ${decision.spec.candidateId}.`);
  }

  return candidate;
}

function buildPreviewClaim(
  candidate: ReviewCandidate,
  decision: ReviewDecision,
  projection: ReviewDecision["spec"]["projection"] | ReviewCandidate["projection"],
): PreviewClaim {
  return {
    candidateId: candidate.id,
    claimId: projection?.claimId ?? candidate.claimTarget.claimId ?? candidate.claimTarget.fieldOrBehavior,
    value: formatValue(candidate.value),
    status: decision.spec.status,
  };
}

function buildCandidateHistory(item: ReviewItem, selectedCandidate: ReviewCandidate): PreviewCandidateHistory[] {
  return item.spec.candidates
    .filter((candidate) => candidate.id !== selectedCandidate.id)
    .map((candidate) => ({
      candidateId: candidate.id,
      value: formatValue(candidate.value),
      historyLabel: "Unselected candidate history",
    }));
}

function buildSourceEvidence(candidate: ReviewCandidate): PreviewSourceEvidence {
  return {
    sourceRef: candidate.source.sourceRef,
    sourceId: candidate.source.sourceId ?? candidate.source.sourceRef,
    excerpt: candidate.locator?.excerpt ?? "No source excerpt provided.",
    extractionId: candidate.extraction.extractionId ?? "not provided",
    extractor: candidate.extraction.extractor ?? "unknown",
    observedAt: candidate.source.observedAt ?? candidate.source.fetchedAt ?? "unknown",
    sourceAuthority: sourceAuthorityFromProducer(candidate.producer?.sourceAuthority),
  };
}

function buildReviewEvent(
  decision: ReviewDecision,
  projection: ReviewDecision["spec"]["projection"] | ReviewCandidate["projection"],
): PreviewReviewEvent {
  return {
    actor: decision.spec.actor?.id ?? "unknown",
    reviewedAt: decision.spec.reviewedAt ?? "not recorded",
    status: decision.spec.status,
    rationale: decision.spec.rationale || "No reviewer rationale provided.",
    reviewOutcomeId: projection?.reviewOutcomeId ?? "not provided",
  };
}

function buildIntegrityPosture(
  item: ReviewItem,
  candidate: ReviewCandidate,
  projection: ReviewDecision["spec"]["projection"] | ReviewCandidate["projection"],
): PreviewIntegrityPosture {
  return {
    candidateSetId: projection?.candidateSetId ?? item.spec.projection?.candidateSetId ?? "not provided",
    rawSourceId: projection?.rawSourceId ?? candidate.source.sourceId ?? "not provided",
    extractionId: projection?.extractionId ?? candidate.extraction.extractionId ?? "not provided",
    checksum: candidate.source.checksum ?? "not provided",
  };
}

function postureDisclaimer(): string {
  return "Survey records source and review posture for projection; it does not validate real-world truth.";
}

export function renderReviewWorkbenchHtml(state: ReviewWorkbenchState): string {
  return `
    <section class="workbench-shell" aria-label="Survey review workbench">
      ${renderWorkbenchHeader(state)}
      <div class="content-grid">
        ${renderCandidateComparison(state)}
        ${renderDecisionColumn(state)}
      </div>
    </section>
  `;
}

function renderWorkbenchHeader(state: ReviewWorkbenchState): string {
  return `
    <header class="topbar">
      <div>
        <p class="eyebrow">${escapeHtml(String(state.item.metadata.producer?.displayName ?? "Survey"))}</p>
        <h1>${escapeHtml(state.item.metadata.name)}</h1>
      </div>
      <dl class="meta-grid">
        ${metaItem("Target", state.item.spec.target)}
        ${metaItem("Status", state.item.spec.candidateSetStatus ?? "unresolved")}
        ${metaItem("Selected", state.item.spec.selectedCandidateId ?? "none")}
        ${metaItem("Candidate count", String(state.item.status?.observedCandidateCount ?? state.item.spec.candidates.length))}
      </dl>
    </header>
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
    </section>
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

export function mountReviewWorkbench(root: HTMLElement, startState = initialReviewWorkbenchState()): void {
  let state = startState;

  const render = (): void => {
    root.innerHTML = renderReviewWorkbenchHtml(state);
    root.querySelector<HTMLTextAreaElement>("[data-testid='reviewer-note']")?.addEventListener("input", (event) => {
      state = {
        ...state,
        note: (event.target as HTMLTextAreaElement).value,
      };
      const payload = root.querySelector<HTMLElement>("[data-testid='decision-payload']");
      if (payload) {
        payload.textContent = JSON.stringify(buildReviewDecision(state) ?? null, null, 2);
      }
      const preview = root.querySelector<HTMLElement>("[data-testid='surface-preview']");
      if (preview) {
        if (typeof document !== "undefined") {
          const wrapper = document.createElement("div");
          wrapper.innerHTML = renderSurfacePreview(state);
          preview.replaceWith(wrapper.firstElementChild as HTMLElement);
        } else {
          render();
        }
      }
    });
    root.querySelectorAll<HTMLButtonElement>("[data-decision]").forEach((button) => {
      button.addEventListener("click", () => {
        state = {
          ...state,
          decision: button.dataset.decision as ReviewWorkbenchDecision,
        };
        render();
      });
    });
  };

  render();
}

function sourceAuthorityFromProducer(value: unknown): PreviewSourceAuthority | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    authorityClass: String(value.authorityClass ?? "not provided"),
    declaredBy: String(value.declaredBy ?? "not provided"),
    scope: String(value.scope ?? "not provided"),
  };
}

function portableAuthorityTrace(value: unknown): PreviewAuthorityTrace {
  if (Array.isArray(value) && value.length > 0) {
    return {
      status: "provided",
      label: "Portable authority trace provided",
      detail: `${value.length} authority trace entr${value.length === 1 ? "y" : "ies"} supplied by the fixture.`,
    };
  }

  return {
    status: "empty",
    label: "Empty / not provided",
    detail: "No portable authority trace is present. SourceAuthority metadata is shown as source evidence and is not promoted into authorityTrace.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function selectedCandidateRole(state: ReviewWorkbenchState): ReviewCandidate["role"] | undefined {
  if (!state.decision) {
    return undefined;
  }

  return state.decision === "keep-current" || state.decision === "reject-proposed" ? "current" : "proposed";
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

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
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
