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
import { buildReviewDecisionsFromSession, replayReviewSessionEventsForSnapshot } from "../src/review-workbench/review-workbench.js";
import { buildReviewItemPresentation } from "../src/review-workbench/review-presentation.js";

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
    assert.equal(junk.excerptVerification, "verified");
    // No binding: a bare metadata object cannot vouch for anything.
    const forged = buildReviewItemPresentation(edit((meta, copy) => {
      copy.metadata.producer["survey.kontourai.io/extraction-envelope"] = { excerptVerification: "verified", excludedProposals: meta.excludedProposals };
    }));
    assert.equal(forged.excerptVerification, undefined);
    assert.deepEqual(forged.excludedProposals, []);
    // Candidates bound to another import do not count as a binding either.
    const crossBound = buildReviewItemPresentation(edit((_meta, copy) => {
      copy.spec.candidates[0].producer["survey.kontourai.io/extraction-envelope"].importName = "other-import";
    }));
    assert.equal(crossBound.excerptVerification, undefined);
  });
});
