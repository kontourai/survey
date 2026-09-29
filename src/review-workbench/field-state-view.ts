import type { FieldContentState, FieldLifecycleState, FieldState } from "../field-states.js";
import { isScoreBlind, type ReviewQueueSessionState, type ReviewWorkbenchDecision } from "./review-queue-session.js";

const CONTENT_TEXT: Record<FieldContentState, string> = {
  value: "Value found",
  conflicting: "Conflicting values",
  unsupported: "Not supported by verifier",
  excluded: "Proposals excluded",
  not_covered: "Not read",
};

const LIFECYCLE_TEXT: Record<FieldLifecycleState, string> = {
  pending: "Needs review",
  accepted: "Accepted",
  rejected: "Rejected",
  could_not_confirm: "Could not confirm",
  superseded: "Superseded",
};

const WORKBENCH_LIFECYCLE: Record<ReviewWorkbenchDecision, Exclude<FieldLifecycleState, "pending" | "superseded">> = {
  "accept-proposed": "accepted",
  "select-proposed": "accepted",
  "keep-current": "accepted",
  "reject-proposed": "rejected",
  "could-not-confirm": "could_not_confirm",
};

/**
 * The field-state panel: one row per field the extraction was asked for or
 * proposed, with its derived content state, its lifecycle, and its signals.
 * Fields with no review card (not read, only excluded proposals, no proposal)
 * are listed too, so a run that lost content never reads as complete.
 *
 * The lifecycle of a field in the queue is read from the live session, so it
 * follows the reviewer's decisions. Only what the session cannot know comes
 * from the derived states: a decision carried forward from an earlier round,
 * and a superseded one. In a score-blind session a content state derived from
 * verifier records is shown as the state its candidates alone give.
 */
export function renderFieldStatesHtml(states: readonly FieldState[], session: ReviewQueueSessionState): string {
  if (states.length === 0) return "";
  const itemsByName = new Map(session.items.map((item) => [item.metadata.name, item]));
  const rows = states.map((state) => {
    const item = state.reviewItemName !== undefined ? itemsByName.get(state.reviewItemName) : undefined;
    const content = state.content === "unsupported" && isScoreBlind(session)
      ? (item && item.spec.candidates.filter((candidate) => candidate.role === "proposed").length > 1 ? "conflicting" : "value")
      : state.content;
    const live = item ? session.decisionsByItemName[item.metadata.name] : undefined;
    const lifecycle: FieldLifecycleState | undefined = live !== undefined
      ? WORKBENCH_LIFECYCLE[live]
      : state.lifecycle === "superseded" || state.decisionBasis === "carried-forward"
        ? state.lifecycle
        : state.reviewItemName !== undefined ? "pending" : undefined;
    const carried = live === undefined && state.decisionBasis === "carried-forward";
    const signals = [
      ...(state.signals.incompleteRun ? ["The extraction stopped before reading all of the source."] : []),
      ...(state.signals.excludedProposals ? [`${state.signals.excludedProposals} proposal${state.signals.excludedProposals === 1 ? " was" : "s were"} excluded: the excerpt is not at the cited span.`] : []),
      ...(state.signals.unresolvedImport ? ["The import could not ground any value."] : []),
    ];
    const label = `${state.slot.fieldOrBehavior}${state.slot.pathIndices?.length ? `[${state.slot.pathIndices.join("][")}]` : ""}`;
    return `
      <li class="field-state-row" data-testid="field-state" data-field="${escapeHtml(label)}" data-content="${content ?? "none"}" data-lifecycle="${lifecycle ?? "none"}"${carried ? ' data-basis="carried-forward"' : ""}>
        <span class="field-state-name">${escapeHtml(label)}</span>
        <span class="field-state-chips">
          <span class="chip state-content ${content ?? "none"}" data-testid="field-state-content">${escapeHtml(content === undefined ? "No proposal" : CONTENT_TEXT[content])}</span>
          ${lifecycle === undefined ? "" : `<span class="chip state-lifecycle ${lifecycle}" data-testid="field-state-lifecycle">${escapeHtml(LIFECYCLE_TEXT[lifecycle])}${carried ? " · carried forward" : ""}</span>`}
        </span>
        ${content === undefined ? `<span class="field-state-note">No value was proposed. That is not the same as the source not stating one.</span>` : ""}
        ${signals.map((signal) => `<span class="field-state-note signal" data-testid="field-state-signal">${escapeHtml(signal)}</span>`).join("")}
      </li>`;
  }).join("");
  const unread = states.filter((state) => state.content === "not_covered").length;
  return `
    <section class="field-states" data-testid="field-states" aria-label="Field states">
      <h2>Field states</h2>
      ${unread > 0 ? `<p class="field-states-lead" data-testid="field-states-incomplete">${unread} field${unread === 1 ? " was" : "s were"} not read: the extraction stopped short. These fields have no value to review, and that does not mean the source lacks them.</p>` : ""}
      <ul>${rows}</ul>
    </section>
  `;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
