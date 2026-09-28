/**
 * Import behavior for envelopes produced by Traverse's own serializer: typed
 * partial reasons with per-chunk coverage (#286), proposals without a proposer
 * confidence (#287), and proposals for one claim grouped into one candidate set
 * (#289). The fixtures under tests/fixtures/traverse-envelopes/ were generated
 * by `generate.mjs` in that directory from a real Traverse build; see its
 * header for how.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  buildCanonicalReviewedTrustInput,
  buildReviewItemsFromExtractionEnvelopeImport,
  buildSurveyLearningProjections,
  buildSurveyTrustBundle,
  exportExtractionEnvelopeImport,
  importExtractionEnvelope,
  reimportExtractionEnvelope,
  type ExtractionEnvelopeImportOptions,
  type PortableExtractionResultEnvelope,
  type ReviewDecision,
  type ReviewItem,
} from "../src/index.js";
import { deriveCalibration } from "../src/calibration.js";
import { toSurfaceReviewedExtractionImport } from "../src/surface-reviewed-extraction.js";
import { buildExtractionInspectorModel } from "../src/review-workbench/extraction-inspector.js";
import { buildReviewResultPresentation } from "../src/review-workbench/review-presentation.js";
import { buildReviewSessionEvents, candidateForDecision, keepActionDecision, reviewSessionSummary, type ReviewWorkbenchDecision } from "../src/review-workbench/review-queue-session.js";
import { createServerReviewSessionRecord, deriveServerReviewSessionApplyResult } from "../src/review-workbench/server-review-session.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewWorkbenchResultsFromSession,
  initialReviewQueueSessionState,
  mapReviewWorkbenchResultsToApplyActions,
  renderReviewWorkbenchHtml,
  type ReviewWorkbenchResult,
} from "../src/review-workbench/review-workbench.js";

const fixtureDir = new URL("../../tests/fixtures/traverse-envelopes/", import.meta.url);
async function traverseFixture(name: string): Promise<PortableExtractionResultEnvelope> {
  return JSON.parse(await readFile(new URL(`${name}.v1.json`, fixtureDir), "utf8")) as PortableExtractionResultEnvelope;
}
function options(overrides: Partial<ExtractionEnvelopeImportOptions> = {}): ExtractionEnvelopeImportOptions {
  return {
    importName: "vendor-import", producerNamespace: "fixture-producer", sourceKind: "uploaded-document",
    claimTarget: (proposal) => ({ subjectType: "vendor", subjectId: "vendor-1", facet: "vendor.contract", claimType: "vendor.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "medium" }),
    ...overrides,
  };
}
function producer(value: { producer?: Record<string, unknown> } | undefined): Record<string, unknown> {
  return value?.producer?.["survey.kontourai.io/extraction-envelope"] as Record<string, unknown>;
}
function acceptAll(items: readonly ReviewItem[]): ReviewWorkbenchResult[] {
  return buildReviewWorkbenchResultsFromSession({
    ...initialReviewQueueSessionState(items),
    actorId: "reviewer-1", reviewedAt: "2026-09-28T00:00:00.000Z",
    decisionsByItemName: Object.fromEntries(items.map((item) => [item.metadata.name, "accept-proposed" as const])),
  });
}
function project(items: readonly ReviewItem[], results: readonly ReviewWorkbenchResult[]) {
  const canonical = buildCanonicalReviewedTrustInput({ source: "fixture-producer", generatedAt: "2026-09-28T00:00:00.000Z", projectionContextId: "round-1", items, results });
  return { surveyInput: canonical.surveyInput, bundle: buildSurveyTrustBundle(canonical.surveyInput, { projectionContextId: canonical.projectionContextId }) };
}

describe("typed partial reasons and per-chunk coverage (#286)", () => {
  for (const [name, reason] of [
    ["partial-provider-failure", "provider-failure"],
    ["partial-content-truncated", "content-truncated"],
    ["partial-output-truncated", "output-truncated"],
    ["partial-unusable-answer", "provider-failure"],
  ] as const) {
    it(`imports a Traverse ${reason} envelope and carries the reason and coverage to the candidate`, async () => {
      const envelope = await traverseFixture(name);
      assert.deepEqual(envelope.result.outcome, { status: "partial", reason });
      assert.ok(envelope.result.coverage?.some((entry) => entry.status !== "complete"), "the fixture must report unread text");
      const imported = importExtractionEnvelope(envelope, options());
      assert.equal(imported.record.status.state, "grounded");
      assert.deepEqual(imported.record.spec.envelope, envelope);
      assert.equal(imported.reviewItems.length, 1);
      const metadata = producer(imported.reviewItems[0]!.spec.candidates[0]);
      assert.deepEqual(metadata.outcome, { status: "partial", reason });
      assert.deepEqual(metadata.partial, envelope.result.partial);
      assert.deepEqual(metadata.coverage, envelope.result.coverage);
      assert.deepEqual(reimportExtractionEnvelope(exportExtractionEnvelopeImport(imported.record)), imported.record);
    });
  }

  it("imports a missing-tool-call envelope: the lost chunk is recorded on the answered chunk's candidate", async () => {
    const envelope = await traverseFixture("partial-missing-tool-call");
    assert.deepEqual(envelope.result.coverage![1], { chunk: 2, start: 30, end: 70, status: "unread", reason: "missing-tool-call" });
    const imported = importExtractionEnvelope(envelope, options());
    assert.deepEqual(imported.reviewItems.map((item) => item.spec.candidates.map((candidate) => candidate.value)), [[48000]]);
    assert.deepEqual(producer(imported.reviewItems[0]!.spec.candidates[0]).coverage, envelope.result.coverage);
  });

  it("imports a failure with no usable answer as unresolved, with an extraction-failed diagnostic and no candidates", async () => {
    const envelope = await traverseFixture("failure-no-usable-answer");
    assert.deepEqual(envelope.result.outcome, { status: "failure", category: "provider", code: "no-usable-answer" });
    assert.ok(envelope.result.warningClassifications?.some((warning) => warning.code === "unusable-answer"));
    const imported = importExtractionEnvelope(envelope, options());
    assert.deepEqual(imported.reviewItems, []);
    assert.deepEqual(imported.record.status, { state: "unresolved", diagnostics: [{ kind: "extraction-failed", category: "provider", code: "no-usable-answer",
      message: "Extraction failed (provider/no-usable-answer); no text was read and answered, so the import has no candidates." }] });
    assert.deepEqual(reimportExtractionEnvelope(exportExtractionEnvelopeImport(imported.record)), imported.record);
    assert.deepEqual(imported.record.spec.envelope.result.outcome, envelope.result.outcome);
    assert.deepEqual(imported.record.spec.envelope.result.warningClassifications, envelope.result.warningClassifications);
  });

  it("a failed or proposal-less partial run never looks like an empty complete run, in the import or the inspector", async () => {
    const artifactFor = (envelope: PortableExtractionResultEnvelope, text: string) =>
      ({ status: "available" as const, text, actualDigest: envelope.result.preparedArtifact!.digest });
    const empty = await traverseFixture("success-empty");
    const failed = await traverseFixture("failure-no-usable-answer");
    const stopped = await traverseFixture("partial-max-chunks-empty");
    assert.deepEqual([empty, failed, stopped].map((envelope) => envelope.result.proposals.length), [0, 0, 0]);

    const emptyImport = importExtractionEnvelope(empty, options());
    const failedImport = importExtractionEnvelope(failed, options());
    const stoppedImport = importExtractionEnvelope(stopped, options());
    assert.deepEqual(emptyImport.record.status, { state: "grounded", diagnostics: [] });
    assert.equal(failedImport.record.status.state, "unresolved");
    assert.deepEqual(stoppedImport.record.status, { state: "unresolved", diagnostics: [{ kind: "extraction-incomplete", reason: "max-chunks",
      message: "Extraction stopped short (max-chunks) without proposing any value; unread text may hold values." }] });

    const emptySource = buildExtractionInspectorModel({ importResult: emptyImport, artifact: artifactFor(empty, "Fee: 5.") }).sources[0]!;
    const failedSource = buildExtractionInspectorModel({ importResult: failedImport, artifact: artifactFor(failed, "Fee: 5.") }).sources[0]!;
    assert.equal(emptySource.alignment, "aligned");
    assert.equal(emptySource.extractionDiagnostic, undefined);
    assert.match(emptySource.message, /^Prepared artifact identity verified/);
    assert.equal(failedSource.alignment, "aligned", "the artifact itself still resolves");
    assert.deepEqual(failedSource.extractionDiagnostic, failedImport.record.status.diagnostics[0]);
    assert.match(failedSource.message, /^Extraction failed \(provider\/no-usable-answer\)/);
    assert.notEqual(failedSource.message, emptySource.message);
  });

  it("keeps a partial run that proposed values grounded, with its reason on the candidates", async () => {
    const imported = importExtractionEnvelope(await traverseFixture("partial-max-chunks"), options());
    assert.deepEqual(imported.record.status, { state: "grounded", diagnostics: [] });
    assert.deepEqual(producer(imported.reviewItems[0]!.spec.candidates[0]).outcome, { status: "partial", reason: "max-chunks" });
  });

  it("accepts a failure that carries unread coverage, while a success still may not", async () => {
    const failure = await traverseFixture("failure-no-usable-answer");
    failure.result.coverage = [{ chunk: 1, start: 0, end: failure.result.preparedArtifact!.contentLength, status: "unread", reason: "provider-failure" }];
    const imported = importExtractionEnvelope(failure, options());
    assert.deepEqual(imported.reviewItems, []);
    assert.deepEqual(imported.record.spec.envelope.result.coverage, failure.result.coverage);
    const success = structuredClone(failure);
    success.result.outcome = { status: "success" };
    assert.throws(() => importExtractionEnvelope(success, options()), /outcome is success/);
  });

  it("imports a partial run whose answered chunk dropped malformed tool items, and carries the warning", async () => {
    const envelope = await traverseFixture("partial-malformed-tool-items");
    assert.ok(envelope.result.warningClassifications?.some((warning) => warning.category === "normalization" && warning.code === "malformed-tool-items"));
    const imported = importExtractionEnvelope(envelope, options());
    assert.deepEqual(producer(imported.reviewItems[0]!.spec.candidates[0]).warnings, envelope.result.warningClassifications);
  });

  it("accepts coverage whose chunk ranges overlap by the chunk overlap", async () => {
    const envelope = await traverseFixture("partial-provider-failure");
    const [first, second, third] = envelope.result.coverage!;
    assert.ok(first!.end > second!.start && second!.end > third!.start, "the fixture ranges must overlap");
    assert.doesNotThrow(() => importExtractionEnvelope(envelope, options()));
  });

  it("accepts coverage on an early stop and on a success whose ranges are all complete", async () => {
    const early = await traverseFixture("partial-max-chunks");
    assert.equal(early.result.coverage?.at(-1)?.reason, "not-dispatched");
    assert.doesNotThrow(() => importExtractionEnvelope(early, options()));
    const success = await traverseFixture("success-no-confidence");
    success.result.coverage = [{ chunk: 1, start: 0, end: success.result.preparedArtifact!.contentLength, status: "complete" }];
    assert.doesNotThrow(() => importExtractionEnvelope(success, options()));
  });

  it("rejects malformed coverage", async () => {
    const cases: Array<[string, (envelope: PortableExtractionResultEnvelope) => void, RegExp]> = [
      ["past contentLength", (e) => { e.result.coverage![2]!.end = e.result.preparedArtifact!.contentLength + 1; }, /exceeds the prepared artifact contentLength/],
      ["reversed", (e) => { e.result.coverage![0]!.start = 41; }, /start < end/],
      ["empty", (e) => { e.result.coverage![0]!.end = e.result.coverage![0]!.start; }, /start < end/],
      ["unordered", (e) => { e.result.coverage!.reverse(); }, /ordered by start/],
      ["unread without reason", (e) => { delete e.result.coverage![1]!.reason; }, /reason is required exactly when status is unread/],
      ["reason on a complete range", (e) => { e.result.coverage![0]!.reason = "provider-failure"; }, /reason is required exactly when status is unread/],
      ["unknown status", (e) => { (e.result.coverage![0] as { status: string }).status = "skipped"; }, /status is invalid/],
      ["unknown reason", (e) => { (e.result.coverage![1] as { reason: string }).reason = "gone"; }, /reason is invalid/],
      ["chunk zero", (e) => { e.result.coverage![0]!.chunk = 0; }, /chunk must be positive/],
      ["extra key", (e) => { (e.result.coverage![0] as unknown as Record<string, unknown>).note = "x"; }, /coverage\[0\]\.note is unexpected/],
      ["no prepared artifact", (e) => { delete e.result.preparedArtifact; }, /coverage requires result\.preparedArtifact/],
    ];
    for (const [label, mutate, expected] of cases) {
      const envelope = await traverseFixture("partial-provider-failure");
      mutate(envelope);
      assert.throws(() => importExtractionEnvelope(envelope, options()), expected, label);
    }
  });

  it("rejects a loss reason whose coverage reports nothing lost, or no coverage at all", async () => {
    const allComplete = await traverseFixture("partial-provider-failure");
    allComplete.result.coverage = allComplete.result.coverage!.map(({ chunk, start, end }) => ({ chunk, start, end, status: "complete" as const }));
    assert.throws(() => importExtractionEnvelope(allComplete, options()), /partial reason provider-failure requires a result\.coverage entry/);
    const missing = await traverseFixture("partial-content-truncated");
    delete missing.result.coverage;
    assert.throws(() => importExtractionEnvelope(missing, options()), /partial reason content-truncated requires/);
  });

  it("rejects a loss reason whose only lost range was never dispatched", async () => {
    const envelope = await traverseFixture("partial-max-chunks");
    (envelope.result.outcome as { reason: string }).reason = "provider-failure";
    envelope.result.partial = { reason: "provider-failure", completedChunks: 1, remainingChunks: 0 };
    assert.throws(() => importExtractionEnvelope(envelope, options()), /requires a result\.coverage entry for a dispatched chunk/);
  });

  it("imports a bundled adapter's unusable tool input and the new warning codes", async () => {
    const envelope = await traverseFixture("partial-unusable-tool-input");
    assert.deepEqual(envelope.result.coverage![1], { chunk: 2, start: 30, end: 70, status: "unread", reason: "provider-failure" });
    assert.ok(envelope.result.warningClassifications?.some((warning) => warning.category === "provider" && warning.code === "unusable-answer"));
    const imported = importExtractionEnvelope(envelope, options());
    assert.deepEqual(imported.reviewItems.map((item) => item.spec.candidates.map((candidate) => candidate.value)), [[48000]]);
    assert.deepEqual(imported.record.spec.envelope.result.warningClassifications, envelope.result.warningClassifications);
    const normalization = await traverseFixture("partial-unusable-answer");
    normalization.result.warningClassifications = [...normalization.result.warningClassifications!, { category: "normalization", code: "proposal-normalization" }];
    assert.deepEqual(producer(importExtractionEnvelope(normalization, options()).reviewItems[0]!.spec.candidates[0]).warnings, normalization.result.warningClassifications);
  });

  it("rejects a success outcome whose coverage names unread text", async () => {
    const envelope = await traverseFixture("success-no-confidence");
    envelope.result.coverage = [{ chunk: 1, start: 0, end: 5, status: "unread", reason: "provider-failure" }];
    assert.throws(() => importExtractionEnvelope(envelope, options()), /outcome is success/);
  });

  it("still rejects a partial reason outside the vocabulary", async () => {
    const envelope = await traverseFixture("partial-provider-failure");
    (envelope.result.outcome as { reason: string }).reason = "other";
    (envelope.result.partial as { reason: string }).reason = "other";
    assert.throws(() => importExtractionEnvelope(envelope, options()), /partial reason is invalid/);
  });

  it("imports an HTML page whose chrome was removed, keeping the article's own header value", async () => {
    const envelope = await traverseFixture("success-html-page-chrome");
    assert.deepEqual(envelope.result.warningClassifications, [{ category: "preparation", code: "navigation-pruned" }]);
    const imported = importExtractionEnvelope(envelope, options());
    assert.deepEqual(imported.reviewItems.map((item) => item.spec.candidates.map((candidate) => candidate.value)), [[48000]]);
    assert.deepEqual(producer(imported.reviewItems[0]!.spec.candidates[0]).warnings, [{ category: "preparation", code: "navigation-pruned" }]);
  });

  it("imports the navigation-pruned preparation warning and carries it", async () => {
    const envelope = await traverseFixture("success-navigation-pruned");
    const imported = importExtractionEnvelope(envelope, options());
    assert.deepEqual(producer(imported.reviewItems[0]!.spec.candidates[0]).warnings, [{ category: "preparation", code: "navigation-pruned" }]);
  });
});

describe("proposals without a proposer confidence (#287)", () => {
  it("imports a proposal with no confidence and never substitutes one", async () => {
    const envelope = await traverseFixture("success-no-confidence");
    assert.equal(Object.hasOwn(envelope.result.proposals[0]!, "confidence"), false);
    const { reviewItems } = importExtractionEnvelope(envelope, options());
    const candidate = reviewItems[0]!.spec.candidates[0]!;
    assert.equal(Object.hasOwn(candidate, "confidence"), false);
    assert.equal(Object.hasOwn(candidate.extraction, "confidence"), false);
  });

  it("still validates a confidence that is present", async () => {
    for (const bad of [1.2, -0.1, null, "0.5"]) {
      const envelope = await traverseFixture("success-no-confidence");
      (envelope.result.proposals[0] as unknown as Record<string, unknown>).confidence = bad;
      assert.throws(() => importExtractionEnvelope(envelope, options()), /proposal\.confidence is invalid/, String(bad));
    }
    const valid = await traverseFixture("success-no-confidence");
    valid.result.proposals[0]!.confidence = 0.4;
    assert.equal(importExtractionEnvelope(valid, options()).reviewItems[0]!.spec.candidates[0]!.confidence, 0.4);
  });

  it("projects through the canonical path with no extraction confidence, and calibration skips it", async () => {
    const { reviewItems } = importExtractionEnvelope(await traverseFixture("success-no-confidence"), options());
    const { surveyInput, bundle } = project(reviewItems, acceptAll(reviewItems));
    const claims = JSON.parse(JSON.stringify(bundle.claims)) as Array<{ status: string; value: unknown; confidenceBasis?: Record<string, unknown> }>;
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.status, "verified");
    assert.equal(claims[0]!.value, 48000);
    assert.equal(Object.hasOwn(claims[0]!.confidenceBasis ?? {}, "extractionConfidence"), false);
    assert.equal(Object.hasOwn(surveyInput.extractions[0]!, "confidence"), false);
    const calibration = deriveCalibration(surveyInput);
    assert.equal(calibration.skippedCount, 1);
    assert.equal(calibration.sampleCount, 0);
  });

  it("refuses by name to hand a record without confidence to Surface's reviewed-extraction profile", async () => {
    const { record } = importExtractionEnvelope(await traverseFixture("success-no-confidence"), options());
    assert.throws(() => toSurfaceReviewedExtractionImport(record), /requires a proposer confidence on every proposal; proposal 0 of vendor-import reports none/);
    const reported = importExtractionEnvelope(await traverseFixture("success-conflicting-fee"), options()).record;
    assert.equal(toSurfaceReviewedExtractionImport(reported), reported);
  });
});

describe("one candidate set per claim slot (#289)", () => {
  it("groups conflicting values for one field into one conflict item", async () => {
    const envelope = await traverseFixture("success-conflicting-fee");
    assert.deepEqual(envelope.result.proposals.map((p) => [p.fieldPath, p.candidateValue, p.provenance.locator]), [
      ["fee", 48000, "chars:5-10"], ["fee", 48000, "chars:34-39"], ["fee", 52000, "chars:54-59"],
    ]);
    const { reviewItems } = importExtractionEnvelope(envelope, options());
    assert.equal(reviewItems.length, 1);
    const item = reviewItems[0]!;
    assert.equal(item.spec.candidateSetStatus, "conflict");
    assert.deepEqual(item.spec.candidates.map((candidate) => candidate.value), [48000, 52000]);
    assert.deepEqual(item.spec.candidates.map((candidate) => candidate.locator?.locator), ["chars:5-10", "chars:54-59"]);
    assert.deepEqual(producer(item.metadata).proposalIndices, [0, 1, 2]);
    const agreeing = producer(item.spec.candidates[0]).sameValueProposals as Array<Record<string, unknown>>;
    assert.deepEqual(agreeing.map(({ proposalIndex, locator, excerpt }) => ({ proposalIndex, locator, excerpt })), [{ proposalIndex: 1, locator: "chars:34-39", excerpt: "48000" }]);
    assert.equal(item.status?.observedCandidateCount, 2);
  });

  it("gives one candidate carrying every locator when the values agree", async () => {
    const envelope = await traverseFixture("success-conflicting-fee");
    envelope.result.proposals.pop();
    const { reviewItems } = importExtractionEnvelope(envelope, options());
    assert.equal(reviewItems.length, 1);
    assert.equal(reviewItems[0]!.spec.candidateSetStatus, "needs-review");
    assert.equal(reviewItems[0]!.spec.candidates.length, 1);
    const candidate = reviewItems[0]!.spec.candidates[0]!;
    assert.deepEqual([candidate.locator?.locator, ...(producer(candidate).sameValueProposals as Array<{ locator: string }>).map((entry) => entry.locator)], ["chars:5-10", "chars:34-39"]);
    // Accepting it projects exactly one verified claim.
    const { bundle } = project(reviewItems, acceptAll(reviewItems));
    assert.deepEqual(bundle.claims.map((claim) => [claim.subjectId, claim.fieldOrBehavior, claim.value, claim.status]), [["vendor-1", "fee", 48000, "verified"]]);
  });

  it("keeps array items (distinct pathIndices) and distinct claim ids as separate items", async () => {
    const indexed = await traverseFixture("success-navigation-pruned");
    assert.deepEqual(indexed.result.proposals.map((p) => p.pathIndices), [[0], [1], [2], [3]]);
    const byIndex = importExtractionEnvelope(indexed, options()).reviewItems;
    assert.equal(byIndex.length, 4);
    assert.ok(byIndex.every((item) => item.spec.candidates.length === 1 && item.spec.candidateSetStatus === "needs-review"));

    const conflicting = await traverseFixture("success-conflicting-fee");
    const declared = importExtractionEnvelope(conflicting, options({
      claimTarget: (proposal, index) => ({ claimId: `vendor-1.fee.${index}`, subjectType: "vendor", subjectId: "vendor-1", facet: "vendor.contract", claimType: "vendor.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "medium" }),
    })).reviewItems;
    assert.equal(declared.length, 3);
  });

  it("groups by the claim a proposal maps to, not by its field path", async () => {
    const envelope = await traverseFixture("success-conflicting-fee");
    envelope.result.proposals[2]!.fieldPath = "amendedFee";
    const sameClaim = importExtractionEnvelope(envelope, options({
      claimTarget: () => ({ subjectType: "vendor", subjectId: "vendor-1", facet: "vendor.contract", claimType: "vendor.field", fieldOrBehavior: "fee", impactLevel: "medium" }),
    })).reviewItems;
    assert.equal(sameClaim.length, 1);
    assert.equal(sameClaim[0]!.spec.candidateSetStatus, "conflict");
    const ownClaim = importExtractionEnvelope(envelope, options()).reviewItems;
    assert.deepEqual(ownClaim.map((item) => [item.spec.target, item.spec.candidateSetStatus]), [["fee", "needs-review"], ["amendedFee", "needs-review"]]);
  });

  it("refuses proposals that map to one claim with different claim targets", async () => {
    const envelope = await traverseFixture("success-conflicting-fee");
    assert.throws(() => importExtractionEnvelope(envelope, options({
      claimTarget: (proposal, index) => ({ subjectType: "vendor", subjectId: "vendor-1", facet: "vendor.contract", claimType: "vendor.field", fieldOrBehavior: proposal.fieldPath, impactLevel: index === 2 ? "high" : "medium" }),
    })), /Proposals 0 and 2 map to the same claim with different claim targets/);
  });

  it("cannot verify both conflicting values: the queue refuses to pick, and a pick projects one claim", async () => {
    const { reviewItems } = importExtractionEnvelope(await traverseFixture("success-conflicting-fee"), options());
    const item = reviewItems[0]!;
    // The workbench decides by role; with two proposed values it must not
    // choose one for the reviewer.
    assert.throws(() => candidateForDecision(item, "accept-proposed"), /has 2 proposed candidates; the accept-proposed decision cannot choose between them/);
    assert.throws(() => acceptAll(reviewItems), /cannot choose between them/);
    // Decisions that trust no value stay available.
    assert.equal(keepActionDecision(item, false), "reject-proposed");
    assert.equal(keepActionDecision(item, true), "reject-proposed");
    assert.equal(candidateForDecision(item, "reject-proposed").id, item.spec.candidates[0]!.id);
    assert.equal(candidateForDecision(item, "could-not-confirm").id, item.spec.candidates[0]!.id);
    const html = renderReviewWorkbenchHtml(initialReviewQueueSessionState(reviewItems));
    assert.match(html, /data-testid="conflicting-proposals"/);
    assert.equal((html.match(/data-testid="conflicting-value"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /data-testid="use-proposed"/);
    assert.match(html, /data-testid="keep-current"[^>]*>Reject all values</);
    assert.match(html, /data-testid="could-not-confirm"/);
    assert.match(html, /data-testid="field-chip">Conflict: 2 values</);

    // A result that selects the second value (as a value-level selection would)
    // projects one claim for the slot, verified with that value only.
    const [first, second] = item.spec.candidates;
    const result: ReviewWorkbenchResult = {
      reviewItemName: item.metadata.name, decision: "accept-proposed",
      selectedCandidate: second!, selectedCandidateId: second!.id, selectedCandidateRole: "proposed",
      selectedValue: second!.value, selectedDisplayValue: "52000", effectiveValue: second!.value, effectiveDisplayValue: "52000",
      unselectedCandidates: [first!], status: "verified", rationale: "Amendment supersedes the schedule.",
      reviewDecision: { apiVersion: "survey.kontourai.io/v1alpha1", kind: "ReviewDecision", metadata: { name: `${item.metadata.name}-accept-proposed` },
        spec: { reviewItemName: item.metadata.name, candidateId: second!.id, status: "verified", actor: { id: "reviewer-1" }, reviewedAt: "2026-09-28T00:00:00.000Z", rationale: "Amendment supersedes the schedule." } },
    };
    const { bundle } = project(reviewItems, [result]);
    const feeClaims = bundle.claims.filter((claim) => claim.subjectId === "vendor-1" && claim.fieldOrBehavior === "fee");
    assert.deepEqual(feeClaims.map((claim) => [claim.value, claim.status]), [[52000, "verified"]]);
  });

  for (const [decision, conflictStatus] of [["could-not-confirm", "disputed"], ["reject-proposed", "rejected"]] as const) {
    it(`a conflict decided ${decision} resolves the round: the sibling verifies, no conflicting value does`, async () => {
      const { items, conflict, sibling } = await conflictRound();
      const session = decidedSession(items, { [conflict.metadata.name]: decision, [sibling.metadata.name]: "accept-proposed" }, conflict.metadata.name);
      assert.equal(reviewSessionSummary(session).unresolved, 0);
      const results = buildReviewWorkbenchResultsFromSession(session);
      const conflictResult = results.find((result) => result.reviewItemName === conflict.metadata.name)!;
      for (const key of ["selectedCandidate", "selectedCandidateId", "selectedCandidateRole", "selectedValue", "selectedDisplayValue", "effectiveValue", "effectiveDisplayValue"]) {
        assert.equal(Object.hasOwn(conflictResult, key), false, key);
      }
      assert.deepEqual(conflictResult.unselectedCandidates.map((candidate) => candidate.id), conflict.spec.candidates.map((candidate) => candidate.id));
      for (const extra of [{ selectedDisplayValue: "48000" }, { effectiveDisplayValue: "48000" }]) {
        assert.throws(() => project(items, results.map((result) => (result === conflictResult ? { ...result, ...extra } : result))), /names a selected value/, JSON.stringify(extra));
      }
      const presentation = buildReviewResultPresentation(conflictResult, conflict);
      assert.equal(presentation.selectedValueText, undefined);
      assert.equal(presentation.applyMeaning, decision === "reject-proposed"
        ? "Saved decision rejects every proposed value; none is applied"
        : "Saved decision records that no proposed value could be confirmed; none is applied");
      assert.deepEqual(presentation.traceRefs.map((ref) => [ref.label, ref.value]), [
        ["Survey ReviewItem", conflict.metadata.name],
        ...conflict.spec.candidates.map((candidate) => [decision === "reject-proposed" ? "Rejected candidate" : "Unconfirmed candidate", candidate.id]),
      ]);
      const actions = mapReviewWorkbenchResultsToApplyActions({ results, items, map: (context) => context.selectedCandidate.id });
      assert.deepEqual(actions.map((action) => action.result.reviewItemName), [sibling.metadata.name]);
      const projected = project(items, results);
      assertConflictRoundProjection(projected.bundle, conflictStatus);
      assertNoValueSingledOut({ conflict, decision, projected, decisions: results.map((result) => result.reviewDecision), events: buildReviewSessionEvents(session, "round-1") });
    });

    it(`the server apply boundary accepts a conflict decided ${decision} with every item required`, async () => {
      const { items, conflict, sibling } = await conflictRound();
      const snapshot = { ...initialReviewQueueSessionState(items), actorId: "reviewer-1", reviewedAt: "2026-09-28T00:00:00.000Z" };
      const events = buildReviewSessionEvents(decidedSession(items, { [conflict.metadata.name]: decision, [sibling.metadata.name]: "accept-proposed" }, conflict.metadata.name), "round-1");
      const record = createServerReviewSessionRecord({ sessionName: "round-1", snapshot, eventCount: events.length, updatedAt: "2026-09-28T00:00:00.000Z" });
      const applied = deriveServerReviewSessionApplyResult({ record, events, requiredResolvedItems: "all" });
      assert.equal(applied.ok, true, JSON.stringify(applied.issues));
      if (!applied.ok) return;
      const projected = project(items, applied.results);
      assertConflictRoundProjection(projected.bundle, conflictStatus);
      assertNoValueSingledOut({ conflict, decision, projected, decisions: applied.decisions, events });
    });
  }

  it("refuses a candidate-level review on a claim that names no candidate of a multi-candidate set", () => {
    const at = "2026-09-28T00:00:00.000Z";
    const input = {
      contractVersion: "1", source: "p", generatedAt: at,
      rawSources: [{ id: "rs", kind: "uploaded-document" as const, sourceRef: "doc", observedAt: at, locatorScheme: "page" as const, checksum: "sha256:x" }],
      extractions: [{ id: "ex", sourceId: "rs", extractor: "e", target: "fee", locator: "p1", extractedAt: at }],
      candidateSets: [{ id: "cs", target: "fee", status: "needs-review" as const, candidates: [{ id: "a", extractionId: "ex", value: 1 }, { id: "b", extractionId: "ex", value: 2 }] }],
      claims: [{ id: "c", candidateSetId: "cs", subjectType: "s", subjectId: "1", facet: "f", claimType: "t", fieldOrBehavior: "fee", impactLevel: "low" as const, collectedBy: "p" }],
      reviewOutcomes: [{ id: "ro", candidateSetId: "cs", candidateId: "a", status: "verified" as const, actor: "r", reviewedAt: at }],
    } as unknown as Parameters<typeof buildSurveyTrustBundle>[0];
    assert.throws(() => buildSurveyTrustBundle(input), /Claim c names no candidate of set cs, but review ro is about candidate a: a candidate-level review needs a selectedCandidateId on the set or a candidateId on the claim/);
  });

  it("could-not-confirm on an escalated item that is not a conflict projects disputed", async () => {
    const [imported] = importExtractionEnvelope(await traverseFixture("success-no-confidence"), options()).reviewItems;
    const escalated: ReviewItem = { ...imported!, spec: { ...imported!.spec, candidateSetStatus: "escalated" } };
    const session = decidedSession([escalated], { [escalated.metadata.name]: "could-not-confirm" }, escalated.metadata.name);
    const { bundle } = project([escalated], buildReviewWorkbenchResultsFromSession(session));
    assert.deepEqual(bundle.claims.map((claim) => [claim.value, claim.status]), [[48000, "disputed"]]);
  });

  it("the MCP card shows every conflicting value; accept is refused and reject is recorded", async () => {
    const { items, conflict } = await conflictRound();
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-conflict-mcp-"));
    const sessionPath = join(tmpDir, "session.json");
    const snapshot = { ...initialReviewQueueSessionState(items), actorId: "reviewer-1", reviewedAt: "2026-09-28T00:00:00.000Z" };
    await writeFile(sessionPath, JSON.stringify({
      session: { apiVersion: "survey.kontourai.io/v1alpha1", kind: "ReviewSession", metadata: { name: "mcp-review-session" },
        spec: { reviewItemNames: items.map((item) => item.metadata.name), actor: { id: "reviewer-1" }, startedAt: "2026-09-28T00:00:00.000Z" },
        status: { activeItemName: conflict.metadata.name, eventCount: 0, decisionCount: 0 } },
      snapshot, events: [],
    }));
    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], { stdio: ["pipe", "pipe", "inherit"] });
    const call = rpc(server);
    try {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const detail = await call("tools/call", { name: "survey_review_item", arguments: { itemName: conflict.metadata.name } });
      const content = detail.result.content as Array<{ type: string; text?: string; resource?: { text?: string } }>;
      const text = content.find((entry) => entry.type === "text")?.text ?? "";
      assert.match(text, /Conflict: 2 proposed values/);
      assert.match(text, /Proposed value: 48000[\s\S]*Proposed value: 52000/);
      const html = content.find((entry) => entry.type === "resource")?.resource?.text ?? "";
      assert.match(html, /Conflict: 2 values/);
      assert.match(html, /48000[\s\S]*52000/);
      assert.doesNotMatch(html, /id="btn-accept"/);
      assert.doesNotMatch(html, /id="btn-hold"/, "no current value to keep");
      assert.match(html, /Reject all values/);

      const accept = await call("tools/call", { name: "survey_review_decide", arguments: { itemName: conflict.metadata.name, decision: "accept" } });
      assert.equal(accept.result.isError, true);
      assert.match((accept.result.content as Array<{ text: string }>)[0]!.text, /cannot choose between them/);
      const reject = await call("tools/call", { name: "survey_review_decide", arguments: { itemName: conflict.metadata.name, decision: "reject", note: "Schedule and amendment disagree." } });
      assert.equal(reject.result.isError, false, JSON.stringify(reject.result.content));
      assert.match((reject.result.content as Array<{ text: string }>)[0]!.text, /^Decision recorded: Reject all values\nEffect: Every proposed value is rejected/);
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps the extraction inspector bound to every proposal of a grouped item", async () => {
    const importResult = importExtractionEnvelope(await traverseFixture("success-conflicting-fee"), options());
    const model = buildExtractionInspectorModel({ importResult, artifact: { status: "unavailable", code: "not-found" } });
    assert.deepEqual(model.candidates.map((candidate) => [candidate.proposalIndex, candidate.reviewItemName]),
      [0, 1, 2].map((index) => [index, importResult.reviewItems[0]!.metadata.name]));
    assert.deepEqual(buildReviewItemsFromExtractionEnvelopeImport(importResult.record), importResult.reviewItems);
  });
});

/**
 * One envelope with a conflicting `fee` item (48000 vs 52000) and an ordinary
 * sibling item (`annualFee`, the second 48000 span re-labelled).
 */
async function conflictRound() {
  const envelope = await traverseFixture("success-conflicting-fee");
  envelope.result.proposals[1]!.fieldPath = "annualFee";
  const items = importExtractionEnvelope(envelope, options()).reviewItems;
  const conflict = items.find((item) => item.spec.candidateSetStatus === "conflict")!;
  const sibling = items.find((item) => item.spec.target === "annualFee")!;
  assert.equal(items.length, 2);
  return { items, conflict, sibling };
}

function decidedSession(items: readonly ReviewItem[], decisions: Record<string, ReviewWorkbenchDecision>, noteFor: string) {
  return {
    ...initialReviewQueueSessionState(items), actorId: "reviewer-1", reviewedAt: "2026-09-28T00:00:00.000Z",
    decisionsByItemName: decisions, notesByItemName: { [noteFor]: "The schedule and the amendment disagree." },
  };
}

function assertConflictRoundProjection(bundle: ReturnType<typeof project>["bundle"], conflictStatus: string): void {
  const claims = bundle.claims.map((claim) => [claim.fieldOrBehavior, claim.value, claim.status]);
  assert.deepEqual(claims.filter(([field]) => field === "annualFee"), [["annualFee", 48000, "verified"]]);
  const feeClaims = claims.filter(([field]) => field === "fee");
  assert.equal(feeClaims.length, 1);
  assert.equal(feeClaims[0]![2], conflictStatus);
}

/**
 * After reject-all or could-not-confirm on a conflict, no emitted record may
 * single out one of its values: no candidate id on the decision, its session
 * events, the review outcome or the claim; no selection on the set; a null
 * claim value that lists every value; one evidence record per candidate; and,
 * for reject-all, one rejected-candidate learning per candidate.
 */
function assertNoValueSingledOut(input: {
  conflict: ReviewItem;
  decision: "could-not-confirm" | "reject-proposed";
  projected: ReturnType<typeof project>;
  decisions: readonly ReviewDecision[];
  events: readonly { spec: { reviewItemName?: string; eventType: string; candidateId?: string } }[];
}): void {
  const { conflict, decision, projected: { surveyInput, bundle } } = input;
  const ids = conflict.spec.candidates.map((candidate) => candidate.id);
  const values = conflict.spec.candidates.map((candidate) => candidate.value);
  assert.deepEqual(values, [48000, 52000]);

  const reviewDecision = input.decisions.find((entry) => entry.spec.reviewItemName === conflict.metadata.name)!;
  assert.equal(Object.hasOwn(reviewDecision.spec, "candidateId"), false, "decision");
  const prompt = (reviewDecision.spec.authorizing as { renderedPrompt?: string } | undefined)?.renderedPrompt ?? "";
  assert.match(prompt, /2 different values were proposed: 48000, 52000\./, "rendered prompt");
  assert.match(prompt, decision === "reject-proposed" ? /Selected decision: Reject all values\.$/ : /Selected decision: Could not confirm\.$/);
  const decisionEvents = input.events.filter((event) => event.spec.reviewItemName === conflict.metadata.name && event.spec.eventType.startsWith("decision-"));
  assert.ok(decisionEvents.length > 0);
  for (const event of decisionEvents) assert.equal(Object.hasOwn(event.spec, "candidateId"), false, "session event");

  const set = surveyInput.candidateSets.find((candidateSet) => candidateSet.candidates.some((candidate) => ids.includes(candidate.id)))!;
  assert.equal(Object.hasOwn(set, "selectedCandidateId"), false, "candidate set");
  assert.equal(set.status, decision === "reject-proposed" ? "rejected" : "conflict");
  const outcome = surveyInput.reviewOutcomes.find((review) => review.candidateSetId === set.id)!;
  assert.equal(Object.hasOwn(outcome, "candidateId"), false, "review outcome");
  assert.equal((outcome.authorizing as { renderedPrompt?: string } | undefined)?.renderedPrompt, prompt, "review outcome prompt");
  const target = surveyInput.claims.find((claim) => claim.candidateSetId === set.id)!;
  assert.equal(Object.hasOwn(target, "candidateId"), false, "claim target");
  assert.equal(target.value, null);
  assert.deepEqual(set.candidates.map((candidate) => Object.hasOwn(candidate, "rejectionReason")), decision === "reject-proposed" ? [true, true] : [false, false]);

  const claim = bundle.claims.find((entry) => entry.id === target.id)!;
  assert.equal(claim.value, null);
  const listed = (claim.metadata?.survey as { candidates: Array<{ candidateId: string; value: unknown }> }).candidates;
  assert.deepEqual(listed.map((entry) => [entry.candidateId, entry.value]), ids.map((id, index) => [id, values[index]]));
  assert.deepEqual(bundle.evidence.filter((entry) => entry.claimId === claim.id).map((entry) => entry.metadata?.candidateId), ids);
  const event = bundle.events.find((entry) => entry.claimId === claim.id)!;
  assert.equal(event.evidenceIds.length, ids.length);

  const learning = buildSurveyLearningProjections(surveyInput).filter((entry) => entry.target === set.target);
  const rejected = learning.filter((entry) => entry.kind === "learning.rejected-candidate");
  assert.deepEqual(rejected.map((entry) => entry.id.endsWith(".learning.rejected-candidate") && ids.find((id) => entry.id.includes(id))).sort(),
    decision === "reject-proposed" ? [...ids].sort() : []);
  assert.equal(learning.filter((entry) => entry.kind === "learning.could-not-confirm").length, decision === "could-not-confirm" ? 1 : 0);
}

function rpc(server: ReturnType<typeof spawn>) {
  const pending = new Map<number, (message: { result: Record<string, unknown> }) => void>();
  createInterface({ input: server.stdout! }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as { id?: number; result: Record<string, unknown> };
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let id = 0;
  return (method: string, params: unknown) => new Promise<{ result: Record<string, unknown> }>((resolve, reject) => {
    id += 1;
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 15_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
