import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIdentityIndex, type TrustBundle } from "@kontourai/surface";
import { createEntityProposal, entityProposalToReviewItem, entityOutcomeFromDecision, projectEntityReviews, planEntityReviewBatch, type EntityAlternative, type EntityProposal, type EntityOperation } from "../src/index.js";
import { buildReviewDecision, buildReviewDecisionsFromSession } from "../src/review-workbench/review-workbench.js";
import { buildReviewSessionEvents, replayReviewSessionEvents, type ReviewQueueSessionState } from "../src/review-workbench/review-queue-session.js";

const subjects: EntityAlternative["subjects"] = [{ subjectType: "person", subjectId: "alex-1" }, { subjectType: "person", subjectId: "alex-2" }];
function alternative(operation: EntityOperation, pair = subjects): EntityAlternative {
  return { subjects: pair, operation, evidence: [
    { id: "a", sourceId: "s1", sourceRef: "urn:source:1", checksum: "sha256:abc", observedAt: "2026-10-01T00:00:00Z", locatorScheme: "text-span", locator: "chars:0-10", excerpt: "Alex Smith", stance: "supports" },
    { id: "b", sourceId: "s2", sourceRef: "urn:source:2", checksum: "sha256:def", observedAt: "2026-10-01T00:00:00Z", locatorScheme: "text-span", locator: "chars:30-48", excerpt: "different employer", stance: "contradicts" },
  ], confidenceComponents: { name: 0.99, context: 0.1 } };
}
function proposal(...alternatives: EntityAlternative[]): EntityProposal {
  return createEntityProposal({ revision: "1", proposer: { id: "extractor", model: "model-v1", rule: "name" }, policy: { id: "identity-policy", revision: "7" }, alternatives });
}
function decision(p: EntityProposal, action: "accept-proposed" | "select-proposed" | "could-not-confirm" | "reject-proposed", candidateId?: string) {
  const item = entityProposalToReviewItem(p);
  return buildReviewDecision({ item, decision: action, selectedCandidateId: candidateId, note: "reviewed source", actorId: "reviewer", reviewedAt: "2026-11-02T00:00:00Z" })!;
}

test("Workbench shows homonym alternatives and contradictory evidence; replay preserves selection", () => {
  const p = proposal(alternative("merge"), alternative("related-to"));
  const reordered = proposal(alternative("related-to"), alternative("merge"), alternative("merge"));
  assert.equal(p.id, reordered.id);
  const item = entityProposalToReviewItem(p);
  assert.equal(item.spec.candidateSetStatus, "conflict");
  assert.equal(item.spec.candidates.length, 2);
  assert.match(JSON.stringify(item.spec.candidates), /different employer/);
  const selected = item.spec.candidates.find(c => (c.value as { operation: string }).operation === "related-to")!;
  const session: ReviewQueueSessionState = { items: [item], activeItemName: p.id, notesByItemName: { [p.id]: "independent people" }, decisionsByItemName: { [p.id]: "select-proposed" }, selectedCandidateIdsByItemName: { [p.id]: selected.id }, actorId: "reviewer", reviewedAt: "2026-11-02T00:00:00Z" };
  const replayed = replayReviewSessionEvents({ ...session, notesByItemName: {}, decisionsByItemName: {}, selectedCandidateIdsByItemName: {} }, buildReviewSessionEvents(session));
  const before = entityOutcomeFromDecision(p, buildReviewDecisionsFromSession(session)[0]!);
  const after = entityOutcomeFromDecision(p, buildReviewDecisionsFromSession(replayed)[0]!);
  assert.deepEqual(after, before);
  assert.equal(projectEntityReviews([p], [after]).find(r => r.candidateId === selected.id)?.status, "accepted");
  assert.equal(projectEntityReviews([p], [after]).some(r => r.identityLink), false);
});

test("superseded merge never applies after later split and can be re-merged", () => {
  const merge = proposal(alternative("merge"));
  const accepted = entityOutcomeFromDecision(merge, decision(merge, "accept-proposed"));
  const acceptedRecord = projectEntityReviews([merge], [accepted])[0]!;
  assert.equal(acceptedRecord.identityLink?.relation, "equivalent");
  const bundle: TrustBundle = { schemaVersion: 5, source: "entity-test", claims: [acceptedRecord.mappingClaim!], evidence: acceptedRecord.mappingEvidence!, events: [acceptedRecord.mappingEvent!], policies: [], identityLinks: [acceptedRecord.identityLink!] };
  assert.equal(acceptedRecord.mappingEvent?.evidenceIds.length, 2);
  assert.equal(buildIdentityIndex(bundle).canonicalKey(subjects[0]), buildIdentityIndex(bundle).canonicalKey(subjects[1]));
  const split = proposal(alternative("split"));
  const splitOutcome = entityOutcomeFromDecision(split, decision(split, "accept-proposed"), accepted.id);
  const projected = projectEntityReviews([merge, split], [accepted, splitOutcome]);
  const old = projected.find(r => r.outcomeId === accepted.id)!;
  assert.equal(old.status, "superseded");
  assert.equal(old.identityLink, undefined, "superseded merge must not apply");
  const afterSplit = buildIdentityIndex({ ...bundle, identityLinks: projected.flatMap(r => r.identityLink ? [r.identityLink] : []) });
  assert.notEqual(afterSplit.canonicalKey(subjects[0]), afterSplit.canonicalKey(subjects[1]));
  assert.equal(old.supersededBy, splitOutcome.id);
  const newMerge = createEntityProposal({ ...merge.spec, revision: "2" });
  const restored = entityOutcomeFromDecision(newMerge, decision(newMerge, "accept-proposed"), splitOutcome.id);
  assert.equal(projectEntityReviews([merge, split, newMerge], [accepted, splitOutcome, restored]).find(r => r.outcomeId === restored.id)?.identityLink?.relation, "equivalent");
  assert.throws(() => projectEntityReviews([split], [splitOutcome]), /Missing or ambiguous supersession/);
});

test("abstention cannot promote or supersede an earlier review", () => {
  const p = proposal(alternative("merge"));
  const abstain = entityOutcomeFromDecision(p, decision(p, "could-not-confirm"));
  const record = projectEntityReviews([p], [abstain])[0]!;
  assert.equal(record.status, "abstained");
  assert.equal(record.identityLink, undefined, "abstention must not apply");
  const accepted = entityOutcomeFromDecision(p, decision(p, "accept-proposed"));
  assert.throws(() => entityOutcomeFromDecision(p, decision(p, "could-not-confirm"), accepted.id), /Abstention cannot supersede/);
});

test("aliases, renamed entities, organizations, cycles, and malicious edges remain review proposals", () => {
  const orgPerson: EntityAlternative["subjects"] = [{ subjectType: "organization", subjectId: "alex-smith-ltd" }, subjects[0]];
  for (const [operation, pair] of [["alias", subjects], ["same-as", subjects], ["merge", orgPerson], ["domain:owns", orgPerson], ["related-to", [subjects[1], subjects[0]]]] as [EntityOperation, EntityAlternative["subjects"]][]) {
    const p = proposal(alternative(operation, pair));
    assert.equal(projectEntityReviews([p], [])[0]?.status, "proposed");
    assert.equal(projectEntityReviews([p], []).some(r => r.identityLink), false);
    const outcome = entityOutcomeFromDecision(p, decision(p, "reject-proposed"));
    assert.equal(projectEntityReviews([p], [outcome])[0]?.status, "rejected");
  }
});

test("bulk plan is bounded and validates supersession without side effects", () => {
  const p = proposal(alternative("merge"));
  const entry = { proposal: p, decision: decision(p, "accept-proposed") };
  assert.equal(planEntityReviewBatch([entry]).outcomes.length, 1);
  assert.throws(() => planEntityReviewBatch(Array(51).fill(entry)), /1 to 50/);
  assert.throws(() => planEntityReviewBatch([entry, entry]), /Duplicate/);
  assert.throws(() => planEntityReviewBatch([{ ...entry, supersedes: "missing" }]), /supersession/);
});
