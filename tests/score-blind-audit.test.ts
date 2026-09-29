/**
 * Score-blind audit mode (#296). A session can hide every proposer confidence
 * and verifier result on every decision surface; each decision made in it
 * records that it was made blind and how its item was sampled, and both facts
 * survive replay and the canonical projection so calibration can select them.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";
import { buildCandidateVerification } from "../src/candidate-verification.js";
import { buildCanonicalReviewedTrustInput, deriveCalibration } from "../src/index.js";
import type { ReviewItem } from "../src/review-resource.js";
import { buildReviewSessionEvents, initialReviewQueueSessionState, type ReviewQueueSessionState } from "../src/review-workbench/review-queue-session.js";
import { candidateVerificationNotes } from "../src/review-workbench/review-presentation.js";
import {
  buildReviewDecision,
  currentReviewWorkbenchState,
  drawRandomAuditSample,
  openRandomAuditSession,
  renderReviewWorkbenchHtml,
} from "../src/review-workbench/review-workbench.js";
import { applyReviewSession } from "../src/review-workbench/server-review-session.js";
import { buildEnvelopeImportFixture, paginatingEnvelopeSeeds } from "./envelope-review-fixture.js";

const SAMPLING = { kind: "random-audit" as const, rate: 0.5, seed: "audit-2026-09" };

/** Envelope items (confidence 0.9 on every proposal) with a verifier record on the first. */
function itemsWithScores(): ReviewItem[] {
  const items = JSON.parse(JSON.stringify(buildEnvelopeImportFixture().reviewItems)) as ReviewItem[];
  const proposed = items[0]!.spec.candidates[0]!;
  const record = buildCandidateVerification({
    input: { candidateId: proposed.id, value: proposed.value, evidence: [{ id: "ev-1", excerpt: proposed.locator!.excerpt!, locator: proposed.locator!.locator! }] },
    verifier: { id: "support-check", version: "2.1.0", method: "model" },
    verdict: { result: "supported" },
    createdAt: "2026-09-28T12:00:00.000Z",
  });
  proposed.verifications = [JSON.parse(JSON.stringify(record))];
  return items;
}

function blind(session: ReviewQueueSessionState): ReviewQueueSessionState {
  return { ...session, presentation: { scoreBlind: true }, sampling: SAMPLING };
}

function renderedPrompt(decision: ReturnType<typeof buildReviewDecision>): string {
  return (decision?.spec.authorizing as { renderedPrompt?: string } | undefined)?.renderedPrompt ?? "";
}

describe("score-blind workbench rendering", () => {
  it("renders no confidence meter and no verifier result in a score-blind session", () => {
    const items = itemsWithScores();
    const [note] = candidateVerificationNotes(items[0]!);
    const shown = renderReviewWorkbenchHtml(initialReviewQueueSessionState(items));
    // The fixture reaches the meter and the note when the session is not blind.
    assert.match(shown, /data-testid="confidence-meter"/);
    assert.ok(shown.includes(note!.sentence));
    assert.doesNotMatch(shown, /data-testid="score-blind-notice"/);

    const hidden = renderReviewWorkbenchHtml(blind(initialReviewQueueSessionState(items)));
    assert.doesNotMatch(hidden, /data-testid="confidence-meter"/);
    assert.doesNotMatch(hidden, /data-testid="support-verification"/);
    assert.ok(!hidden.includes(note!.sentence));
    assert.doesNotMatch(hidden, />0\.90</, "no score text leaks into the card");
    assert.match(hidden, /data-testid="score-blind-notice"[^>]*data-sampling="random-audit"/);
    // Every item stays reviewable: the source excerpt is what the reviewer decides from.
    assert.equal((hidden.match(/data-testid="proposed-excerpt"/g) ?? []).length, items.length);
  });

  it("stays blind once a decision is made, and the recorded prompt names no verifier result", () => {
    const items = itemsWithScores();
    const name = items[0]!.metadata.name;
    const decided = { ...blind(initialReviewQueueSessionState(items)), decisionsByItemName: { [name]: "accept-proposed" as const } };
    assert.doesNotMatch(renderReviewWorkbenchHtml(decided), /data-testid="confidence-meter"|data-testid="support-verification"/);
    const [note] = candidateVerificationNotes(items[0]!);
    const seen = renderedPrompt(buildReviewDecision(currentReviewWorkbenchState({ ...decided, presentation: undefined, sampling: undefined })));
    assert.ok(seen.includes(note!.sentence), "a sighted decision records the note it saw");
    assert.ok(!renderedPrompt(buildReviewDecision(currentReviewWorkbenchState(decided))).includes(note!.sentence));
  });
});

describe("decisions record how they were made", () => {
  it("carry scoreBlind and the sampling descriptor through replay, apply and canonical projection", () => {
    const items = itemsWithScores();
    const snapshot = blind(initialReviewQueueSessionState(items));
    const decided: ReviewQueueSessionState = {
      ...snapshot,
      decisionsByItemName: { [items[0]!.metadata.name]: "accept-proposed", [items[1]!.metadata.name]: "reject-proposed" },
    };
    const events = buildReviewSessionEvents(decided, "audit-session");
    const applied = applyReviewSession({ snapshot, events, sessionName: "audit-session" });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    assert.equal(applied.decisions.length, 2);
    for (const decision of applied.decisions) {
      assert.deepEqual(decision.spec.presentation, { scoreBlind: true });
      assert.deepEqual(decision.spec.sampling, SAMPLING);
    }
    const reviewedItems = items.filter((item) => item.metadata.name in decided.decisionsByItemName);
    const projection = buildCanonicalReviewedTrustInput({
      source: "audit", generatedAt: "2026-09-28T13:00:00.000Z", projectionContextId: "audit-1", items: reviewedItems, results: applied.results,
    });
    for (const outcome of projection.surveyInput.reviewOutcomes) {
      assert.deepEqual(outcome.metadata?.presentation, { scoreBlind: true });
      assert.deepEqual(outcome.metadata?.sampling, SAMPLING);
    }

    // Calibration can select exactly these audit labels.
    const all = deriveCalibration(projection.surveyInput);
    const audit = deriveCalibration(projection.surveyInput, { auditSamplesOnly: true });
    assert.equal(audit.sampleCount, all.sampleCount);
    assert.equal(audit.sampleCount, 2);

    // A sighted session's decisions record nothing and are not audit labels.
    const sightedEvents = buildReviewSessionEvents({ ...decided, presentation: undefined, sampling: undefined }, "sighted");
    const sighted = applyReviewSession({ snapshot: initialReviewQueueSessionState(items), events: sightedEvents, sessionName: "sighted" });
    assert.equal(sighted.ok, true);
    assert.equal(sighted.decisions[0]!.spec.presentation, undefined);
    const sightedProjection = buildCanonicalReviewedTrustInput({
      source: "audit", generatedAt: "2026-09-28T13:00:00.000Z", projectionContextId: "sighted-1", items: reviewedItems, results: sighted.results,
    });
    assert.equal(sightedProjection.surveyInput.reviewOutcomes[0]!.metadata?.presentation, undefined);
    const filtered = deriveCalibration(sightedProjection.surveyInput, { auditSamplesOnly: true });
    assert.equal(filtered.sampleCount, 0);
    assert.equal(filtered.skippedCount, 2);
    assert.equal(deriveCalibration(sightedProjection.surveyInput).sampleCount, 2);
  });

  it("a score-blind queue sample (not a random audit) is not an audit label", () => {
    const items = itemsWithScores();
    const snapshot = { ...initialReviewQueueSessionState(items), presentation: { scoreBlind: true }, sampling: { kind: "queue" as const } };
    const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName: { [items[0]!.metadata.name]: "accept-proposed" } }, "queue");
    const applied = applyReviewSession({ snapshot, events, sessionName: "queue" });
    assert.equal(applied.ok, true);
    const projection = buildCanonicalReviewedTrustInput({ source: "q", generatedAt: "2026-09-28T13:00:00.000Z", projectionContextId: "q-1", items: [items[0]!], results: applied.results });
    assert.deepEqual(projection.surveyInput.reviewOutcomes[0]!.metadata?.sampling, { kind: "queue" });
    assert.equal(deriveCalibration(projection.surveyInput, { auditSamplesOnly: true }).sampleCount, 0);
  });

  it("refuses decision events recorded under other conditions than the snapshot's", () => {
    const items = itemsWithScores();
    const name = items[0]!.metadata.name;
    const blindSnapshot = blind(initialReviewQueueSessionState(items));
    const sightedSnapshot = initialReviewQueueSessionState(items);
    const sightedEvents = buildReviewSessionEvents({ ...sightedSnapshot, decisionsByItemName: { [name]: "accept-proposed" } }, "s");
    const blindEvents = buildReviewSessionEvents({ ...blindSnapshot, decisionsByItemName: { [name]: "accept-proposed" } }, "s");
    assert.deepEqual(blindEvents.find((event) => event.spec.eventType === "decision-submitted")!.spec.data?.sessionConditions, { presentation: { scoreBlind: true }, sampling: SAMPLING });
    const refused = (snapshot: ReviewQueueSessionState, events: typeof blindEvents) => {
      const result = applyReviewSession({ snapshot, events, sessionName: "s" });
      assert.equal(result.ok, false);
      assert.match(JSON.stringify(result.issues), /session conditions/);
    };
    refused(blindSnapshot, sightedEvents);
    refused(sightedSnapshot, blindEvents);
    refused({ ...blindSnapshot, presentation: { scoreBlind: false } }, blindEvents);
    refused({ ...blindSnapshot, sampling: { kind: "random-audit", rate: 0.9, seed: "audit-2026-09" } }, blindEvents);
    assert.equal(applyReviewSession({ snapshot: blindSnapshot, events: blindEvents, sessionName: "s" }).ok, true);
  });

  it("refuses malformed session conditions instead of recording them", () => {
    const items = itemsWithScores();
    const state = { ...currentReviewWorkbenchState(initialReviewQueueSessionState(items)), decision: "accept-proposed" as const };
    const bad: Array<[string, Record<string, unknown>]> = [
      ["string flag", { presentation: { scoreBlind: "yes" } }],
      ["extra presentation key", { presentation: { scoreBlind: true, byReviewer: true } }],
      ["rate zero", { sampling: { kind: "random-audit", rate: 0, seed: "s" } }],
      ["rate above one", { sampling: { kind: "random-audit", rate: 1.5, seed: "s" } }],
      ["no seed", { sampling: { kind: "random-audit", rate: 0.2 } }],
      ["blank seed", { sampling: { kind: "random-audit", rate: 0.2, seed: " " } }],
      ["seed with spaces", { sampling: { kind: "random-audit", rate: 0.2, seed: "audit seed" } }],
      ["queue with rate", { sampling: { kind: "queue", rate: 0.2 } }],
      ["unknown kind", { sampling: { kind: "manual" } }],
    ];
    for (const [label, conditions] of bad) {
      assert.throws(() => buildReviewDecision({ ...state, ...conditions } as never), /Review session|random-audit/, label);
    }
  });
});

describe("random audit sample", () => {
  const items = JSON.parse(JSON.stringify(buildEnvelopeImportFixture(paginatingEnvelopeSeeds(60)).reviewItems)) as ReviewItem[];
  const names = (sample: readonly ReviewItem[]): string[] => sample.map((item) => item.metadata.name);

  it("the same seed draws the same sample, in any input order", () => {
    const first = drawRandomAuditSample(items, { rate: 0.3, seed: "seed-a" });
    assert.deepEqual(names(drawRandomAuditSample(items, { rate: 0.3, seed: "seed-a" })), names(first));
    assert.deepEqual(names(drawRandomAuditSample([...items].reverse(), { rate: 0.3, seed: "seed-a" })).sort(), names(first).sort());
    assert.ok(first.length > 0 && first.length < items.length, `a 0.3 draw of 60 is a proper subset (got ${first.length})`);
    assert.notDeepEqual(names(drawRandomAuditSample(items, { rate: 0.3, seed: "seed-b" })), names(first), "another seed draws another sample");
    // An item's inclusion does not depend on the other items.
    const half = items.slice(0, 30);
    assert.deepEqual(names(drawRandomAuditSample(half, { rate: 0.3, seed: "seed-a" })), names(first).filter((name) => names(half).includes(name)));
    assert.equal(drawRandomAuditSample(items, { rate: 1, seed: "seed-a" }).length, items.length);
  });

  it("opens the sample as a score-blind random-audit session", () => {
    const session = openRandomAuditSession(items, { rate: 0.3, seed: "seed-a", actorId: "auditor" });
    assert.deepEqual(names(session.items), names(drawRandomAuditSample(items, { rate: 0.3, seed: "seed-a" })));
    assert.deepEqual(session.presentation, { scoreBlind: true });
    assert.deepEqual(session.sampling, { kind: "random-audit", rate: 0.3, seed: "seed-a" });
    assert.equal(session.actorId, "auditor");
    assert.doesNotMatch(renderReviewWorkbenchHtml(session), /data-testid="confidence-meter"/);
  });

  it("refuses an invalid rate, an empty seed, duplicate names and an empty draw", () => {
    for (const rate of [0, -0.1, 1.01, Number.NaN]) assert.throws(() => drawRandomAuditSample(items, { rate, seed: "s" }), /rate/);
    assert.throws(() => drawRandomAuditSample(items, { rate: 0.5, seed: "" }), /seed/);
    assert.throws(() => drawRandomAuditSample([items[0]!, items[0]!], { rate: 0.5, seed: "s" }), /unique names/);
    assert.throws(() => openRandomAuditSession(items.slice(0, 1), { rate: 1e-9, seed: "s" }), /drew no items/);
  });
});

function rpc(server: ReturnType<typeof spawn>) {
  const waiters = new Map<number, (value: any) => void>();
  createInterface({ input: server.stdout! }).on("line", (line) => {
    if (!line.trim()) return;
    const parsed = JSON.parse(line);
    if (typeof parsed.id === "number") waiters.get(parsed.id)?.(parsed);
  });
  let id = 0;
  return (method: string, params: unknown): Promise<any> => {
    id += 1;
    const current = id;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 15_000);
      waiters.set(current, (value) => { clearTimeout(timer); resolve(value); });
    });
    server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
    return response;
  };
}

async function withMcpSession(snapshot: ReviewQueueSessionState, run: (call: ReturnType<typeof rpc>, sessionPath: string) => Promise<void>): Promise<void> {
  const example = JSON.parse(await readFile("example-data/mcp-review-session.json", "utf8")) as Record<string, any>;
  example.session.spec.reviewItemNames = snapshot.items.map((item) => item.metadata.name);
  const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-score-blind-"));
  const sessionPath = join(tmpDir, "session.json");
  await writeFile(sessionPath, JSON.stringify({ session: example.session, snapshot, events: [] }, null, 2));
  const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], { stdio: ["pipe", "pipe", "inherit"] });
  const call = rpc(server);
  try {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await run(call, sessionPath);
  } finally {
    server.stdin!.end();
    await once(server, "exit");
    await rm(tmpDir, { recursive: true, force: true });
  }
}

describe("score-blind MCP server", () => {
  it("shows no confidence or verifier result in item text, data or card, and records the decision as blind", async () => {
    const items = itemsWithScores();
    const itemName = items[0]!.metadata.name;
    const [note] = candidateVerificationNotes(items[0]!);

    // Control: the same item in a sighted session shows both.
    await withMcpSession(initialReviewQueueSessionState(items), async (call) => {
      const response = await call("tools/call", { name: "survey_review_item", arguments: { itemName } });
      const text: string = response.result.content[0].text;
      assert.match(text, /confidence: 90%/);
      assert.ok(text.includes(`Verification: ${note!.sentence}`));
    });

    await withMcpSession(blind(initialReviewQueueSessionState(items)), async (call, sessionPath) => {
      const queue = await call("tools/call", { name: "survey_review_queue", arguments: {} });
      const queueText: string = queue.result.content[0].text;
      assert.match(queueText, /Random audit sample\. Score-blind review/);
      const queueData = JSON.parse(queueText.slice(queueText.indexOf("\n{") + 1));
      assert.deepEqual(queueData.presentation, { scoreBlind: true });
      assert.deepEqual(queueData.sampling, SAMPLING);
      const queueCard = queue.result.content.find((entry: { type: string }) => entry.type === "resource")?.resource?.text ?? "";
      assert.doesNotMatch(queueCard, /class="conf"|confidence 90%/);

      const response = await call("tools/call", { name: "survey_review_item", arguments: { itemName } });
      assert.equal(response.result.isError, false);
      const text: string = response.result.content[0].text;
      assert.doesNotMatch(text, /confidence: |"confidence"|90%|0\.9\b/);
      assert.doesNotMatch(text, /Verification:|said supported|"verification"/);
      const data = JSON.parse(text.slice(text.indexOf("\n{") + 1));
      for (const candidate of data.candidates) {
        assert.equal("confidence" in candidate, false);
        assert.equal("verification" in candidate, false);
      }
      const card = response.result.content.find((entry: { type: string }) => entry.type === "resource")?.resource?.text ?? "";
      assert.doesNotMatch(card, /class="conf"|confidence 90%/);
      assert.ok(!card.includes(note!.sentence));
      assert.match(card, /id="score-blind-note"/);

      const decide = await call("tools/call", { name: "survey_review_decide", arguments: { itemName, decision: "accept" } });
      assert.equal(decide.result.isError, false);
      assert.doesNotMatch(decide.result.content[0].text, /confidence: |90%|Verification:/);

      const persisted = JSON.parse(await readFile(sessionPath, "utf8"));
      const applied = applyReviewSession({ snapshot: persisted.snapshot, events: persisted.events, sessionName: persisted.events[0].spec.sessionName });
      assert.equal(applied.ok, true, JSON.stringify(applied.issues));
      assert.deepEqual(applied.decisions[0]!.spec.presentation, { scoreBlind: true });
      assert.deepEqual(applied.decisions[0]!.spec.sampling, SAMPLING);
      assert.ok(!renderedPrompt(applied.decisions[0]).includes(note!.sentence), "the recorded prompt names no verifier result");
    });
  });
});
