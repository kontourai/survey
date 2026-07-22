import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createExtractionTaskSpec } from "@kontourai/traverse";
import {
  approveExtractionImprovementProposal,
  buildExtractionImprovementProposal,
  importExtractionEnvelope,
  type PortableExtractionResultEnvelope,
  type ReviewDecision,
  type SurveyInput,
} from "../src/index.js";

describe("extraction improvement proposal Traverse compatibility", () => {
  it("references a real next task and retains the byte-identical prior task as rollback", () => {
    const prior = createExtractionTaskSpec({
      version: "2026-07-01", targetSchema: [{ path: "status", type: "enum", enumValues: ["ACTIVE", "INACTIVE"] }],
      guidance: "Extract the status from the table row.",
      examples: [{ content: "Status: ACTIVE", proposals: [{ fieldPath: "status", candidateValue: "ACTIVE", excerpt: "ACTIVE" }] }],
    });
    const priorBytes = JSON.stringify(prior);
    const next = createExtractionTaskSpec({
      version: "2026-07-22", targetSchema: prior.targetSchema, guidance: "Extract the status only from the matching row.",
      examples: [...(prior.examples ?? []).map(({ digest: _digest, ...example }) => example), {
        content: "Status: INACTIVE", proposals: [{ fieldPath: "status", candidateValue: "INACTIVE", excerpt: "INACTIVE" }],
      }],
    });
    const artifactBinding = { format: "traverse-prepared-artifact", version: 1, digest: "d".repeat(64), preparationMode: "text", preparationVersion: "1", contentLength: 14, sourceSnapshotRef: "snapshot:fixture" } as const;
    const artifact = { ...artifactBinding, ref: `traverse-prepared-artifact:v1:sha256:${createHash("sha256").update(JSON.stringify(artifactBinding)).digest("hex")}` } as const;
    const envelope: PortableExtractionResultEnvelope = {
      format: "traverse-extraction-result", version: 1, source: { ref: "source:fixture", snapshotRef: "snapshot:fixture" },
      result: { proposals: [{ fieldPath: "status", candidateValue: "ACTIVE", confidence: 0.9, extractor: "fixture", provenance: { excerpt: "ACTIVE", locator: "chars:8-14", occurrence: { resolverVersion: "exact-occurrence-v1", count: 1, selected: { index: 0, start: 8, end: 14 }, selection: "source-order", hintUsed: false, ambiguous: false } } }], provider: "fixture", runId: "traverse-extraction-run:00000000-0000-4000-8000-000000000157", raw: {}, outcome: { status: "success" }, extractedAt: "2026-07-22T14:20:00.000Z", providerCalls: 1, totalTokensUsed: 1, taskDigest: prior.digest, exampleDigests: (prior.examples ?? []).map((example) => example.digest), preparedArtifact: artifact, preparedArtifactState: { status: "available", requestedRef: artifact.ref, canonicalRef: artifact.ref } },
    };
    const imported = importExtractionEnvelope(envelope, { importName: "import:fixture", producerNamespace: "producer:fixture", sourceKind: "api-record", claimTarget: () => ({ subjectType: "record", subjectId: "42", facet: "profile", claimType: "field", fieldOrBehavior: "status", impactLevel: "medium" }) });
    const reviewItem = imported.reviewItems[0]!, candidate = reviewItem.spec.candidates[0]!;
    const reviewDecision: ReviewDecision = { apiVersion: "survey.kontourai.io/v1alpha1", kind: "ReviewDecision", metadata: { name: "decision:fixture" }, spec: { reviewItemName: reviewItem.metadata.name, candidateId: candidate.id, status: "rejected", resolution: "rejected", actor: { id: "reviewer" }, reviewedAt: "2026-07-22T14:25:00.000Z", rationale: "Row was joined.", evidenceIds: ["evidence:1"], attemptEvidenceIds: ["attempt:1"], projection: { reviewOutcomeId: "outcome:1", candidateSetId: "set:1", candidateId: candidate.id } } };
    const survey: SurveyInput = { source: "fixture", generatedAt: "2026-07-22T14:26:00.000Z", rawSources: [], extractions: [], candidateSets: [], reviewOutcomes: [{ id: "outcome:1", candidateSetId: "set:1", candidateId: candidate.id, status: "rejected", resolution: "rejected", actor: "reviewer", reviewedAt: "2026-07-22T14:25:00.000Z", rationale: "Row was joined.", evidenceIds: ["evidence:1"], attemptEvidenceIds: ["attempt:1"] }], claims: [] };
    const draft = buildExtractionImprovementProposal({ createdAt: "2026-07-22T14:30:00.000Z", priorTaskSpecVersion: prior.version, extractionImport: imported.record, proposalIndex: 0, reviewItem, reviewDecision, survey, reviewOutcomeId: "outcome:1", diagnosis: { kind: "bad-extraction", requestedTaskChanges: ["example-addition", "guidance-update"] } });
    const request = approveExtractionImprovementProposal({
      draft, approval: { id: "approval:1", actor: "producer", approvedAt: "2026-07-22T14:31:00.000Z", rationale: "Create revision.", evidenceIds: [] },
      nextTaskSpec: { version: next.version, digest: next.digest, exampleDigests: (next.examples ?? []).map((example) => example.digest) },
      rollbackTaskSpec: { version: prior.version, digest: prior.digest, exampleDigests: (prior.examples ?? []).map((example) => example.digest) },
      guidanceChangeProofDigest: `sha256:${createHash("sha256").update("guidance-change:fixture").digest("hex")}`,
    });
    assert.equal(request.nextTaskSpec.digest, next.digest);
    assert.deepEqual(request.rollbackTaskSpec, draft.lineage.taskSpec);
    assert.equal(JSON.stringify(prior), priorBytes);
    assert.notEqual(next.digest, prior.digest);
  });
});
