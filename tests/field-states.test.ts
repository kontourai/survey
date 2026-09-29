/**
 * Per-field content and lifecycle states (#294). Each shipped state comes from
 * a minimal fixture built through the real importer, a field with no candidate
 * in a partial run is `not_covered` (never `not_found`), and a state whose
 * producer is absent never appears.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCandidateVerification, type CandidateVerification } from "../src/candidate-verification.js";
import {
  buildCanonicalReviewedTrustInput,
  buildDecisionSupersession,
  buildSurveyTrustBundle,
  deriveFieldStates,
  FIELD_STATE_METADATA_KEY,
  type FieldState,
} from "../src/index.js";
import type { ReviewItem } from "../src/review-resource.js";
import { initialReviewQueueSessionState, type ReviewWorkbenchDecision } from "../src/review-workbench/review-queue-session.js";
import {
  applyReviewSession,
} from "../src/review-workbench/server-review-session.js";
import {
  buildReviewDecision,
  buildReviewSessionEvents,
  currentReviewWorkbenchState,
  renderReviewWorkbenchHtml,
} from "../src/review-workbench/review-workbench.js";
import { importFields, slot } from "./field-state-fixture.js";

const SHIPPED_CONTENT = new Set(["value", "conflicting", "unsupported", "not_covered"]);
const SHIPPED_LIFECYCLE = new Set(["pending", "accepted", "rejected", "could_not_confirm", "superseded"]);

function byField(states: readonly FieldState[], field: string): FieldState {
  const matches = states.filter((state) => state.slot.fieldOrBehavior === field);
  assert.equal(matches.length, 1, `exactly one state for ${field}`);
  return matches[0]!;
}

function decide(item: ReviewItem, decision: ReviewWorkbenchDecision, note = "") {
  return buildReviewDecision({ ...currentReviewWorkbenchState(initialReviewQueueSessionState([item])), decision, note })!;
}

function verification(item: ReviewItem, result: "supported" | "contradicted" | "not-addressed" | "abstain", candidateIndex = 0): CandidateVerification {
  const candidate = item.spec.candidates[candidateIndex]!;
  return JSON.parse(JSON.stringify(buildCandidateVerification({
    input: { candidateId: candidate.id, value: candidate.value, evidence: [{ id: "ev", excerpt: candidate.locator!.excerpt!, locator: candidate.locator!.locator! }] },
    verifier: { id: "support-check", version: "1.0.0", method: "model" },
    verdict: result === "abstain" ? { result, abstainReason: "timeout" } : { result },
    createdAt: "2026-09-28T11:00:00.000Z",
  })));
}

function assertOnlyShippedStates(states: readonly FieldState[]): void {
  for (const state of states) {
    if (state.content !== undefined) assert.ok(SHIPPED_CONTENT.has(state.content), `content ${state.content} has no producer`);
    if (state.lifecycle !== undefined) assert.ok(SHIPPED_LIFECYCLE.has(state.lifecycle), `lifecycle ${state.lifecycle} has no producer`);
    assert.notEqual(state.content as string, "not_found");
    assert.notEqual(state.lifecycle as string, "stale");
  }
}

describe("field content states", () => {
  it("value: one candidate with evidence", () => {
    const imported = importFields([{ field: "annualFee", value: 48000, excerpt: "48000" }]);
    const [state] = deriveFieldStates({ imports: [{ record: imported.record }] });
    assert.equal(state!.content, "value");
    assert.equal(state!.lifecycle, "pending");
    assert.equal(state!.reviewItemName, imported.reviewItems[0]!.metadata.name);
    assert.deepEqual(state!.signals, {});
    assert.deepEqual(state!.slot, slot("annualFee"));
  });

  it("conflicting: two distinct values for one field", () => {
    const imported = importFields([
      { field: "annualFee", value: 48000, excerpt: "48000" },
      { field: "annualFee", value: 52000, excerpt: "52000" },
    ]);
    const states = deriveFieldStates({ imports: [{ record: imported.record }] });
    assert.equal(states.length, 1);
    assert.equal(states[0]!.content, "conflicting");
    // The same value twice is one candidate, not a conflict.
    const repeated = importFields([
      { field: "annualFee", value: 48000, excerpt: "48000" },
      { field: "annualFee", value: 48000, excerpt: "48000." },
    ]);
    assert.equal(deriveFieldStates({ imports: [{ record: repeated.record }] })[0]!.content, "value");
  });

  it("not_covered: a field with no candidate in a typed partial run; never not_found", () => {
    const partial = importFields([{ field: "annualFee", value: 48000, excerpt: "48000" }], { partial: true });
    assert.equal(partial.record.spec.envelope.result.outcome.status, "partial");
    const states = deriveFieldStates({ imports: [{ record: partial.record, expectedFields: [slot("annualFee"), slot("renewalDate")] }] });
    const renewal = byField(states, "renewalDate");
    assert.equal(renewal.content, "not_covered");
    assert.equal(renewal.reviewItemName, undefined);
    assert.equal(renewal.lifecycle, undefined, "nothing to decide without an item");
    assert.deepEqual(renewal.signals, { incompleteRun: true });
    // A field that did get a value in the partial run is a value, and carries the signal.
    const fee = byField(states, "annualFee");
    assert.equal(fee.content, "value");
    assert.deepEqual(fee.signals, { incompleteRun: true });

    // The same field in a complete run has no content state: no producer can
    // say "not in the document" yet, so nothing is named.
    const complete = importFields([{ field: "annualFee", value: 48000, excerpt: "48000" }]);
    const completeRenewal = byField(deriveFieldStates({ imports: [{ record: complete.record, expectedFields: [slot("renewalDate")] }] }), "renewalDate");
    assert.equal(completeRenewal.content, undefined);
    assert.deepEqual(completeRenewal.signals, {});
    assertOnlyShippedStates(states);
  });

  it("unsupported: every candidate has a contradicted or not-addressed record and none supported", () => {
    const imported = importFields([
      { field: "annualFee", value: 48000, excerpt: "48000" },
      { field: "annualFee", value: 52000, excerpt: "52000" },
    ]);
    const item = imported.reviewItems[0]!;
    const contradicted = verification(item, "contradicted", 0);
    const notAddressed = verification(item, "not-addressed", 1);
    const derive = (verifications?: CandidateVerification[]) => deriveFieldStates({ imports: [{ record: imported.record }], ...(verifications ? { verifications } : {}) })[0]!.content;
    assert.equal(derive([contradicted, notAddressed]), "unsupported");
    // One candidate unverified, or one supported, is not unsupported.
    assert.equal(derive([contradicted]), "conflicting");
    assert.equal(derive([contradicted, notAddressed, verification(item, "supported", 1)]), "conflicting");
    assert.equal(derive([contradicted, verification(item, "abstain", 1)]), "conflicting", "an abstention is not a verdict");
    // Without verifier records the state is never produced.
    assert.equal(derive(), "conflicting");
    // A record for another value does not apply.
    const moved = { ...contradicted, candidateId: item.spec.candidates[1]!.id };
    assert.equal(derive([moved as CandidateVerification, notAddressed]), "conflicting");
  });

  it("an excluded proposal keeps its slot on record without a content state, or not_covered in a partial run", () => {
    const imported = importFields([
      { field: "annualFee", value: 48000, excerpt: "48000" },
      { field: "renewalDate", value: "2027-03-31", excerpt: "2027-03-31" },
    ], { mismatched: [1] });
    assert.equal(imported.reviewItems.length, 1);
    const renewal = byField(deriveFieldStates({ imports: [{ record: imported.record, expectedFields: [slot("renewalDate")] }] }), "renewalDate");
    assert.equal(renewal.content, undefined, "a dropped proposal is not a finding that the value is absent");
    assert.deepEqual(renewal.signals, { excludedProposals: 1 });
    const partial = importFields([
      { field: "annualFee", value: 48000, excerpt: "48000" },
      { field: "renewalDate", value: "2027-03-31", excerpt: "2027-03-31" },
    ], { mismatched: [1], partial: true });
    const partialRenewal = byField(deriveFieldStates({ imports: [{ record: partial.record }] }), "renewalDate");
    assert.equal(partialRenewal.content, "not_covered");
    assert.deepEqual(partialRenewal.signals, { incompleteRun: true, excludedProposals: 1 });
  });
});

describe("field lifecycle states", () => {
  it("pending, accepted, rejected and could_not_confirm come from the item's decision", () => {
    const imported = importFields([
      { field: "a", value: "one", excerpt: "one" },
      { field: "b", value: "two", excerpt: "two" },
      { field: "c", value: "three", excerpt: "three" },
      { field: "d", value: "four", excerpt: "four" },
    ]);
    const [a, b, c] = imported.reviewItems;
    const decisions = [decide(a!, "accept-proposed"), decide(b!, "reject-proposed"), decide(c!, "could-not-confirm", "Source is illegible")];
    const states = deriveFieldStates({ imports: [{ record: imported.record }], decisions });
    assert.deepEqual(states.map((state) => [state.slot.fieldOrBehavior, state.lifecycle, state.decisionBasis ?? null]), [
      ["a", "accepted", "affirmed"], ["b", "rejected", "affirmed"], ["c", "could_not_confirm", "affirmed"], ["d", "pending", null],
    ]);
    assertOnlyShippedStates(states);
    assert.throws(() => deriveFieldStates({ imports: [{ record: imported.record }], decisions: [decisions[0]!, decisions[0]!] }), /more than one decision/);
  });

  it("superseded appears only when a supersession names the decision", () => {
    const first = importFields([{ field: "a", value: "one", excerpt: "one" }]);
    const second = importFields([{ field: "a", value: "uno", excerpt: "uno" }], { runId: "traverse-extraction-run:00000000-0000-4000-8000-0000000000f6" });
    const prior = decide(first.reviewItems[0]!, "accept-proposed");
    const next = decide(second.reviewItems[0]!, "accept-proposed");
    const priorRound = { item: first.reviewItems[0]!, slotId: "slot:a", candidateVersionIds: { [first.reviewItems[0]!.spec.candidates[0]!.id]: "v1" } };
    const nextRound = { item: second.reviewItems[0]!, slotId: "slot:a", candidateVersionIds: { [second.reviewItems[0]!.spec.candidates[0]!.id]: "v2" } };
    const supersession = buildDecisionSupersession({ prior: { ...priorRound, decision: prior }, item: nextRound, decision: next });
    assert.equal(deriveFieldStates({ imports: [{ record: first.record }], decisions: [prior] })[0]!.lifecycle, "accepted");
    assert.equal(deriveFieldStates({ imports: [{ record: first.record }], decisions: [prior], supersessions: [supersession] })[0]!.lifecycle, "superseded");
    assert.equal(deriveFieldStates({ imports: [{ record: second.record }], decisions: [next], supersessions: [supersession] })[0]!.lifecycle, "accepted");
  });
});

describe("field states in the Surface projection", () => {
  it("projects both states as claim metadata under the documented key, with no status change", () => {
    const imported = importFields([
      { field: "annualFee", value: 48000, excerpt: "48000" },
      { field: "vendorName", value: "Acme", excerpt: "Acme" },
      { field: "vendorName", value: "Acme Corp", excerpt: "Acme Corp" },
    ], { partial: true });
    const [fee, name] = imported.reviewItems;
    const snapshot = initialReviewQueueSessionState(imported.reviewItems);
    const events = buildReviewSessionEvents({
      ...snapshot,
      decisionsByItemName: { [fee!.metadata.name]: "accept-proposed", [name!.metadata.name]: "reject-proposed" },
    }, "states");
    const applied = applyReviewSession({ snapshot, events, sessionName: "states", extractionImport: imported.record });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    const base = { source: "fixture", generatedAt: "2026-09-28T12:00:00.000Z", projectionContextId: "states-1", items: imported.reviewItems, results: applied.results };
    const withStates = buildCanonicalReviewedTrustInput({ ...base, fieldStates: { imports: [{ record: imported.record }] } });
    const without = buildCanonicalReviewedTrustInput(base);

    const bundle = buildSurveyTrustBundle(withStates.surveyInput, { projectionContextId: withStates.projectionContextId });
    const plain = buildSurveyTrustBundle(without.surveyInput, { projectionContextId: without.projectionContextId });
    const claimFor = (b: typeof bundle, field: string) => b.claims.find((claim) => claim.fieldOrBehavior === field)!;
    assert.deepEqual(claimFor(bundle, "annualFee").metadata?.[FIELD_STATE_METADATA_KEY], {
      schemaVersion: 1, content: "value", lifecycle: "accepted", decisionBasis: "affirmed", signals: { incompleteRun: true },
    });
    assert.deepEqual(claimFor(bundle, "vendorName").metadata?.[FIELD_STATE_METADATA_KEY], {
      schemaVersion: 1, content: "conflicting", lifecycle: "rejected", decisionBasis: "affirmed", signals: { incompleteRun: true },
    });
    for (const field of ["annualFee", "vendorName"]) {
      assert.equal(claimFor(bundle, field).status, claimFor(plain, field).status, "states never change claim status");
      assert.equal(claimFor(plain, field).metadata?.[FIELD_STATE_METADATA_KEY], undefined);
    }
  });
});

describe("the field-state panel in the workbench", () => {
  it("lists a field that was not read, and follows the live session's decisions", () => {
    const imported = importFields([{ field: "annualFee", value: 48000, excerpt: "48000" }], { partial: true });
    const states = deriveFieldStates({ imports: [{ record: imported.record, expectedFields: [slot("annualFee"), slot("renewalDate")] }] });
    const session = initialReviewQueueSessionState(imported.reviewItems);
    const html = renderReviewWorkbenchHtml(session, [], { fieldStates: states });
    assert.match(html, /data-testid="field-states"/);
    assert.match(html, /data-testid="field-state" data-field="renewalDate" data-content="not_covered" data-lifecycle="none"/);
    assert.match(html, /data-testid="field-state" data-field="annualFee" data-content="value" data-lifecycle="pending"/);
    assert.match(html, /data-testid="field-states-incomplete"/);
    const decided = renderReviewWorkbenchHtml({ ...session, decisionsByItemName: { [imported.reviewItems[0]!.metadata.name]: "accept-proposed" } }, [], { fieldStates: states });
    assert.match(decided, /data-field="annualFee" data-content="value" data-lifecycle="accepted"/);
    assert.doesNotMatch(renderReviewWorkbenchHtml(session), /data-testid="field-states"/, "no panel without states");
  });

  it("in a score-blind session shows no verifier-derived content state", () => {
    const imported = importFields([{ field: "annualFee", value: 48000, excerpt: "48000" }]);
    const states = deriveFieldStates({ imports: [{ record: imported.record }], verifications: [verification(imported.reviewItems[0]!, "contradicted")] });
    assert.equal(states[0]!.content, "unsupported");
    const session = initialReviewQueueSessionState(imported.reviewItems);
    assert.match(renderReviewWorkbenchHtml(session, [], { fieldStates: states }), /data-content="unsupported"/);
    const blind = renderReviewWorkbenchHtml({ ...session, presentation: { scoreBlind: true } }, [], { fieldStates: states });
    assert.doesNotMatch(blind, /unsupported|Not supported by verifier/);
    assert.match(blind, /data-field="annualFee" data-content="value"/);
  });
});
