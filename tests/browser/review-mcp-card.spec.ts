/**
 * Browser-level tests for the MCP UI review card.
 *
 * Tests use page.setContent() to load the self-contained HTML card returned by
 * the survey_review_queue / survey_review_item MCP tools, without requiring any
 * network server.
 *
 * Each test group that needs the real server spawns it over stdio against a
 * temp copy of example-data/mcp-review-session.json, following the same helper
 * pattern as tests/review-mcp.test.ts.
 */

import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Shared stdio MCP helper (mirrors tests/review-mcp.test.ts collectResponses)
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string | null;
  result?: {
    content: Array<{ type: string; text?: string; resource?: Record<string, unknown> }>;
    isError: boolean;
  } & Record<string, unknown>;
  error?: { code: number; message: string };
}

function mcpSend(server: ReturnType<typeof spawn>, message: unknown): void {
  server.stdin!.write(`${JSON.stringify(message)}\n`);
}

function collectMcpResponses(stdout: NodeJS.ReadableStream) {
  const byId = new Map<number, JsonRpcResponse>();
  const waiters = new Map<number, (response: JsonRpcResponse) => void>();
  const rl = createInterface({ input: stdout });
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof parsed.id !== "number") return;
    const waiter = waiters.get(parsed.id);
    if (waiter) {
      waiters.delete(parsed.id);
      waiter(parsed);
    } else {
      byId.set(parsed.id, parsed);
    }
  });

  return {
    next(id: number): Promise<JsonRpcResponse> {
      const existing = byId.get(id);
      if (existing) {
        byId.delete(id);
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for MCP response id=${id}`)),
          15_000,
        );
        waiters.set(id, (resp) => {
          clearTimeout(timer);
          resolve(resp);
        });
      });
    },
  };
}

interface McpServer {
  server: ReturnType<typeof spawn>;
  responses: ReturnType<typeof collectMcpResponses>;
  sessionPath: string;
  tmpDir: string;
}

/** Spin up a fresh MCP server against a temp copy of the given session file. */
async function startMcpServer(sessionSourcePath: string): Promise<McpServer> {
  const tmpDir = await mkdtemp(join(tmpdir(), "survey-browser-test-"));
  const sessionPath = join(tmpDir, "session.json");
  await copyFile(sessionSourcePath, sessionPath);

  const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], {
    stdio: ["pipe", "pipe", "inherit"],
    cwd: "/Users/brian/dev/github/kontourai/survey",
  });
  const responses = collectMcpResponses(server.stdout!);

  // Perform MCP handshake
  mcpSend(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "review-card-browser-test", version: "0.0.0" },
    },
  });
  await responses.next(1);
  mcpSend(server, { jsonrpc: "2.0", method: "notifications/initialized" });

  return { server, responses, sessionPath, tmpDir };
}

async function stopMcpServer({ server, tmpDir }: McpServer): Promise<void> {
  server.stdin!.end();
  await once(server, "exit");
  await rm(tmpDir, { recursive: true, force: true });
}

/** Extract the UI resource HTML from a tools/call response. */
function extractCardHtml(resp: JsonRpcResponse): string {
  const content = resp.result?.content ?? [];
  const resourceItem = content.find((c) => c.type === "resource");
  if (!resourceItem?.resource) throw new Error("No resource content item found in MCP response");
  return (resourceItem.resource as Record<string, unknown>).text as string;
}

// ---------------------------------------------------------------------------
// Example session path (absolute so tests work from any cwd)
// ---------------------------------------------------------------------------

const EXAMPLE_SESSION_PATH = "/Users/brian/dev/github/kontourai/survey/example-data/mcp-review-session.json";

// ---------------------------------------------------------------------------
// TEST 1: RENDER
// ---------------------------------------------------------------------------

test.describe("RENDER: card loaded via setContent", () => {
  test("shows current/proposed values, queue progress, buttons — no console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(err.message);
    });

    // Obtain the card HTML from the real MCP server
    const mcp = await startMcpServer(EXAMPLE_SESSION_PATH);
    let html: string;
    try {
      mcpSend(mcp.server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "survey_review_queue", arguments: {} },
      });
      const queueResp = await mcp.responses.next(2);
      expect(queueResp.result?.isError).toBe(false);
      html = extractCardHtml(queueResp);
    } finally {
      await stopMcpServer(mcp);
    }

    // Load the card in the browser
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    // Current and proposed values must be visible
    // (example session active item: "Weekdays 9am-5pm" / "Weekdays 8am-6pm")
    await expect(page.locator(".card-grid")).toContainText("Weekdays 9am-5pm");
    await expect(page.locator(".card-grid")).toContainText("Weekdays 8am-6pm");

    // Queue progress visible (format: n/total resolved)
    await expect(page.locator(".progress")).toBeVisible();
    await expect(page.locator(".progress")).toContainText("/");

    // No console errors
    expect(consoleErrors).toEqual([]);

    // All three action buttons present
    await expect(page.locator("#btn-accept")).toBeVisible();
    await expect(page.locator("#btn-hold")).toBeVisible();
    await expect(page.locator("#btn-reject")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// TEST 2: INTERACTION ROUND-TRIP
// ---------------------------------------------------------------------------

test.describe("INTERACTION ROUND-TRIP: postMessage + real server", () => {
  test("Accept button posts correct message; feeding params back to server succeeds and queue reflects resolution", async ({ page }) => {
    // Expose a Node-side capture function into the page's main world.
    // (page.addInitScript runs in an isolated utility world; exposeFunction is
    // accessible from the main world where the card's inline script runs.)
    const captured: unknown[] = [];
    await page.exposeFunction("__captureMessage", (data: unknown) => {
      captured.push(data);
    });

    const mcp = await startMcpServer(EXAMPLE_SESSION_PATH);
    let html: string;
    let capturedItemName: string;

    try {
      mcpSend(mcp.server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "survey_review_queue", arguments: {} },
      });
      const queueResp = await mcp.responses.next(2);
      html = extractCardHtml(queueResp);

      // Derive the active item name and initial accepted count from the queue text
      const textItem = (queueResp.result?.content ?? []).find((c) => c.type === "text");
      const queueText = textItem?.text ?? "";
      const activeMatch = /Active item: ([^\s(]+)/.exec(queueText);
      capturedItemName = activeMatch?.[1] ?? "public-directory-hours";
      const acceptedMatch = /accepted=(\d+)/.exec(queueText);
      const initialAccepted = acceptedMatch ? parseInt(acceptedMatch[1], 10) : 0;

      // Load the card in the browser
      await page.setContent(html, { waitUntil: "domcontentloaded" });

      // Inject a message listener that bridges into the exposed capture function.
      // Must be done AFTER setContent (main-world evaluate) so the listener
      // coexists with the page's own message handler.
      await page.evaluate(() => {
        window.addEventListener("message", function (evt) {
          const fn = (window as unknown as Record<string, unknown>)["__captureMessage"];
          if (typeof fn === "function") {
            void (fn as (d: unknown) => void)(evt.data);
          }
        });
      });

      // Fill reviewer note
      await page.locator("#note").fill("Looks correct per browser test.");

      // Click Accept — triggers window.parent.postMessage(...)
      // In a top-level page, window.parent === window, so the message event
      // fires on the same window and is caught by our listener above.
      await page.locator("#btn-accept").click();

      // Wait until at least one message has been captured (Node-side array)
      await expect
        .poll(() => captured.length, { timeout: 10_000, message: "Expected one captured postMessage" })
        .toBeGreaterThanOrEqual(1);

      expect(captured).toHaveLength(1);

      const msg = captured[0] as {
        jsonrpc: string;
        id: number;
        method: string;
        params: {
          name: string;
          arguments: { itemName: string; decision: string; note?: string };
        };
      };

      // Validate postMessage shape
      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.method).toBe("tools/call");
      expect(msg.params.name).toBe("survey_review_decide");
      expect(msg.params.arguments.itemName).toBe(capturedItemName);
      expect(msg.params.arguments.decision).toBe("accept");
      expect(msg.params.arguments.note).toBe("Looks correct per browser test.");

      // Feed the captured params back into the real stdio server as a tools/call
      mcpSend(mcp.server, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: msg.params,
      });
      const decideResp = await mcp.responses.next(3);
      expect(decideResp.result?.isError).toBe(false);
      const decideText =
        (decideResp.result?.content?.[0] as { text?: string })?.text ?? "";
      expect(decideText).toMatch(/Accept proposed/);

      // Subsequent queue call must reflect the now-resolved item
      mcpSend(mcp.server, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "survey_review_queue", arguments: {} },
      });
      const updatedQueueResp = await mcp.responses.next(4);
      expect(updatedQueueResp.result?.isError).toBe(false);
      const updatedQueueText =
        (updatedQueueResp.result?.content?.[0] as { text?: string })?.text ?? "";
      // The accepted count must be exactly initialAccepted + 1
      expect(updatedQueueText).toMatch(new RegExp(`accepted=${initialAccepted + 1}`));
    } finally {
      await stopMcpServer(mcp);
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 3: HOSTILE INPUT / XSS
// ---------------------------------------------------------------------------

/** Build a minimal hostile review session JSON with XSS payloads in data fields. */
async function buildHostileSession(dir: string): Promise<string> {
  const hostile1 = "</script><script>window.__pwned=1</script>";
  const hostile2 = '<img src=x onerror="window.__pwned=2">';
  const hostile3 = "\"';alert(1)//";

  const session = {
    session: {
      apiVersion: "survey.kontourai.io/v1alpha1",
      kind: "ReviewSession",
      metadata: { name: "hostile-test-session" },
      spec: {
        reviewItemNames: ["hostile-item"],
        actor: { id: "test" },
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      status: { activeItemName: "hostile-item", eventCount: 0, decisionCount: 0 },
    },
    snapshot: {
      items: [
        {
          apiVersion: "survey.kontourai.io/v1alpha1",
          kind: "ReviewItem",
          metadata: { name: "hostile-item" },
          spec: {
            // target and rationale carry hostile1 / hostile3
            target: hostile1,
            candidateSetStatus: "needs-review",
            rationale: hostile3,
            candidates: [
              {
                id: "hostile:current",
                role: "current",
                value: hostile2, // current value: image injection
                confidence: 0.9,
                source: {
                  sourceId: "hostile:src:current",
                  sourceRef: hostile3,
                  kind: "web-page",
                  observedAt: "2026-01-01T00:00:00.000Z",
                  fetchedAt: "2026-01-01T00:00:00.000Z",
                  locatorScheme: "html",
                },
                locator: {
                  scheme: "html",
                  locator: "html:field=test",
                  excerpt: hostile1, // excerpt: script injection
                },
                extraction: {
                  extractionId: "hostile:ext:current",
                  target: "hostileField",
                  confidence: 0.9,
                  extractor: "test",
                  extractedAt: "2026-01-01T00:00:00.000Z",
                },
                claimTarget: {
                  claimId: "hostile.current",
                  subjectType: "test",
                  subjectId: "x",
                  surface: "test",
                  claimType: "test",
                  fieldOrBehavior: "hostileField",
                  impactLevel: "low",
                  collectedBy: "test",
                },
              },
              {
                id: "hostile:proposed",
                role: "proposed",
                value: hostile1, // proposed value: script injection
                confidence: 0.8,
                source: {
                  sourceId: "hostile:src:proposed",
                  sourceRef: hostile2,
                  kind: "web-page",
                  observedAt: "2026-01-01T01:00:00.000Z",
                  fetchedAt: "2026-01-01T01:00:00.000Z",
                  locatorScheme: "html",
                },
                locator: {
                  scheme: "html",
                  locator: "html:field=test",
                  excerpt: hostile2, // excerpt: image injection
                },
                extraction: {
                  extractionId: "hostile:ext:proposed",
                  target: "hostileField",
                  confidence: 0.8,
                  extractor: "test",
                  extractedAt: "2026-01-01T01:00:00.000Z",
                },
                claimTarget: {
                  claimId: "hostile.proposed",
                  subjectType: "test",
                  subjectId: "x",
                  surface: "test",
                  claimType: "test",
                  fieldOrBehavior: "hostileField",
                  impactLevel: "low",
                  collectedBy: "test",
                },
              },
            ],
          },
          status: { observedCandidateCount: 2 },
        },
      ],
      activeItemName: "hostile-item",
      notesByItemName: {},
      decisionsByItemName: {},
      reviewedAt: "2026-01-01T00:00:00.000Z",
      actorId: "test",
    },
    events: [],
  };

  const sessionPath = join(dir, "hostile-session.json");
  await writeFile(sessionPath, JSON.stringify(session, null, 2), "utf8");
  return sessionPath;
}

test.describe("HOSTILE INPUT: XSS escaping", () => {
  test("hostile strings in values/target/excerpt render as visible text, never execute", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(err.message);
    });

    const tmpDir = await mkdtemp(join(tmpdir(), "survey-hostile-test-"));
    let html: string;

    try {
      const sessionPath = await buildHostileSession(tmpDir);
      const mcp = await startMcpServer(sessionPath);

      try {
        mcpSend(mcp.server, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "survey_review_queue", arguments: {} },
        });
        const resp = await mcp.responses.next(2);
        expect(resp.result?.isError).toBe(false);
        html = extractCardHtml(resp);
      } finally {
        await stopMcpServer(mcp);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }

    // Load card in browser
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    // window.__pwned must NOT be set — no XSS executed
    const pwned = await page.evaluate(() =>
      (window as unknown as Record<string, unknown>)["__pwned"],
    );
    expect(pwned).toBeUndefined();

    // No console errors
    expect(consoleErrors).toEqual([]);

    // The hostile <img> tag must NOT have been injected as a real DOM element
    // inside the candidate value areas
    const imgElements = await page.locator(".card-grid img").count();
    expect(imgElements).toBe(0);

    // Verify the hostile strings appear as text content (DOM textContent returns
    // the unescaped, human-readable string — confirming the browser parsed them
    // as text nodes, not markup)
    const cardGridText = await page.locator(".card-grid").textContent();
    expect(cardGridText).toContain("</script><script>window.__pwned=1</script>");
    expect(cardGridText).toContain('<img src=x onerror="window.__pwned=2">');

    // Verify no extra <script> tags were injected — the card should have exactly
    // one (the card's own inline script block)
    const scriptCount = await page.evaluate(() => document.scripts.length);
    expect(scriptCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TEST 4: NO NETWORK REQUESTS
// ---------------------------------------------------------------------------

test.describe("NO NETWORK REQUESTS: card is fully self-contained", () => {
  test("setContent renders without making any external network requests", async ({ page }) => {
    const externalRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      // Allow only about: and data: URLs (the page document itself)
      if (!url.startsWith("about:") && !url.startsWith("data:")) {
        externalRequests.push(url);
      }
    });

    const mcp = await startMcpServer(EXAMPLE_SESSION_PATH);
    let html: string;
    try {
      mcpSend(mcp.server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "survey_review_queue", arguments: {} },
      });
      const resp = await mcp.responses.next(2);
      html = extractCardHtml(resp);
    } finally {
      await stopMcpServer(mcp);
    }

    await page.setContent(html, { waitUntil: "networkidle" });

    // No external requests should have been made
    expect(externalRequests).toEqual([]);
  });
});
