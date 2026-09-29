/**
 * Decisions across review rounds (#295): an unchanged candidate inherits its
 * prior decision with a record naming it; a changed one goes to review, and
 * once decided the prior decision reads as superseded. A carried-forward
 * decision is always distinguishable from one affirmed against the new round.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDecisionSupersession,
  decisionReference,
  deriveFieldStates,
  splitRoundForCarryForward,
  validateDecisionCarryForward,
  validateDecisionSupersession,
  type PriorRoundDecision,
  type RoundReviewItem,
} from "../src/index.js";
import type { ExtractionEnvelopeImportResult } from "../src/extraction-envelope.js";
import type { ReviewItem } from "../src/review-resource.js";
import { initialReviewQueueSessionState, type ReviewWorkbenchDecision } from "../src/review-workbench/review-queue-session.js";
import { buildReviewDecision, currentReviewWorkbenchState } from "../src/review-workbench/review-workbench.js";
import { importFields, type FieldProposalSeed } from "./field-state-fixture.js";

const RUN_1 = "traverse-extraction-run:00000000-0000-4000-8000-000000000101";
const RUN_2 = "traverse-extraction-run:00000000-0000-4000-8000-000000000102";

/**
 * Producer identities, as a producer would compute them: the slot from the
 * source lineage and field, the version from the value and its evidence.
 * The fixture keeps the same text layout across rounds, so an unchanged
 * proposal has the same locator and excerpt.
 */
function round(imported: ExtractionEnvelopeImportResult, versionOf: (item: ReviewItem, candidateIndex: number) => string = (item, index) => `v:${item.spec.target}:${JSON.stringify(item.spec.candidates[index]!.value)}`): RoundReviewItem[] {
  return imported.reviewItems.map((item) => ({
    item,
    slotId: `slot:acme-contract:${item.spec.target}`,
    candidateVersionIds: Object.fromEntries(item.spec.candidates.map((candidate, index) => [candidate.id, versionOf(item, index)])),
  }));
}

function decide(entry: RoundReviewItem, decision: ReviewWorkbenchDecision, note = "", selectedCandidateId?: string): PriorRoundDecision {
  const state = currentReviewWorkbenchState(initialReviewQueueSessionState([entry.item]));
  return { ...entry, decision: buildReviewDecision({ ...state, decision, note, ...(selectedCandidateId ? { selectedCandidateId } : {}) })! };
}

function rounds(first: FieldProposalSeed[], second: FieldProposalSeed[]) {
  return {
    one: importFields(first, { runId: RUN_1, importName: "round-1" }),
    two: importFields(second, { runId: RUN_2, importName: "round-2" }),
  };
}

const FEE = { field: "annualFee", value: 48000, excerpt: "48000" };

describe("carry-forward across rounds", () => {
  it("carries an accepted decision forward when the candidate is unchanged, naming the prior decision", () => {
    const { one, two } = rounds([FEE], [FEE]);
    const [prior] = round(one);
    const [next] = round(two);
    // A new extraction gives the unchanged field a new item and candidate identity.
    assert.notEqual(next!.item.metadata.name, prior!.item.metadata.name);
    assert.notEqual(next!.item.spec.candidates[0]!.id, prior!.item.spec.candidates[0]!.id);
    const accepted = decide(prior!, "accept-proposed");

    const split = splitRoundForCarryForward({ roundId: "round-2", items: [next!], priorDecisions: [accepted] });
    assert.equal(split.needsReview.length, 0);
    const [carried] = split.carriedForward;
    assert.deepEqual(carried!.carryForward.priorDecision, decisionReference(accepted.decision));
    assert.equal(carried!.carryForward.priorDecision.name, accepted.decision.metadata.name);
    assert.equal(carried!.carryForward.reviewItemName, next!.item.metadata.name);
    assert.equal(carried!.carryForward.candidateId, next!.item.spec.candidates[0]!.id, "the decision applies to the new round's candidate");
    assert.equal(carried!.carryForward.resolution, "accepted");
    assert.equal(carried!.carryForward.basis, "carried-forward");
    assert.equal(carried!.carryForward.roundId, "round-2");
    assert.deepEqual(validateDecisionCarryForward(JSON.parse(JSON.stringify(carried!.carryForward))), carried!.carryForward);
    assert.throws(() => validateDecisionCarryForward({ ...carried!.carryForward, resolution: "rejected" }), /not the digest/);
    assert.throws(() => validateDecisionCarryForward({ ...carried!.carryForward, basis: "affirmed" }), /basis/);

    // The field state reads it as carried forward, not affirmed.
    const [state] = deriveFieldStates({ imports: [{ record: two.record }], carryForwards: [carried!.carryForward] });
    assert.equal(state!.lifecycle, "accepted");
    assert.equal(state!.decisionBasis, "carried-forward");
    assert.equal(state!.decisionName, accepted.decision.metadata.name);
    const affirmed = decide(next!, "accept-proposed");
    const [affirmedState] = deriveFieldStates({ imports: [{ record: two.record }], decisions: [affirmed.decision] });
    assert.equal(affirmedState!.decisionBasis, "affirmed");
  });

  it("sends a changed value to review, and the prior decision is superseded once the new one is made", () => {
    const { one, two } = rounds([FEE], [{ field: "annualFee", value: 52000, excerpt: "52000" }]);
    const [prior] = round(one);
    const [next] = round(two);
    const accepted = decide(prior!, "accept-proposed");
    const split = splitRoundForCarryForward({ roundId: "round-2", items: [next!], priorDecisions: [accepted] });
    assert.equal(split.carriedForward.length, 0);
    assert.equal(split.needsReview[0]!.reason, "candidate-changed");
    assert.deepEqual(split.needsReview[0]!.priorDecision, decisionReference(accepted.decision));

    const decided = decide(next!, "accept-proposed");
    const supersession = buildDecisionSupersession({ prior: accepted, item: next!, decision: decided.decision });
    assert.equal(supersession.reason, "candidate-changed");
    assert.deepEqual(supersession.priorDecision, decisionReference(accepted.decision));
    assert.deepEqual(supersession.newDecision, decisionReference(decided.decision));
    assert.deepEqual(validateDecisionSupersession(JSON.parse(JSON.stringify(supersession))), supersession);
    assert.throws(() => validateDecisionSupersession({ ...supersession, reason: "re-reviewed" }), /not the digest/);

    const [priorState] = deriveFieldStates({ imports: [{ record: one.record }], decisions: [accepted.decision], supersessions: [supersession] });
    assert.equal(priorState!.lifecycle, "superseded");
    const [newState] = deriveFieldStates({ imports: [{ record: two.record }], decisions: [decided.decision], supersessions: [supersession] });
    assert.equal(newState!.lifecycle, "accepted");

    // A superseded decision is no longer live: it is not carried into a later round.
    const later = splitRoundForCarryForward({ roundId: "round-3", items: [next!], priorDecisions: [accepted], supersessions: [supersession] });
    assert.equal(later.needsReview[0]!.reason, "no-prior-decision");
  });

  it("a changed version with unchanged content still needs review", () => {
    const { one, two } = rounds([FEE], [FEE]);
    const [prior] = round(one);
    const [next] = round(two, () => "v:annualFee:new-artifact");
    const split = splitRoundForCarryForward({ roundId: "round-2", items: [next!], priorDecisions: [decide(prior!, "accept-proposed")] });
    assert.equal(split.needsReview[0]!.reason, "candidate-changed");
  });

  it("never carries across a changed value, excerpt or evidence, even under a reused version id", () => {
    const sameVersion = () => "v:annualFee:reused";
    const cases: Array<[string, FieldProposalSeed]> = [
      ["value", { ...FEE, value: 48001 }],
      ["excerpt", { ...FEE, excerpt: "48,00" }],
    ];
    for (const [label, changed] of cases) {
      const { one, two } = rounds([FEE], [changed]);
      const split = splitRoundForCarryForward({ roundId: "round-2", items: round(two, sameVersion), priorDecisions: [decide(round(one, sameVersion)[0]!, "accept-proposed")] });
      assert.equal(split.carriedForward.length, 0, label);
      assert.equal(split.needsReview[0]!.reason, "candidate-content-changed", label);
    }
    // Evidence: the same value and excerpt found at another place in the source.
    const { one, two } = rounds([FEE], [{ field: "preamble", value: "x", excerpt: "x" }, FEE]);
    const nextFee = round(two, sameVersion).find((entry) => entry.item.spec.target === "annualFee")!;
    assert.notEqual(nextFee.item.spec.candidates[0]!.locator!.locator, round(one)[0]!.item.spec.candidates[0]!.locator!.locator);
    const moved = splitRoundForCarryForward({ roundId: "round-2", items: [nextFee], priorDecisions: [decide(round(one, sameVersion)[0]!, "accept-proposed")] });
    assert.equal(moved.needsReview[0]!.reason, "candidate-content-changed");
  });

  it("does not carry a rejected or could-not-confirm decision unless the policy allows it", () => {
    const { one, two } = rounds([FEE], [FEE]);
    const [prior] = round(one);
    const [next] = round(two);
    for (const [decision, resolution] of [["reject-proposed", "rejected"], ["could-not-confirm", "could_not_confirm"]] as const) {
      const priorDecision = decide(prior!, decision, "Checked the source");
      const byDefault = splitRoundForCarryForward({ roundId: "round-2", items: [next!], priorDecisions: [priorDecision] });
      assert.equal(byDefault.carriedForward.length, 0, decision);
      assert.equal(byDefault.needsReview[0]!.reason, "resolution-not-carried");
      const allowed = splitRoundForCarryForward({ roundId: "round-2", items: [next!], priorDecisions: [priorDecision], policy: { carry: ["accepted", resolution] } });
      assert.equal(allowed.carriedForward[0]!.carryForward.resolution, resolution);
      const [state] = deriveFieldStates({ imports: [{ record: two.record }], carryForwards: [allowed.carriedForward[0]!.carryForward] });
      assert.equal(state!.lifecycle, resolution);
    }
  });

  it("carries a choice between conflicting values only when the same values are in conflict again", () => {
    const conflict = [FEE, { field: "annualFee", value: 52000, excerpt: "52000" }];
    const { one, two } = rounds(conflict, conflict);
    const [prior] = round(one);
    const [next] = round(two);
    const chosen = prior!.item.spec.candidates[1]!;
    const choice = decide(prior!, "select-proposed", "", chosen.id);
    const [carried] = splitRoundForCarryForward({ roundId: "round-2", items: [next!], priorDecisions: [choice] }).carriedForward;
    assert.equal(carried!.carryForward.candidateId, next!.item.spec.candidates[1]!.id);
    assert.equal(carried!.carryForward.versionIds.length, 2);
    // A new rival value is a changed slot: the choice goes back to review.
    const three = importFields([...conflict, { field: "annualFee", value: 50000, excerpt: "50000" }], { runId: RUN_2, importName: "round-3" });
    assert.equal(splitRoundForCarryForward({ roundId: "round-3", items: round(three), priorDecisions: [choice] }).needsReview[0]!.reason, "candidate-changed");
  });

  it("requires producer slot and version identities and never invents them", () => {
    const { one, two } = rounds([FEE], [FEE]);
    const [prior] = round(one);
    const [next] = round(two);
    const accepted = decide(prior!, "accept-proposed");
    assert.throws(() => splitRoundForCarryForward({ roundId: "r", items: [{ ...next!, slotId: "" }], priorDecisions: [accepted] }), /slotId/);
    assert.throws(() => splitRoundForCarryForward({ roundId: "r", items: [{ ...next!, candidateVersionIds: {} }], priorDecisions: [accepted] }), /version id for exactly its candidates/);
    assert.throws(() => splitRoundForCarryForward({ roundId: "r", items: [next!], priorDecisions: [{ ...accepted, candidateVersionIds: { other: "v" } }] }), /version id for exactly its candidates/);
    assert.throws(() => splitRoundForCarryForward({ roundId: "r", items: [next!], priorDecisions: [{ ...accepted, item: next!.item, candidateVersionIds: next!.candidateVersionIds }] }), /names .*, not /);
    assert.throws(() => splitRoundForCarryForward({ roundId: "r", items: [next!, next!], priorDecisions: [] }), /two items for slot/);
    assert.throws(() => splitRoundForCarryForward({ roundId: "", items: [next!], priorDecisions: [] }), /roundId/);
    assert.throws(() => splitRoundForCarryForward({ roundId: "r", items: [next!], priorDecisions: [accepted], policy: { carry: ["held" as never] } }), /unknown resolution/);
  });

  it("refuses to pick between two live prior decisions for one slot", () => {
    const { one, two } = rounds([FEE], [FEE]);
    const [prior] = round(one);
    const [next] = round(two);
    const first = decide(prior!, "accept-proposed");
    const second = decide(prior!, "accept-proposed", "Rechecked");
    const split = splitRoundForCarryForward({ roundId: "round-2", items: [next!], priorDecisions: [first, second] });
    assert.equal(split.needsReview[0]!.reason, "ambiguous-prior-decisions");
  });

  it("re-reviewing an unchanged slot supersedes the prior decision as re-reviewed", () => {
    const { one, two } = rounds([FEE], [FEE]);
    const [prior] = round(one);
    const [next] = round(two);
    const rejected = decide(prior!, "reject-proposed");
    const accepted = decide(next!, "accept-proposed");
    assert.equal(buildDecisionSupersession({ prior: rejected, item: next!, decision: accepted.decision }).reason, "re-reviewed");
    assert.throws(() => buildDecisionSupersession({ prior: rejected, item: { ...next!, slotId: "slot:other" }, decision: accepted.decision }), /one slot/);
    assert.throws(() => buildDecisionSupersession({ prior: rejected, item: prior!, decision: rejected.decision }), /supersede itself/);
  });
});
