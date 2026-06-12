/**
 * Standalone Survey Review Console — loopback HTTP server that serves the
 * existing Review Workbench UI wired to a session JSON file for real-time review.
 *
 * Routes:
 *   GET  /              HTML shell that mounts the workbench
 *   GET  /api/session   Current session state (snapshot + replayed events)
 *   POST /api/events    Append review session events (same contract as MCP server)
 *   GET  /api/stream    SSE stream: emits "update" events when the session file changes
 *   GET  /api/health    Health check
 *   GET  /dist/*        Compiled assets served from the dist tree (traversal-safe)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { watch } from "node:fs";
import { readFile as readFileAsync, writeFile as writeFileAsync, rename as renameAsync } from "node:fs/promises";
import { resolve, join, dirname, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  replayReviewSessionEvents,
  defaultReviewSessionName,
} from "../review-workbench/review-workbench.js";
import {
  createServerReviewSessionRecord,
  deriveServerReviewSessionApplyResult,
} from "../review-workbench/server-review-session.js";
import type { ReviewQueueSessionState } from "../review-workbench/review-queue-session.js";
import type { ReviewSessionEvent } from "../review-resource.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewConsoleServerOptions {
  /** Absolute path to the session JSON file. */
  readonly sessionPath: string;
  /** TCP port. Defaults to 0 (OS-assigned). */
  readonly port?: number;
  /** Host to bind on. Must be a loopback address. Defaults to 127.0.0.1. */
  readonly host?: string;
}

export interface ReviewConsoleServerHandle {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

interface SessionFileContent {
  readonly session: unknown;
  readonly snapshot: ReviewQueueSessionState;
  readonly events: readonly ReviewSessionEvent[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SSE_DEBOUNCE_MS = 120;

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
};

// ---------------------------------------------------------------------------
// Asset paths — resolved relative to this compiled module at runtime
// ---------------------------------------------------------------------------

/**
 * Resolve the dist/ directory that contains the compiled workbench assets.
 *
 * - When running from compiled output (dist/src/console/*.js): go up 2 levels
 *   to reach dist/.
 * - When running from TypeScript source (Playwright/ts-node, src/console/*.ts):
 *   go up 2 levels reaches repo root; add "dist" to find the compiled assets.
 *
 * We check by looking at the source-file extension: .ts = source context.
 */
function distRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const twoUp = resolve(dirname(thisFile), "..", "..");
  // If we're running from a TypeScript source file, add the "dist" segment.
  if (thisFile.endsWith(".ts")) {
    return join(twoUp, "dist");
  }
  return twoUp;
}

// ---------------------------------------------------------------------------
// Session file helpers
// ---------------------------------------------------------------------------

async function readSession(path: string): Promise<SessionFileContent> {
  const raw = await readFileAsync(path, "utf8");
  return JSON.parse(raw) as SessionFileContent;
}

async function writeSessionAtomic(path: string, content: SessionFileContent): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFileAsync(tmp, JSON.stringify(content, null, 2), "utf8");
  await renameAsync(tmp, path);
}

function currentState(content: SessionFileContent): ReviewQueueSessionState {
  const { snapshot, events } = content;
  return events.length > 0 ? replayReviewSessionEvents(snapshot, events) : snapshot;
}

// ---------------------------------------------------------------------------
// SSE broadcaster
// ---------------------------------------------------------------------------

function createSseBroadcaster() {
  const clients = new Set<ServerResponse>();

  function add(res: ServerResponse): void {
    clients.add(res);
    res.on("close", () => clients.delete(res));
  }

  function broadcast(event: string, data: string): void {
    const payload = `event: ${event}\ndata: ${data}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  return { add, broadcast };
}

// ---------------------------------------------------------------------------
// File watcher with debounce + polling fallback
// ---------------------------------------------------------------------------

function watchSessionFile(
  sessionPath: string,
  onChange: () => void,
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onChange, SSE_DEBOUNCE_MS);
  };

  try {
    const watcher = watch(sessionPath, schedule);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
    };
  } catch {
    // Polling fallback: check mtime every 500ms
    let lastMtime = 0;
    const interval = setInterval(() => {
      import("node:fs").then(({ stat }) => {
        stat(sessionPath, (_err, stats) => {
          if (!stats) return;
          const mtime = stats.mtimeMs;
          if (mtime !== lastMtime) {
            lastMtime = mtime;
            schedule();
          }
        });
      }).catch(() => undefined);
    }, 500);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(interval);
    };
  }
}

// ---------------------------------------------------------------------------
// Static file serving (traversal-safe)
// ---------------------------------------------------------------------------

/**
 * Serve a file from the dist directory tree.
 * The path is validated to prevent traversal out of distRoot.
 */
async function serveDistFile(
  distDir: string,
  pathname: string,
  res: ServerResponse,
): Promise<boolean> {
  // Strip the /dist/ prefix
  const relative = pathname.startsWith("/dist/") ? pathname.slice("/dist/".length) : null;
  if (!relative) return false;

  // Reject obviously dangerous segments before resolving
  const decoded = decodeURIComponent(relative);
  const parts = normalize(decoded).split(sep);
  if (parts.some((p) => p === ".." || p === ".")) {
    send(res, 404, "not found", "text/plain; charset=utf-8");
    return true;
  }

  const filePath = join(distDir, decoded);
  const resolvedFile = resolve(filePath);
  const resolvedRoot = resolve(distDir);

  // Confirm the resolved path is under distDir
  if (!resolvedFile.startsWith(resolvedRoot + sep) && resolvedFile !== resolvedRoot) {
    send(res, 404, "not found", "text/plain; charset=utf-8");
    return true;
  }

  try {
    const content = await readFileAsync(resolvedFile);
    const ct = MIME[extname(resolvedFile)] ?? "application/octet-stream";
    send(res, 200, content, ct);
  } catch {
    send(res, 404, "not found", "text/plain; charset=utf-8");
  }
  return true;
}

// ---------------------------------------------------------------------------
// HTML shell
// ---------------------------------------------------------------------------

function buildConsoleHtml(sessionPath: string): string {
  const escapedPath = sessionPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "\\'");
  // workbench.js lives at dist/src/review-workbench/review-workbench.js relative to distRoot
  const workbenchJsPath = "/dist/src/review-workbench/review-workbench.js";
  const workbenchCssPath = "/dist/src/review-workbench/review-workbench.css";
  const tokensIndexPath = "/dist/src/review-workbench/vendor/console-kit/tokens/index.css";

  return `<!doctype html>
<html lang="en" class="theme-survey">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Survey Review Console</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%2319202a'/%3E%3Cpath d='M4 8.2 6.7 11 12 5' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${tokensIndexPath}">
<link rel="stylesheet" href="${workbenchCssPath}">
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font-family: var(--k-font-ui, "Hanken Grotesk", system-ui, sans-serif);
  background: var(--k-bg, #0a0e13);
  color: var(--k-text, #eef3f8);
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.console-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  height: 48px;
  border-bottom: 1px solid var(--k-line, rgba(150,180,210,0.12));
  background: var(--k-panel, #111824);
  flex-shrink: 0;
  position: sticky;
  top: 0;
  z-index: 50;
}
.console-topbar-logo {
  font-family: var(--k-font-mono, "IBM Plex Mono", monospace);
  font-size: 11px;
  color: var(--k-brand, #5ce0c6);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 6px;
}
.console-topbar-logo svg { flex-shrink: 0; }
.console-topbar-path {
  font-family: var(--k-font-mono, monospace);
  font-size: 11px;
  color: var(--k-text-muted, #aebccb);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.console-topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.theme-toggle {
  padding: 4px 10px;
  border: 1px solid var(--k-line-strong, rgba(150,180,210,0.22));
  border-radius: 6px;
  background: var(--k-panel-raised, #16202d);
  color: var(--k-text-muted, #aebccb);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
}
.theme-toggle:hover {
  border-color: var(--k-brand, #5ce0c6);
  color: var(--k-text, #eef3f8);
}
.connection-indicator {
  display: flex;
  align-items: center;
  gap: 5px;
  font-family: var(--k-font-mono, monospace);
  font-size: 10px;
  color: var(--k-text-faint, #72869b);
  padding: 3px 8px;
  border: 1px solid var(--k-line, rgba(150,180,210,0.12));
  border-radius: 999px;
}
.connection-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--k-positive, #34d399);
  transition: background 0.3s;
}
.connection-dot.disconnected {
  background: var(--k-negative, #ff6f6f);
}
#review-workbench {
  flex: 1;
  min-height: 0;
}
</style>
<!-- Apply persisted theme before first paint -->
<script>
(function () {
  try {
    var saved = localStorage.getItem("survey-console-color-scheme");
    if (saved === "light") document.documentElement.setAttribute("data-theme", "light");
  } catch (_) {}
}());
</script>
</head>
<body>
<header class="console-topbar" role="banner">
  <div class="console-topbar-logo">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="14" height="14" rx="3" fill="#5ce0c6" fill-opacity="0.15"/>
      <path d="M3.5 7.2L5.9 9.8L10.5 4.5" stroke="#5ce0c6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    Survey Review Console
  </div>
  <div class="console-topbar-path" title="${escapedPath}">${escapedPath}</div>
  <div class="console-topbar-actions">
    <div class="connection-indicator" id="connection-indicator" role="status" aria-live="polite">
      <span class="connection-dot" id="connection-dot" aria-hidden="true"></span>
      <span id="connection-label">live</span>
    </div>
    <button class="theme-toggle" type="button" id="theme-toggle" aria-label="Toggle light/dark theme" data-testid="theme-toggle">
      <span class="theme-toggle-icon" aria-hidden="true">&#x2600;</span>
      <span class="theme-toggle-label">Light</span>
    </button>
  </div>
</header>
<main id="review-workbench" class="workbench" data-testid="review-workbench"></main>
<script type="module">
import { mountReviewWorkbench, replayReviewSessionEvents, defaultReviewSessionName, buildReviewSessionEvents } from "${workbenchJsPath}";

// ---- persistence adapter: POST events to /api/events ----
function createConsoleEventStore() {
  let _events = [];
  return {
    load: () => _events.length > 0 ? [..._events] : undefined,
    save: async (_session, events) => {
      _events = [...events];
      try {
        await fetch("/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events }),
        });
      } catch (err) {
        console.error("[console] Failed to persist events:", err);
      }
    },
  };
}

const eventStore = createConsoleEventStore();
let activeItemName = null;

async function fetchAndMount() {
  try {
    const res = await fetch("/api/session");
    if (!res.ok) throw new Error("Session fetch failed: " + res.status);
    const data = await res.json();
    const { snapshot, events } = data;
    const state = events && events.length > 0
      ? replayReviewSessionEvents(snapshot, events)
      : snapshot;

    // Preserve active item selection across reloads
    if (activeItemName && state.items && state.items.some(i => i.metadata.name === activeItemName)) {
      state.activeItemName = activeItemName;
    }

    const root = document.getElementById("review-workbench");
    if (!root) return;

    mountReviewWorkbench(root, state, { eventStore });
  } catch (err) {
    console.error("[console] Mount error:", err);
  }
}

// Track active item to restore after SSE refresh
document.addEventListener("click", (e) => {
  const row = e.target.closest("[data-item-name]");
  if (row) activeItemName = row.dataset.itemName;
});

// ---- SSE: refetch + re-render on change ----
function connectSse() {
  const sse = new EventSource("/api/stream");
  const dot = document.getElementById("connection-dot");
  const label = document.getElementById("connection-label");

  sse.addEventListener("open", () => {
    if (dot) dot.classList.remove("disconnected");
    if (label) label.textContent = "live";
  });
  sse.addEventListener("update", () => {
    fetchAndMount();
  });
  sse.addEventListener("error", () => {
    if (dot) dot.classList.add("disconnected");
    if (label) label.textContent = "disconnected";
  });

  return sse;
}

// ---- Theme toggle ----
(function () {
  var toggle = document.getElementById("theme-toggle");
  if (!toggle) return;

  function currentScheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function applyScheme(scheme) {
    if (scheme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
      toggle.querySelector(".theme-toggle-label").textContent = "Dark";
      toggle.querySelector(".theme-toggle-icon").textContent = "☽";
      toggle.setAttribute("aria-label", "Switch to dark theme");
    } else {
      document.documentElement.removeAttribute("data-theme");
      toggle.querySelector(".theme-toggle-label").textContent = "Light";
      toggle.querySelector(".theme-toggle-icon").textContent = "☀";
      toggle.setAttribute("aria-label", "Switch to light theme");
    }
    try { localStorage.setItem("survey-console-color-scheme", scheme); } catch (_) {}
  }

  applyScheme(currentScheme());
  toggle.addEventListener("click", function () {
    applyScheme(currentScheme() === "light" ? "dark" : "light");
  });
}());

// Boot
await fetchAndMount();
connectSse();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: string | Buffer, contentType: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startReviewConsoleServer(
  options: ReviewConsoleServerOptions,
): Promise<ReviewConsoleServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("survey-review-console only serves loopback addresses");
  }

  const sessionPath = resolve(options.sessionPath);
  const distDir = distRoot();
  const broadcaster = createSseBroadcaster();
  const stopWatcher = watchSessionFile(sessionPath, () => {
    broadcaster.broadcast("update", JSON.stringify({ ts: Date.now() }));
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      // ---- Static dist assets ----
      if (pathname.startsWith("/dist/")) {
        await serveDistFile(distDir, pathname, res);
        return;
      }

      // ---- SSE ----
      if (pathname === "/api/stream" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write("retry: 3000\n\n");
        broadcaster.add(res);
        return;
      }

      // ---- Session read ----
      if (pathname === "/api/session" && req.method === "GET") {
        const content = await readSession(sessionPath);
        sendJson(res, 200, {
          session: content.session,
          snapshot: content.snapshot,
          events: content.events,
          state: currentState(content),
        });
        return;
      }

      // ---- Events write (append) ----
      if (pathname === "/api/events" && req.method === "POST") {
        const body = await readJsonBody(req);
        const incomingEvents = body.events as ReviewSessionEvent[];

        if (!Array.isArray(incomingEvents)) {
          sendJson(res, 400, { error: "events must be an array" });
          return;
        }

        const content = await readSession(sessionPath);
        const { snapshot, events: existingEvents } = content;

        const record = createServerReviewSessionRecord({
          sessionName: defaultReviewSessionName,
          snapshot,
          eventCount: existingEvents.length,
          updatedAt: new Date(),
        });

        const applyResult = deriveServerReviewSessionApplyResult({
          record,
          events: incomingEvents,
          requiredResolvedItems: "none",
        });

        if (!applyResult.ok) {
          const issueMessages = applyResult.issues.map((issue) =>
            "message" in issue ? issue.message : String(issue),
          );
          sendJson(res, 422, { error: `Validation failed: ${issueMessages.join("; ")}` });
          return;
        }

        await writeSessionAtomic(sessionPath, {
          session: content.session,
          snapshot,
          events: incomingEvents,
        });

        sendJson(res, 200, { ok: true, eventCount: incomingEvents.length });
        return;
      }

      // ---- Health ----
      if (pathname === "/health" && req.method === "GET") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- HTML shell (catch-all for GET) ----
      if (req.method === "GET" || req.method === "HEAD") {
        const html = buildConsoleHtml(sessionPath);
        send(res, 200, html, "text/html; charset=utf-8");
        return;
      }

      send(res, 405, "method not allowed", "text/plain; charset=utf-8");
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine server address");
  }
  const normalizedHost = host === "::1" ? "[::1]" : host;
  const url = `http://${normalizedHost}:${address.port}/`;

  return {
    url,
    port: address.port,
    host,
    close: () =>
      new Promise<void>((resolveClosed, reject) => {
        stopWatcher();
        server.close((err) => (err ? reject(err) : resolveClosed()));
      }),
  };
}

// ---------------------------------------------------------------------------
// CLI entry point (called from bin/survey-review-console.mjs)
// ---------------------------------------------------------------------------

export async function runReviewConsole(args: string[]): Promise<void> {
  let sessionPath: string | undefined;
  let port: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--session") {
      const next = args[++i];
      if (!next) throw new Error("--session requires a path argument");
      sessionPath = next;
    } else if (arg === "--port") {
      const next = args[++i];
      if (!next) throw new Error("--port requires a number argument");
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`--port must be an integer between 1 and 65535, got: ${next}`);
      }
      port = parsed;
    } else {
      throw new Error(`Unknown survey-review-console argument: ${arg}`);
    }
  }

  if (!sessionPath) {
    throw new Error("--session <path> is required");
  }

  const handle = await startReviewConsoleServer({ sessionPath, port: port ?? 4243 });
  console.log(`Survey Review Console running at ${handle.url}`);
  console.log(`Session file: ${resolve(sessionPath)}`);
  console.log(`Press Ctrl+C to stop.`);

  process.on("SIGINT", () => {
    handle.close().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  process.on("SIGTERM", () => {
    handle.close().then(() => process.exit(0)).catch(() => process.exit(1));
  });
}
