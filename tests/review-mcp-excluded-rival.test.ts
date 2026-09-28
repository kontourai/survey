/**
 * An item whose rival value was excluded at import stays needs-review, so
 * accept is allowed. That is only honest if every decision surface shows the
 * rival: the MCP item text, the MCP card, and the recorded decision prompt.
 * Driven end to end through the real MCP server over a real Traverse envelope.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importExtractionEnvelope, type PortableExtractionResultEnvelope } from "../src/extraction-envelope.js";
import { initialReviewQueueSessionState } from "../src/review-workbench/review-queue-session.js";
import {
  buildReviewDecision,
  buildReviewDecisionsFromSession,
  deriveReviewSessionApplyResultForSnapshot,
  initialReviewWorkbenchState,
  renderReviewWorkbenchHtml,
  replayReviewSessionEventsForSnapshot,
} from "../src/review-workbench/review-workbench.js";
import { buildReviewItemPresentation, type ReviewPresentationAdapter } from "../src/review-workbench/review-presentation.js";
import { buildReviewSessionEvents } from "../src/review-workbench/review-queue-session.js";
import { createServerReviewSessionRecord, deriveServerReviewSessionApplyResult } from "../src/review-workbench/server-review-session.js";
import type { ReviewDecision, ReviewItem } from "../src/review-resource.js";

const ENVELOPE_PRODUCER = "survey.kontourai.io/extraction-envelope";

function renderedPrompt(decision: ReviewDecision | undefined): string {
  return (decision?.spec.authorizing as { renderedPrompt?: string } | undefined)?.renderedPrompt ?? "";
}

function edited(item: ReviewItem, change: (meta: Record<string, any>, copy: Record<string, any>) => void): ReviewItem {
  const copy = JSON.parse(JSON.stringify(item));
  change(copy.metadata.producer[ENVELOPE_PRODUCER], copy);
  return copy;
}

const TEXT = "Fee: 48000 per year. Summary Fee: 48000. Amended Fee: 52000.";

async function verifiedItemsWithExcludedRival() {
  const envelope = JSON.parse(await readFile("tests/fixtures/traverse-envelopes/success-conflicting-fee.v1.json", "utf8")) as PortableExtractionResultEnvelope;
  const rival = envelope.result.proposals[2]!;
  rival.candidateValue = 52001; rival.provenance.excerpt = "52001";
  const imported = importExtractionEnvelope(envelope, {
    sourceKind: "uploaded-document",
    claimTarget: (proposal) => ({ subjectType: "vendor", subjectId: "acme", facet: "vendor.contract", claimType: "vendor.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "medium" }),
    artifact: { status: "available", text: TEXT, actualDigest: createHash("sha256").update(TEXT).digest("hex") },
  });
  assert.equal(imported.reviewItems.length, 1);
  assert.equal(imported.reviewItems[0]!.spec.candidateSetStatus, "needs-review");
  return imported.reviewItems;
}

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

describe("an excluded rival value on the MCP decision path", () => {
  test("the item text, the card, and the recorded decision prompt all name the excluded rival", async () => {
    const items = await verifiedItemsWithExcludedRival();
    const itemName = items[0]!.metadata.name;
    const example = JSON.parse(await readFile("example-data/mcp-review-session.json", "utf8")) as Record<string, any>;
    const snapshot = initialReviewQueueSessionState(items);
    example.session.spec.reviewItemNames = [itemName];
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-excluded-"));
    const sessionPath = join(tmpDir, "session.json");
    await writeFile(sessionPath, JSON.stringify({ session: example.session, snapshot, events: [] }, null, 2));

    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], { stdio: ["pipe", "pipe", "inherit"] });
    const call = rpc(server);
    try {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const item = await call("tools/call", { name: "survey_review_item", arguments: { itemName } });
      assert.equal(item.result.isError, false);
      const text: string = item.result.content[0].text;
      assert.match(text, /Proposed value: 48000/);
      assert.match(text, /Excluded: Another proposed value was excluded at import .*52001 \(proposal 2, chars:54-59\)/);
      assert.match(text, /"excludedProposals"/);
      assert.match(text, /Excerpts were checked against the prepared source text at import\./);
      const card = item.result.content.find((entry: { type: string }) => entry.type === "resource")?.resource?.text ?? "";
      assert.match(card, /id="excluded-note"[^>]*>[^<]*52001/);

      const decide = await call("tools/call", { name: "survey_review_decide", arguments: { itemName, decision: "accept" } });
      assert.equal(decide.result.isError, false);
      assert.match(decide.result.content[0].text, /52001/);

      const persisted = JSON.parse(await readFile(sessionPath, "utf8"));
      const state = replayReviewSessionEventsForSnapshot(persisted.snapshot, persisted.events);
      const [decision] = buildReviewDecisionsFromSession(state);
      const prompt = (decision!.spec.authorizing as { renderedPrompt?: string } | undefined)?.renderedPrompt ?? "";
      assert.match(prompt, /Selected decision: Accept proposed\./);
      assert.match(prompt, /52001 \(proposal 2, chars:54-59\)/, "the audit trail must show the reviewer was told about the rival");
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("malformed or unbound stored metadata never breaks a card or claims verification", async () => {
    const [item] = await verifiedItemsWithExcludedRival();
    const edit = (change: (meta: Record<string, any>, copy: Record<string, any>) => void) => {
      const copy = JSON.parse(JSON.stringify(item));
      change(copy.metadata.producer["survey.kontourai.io/extraction-envelope"], copy);
      return copy;
    };
    const junk = buildReviewItemPresentation(edit((meta) => { meta.excludedProposals = [null, 7, { proposalIndex: "x" }]; }));
    assert.deepEqual(junk.excludedProposals, []);
    assert.deepEqual(junk.excludedProposalsUnreadable, { reason: "malformed-entries", count: 3 });
    assert.equal(junk.excerptVerification, "verified");
    // No binding: a bare metadata object cannot vouch for anything.
    const forged = buildReviewItemPresentation(edit((meta, copy) => {
      copy.metadata.producer["survey.kontourai.io/extraction-envelope"] = { excerptVerification: "verified", excludedProposals: meta.excludedProposals };
    }));
    assert.equal(forged.excerptVerification, undefined);
    assert.deepEqual(forged.excludedProposals, []);
    assert.deepEqual(forged.excludedProposalsUnreadable, { reason: "binding-broken", count: 1 });
    // Candidates bound to another import do not count as a binding either.
    const crossBound = buildReviewItemPresentation(edit((_meta, copy) => {
      copy.spec.candidates[0].producer["survey.kontourai.io/extraction-envelope"].importName = "other-import";
    }));
    assert.equal(crossBound.excerptVerification, undefined);
  });

  test("stored excluded entries that cannot be shown are flagged on the card, the audit rows, the MCP surfaces and the prompt", async () => {
    const [item] = await verifiedItemsWithExcludedRival();
    // One valid entry and two malformed ones: the valid one is shown, and the card says two were not.
    const mixed = edited(item!, (meta) => { meta.excludedProposals = [meta.excludedProposals[0], null, { proposalIndex: "x" }]; });
    const mixedPresentation = buildReviewItemPresentation(mixed);
    assert.equal(mixedPresentation.excludedProposals.length, 1);
    assert.deepEqual(mixedPresentation.excludedProposalsUnreadable, { reason: "malformed-entries", count: 2 });
    const mixedCard = renderReviewWorkbenchHtml(initialReviewWorkbenchState(mixed));
    assert.match(mixedCard, /data-testid="excluded-proposal"/);
    assert.match(mixedCard, /data-testid="excluded-proposals-unreadable" data-reason="malformed-entries"[\s\S]*2 stored excluded entries are unreadable and not shown\./);
    assert.match(mixedCard, /data-audit-row="excluded-proposals-unreadable"/);
    assert.match(renderedPrompt(buildReviewDecision({ ...initialReviewWorkbenchState(mixed), decision: "accept-proposed" })), /2 stored excluded entries are unreadable and not shown\./);

    // A candidate that lost its import name breaks the binding: 0 of 1 stored rivals can be shown, and that is said.
    const unbound = edited(item!, (_meta, copy) => { delete copy.spec.candidates[0].producer[ENVELOPE_PRODUCER].importName; });
    assert.deepEqual(buildReviewItemPresentation(unbound).excludedProposals, []);
    assert.deepEqual(buildReviewItemPresentation(unbound).excludedProposalsUnreadable, { reason: "binding-broken", count: 1 });
    const unboundCard = renderReviewWorkbenchHtml(initialReviewWorkbenchState(unbound));
    assert.match(unboundCard, /data-testid="excluded-proposals-unreadable" data-reason="binding-broken"[\s\S]*1 stored excluded entry is not shown because this item&#39;s extraction binding is broken\./);
    assert.match(renderedPrompt(buildReviewDecision({ ...initialReviewWorkbenchState(unbound), decision: "accept-proposed" })), /1 stored excluded entry is not shown because this item's extraction binding is broken\./);

    // Item metadata replaced by a non-object, or removed, while the candidates still carry the envelope binding: binding broken, count unknown.
    for (const replacement of ["tampered", ["tampered"], undefined]) {
      const replaced = edited(item!, (_meta, copy) => { copy.metadata.producer[ENVELOPE_PRODUCER] = replacement; });
      assert.deepEqual(buildReviewItemPresentation(replaced).excludedProposalsUnreadable, { reason: "binding-broken" }, JSON.stringify(replacement));
      assert.match(renderedPrompt(buildReviewDecision({ ...initialReviewWorkbenchState(replaced), decision: "accept-proposed" })), /Stored excluded proposals are not shown because this item's extraction binding is broken\./);
    }
    // An item from another producer (no envelope binding anywhere) says nothing.
    const foreign = edited(item!, (_meta, copy) => { delete copy.metadata.producer[ENVELOPE_PRODUCER]; for (const c of copy.spec.candidates) delete c.producer[ENVELOPE_PRODUCER]; });
    assert.equal(buildReviewItemPresentation(foreign).excludedProposalsUnreadable, undefined);
    // A stored field that is not a list is unreadable, count unknown.
    assert.deepEqual(buildReviewItemPresentation(edited(item!, (meta) => { meta.excludedProposals = "tampered"; })).excludedProposalsUnreadable, { reason: "malformed-entries" });
    // An intact item hides nothing and says nothing extra.
    assert.equal(buildReviewItemPresentation(item!).excludedProposalsUnreadable, undefined);

    // The MCP item text, data and card say the same.
    const itemName = mixed.metadata.name;
    const example = JSON.parse(await readFile("example-data/mcp-review-session.json", "utf8")) as Record<string, any>;
    example.session.spec.reviewItemNames = [itemName];
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-unreadable-"));
    const sessionPath = join(tmpDir, "session.json");
    await writeFile(sessionPath, JSON.stringify({ session: example.session, snapshot: initialReviewQueueSessionState([mixed]), events: [] }, null, 2));
    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], { stdio: ["pipe", "pipe", "inherit"] });
    const call = rpc(server);
    try {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const response = await call("tools/call", { name: "survey_review_item", arguments: { itemName } });
      assert.equal(response.result.isError, false);
      const text: string = response.result.content[0].text;
      assert.match(text, /Excluded: 2 stored excluded entries are unreadable and not shown\./);
      assert.match(text, /"excludedProposalsUnreadable": \{\s*"reason": "malformed-entries",\s*"count": 2/);
      const card = response.result.content.find((entry: { type: string }) => entry.type === "resource")?.resource?.text ?? "";
      assert.match(card, /id="excluded-unreadable-note"[^>]*>2 stored excluded entries are unreadable/);
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("the recorded prompt renders values with the card's presentation adapter", async () => {
    const [item] = await verifiedItemsWithExcludedRival();
    const adapter: ReviewPresentationAdapter = {
      labelForTarget: () => "Annual fee",
      summarizeValue: (value) => `USD ${String(value)}`,
    };
    const card = renderReviewWorkbenchHtml(initialReviewWorkbenchState(item!), undefined, { presentationAdapter: adapter });
    assert.match(card, /USD 48000/);
    assert.match(card, /<q>USD 52001<\/q>/);

    const prompt = renderedPrompt(buildReviewDecision({ ...initialReviewWorkbenchState(item!), decision: "accept-proposed" }, { presentationAdapter: adapter }));
    assert.match(prompt, /^For Annual fee, decide whether USD 48000 should replace /);
    assert.match(prompt, /USD 52001 \(proposal 2, chars:54-59\)/);

    // The server apply boundary records the same prompt when given the same adapter.
    const snapshot = initialReviewQueueSessionState([item!]);
    const decided = { ...snapshot, decisionsByItemName: { [item!.metadata.name]: "accept-proposed" as const } };
    const applied = deriveReviewSessionApplyResultForSnapshot({ snapshot, events: buildReviewSessionEvents(decided), presentationAdapter: adapter });
    assert.equal(renderedPrompt(applied.decisions[0]), renderedPrompt(buildReviewDecision({ ...initialReviewWorkbenchState(item!), decision: "accept-proposed", reviewedAt: applied.decisions[0]!.spec.reviewedAt!, actorId: applied.decisions[0]!.spec.actor!.id }, { presentationAdapter: adapter })));
    assert.match(renderedPrompt(applied.decisions[0]), /USD 52001/);
  });

  test("the server apply boundary records the card-adapted prompt when given the card's adapter", async () => {
    const [item] = await verifiedItemsWithExcludedRival();
    const adapter: ReviewPresentationAdapter = { labelForTarget: () => "Annual fee", summarizeValue: (value) => `USD ${String(value)}` };
    const snapshot = initialReviewQueueSessionState([item!]);
    const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName: { [item!.metadata.name]: "accept-proposed" } });
    const record = createServerReviewSessionRecord({ sessionName: events[0]!.spec.sessionName, snapshot });
    const adapted = renderedPrompt(deriveServerReviewSessionApplyResult({ record, events, presentationAdapter: adapter }).decisions[0]);
    assert.match(adapted, /^For Annual fee, decide whether USD 48000 should replace /);
    assert.match(adapted, /USD 52001 \(proposal 2, chars:54-59\)/);
    assert.equal(adapted, renderedPrompt(deriveReviewSessionApplyResultForSnapshot({ snapshot, events, presentationAdapter: adapter }).decisions[0]));
  });
});
