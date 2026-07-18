import { createInterface } from "node:readline";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";

import {
  buildReviewSessionEvents,
  currentReviewItem,
  deriveQueueRowStatus,
  initialReviewQueueSessionState,
  nextUnresolvedItemName,
  reviewSessionSummary,
  workbenchDecisionDefinitions,
  type ReviewQueueSessionState,
  type ReviewWorkbenchDecision,
} from "../review-workbench/review-workbench.js";
import {
  createServerReviewSessionRecord,
  currentSessionState,
  deriveServerReviewSessionApplyResult,
} from "../review-workbench/server-review-session.js";
import type { ReviewItem, ReviewSession, ReviewSessionEvent } from "../review-resource.js";

/**
 * Minimal Model Context Protocol server over stdio for review-queue inspection
 * and decision-making against a session JSON file.
 *
 * Implemented without an SDK dependency — newline-delimited JSON-RPC 2.0 with
 * the MCP lifecycle (initialize / ping / tools) and an optional embedded UI
 * resource per tool call. The session file is the durable store; decisions
 * append events and write back atomically (write temp + rename).
 */

const PROTOCOL_VERSION = "2025-06-18";
const SESSION_NAME = "mcp-review-session";

// MCP Apps extension (SEP-1865). The review card is offered under both UI
// conventions so one server renders across hosts: the existing mcp-ui.dev
// embedded resource in tool results, AND a declared `ui://` resource that the
// official Apps hosts (ChatGPT/Claude) and Station's SEP-1865 resolver read via
// resources/read. The canonical pointer is the FLAT `_meta["ui/resourceUri"]`
// key (what registerAppTool emits); the nested `_meta.ui.resourceUri` is the
// convenience shape some hosts read — we emit both.
const UI_RESOURCE_URI_META_KEY = "ui/resourceUri";
const UI_CAPABILITY_EXTENSION = "io.modelcontextprotocol/ui";
const QUEUE_PANEL_URI = "ui://survey/review-card/queue";
const UI_RESOURCE_MIME = "text/html;profile=mcp-app";

// MCP tool decision strings → ReviewWorkbenchDecision
const MCP_DECISION_MAP: Record<string, ReviewWorkbenchDecision> = {
  accept: "accept-proposed",
  hold: "keep-current",
  reject: "reject-proposed",
  "could-not-confirm": "could-not-confirm",
};

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ReviewMcpOptions {
  readonly sessionPath: string;
  readonly noUi: boolean;
}

// ---- Session file format --------------------------------------------------

interface SessionFileContent {
  readonly session: ReviewSession;
  readonly snapshot: ReviewQueueSessionState;
  readonly events: readonly ReviewSessionEvent[];
}

async function readSessionFile(path: string): Promise<SessionFileContent> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as SessionFileContent;
}

async function writeSessionFileAtomic(path: string, content: SessionFileContent): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(content, null, 2), "utf8");
  await rename(tmp, path);
}

// ---- Queue helpers -------------------------------------------------------

function queueSummaryText(snapshot: ReviewQueueSessionState, events: readonly ReviewSessionEvent[]): string {
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

function itemDetailText(item: ReviewItem, snapshot: ReviewQueueSessionState, events: readonly ReviewSessionEvent[]): string {
  const current = currentSessionState(snapshot, events);
  const status = deriveQueueRowStatus(item, current);
  const decision = current.decisionsByItemName[item.metadata.name];
  const note = current.notesByItemName[item.metadata.name];

  const currentCandidate = item.spec.candidates.find((c) => c.role === "current");
  const proposedCandidate = item.spec.candidates.find((c) => c.role === "proposed");

  const valueStr = (v: unknown): string =>
    typeof v === "string" ? v : JSON.stringify(v);

  const confStr = (c: number | undefined): string =>
    c !== undefined ? `${Math.round(c * 100)}%` : "unknown";

  const lines: string[] = [
    `Item: ${item.metadata.name}`,
    `Target: ${item.spec.target}`,
    `Status: ${status}`,
    `Candidate set status: ${item.spec.candidateSetStatus ?? "unknown"}`,
    ...(decision ? [`Decision: ${decision}`] : []),
    ...(note ? [`Note: ${note}`] : []),
    ``,
    `Current value: ${valueStr(currentCandidate?.value ?? "(none)")}`,
    `  confidence: ${confStr(currentCandidate?.extraction?.confidence ?? currentCandidate?.confidence)}`,
    `  source: ${currentCandidate?.source?.sourceRef ?? "none"}`,
    ...(currentCandidate?.locator?.excerpt ? [`  excerpt: ${currentCandidate.locator.excerpt}`] : []),
    ``,
    `Proposed value: ${valueStr(proposedCandidate?.value ?? "(none)")}`,
    `  confidence: ${confStr(proposedCandidate?.extraction?.confidence ?? proposedCandidate?.confidence)}`,
    `  source: ${proposedCandidate?.source?.sourceRef ?? "none"}`,
    ...(proposedCandidate?.locator?.excerpt ? [`  excerpt: ${proposedCandidate.locator.excerpt}`] : []),
  ];

  if (item.spec.rationale) {
    lines.push(``, `Rationale: ${item.spec.rationale}`);
  }

  return lines.join("\n");
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
): string {
  const current = currentSessionState(snapshot, events);
  const summary = reviewSessionSummary(current);
  const total = current.items.length;
  const resolved = total - summary.unresolved;

  const currentCandidate = item.spec.candidates.find((c) => c.role === "current");
  const proposedCandidate = item.spec.candidates.find((c) => c.role === "proposed");
  const decision = current.decisionsByItemName[item.metadata.name];
  const status = deriveQueueRowStatus(item, current);

  const valueStr = (v: unknown): string =>
    typeof v === "string" ? v : JSON.stringify(v, null, 2);

  const confStr = (c: number | undefined): string =>
    c !== undefined ? `${Math.round(c * 100)}%` : "—";

  const currentValue = valueStr(currentCandidate?.value ?? "—");
  const proposedValue = valueStr(proposedCandidate?.value ?? "—");
  const currentConf = confStr(currentCandidate?.extraction?.confidence ?? currentCandidate?.confidence);
  const proposedConf = confStr(proposedCandidate?.extraction?.confidence ?? proposedCandidate?.confidence);
  const currentSource = currentCandidate?.source?.sourceRef ?? "—";
  const proposedSource = proposedCandidate?.source?.sourceRef ?? "—";
  const currentExcerpt = currentCandidate?.locator?.excerpt ?? "";
  const proposedExcerpt = proposedCandidate?.locator?.excerpt ?? "";

  const itemNameJson = escapeJsonInHtml(item.metadata.name);

  const decisionBadge = decision
    ? `<span class="badge badge-${decision === "accept-proposed" ? "accept" : decision === "reject-proposed" ? "reject" : "hold"}">${escapeHtml(workbenchDecisionDefinitions[decision].label)}</span>`
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
  --k-text-faint: #72869b;
  --k-brand: #5ce0c6;
  --k-positive: #34d399;
  --k-caution: #f3b14b;
  --k-negative: #ff6f6f;
  --k-active: #7aa2ff;
  --k-radius-sm: 9px;
  --k-radius-md: 14px;
  --k-font-ui: "Hanken Grotesk",ui-sans-serif,system-ui,-apple-system,sans-serif;
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
    --k-text-faint: #707782;
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
</style>
</head>
<body>
<p class="eyebrow">Survey Review</p>
<h1>${escapeHtml(item.spec.target)}</h1>
<div class="meta">
  <span>${escapeHtml(item.metadata.name)}</span>
  ${decisionBadge}
  <span class="progress">${resolved}/${total} resolved</span>
</div>

<div class="card-grid">
  <div class="card">
    <div class="card-label">Current</div>
    <div class="value">${currentValue.includes("\n") ? `<pre>${escapeHtml(currentValue)}</pre>` : escapeHtml(currentValue)}</div>
    <div class="conf">confidence ${currentConf}</div>
    <div class="source-ref">${escapeHtml(currentSource)}</div>
    ${currentExcerpt ? `<div class="excerpt">${escapeHtml(currentExcerpt)}</div>` : ""}
  </div>
  <div class="card is-proposed">
    <div class="card-label">Proposed</div>
    <div class="value">${proposedValue.includes("\n") ? `<pre>${escapeHtml(proposedValue)}</pre>` : escapeHtml(proposedValue)}</div>
    <div class="conf">confidence ${proposedConf}</div>
    <div class="source-ref">${escapeHtml(proposedSource)}</div>
    ${proposedExcerpt ? `<div class="excerpt">${escapeHtml(proposedExcerpt)}</div>` : ""}
  </div>
</div>

<div class="divider"></div>

<div class="note-label">Reviewer note (required for Could not confirm)</div>
<textarea class="note-input" id="note" placeholder="Add a rationale for this decision...">${escapeHtml(current.notesByItemName[item.metadata.name] ?? "")}</textarea>

<div class="btn-row">
  <button class="btn btn-accept${decision === "accept-proposed" ? " active" : ""}" id="btn-accept">Accept proposed</button>
  <button class="btn btn-hold${decision === "keep-current" ? " active" : ""}" id="btn-hold">Hold / Keep current</button>
  <button class="btn btn-reject${decision === "reject-proposed" ? " active" : ""}" id="btn-reject">Reject proposed</button>
  <button class="btn btn-unconfirmed${decision === "could-not-confirm" ? " active" : ""}" id="btn-unconfirmed">Could not confirm</button>
</div>
<div class="feedback" id="feedback"></div>

<script>
(function () {
  var itemName = ${itemNameJson};
  var msgId = 1;

  function postDecision(decision) {
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
          : { itemName: itemName, decision: decision, note: note || undefined }
      }
    }, "*");
    return true;
  }

  document.getElementById('btn-accept').addEventListener('click', function () { postDecision('accept'); document.getElementById('feedback').textContent = 'Submitting accept…'; });
  document.getElementById('btn-hold').addEventListener('click', function () { postDecision('hold'); document.getElementById('feedback').textContent = 'Submitting hold…'; });
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
  const { snapshot, events } = file;

  const text = queueSummaryText(snapshot, events);
  const queueData = {
    items: snapshot.items.map((item) => {
      const current = currentSessionState(snapshot, events);
      return {
        name: item.metadata.name,
        target: item.spec.target,
        status: deriveQueueRowStatus(item, current),
        decision: current.decisionsByItemName[item.metadata.name],
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
    content.push(buildUiResource(activeItem, snapshot, events, "queue"));
  }

  return content;
}

async function toolItem(itemName: string, options: ReviewMcpOptions): Promise<ContentItem[]> {
  const file = await readSessionFile(options.sessionPath);
  const { snapshot, events } = file;
  const current = currentSessionState(snapshot, events);

  const item = current.items.find((i) => i.metadata.name === itemName);
  if (!item) {
    throw new DomainError(`Unknown review item: ${itemName}`);
  }

  const text = itemDetailText(item, snapshot, events);
  const itemData = {
    name: item.metadata.name,
    target: item.spec.target,
    status: deriveQueueRowStatus(item, current),
    decision: current.decisionsByItemName[item.metadata.name],
    note: current.notesByItemName[item.metadata.name],
    candidateSetStatus: item.spec.candidateSetStatus,
    candidates: item.spec.candidates.map((c) => ({
      id: c.id,
      role: c.role,
      value: c.value,
      confidence: c.extraction?.confidence ?? c.confidence,
      sourceRef: c.source?.sourceRef,
      excerpt: c.locator?.excerpt,
    })),
  };

  const content: ContentItem[] = [
    { type: "text", text: `${text}\n\n${JSON.stringify(itemData, null, 2)}` },
  ];

  if (!options.noUi) {
    content.push(buildUiResource(item, snapshot, events, itemName));
  }

  return content;
}

async function toolDecide(
  itemName: string,
  mcpDecision: string,
  note: string | undefined,
  attemptEvidenceIds: readonly string[] | undefined,
  options: ReviewMcpOptions,
): Promise<ContentItem[]> {
  const wbDecision = MCP_DECISION_MAP[mcpDecision];
  if (!wbDecision) {
    throw new DomainError(`Invalid decision: ${mcpDecision}. Must be accept, hold, reject, or could-not-confirm.`);
  }
  if (wbDecision === "could-not-confirm" && !note?.trim()) {
    throw new DomainError("survey_review_decide requires a non-empty reason for could-not-confirm");
  }

  const file = await readSessionFile(options.sessionPath);
  const { snapshot, events } = file;
  const current = currentSessionState(snapshot, events);

  const item = current.items.find((i) => i.metadata.name === itemName);
  if (!item) {
    throw new DomainError(`Unknown review item: ${itemName}`);
  }

  const existingDecision = current.decisionsByItemName[item.metadata.name];
  if (existingDecision) {
    throw new DomainError(`Item ${itemName} already has a decision: ${existingDecision}. Use a new session to re-decide.`);
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
  };

  // Use the server session APIs for apply-path validation
  const record = createServerReviewSessionRecord({
    sessionName: SESSION_NAME,
    snapshot,
    eventCount: events.length,
    updatedAt: new Date(),
  });

  const newEvents = buildReviewSessionEvents(sessionWithDecision, SESSION_NAME);
  const applyResult = deriveServerReviewSessionApplyResult({
    record,
    events: newEvents,
    requiredResolvedItems: "none",
  });

  if (!applyResult.ok) {
    throw new DomainError(
      `Decision validation failed: ${applyResult.issues.map((issue) => "message" in issue ? issue.message : String(issue)).join("; ")}`,
    );
  }

  // Persist atomically
  const updatedFile: SessionFileContent = {
    session: file.session,
    snapshot,
    events: newEvents,
  };
  await writeSessionFileAtomic(options.sessionPath, updatedFile);

  // Summarize the result
  const updatedItem = sessionWithDecision.items.find((i) => i.metadata.name === itemName);
  const itemText = updatedItem ? itemDetailText(updatedItem, snapshot, newEvents) : `Item: ${itemName}`;
  const remainingText = queueSummaryText(snapshot, newEvents);
  const definition = workbenchDecisionDefinitions[wbDecision];

  const text = [
    `Decision recorded: ${definition.label}`,
    `Effect: ${definition.effect}`,
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
): ResourceContent {
  return {
    type: "resource",
    resource: {
      uri: `ui://survey/review-card/${encodeURIComponent(instance)}`,
      mimeType: "text/html;profile=mcp-app",
      text: buildReviewCardHtml(item, snapshot, events),
      _meta: {
        "mcpui.dev/ui-preferred-frame-size": ["420px", "560px"],
      },
    },
  };
}

// Render the SEP-1865 declared review card: load the configured session, replay
// to current state, and render the active item's card HTML (the same HTML the
// embedded `queue` resource carries — here served via resources/read).
async function readQueuePanelHtml(options: ReviewMcpOptions): Promise<string> {
  const { snapshot, events } = await readSessionFile(options.sessionPath);
  const current = currentSessionState(snapshot, events);
  const activeItem = currentReviewItem(current);
  return buildReviewCardHtml(activeItem, snapshot, events);
}

// ---- Domain error (maps to isError:true, not a JSON-RPC error) -----------

class DomainError extends Error {
  readonly isDomainError = true;
}

// ---- JSON-RPC dispatch ---------------------------------------------------

async function handleLine(
  line: string,
  options: ReviewMcpOptions,
  serverVersion: string,
): Promise<void> {
  const trimmed = line.trim();
  if (trimmed === "") return;

  let message: JsonRpcRequest;
  try {
    message = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  const { id, method, params } = message;
  const isNotification = id === undefined;

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            // Resources back the SEP-1865 ui:// review card (unless --no-ui).
            ...(options.noUi ? {} : { resources: { listChanged: false } }),
            ...(options.noUi
              ? {}
              : { extensions: { [UI_CAPABILITY_EXTENSION]: {} } }),
          },
          serverInfo: { name: "survey-review-mcp", title: "Survey Review MCP", version: serverVersion },
          instructions:
            "Use survey_review_queue to inspect the queue, survey_review_item to drill into a single item, and survey_review_decide to record a decision. Decisions are persisted to the session file and are irreversible within this session.",
        },
      });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "survey_review_queue",
              title: "Review queue",
              description:
                "Return a text summary and JSON of the current review queue: all items with their status (pending, in-review, resolved, rejected, escalated), the active item, resolved/total counts, and session summary totals.",
              inputSchema: { type: "object", properties: {} },
              // SEP-1865 UI pointer (both flat canonical + nested), unless --no-ui.
              ...(options.noUi
                ? {}
                : {
                    _meta: {
                      [UI_RESOURCE_URI_META_KEY]: QUEUE_PANEL_URI,
                      ui: { resourceUri: QUEUE_PANEL_URI, visibility: ["model", "app"] },
                    },
                  }),
            },
            {
              name: "survey_review_item",
              title: "Review item detail",
              description:
                "Return full detail for a single review item: current vs proposed values, confidence, source references, excerpts, and the current decision (if any).",
              inputSchema: {
                type: "object",
                properties: {
                  itemName: { type: "string", description: "The ReviewItem name to inspect." },
                },
                required: ["itemName"],
              },
            },
            {
              name: "survey_review_decide",
              title: "Record a review decision",
              description:
                "Apply a decision to a review item and persist it to the session file. Decision must be accept, hold, reject, or could-not-confirm. Could-not-confirm requires a reason. Domain failures return isError:true.",
              inputSchema: {
                type: "object",
                properties: {
                  itemName: { type: "string", description: "The ReviewItem name to decide." },
                  decision: {
                    type: "string",
                    enum: ["accept", "hold", "reject", "could-not-confirm"],
                    description: "accept = accept-proposed, hold = keep-current, reject = reject-proposed, could-not-confirm = terminal non-answer.",
                  },
                  note: { type: "string", description: "Optional reviewer note / rationale." },
                  reason: { type: "string", minLength: 1, description: "Required non-empty reason when decision is could-not-confirm." },
                  attemptEvidenceIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional evidence ids recording what was attempted before could-not-confirm.",
                  },
                },
                required: ["itemName", "decision"],
                allOf: [{
                  if: { properties: { decision: { const: "could-not-confirm" } }, required: ["decision"] },
                  then: { required: ["reason"] },
                }],
              },
            },
          ],
        },
      });
    } else if (method === "resources/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          resources: options.noUi
            ? []
            : [
                {
                  uri: QUEUE_PANEL_URI,
                  name: "Survey review workbench",
                  description:
                    "Interactive review card for the active item in the configured review session (MCP Apps UI resource).",
                  mimeType: UI_RESOURCE_MIME,
                },
              ],
        },
      });
    } else if (method === "resources/read") {
      const uri = typeof params?.uri === "string" ? params.uri : "";
      if (options.noUi || uri !== QUEUE_PANEL_URI) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown resource: ${uri || "(missing uri)"}` } });
        return;
      }
      const html = await readQueuePanelHtml(options);
      send({
        jsonrpc: "2.0",
        id,
        result: { contents: [{ uri: QUEUE_PANEL_URI, mimeType: UI_RESOURCE_MIME, text: html }] },
      });
    } else if (method === "tools/call") {
      const name = typeof params?.name === "string" ? params.name : "";
      const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;

      try {
        let content: ContentItem[];

        if (name === "survey_review_queue") {
          content = await toolQueue(options);
        } else if (name === "survey_review_item") {
          const itemName = typeof toolArgs.itemName === "string" ? toolArgs.itemName : "";
          if (!itemName) {
            throw new DomainError("survey_review_item requires itemName");
          }
          content = await toolItem(itemName, options);
        } else if (name === "survey_review_decide") {
          const itemName = typeof toolArgs.itemName === "string" ? toolArgs.itemName : "";
          const decision = typeof toolArgs.decision === "string" ? toolArgs.decision : "";
          const note = typeof toolArgs.note === "string" ? toolArgs.note : undefined;
          const reason = typeof toolArgs.reason === "string" ? toolArgs.reason : undefined;
          const attemptEvidenceIds = Array.isArray(toolArgs.attemptEvidenceIds)
            && toolArgs.attemptEvidenceIds.every((value) => typeof value === "string")
            ? toolArgs.attemptEvidenceIds as string[]
            : undefined;
          if (!itemName) throw new DomainError("survey_review_decide requires itemName");
          if (!decision) throw new DomainError("survey_review_decide requires decision");
          content = await toolDecide(itemName, decision, decision === "could-not-confirm" ? reason : note, attemptEvidenceIds, options);
        } else {
          send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name || "(missing name)"}` } });
          return;
        }

        send({ jsonrpc: "2.0", id, result: { content, isError: false } });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
      }
    } else if (isNotification) {
      // Lifecycle notifications such as notifications/initialized need no reply.
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method ?? "(none)"}` } });
    }
  } catch (error) {
    if (!isNotification) {
      const messageText = error instanceof Error ? error.message : String(error);
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: messageText } });
    }
  }
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

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function runReviewMcp(args: string[]): Promise<void> {
  const options = parseMcpArgs(args);
  const serverVersion = await readPackageVersion();

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    void handleLine(line, options, serverVersion);
  });

  await new Promise<void>((resolveClosed) => {
    rl.on("close", resolveClosed);
  });
}
