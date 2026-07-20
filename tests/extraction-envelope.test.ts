import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { deserializePortableExtractionResult, validatePortableExtractionResultEnvelope } from "@kontourai/traverse";
import {
  buildReviewItemsFromExtractionEnvelopeImport,
  createExtractionEnvelopeResolutionIdentity,
  exportExtractionEnvelopeImport,
  importExtractionEnvelope,
  reimportExtractionEnvelope,
  type ExtractionEnvelopeImportOptions,
  type PortableExtractionProposal,
  type PortableExtractionResultEnvelope,
} from "../src/index.js";

const fixtureUrl = new URL("../../tests/fixtures/portable-extraction-result.v1.json", import.meta.url);

describe("portable extraction envelope import", () => {
  it("consumes the owning v1 fixture and preserves the envelope exactly", async () => {
    const serialized = await readFile(fixtureUrl, "utf8");
    const owningEnvelope = deserializePortableExtractionResult(serialized);
    const imported = importExtractionEnvelope(serialized, options());
    const restored = reimportExtractionEnvelope(exportExtractionEnvelopeImport(imported.record));

    assert.deepEqual(restored.spec.envelope, owningEnvelope);
    assert.deepEqual(restored, imported.record);
    assert.equal(imported.record.status.state, "grounded");
    assert.equal(imported.reviewItems.length, 2);
    const candidate = imported.reviewItems[0]!.spec.candidates[0]!;
    assert.equal(candidate.locator?.locator, "chars:0-5");
    assert.equal(candidate.extraction.target, "title");
    assert.equal(candidate.extraction.extractor, "portable-fixture");
    assert.equal(candidate.extraction.model, "generic-model");
    assert.deepEqual(candidate.producer?.["survey.kontourai.io/extraction-envelope"], {
      importName: "fixture-import", proposalIndex: 0,
      evidenceId: (candidate.producer?.["survey.kontourai.io/extraction-envelope"] as Record<string, unknown>).evidenceId,
      runId: "traverse-extraction-run:00000000-0000-4000-8000-000000000001",
      provider: "portable-fixture", model: "generic-model",
      taskDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      exampleDigests: ["sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      valueType: { type: "string", origin: "explicit" },
      occurrence: owningEnvelope.result.proposals[0]!.provenance.occurrence,
      attempt: { id: owningEnvelope.result.runId, providerCalls: 2 },
      warnings: [{ category: "provider", code: "provider-warning" }],
      outcome: { status: "partial", reason: "max-provider-calls" },
    });
  });

  it("keeps same values at different locators distinct", async () => {
    const imported = importExtractionEnvelope(await readFile(fixtureUrl, "utf8"), options());
    assert.equal(imported.reviewItems[0]!.spec.candidates[0]!.value, "Alpha");
    assert.equal(imported.reviewItems[1]!.spec.candidates[0]!.value, "Alpha");
    assert.notEqual(imported.reviewItems[0]!.metadata.name, imported.reviewItems[1]!.metadata.name);
    assert.notEqual(imported.reviewItems[0]!.spec.candidates[0]!.id, imported.reviewItems[1]!.spec.candidates[0]!.id);
  });

  it("keeps same-span different fields distinct while sharing source evidence", async () => {
    const envelope = await fixture();
    envelope.result.proposals.push({ ...envelope.result.proposals[0]!, fieldPath: "alias" });
    const imported = importExtractionEnvelope(envelope, options());
    const a = imported.reviewItems[0]!, b = imported.reviewItems[2]!;
    assert.notEqual(a.metadata.name, b.metadata.name);
    assert.notEqual(a.spec.candidates[0]!.id, b.spec.candidates[0]!.id);
    assert.equal(evidenceId(a), evidenceId(b));
  });

  it("binds candidate and evidence identities to complete import, artifact, snapshot, and locator identity", async () => {
    const base = await fixture();
    const imported = importExtractionEnvelope(base, options());
    const baseCandidate = imported.reviewItems[0]!.spec.candidates[0]!.id;
    const baseEvidence = evidenceId(imported.reviewItems[0]!);
    for (const mutate of [
      (e: PortableExtractionResultEnvelope) => { e.source.snapshotRef = "snapshot:other"; e.result.preparedArtifact!.sourceSnapshotRef = "snapshot:other"; rebindArtifact(e); },
      (e: PortableExtractionResultEnvelope) => { e.result.preparedArtifact!.preparationVersion = "2"; rebindArtifact(e); },
      (e: PortableExtractionResultEnvelope) => { e.result.proposals[0]!.provenance.locator = "chars:1-5"; e.result.proposals[0]!.provenance.excerpt = "lpha"; e.result.proposals[0]!.provenance.occurrence.selected.start = 1; },
    ]) {
      const changed = structuredClone(base); mutate(changed);
      const result = importExtractionEnvelope(changed, options());
      assert.notEqual(result.reviewItems[0]!.spec.candidates[0]!.id, baseCandidate);
      assert.notEqual(evidenceId(result.reviewItems[0]!), baseEvidence);
    }
    assert.notEqual(importExtractionEnvelope(base, options({ producerNamespace: "other" })).reviewItems[0]!.spec.candidates[0]!.id, baseCandidate);
    assert.notEqual(importExtractionEnvelope(base, options({ importName: "other" })).reviewItems[0]!.spec.candidates[0]!.id, baseCandidate);
  });

  it("binds candidate, extraction, and resolution identities to every proposal semantic input", async () => {
    const base = await fixture();
    const baseline = importExtractionEnvelope(base, options());
    const baselineCandidate = baseline.reviewItems[0]!.spec.candidates[0]!;
    const baselineResolution = resolutionBase(createExtractionEnvelopeResolutionIdentity(baseline.record, 0).evidenceId);
    for (const mutate of [
      (p: PortableExtractionProposal) => { p.candidateValue = "Beta"; },
      (p: PortableExtractionProposal) => { p.confidence = 0.81; },
      (p: PortableExtractionProposal) => { p.extractor = "other-extractor"; },
      (p: PortableExtractionProposal) => { p.inferenceType = "inferred"; },
      (p: PortableExtractionProposal) => { p.valueType = "enum"; p.enumValues = ["Alpha", "Beta"]; },
      (p: PortableExtractionProposal) => { p.pathIndices = [0, 2]; },
      (p: PortableExtractionProposal) => { p.provenance.occurrence.selected.index = 1; },
    ]) {
      const changed = structuredClone(base); mutate(changed.result.proposals[0]!);
      const result = importExtractionEnvelope(changed, options());
      const candidate = result.reviewItems[0]!.spec.candidates[0]!;
      assert.notEqual(candidate.id, baselineCandidate.id);
      assert.notEqual(candidate.extraction.extractionId, baselineCandidate.extraction.extractionId);
      assert.notEqual(resolutionBase(createExtractionEnvelopeResolutionIdentity(result.record, 0).evidenceId), baselineResolution);
    }
  });

  it("binds evidence to excerpt and occurrence but shares it across field and value semantics", async () => {
    const base = await fixture();
    const baselineEvidence = evidenceId(importExtractionEnvelope(base, options()).reviewItems[0]!);
    const sameSource = structuredClone(base); sameSource.result.proposals[0]!.fieldPath = "alias"; sameSource.result.proposals[0]!.candidateValue = "Different";
    assert.equal(evidenceId(importExtractionEnvelope(sameSource, options()).reviewItems[0]!), baselineEvidence);
    const changedOccurrence = structuredClone(base); changedOccurrence.result.proposals[0]!.provenance.occurrence.selected.index = 1;
    assert.notEqual(evidenceId(importExtractionEnvelope(changedOccurrence, options()).reviewItems[0]!), baselineEvidence);
    const changedExcerpt = structuredClone(base); changedExcerpt.result.proposals[0]!.provenance.excerpt = "ALPHA";
    assert.notEqual(evidenceId(importExtractionEnvelope(changedExcerpt, options()).reviewItems[0]!), baselineEvidence);
  });

  it("retains every non-grounded artifact state as a typed diagnostic and never emits candidates", async () => {
    const canonicalRef = (await fixture()).result.preparedArtifact!.ref;
    for (const state of [
      { status: "unavailable", requestedRef: canonicalRef, canonicalRef },
      { status: "storage-error", requestedRef: canonicalRef, canonicalRef },
      { status: "identity-mismatch", requestedRef: "artifact:requested-mismatch", canonicalRef },
      { status: "invalid-artifact", reason: "invalid-format", canonicalRef: "artifact:canonical" },
    ] as const) {
      const envelope = await fixture(); envelope.result.preparedArtifactState = { ...state, canonicalRef: envelope.result.preparedArtifact!.ref };
      const result = importExtractionEnvelope(envelope, options());
      assert.equal(result.record.status.state, "unresolved");
      assert.equal(result.record.status.diagnostics[0]!.kind, "artifact-unavailable");
      assert.deepEqual(result.reviewItems, []);
      assert.deepEqual(buildReviewItemsFromExtractionEnvelopeImport(result.record), []);
    }
    const envelope = await fixture();
    envelope.result.preparedArtifactState = { status: "digest-mismatch", requestedRef: envelope.result.preparedArtifact!.ref, canonicalRef: envelope.result.preparedArtifact!.ref, actualDigest: "c".repeat(64), actualContentLength: 17 };
    const mismatch = importExtractionEnvelope(envelope, options());
    assert.deepEqual(mismatch.record.status.diagnostics[0], { kind: "digest-mismatch", artifactRef: envelope.result.preparedArtifact!.ref, expectedDigest: envelope.result.preparedArtifact!.digest, actualDigest: "c".repeat(64), message: "Prepared artifact digest does not match the expected extraction artifact." });
    assert.deepEqual(mismatch.reviewItems, []);
  });

  it("rejects malformed runtime shapes and non-lossless object inputs before grounding", async () => {
    const bad = await fixture(); (bad.result.proposals[0]!.confidence as number) = 2;
    assert.throws(() => importExtractionEnvelope(bad, options()), /confidence/);
    const unknown = await fixture(); (unknown.result.outcome as { status: string }).status = "unknown";
    assert.throws(() => importExtractionEnvelope(unknown, options()), /outcome status/);
    const negativeZero = await fixture(); negativeZero.result.proposals[0]!.candidateValue = -0;
    assert.throws(() => importExtractionEnvelope(negativeZero, options()), /non-lossless number/);
    const sparse = await fixture(); sparse.result.proposals = new Array<PortableExtractionProposal>(2); sparse.result.proposals[1] = (await fixture()).result.proposals[0]!;
    assert.throws(() => importExtractionEnvelope(sparse, options()), /sparse array slot/);
  });

  it("matches the owner validator for occurrence hints, token overshoot, and strict invariants", async () => {
    const valid = await fixture();
    valid.result.proposals[0]!.provenance.occurrence.selection = "occurrence-hint";
    valid.result.proposals[0]!.provenance.occurrence.hintUsed = true;
    valid.result.partial!.tokenOvershoot = 3;
    valid.result.pdfPageOffsets = [0, 10, 20];
    assert.equal(validatePortableExtractionResultEnvelope(valid).status, "valid");
    assert.doesNotThrow(() => importExtractionEnvelope(valid, options()));

    await assertBothReject((e) => { e.result.proposals[0]!.provenance.occurrence.hintUsed = true; });
    await assertBothReject((e) => { e.result.proposals[0]!.provenance.occurrence.ambiguous = false; });
    await assertBothReject((e) => { e.result.proposals[0]!.provenance.occurrence.selected.index = 2; });
    await assertBothReject((e) => { e.result.pdfPageOffsets = [0, 10, 10]; });
    await assertBothReject((e) => { e.result.partial!.tokenOvershoot = 0; });
  });

  it("matches owner privacy and prepared-state relationship validation", async () => {
    for (const mutate of [
      (e: PortableExtractionResultEnvelope) => { e.source.ref = "https://user:password@example.test/source"; },
      (e: PortableExtractionResultEnvelope) => { e.source.snapshotRef = "https://example.test/snapshot?api_key=secret"; e.result.preparedArtifact!.sourceSnapshotRef = e.source.snapshotRef; rebindArtifact(e); },
      (e: PortableExtractionResultEnvelope) => { e.result.provider = "sk-secretvalue"; },
      (e: PortableExtractionResultEnvelope) => { e.result.proposals[0]!.extractor = "https://example.test/?token=secret"; },
      (e: PortableExtractionResultEnvelope) => { const ref = e.result.preparedArtifact!.ref; e.result.preparedArtifactState = { status: "available", requestedRef: "traverse-prepared-artifact:v1:sha256:" + "a".repeat(64), canonicalRef: ref }; },
      (e: PortableExtractionResultEnvelope) => { const ref = e.result.preparedArtifact!.ref; e.result.preparedArtifactState = { status: "identity-mismatch", requestedRef: ref, canonicalRef: ref }; },
    ]) await assertBothReject(mutate);
  });

  it("matches owner JSON descriptor and Unicode validation without narrowing enum values", async () => {
    await assertBothReject((e) => { (e.result.proposals as PortableExtractionProposal[] & { extra?: string }).extra = "discarded"; });
    await assertBothReject((e) => { Object.defineProperty(e.result.proposals, "0", { get: () => e.result.proposals[0], enumerable: true, configurable: true }); });
    await assertBothReject((e) => { Object.defineProperty(e.result.proposals, "0", { value: e.result.proposals[0], enumerable: false, writable: true, configurable: true }); });
    await assertBothReject((e) => { e.result.proposals[0]!.candidateValue = "\ud800"; });
    await assertBothReject((e) => { Object.defineProperty(e.result.proposals[0]!, "candidateValue", { get: () => "Alpha", enumerable: true, configurable: true }); });

    const emptyEnum = await fixture();
    emptyEnum.result.proposals[0]!.valueType = "enum";
    emptyEnum.result.proposals[0]!.enumValues = [""];
    assert.equal(validatePortableExtractionResultEnvelope(emptyEnum).status, "valid");
    assert.doesNotThrow(() => importExtractionEnvelope(emptyEnum, options()));
  });

  it("accepts owner-valid whitespace-only upstream non-empty strings", async () => {
    for (const mutate of [
      (e: PortableExtractionResultEnvelope) => { e.result.proposals[0]!.fieldPath = " "; },
      (e: PortableExtractionResultEnvelope) => { e.result.proposals[0]!.provenance.excerpt = "     "; },
      (e: PortableExtractionResultEnvelope) => { e.result.extractedAt = " "; },
    ]) {
      const envelope = await fixture(); mutate(envelope);
      assert.equal(validatePortableExtractionResultEnvelope(envelope).status, "valid");
      assert.doesNotThrow(() => importExtractionEnvelope(envelope, options({ claimTarget: () => ({ subjectType: "fixture", subjectId: "one", facet: "fixture.record", claimType: "fixture.field", fieldOrBehavior: "mapped-field", impactLevel: "medium" }) })));
    }
  });

  it("creates collision-resistant evidence and event identities for repeated resolutions", async () => {
    const record = importExtractionEnvelope(await readFile(fixtureUrl, "utf8"), options()).record;
    const first = createExtractionEnvelopeResolutionIdentity(record, 0);
    const second = createExtractionEnvelopeResolutionIdentity(record, 0);
    assert.notEqual(first.evidenceId, second.evidenceId);
    assert.notEqual(first.eventId, second.eventId);
  });
});

async function fixture(): Promise<PortableExtractionResultEnvelope> { return JSON.parse(await readFile(fixtureUrl, "utf8")) as PortableExtractionResultEnvelope; }
function options(overrides: Partial<ExtractionEnvelopeImportOptions> = {}): ExtractionEnvelopeImportOptions { return { importName: "fixture-import", producerNamespace: "fixture-producer", sourceKind: "api-record", claimTarget: (proposal) => ({ subjectType: "fixture", subjectId: "one", facet: "fixture.record", claimType: "fixture.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "medium" }), ...overrides }; }
function evidenceId(item: ReturnType<typeof importExtractionEnvelope>["reviewItems"][number]): unknown { return (item.spec.candidates[0]!.producer?.["survey.kontourai.io/extraction-envelope"] as Record<string, unknown>).evidenceId; }
function rebindArtifact(envelope: PortableExtractionResultEnvelope): void { const artifact = envelope.result.preparedArtifact!; const binding = { format: artifact.format, version: artifact.version, digest: artifact.digest, preparationMode: artifact.preparationMode, preparationVersion: artifact.preparationVersion, contentLength: artifact.contentLength, sourceSnapshotRef: artifact.sourceSnapshotRef ?? null }; artifact.ref = `traverse-prepared-artifact:v1:sha256:${createHash("sha256").update(JSON.stringify(binding)).digest("hex")}`; }
async function assertBothReject(mutate: (envelope: PortableExtractionResultEnvelope) => void): Promise<void> { const envelope = await fixture(); mutate(envelope); assert.equal(validatePortableExtractionResultEnvelope(envelope).status, "invalid"); assert.throws(() => importExtractionEnvelope(envelope, options())); }
function resolutionBase(id: string): string { return id.replace(/\.[0-9a-f-]{36}$/, ""); }
