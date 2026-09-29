/**
 * Choosing one value of a conflicting candidate set (#304). A conflict item
 * (two distinct proposed values for one claim) can be decided by choosing one
 * candidate by id: `select-proposed`. Driven through the workbench session
 * path, the server session boundary and the real MCP server; each projects
 * exactly one verified claim with the CHOSEN value (the second one, so a
 * fallback to the first candidate fails), and every record says a rival was
 * seen and not chosen.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";
import {
  buildCanonicalReviewedTrustInput,
  buildSurveyLearningProjections,
  buildSurveyTrustBundle,
  importExtractionEnvelope,
  type PortableExtractionResultEnvelope,
  type ReviewDecision,
  type ReviewItem,
  type ReviewSessionEvent,
} from "../src/index.js";
import {
  buildReviewDecisionsFromSession,
  buildReviewResultPresentation,
  buildReviewSessionEvents,
  buildReviewWorkbenchResultsFromSession,
  candidateForDecision,
  deriveReviewSessionApplyResultForSnapshot,
  initialReviewQueueSessionState,
  renderReviewWorkbenchHtml,
  replayReviewSessionEvents,
  reviewSessionSummary,
  type ReviewQueueSessionState,
  type ReviewWorkbenchResult,
} from "../src/review-workbench/review-workbench.js";
import { createServerReviewSessionRecord, deriveServerReviewSessionApplyResult } from "../src/review-workbench/server-review-session.js";

const AT = "2026-09-28T00:00:00.000Z";
const NOTE = "The amendment supersedes the schedule.";

async function conflictRound() {
  const envelope = JSON.parse(await readFile("tests/fixtures/traverse-envelopes/success-conflicting-fee.v1.json", "utf8")) as PortableExtractionResultEnvelope;
  envelope.result.proposals[1]!.fieldPath = "annualFee";
  const imported = importExtractionEnvelope(envelope, {
    importName: "vendor-import", producerNamespace: "fixture-producer", sourceKind: "uploaded-document",
    claimTarget: (proposal) => ({ subjectType: "vendor", subjectId: "vendor-1", facet: "vendor.contract", claimType: "vendor.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "medium" }),
  });
  const items = imported.reviewItems;
  const conflict = items.find((item) => item.spec.candidateSetStatus === "conflict")!;
  const sibling = items.find((item) => item.spec.target === "annualFee")!;
  assert.deepEqual(conflict.spec.candidates.map((candidate) => candidate.value), [48000, 52000]);
  const [first, second] = conflict.spec.candidates;
  return { imported, items, conflict, sibling, first: first!, second: second! };
}

function baseSnapshot(items: readonly ReviewItem[]): ReviewQueueSessionState {
  return { ...initialReviewQueueSessionState(items), actorId: "reviewer-1", reviewedAt: AT };
}

/** The session a reviewer produces by choosing `candidateId` on the conflict and accepting the sibling. */
function chosenSession(items: readonly ReviewItem[], conflict: ReviewItem, sibling: ReviewItem, candidateId: string): ReviewQueueSessionState {
  return {
    ...baseSnapshot(items),
    decisionsByItemName: { [conflict.metadata.name]: "select-proposed", [sibling.metadata.name]: "accept-proposed" },
    selectedCandidateIdsByItemName: { [conflict.metadata.name]: candidateId },
    notesByItemName: { [conflict.metadata.name]: NOTE },
  };
}

function project(items: readonly ReviewItem[], results: readonly ReviewWorkbenchResult[]) {
  const canonical = buildCanonicalReviewedTrustInput({ source: "fixture-producer", generatedAt: AT, projectionContextId: "round-1", items, results });
  return { surveyInput: canonical.surveyInput, bundle: buildSurveyTrustBundle(canonical.surveyInput, { projectionContextId: canonical.projectionContextId }) };
}

function renderedPrompt(decision: ReviewDecision | undefined): string {
  return (decision?.spec.authorizing as { renderedPrompt?: string } | undefined)?.renderedPrompt ?? "";
}

/**
 * The chosen value projects as the one verified claim for the slot, and every
 * record keeps the rival: the decision names it as not chosen, the recorded
 * prompt lists both values and which was chosen, the candidate set keeps it
 * with a not-chosen reason, and the Surface claim lists both values.
 */
function assertChoseSecond(input: {
  items: readonly ReviewItem[];
  conflict: ReviewItem;
  first: ReviewItem["spec"]["candidates"][number];
  second: ReviewItem["spec"]["candidates"][number];
  results: readonly ReviewWorkbenchResult[];
  decisions: readonly ReviewDecision[];
  events: readonly ReviewSessionEvent[];
}): void {
  const { conflict, first, second } = input;
  const result = input.results.find((entry) => entry.reviewItemName === conflict.metadata.name)!;
  assert.equal(result.decision, "select-proposed");
  assert.equal(result.selectedCandidateId, second.id);
  assert.equal(result.effectiveValue, 52000);
  assert.deepEqual(result.unselectedCandidates.map((candidate) => candidate.id), [first.id]);

  const decision = input.decisions.find((entry) => entry.spec.reviewItemName === conflict.metadata.name)!;
  assert.equal(decision.metadata.name, `${conflict.metadata.name}-select-proposed`);
  assert.equal(decision.spec.candidateId, second.id);
  assert.deepEqual(decision.spec.unselectedCandidateIds, [first.id]);
  assert.equal(decision.spec.status, "verified");
  assert.equal(renderedPrompt(decision), "For Fee, 2 different values were proposed: 48000, 52000. Selected decision: Use this value: 52000 (not chosen: 48000).");

  const decisionEvents = input.events.filter((event) => event.spec.reviewItemName === conflict.metadata.name && event.spec.eventType.startsWith("decision-"));
  assert.ok(decisionEvents.length > 0);
  for (const event of decisionEvents) {
    assert.equal(event.spec.candidateId, second.id, "the event's candidateId is the choice");
    assert.equal(event.spec.data?.workbenchDecision, "select-proposed");
  }

  const { surveyInput, bundle } = project(input.items, input.results);
  const feeClaims = bundle.claims.filter((claim) => claim.fieldOrBehavior === "fee");
  assert.deepEqual(feeClaims.map((claim) => [claim.value, claim.status]), [[52000, "verified"]]);
  const survey = feeClaims[0]!.metadata?.survey as Record<string, unknown>;
  assert.equal(survey.candidateId, second.id);
  assert.deepEqual(survey.candidates, [
    { candidateId: first.id, value: 48000, rejectionReason: `Not chosen: the reviewer chose candidate ${second.id} for this claim.` },
    { candidateId: second.id, value: 52000, selected: true },
  ]);

  const set = surveyInput.candidateSets.find((entry) => entry.candidates.some((candidate) => candidate.id === second.id))!;
  assert.equal(set.selectedCandidateId, second.id);
  assert.equal(set.status, "resolved");
  const outcome = surveyInput.reviewOutcomes.find((review) => review.candidateSetId === set.id)!;
  assert.equal(outcome.candidateId, second.id);
  assert.deepEqual(outcome.metadata, { workbenchDecision: "select-proposed", unselectedCandidateIds: [first.id] });
  const learning = buildSurveyLearningProjections(surveyInput).filter((entry) => entry.kind === "learning.rejected-candidate");
  assert.ok(learning.some((entry) => entry.id.includes(first.id)), "the value not chosen is a rejected-candidate signal");
  assert.ok(!learning.some((entry) => entry.id.includes(second.id)));
}

describe("choosing one value of a conflict (#304)", () => {
  it("the workbench session records the choice by id and projects the chosen value verified", async () => {
    const { items, conflict, sibling, first, second } = await conflictRound();
    const session = chosenSession(items, conflict, sibling, second.id);
    assert.equal(reviewSessionSummary(session).unresolved, 0);
    const events = buildReviewSessionEvents(session, "round-1");
    assertChoseSecond({ items, conflict, first, second, results: buildReviewWorkbenchResultsFromSession(session), decisions: buildReviewDecisionsFromSession(session), events });

    // Replaying the stored events restores the choice.
    const replayed = replayReviewSessionEvents(baseSnapshot(items), events);
    assert.equal(replayed.decisionsByItemName[conflict.metadata.name], "select-proposed");
    assert.equal(replayed.selectedCandidateIdsByItemName?.[conflict.metadata.name], second.id);

    const presentation = buildReviewResultPresentation(buildReviewWorkbenchResultsFromSession(session).find((result) => result.reviewItemName === conflict.metadata.name)!, conflict);
    assert.equal(presentation.selectedValueText, "52000");
    assert.equal(presentation.applyMeaning, "Saved decision applies the chosen value; the other proposed values were seen and not chosen");
    assert.deepEqual(presentation.traceRefs.filter((ref) => ref.label === "Not chosen candidate").map((ref) => ref.value), [first.id]);
  });

  it("the workbench card offers a choice per value, then marks every value chosen or not chosen", async () => {
    const { items, conflict, sibling, first, second } = await conflictRound();
    const undecided = renderReviewWorkbenchHtml(baseSnapshot(items));
    const buttons = [...undecided.matchAll(/data-testid="select-value" data-item-name="([^"]+)" data-candidate-id="([^"]+)"/g)].map((match) => [match[1], match[2]]);
    assert.deepEqual(buttons, [[conflict.metadata.name, first.id], [conflict.metadata.name, second.id]]);

    const decided = renderReviewWorkbenchHtml(chosenSession(items, conflict, sibling, second.id));
    const card = decided.slice(decided.indexOf(`data-item-name="${conflict.metadata.name}"`));
    assert.match(card, /data-decision="select-proposed"/);
    assert.match(card, /data-testid="decided-chip">Chose 1 of 2 values</);
    assert.match(card, new RegExp(`data-candidate-id="${first.id}" data-chosen="false"[\\s\\S]*?48000[\\s\\S]*?>Not chosen<`));
    assert.match(card, new RegExp(`data-candidate-id="${second.id}" data-chosen="true"[\\s\\S]*?52000[\\s\\S]*?>Chosen<`));
    assert.doesNotMatch(card.slice(0, card.indexOf("audit-details")), /data-testid="select-value"/, "a decided card offers no further choice");
  });

  it("the server session boundary applies the choice from snapshot + events", async () => {
    const { items, conflict, sibling, first, second } = await conflictRound();
    const snapshot = baseSnapshot(items);
    const events = buildReviewSessionEvents(chosenSession(items, conflict, sibling, second.id), "round-1");
    const record = createServerReviewSessionRecord({ sessionName: "round-1", snapshot, eventCount: events.length, updatedAt: AT });
    const applied = deriveServerReviewSessionApplyResult({ record, events, requiredResolvedItems: "all" });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    assertChoseSecond({ items, conflict, first, second, results: applied.results, decisions: applied.decisions, events });
  });

  it("refuses a choice that names no candidate, an unknown one, or one that is not proposed, on every path", async () => {
    const { items, conflict, sibling, second } = await conflictRound();
    const snapshot = baseSnapshot(items);
    const events = buildReviewSessionEvents(chosenSession(items, conflict, sibling, second.id), "round-1");
    const withCandidate = (candidateId: string | undefined) => events.map((event) => event.spec.reviewItemName === conflict.metadata.name && event.spec.eventType.startsWith("decision-")
      ? { ...event, spec: { ...event.spec, candidateId } }
      : event);
    for (const candidateId of [undefined, "no-such-candidate"]) {
      const applied = deriveReviewSessionApplyResultForSnapshot({ snapshot, events: withCandidate(candidateId) });
      assert.equal(applied.ok, false, String(candidateId));
      assert.ok(applied.issues.some((issue) => issue.code === "invalid-conflict-selection"), JSON.stringify(applied.issues));
    }

    // A current candidate beside two proposed ones cannot be "chosen" as a proposed value.
    const withCurrent: ReviewItem = { ...conflict, spec: { ...conflict.spec, candidates: [{ ...conflict.spec.candidates[0]!, id: "prior", role: "current" }, ...conflict.spec.candidates] } };
    const currentItems = items.map((item) => (item === conflict ? withCurrent : item));
    const currentEvents = buildReviewSessionEvents(chosenSession(currentItems, withCurrent, sibling, second.id), "round-1")
      .map((event) => event.spec.reviewItemName === conflict.metadata.name && event.spec.candidateId ? { ...event, spec: { ...event.spec, candidateId: "prior" } } : event);
    const refusedCurrent = deriveReviewSessionApplyResultForSnapshot({ snapshot: baseSnapshot(currentItems), events: currentEvents });
    assert.ok(refusedCurrent.issues.some((issue) => issue.code === "invalid-conflict-selection" && /has role current/.test(issue.message)), JSON.stringify(refusedCurrent.issues));
    assert.throws(() => candidateForDecision(withCurrent, "select-proposed", "prior"), /has role current/);

    // An item with one proposed value has no rival to choose over.
    assert.throws(() => candidateForDecision(sibling, "select-proposed", sibling.spec.candidates[0]!.id), /needs at least two/);
    assert.throws(() => buildReviewSessionEvents({ ...baseSnapshot(items), decisionsByItemName: { [sibling.metadata.name]: "select-proposed" }, selectedCandidateIdsByItemName: { [sibling.metadata.name]: sibling.spec.candidates[0]!.id } }), /needs at least two/);

    // Role-only accept on the conflict stays refused.
    assert.throws(() => candidateForDecision(conflict, "accept-proposed"), /cannot choose between them/);
    assert.throws(() => buildReviewSessionEvents({ ...baseSnapshot(items), decisionsByItemName: { [conflict.metadata.name]: "accept-proposed" } }), /cannot choose between them/);
  });

  it("stored sessions and events from before the choice existed replay with the same meaning", async () => {
    const stored = JSON.parse(await readFile("example-data/mcp-review-session.json", "utf8")) as { snapshot: ReviewQueueSessionState; events: ReviewSessionEvent[] };
    assert.equal(Object.hasOwn(stored.snapshot, "selectedCandidateIdsByItemName"), false);
    const itemName = stored.snapshot.items[0]!.metadata.name;
    const events = buildReviewSessionEvents({ ...stored.snapshot, decisionsByItemName: { [itemName]: "accept-proposed" } });
    const applied = deriveReviewSessionApplyResultForSnapshot({ snapshot: stored.snapshot, events });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    assert.equal(applied.results[0]!.decision, "accept-proposed");
    assert.equal(Object.hasOwn(applied.decisions[0]!.spec, "unselectedCandidateIds"), false);
  });

  it("the real MCP server lists each value's candidate id, records a choice, and refuses a bad one", async () => {
    const { items, conflict, sibling, first, second } = await conflictRound();
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-conflict-select-mcp-"));
    const sessionPath = join(tmpDir, "session.json");
    const snapshot = baseSnapshot(items);
    await writeFile(sessionPath, JSON.stringify({
      session: { apiVersion: "survey.kontourai.io/v1alpha1", kind: "ReviewSession", metadata: { name: "mcp-review-session" },
        spec: { reviewItemNames: items.map((item) => item.metadata.name), actor: { id: "reviewer-1" }, startedAt: AT },
        status: { activeItemName: conflict.metadata.name, eventCount: 0, decisionCount: 0 } },
      snapshot, events: [],
    }));
    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], { stdio: ["pipe", "pipe", "inherit"] });
    const call = rpc(server);
    try {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const tools = await call("tools/list", {});
      const decide = (tools.result.tools as Array<Record<string, any>>).find((tool) => tool.name === "survey_review_decide")!;
      const selectBranch = (decide.inputSchema.oneOf as Array<Record<string, any>>).find((branch) => branch.properties.decision.const === "select")!;
      assert.deepEqual(selectBranch.required, ["itemName", "decision", "candidateId"]);

      const detail = await call("tools/call", { name: "survey_review_item", arguments: { itemName: conflict.metadata.name } });
      const text = textOf(detail);
      assert.match(text, /choose one with decision "select" and its candidateId/);
      assert.match(text, new RegExp(`Proposed value: 48000\\n[\\s\\S]*?candidateId: ${first.id}[\\s\\S]*Proposed value: 52000\\n[\\s\\S]*?candidateId: ${second.id}`));
      const card = cardOf(detail);
      assert.deepEqual([...card.matchAll(/class="btn btn-accept btn-select" data-candidate-id="([^"]+)"/g)].map((match) => match[1]), [first.id, second.id]);

      // Refused: an id that is not on the item, a non-conflict item, and the role-only accept.
      for (const [args, pattern] of [
        [{ itemName: conflict.metadata.name, decision: "select", candidateId: "no-such-candidate" }, /has no candidate no-such-candidate/],
        [{ itemName: sibling.metadata.name, decision: "select", candidateId: sibling.spec.candidates[0]!.id }, /needs at least two/],
        [{ itemName: conflict.metadata.name, decision: "accept" }, /cannot choose between them/],
      ] as const) {
        const refused = await call("tools/call", { name: "survey_review_decide", arguments: args });
        assert.equal(refused.result.isError, true, JSON.stringify(args));
        assert.match(textOf(refused), pattern);
      }
      assert.deepEqual(JSON.parse(await readFile(sessionPath, "utf8")).events, [], "a refused decision writes nothing");

      const chosen = await call("tools/call", { name: "survey_review_decide", arguments: { itemName: conflict.metadata.name, decision: "select", candidateId: second.id, note: NOTE } });
      assert.equal(chosen.result.isError, false, textOf(chosen));
      assert.match(textOf(chosen), /^Decision recorded: Use this value\nEffect: 52000 becomes the verified value; not chosen: 48000\./);
      assert.match(textOf(chosen), new RegExp(`Chosen value: 52000 \\(candidate ${second.id}\\); not chosen: 48000 \\(candidate ${first.id}\\)`));
      await call("tools/call", { name: "survey_review_decide", arguments: { itemName: sibling.metadata.name, decision: "accept" } });

      const after = await call("tools/call", { name: "survey_review_item", arguments: { itemName: conflict.metadata.name } });
      const afterCard = cardOf(after);
      assert.match(afterCard, /Chose 1 of 2 values/);
      assert.match(afterCard, new RegExp(`class="choice not-chosen" data-candidate-id="${first.id}">Not chosen<`));
      assert.match(afterCard, new RegExp(`class="choice chosen" data-candidate-id="${second.id}">Chosen<`));
      assert.match(textOf(after), /"selectedCandidateId": /);

      const persisted = JSON.parse(await readFile(sessionPath, "utf8")) as { snapshot: ReviewQueueSessionState; events: ReviewSessionEvent[] };
      const record = createServerReviewSessionRecord({ sessionName: persisted.events[0]!.spec.sessionName, snapshot: persisted.snapshot, updatedAt: AT });
      const applied = deriveServerReviewSessionApplyResult({ record, events: persisted.events, requiredResolvedItems: "all" });
      assert.equal(applied.ok, true, JSON.stringify(applied.issues));
      assertChoseSecond({ items, conflict, first, second, results: applied.results, decisions: applied.decisions, events: persisted.events });
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

function textOf(response: { result: Record<string, any> }): string {
  return (response.result.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text")?.text ?? "";
}

function cardOf(response: { result: Record<string, any> }): string {
  return (response.result.content as Array<{ type: string; resource?: { text?: string } }>).find((entry) => entry.type === "resource")?.resource?.text ?? "";
}

function rpc(server: ReturnType<typeof spawn>) {
  const pending = new Map<number, (message: { result: Record<string, any> }) => void>();
  createInterface({ input: server.stdout! }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as { id?: number; result: Record<string, any> };
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let id = 0;
  return (method: string, params: unknown) => new Promise<{ result: Record<string, any> }>((resolve, reject) => {
    id += 1;
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 15_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
