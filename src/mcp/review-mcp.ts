import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import {
  attestReviewQueueExtraction,
  buildReviewSessionEvents,
  conflictSelectionIssue,
  currentReviewItem,
  decisionSelectsNoCandidate,
  deriveQueueRowStatus,
  initialReviewQueueSessionState,
  isScoreBlind,
  nextUnresolvedItemName,
  reviewSessionSummary,
  workbenchDecisionDefinitions,
  type ReviewQueueExtractionAttestation,
  type ReviewQueueSessionState,
  type ReviewWorkbenchDecision,
} from "../review-workbench/review-workbench.js";
import type { ExtractionEnvelopeImport } from "../extraction-envelope.js";
import {
  createServerReviewSessionRecord,
  currentSessionState,
  deriveServerReviewSessionApplyResult,
} from "../review-workbench/server-review-session.js";
import type { ReviewItem, ReviewSession, ReviewSessionEvent } from "../review-resource.js";
import { buildReviewItemPresentation, candidateVerificationNotes, excludedProposalsSentence, excludedProposalsUnreadableSentence } from "../review-workbench/review-presentation.js";
import {
  appendReviewSessionEvents,
  readReviewSessionFile,
  storedReviewSessionName,
  updateReviewSessionFile,
} from "../review-session-file.js";

const SESSION_NAME = "mcp-review-session";

const UI_RESOURCE_URI_META_KEY = "ui/resourceUri";
const UI_CAPABILITY_EXTENSION = "io.modelcontextprotocol/ui";
const QUEUE_PANEL_URI = "ui://survey/review-card/queue";
const UI_RESOURCE_MIME = "text/html;profile=mcp-app";
const SERVER_INSTRUCTIONS =
  "Use survey_review_queue to inspect the queue, survey_review_item to drill into one item, and survey_review_decide to record a decision. Decisions are validated and persisted to the session file and are irreversible within this session.";

// MCP tool decision strings → ReviewWorkbenchDecision
const MCP_DECISION_MAP: Record<string, ReviewWorkbenchDecision> = {
  accept: "accept-proposed",
  select: "select-proposed",
  hold: "keep-current",
  reject: "reject-proposed",
  "could-not-confirm": "could-not-confirm",
};

interface ReviewMcpOptions {
  readonly sessionPath: string;
  readonly noUi: boolean;
}

// ---- Session file format --------------------------------------------------

interface SessionFileContent {
  readonly session: ReviewSession;
  readonly snapshot: ReviewQueueSessionState;
  readonly events: readonly ReviewSessionEvent[];
  /** The extraction import record the snapshot's items were built from, stored beside them. */
  readonly extractionImport?: ExtractionEnvelopeImport;
}

interface AttestedSessionFile extends SessionFileContent {
  readonly attestation: ReviewQueueExtractionAttestation;
}

/**
 * Reads the session and checks its queue against the extraction import stored
 * beside it. A queue that does not match its import is refused outright; one
 * whose items came from an import but has no record stored is presented with
 * an "Unverified queue" notice on every surface.
 */
async function readSessionFile(path: string): Promise<AttestedSessionFile> {
  const file = await readReviewSessionFile<SessionFileContent>(path);
  return { ...file, attestation: attestedQueue(file) };
}

function attestedQueue(file: SessionFileContent): ReviewQueueExtractionAttestation {
  const attestation = attestReviewQueueExtraction(file.snapshot.items, file.extractionImport);
  if (attestation.state === "diverges") {
    throw new DomainError(attestation.message);
  }
  return attestation;
}

function attestationLines(attestation: ReviewQueueExtractionAttestation): string[] {
  return attestation.state === "unverified" ? [attestation.message, ``] : [];
}

/**
 * A score-blind session shows no confidence and no verifier result on any
 * surface (text, data or card), so the decision is made without them.
 */
const SCORE_BLIND_NOTICE = "Score-blind review: confidence and verifier results are hidden for this whole session. Decide from the source and its excerpt.";

function scoreBlindLines(state: ReviewQueueSessionState): string[] {
  return isScoreBlind(state) ? [`${state.sampling?.kind === "random-audit" ? "Random audit sample. " : ""}${SCORE_BLIND_NOTICE}`, ``] : [];
}

// ---- Queue helpers -------------------------------------------------------

function queueSummaryText(snapshot: ReviewQueueSessionState, events: readonly ReviewSessionEvent[], attestation: ReviewQueueExtractionAttestation): string {
  const current = currentSessionState(snapshot, events);
  const summary = reviewSessionSummary(current);
  const total = current.items.length;
  const resolved = total - summary.unresolved;
  const activeItem = currentReviewItem(current);
  const nextItem = nextUnresolvedItemName(current);

  const rows = current.items.map((item) => {
    const status = deriveQueueRowStatus(item, current);
    const isActive = item.metadata.name === current.activeItemName;
    const marker = isActive ? " [active]" : "";
    return `  ${item.metadata.name} — ${item.spec.target} — ${status}${marker}`;
  });

  return [
    ...attestationLines(attestation),
    ...scoreBlindLines(current),
    `Review queue: ${resolved}/${total} resolved`,
    `Active item: ${activeItem.metadata.name} (${activeItem.spec.target})`,
    ...(nextItem ? [`Next unresolved: ${nextItem}`] : ["All items resolved."]),
    ``,
    `Session summary: accepted=${summary.accepted} keptCurrent=${summary.keptCurrent} rejected=${summary.rejected} couldNotConfirm=${summary.couldNotConfirm ?? 0} escalated=${summary.escalated} unresolved=${summary.unresolved}`,
    ``,
    `Items:`,
    ...rows,
  ].join("\n");
}

function itemDetailText(item: ReviewItem, snapshot: ReviewQueueSessionState, events: readonly ReviewSessionEvent[], attestation: ReviewQueueExtractionAttestation): string {
  const current = currentSessionState(snapshot, events);
  const status = deriveQueueRowStatus(item, current);
  const decision = current.decisionsByItemName[item.metadata.name];
  const note = current.notesByItemName[item.metadata.name];
  const chosenId = decision === "select-proposed" ? current.selectedCandidateIdsByItemName?.[item.metadata.name] : undefined;

  const currentCandidate = item.spec.candidates.find((c) => c.role === "current");
  const proposedCandidates = item.spec.candidates.filter((c) => c.role === "proposed");

  const valueStr = (v: unknown): string =>
    typeof v === "string" ? v : JSON.stringify(v);

  const confStr = (c: number | undefined): string =>
    c !== undefined ? `${Math.round(c * 100)}%` : "unknown";
  const blind = isScoreBlind(current);
  const confidenceLine = (c: number | undefined): string[] => blind ? [] : [`  confidence: ${confStr(c)}`];

  const lines: string[] = [
    ...attestationLines(attestation),
    ...scoreBlindLines(current),
    `Item: ${item.metadata.name}`,
    `Target: ${item.spec.target}`,
    `Status: ${status}`,
    `Candidate set status: ${item.spec.candidateSetStatus ?? "unknown"}`,
    ...(decision ? [`Decision: ${decision}`] : []),
    ...(note ? [`Note: ${note}`] : []),
    ``,
    `Current value: ${valueStr(currentCandidate?.value ?? "(none)")}`,
    ...confidenceLine(currentCandidate?.extraction?.confidence ?? currentCandidate?.confidence),
    `  source: ${currentCandidate?.source?.sourceRef ?? "none"}`,
    ...(currentCandidate?.locator?.excerpt ? [`  excerpt: ${currentCandidate.locator.excerpt}`] : []),
    ``,
    ...(proposedCandidates.length > 1
      ? [`Conflict: ${proposedCandidates.length} proposed values. Accept is refused; choose one with decision "select" and its candidateId, reject them all, or use could-not-confirm with a reason.`]
      : []),
    ...(chosenId !== undefined
      ? [`Chosen value: ${valueStr(proposedCandidates.find((c) => c.id === chosenId)?.value)} (candidate ${chosenId}); not chosen: ${proposedCandidates.filter((c) => c.id !== chosenId).map((c) => `${valueStr(c.value)} (candidate ${c.id})`).join(", ")}`]
      : []),
    ...(proposedCandidates.length === 0 ? [`Proposed value: (none)`] : proposedCandidates.flatMap((candidate) => [
      `Proposed value: ${valueStr(candidate.value)}${chosenId === undefined ? "" : candidate.id === chosenId ? " [chosen]" : " [not chosen]"}`,
      ...(proposedCandidates.length > 1 ? [`  candidateId: ${candidate.id}`] : []),
      ...confidenceLine(candidate.extraction?.confidence ?? candidate.confidence),
      `  source: ${candidate.source?.sourceRef ?? "none"}`,
      ...(candidate.locator?.excerpt ? [`  excerpt: ${candidate.locator.excerpt}`] : []),
    ])),
    ...extractionImportLines(item),
    ...(blind ? [] : candidateVerificationNotes(item, editedValueFor(item, current)).flatMap((entry) => [``, `Verification: ${entry.sentence}`])),
  ];

  if (item.spec.rationale) {
    lines.push(``, `Rationale: ${item.spec.rationale}`);
  }

  return lines.join("\n");
}

/** The reviewer's edit when the item's decision accepts one; verifier records are read against it. */
/** The session's presentation and sampling, as a client should read them. */
function sessionConditions(snapshot: ReviewQueueSessionState): Record<string, unknown> {
  return {
    ...(snapshot.presentation !== undefined ? { presentation: snapshot.presentation } : {}),
    ...(snapshot.sampling !== undefined ? { sampling: snapshot.sampling } : {}),
  };
}

function editedValueFor(item: ReviewItem, state: ReviewQueueSessionState): unknown {
  return state.decisionsByItemName[item.metadata.name] === "accept-proposed" ? state.editedValuesByItemName?.[item.metadata.name] : undefined;
}

/** What an envelope import says about the item's evidence, including rival values it excluded. */
function extractionImportLines(item: ReviewItem): string[] {
  const presentation = buildReviewItemPresentation(item);
  const excluded = excludedProposalsSentence(presentation.excludedProposals);
  const unreadable = excludedProposalsUnreadableSentence(presentation.excludedProposalsUnreadable);
  return [
    ...(excluded ? [``, `Excluded: ${excluded} Check the source before accepting.`] : []),
    ...(unreadable ? [``, `Excluded: ${unreadable} Check the source before accepting.`] : []),
    ...(presentation.excerptVerification ? [``, `Excerpts ${presentation.excerptVerification === "verified" ? "were" : "were not"} checked against the prepared source text at import.`] : []),
  ];
}

// ---- UI card -------------------------------------------------------------

function escapeJsonInHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildReviewCardHtml(
  item: ReviewItem,
  snapshot: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[],
  attestation: ReviewQueueExtractionAttestation,
): string {
  const current = currentSessionState(snapshot, events);
  const summary = reviewSessionSummary(current);
  const total = current.items.length;
  const resolved = total - summary.unresolved;

  const currentCandidate = item.spec.candidates.find((c) => c.role === "current");
  const proposedCandidates = item.spec.candidates.filter((c) => c.role === "proposed");
  // Several proposed values are a conflict: every value is shown, accept
  // (which names a role, not a value) is not offered, and each value has its
  // own "Use this value" control that names its candidate id.
  const conflict = proposedCandidates.length > 1;
  const decision = current.decisionsByItemName[item.metadata.name];
  const chosenId = decision === "select-proposed" ? current.selectedCandidateIdsByItemName?.[item.metadata.name] : undefined;
  const status = deriveQueueRowStatus(item, current);

  const valueStr = (v: unknown): string =>
    typeof v === "string" ? v : JSON.stringify(v, null, 2);

  const confStr = (c: number | undefined): string =>
    c !== undefined ? `${Math.round(c * 100)}%` : "—";
  const blind = isScoreBlind(current);
  const confHtml = (c: number | undefined): string => blind ? "" : `<div class="conf">confidence ${confStr(c)}</div>`;

  const currentValue = valueStr(currentCandidate?.value ?? "—");
  const currentConf = confHtml(currentCandidate?.extraction?.confidence ?? currentCandidate?.confidence);
  const currentSource = currentCandidate?.source?.sourceRef ?? "—";
  const currentExcerpt = currentCandidate?.locator?.excerpt ?? "";
  const proposedCard = (candidate: ReviewItem["spec"]["candidates"][number] | undefined, label: string): string => {
    const value = valueStr(candidate?.value ?? "—");
    const excerpt = candidate?.locator?.excerpt ?? "";
    const choice = conflict && candidate
      ? chosenId !== undefined
        ? `<div class="choice ${candidate.id === chosenId ? "chosen" : "not-chosen"}" data-candidate-id="${escapeHtml(candidate.id)}">${candidate.id === chosenId ? "Chosen" : "Not chosen"}</div>`
        : decision === undefined
          ? `<button class="btn btn-accept btn-select" data-candidate-id="${escapeHtml(candidate.id)}">Use this value</button>`
          : ""
      : "";
    return `<div class="card is-proposed"${conflict && candidate ? ` data-candidate-id="${escapeHtml(candidate.id)}"` : ""}>
    <div class="card-label">${escapeHtml(label)}</div>
    <div class="value">${value.includes("\n") ? `<pre>${escapeHtml(value)}</pre>` : escapeHtml(value)}</div>
    ${confHtml(candidate?.extraction?.confidence ?? candidate?.confidence)}
    <div class="source-ref">${escapeHtml(candidate?.source?.sourceRef ?? "—")}</div>
    ${excerpt ? `<div class="excerpt">${escapeHtml(excerpt)}</div>` : ""}
    ${choice}
  </div>`;
  };
  const proposedCards = conflict
    ? proposedCandidates.map((candidate, index) => proposedCard(candidate, `Proposed ${index + 1} of ${proposedCandidates.length}`)).join("\n  ")
    : proposedCard(proposedCandidates[0], "Proposed");

  const itemNameJson = escapeJsonInHtml(item.metadata.name);
  const itemPresentation = buildReviewItemPresentation(item);
  const excludedNote = excludedProposalsSentence(itemPresentation.excludedProposals);
  const unreadableNote = excludedProposalsUnreadableSentence(itemPresentation.excludedProposalsUnreadable);
  const verificationNotes = blind ? [] : candidateVerificationNotes(item, editedValueFor(item, current));

  const decisionBadge = decision
    ? `<span class="badge badge-${decision === "accept-proposed" || decision === "select-proposed" ? "accept" : decision === "reject-proposed" ? "reject" : "hold"}">${escapeHtml(decision === "select-proposed" ? `Chose 1 of ${proposedCandidates.length} values` : workbenchDecisionDefinitions[decision].label)}</span>`
    : `<span class="badge badge-pending">${escapeHtml(status)}</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review: ${escapeHtml(item.spec.target)}</title>
<style>
:root {
  color-scheme: dark;
  --k-bg: #0a0e13;
  --k-panel: #111824;
  --k-panel-raised: #16202d;
  --k-line: rgba(150,180,210,0.12);
  --k-line-strong: rgba(150,180,210,0.22);
  --k-text: #eef3f8;
  --k-text-muted: #aebccb;
  --k-text-faint: #75889d;
  --k-brand: #5ce0c6;
  --k-positive: #34d399;
  --k-caution: #f3b14b;
  --k-negative: #ff6f6f;
  --k-active: #7aa2ff;
  --k-radius-sm: 9px;
  --k-radius-md: 14px;
  --k-font-ui: "Hanken Grotesk",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --k-font-mono: "IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --k-bg: #f5f4ef;
    --k-panel: #ffffff;
    --k-panel-raised: #fbfaf7;
    --k-line: rgba(36,40,46,0.12);
    --k-line-strong: rgba(36,40,46,0.20);
    --k-text: #202124;
    --k-text-muted: #5b626b;
    --k-text-faint: #6a707b;
    /* The dark brand (#5ce0c6) reads at ~1.6:1 on the light canvas; the eyebrow
       and source link use --k-brand as text, so light mode takes @kontourai/ui's
       survey light brand, retinted in 1.18 to clear 4.5:1. */
    --k-brand: #107e6d;
    --k-positive: #168257;
    --k-caution: #8a5a00;
    --k-negative: #c83b3b;
    --k-active: #3f6fd6;
  }
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:var(--k-font-ui);font-size:13px;background:var(--k-bg);color:var(--k-text);padding:14px}
h1{font-size:15px;font-weight:700;margin:0 0 4px}
.eyebrow{font-family:var(--k-font-mono);font-size:10px;color:var(--k-brand);text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px}
.meta{font-size:11px;color:var(--k-text-muted);margin:0 0 12px;display:flex;gap:10px;flex-wrap:wrap}
.progress{font-family:var(--k-font-mono);font-size:10px;color:var(--k-text-faint)}
.card-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
.card{background:var(--k-panel);border:1px solid var(--k-line);border-radius:var(--k-radius-sm);padding:10px}
.card-label{font-family:var(--k-font-mono);font-size:10px;color:var(--k-text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
.card.is-proposed .card-label{color:var(--k-active)}
.value{font-size:14px;font-weight:700;margin:0 0 6px;word-break:break-word}
.value pre{font-family:var(--k-font-mono);font-size:11px;margin:0;white-space:pre-wrap;word-break:break-word}
.conf{font-size:11px;color:var(--k-text-muted)}
.source-ref{font-size:10px;color:var(--k-brand);word-break:break-all;margin-top:4px}
.excerpt{font-size:11px;color:var(--k-text-faint);font-style:italic;margin-top:3px}
.divider{height:1px;background:var(--k-line);margin:12px 0}
.badge{display:inline-block;font-family:var(--k-font-mono);font-size:10px;padding:2px 7px;border-radius:4px;font-weight:600;letter-spacing:.04em}
.badge-pending{background:color-mix(in srgb,var(--k-active) 14%,transparent);color:var(--k-active)}
.badge-accept{background:color-mix(in srgb,var(--k-positive) 14%,transparent);color:var(--k-positive)}
.badge-hold{background:color-mix(in srgb,var(--k-caution) 14%,transparent);color:var(--k-caution)}
.badge-reject{background:color-mix(in srgb,var(--k-negative) 14%,transparent);color:var(--k-negative)}
.note-label{font-size:11px;color:var(--k-text-muted);margin-bottom:4px}
.note-input{width:100%;background:var(--k-panel-raised);border:1px solid var(--k-line-strong);border-radius:var(--k-radius-sm);color:var(--k-text);font:inherit;font-size:12px;padding:7px 10px;resize:vertical;min-height:52px}
.note-input:focus{outline:2px solid var(--k-brand);outline-offset:1px;border-color:transparent}
.btn-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.btn{padding:9px 4px;border:1px solid var(--k-line-strong);border-radius:var(--k-radius-sm);background:var(--k-panel-raised);color:var(--k-text-muted);font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:background .12s,color .12s,border-color .12s}
.btn:hover{background:var(--k-panel);border-color:var(--k-brand);color:var(--k-text)}
.btn-accept:hover,.btn-accept.active{background:color-mix(in srgb,var(--k-positive) 16%,transparent);border-color:var(--k-positive);color:var(--k-positive)}
.btn-hold:hover,.btn-hold.active{background:color-mix(in srgb,var(--k-caution) 16%,transparent);border-color:var(--k-caution);color:var(--k-caution)}
.btn-reject:hover,.btn-reject.active{background:color-mix(in srgb,var(--k-negative) 16%,transparent);border-color:var(--k-negative);color:var(--k-negative)}
.btn-unconfirmed:hover,.btn-unconfirmed.active{background:color-mix(in srgb,var(--k-caution) 16%,transparent);border-color:var(--k-caution);color:var(--k-caution)}
.feedback{font-size:11px;color:var(--k-text-faint);margin-top:8px;min-height:16px}
.btn-select{width:100%;margin-top:8px}
.choice{font-family:var(--k-font-mono);font-size:10px;font-weight:600;margin-top:8px;text-transform:uppercase;letter-spacing:.06em}
.choice.chosen{color:var(--k-positive)}
.choice.not-chosen{color:var(--k-text-faint)}
.notice{font-size:11px;color:var(--k-caution);background:color-mix(in srgb,var(--k-caution) 12%,transparent);border-radius:var(--k-radius-sm);padding:7px 10px;margin:0 0 12px}
</style>
</head>
<body>
${attestation.state === "unverified" ? `<p class="notice" id="unverified-queue-note">${escapeHtml(attestation.message)}</p>` : ""}
${blind ? `<p class="notice" id="score-blind-note">${escapeHtml(scoreBlindLines(current)[0]!)}</p>` : ""}
<p class="eyebrow">Survey Review</p>
<h1>${escapeHtml(item.spec.target)}</h1>
<div class="meta">
  <span>${escapeHtml(item.metadata.name)}</span>
  ${decisionBadge}
  ${conflict ? `<span class="badge badge-hold" id="conflict-badge">Conflict: ${proposedCandidates.length} values</span>` : ""}
  <span class="progress">${resolved}/${total} resolved</span>
</div>

<div class="card-grid">
  <div class="card">
    <div class="card-label">Current</div>
    <div class="value">${currentValue.includes("\n") ? `<pre>${escapeHtml(currentValue)}</pre>` : escapeHtml(currentValue)}</div>
    ${currentConf}
    <div class="source-ref">${escapeHtml(currentSource)}</div>
    ${currentExcerpt ? `<div class="excerpt">${escapeHtml(currentExcerpt)}</div>` : ""}
  </div>
  ${proposedCards}
</div>
${excludedNote ? `<p class="feedback" id="excluded-note">${escapeHtml(excludedNote)}</p>` : ""}
${unreadableNote ? `<p class="feedback" id="excluded-unreadable-note">${escapeHtml(unreadableNote)}</p>` : ""}
${verificationNotes.map((entry) => `<p class="feedback verification-note" data-candidate-id="${escapeHtml(entry.candidateId)}">${escapeHtml(entry.sentence)}</p>`).join("\n")}
${conflict ? `<p class="feedback" id="conflict-note">${escapeHtml(chosenId !== undefined
    ? `${proposedCandidates.length} different values were proposed. One was chosen; ${proposedCandidates.length === 2 ? "the other was" : "the others were"} seen and not chosen.`
    : `${proposedCandidates.length} different values were proposed. Use the value the source supports, reject them all, or use Could not confirm with a reason.`)}</p>` : ""}

<div class="divider"></div>

<div class="note-label">Reviewer note (required for Could not confirm)</div>
<textarea class="note-input" id="note" placeholder="Add a rationale for this decision...">${escapeHtml(current.notesByItemName[item.metadata.name] ?? "")}</textarea>

<div class="btn-row">
  ${conflict ? "" : `<button class="btn btn-accept${decision === "accept-proposed" ? " active" : ""}" id="btn-accept">Accept proposed</button>`}
  ${currentCandidate ? `<button class="btn btn-hold${decision === "keep-current" ? " active" : ""}" id="btn-hold">Hold / Keep current</button>` : ""}
  <button class="btn btn-reject${decision === "reject-proposed" ? " active" : ""}" id="btn-reject">${conflict ? "Reject all values" : "Reject proposed"}</button>
  <button class="btn btn-unconfirmed${decision === "could-not-confirm" ? " active" : ""}" id="btn-unconfirmed">Could not confirm</button>
</div>
<div class="feedback" id="feedback"></div>

<script>
(function () {
  var itemName = ${itemNameJson};
  var msgId = 1;

  function postDecision(decision, candidateId) {
    var note = document.getElementById('note').value;
    if (decision === 'could-not-confirm' && !note.trim()) {
      document.getElementById('feedback').textContent = 'A reason is required when you could not confirm.';
      document.getElementById('note').focus();
      return false;
    }
    window.parent.postMessage({
      jsonrpc: "2.0",
      id: msgId++,
      method: "tools/call",
      params: {
        name: "survey_review_decide",
        arguments: decision === 'could-not-confirm'
          ? { itemName: itemName, decision: decision, reason: note }
          : decision === 'select'
            ? { itemName: itemName, decision: decision, candidateId: candidateId, note: note || undefined }
            : { itemName: itemName, decision: decision, note: note || undefined }
      }
    }, "*");
    return true;
  }

  Array.prototype.forEach.call(document.querySelectorAll('.btn-select'), function (button) {
    button.addEventListener('click', function () { postDecision('select', button.getAttribute('data-candidate-id')); document.getElementById('feedback').textContent = 'Submitting choice…'; });
  });

  var acceptButton = document.getElementById('btn-accept');
  if (acceptButton) acceptButton.addEventListener('click', function () { postDecision('accept'); document.getElementById('feedback').textContent = 'Submitting accept…'; });
  var holdButton = document.getElementById('btn-hold');
  if (holdButton) holdButton.addEventListener('click', function () { postDecision('hold'); document.getElementById('feedback').textContent = 'Submitting hold…'; });
  document.getElementById('btn-reject').addEventListener('click', function () { postDecision('reject'); document.getElementById('feedback').textContent = 'Submitting reject…'; });
  document.getElementById('btn-unconfirmed').addEventListener('click', function () { if (postDecision('could-not-confirm')) document.getElementById('feedback').textContent = 'Submitting could not confirm…'; });

  window.addEventListener('message', function (evt) {
    var data = evt.data;
    if (data && data.jsonrpc === '2.0' && data.result) {
      if (data.result.isError) {
        document.getElementById('feedback').textContent = 'Error: ' + (data.result.content && data.result.content[0] && data.result.content[0].text || 'unknown');
      } else {
        document.getElementById('feedback').textContent = 'Decision recorded.';
      }
    }
  });
}());
</script>
</body>
</html>`;
}

// ---- Tool implementations ------------------------------------------------

async function toolQueue(options: ReviewMcpOptions): Promise<ContentItem[]> {
  const file = await readSessionFile(options.sessionPath);
  const { snapshot, events, attestation } = file;

  const text = queueSummaryText(snapshot, events, attestation);
  const queueData = {
    queueAttestation: attestation.state,
    ...sessionConditions(snapshot),
    items: snapshot.items.map((item) => {
      const current = currentSessionState(snapshot, events);
      const selectedCandidateId = current.decisionsByItemName[item.metadata.name] === "select-proposed"
        ? current.selectedCandidateIdsByItemName?.[item.metadata.name]
        : undefined;
      return {
        name: item.metadata.name,
        target: item.spec.target,
        status: deriveQueueRowStatus(item, current),
        decision: current.decisionsByItemName[item.metadata.name],
        ...(selectedCandidateId !== undefined ? { selectedCandidateId } : {}),
        candidateSetStatus: item.spec.candidateSetStatus,
      };
    }),
    summary: reviewSessionSummary(currentSessionState(snapshot, events)),
    activeItemName: currentSessionState(snapshot, events).activeItemName,
  };

  const content: ContentItem[] = [
    { type: "text", text: `${text}\n\n${JSON.stringify(queueData, null, 2)}` },
  ];

  if (!options.noUi) {
    const activeItem = currentReviewItem(currentSessionState(snapshot, events));
    content.push(buildUiResource(activeItem, snapshot, events, "queue", attestation));
  }

  return content;
}

async function toolItem(itemName: string, options: ReviewMcpOptions): Promise<ContentItem[]> {
  const file = await readSessionFile(options.sessionPath);
  const { snapshot, events, attestation } = file;
  const current = currentSessionState(snapshot, events);

  const item = current.items.find((i) => i.metadata.name === itemName);
  if (!item) {
    throw new DomainError(`Unknown review item: ${itemName}`);
  }

  const text = itemDetailText(item, snapshot, events, attestation);
  const decision = current.decisionsByItemName[item.metadata.name];
  const selectedCandidateId = decision === "select-proposed" ? current.selectedCandidateIdsByItemName?.[item.metadata.name] : undefined;
  const blind = isScoreBlind(current);
  const itemData = {
    queueAttestation: attestation.state,
    ...sessionConditions(snapshot),
    name: item.metadata.name,
    target: item.spec.target,
    status: deriveQueueRowStatus(item, current),
    decision,
    ...(selectedCandidateId !== undefined ? { selectedCandidateId } : {}),
    note: current.notesByItemName[item.metadata.name],
    candidateSetStatus: item.spec.candidateSetStatus,
    ...(() => {
      const presentation = buildReviewItemPresentation(item);
      return {
        ...(presentation.excerptVerification ? { excerptVerification: presentation.excerptVerification } : {}),
        ...(presentation.excludedProposals.length ? { excludedProposals: presentation.excludedProposals.map(({ proposalIndex, value, locator, excerpt }) => ({ proposalIndex, value, locator, excerpt })) } : {}),
        ...(presentation.excludedProposalsUnreadable ? { excludedProposalsUnreadable: presentation.excludedProposalsUnreadable } : {}),
      };
    })(),
    candidates: (() => {
      const notes = blind ? [] : candidateVerificationNotes(item, editedValueFor(item, current));
      return item.spec.candidates.map((c, index) => {
        const note = notes.find((entry) => entry.candidateIndex === index);
        return {
          id: c.id,
          role: c.role,
          value: c.value,
          ...(blind ? {} : { confidence: c.extraction?.confidence ?? c.confidence }),
          sourceRef: c.source?.sourceRef,
          excerpt: c.locator?.excerpt,
          ...(selectedCandidateId !== undefined && c.role === "proposed" ? { chosen: c.id === selectedCandidateId } : {}),
          ...(note ? { verification: { subject: note.subjectLabel, status: note.status, records: note.records, inapplicableCount: note.inapplicableCount, rejectedCount: note.rejectedCount } } : {}),
        };
      });
    })(),
  };

  const content: ContentItem[] = [
    { type: "text", text: `${text}\n\n${JSON.stringify(itemData, null, 2)}` },
  ];

  if (!options.noUi) {
    content.push(buildUiResource(item, snapshot, events, itemName, attestation));
  }

  return content;
}

async function toolDecide(
  itemName: string,
  mcpDecision: string,
  note: string | undefined,
  attemptEvidenceIds: readonly string[] | undefined,
  options: ReviewMcpOptions,
  selectedCandidateId?: string,
): Promise<ContentItem[]> {
  const wbDecision = MCP_DECISION_MAP[mcpDecision];
  if (!wbDecision) {
    throw new DomainError(`Invalid decision: ${mcpDecision}. Must be accept, select, hold, reject, or could-not-confirm.`);
  }
  if (wbDecision === "could-not-confirm" && !note?.trim()) {
    throw new DomainError("survey_review_decide requires a non-empty reason for could-not-confirm");
  }

  // Read, validate and write inside the shared session lock so a concurrent
  // decide or console save cannot interleave and drop this decision (#281).
  const { snapshot, sessionWithDecision, newEvents, attestation } = await updateReviewSessionFile<SessionFileContent, {
    snapshot: ReviewQueueSessionState;
    sessionWithDecision: ReviewQueueSessionState;
    newEvents: ReviewSessionEvent[];
    attestation: ReviewQueueExtractionAttestation;
  }>(options.sessionPath, (file) => {
    const { snapshot, events } = file;
    const attestation = attestedQueue(file);
    const current = currentSessionState(snapshot, events);

    const item = current.items.find((i) => i.metadata.name === itemName);
    if (!item) {
      throw new DomainError(`Unknown review item: ${itemName}`);
    }

    const existingDecision = current.decisionsByItemName[item.metadata.name];
    if (existingDecision) {
      throw new DomainError(`Item ${itemName} already has a decision: ${existingDecision}. Use a new session to re-decide.`);
    }
    if (wbDecision === "select-proposed") {
      const selectionIssue = conflictSelectionIssue(item, selectedCandidateId);
      if (selectionIssue) {
        throw new DomainError(selectionIssue);
      }
    }

    // Build the updated session state with the decision
    const sessionWithDecision: ReviewQueueSessionState = {
      ...current,
      decisionsByItemName: {
        ...current.decisionsByItemName,
        [itemName]: wbDecision,
      },
      ...(note !== undefined
        ? {
            notesByItemName: {
              ...current.notesByItemName,
              [itemName]: note,
            },
          }
        : {}),
      ...(attemptEvidenceIds?.length
        ? {
            attemptEvidenceIdsByItemName: {
              ...current.attemptEvidenceIdsByItemName,
              [itemName]: [...attemptEvidenceIds],
            },
          }
        : {}),
      ...(wbDecision === "select-proposed" && selectedCandidateId !== undefined
        ? {
            selectedCandidateIdsByItemName: {
              ...current.selectedCandidateIdsByItemName,
              [itemName]: selectedCandidateId,
            },
          }
        : {}),
    };

    // Append only this decision's events (its note, then the decision) to the
    // stored log. Regenerating the whole log from state would erase earlier
    // reversals and note changes recorded by the console (#281).
    const sessionName = storedReviewSessionName(file, SESSION_NAME);
    const decisionEvents = buildReviewSessionEvents(sessionWithDecision, sessionName).filter(
      (event) =>
        event.spec.reviewItemName === itemName
        && (event.spec.eventType === "decision-changed"
          || event.spec.eventType === "decision-submitted"
          || (event.spec.eventType === "note-changed" && note !== undefined)),
    );
    const newEvents = appendReviewSessionEvents(file, decisionEvents);

    // Use the server session APIs for apply-path validation
    const record = createServerReviewSessionRecord({
      sessionName,
      snapshot,
      eventCount: events.length,
      updatedAt: new Date(),
    });

    const applyResult = deriveServerReviewSessionApplyResult({
      record,
      events: newEvents,
      requiredResolvedItems: "none",
      extractionImport: file.extractionImport,
    });

    if (!applyResult.ok) {
      throw new DomainError(
        `Decision validation failed: ${applyResult.issues.map((issue) => "message" in issue ? issue.message : String(issue)).join("; ")}`,
      );
    }

    const updatedFile: SessionFileContent = {
      ...file,
      session: file.session,
      snapshot,
      events: newEvents,
    };
    return { next: updatedFile, result: { snapshot, sessionWithDecision, newEvents, attestation } };
  });

  // Summarize the result
  const updatedItem = sessionWithDecision.items.find((i) => i.metadata.name === itemName);
  const itemText = updatedItem ? itemDetailText(updatedItem, snapshot, newEvents, attestation) : `Item: ${itemName}`;
  const remainingText = queueSummaryText(snapshot, newEvents, attestation);
  const definition = workbenchDecisionDefinitions[wbDecision];
  const conflictRejected = wbDecision === "reject-proposed" && updatedItem !== undefined && decisionSelectsNoCandidate(updatedItem, wbDecision);
  const valueStr = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
  const proposed = updatedItem?.spec.candidates.filter((c) => c.role === "proposed") ?? [];
  const chosen = proposed.find((c) => c.id === selectedCandidateId);
  const effect = conflictRejected
    ? "Every proposed value is rejected; none becomes the claim's value."
    : wbDecision === "select-proposed"
      ? `${valueStr(chosen?.value)} becomes the verified value; not chosen: ${proposed.filter((c) => c.id !== selectedCandidateId).map((c) => valueStr(c.value)).join(", ")}.`
      : definition.effect;

  const text = [
    `Decision recorded: ${conflictRejected ? "Reject all values" : definition.label}`,
    `Effect: ${effect}`,
    "",
    itemText,
    "",
    "--- Updated queue ---",
    remainingText,
  ].join("\n");

  return [{ type: "text", text }];
}

// ---- UI resource wrapper -------------------------------------------------

interface TextContent {
  readonly type: "text";
  readonly text: string;
}

interface ResourceContent {
  readonly type: "resource";
  readonly resource: {
    readonly uri: string;
    readonly mimeType: string;
    readonly text: string;
    readonly _meta: Record<string, unknown>;
  };
}

type ContentItem = TextContent | ResourceContent;

function buildUiResource(
  item: ReviewItem,
  snapshot: ReviewQueueSessionState,
  events: readonly ReviewSessionEvent[],
  instance: string,
  attestation: ReviewQueueExtractionAttestation,
): ResourceContent {
  return {
    type: "resource",
    resource: {
      uri: `ui://survey/review-card/${encodeURIComponent(instance)}`,
      mimeType: "text/html;profile=mcp-app",
      text: buildReviewCardHtml(item, snapshot, events, attestation),
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
          },
        },
        "mcpui.dev/ui-preferred-frame-size": ["420px", "560px"],
      },
    },
  };
}

// Render the declared review card from the same function used by embedded tool
// results, so Apps and text-first hosts cannot drift.
async function readQueuePanelResource(
  options: ReviewMcpOptions,
): Promise<ResourceContent["resource"]> {
  const { snapshot, events, attestation } = await readSessionFile(options.sessionPath);
  const current = currentSessionState(snapshot, events);
  const activeItem = currentReviewItem(current);
  return buildUiResource(activeItem, snapshot, events, "queue", attestation).resource;
}

// ---- Domain error (maps to isError:true, not a JSON-RPC error) -----------

class DomainError extends Error {
  readonly isDomainError = true;
}

// ---- Official dual-era MCP server ---------------------------------------

function uiResourceMeta(resourceUri: string): Record<string, unknown> {
  return {
    ui: { resourceUri, visibility: ["model", "app"] },
    [UI_RESOURCE_URI_META_KEY]: resourceUri,
  };
}

function createReviewMcpServer(
  options: ReviewMcpOptions,
  serverVersion: string,
): McpServer {
  const server = new McpServer(
    {
      name: "survey-review-mcp",
      title: "Survey Review MCP",
      version: serverVersion,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: options.noUi
        ? {}
        : {
            extensions: {
              [UI_CAPABILITY_EXTENSION]: {},
            },
          },
      cacheHints: {
        "server/discover": { ttlMs: 0, cacheScope: "private" },
        "tools/list": { ttlMs: 0, cacheScope: "private" },
        "resources/list": { ttlMs: 0, cacheScope: "private" },
        "resources/read": { ttlMs: 0, cacheScope: "private" },
      },
    },
  );

  server.registerTool(
    "survey_review_queue",
    {
      title: "Review queue",
      description:
        "Return a text summary and JSON of the current review queue: all items with their status, the active item, resolved/total counts, and session summary totals.",
      inputSchema: z.object({}),
      ...(options.noUi ? {} : { _meta: uiResourceMeta(QUEUE_PANEL_URI) }),
    },
    async () => runReviewTool(() => toolQueue(options)),
  );

  server.registerTool(
    "survey_review_item",
    {
      title: "Review item detail",
      description:
        "Return full detail for one review item: current and proposed values, confidence, source references, excerpts, and any current decision.",
      inputSchema: z.object({
        itemName: z.string().min(1).describe("The ReviewItem name to inspect."),
      }),
    },
    async ({ itemName }) => runReviewTool(() => toolItem(itemName, options)),
  );

  server.registerTool(
    "survey_review_decide",
    {
      title: "Record a review decision",
      description:
        "Apply a decision to a review item and persist it through Survey's server-owned validation boundary. Decision must be accept, select, hold, reject, or could-not-confirm. Select chooses one value of a conflict (several proposed values) by candidateId. Could-not-confirm requires a reason. Domain failures return isError:true.",
      inputSchema: z.discriminatedUnion("decision", [
        z.object({
          itemName: z.string().min(1).describe("The ReviewItem name to decide."),
          decision: z
            .enum(["accept", "hold", "reject"])
            .describe(
              "accept = accept-proposed, hold = keep-current, reject = reject-proposed.",
            ),
          note: z.string().optional().describe("Optional reviewer note or rationale."),
        }),
        z.object({
          itemName: z.string().min(1).describe("The ReviewItem name to decide."),
          decision: z
            .literal("could-not-confirm")
            .describe("Record a terminal non-answer after evidence attempts are exhausted."),
          reason: z
            .string()
            .trim()
            .min(1)
            .describe("Required non-empty reason for the could-not-confirm decision."),
          attemptEvidenceIds: z
            .array(z.string())
            .optional()
            .describe("Evidence ids attempted before a could-not-confirm decision."),
        }),
        z.object({
          itemName: z.string().min(1).describe("The ReviewItem name to decide."),
          decision: z
            .literal("select")
            .describe("select = select-proposed: choose one value of a conflict; the other proposed values are recorded as seen and not chosen."),
          candidateId: z
            .string()
            .min(1)
            .describe("The id of the proposed candidate to use, from survey_review_item."),
          note: z.string().optional().describe("Optional reviewer note or rationale."),
        }),
      ]),
    },
    async (input) =>
      runReviewTool(() =>
        input.decision === "could-not-confirm"
          ? toolDecide(
              input.itemName,
              input.decision,
              input.reason,
              input.attemptEvidenceIds,
              options,
            )
          : input.decision === "select"
            ? toolDecide(
                input.itemName,
                input.decision,
                input.note,
                undefined,
                options,
                input.candidateId,
              )
            : toolDecide(
                input.itemName,
                input.decision,
                input.note,
                undefined,
                options,
              ),
      ),
  );

  if (!options.noUi) {
    server.registerResource(
      "survey-review-workbench",
      QUEUE_PANEL_URI,
      {
        title: "Survey review workbench",
        description:
          "Interactive review card for the active item in the configured review session.",
        mimeType: UI_RESOURCE_MIME,
        cacheHint: { ttlMs: 0, cacheScope: "private" },
      },
      async () => {
        const resource = await readQueuePanelResource(options);
        return {
          contents: [
            {
              uri: QUEUE_PANEL_URI,
              mimeType: resource.mimeType,
              text: sanitizeProtocolText(resource.text),
              _meta: resource._meta,
            },
          ],
        };
      },
    );
  }

  return server;
}

async function runReviewTool(
  operation: () => Promise<ContentItem[]>,
): Promise<CallToolResult> {
  try {
    return {
      content: (await operation()).map(sanitizeContentItem),
      isError: false,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: sanitizeProtocolText(error instanceof Error ? error.message : String(error)),
        },
      ],
      isError: true,
    };
  }
}

const UNSAFE_TEXT_CHARS_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u0080-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/g;

function sanitizeProtocolText(text: string): string {
  return text.replace(UNSAFE_TEXT_CHARS_RE, "");
}

function sanitizeContentItem(item: ContentItem): ContentItem {
  if (item.type === "text") {
    return { ...item, text: sanitizeProtocolText(item.text) };
  }
  return {
    ...item,
    resource: {
      ...item.resource,
      text: sanitizeProtocolText(item.resource.text),
    },
  };
}

function sanitizeDiagnostic(text: string): string {
  return sanitizeProtocolText(text).replaceAll(/\s*\r?\n\s*/g, " ").trim();
}

// ---- Entry point ---------------------------------------------------------

function parseMcpArgs(args: string[]): ReviewMcpOptions {
  const defaultSession = resolve(
    dirname(new URL(import.meta.url).pathname),
    "../../../example-data/mcp-review-session.json",
  );
  let sessionPath = defaultSession;
  let noUi = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--session") {
      const next = args[++index];
      if (!next) throw new Error("--session requires a path argument");
      sessionPath = resolve(next);
    } else if (arg === "--no-ui") {
      noUi = true;
    } else {
      throw new Error(`Unknown survey-review-mcp argument: ${arg}`);
    }
  }

  return { sessionPath, noUi };
}

async function readPackageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function runReviewMcp(args: string[]): Promise<void> {
  const options = parseMcpArgs(args);
  const serverVersion = await readPackageVersion();
  const inputClosed = new Promise<void>((resolveClosed) => {
    process.stdin.once("end", resolveClosed);
    process.stdin.once("close", resolveClosed);
  });

  const handle = serveStdio(() => createReviewMcpServer(options, serverVersion), {
    legacy: "serve",
    onerror: (error) => {
      process.stderr.write(`survey-review-mcp: ${sanitizeDiagnostic(error.message)}\n`);
    },
  });

  await inputClosed;
  await handle.close();
}
