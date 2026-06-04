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
