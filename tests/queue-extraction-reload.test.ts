/**
 * The built-in reload paths check a stored queue against the extraction import
 * stored beside it (#317). Deleting an excluded rival entry from a stored item
 * leaves nothing for the card to flag, so only the import can reveal it: a
 * queue that diverges from its import is refused on every path, and a queue
 * whose items came from an import but has no import stored is shown as
 * unverified instead of being trusted silently.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";
import { startReviewConsoleServer } from "../src/console/review-console-server.js";
import { importExtractionEnvelope, type ExtractionEnvelopeImportResult, type PortableExtractionResultEnvelope } from "../src/extraction-envelope.js";
import type { ReviewItem } from "../src/review-resource.js";
import {
  attestReviewQueueExtraction,
  buildReviewSessionEvents,
  initialReviewQueueSessionState,
  renderReviewWorkbenchHtml,
  UnattestedExtractionQueueError,
  type ReviewQueueSessionState,
} from "../src/review-workbench/review-workbench.js";
import { applyReviewSession, createServerReviewSessionRecord, deriveServerReviewSessionApplyResult } from "../src/review-workbench/server-review-session.js";

const ENVELOPE_PRODUCER = "survey.kontourai.io/extraction-envelope";
const TEXT = "Fee: 48000 per year. Summary Fee: 48000. Amended Fee: 52000.";

/** A verified import whose one item lists an excluded rival value (52001). */
async function importWithExcludedRival(): Promise<ExtractionEnvelopeImportResult> {
  const envelope = JSON.parse(await readFile("tests/fixtures/traverse-envelopes/success-conflicting-fee.v1.json", "utf8")) as PortableExtractionResultEnvelope;
  const rival = envelope.result.proposals[2]!;
  rival.candidateValue = 52001; rival.provenance.excerpt = "52001";
  const imported = importExtractionEnvelope(envelope, {
    sourceKind: "uploaded-document",
    claimTarget: (proposal) => ({ subjectType: "vendor", subjectId: "acme", facet: "vendor.contract", claimType: "vendor.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "medium" }),
    artifact: { status: "available", text: TEXT, actualDigest: createHash("sha256").update(TEXT).digest("hex") },
  });
  assert.equal(imported.reviewItems.length, 1);
  assert.equal((imported.reviewItems[0]!.metadata.producer![ENVELOPE_PRODUCER] as { excludedProposals: unknown[] }).excludedProposals.length, 1);
  return imported;
}

/** The same item with its excluded rival entry deleted outright: nothing on the item says anything was removed. */
function withRivalDeleted(item: ReviewItem): ReviewItem {
  const copy = JSON.parse(JSON.stringify(item)) as ReviewItem;
  delete (copy.metadata.producer![ENVELOPE_PRODUCER] as Record<string, unknown>).excludedProposals;
  return copy;
}

function snapshotOf(items: readonly ReviewItem[]): ReviewQueueSessionState {
  return { ...initialReviewQueueSessionState(items), actorId: "reviewer-1", reviewedAt: "2026-09-28T00:00:00.000Z" };
}

function sessionFile(items: readonly ReviewItem[], extractionImport?: unknown): string {
  return JSON.stringify({
    session: { apiVersion: "survey.kontourai.io/v1alpha1", kind: "ReviewSession", metadata: { name: "mcp-review-session" },
      spec: { reviewItemNames: items.map((item) => item.metadata.name), actor: { id: "reviewer-1" }, startedAt: "2026-09-28T00:00:00.000Z" } },
    snapshot: snapshotOf(items),
    events: [],
    ...(extractionImport !== undefined ? { extractionImport } : {}),
  });
}

describe("reload paths check a stored queue against its extraction import (#317)", () => {
  it("attests, refuses, or marks unverified", async () => {
    const imported = await importWithExcludedRival();
    const [item] = imported.reviewItems;
    assert.deepEqual(attestReviewQueueExtraction(imported.reviewItems, imported.record), { state: "attested" });
    assert.deepEqual(attestReviewQueueExtraction(imported.reviewItems, imported), { state: "attested" });
    const diverges = attestReviewQueueExtraction([withRivalDeleted(item!)], imported.record);
    assert.equal(diverges.state, "diverges");
    assert.deepEqual(diverges.state === "diverges" && diverges.issues.map((issue) => issue.code), ["item-diverges-from-extraction"]);
    const unverified = attestReviewQueueExtraction([withRivalDeleted(item!)], undefined);
    assert.equal(unverified.state, "unverified");
    assert.match(unverified.state === "unverified" ? unverified.message : "", /^Unverified queue: 1 item came from an extraction import, but no import record was stored/);
    const invalid = attestReviewQueueExtraction(imported.reviewItems, { ...imported.record, kind: "Nope" } as unknown as typeof imported.record);
    assert.deepEqual(invalid.state === "diverges" && invalid.issues.map((issue) => issue.code), ["import-invalid"]);
    // A queue that never came from an extraction has nothing to check.
    const plain = JSON.parse(await readFile("example-data/mcp-review-session.json", "utf8")) as { snapshot: ReviewQueueSessionState };
    assert.deepEqual(attestReviewQueueExtraction(plain.snapshot.items, undefined), { state: "not-extraction" });
  });

  it("the workbench refuses a diverging queue and marks an unchecked one unverified", async () => {
    const imported = await importWithExcludedRival();
    const tampered = [withRivalDeleted(imported.reviewItems[0]!)];
    const refused = renderReviewWorkbenchHtml(snapshotOf(tampered), undefined, { extractionImport: imported.record });
    assert.match(refused, /data-queue-attestation="diverges"/);
    assert.match(refused, /data-testid="queue-attestation" data-state="diverges" role="alert">[\s\S]*does not match the extraction import stored with it/);
    assert.doesNotMatch(refused, /data-testid="review-field"/, "a diverging queue shows no cards to decide");

    const unchecked = renderReviewWorkbenchHtml(snapshotOf(tampered));
    assert.match(unchecked, /data-testid="queue-attestation" data-state="unverified" role="note">[\s\S]*Unverified queue: 1 item came from an extraction import/);
    assert.match(unchecked, /data-testid="review-field"/);

    const attested = renderReviewWorkbenchHtml(snapshotOf(imported.reviewItems), undefined, { extractionImport: imported });
    assert.match(attested, /data-queue-attestation="attested"/);
    assert.doesNotMatch(attested, /data-testid="queue-attestation"/);
  });

  it("the server session boundary refuses a diverging queue and warns on an unchecked one", async () => {
    const imported = await importWithExcludedRival();
    const tampered = [withRivalDeleted(imported.reviewItems[0]!)];
    const snapshot = snapshotOf(tampered);
    const events = buildReviewSessionEvents({ ...snapshot, decisionsByItemName: { [tampered[0]!.metadata.name]: "accept-proposed" } }, "round-1");
    const record = createServerReviewSessionRecord({ sessionName: "round-1", snapshot, updatedAt: "2026-09-28T00:00:00.000Z" });
    assert.throws(() => deriveServerReviewSessionApplyResult({ record, events, extractionImport: imported.record }), (error: unknown) =>
      error instanceof UnattestedExtractionQueueError && error.issues.some((issue) => issue.code === "item-diverges-from-extraction"));
    const applied = applyReviewSession({ record, events, extractionImport: imported });
    assert.equal(applied.ok, false);
    assert.deepEqual(!applied.ok && applied.issues.map((issue) => issue.code), ["unattested-extraction-queue"]);

    const unchecked = deriveServerReviewSessionApplyResult({ record, events });
    assert.equal(unchecked.ok, true);
    assert.deepEqual(unchecked.warnings?.filter((warning) => warning.code === "unverified-extraction-queue").map((warning) => warning.code), ["unverified-extraction-queue"]);

    const intactSnapshot = snapshotOf(imported.reviewItems);
    const intactRecord = createServerReviewSessionRecord({ sessionName: "round-1", snapshot: intactSnapshot, updatedAt: "2026-09-28T00:00:00.000Z" });
    const attested = deriveServerReviewSessionApplyResult({ record: intactRecord, events, extractionImport: imported.record });
    assert.equal(attested.ok, true, JSON.stringify(attested.issues));
    assert.deepEqual(attested.warnings, []);
  });

  it("the real MCP server refuses a diverging stored queue and marks an unchecked one unverified", async () => {
    const imported = await importWithExcludedRival();
    const tampered = [withRivalDeleted(imported.reviewItems[0]!)];
    const itemName = tampered[0]!.metadata.name;
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-reload-"));
    try {
      // Diverging: every tool refuses, and nothing is written.
      const divergingPath = join(tmpDir, "diverging.json");
      await writeFile(divergingPath, sessionFile(tampered, imported.record));
      await withMcp(divergingPath, async (call) => {
        for (const [name, args] of [["survey_review_queue", {}], ["survey_review_item", { itemName }], ["survey_review_decide", { itemName, decision: "accept" }]] as const) {
          const response = await call("tools/call", { name, arguments: args });
          assert.equal(response.result.isError, true, name);
          assert.match(textOf(response), /does not match the extraction import stored with it[\s\S]*ReviewItem .* does not match the extraction it was imported from/, name);
        }
      });
      assert.deepEqual(JSON.parse(await readFile(divergingPath, "utf8")).events, []);

      // No import stored: served, with the notice on the text, the data and the card.
      const uncheckedPath = join(tmpDir, "unchecked.json");
      await writeFile(uncheckedPath, sessionFile(tampered));
      await withMcp(uncheckedPath, async (call) => {
        const queue = await call("tools/call", { name: "survey_review_queue", arguments: {} });
        assert.match(textOf(queue), /^Unverified queue: 1 item came from an extraction import/);
        assert.match(textOf(queue), /"queueAttestation": "unverified"/);
        const item = await call("tools/call", { name: "survey_review_item", arguments: { itemName } });
        assert.match(textOf(item), /^Unverified queue: /);
        assert.match(cardOf(item), /id="unverified-queue-note">Unverified queue: /);
        const decided = await call("tools/call", { name: "survey_review_decide", arguments: { itemName, decision: "accept" } });
        assert.equal(decided.result.isError, false, textOf(decided));
        assert.match(textOf(decided), /Unverified queue: /);
      });

      // The import stored beside an intact queue: attested, no notice, and the decision keeps the import.
      const intactPath = join(tmpDir, "intact.json");
      await writeFile(intactPath, sessionFile(imported.reviewItems, imported.record));
      await withMcp(intactPath, async (call) => {
        const item = await call("tools/call", { name: "survey_review_item", arguments: { itemName } });
        assert.equal(item.result.isError, false, textOf(item));
        assert.doesNotMatch(textOf(item), /Unverified queue/);
        assert.match(textOf(item), /"queueAttestation": "attested"/);
        assert.match(textOf(item), /52001/);
        const decided = await call("tools/call", { name: "survey_review_decide", arguments: { itemName, decision: "accept" } });
        assert.equal(decided.result.isError, false, textOf(decided));
      });
      assert.deepEqual(JSON.parse(await readFile(intactPath, "utf8")).extractionImport, imported.record, "a decision keeps the stored import");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("the review console refuses to serve or append to a diverging queue and serves an unchecked one as unverified", async () => {
    const imported = await importWithExcludedRival();
    const tampered = [withRivalDeleted(imported.reviewItems[0]!)];
    const itemName = tampered[0]!.metadata.name;
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-console-reload-"));
    try {
      const divergingPath = join(tmpDir, "diverging.json");
      await writeFile(divergingPath, sessionFile(tampered, imported.record));
      const diverging = await startReviewConsoleServer({ sessionPath: divergingPath, port: 0 });
      try {
        const read = await fetch(`${diverging.url}api/session`);
        assert.equal(read.status, 409);
        const body = await read.json() as { error: string; queueAttestation: string };
        assert.equal(body.queueAttestation, "diverges");
        assert.match(body.error, /does not match the extraction import stored with it/);
        const events = buildReviewSessionEvents({ ...snapshotOf(tampered), decisionsByItemName: { [itemName]: "accept-proposed" } }, "mcp-review-session");
        const write = await fetch(`${diverging.url}api/events`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: diverging.url.replace(/\/$/, "") },
          body: JSON.stringify({ events, baseRevision: createHash("sha256").update("[]").digest("hex").slice(0, 32) }),
        });
        assert.equal(write.status, 422);
        assert.match((await write.json() as { error: string }).error, /not attested by its extraction import: ReviewItem .* does not match the extraction it was imported from/);
      } finally {
        await diverging.close();
      }
      assert.deepEqual(JSON.parse(await readFile(divergingPath, "utf8")).events, []);

      const uncheckedPath = join(tmpDir, "unchecked.json");
      await writeFile(uncheckedPath, sessionFile(tampered));
      const unchecked = await startReviewConsoleServer({ sessionPath: uncheckedPath, port: 0 });
      try {
        const read = await fetch(`${unchecked.url}api/session`);
        assert.equal(read.status, 200);
        const body = await read.json() as { queueAttestation: string; extractionImport?: unknown };
        assert.equal(body.queueAttestation, "unverified");
        assert.equal(body.extractionImport, undefined);
      } finally {
        await unchecked.close();
      }

      const intactPath = join(tmpDir, "intact.json");
      await writeFile(intactPath, sessionFile(imported.reviewItems, imported.record));
      const intact = await startReviewConsoleServer({ sessionPath: intactPath, port: 0 });
      try {
        const body = await (await fetch(`${intact.url}api/session`)).json() as { queueAttestation: string; extractionImport?: unknown };
        assert.equal(body.queueAttestation, "attested");
        assert.deepEqual(body.extractionImport, imported.record, "the page mounts the workbench with the stored import");
      } finally {
        await intact.close();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

type Call = (method: string, params: unknown) => Promise<{ result: Record<string, any> }>;

async function withMcp(sessionPath: string, body: (call: Call) => Promise<void>): Promise<void> {
  const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, (message: { result: Record<string, any> }) => void>();
  createInterface({ input: server.stdout! }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as { id?: number; result: Record<string, any> };
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let id = 0;
  const call: Call = (method, params) => new Promise((resolve, reject) => {
    id += 1;
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 15_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await body(call);
  } finally {
    server.stdin!.end();
    await once(server, "exit");
  }
}

function textOf(response: { result: Record<string, any> }): string {
  return (response.result.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text")?.text ?? "";
}

function cardOf(response: { result: Record<string, any> }): string {
  return (response.result.content as Array<{ type: string; resource?: { text?: string } }>).find((entry) => entry.type === "resource")?.resource?.text ?? "";
}
