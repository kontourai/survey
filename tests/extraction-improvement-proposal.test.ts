import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  approveExtractionImprovementProposal,
  buildExtractionImprovementProposal,
  importExtractionEnvelope,
  rejectExtractionImprovementProposal,
  type BuildExtractionImprovementProposalInput,
  type ExtractionImprovementDiagnosis,
  type PortableExtractionResultEnvelope,
  type ReviewDecision,
  type ReviewOutcome,
  type SurveyInput,
} from "../src/index.js";

const sha = (letter: string) => `sha256:${letter.repeat(64)}`;

function fixture(kind: "rejected" | "accepted" | "could_not_confirm" = "rejected"): BuildExtractionImprovementProposalInput {
  const artifactBinding = {
    format: "traverse-prepared-artifact", version: 1, digest: "d".repeat(64), preparationMode: "text",
    preparationVersion: "1", contentLength: 14, sourceSnapshotRef: "snapshot:fixture",
  } as const;
  const preparedArtifact = {
    ...artifactBinding,
    ref: `traverse-prepared-artifact:v1:sha256:${createHash("sha256").update(JSON.stringify(artifactBinding)).digest("hex")}`,
  } as const;
  const envelope: PortableExtractionResultEnvelope = {
    format: "traverse-extraction-result", version: 1, source: { ref: "source:fixture", snapshotRef: "snapshot:fixture" },
    result: {
      proposals: [{
        fieldPath: "status", candidateValue: "ACTIVE", confidence: 0.9, extractor: "fixture-extractor",
        provenance: { excerpt: "ACTIVE", locator: "chars:8-14", occurrence: { resolverVersion: "exact-occurrence-v1", count: 1, selected: { index: 0, start: 8, end: 14 }, selection: "source-order", hintUsed: false, ambiguous: false } },
      }],
      provider: "fixture-provider", runId: "traverse-extraction-run:00000000-0000-4000-8000-000000000157", raw: {}, outcome: { status: "success" },
      extractedAt: "2026-07-22T14:20:00.000Z", providerCalls: 1, totalTokensUsed: 10,
      taskDigest: sha("a"), exampleDigests: [sha("b")], preparedArtifact,
      preparedArtifactState: { status: "available", requestedRef: preparedArtifact.ref, canonicalRef: preparedArtifact.ref },
    },
  };
  const imported = importExtractionEnvelope(envelope, {
    importName: "import:fixture", producerNamespace: "producer:fixture", sourceKind: "api-record",
    claimTarget: () => ({ subjectType: "record", subjectId: "42", facet: "profile", claimType: "field", fieldOrBehavior: "status", impactLevel: "medium" }),
  });
  const reviewItem = imported.reviewItems[0]!;
  const candidate = reviewItem.spec.candidates[0]!;
  const outcomeId = "review-outcome:fixture";
  const status = kind === "accepted" ? "verified" : kind === "rejected" ? "rejected" : "proposed";
  const resolution = kind === "accepted" ? "accepted" : kind;
  const rationale = kind === "accepted"
    ? "The grounded proposal is correct and reusable."
    : kind === "rejected"
      ? "The extraction joined adjacent rows."
      : "The available source cannot confirm the value.";
  const outcome: ReviewOutcome = {
    id: outcomeId, candidateSetId: "candidate-set:fixture", candidateId: candidate.id, status, resolution,
    ...(kind === "could_not_confirm" ? { resolutionReason: rationale } : {}),
    actor: "reviewer:fixture", reviewedAt: "2026-07-22T14:25:00.000Z", rationale,
    evidenceIds: ["evidence:source", "evidence:review"], attemptEvidenceIds: ["attempt:replay"],
  };
  const reviewDecision: ReviewDecision = {
    apiVersion: "survey.kontourai.io/v1alpha1", kind: "ReviewDecision", metadata: { name: "review-decision:fixture" },
    spec: {
      reviewItemName: reviewItem.metadata.name, candidateId: candidate.id, status, resolution,
      ...(kind === "could_not_confirm" ? { resolutionReason: rationale } : {}),
      actor: { id: "reviewer:fixture" }, reviewedAt: "2026-07-22T14:25:00.000Z", rationale,
      evidenceIds: ["evidence:source", "evidence:review"], attemptEvidenceIds: ["attempt:replay"],
      projection: { reviewOutcomeId: outcomeId, candidateSetId: outcome.candidateSetId, candidateId: candidate.id },
    },
  };
  const survey: SurveyInput = {
    source: "fixture", generatedAt: "2026-07-22T14:26:00.000Z", rawSources: [], extractions: [],
    candidateSets: [], reviewOutcomes: [outcome], claims: [],
  };
  const diagnosis: ExtractionImprovementDiagnosis = kind === "accepted"
    ? { kind: "accepted-extraction", requestedTaskChanges: ["grounded-positive-example"] }
    : kind === "rejected"
      ? { kind: "bad-extraction", requestedTaskChanges: ["example-addition", "guidance-update"] }
      : { kind: "insufficient-source-evidence", sourceRemediation: "obtain-authoritative-source" };
  return {
    createdAt: "2026-07-22T14:30:00.000Z", priorTaskSpecVersion: "2026-07-01",
    extractionImport: imported.record, proposalIndex: 0, reviewItem, reviewDecision, survey,
    reviewOutcomeId: outcomeId, diagnosis,
  };
}

function approve(input: BuildExtractionImprovementProposalInput) {
  const draft = buildExtractionImprovementProposal(input);
  return approveExtractionImprovementProposal({
    draft,
    approval: { id: "approval:fixture", actor: "producer", approvedAt: "2026-07-22T14:31:00.000Z", rationale: "Create reviewed revision.", evidenceIds: ["evidence:approval"] },
    nextTaskSpec: { version: "2026-07-22", digest: sha("e"), exampleDigests: [...draft.lineage.taskSpec.exampleDigests, sha("f")] },
    rollbackTaskSpec: draft.lineage.taskSpec,
    ...(draft.diagnosis.kind === "bad-extraction" && draft.diagnosis.requestedTaskChanges.includes("guidance-update") ? { guidanceChangeProofDigest: sha("9") } : {}),
  });
}

describe("extraction improvement proposals", () => {
  it("derives complete immutable lineage from joined canonical records", () => {
    const input = fixture();
    const before = structuredClone(input);
    const draft = buildExtractionImprovementProposal(input);
    assert.equal(draft.state, "draft");
    assert.equal(draft.lineage.taskSpec.digest, input.extractionImport.spec.envelope.result.taskDigest);
    assert.equal(draft.lineage.extractionImportName, input.extractionImport.metadata.name);
    assert.equal(draft.lineage.reviewItemName, input.reviewItem.metadata.name);
    assert.equal(draft.lineage.reviewDecisionName, input.reviewDecision.metadata.name);
    assert.equal(draft.lineage.reviewOutcomeId, input.reviewOutcomeId);
    assert.equal(draft.lineage.sourceSnapshotRef, input.extractionImport.spec.envelope.source.snapshotRef);
    assert.match(draft.lineage.recordDigests.reviewOutcome, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Object.values(draft.lineage.recordDigests).every((value) => /^sha256:[a-f0-9]{64}$/.test(value)));
    assert.ok(Object.isFrozen(draft.lineage.recordDigests));
    assert.deepEqual(input, before, "building does not mutate canonical inputs");
  });

  it("rejects broken import, item, decision, and outcome joins", () => {
    const badItem = fixture();
    badItem.reviewItem.metadata.name = "review-item:unrelated";
    assert.throws(() => buildExtractionImprovementProposal(badItem), /canonical projection/);

    const badDecision = fixture();
    badDecision.reviewDecision.spec.reviewItemName = "review-item:unrelated";
    assert.throws(() => buildExtractionImprovementProposal(badDecision), /does not join/);

    const badOutcome = fixture();
    badOutcome.survey.reviewOutcomes[0]!.candidateSetId = "candidate-set:unrelated";
    assert.throws(() => buildExtractionImprovementProposal(badOutcome), /projection must identify/);

    const badCandidate = fixture();
    badCandidate.reviewDecision.spec.candidateId = "candidate:unrelated";
    assert.throws(() => buildExtractionImprovementProposal(badCandidate), /candidate lineage/);

    const inconclusiveOtherCandidate = fixture("could_not_confirm");
    inconclusiveOtherCandidate.reviewDecision.spec.candidateId = "candidate:unrelated";
    inconclusiveOtherCandidate.reviewDecision.spec.projection!.candidateId = "candidate:unrelated";
    inconclusiveOtherCandidate.survey.reviewOutcomes[0]!.candidateId = "candidate:unrelated";
    assert.throws(() => buildExtractionImprovementProposal(inconclusiveOtherCandidate), /canonical imported proposal/);
  });

  it("keeps accepted, rejected, and insufficient-evidence remedies explicit and separate", () => {
    const accepted = buildExtractionImprovementProposal(fixture("accepted"));
    assert.equal(accepted.review.resolution, "accepted");
    assert.equal(accepted.diagnosis.kind, "accepted-extraction");
    assert.equal(approve(fixture("accepted")).state, "approved");

    const rejected = buildExtractionImprovementProposal(fixture("rejected"));
    assert.equal(rejected.review.resolution, "rejected");
    assert.equal(rejected.diagnosis.kind, "bad-extraction");

    const insufficient = buildExtractionImprovementProposal(fixture("could_not_confirm"));
    assert.equal(insufficient.review.resolution, "could_not_confirm");
    assert.equal(insufficient.diagnosis.kind, "insufficient-source-evidence");

    const candidateLessInput = fixture("could_not_confirm");
    delete candidateLessInput.reviewDecision.spec.candidateId;
    delete candidateLessInput.reviewDecision.spec.projection!.candidateId;
    delete candidateLessInput.survey.reviewOutcomes[0]!.candidateId;
    assert.equal(buildExtractionImprovementProposal(candidateLessInput).review.resolution, "could_not_confirm");

    assert.throws(() => approveExtractionImprovementProposal({
      draft: insufficient,
      approval: { id: "approval:no", actor: "producer", approvedAt: "2026-07-22T14:31:00.000Z", rationale: "No task change.", evidenceIds: [] },
      nextTaskSpec: { version: "next", digest: sha("e"), exampleDigests: insufficient.lineage.taskSpec.exampleDigests },
      rollbackTaskSpec: insufficient.lineage.taskSpec,
    }), /cannot request/);
  });

  it("uses one stable disposition key so approval/rejection conflicts are machine-detectable", () => {
    const draft = buildExtractionImprovementProposal(fixture("accepted"));
    const approval = approveExtractionImprovementProposal({
      draft,
      approval: { id: "approval:fixture", actor: "producer", approvedAt: "2026-07-22T14:31:00.000Z", rationale: "Create revision.", evidenceIds: [] },
      nextTaskSpec: { version: "next", digest: sha("e"), exampleDigests: [...draft.lineage.taskSpec.exampleDigests, sha("f")] },
      rollbackTaskSpec: draft.lineage.taskSpec,
    });
    const rejectionInput = { draft, rejection: { id: "rejection:fixture", actor: "producer", rejectedAt: "2026-07-22T14:31:00.000Z", rationale: "Do not reuse.", evidenceIds: [] } };
    const rejection = rejectExtractionImprovementProposal(rejectionInput);
    assert.equal(approval.dispositionKey, rejection.dispositionKey);
    assert.deepEqual(rejection, rejectExtractionImprovementProposal(rejectionInput), "same rejection is idempotent");
    assert.notEqual(approval.id, rejection.id, "the shared key, not unrelated record ids, identifies the conflict");
  });

  it("requires task changes to match the explicit example and guidance remedies", () => {
    const guidanceDraft = buildExtractionImprovementProposal(fixture("rejected"));
    const base = {
      draft: guidanceDraft,
      approval: { id: "approval:fixture", actor: "producer", approvedAt: "2026-07-22T14:31:00.000Z", rationale: "Create revision.", evidenceIds: [] },
      nextTaskSpec: { version: "next", digest: sha("e"), exampleDigests: [...guidanceDraft.lineage.taskSpec.exampleDigests, sha("f")] },
      rollbackTaskSpec: guidanceDraft.lineage.taskSpec,
    };
    assert.throws(() => approveExtractionImprovementProposal(base), /guidanceChangeProofDigest/);
    assert.equal(approveExtractionImprovementProposal({ ...base, guidanceChangeProofDigest: sha("9") }).state, "approved");
    assert.throws(() => approveExtractionImprovementProposal({
      ...base, guidanceChangeProofDigest: sha("9"),
      nextTaskSpec: { ...base.nextTaskSpec, version: guidanceDraft.lineage.taskSpec.version },
    }), /new version/);

    const acceptedDraft = buildExtractionImprovementProposal(fixture("accepted"));
    assert.throws(() => approveExtractionImprovementProposal({
      ...base, draft: acceptedDraft, rollbackTaskSpec: acceptedDraft.lineage.taskSpec,
      nextTaskSpec: { version: "next", digest: sha("e"), exampleDigests: acceptedDraft.lineage.taskSpec.exampleDigests },
    }), /strict superset/);

    const malformed = structuredClone(acceptedDraft);
    if (malformed.diagnosis.kind === "accepted-extraction") malformed.diagnosis.requestedTaskChanges = [];
    assert.throws(() => approveExtractionImprovementProposal({
      ...base, draft: malformed, rollbackTaskSpec: malformed.lineage.taskSpec,
    }), /at least one explicit task change/);
  });

  it("accepts only canonical ISO timestamps", () => {
    const badCreatedAt = fixture();
    badCreatedAt.createdAt = "2026-07-22T14:30:00Z";
    assert.throws(() => buildExtractionImprovementProposal(badCreatedAt), /canonical ISO/);
    const badReviewedAt = fixture();
    badReviewedAt.reviewDecision.spec.reviewedAt = "2026-07-22T14:25:00Z";
    badReviewedAt.survey.reviewOutcomes[0]!.reviewedAt = "2026-07-22T14:25:00Z";
    assert.throws(() => buildExtractionImprovementProposal(badReviewedAt), /canonical ISO/);
    const draft = buildExtractionImprovementProposal(fixture("accepted"));
    assert.throws(() => approveExtractionImprovementProposal({
      draft,
      approval: { id: "approval:fixture", actor: "producer", approvedAt: "2026-07-22 14:31:00Z", rationale: "Create revision.", evidenceIds: [] },
      nextTaskSpec: { version: "next", digest: sha("e"), exampleDigests: [...draft.lineage.taskSpec.exampleDigests, sha("f")] },
      rollbackTaskSpec: draft.lineage.taskSpec,
    }), /canonical ISO/);
    assert.throws(() => rejectExtractionImprovementProposal({
      draft,
      rejection: { id: "rejection:fixture", actor: "producer", rejectedAt: "2026-07-22", rationale: "Reject.", evidenceIds: [] },
    }), /canonical ISO/);
  });
});
