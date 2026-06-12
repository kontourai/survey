import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startReviewConsoleServer, type ReviewConsoleServerHandle } from "../src/console/review-console-server.js";
import {
  buildReviewSessionEvents,
  defaultReviewSessionName,
  type ReviewQueueSessionState,
} from "../src/review-workbench/review-workbench.js";

const SAMPLE_SESSION = "example-data/mcp-review-session.json";

async function makeIsolatedServer(): Promise<{ handle: ReviewConsoleServerHandle; sessionPath: string; tmpDir: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "survey-console-test-"));
  const sessionPath = join(tmpDir, "session.json");
  await copyFile(SAMPLE_SESSION, sessionPath);
  const handle = await startReviewConsoleServer({ sessionPath, port: 0 });
  return { handle, sessionPath, tmpDir };
}

async function teardown(handle: ReviewConsoleServerHandle, tmpDir: string): Promise<void> {
  await handle.close();
  await rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Suite: basic HTTP contract
// ---------------------------------------------------------------------------

describe("survey-review-console server", () => {
  let tmpDir: string;
  let sessionPath: string;
  let handle: ReviewConsoleServerHandle;

  before(async () => {
    ({ handle, sessionPath, tmpDir } = await makeIsolatedServer());
  });

  after(async () => {
    await teardown(handle, tmpDir);
  });

  test("GET / returns 200 with HTML containing workbench mount root", async () => {
    const res = await fetch(handle.url);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("text/html"), `expected text/html, got: ${ct}`);
    const html = await res.text();
    assert.ok(html.includes('id="review-workbench"'), "missing #review-workbench mount point");
    assert.ok(html.includes("/dist/src/review-workbench/review-workbench.js"), "missing workbench.js script reference");
    assert.ok(html.includes("/api/session"), "missing /api/session reference in client script");
    assert.ok(html.includes("/api/stream"), "missing /api/stream reference in client script");
  });

  test("GET /api/session returns 200 with session shape", async () => {
    const res = await fetch(`${handle.url}api/session`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("application/json"), `expected application/json, got: ${ct}`);

    const body = await res.json() as Record<string, unknown>;
    assert.ok("session" in body, "missing session field");
    assert.ok("snapshot" in body, "missing snapshot field");
    assert.ok("events" in body, "missing events field");
    assert.ok("state" in body, "missing state field");
    assert.ok(Array.isArray(body.events), "events must be an array");

    const state = body.state as Record<string, unknown>;
    assert.ok(Array.isArray(state.items), "state.items must be an array");
    assert.ok((state.items as unknown[]).length > 0, "state.items must be non-empty");
    assert.equal(typeof state.activeItemName, "string");
  });

  test("GET /dist/src/review-workbench/review-workbench.js returns 200 with JavaScript", async () => {
    const res = await fetch(`${handle.url}dist/src/review-workbench/review-workbench.js`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("javascript"), `expected javascript, got: ${ct}`);
    const text = await res.text();
    assert.ok(text.length > 100, "workbench.js appears empty");
  });

  test("GET /dist/src/review-workbench/review-workbench.css returns 200 with CSS", async () => {
    const res = await fetch(`${handle.url}dist/src/review-workbench/review-workbench.css`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("css"), `expected css, got: ${ct}`);
  });

  test("GET /dist/src/review-workbench/vendor/console-kit/tokens/index.css returns 200 with CSS", async () => {
    const res = await fetch(`${handle.url}dist/src/review-workbench/vendor/console-kit/tokens/index.css`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("css"), `expected css, got: ${ct}`);
  });

  test("traversal-safe: /dist/../package.json is rejected", async () => {
    // The URL parser normalises /dist/../package.json to /package.json before the dist handler runs,
    // so that traversal class is neutralized at the URL level. The dist handler also rejects
    // percent-encoded '..' segments in the path.
    const normalized = await fetch(`${handle.url}dist/../package.json`);
    // After URL normalization, /package.json hits the HTML catch-all (200) or 404; either is fine
    // as long as it does NOT return the package.json contents parsed as JSON.
    const ct = normalized.headers.get("content-type") ?? "";
    // The package.json path goes to catch-all HTML (200 text/html) — not the actual file
    assert.ok(!ct.includes("application/json"), `traversal must not serve JSON: got ${ct}`);

    // Also test that percent-encoded .. is rejected by the dist handler directly
    const encoded = await fetch(`${handle.url}dist/..%2Fpackage.json`);
    assert.ok(encoded.status === 404 || encoded.status === 400, `encoded traversal must be 404/400, got ${encoded.status}`);
  });

  test("POST /api/events round-trip mutates session file and returns ok", async () => {
    const raw = await readFile(sessionPath, "utf8");
    const { snapshot } = JSON.parse(raw) as { snapshot: ReviewQueueSessionState };

    const item = snapshot.items[0];
    const sessionWithDecision: ReviewQueueSessionState = {
      ...snapshot,
      decisionsByItemName: {
        ...snapshot.decisionsByItemName,
        [item.metadata.name]: "accept-proposed",
      },
    };
    const newEvents = buildReviewSessionEvents(sessionWithDecision, defaultReviewSessionName);

    const postRes = await fetch(`${handle.url}api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: newEvents }),
    });
    assert.equal(postRes.status, 200);
    const postBody = await postRes.json() as Record<string, unknown>;
    assert.equal(postBody.ok, true);
    assert.equal(postBody.eventCount, newEvents.length);

    // Verify the file was actually mutated
    const afterRaw = await readFile(sessionPath, "utf8");
    const after = JSON.parse(afterRaw) as { events: unknown[] };
    assert.equal(after.events.length, newEvents.length);

    // Verify /api/session reflects the change
    const sessionRes = await fetch(`${handle.url}api/session`);
    const sessionData = await sessionRes.json() as Record<string, unknown>;
    const state = sessionData.state as Record<string, unknown>;
    const decisions = state.decisionsByItemName as Record<string, string>;
    assert.equal(decisions[item.metadata.name], "accept-proposed");
  });

  test("SSE /api/stream emits 'update' event after a POST to /api/events", async () => {
    const updateReceived = new Promise<void>((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error("SSE update not received within 5s"));
      }, 5000);

      fetch(`${handle.url}api/stream`, { signal: controller.signal })
        .then(async (res) => {
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.includes("event: update")) {
              clearTimeout(timer);
              controller.abort();
              resolve();
              break;
            }
          }
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          clearTimeout(timer);
          reject(err as Error);
        });
    });

    await new Promise((r) => setTimeout(r, 150));

    const raw = await readFile(sessionPath, "utf8");
    const { snapshot } = JSON.parse(raw) as { snapshot: ReviewQueueSessionState };
    const sessionWithDecision: ReviewQueueSessionState = {
      ...snapshot,
      decisionsByItemName: {
        ...snapshot.decisionsByItemName,
        [snapshot.items[0].metadata.name]: "keep-current",
      },
    };
    const events = buildReviewSessionEvents(sessionWithDecision, defaultReviewSessionName);

    await fetch(`${handle.url}api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });

    await updateReceived;
  });

  test("second client sees SSE update after a POST", async () => {
    const { handle: h2, sessionPath: sp2, tmpDir: td2 } = await makeIsolatedServer();

    try {
      const makeReceiver = () => new Promise<void>((resolveP, rejectP) => {
        const ac = new AbortController();
        const t = setTimeout(() => { ac.abort(); rejectP(new Error("SSE timeout")); }, 5000);
        fetch(`${h2.url}api/stream`, { signal: ac.signal }).then(async (res) => {
          const reader = res.body!.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            if (buf.includes("event: update")) {
              clearTimeout(t);
              ac.abort();
              resolveP();
              break;
            }
          }
        }).catch((e: unknown) => {
          if (e instanceof Error && e.name === "AbortError") return;
          clearTimeout(t);
          rejectP(e as Error);
        });
      });

      const first = makeReceiver();
      const second = makeReceiver();

      await new Promise((r) => setTimeout(r, 200));

      const raw = await readFile(sp2, "utf8");
      const { snapshot } = JSON.parse(raw) as { snapshot: ReviewQueueSessionState };
      const events = buildReviewSessionEvents(snapshot, defaultReviewSessionName);
      await fetch(`${h2.url}api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
      });

      await Promise.all([first, second]);
    } finally {
      await teardown(h2, td2);
    }
  });

  test("loopback-only: non-loopback host is rejected", async () => {
    await assert.rejects(
      () => startReviewConsoleServer({ sessionPath, host: "0.0.0.0", port: 0 }),
      /loopback/,
    );
  });

  test("GET /health returns 200 ok", async () => {
    const res = await fetch(`${handle.url}health`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
  });
});
