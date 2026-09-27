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
import { copyFile, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { startReviewConsoleServer, type ReviewConsoleServerHandle } from "../src/console/review-console-server.js";
import { acquireReviewSessionFileLock, ReviewSessionFileLockTimeoutError } from "../src/review-session-file.js";
import {
  buildReviewSessionEvents,
  defaultReviewSessionName,
  type ReviewQueueSessionState,
} from "../src/review-workbench/review-workbench.js";
import type { ReviewSessionEvent } from "../src/review-resource.js";
import { currentSessionState } from "../src/review-workbench/server-review-session.js";

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

/** The decision events a workbench appends for these decisions (what the console client posts). */
function eventsDeciding(snapshot: ReviewQueueSessionState, decisions: Record<string, "accept-proposed" | "keep-current" | "reject-proposed">): ReviewSessionEvent[] {
  return buildReviewSessionEvents(
    { ...snapshot, decisionsByItemName: { ...snapshot.decisionsByItemName, ...decisions } },
    defaultReviewSessionName,
  ).filter((event) => event.spec.eventType.startsWith("decision-") && event.spec.reviewItemName! in decisions);
}

function postEvents(
  handle: ReviewConsoleServerHandle,
  payload: Record<string, unknown>,
  headers: Record<string, string> = ownHeaders(handle),
): Promise<RawResponse> {
  return rawRequest(handle, "POST", "/api/events", headers, JSON.stringify(payload));
}

async function decisionsOnDisk(sessionPath: string): Promise<Record<string, string>> {
  const parsed = JSON.parse(await readFile(sessionPath, "utf8")) as { snapshot: ReviewQueueSessionState; events: ReviewSessionEvent[] };
  return currentSessionState(parsed.snapshot, parsed.events).decisionsByItemName;
}

async function decidedItemsOnDisk(sessionPath: string): Promise<string[]> {
  return Object.keys(await decisionsOnDisk(sessionPath)).sort();
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
      assert.match(String(res.body.error), /at least one event/);
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

        try {
          await new Promise((r) => setTimeout(r, HELD_MS));
          assert.equal(await readFile(sessionPath, "utf8"), before, "a writer modified the session while another writer held the lock");
        } finally {
          await release();
        }

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

        try {
          await new Promise((r) => setTimeout(r, HELD_MS));
          assert.equal(await readFile(sessionPath, "utf8"), before, "an MCP decide modified the session while the lock was held");
        } finally {
          await release();
        }

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

describe("session event history is kept (#281)", () => {
  function decisionTrail(events: ReviewSessionEvent[], itemName: string): string[] {
    return events
      .filter((event) => event.spec.reviewItemName === itemName && event.spec.eventType === "decision-changed")
      .map((event) => String(event.spec.data?.workbenchDecision));
  }

  test("a console reversal is appended, renumbered and renamed into the stored session, not collapsed", async () => {
    await withConsole(async ({ handle, sessionPath }) => {
      const first = await readSessionState(handle);
      const storedName = first.events[0].spec.sessionName;
      const item = first.snapshot.items[0].metadata.name;

      const accept = await postEvents(handle, { events: eventsDeciding(first.snapshot, { [item]: "accept-proposed" }), baseRevision: first.revision });
      assert.equal(accept.status, 200, JSON.stringify(accept.body));
      const second = await readSessionState(handle);
      const reject = await postEvents(handle, { events: eventsDeciding(first.snapshot, { [item]: "reject-proposed" }), baseRevision: second.revision });
      assert.equal(reject.status, 200, JSON.stringify(reject.body));

      const { events } = await readSessionState(handle);
      assert.deepEqual(decisionTrail(events, item), ["accept-proposed", "reject-proposed"], "the reversal must stay on record");
      assert.deepEqual(events.slice(0, first.events.length), first.events, "the stored prefix is never rewritten");
      assert.deepEqual(events.map((event) => event.spec.sequence), events.map((_, index) => index + 1));
      assert.ok(events.every((event) => event.spec.sessionName === storedName), "appended events carry the stored session name");
      assert.ok(events.every((event) => event.metadata.name.startsWith(`${storedName}-`)));
      assert.equal((await decisionsOnDisk(sessionPath))[item], "reject-proposed");
    });
  });

  test("an MCP decide appends its decision and keeps the console's reversal history", async () => {
    await withConsole(async ({ handle, sessionPath }) => {
      const first = await readSessionState(handle);
      const item = "public-directory-hours";
      assert.equal((await postEvents(handle, { events: eventsDeciding(first.snapshot, { [item]: "accept-proposed" }), baseRevision: first.revision })).status, 200);
      const second = await readSessionState(handle);
      assert.equal((await postEvents(handle, { events: eventsDeciding(first.snapshot, { [item]: "keep-current" }), baseRevision: second.revision })).status, 200);
      const beforeMcp = (await readSessionState(handle)).events;

      const mcp = await startMcp(sessionPath);
      try {
        const result = await mcp.call(2, "survey_review_decide", { itemName: "public-directory-phone", decision: "reject", note: "Wrong number." });
        assert.equal(result.isError, false, result.text);
      } finally {
        await mcp.close();
      }

      const after = JSON.parse(await readFile(sessionPath, "utf8")) as { events: ReviewSessionEvent[] };
      assert.deepEqual(after.events.slice(0, beforeMcp.length), beforeMcp, "MCP must not rewrite the stored log");
      assert.deepEqual(decisionTrail(after.events, item), ["accept-proposed", "keep-current"]);
      const decisions = await decisionsOnDisk(sessionPath);
      assert.equal(decisions[item], "keep-current");
      assert.equal(decisions["public-directory-phone"], "reject-proposed");
    });
  });
});

describe("session lock robustness (#281)", () => {
  const moduleUrl = new URL("../src/review-session-file.js", import.meta.url).href;

  test("breaking a dead-pid lock admits exactly one holder at a time across processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "survey-lock-race-"));
    const sessionPath = join(dir, "session.json");
    const marker = join(dir, "holder.marker");
    const contenders = 5;
    const rounds = 20;
    // Each child waits for a shared start instant, acquires the lock, then
    // proves exclusivity by creating an O_EXCL marker it holds for 30 ms.
    const child = `
      import { open, rm } from "node:fs/promises";
      const { acquireReviewSessionFileLock } = await import(${JSON.stringify(moduleUrl)});
      const [sessionPath, marker, startAt] = process.argv.slice(1);
      await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
      const release = await acquireReviewSessionFileLock(sessionPath, { timeoutMs: 20000 });
      try {
        let handle;
        try { handle = await open(marker, "wx"); } catch { process.exit(3); }
        await new Promise((r) => setTimeout(r, 30));
        await handle.close();
        await rm(marker);
      } finally { await release(); }
    `;
    try {
      let overlaps = 0;
      for (let round = 0; round < rounds; round += 1) {
        await writeFile(`${sessionPath}.lock`, JSON.stringify({ pid: 4_194_400, token: "dead", acquiredAt: new Date().toISOString() }));
        const startAt = String(Date.now() + 400);
        const exits = await Promise.all(Array.from({ length: contenders }, async () => {
          const proc = spawn(process.execPath, ["--input-type=module", "-e", child, sessionPath, marker, startAt], { stdio: ["ignore", "ignore", "inherit"] });
          const [code] = await once(proc, "exit");
          return code as number;
        }));
        overlaps += exits.filter((code) => code === 3).length;
        assert.ok(exits.every((code) => code === 0 || code === 3), `unexpected child exit codes ${exits}`);
        await rm(marker, { force: true });
      }
      assert.equal(overlaps, 0, `${overlaps} holders found the lock already held by another holder`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a lock file left empty by a crashed acquirer is broken quickly, not after the 30s age limit", async () => {
    await withConsole(async ({ handle, sessionPath }) => {
      await writeFile(`${sessionPath}.lock`, "");
      const { snapshot, revision } = await readSessionState(handle);
      const started = Date.now();
      const res = await postEvents(handle, { events: eventsDeciding(snapshot, { "public-directory-hours": "accept-proposed" }), baseRevision: revision });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started}ms`);
    });
  });

  test("a live holder that outlasts staleMs is never broken by another writer (#281 fix round 2)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "survey-lock-live-"));
    const sessionPath = join(dir, "session.json");
    const marker = join(dir, "holder.marker");
    // The holder is a genuinely separate, alive process (its own real pid),
    // so the waiter below can only judge it via process.kill(pid, 0), never
    // by coincidence with the test process's own pid.
    const HOLD_MS = 900;
    const holderScript = `
      import { open, rm } from "node:fs/promises";
      const { acquireReviewSessionFileLock } = await import(${JSON.stringify(moduleUrl)});
      const [sessionPath, marker, holdMs] = process.argv.slice(1);
      const release = await acquireReviewSessionFileLock(sessionPath, { timeoutMs: 20000 });
      const handle = await open(marker, "wx");
      await handle.close();
      await new Promise((r) => setTimeout(r, Number(holdMs)));
      await rm(marker, { force: true });
      await release();
    `;
    const fileExists = async (path: string): Promise<boolean> => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    };
    const holder = spawn(process.execPath, ["--input-type=module", "-e", holderScript, sessionPath, marker, String(HOLD_MS)], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    // Captured immediately: `once` only sees an event fired after it starts
    // listening, so awaiting this later (once the holder may already have
    // exited) would hang forever.
    const holderExit = once(holder, "exit");
    try {
      // Wait for the holder to actually take the lock before racing it.
      const holderStarted = Date.now();
      while (!(await fileExists(marker))) {
        if (Date.now() - holderStarted > 5_000) throw new Error("holder never acquired the lock");
        await new Promise((r) => setTimeout(r, 10));
      }

      // A staleMs far shorter than the holder's hold time: on the pre-fix
      // code, age alone made the lock stale well before the holder released
      // it, so this acquire would succeed *while the marker still exists*
      // (the holder is alive and still working) — a double hold.
      const started = Date.now();
      const release = await acquireReviewSessionFileLock(sessionPath, { staleMs: 150, timeoutMs: HOLD_MS + 5_000 });
      const waitedMs = Date.now() - started;
      const holderStillWorking = await fileExists(marker);
      await release();

      assert.ok(
        !holderStillWorking,
        `entered the lock after only ${waitedMs}ms while the live holder's marker still existed: ` +
          "a stale-by-age lock was broken out from under a holder that was alive and merely slow " +
          "(the exact double-hold defect kontourai/survey#281's reviewer reproduced)",
      );
      assert.ok(waitedMs >= HOLD_MS - 50, `acquired too early (${waitedMs}ms) for a lock held by a live process for ${HOLD_MS}ms`);
    } finally {
      await holderExit;
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe("pid reuse (#298)", () => {
    const withLockDir = async (run: (sessionPath: string) => Promise<void>): Promise<void> => {
      const dir = await mkdtemp(join(tmpdir(), "survey-lock-reuse-"));
      try {
        await run(join(dir, "session.json"));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };
    // A lock whose pid is alive (this test process) but whose recorded start
    // time belongs to an earlier process: its holder died and the pid was reused.
    const writeReusedPidLock = async (sessionPath: string, ageMs: number): Promise<void> => {
      const lockPath = `${sessionPath}.lock`;
      await writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        startIdentity: "ps-lstart:Thu Jan 1 00:00:00 1970",
        token: "dead-holder",
        acquiredAt: new Date(Date.now() - ageMs).toISOString(),
      }));
      const past = new Date(Date.now() - ageMs);
      await utimes(lockPath, past, past);
    };

    test("a lock naming a live pid with a different start time is broken after staleMs, for every contending writer", async (t) => {
      if (process.platform === "win32") t.skip("no process start time on this platform");
      await withLockDir(async (sessionPath) => {
        for (let round = 0; round < 3; round += 1) {
          await writeReusedPidLock(sessionPath, 5_000);
          // allSettled: every writer finishes before the directory is removed,
          // so a timeout is reported as itself.
          const results = await Promise.allSettled(Array.from({ length: 10 }, async () => {
            const release = await acquireReviewSessionFileLock(sessionPath, { staleMs: 1_000, timeoutMs: 5_000 });
            await release();
          }));
          const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
          assert.equal(failed.length, 0, `round ${round}: ${failed.length}/10 writers failed, first: ${String(failed[0]?.reason)}`);
        }
      });
    });

    test("a reused-pid lock younger than staleMs is still waited for (age rule)", async (t) => {
      if (process.platform === "win32") t.skip("no process start time on this platform");
      await withLockDir(async (sessionPath) => {
        await writeReusedPidLock(sessionPath, 0);
        await assert.rejects(
          acquireReviewSessionFileLock(sessionPath, { staleMs: 30_000, timeoutMs: 300 }),
          ReviewSessionFileLockTimeoutError,
        );
      });
    });

    test("a live holder whose recorded start time matches is never broken, however old its lock", async (t) => {
      if (process.platform === "win32") t.skip("no process start time on this platform");
      await withLockDir(async (sessionPath) => {
        const lockPath = `${sessionPath}.lock`;
        const release = await acquireReviewSessionFileLock(sessionPath);
        try {
          const holder = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; startIdentity?: unknown };
          assert.equal(holder.pid, process.pid);
          assert.equal(typeof holder.startIdentity, "string", "the holder records its start time");
          const past = new Date(Date.now() - 60_000);
          await utimes(lockPath, past, past);
          await assert.rejects(
            acquireReviewSessionFileLock(sessionPath, { staleMs: 50, timeoutMs: 500 }),
            ReviewSessionFileLockTimeoutError,
          );
        } finally {
          await release();
        }
      });
    });
  });

  test("orphan temp files from a crashed writer are removed on the next write", async () => {
    await withConsole(async ({ handle, sessionPath, tmpDir }) => {
      const orphan = `${sessionPath}.4194400.00000000-0000-4000-8000-000000000000.tmp`;
      const unrelated = join(tmpDir, "notes.tmp");
      await writeFile(orphan, "{");
      await writeFile(unrelated, "keep");
      const { snapshot, revision } = await readSessionState(handle);
      const res = await postEvents(handle, { events: eventsDeciding(snapshot, { "public-directory-hours": "accept-proposed" }), baseRevision: revision });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const entries = await readdir(tmpDir);
      assert.ok(!entries.includes(resolve(orphan).split("/").pop()!), `orphan still present: ${entries}`);
      assert.ok(entries.includes("notes.tmp"), "unrelated files are left alone");
    });
  });
});
