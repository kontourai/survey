import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  buildExtractionInspectorModel,
  exportExtractionInspector,
  filterExtractionInspectorCandidates,
  importExtractionEnvelope,
  type PortablePdfLayout,
  type PortableExtractionResultEnvelope,
} from "../src/index.js";

const fixtureUrl = new URL("../../tests/fixtures/portable-extraction-result.v1.json", import.meta.url);

async function input(importName = "inspector-fixture") {
  const envelope = JSON.parse(await readFile(fixtureUrl, "utf8")) as PortableExtractionResultEnvelope;
  const preparedText = "Alpha Beta Alpha";
  const artifact = envelope.result.preparedArtifact!;
  artifact.digest = createHash("sha256").update(preparedText).digest("hex");
  const binding = { format: artifact.format, version: artifact.version, digest: artifact.digest, preparationMode: artifact.preparationMode, preparationVersion: artifact.preparationVersion, contentLength: artifact.contentLength, sourceSnapshotRef: artifact.sourceSnapshotRef ?? null };
  artifact.ref = `traverse-prepared-artifact:v1:sha256:${createHash("sha256").update(JSON.stringify(binding)).digest("hex")}`;
  const imported = importExtractionEnvelope(envelope, {
    importName,
    producerNamespace: "fixture",
    sourceKind: "api-record",
    claimTarget: (proposal) => ({ subjectType: "fixture", subjectId: "one", facet: "fixture", claimType: "fixture.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "low" }),
  });
  return { importResult: imported, artifact: { status: "available" as const, text: preparedText, actualDigest: artifact.digest } };
}

describe("source-linked extraction inspector", () => {
  it("keeps repeated spans and shared spans as distinct candidates", async () => {
    const source = await input();
    const model = buildExtractionInspectorModel(source);
    assert.equal(model.sources[0]!.alignment, "aligned");
    assert.deepEqual(model.candidates.map(candidate => candidate.reviewItemName), source.importResult.reviewItems.map(item => item.metadata.name));
    assert.deepEqual(model.candidates.map((candidate) => [candidate.field, candidate.start, candidate.end]), [["title", 0, 5], ["alias", 11, 16]]);
    const sharedEnvelope = structuredClone(source.importResult.record.spec.envelope);
    sharedEnvelope.result.proposals[1]!.provenance.locator = "chars:0-5";
    sharedEnvelope.result.proposals[1]!.provenance.occurrence.selected = { index: 0, start: 0, end: 5 };
    const sharedImport = importExtractionEnvelope(sharedEnvelope, { importName: "shared", producerNamespace: "fixture", sourceKind: "api-record", claimTarget: proposal => ({ subjectType: "fixture", subjectId: "one", facet: "fixture", claimType: "fixture.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "low" }) });
    const sharedModel = buildExtractionInspectorModel({ importResult: sharedImport, artifact: source.artifact });
    assert.equal(sharedModel.candidates.length, 2);
    assert.notEqual(sharedModel.candidates[0]!.id, sharedModel.candidates[1]!.id);
  });

  it("filters by all required extraction dimensions", async () => {
    const first = await input();
    const second = await input("second-import");
    const model = buildExtractionInspectorModel({ imports: [{ ...first, pass: "primary" }, { ...second, pass: "adversarial" }] });
    assert.equal(filterExtractionInspectorCandidates(model, { field: "alias", provider: "portable-fixture", model: "generic-model", attempt: model.candidates[0]!.attempt, pass: "primary", inferenceType: "inferred", alignment: "aligned" }).length, 1);
    assert.equal(filterExtractionInspectorCandidates(model, { inferenceType: "explicit" })[0]!.field, "title");
    assert.equal(filterExtractionInspectorCandidates(model, { pass: "adversarial" }).length, 2);
    assert.deepEqual(
      filterExtractionInspectorCandidates(model, { query: "alias" }).map(candidate => candidate.field),
      ["alias", "alias"],
    );
  });

  it("fails closed for unavailable, digest-mismatched, and excerpt-mismatched artifacts", async () => {
    const source = await input();
    assert.equal(buildExtractionInspectorModel({ ...source, artifact: { status: "unavailable", code: "storage-error" } }).sources[0]!.alignment, "artifact-unavailable");
    assert.equal(buildExtractionInspectorModel({ ...source, artifact: { status: "digest-mismatch", actualDigest: "0".repeat(64) } }).sources[0]!.alignment, "digest-mismatch");
    const tampered = buildExtractionInspectorModel({ ...source, artifact: { ...source.artifact, text: "Alpha Beta Alphx" } });
    assert.equal(tampered.sources[0]!.alignment, "digest-mismatch");
    assert.equal(tampered.sources[0]!.artifactText, undefined);
    const excerptEnvelope = structuredClone(source.importResult.record.spec.envelope);
    excerptEnvelope.result.proposals[0]!.provenance.excerpt = "Omega";
    const excerptImport = importExtractionEnvelope(excerptEnvelope, { importName: "excerpt-mismatch", producerNamespace: "fixture", sourceKind: "api-record", claimTarget: proposal => ({ subjectType: "fixture", subjectId: "one", facet: "fixture", claimType: "fixture.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "low" }) });
    const excerptMismatch = buildExtractionInspectorModel({ importResult: excerptImport, artifact: source.artifact });
    assert.equal(excerptMismatch.sources[0]!.alignment, "excerpt-mismatch");
    assert.equal(excerptMismatch.sources[0]!.artifactText, undefined);
    assert.deepEqual(excerptMismatch.candidates.map(candidate => candidate.alignment), ["excerpt-mismatch", "excerpt-mismatch"]);
    const malformed = structuredClone(source); malformed.importResult.reviewItems[0]!.metadata.name = "invented"; malformed.importResult.reviewItems[0]!.spec.target = "wrong";
    assert.throws(() => buildExtractionInspectorModel(malformed), /canonical identities/);
    const nameOnlyTamper = structuredClone(source); nameOnlyTamper.importResult.reviewItems[0]!.metadata.name = "invented-name-only";
    assert.throws(() => buildExtractionInspectorModel(nameOnlyTamper), /canonical identities/);
    assert.throws(() => buildExtractionInspectorModel({ ...source, artifact: { status: "unavailable", code: "unknown", reason: "secret resolver detail" } as never }), /Invalid unavailable/);
  });

  it("exports provider-independent read-only evidence with sensitive content redacted by default", async () => {
    const model = buildExtractionInspectorModel(await input());
    const safe = exportExtractionInspector(model);
    assert.doesNotMatch(safe, /Alpha Beta Alpha/);
    assert.doesNotMatch(safe, /Store offline|resolver|reason/);
    assert.match(safe, /\[redacted\]/);
    assert.match(safe, /preparedTextIncluded\":false/);
    const disclosed = exportExtractionInspector(model, { includePreparedText: true, includeExcerpts: true });
    assert.match(disclosed, /Alpha Beta Alpha/);
    assert.doesNotMatch(disclosed, /apiKey|providerConfig|rawResponse/);
  });

  it("resolves exact PDF regions and preserves an explicit OCR posture", async () => {
    const source = await input();
    const pdfEnvelope = structuredClone(source.importResult.record.spec.envelope);
    pdfEnvelope.result.pdfPageOffsets = [0, 11];
    pdfEnvelope.result.pdfLayout = layout();
    const pdfImport = importExtractionEnvelope(pdfEnvelope, {
      importName: "pdf-inspector",
      producerNamespace: "fixture",
      sourceKind: "uploaded-document",
      claimTarget: proposal => ({ subjectType: "fixture", subjectId: "one", facet: "fixture", claimType: "fixture.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "low" }),
    });
    const pdfModel = buildExtractionInspectorModel({ importResult: pdfImport, artifact: source.artifact });
    assert.deepEqual(pdfModel.candidates[0]!.pdfRegion, {
      pages: [1],
      elements: [layout().elements[0]],
      tableCells: [],
    });
    assert.deepEqual(pdfModel.candidates[1]!.pdfRegion?.pages, [2]);
    assert.equal(pdfModel.candidates[1]!.pdfRegion?.tableCells[0]?.cell.rowIndex, 0);
    assert.doesNotMatch(exportExtractionInspector(pdfModel), /Alpha Beta Alpha/);
    assert.match(exportExtractionInspector(pdfModel), /pdfRegion/);

    const ocrEnvelope = structuredClone(source.importResult.record.spec.envelope);
    ocrEnvelope.result.ocrDerived = true;
    const ocrImport = importExtractionEnvelope(ocrEnvelope, {
      importName: "ocr-inspector",
      producerNamespace: "fixture",
      sourceKind: "uploaded-document",
      claimTarget: proposal => ({ subjectType: "fixture", subjectId: "one", facet: "fixture", claimType: "fixture.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "low" }),
    });
    const ocrModel = buildExtractionInspectorModel({ importResult: ocrImport, artifact: source.artifact });
    assert.equal(ocrModel.sources[0]!.ocrDerived, true);
    assert.equal(ocrModel.candidates[0]!.ocrDerived, true);
    assert.match(ocrModel.sources[0]!.message, /OCR-derived/);
  });
});

function layout(): PortablePdfLayout {
  return {
    pages: [
      { pageNumber: 1, width: 612, height: 792, unit: "points" },
      { pageNumber: 2, width: 612, height: 792, unit: "points" },
    ],
    elements: [
      { kind: "heading", pageNumber: 1, range: { start: 0, end: 5 }, bounds: { x: 10, y: 20, width: 80, height: 12 } },
      { kind: "table-cell", pageNumber: 2, range: { start: 11, end: 16 }, bounds: { x: 30, y: 40, width: 90, height: 14 } },
    ],
    tables: [{
      pageNumber: 2,
      cells: [{ rowIndex: 0, columnIndex: 0, range: { start: 11, end: 16 } }],
    }],
  };
}
