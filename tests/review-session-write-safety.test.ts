/**
 * Write safety for the two local session writers (kontourai/survey#281):
 * console compare-and-swap, console request guards, and the shared session
 * lock that both the console and the MCP `decide` tool must take.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createInterface } from "node:readline";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startReviewConsoleServer, type ReviewConsoleServerHandle } from "../src/console/review-console-server.js";
import { acquireReviewSessionFileLock } from "../src/review-session-file.js";
import {
  buildReviewSessionEvents,
  defaultReviewSessionName,
  type ReviewQueueSessionState,
} from "../src/review-workbench/review-workbench.js";
import type { ReviewSessionEvent } from "../src/review-resource.js";

const SAMPLE_SESSION = "example-data/mcp-review-session.json";

interface Fixture {
  readonly handle: ReviewConsoleServerHandle;
  readonly sessionPath: string;
  readonly tmpDir: string;
}

async function withConsole(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "survey-write-safety-"));
  const sessionPath = join(tmpDir, "session.json");
  await copyFile(SAMPLE_SESSION, sessionPath);
  const handle = await startReviewConsoleServer({ sessionPath, port: 0 });
  try {
    await run({ handle, sessionPath, tmpDir });
  } finally {
    await handle.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

interface RawResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** node:http so the test controls Host and Origin exactly (fetch does not). */
function rawRequest(
  handle: ReviewConsoleServerHandle,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolveResponse, reject) => {
    const req = request(
      { host: "127.0.0.1", port: handle.port, method, path, headers: { ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            parsed = { raw: text };
          }
          resolveResponse({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function ownHeaders(handle: ReviewConsoleServerHandle): Record<string, string> {
  return {
    host: `127.0.0.1:${handle.port}`,
    origin: `http://127.0.0.1:${handle.port}`,
    "content-type": "application/json",
  };
}

async function readSessionState(handle: ReviewConsoleServerHandle): Promise<{ snapshot: ReviewQueueSessionState; events: ReviewSessionEvent[]; revision: string }> {
  const res = await rawRequest(handle, "GET", "/api/session", ownHeaders(handle));
  assert.equal(res.status, 200);
  return res.body as unknown as { snapshot: ReviewQueueSessionState; events: ReviewSessionEvent[]; revision: string };
}

function eventsDeciding(snapshot: ReviewQueueSessionState, decisions: Record<string, "accept-proposed" | "keep-current">): ReviewSessionEvent[] {
  return buildReviewSessionEvents(
    { ...snapshot, decisionsByItemName: { ...snapshot.decisionsByItemName, ...decisions } },
    defaultReviewSessionName,
  );
}

function postEvents(
  handle: ReviewConsoleServerHandle,
  payload: Record<string, unknown>,
  headers: Record<string, string> = ownHeaders(handle),
): Promise<RawResponse> {
  return rawRequest(handle, "POST", "/api/events", headers, JSON.stringify(payload));
}

async function decidedItemsOnDisk(sessionPath: string): Promise<string[]> {
  const parsed = JSON.parse(await readFile(sessionPath, "utf8")) as { events: ReviewSessionEvent[] };
  return parsed.events
    .filter((event) => event.spec.eventType === "decision-submitted")
    .map((event) => event.spec.reviewItemName ?? "")
    .sort();
}

// ---- MCP child process helpers -------------------------------------------

interface McpClient {
  readonly child: ChildProcess;
  call(id: number, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }>;
  close(): Promise<void>;
}

async function startMcp(sessionPath: string): Promise<McpClient> {
  const child = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], { stdio: ["pipe", "pipe", "inherit"] });
  const waiters = new Map<number, (message: Record<string, any>) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as Record<string, any>;
    if (typeof message.id === "number") waiters.get(message.id)?.(message);
  });
  const rpc = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, any>>((resolveRpc, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP response ${id} timed out`)), 20_000);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolveRpc(message);
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "write-safety-test", version: "0" } });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    child,
    async call(id, name, args) {
      const message = await rpc(id, "tools/call", { name, arguments: args });
      return { isError: message.result?.isError, text: message.result?.content?.[0]?.text ?? JSON.stringify(message.error) };
    },
    async close() {
      child.stdin!.end();
      await once(child, "exit");
    },
  };
}

const HELD_MS = 600;

// ---------------------------------------------------------------------------

describe("review console compare-and-swap (#281)", () => {
  test("two writes based on the same read: the second is 409 and the first decision stays on disk", async () => {
    await withConsole(async ({ handle, sessionPath }) => {
      const { snapshot, revision } = await readSessionState(handle);
      const [first, second] = snapshot.items.map((item) => item.metadata.name);

      const a = await postEvents(handle, { events: eventsDeciding(snapshot, { [first]: "accept-proposed" }), baseRevision: revision });
      assert.equal(a.status, 200);
      assert.equal(typeof a.body.revision, "string");

      const b = await postEvents(handle, { events: eventsDeciding(snapshot, { [second]: "accept-proposed" }), baseRevision: revision });
      assert.equal(b.status, 409, JSON.stringify(b.body));
      assert.equal(b.body.revision, a.body.revision, "409 reports the stored revision so the client can reload");

      assert.deepEqual(await decidedItemsOnDisk(sessionPath), [first]);
    });
  });

  test("a write that omits baseRevision is refused (428) and leaves the log unchanged", async () => {
    await withConsole(async ({ handle, sessionPath }) => {
      const { snapshot } = await readSessionState(handle);
      const before = await readFile(sessionPath, "utf8");
      const res = await postEvents(handle, { events: eventsDeciding(snapshot, { [snapshot.items[0].metadata.name]: "accept-proposed" }) });
      assert.equal(res.status, 428, JSON.stringify(res.body));
      assert.equal(await readFile(sessionPath, "utf8"), before);
    });
  });

  test("an empty event array against a non-empty log is rejected and the log is unchanged", async () => {
    await withConsole(async ({ handle, sessionPath }) => {
      const { events, revision } = await readSessionState(handle);
      assert.ok(events.length > 0, "fixture must start with a non-empty log");
      const before = await readFile(sessionPath, "utf8");
      const res = await postEvents(handle, { events: [], baseRevision: revision });
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.match(String(res.body.error), /empty/);
      assert.equal(await readFile(sessionPath, "utf8"), before);
    });
  });
});

describe("review console request guards (#281)", () => {
  async function assertRefused(headers: (handle: ReviewConsoleServerHandle) => Record<string, string>, expectedStatus: number): Promise<void> {
    await withConsole(async ({ handle, sessionPath }) => {
      const { snapshot, revision } = await readSessionState(handle);
      const before = await readFile(sessionPath, "utf8");
      const payload = { events: eventsDeciding(snapshot, { [snapshot.items[0].metadata.name]: "accept-proposed" }), baseRevision: revision };
      const res = await postEvents(handle, payload, headers(handle));
      assert.equal(res.status, expectedStatus, JSON.stringify(res.body));
      assert.equal(await readFile(sessionPath, "utf8"), before);

      // Control: the same payload with the server's own headers is accepted,
      // so the refusal above came from the guard, not from the payload.
      const ok = await postEvents(handle, payload);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    });
  }

  test("a text/plain POST (CORS simple request) is refused", async () => {
    await assertRefused((handle) => ({ ...ownHeaders(handle), "content-type": "text/plain" }), 415);
  });

  test("a POST with a foreign Origin is refused", async () => {
    await assertRefused((handle) => ({ ...ownHeaders(handle), origin: "https://other.example" }), 403);
  });

  test("a POST whose Origin names a loopback host on another port is refused", async () => {
    await assertRefused((handle) => ({ ...ownHeaders(handle), origin: `http://127.0.0.1:${handle.port + 1}` }), 403);
  });

  test("a POST with a non-loopback Host (DNS rebinding) is refused", async () => {
    await assertRefused((handle) => {
      const { origin: _origin, ...rest } = ownHeaders(handle);
      return { ...rest, host: `attacker.example:${handle.port}` };
    }, 403);
  });

  test("a POST without an Origin header (non-browser client) from loopback is accepted", async () => {
    await withConsole(async ({ handle }) => {
      const { snapshot, revision } = await readSessionState(handle);
      const { origin: _origin, ...headers } = ownHeaders(handle);
      const res = await postEvents(
        handle,
        { events: eventsDeciding(snapshot, { [snapshot.items[0].metadata.name]: "accept-proposed" }), baseRevision: revision },
        headers,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });
  });
});

describe("shared session write lock (#281)", () => {
  test("console POST and MCP decide both wait for the lock; neither decision is silently dropped", async () => {
    await withConsole(async ({ handle, sessionPath }) => {
      const mcp = await startMcp(sessionPath);
      try {
        const { snapshot, revision } = await readSessionState(handle);
        const release = await acquireReviewSessionFileLock(sessionPath);
        const before = await readFile(sessionPath, "utf8");

        const consoleWrite = postEvents(handle, {
          events: eventsDeciding(snapshot, { "public-directory-hours": "accept-proposed" }),
          baseRevision: revision,
        });
        const mcpWrite = mcp.call(2, "survey_review_decide", { itemName: "public-directory-phone", decision: "accept" });

        await new Promise((r) => setTimeout(r, HELD_MS));
        assert.equal(await readFile(sessionPath, "utf8"), before, "a writer modified the session while another writer held the lock");
        await release();

        const [consoleResult, mcpResult] = await Promise.all([consoleWrite, mcpWrite]);
        assert.equal(mcpResult.isError, false, mcpResult.text);
        const onDisk = await decidedItemsOnDisk(sessionPath);
        assert.ok(onDisk.includes("public-directory-phone"), `MCP decision lost: ${onDisk}`);
        if (consoleResult.status === 200) {
          assert.ok(onDisk.includes("public-directory-hours"), `console decision lost after a 200: ${onDisk}`);
        } else {
          // MCP won the lock first, so the console's view is stale: it must be
          // told (409), never silently overwritten or silently dropped.
          assert.equal(consoleResult.status, 409, JSON.stringify(consoleResult.body));
          assert.ok(!onDisk.includes("public-directory-hours"));
        }
      } finally {
        await mcp.close();
      }
    });
  });

  test("two concurrent MCP decides on different items both end up on disk", async () => {
    await withConsole(async ({ sessionPath }) => {
      const [first, second] = await Promise.all([startMcp(sessionPath), startMcp(sessionPath)]);
      try {
        const release = await acquireReviewSessionFileLock(sessionPath);
        const before = await readFile(sessionPath, "utf8");
        const a = first.call(2, "survey_review_decide", { itemName: "public-directory-hours", decision: "accept" });
        const b = second.call(2, "survey_review_decide", { itemName: "public-directory-phone", decision: "hold" });

        await new Promise((r) => setTimeout(r, HELD_MS));
        assert.equal(await readFile(sessionPath, "utf8"), before, "an MCP decide modified the session while the lock was held");
        await release();

        const results = await Promise.all([a, b]);
        for (const result of results) assert.equal(result.isError, false, result.text);
        assert.deepEqual(await decidedItemsOnDisk(sessionPath), ["public-directory-hours", "public-directory-phone"]);
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    });
  });

  test("a lock left by a dead process is broken instead of blocking writers", async () => {
    await withConsole(async ({ handle, sessionPath }) => {
      const { writeFile } = await import("node:fs/promises");
      // pid 2^22+ is above the default pid_max on Linux and macOS: never alive.
      await writeFile(`${sessionPath}.lock`, JSON.stringify({ pid: 4_194_400, token: "dead", acquiredAt: new Date().toISOString() }));
      const { snapshot, revision } = await readSessionState(handle);
      const res = await postEvents(handle, { events: eventsDeciding(snapshot, { "public-directory-hours": "accept-proposed" }), baseRevision: revision });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(await decidedItemsOnDisk(sessionPath), ["public-directory-hours"]);
    });
  });
});
