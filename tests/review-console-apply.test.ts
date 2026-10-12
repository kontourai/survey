import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startReviewConsoleServer, type ReviewConsoleApplyInput } from "../src/console/review-console-server.js";
import { bindReviewQueue, buildReviewSessionEvents, type ReviewQueueSessionState } from "../src/review-workbench/review-workbench.js";

async function fixture(apply = async (_input: ReviewConsoleApplyInput) => ({ reference: "host-decision:fixture", summary: "Workflow recorded the review" })) {
  const root = await mkdtemp(join(tmpdir(), "survey-producer-apply-"));
  const sessionPath = join(root, "session.json");
  const content = JSON.parse(await readFile("example-data/mcp-review-session.json", "utf8"));
  const snapshot: ReviewQueueSessionState = { ...content.snapshot, items: content.snapshot.items.slice(0, 1), decisionsByItemName: {}, notesByItemName: {} };
  const sessionName = content.session.metadata.name;
  await writeFile(sessionPath, JSON.stringify({ ...content, snapshot, events: [] }));
  let calls = 0;
  const handle = await startReviewConsoleServer({ sessionPath, producerApply: {
    binding: bindReviewQueue(snapshot, { sessionName }),
    apply: async input => { calls++; return apply(input); },
  } });
  const get = async () => (await fetch(`${handle.url}api/session`)).json() as Promise<{ revision: string }>;
  const post = async (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${handle.url}api/${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const resolve = async () => {
    const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName: { [snapshot.items[0].metadata.name]: "accept-proposed" } }, sessionName).filter(event => event.spec.eventType.startsWith("decision-"));
    assert.equal((await post("events", { baseRevision: (await get()).revision, events })).status, 200);
  };
  return { root, sessionPath, handle, snapshot, get, post, resolve, calls: () => calls, close: async () => { await handle.close(); await rm(root, { recursive: true }); } };
}

test("saved review roundtrip invokes the producer once and retains its reference", async () => {
  const f = await fixture(async input => {
    assert.equal(input.results.length, 1);
    assert.equal(input.results[0].decision, "accept-proposed");
    assert.ok(input.events.length > 0);
    return { reference: "workflow:approved", summary: "Workflow recorded approval" };
  });
  try {
    const html = await (await fetch(f.handle.url)).text();
    assert.match(html, /id="apply-review"/);
    await f.resolve();
    const revision = (await f.get()).revision;
    const replies = await Promise.all([f.post("apply", { baseRevision: revision }), f.post("apply", { baseRevision: revision })]);
    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
    assert.equal(f.calls(), 1);
    const stored = JSON.parse(await readFile(f.sessionPath, "utf8"));
    assert.equal(stored.producerApplication.reference, "workflow:approved");
    assert.equal((await f.post("events", { baseRevision: revision, events: [] })).status, 409);
  } finally { await f.close(); }
});

test("missing revision, unresolved items, stale revision and cross-origin submissions never reach the producer", async () => {
  const f = await fixture();
  try {
    const revision = (await f.get()).revision;
    assert.equal((await f.post("apply", {})).status, 428);
    assert.equal((await f.post("apply", { baseRevision: revision })).status, 422);
    await f.resolve();
    assert.equal((await f.post("apply", { baseRevision: revision })).status, 409);
    assert.equal((await f.post("apply", { baseRevision: (await f.get()).revision }, { Origin: "https://unrelated.example" })).status, 403);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("changing actual queue bytes after construction refuses application before producer effects", async () => {
  const f = await fixture();
  try {
    await f.resolve();
    const content = JSON.parse(await readFile(f.sessionPath, "utf8"));
    content.snapshot.items[0].spec.rationale = "different artifact basis";
    await writeFile(f.sessionPath, JSON.stringify(content));
    assert.equal((await f.post("apply", { baseRevision: (await f.get()).revision })).status, 409);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("producer current-visit refusal does not persist an application or consume its review", async () => {
  const f = await fixture(async () => { throw new Error("Current workflow visit changed"); });
  try {
    await f.resolve();
    const response = await f.post("apply", { baseRevision: (await f.get()).revision });
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /visit changed/);
    const stored = JSON.parse(await readFile(f.sessionPath, "utf8"));
    assert.equal(stored.producerApplication, undefined);
    assert.ok(stored.events.length > 0);
  } finally { await f.close(); }
});
