/**
 * Verifier records on a candidate must read the same on every decision
 * surface: the MCP item (text, data and card), the workbench card, and the
 * recorded decision prompt. A forged record is ignored everywhere, a record on
 * another value never reads as a verdict, and an item without records shows
 * nothing.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";
import { buildCandidateVerification, type SupportVerificationInput } from "../src/candidate-verification.js";
import { currentProposedReviewItem, type CurrentProposedCandidateInput } from "../src/current-proposed-review-item.js";
import type { ReviewItem } from "../src/review-resource.js";
import { initialReviewQueueSessionState } from "../src/review-workbench/review-queue-session.js";
import { candidateVerificationNotes } from "../src/review-workbench/review-presentation.js";
import {
  buildReviewDecision,
  buildReviewDecisionsFromSession,
  initialReviewWorkbenchState,
  renderReviewWorkbenchHtml,
  replayReviewSessionEventsForSnapshot,
} from "../src/review-workbench/review-workbench.js";

function candidate(value: unknown): CurrentProposedCandidateInput {
  return {
    value,
    source: { sourceRef: "https://example.test/fees", kind: "web-page", locatorScheme: "text" },
    locator: { scheme: "text", locator: "chars:0-19", excerpt: "Fee: 48000 per year" },
    extraction: { target: "annualFee", extractor: "example-extractor" },
    claimTarget: { subjectType: "vendor", subjectId: "acme", facet: "vendor.contract", claimType: "vendor.field", fieldOrBehavior: "annualFee", impactLevel: "medium" },
  };
}

const SUPPORTED = "Verifier records for the proposed value (what a verifier said, not a review decision): slow-check 1.0.0 (model) abstained: timeout; support-check 2.1.0 (model) said supported. 1 record was made for a different value or evidence and does not apply. 1 record failed validation and was ignored.";
const EDITED = "No verifier record applies to the edited value. 3 records were made for a different value or evidence and do not apply. 1 record failed validation and was ignored.";

function itemWithRecords(): ReviewItem {
  const item = currentProposedReviewItem({ name: "acme-annual-fee", target: "annualFee", current: candidate(45000), proposed: candidate(48000) });
  const proposed = item.spec.candidates.find((c) => c.role === "proposed")!;
  const input = (value: unknown): SupportVerificationInput => ({ candidateId: proposed.id, value, evidence: [{ id: "ev-1", excerpt: "Fee: 48000 per year", locator: "chars:0-19" }] });
  const createdAt = "2026-09-28T12:00:00.000Z";
  const supported = buildCandidateVerification({ input: input(48000), verifier: { id: "support-check", version: "2.1.0", method: "model" }, verdict: { result: "supported", score: 0.97 }, createdAt });
  const timedOut = buildCandidateVerification({ input: input(48000), verifier: { id: "slow-check", version: "1.0.0", method: "model" }, verdict: { result: "abstain", abstainReason: "timeout" }, createdAt });
  const stale = buildCandidateVerification({ input: input(47000), verifier: { id: "support-check", version: "2.1.0", method: "model" }, verdict: { result: "contradicted" }, createdAt });
  const forged = { ...JSON.parse(JSON.stringify(stale)), valueDigest: supported.valueDigest };
  proposed.verifications = JSON.parse(JSON.stringify([supported, timedOut, stale, forged]));
  return item;
}

function renderedPrompt(decision: ReturnType<typeof buildReviewDecision>): string {
  return (decision?.spec.authorizing as { renderedPrompt?: string } | undefined)?.renderedPrompt ?? "";
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

describe("verifier records on the decision surfaces", () => {
  it("the presentation validates records and reads them against the value under review", () => {
    const item = itemWithRecords();
    const [note] = candidateVerificationNotes(item);
    assert.equal(note?.status, "evaluated");
    assert.deepEqual(note?.records.map((r) => r.result).sort(), ["abstain", "supported"]);
    assert.equal(note?.inapplicableCount, 1);
    assert.equal(note?.rejectedCount, 1);
    assert.equal(note?.sentence, SUPPORTED);
    assert.ok(!note?.sentence.includes("0.97"), "an uncalibrated score is not shown to the reviewer");

    const [edited] = candidateVerificationNotes(item, 52000);
    assert.equal(edited?.status, "not-evaluated");
    assert.equal(edited?.sentence, EDITED);
  });

  it("the workbench card and the recorded decision prompt show the same note", () => {
    const item = itemWithRecords();
    const [note] = candidateVerificationNotes(item);
    const html = renderReviewWorkbenchHtml(initialReviewWorkbenchState(item));
    assert.match(html, /data-testid="support-verification"[^>]*data-status="evaluated"/);
    assert.ok(html.includes(note!.sentence), "the card shows the note");

    const accepted = renderedPrompt(buildReviewDecision({ ...initialReviewWorkbenchState(item), decision: "accept-proposed" }));
    assert.ok(accepted.includes(note!.sentence), "the recorded prompt says what the card said");

    const editedPrompt = renderedPrompt(buildReviewDecision({ ...initialReviewWorkbenchState(item), decision: "accept-proposed", editedValue: 52000 }));
    assert.ok(editedPrompt.includes(EDITED), "an edited value is not covered by records on the proposed value");
    assert.ok(!editedPrompt.includes("said supported"));

    const session = initialReviewQueueSessionState([item]);
    const editedCard = renderReviewWorkbenchHtml({ ...session, decisionsByItemName: { [item.metadata.name]: "accept-proposed" }, editedValuesByItemName: { [item.metadata.name]: 52000 } });
    assert.match(editedCard, /data-testid="support-verification"[^>]*data-status="not-evaluated"/);
    assert.ok(editedCard.includes(EDITED));
  });

  it("an item without records shows no verification on the card or in the prompt", () => {
    const item = itemWithRecords();
    delete item.spec.candidates.find((c) => c.role === "proposed")!.verifications;
    assert.deepEqual(candidateVerificationNotes(item), []);
    assert.ok(!renderReviewWorkbenchHtml(initialReviewWorkbenchState(item)).includes("support-verification"));
    assert.ok(!renderedPrompt(buildReviewDecision({ ...initialReviewWorkbenchState(item), decision: "accept-proposed" })).includes("erifier"));
  });

  it("the MCP item text, data and card, and the prompt it records, show the same note", async () => {
    const item = itemWithRecords();
    const [note] = candidateVerificationNotes(item);
    const itemName = item.metadata.name;
    const example = JSON.parse(await readFile("example-data/mcp-review-session.json", "utf8")) as Record<string, any>;
    example.session.spec.reviewItemNames = [itemName];
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-verification-"));
    const sessionPath = join(tmpDir, "session.json");
    await writeFile(sessionPath, JSON.stringify({ session: example.session, snapshot: initialReviewQueueSessionState([item]), events: [] }, null, 2));

    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], { stdio: ["pipe", "pipe", "inherit"] });
    const call = rpc(server);
    try {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const response = await call("tools/call", { name: "survey_review_item", arguments: { itemName } });
      assert.equal(response.result.isError, false);
      const text: string = response.result.content[0].text;
      assert.ok(text.includes(`Verification: ${note!.sentence}`), "the item text carries the note");
      const data = JSON.parse(text.slice(text.indexOf("\n{") + 1));
      const proposed = data.candidates.find((c: { role: string }) => c.role === "proposed");
      assert.equal(proposed.verification.status, "evaluated");
      assert.deepEqual(proposed.verification.records.map((r: { recordId: string }) => r.recordId), note!.records.map((r) => r.recordId));
      assert.equal(proposed.verification.rejectedCount, 1);
      assert.equal(data.candidates.find((c: { role: string }) => c.role === "current").verification, undefined, "no records, no verification claim");
      const card = response.result.content.find((entry: { type: string }) => entry.type === "resource")?.resource?.text ?? "";
      assert.ok(card.includes(note!.sentence), "the MCP card carries the note");

      const decide = await call("tools/call", { name: "survey_review_decide", arguments: { itemName, decision: "accept" } });
      assert.equal(decide.result.isError, false);
      const persisted = JSON.parse(await readFile(sessionPath, "utf8"));
      const [decision] = buildReviewDecisionsFromSession(replayReviewSessionEventsForSnapshot(persisted.snapshot, persisted.events));
      assert.ok(renderedPrompt(decision).includes(note!.sentence), "the recorded prompt says what the MCP item said");
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
