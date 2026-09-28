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
  buildSurveyTrustBundle,
  exportExtractionEnvelopeImport,
  importExtractionEnvelope,
  reimportExtractionEnvelope,
  type ExtractionEnvelopeImportOptions,
  type PortableExtractionResultEnvelope,
  type ReviewItem,
} from "../src/index.js";
import { deriveCalibration } from "../src/calibration.js";
import { toSurfaceReviewedExtractionImport } from "../src/surface-reviewed-extraction.js";
import { buildExtractionInspectorModel } from "../src/review-workbench/extraction-inspector.js";
import { candidateForDecision, keepActionDecision } from "../src/review-workbench/review-queue-session.js";
import {
  buildReviewWorkbenchResultsFromSession,
  initialReviewQueueSessionState,
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

  it("imports a missing-tool-call envelope: the loss is recorded and no candidate is invented", async () => {
    const envelope = await traverseFixture("partial-missing-tool-call");
    assert.deepEqual(envelope.result.coverage, [{ chunk: 1, start: 0, end: 7, status: "unread", reason: "missing-tool-call" }]);
    const imported = importExtractionEnvelope(envelope, options());
    assert.deepEqual(imported.reviewItems, []);
    assert.deepEqual(imported.record.spec.envelope.result.coverage, envelope.result.coverage);
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
    assert.equal(keepActionDecision(item, false), undefined);
    assert.equal(keepActionDecision(item, true), undefined);
    const html = renderReviewWorkbenchHtml(initialReviewQueueSessionState(reviewItems));
    assert.match(html, /data-testid="conflicting-proposals"/);
    assert.equal((html.match(/data-testid="conflicting-value"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /data-testid="use-proposed"|data-testid="keep-current"|data-testid="could-not-confirm"/);

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

  it("keeps the extraction inspector bound to every proposal of a grouped item", async () => {
    const importResult = importExtractionEnvelope(await traverseFixture("success-conflicting-fee"), options());
    const model = buildExtractionInspectorModel({ importResult, artifact: { status: "unavailable", code: "not-found" } });
    assert.deepEqual(model.candidates.map((candidate) => [candidate.proposalIndex, candidate.reviewItemName]),
      [0, 1, 2].map((index) => [index, importResult.reviewItems[0]!.metadata.name]));
    assert.deepEqual(buildReviewItemsFromExtractionEnvelopeImport(importResult.record), importResult.reviewItems);
  });
});
