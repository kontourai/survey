import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildReviewedLearningUpdateProposal,
  buildCanonicalReviewProofPayload,
  buildSurveyLearningProjections,
  buildSurveyTrustBundle,
  hashCanonicalReviewProofPayload,
  type ReviewedLearningUpdateProposalInput,
  type SurveyInput,
} from "../src/index.js";

const proofHash = "a".repeat(64);

function fixture(): ReviewedLearningUpdateProposalInput {
  const survey: SurveyInput = {
    source: "review-workflow",
    generatedAt: "2026-07-10T12:00:00.000Z",
    rawSources: [
      { id: "source-current", kind: "api-record", resolution: "supersession", sourceRef: "record:1", observedAt: "2026-07-01T00:00:00.000Z", locatorScheme: "structured-field" },
      { id: "source-proposed", kind: "manual-entry", resolution: "supersession", sourceRef: "review:1", observedAt: "2026-07-02T00:00:00.000Z", locatorScheme: "structured-field" },
    ],
    extractions: [
      { id: "ex-current", sourceId: "source-current", target: "setting.threshold", value: 10, locator: "field:threshold", extractor: "fixture", extractedAt: "2026-07-01T00:00:00.000Z" },
      { id: "ex-proposed", sourceId: "source-proposed", target: "setting.threshold", value: 12, locator: "field:threshold", extractor: "fixture", extractedAt: "2026-07-02T00:00:00.000Z" },
    ],
    candidateSets: [{
      id: "set-1", target: "setting.threshold", status: "resolved", selectedCandidateId: "candidate-proposed",
      candidates: [
        { id: "candidate-current", extractionId: "ex-current", value: 10, metadata: { candidateRole: "current" } },
        { id: "candidate-proposed", extractionId: "ex-proposed", value: 12, metadata: { candidateRole: "proposed" } },
      ],
    }],
    reviewOutcomes: [{ id: "review-1", candidateSetId: "set-1", candidateId: "candidate-proposed", status: "verified", actor: "reviewer", reviewedAt: "2026-07-03T00:00:00.000Z", evidenceIds: ["evidence-b", "evidence-a"], authorizing: { kind: "explicit-statement", statement: "accepted" } }],
    claims: [
      { id: "claim-current", candidateSetId: "set-1", candidateId: "candidate-current", subjectType: "configuration", subjectId: "service-1", facet: "operation", claimType: "setting", fieldOrBehavior: "threshold", status: "superseded", impactLevel: "medium", collectedBy: "fixture" },
      { id: "claim-proposed", candidateSetId: "set-1", candidateId: "candidate-proposed", subjectType: "configuration", subjectId: "service-1", facet: "operation", claimType: "setting", fieldOrBehavior: "threshold", status: "verified", impactLevel: "medium", collectedBy: "fixture" },
    ],
  };
  return { survey, candidateSetId: "set-1", reviewOutcomeId: "review-1", selectedClaimId: "claim-proposed", proof: { kind: "review-proof", algorithm: "sha256", value: proofHash, proofSchemaVersion: 2 } };
}

describe("buildReviewedLearningUpdateProposal", () => {
  it("emits the exact producer-neutral reviewed correction", () => {
    assert.deepEqual(buildReviewedLearningUpdateProposal(fixture()), {
      id: "1c6dc753baf37c46ec42b22dcf8f92f2fbcdb13d7de39a17bca6590b25bc3409",
      kind: "learning.update-proposal", source: "review-workflow", createdAt: "2026-07-03T00:00:00.000Z",
      subject: { subjectType: "configuration", subjectId: "service-1", facet: "operation", claimType: "setting", fieldOrBehavior: "threshold" },
      applicability: { target: "setting.threshold" }, proposedDelta: { previousValue: 10, proposedValue: 12 },
      evidenceRefs: [
        { kind: "evidence", id: "evidence-a" }, { kind: "evidence", id: "evidence-b" },
        { kind: "provenance", rawSourceId: "source-current", origin: "api-record", resolution: "supersession", reviewOutcomeId: "review-1" },
        { kind: "provenance", rawSourceId: "source-proposed", origin: "manual-entry", resolution: "supersession", reviewOutcomeId: "review-1" },
        { kind: "review-proof", algorithm: "sha256", value: proofHash, proofSchemaVersion: 2 },
      ],
      authorizationRef: { reviewOutcomeId: "review-1", reviewProofHash: proofHash },
      reviewLineage: { candidateSetId: "set-1", selectedCandidateId: "candidate-proposed", unselectedCandidateIds: ["candidate-current"], reviewOutcomeId: "review-1", selectedClaimId: "claim-proposed" },
    });
  });

  it("includes every sorted unselected candidate while roles remain unambiguous", () => {
    const input = fixture();
    input.survey.candidateSets[0]!.candidates.push({ id: "candidate-alternative", extractionId: "ex-alt", value: 11 });
    input.survey.extractions.push({ id: "ex-alt", sourceId: "source-current", target: "setting.threshold", value: 11, extractor: "fixture", extractedAt: "2026-07-02T00:00:00.000Z" });
    input.survey.claims.push({ ...input.survey.claims[0]!, id: "claim-alt", candidateId: "candidate-alternative" });
    const reordered = structuredClone(input); reordered.survey.candidateSets[0]!.candidates.reverse();
    const first = buildReviewedLearningUpdateProposal(input); const second = buildReviewedLearningUpdateProposal(reordered);
    assert.deepEqual(first.reviewLineage.unselectedCandidateIds, ["candidate-alternative", "candidate-current"]);
    assert.equal(first.id, second.id);
  });

  it("deduplicates set-like evidence references before sorting and hashing", () => {
    const input = fixture(); input.survey.reviewOutcomes[0]!.evidenceIds = ["evidence-b", "evidence-a", "evidence-b", "evidence-a"];
    input.survey.extractions[1]!.sourceId = "source-current";
    const reordered = structuredClone(input); reordered.survey.reviewOutcomes[0]!.evidenceIds!.reverse();
    const first = buildReviewedLearningUpdateProposal(input); const second = buildReviewedLearningUpdateProposal(reordered);
    assert.deepEqual(first.evidenceRefs, [
      { kind: "evidence", id: "evidence-a" }, { kind: "evidence", id: "evidence-b" },
      { kind: "provenance", rawSourceId: "source-current", origin: "api-record", resolution: "supersession", reviewOutcomeId: "review-1" },
      { kind: "review-proof", algorithm: "sha256", value: proofHash, proofSchemaVersion: 2 },
    ]);
    assert.equal(first.id, second.id);
  });

  it("is deterministic across set ordering and changes for semantic changes", () => {
    const base = fixture(); const reordered = fixture();
    reordered.survey.candidateSets[0]!.candidates.reverse(); reordered.survey.reviewOutcomes[0]!.evidenceIds!.reverse(); reordered.survey.rawSources.reverse();
    assert.equal(buildReviewedLearningUpdateProposal(base).id, buildReviewedLearningUpdateProposal(reordered).id);
    for (const mutate of [
      (x: ReviewedLearningUpdateProposalInput) => { x.survey.claims[0]!.subjectId = "service-2"; x.survey.claims[1]!.subjectId = "service-2"; },
      (x: ReviewedLearningUpdateProposalInput) => { x.survey.candidateSets[0]!.target = "setting.limit"; x.survey.extractions.forEach(e => { e.target = "setting.limit"; }); },
      (x: ReviewedLearningUpdateProposalInput) => { x.survey.candidateSets[0]!.candidates[1]!.value = 13; x.survey.extractions[1]!.value = 13; },
      (x: ReviewedLearningUpdateProposalInput) => { x.proof.value = "b".repeat(64); },
      (x: ReviewedLearningUpdateProposalInput) => { x.survey.rawSources[0]!.kind = "web-page"; },
      (x: ReviewedLearningUpdateProposalInput) => { x.survey.claims[1]!.id = "claim-other"; x.selectedClaimId = "claim-other"; },
    ]) { const changed = fixture(); mutate(changed); assert.notEqual(buildReviewedLearningUpdateProposal(base).id, buildReviewedLearningUpdateProposal(changed).id); }
  });

  it("rejects incomplete or inconsistent adjudications", () => {
    const cases: Array<[string, (x: ReviewedLearningUpdateProposalInput) => void, RegExp]> = [
      ["unresolved", x => { x.survey.candidateSets[0]!.status = "needs-review"; }, /resolved/],
      ["keep-current", x => { x.survey.candidateSets[0]!.selectedCandidateId = "candidate-current"; x.survey.reviewOutcomes[0]!.candidateId = "candidate-current"; }, /proposed/],
      ["rejected", x => { x.survey.reviewOutcomes[0]!.status = "rejected"; }, /^Error: learning update requires an accepted review status$/],
      ["missing role", x => { delete x.survey.candidateSets[0]!.candidates[0]!.metadata; }, /current.*proposed/],
      ["duplicate role", x => { x.survey.candidateSets[0]!.candidates[0]!.metadata = { candidateRole: "proposed" }; }, /current.*proposed/],
      ["review mismatch", x => { x.survey.reviewOutcomes[0]!.candidateId = "candidate-current"; }, /selected candidate/],
      ["claim mismatch", x => { x.selectedClaimId = "claim-current"; }, /selected claim/],
      ["lineage missing", x => { x.survey.claims = []; }, /selected claim/],
      ["missing review time", x => { delete x.survey.reviewOutcomes[0]!.reviewedAt; }, /reviewedAt/],
      ["missing authorization", x => { delete x.survey.reviewOutcomes[0]!.authorizing; }, /authorizing review provenance/],
      ["missing provenance", x => { delete x.survey.rawSources[0]!.resolution; }, /supersession provenance/],
      ["wrong provenance", x => { x.survey.rawSources[0]!.resolution = "observation"; }, /supersession provenance/],
      ["unidentified hash", x => { x.proof.value = "not-a-sha256"; }, /SHA-256/],
      ["missing proof", x => { (x as { proof?: unknown }).proof = undefined; }, /canonical v2 review proof/],
      ["wrong proof kind", x => { (x.proof as { kind: string }).kind = "integrity-anchor"; }, /canonical v2 review proof/],
      ["wrong proof version", x => { (x.proof as { proofSchemaVersion: number }).proofSchemaVersion = 1; }, /canonical v2 review proof/],
      ["current claim posture", x => { x.survey.claims[0]!.status = "rejected"; }, /unselected claim status/],
    ];
    for (const [name, mutate, expected] of cases) { const input = fixture(); mutate(input); assert.throws(() => buildReviewedLearningUpdateProposal(input), expected, name); }
  });

  it("rejects a both-rejected adjudication as ineligible", () => {
    const input = fixture();
    input.survey.reviewOutcomes[0]!.status = "rejected";
    input.survey.claims[1]!.status = "rejected";
    assert.throws(
      () => buildReviewedLearningUpdateProposal(input),
      /^Error: learning update requires an accepted review status$/,
    );
  });

  it("independently rejects a non-accepted selected claim posture", () => {
    const input = fixture();
    input.survey.claims[1]!.status = "proposed";
    assert.throws(
      () => buildReviewedLearningUpdateProposal(input),
      /^Error: learning update requires an accepted selected claim status$/,
    );
  });

  it("separately rejects accepted review and claim statuses that differ", () => {
    const input = fixture();
    input.survey.reviewOutcomes[0]!.status = "assumed";
    assert.throws(
      () => buildReviewedLearningUpdateProposal(input),
      /^Error: selected claim status must match the accepted review status$/,
    );
  });

  it("rejects ambiguous joins instead of taking the first record", () => {
    const duplicateCases: Array<[string, (x: ReviewedLearningUpdateProposalInput) => void]> = [
      ["candidate set", x => x.survey.candidateSets.push(structuredClone(x.survey.candidateSets[0]!))],
      ["review outcome", x => x.survey.reviewOutcomes.push(structuredClone(x.survey.reviewOutcomes[0]!))],
      ["selected claim", x => x.survey.claims.push(structuredClone(x.survey.claims[1]!))],
      ["extraction", x => x.survey.extractions.push(structuredClone(x.survey.extractions[1]!))],
      ["source", x => x.survey.rawSources.push(structuredClone(x.survey.rawSources[1]!))],
      ["candidate", x => x.survey.candidateSets[0]!.candidates.push(structuredClone(x.survey.candidateSets[0]!.candidates[1]!))],
    ];
    for (const [name, addDuplicate] of duplicateCases) { const input = fixture(); addDuplicate(input); assert.throws(() => buildReviewedLearningUpdateProposal(input), /exactly one|duplicate|ambiguous/, name); }
  });

  it("rejects values outside the collision-free canonical JSON domain", () => {
    const badValues: unknown[] = [undefined, () => 1, Symbol("x"), 1n, Number.NaN, Infinity, -Infinity, -0, new Date(), new Map()];
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; badValues.push(cyclic);
    badValues.push({ [Symbol("hidden")]: 1 });
    badValues.push(Object.defineProperty({}, "hidden", { value: 1, enumerable: false }));
    badValues.push(Object.defineProperty({}, "computed", { get: () => 1, enumerable: true }));
    for (const value of badValues) { const input = fixture(); input.survey.candidateSets[0]!.candidates[1]!.value = value; input.survey.extractions[1]!.value = value; assert.throws(() => buildReviewedLearningUpdateProposal(input), /canonical JSON value/, String(value)); }
    const nullValue = fixture(); nullValue.survey.candidateSets[0]!.candidates[1]!.value = null; nullValue.survey.extractions[1]!.value = null;
    assert.notEqual(buildReviewedLearningUpdateProposal(nullValue).id, buildReviewedLearningUpdateProposal(fixture()).id);
  });

  it("validates extraction values before canonical comparison without invoking getters", () => {
    let getterCalls = 0;
    const unsafeExtractions: unknown[] = [undefined, (() => { const x: Record<string, unknown> = {}; x.self = x; return x; })(), Object.defineProperty({}, "computed", { get: () => { getterCalls += 1; return 12; }, enumerable: true })];
    for (const value of unsafeExtractions) { const input = fixture(); input.survey.extractions[1]!.value = value; assert.throws(() => buildReviewedLearningUpdateProposal(input), /canonical JSON value/); }
    assert.equal(getterCalls, 0);
  });

  it("rejects arrays with unhashed own-property semantics", () => {
    const arrays: unknown[][] = [[12], [12], [12]];
    Object.defineProperty(arrays[0]!, "hidden", { value: 1, enumerable: false });
    Object.defineProperty(arrays[1]!, "computed", { get: () => 1, enumerable: true });
    (arrays[2]! as unknown as Record<string, unknown>).extra = 1;
    for (const value of arrays) { const input = fixture(); input.survey.candidateSets[0]!.candidates[1]!.value = value; input.survey.extractions[1]!.value = value; assert.throws(() => buildReviewedLearningUpdateProposal(input), /canonical JSON value/); }
  });

  it("leaves existing projections byte-identical and pins canonical v2 proof hashing", () => {
    const input = fixture();
    const learningBefore = JSON.stringify(buildSurveyLearningProjections(input.survey));
    const trustBefore = JSON.stringify(buildSurveyTrustBundle(input.survey));
    buildReviewedLearningUpdateProposal(input);
    assert.equal(JSON.stringify(buildSurveyLearningProjections(input.survey)), learningBefore);
    assert.equal(JSON.stringify(buildSurveyTrustBundle(input.survey)), trustBefore);
    const candidate = input.survey.candidateSets[0]!.candidates[1]!;
    const proofPayload = buildCanonicalReviewProofPayload({ rawSource: input.survey.rawSources[1]!, extraction: input.survey.extractions[1]!, candidateSet: input.survey.candidateSets[0]!, candidate, reviewOutcome: input.survey.reviewOutcomes[0]!, claim: input.survey.claims[1]! });
    assert.equal(hashCanonicalReviewProofPayload(proofPayload), "7dc9c493cfa2732c395ed6948964181e56e9e854a969b3ec1b10dcc77865c1e9");
  });

  it("does not mutate inputs and gives a generic consumer a complete record", () => {
    const input = fixture(); const before = structuredClone(input); const proposal = buildReviewedLearningUpdateProposal(input);
    assert.deepEqual(input, before);
    // This consumer mirrors the information needs of a persisted adjudication fixture without importing its vocabulary.
    const instruction = { target: proposal.applicability.target, from: proposal.proposedDelta.previousValue, to: proposal.proposedDelta.proposedValue, authority: proposal.authorizationRef, evidence: proposal.evidenceRefs };
    assert.deepEqual(instruction.target, "setting.threshold"); assert.equal(instruction.to, 12); assert.equal(instruction.evidence.length, 5);
  });

  it("keeps executable capabilities outside the public input", () => {
    const input: ReviewedLearningUpdateProposalInput = {
      ...fixture(),
      // @ts-expect-error proposals are data-only and never accept mutation capabilities
      writer: () => undefined,
    };
    assert.ok(input);
    const publicModule = readFileSync("src/learning-update-proposal.ts", "utf8");
    const regulatedVerticalTerm = ["t", "a", "x"].join("");
    const forbiddenImportPattern = new RegExp(`from ["']node:fs|from ["'][^"']*(?:${regulatedVerticalTerm}|consumer)`);
    assert.doesNotMatch(publicModule, forbiddenImportPattern);
    assert.doesNotMatch(publicModule, /\b(?:apply|mutate|persist|validatePath|callback|adapter|writer|store)\b/i);
  });
});
