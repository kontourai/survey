import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  buildExtractionInspectorModel,
  buildReviewItemsFromExtractionEnvelopeImport,
  inspectorSourcePosture,
  exportExtractionEnvelopeImport,
  importExtractionEnvelope,
  reimportExtractionEnvelope,
  validateExtractionEnvelopeImport,
  validateReviewQueueAgainstExtractionImport,
  type ExtractionEnvelopeImportOptions,
  type PortableExtractionProposal,
  type PortableExtractionResultEnvelope,
  type ResolvedExtractionArtifact,
} from "../src/index.js";

const TEXT = "Annual fee: 48000 USD. Renewal: 2027-03-31.";

function sha256(text: string): string { return createHash("sha256").update(text).digest("hex"); }

function proposal(fieldPath: string, excerpt: string, start: number): PortableExtractionProposal {
  const end = start + excerpt.length;
  return {
    fieldPath, candidateValue: excerpt, extractor: "verification-fixture", valueType: "string",
    provenance: { excerpt, locator: `chars:${start}-${end}`, occurrence: { resolverVersion: "exact-occurrence-v1", count: 1, selected: { index: 0, start, end }, selection: "source-order", hintUsed: false, ambiguous: false } },
  };
}

/** `48000` really sits at chars:12-17; `12345` claims the same span and is not in the text. */
const matching = proposal("commercial.annualFee", "48000", 12);
const fabricated = proposal("commercial.discount", "12345", 12);
const renewal = proposal("renewal.date", "2027-03-31", 32);

function envelope(proposals: PortableExtractionProposal[], contentLength = TEXT.length): PortableExtractionResultEnvelope {
  const identity = { format: "traverse-prepared-artifact" as const, version: 1 as const, digest: sha256(TEXT), preparationMode: "text", preparationVersion: "1", contentLength };
  const ref = `traverse-prepared-artifact:v1:sha256:${sha256(JSON.stringify({ ...identity, sourceSnapshotRef: null }))}`;
  return {
    format: "traverse-extraction-result", version: 1, source: { ref: "https://example.test/contract.txt" },
    result: {
      proposals, provider: "verification-fixture", runId: "traverse-extraction-run:00000000-0000-4000-8000-00000000a293",
      raw: {}, outcome: { status: "success" }, extractedAt: "2026-09-28T00:00:00.000Z", providerCalls: 1, totalTokensUsed: 1,
      preparedArtifact: { ...identity, ref },
    },
  };
}

function options(artifact?: ResolvedExtractionArtifact): ExtractionEnvelopeImportOptions {
  return {
    importName: "verification-import", producerNamespace: "verification-producer", sourceKind: "uploaded-document",
    claimTarget: (p) => ({ subjectType: "vendor", subjectId: "vendor-1", facet: "vendor.contract", claimType: "vendor.field", fieldOrBehavior: p.fieldPath, impactLevel: "medium" }),
    ...(artifact ? { artifact } : {}),
  };
}

const available = (text = TEXT, actualDigest = sha256(text)): ResolvedExtractionArtifact => ({ status: "available", text, actualDigest });

describe("import-time excerpt verification against the prepared artifact (#293)", () => {
  it("a proposal whose excerpt is not in the prepared text yields no review item and an excerpt-mismatch diagnostic", () => {
    const imported = importExtractionEnvelope(envelope([fabricated]), options(available()));
    assert.deepEqual(imported.reviewItems, []);
    assert.equal(imported.record.status.state, "unresolved", "every proposal excluded must not read as a clean empty run");
    assert.equal(imported.record.status.provenance, "verified");
    assert.deepEqual(imported.record.status.diagnostics, [{ kind: "excerpt-mismatch", proposalIndex: 0, locator: "chars:12-17",
      message: "Proposal 0 (commercial.discount): the prepared text at chars:12-17 is not its excerpt, so it produced no review item." }]);
    // Without the artifact the same envelope still imports as before, but says it is unverified.
    const unverified = importExtractionEnvelope(envelope([fabricated]), options());
    assert.equal(unverified.record.status.state, "grounded");
    assert.equal(unverified.record.status.provenance, "unverified");
    assert.equal(unverified.reviewItems.length, 1);
  });

  it("drops only the mismatched proposal; matching proposals import unchanged", () => {
    const clean = envelope([matching, renewal]);
    const withoutArtifact = importExtractionEnvelope(clean, options());
    const withArtifact = importExtractionEnvelope(clean, options(available()));
    // Same items and candidates; only the item says it was verified.
    const unmark = (items: typeof withArtifact.reviewItems) => items.map((item) => {
      const copy = JSON.parse(JSON.stringify(item));
      const meta = copy.metadata.producer["survey.kontourai.io/extraction-envelope"];
      assert.equal(meta.excerptVerification, "verified");
      delete meta.excerptVerification;
      return copy;
    });
    assert.deepEqual(unmark(withArtifact.reviewItems), withoutArtifact.reviewItems);
    assert.ok(withoutArtifact.reviewItems.every((item) => !("excerptVerification" in (item.metadata.producer!["survey.kontourai.io/extraction-envelope"] as object))));
    assert.deepEqual(withArtifact.record.status, { state: "grounded", diagnostics: [], provenance: "verified" });

    const mixed = importExtractionEnvelope(envelope([matching, fabricated, renewal]), options(available()));
    assert.equal(mixed.record.status.state, "grounded");
    assert.equal(mixed.record.status.provenance, "verified");
    assert.deepEqual(mixed.record.status.diagnostics.map((d) => [d.kind, "proposalIndex" in d ? d.proposalIndex : null]), [["excerpt-mismatch", 1]]);
    assert.deepEqual(mixed.reviewItems.map((item) => item.spec.target), ["commercial.annualFee", "renewal.date"]);
    assert.ok(mixed.reviewItems.every((item) => item.spec.candidates.every((c) => c.locator?.excerpt !== "12345")));

    // The record round-trips, and every downstream reader agrees on what it grounds.
    const restored = reimportExtractionEnvelope(exportExtractionEnvelopeImport(mixed.record));
    assert.deepEqual(restored, mixed.record);
    assert.deepEqual(buildReviewItemsFromExtractionEnvelopeImport(restored), mixed.reviewItems);
    assert.deepEqual(validateReviewQueueAgainstExtractionImport(mixed.reviewItems, mixed), []);
    const inspector = buildExtractionInspectorModel({ importResult: mixed, artifact: available() });
    assert.deepEqual(inspector.candidates.map((c) => [c.proposalIndex, c.alignment]), [[0, "aligned"], [2, "aligned"]]);
    // The excluded proposal is named on the source, which is not painted as complete.
    const [source] = inspector.sources;
    assert.deepEqual(source!.excludedProposals, [{ proposalIndex: 1, field: "commercial.discount", locator: "chars:12-17" }]);
    assert.equal(inspectorSourcePosture(source!), "proposals-excluded");
    assert.match(source!.message, /^1 proposal was excluded at import .*#1 commercial\.discount \(chars:12-17\)/);
    assert.doesNotMatch(source!.message, /Exact source spans are available/);
    assert.equal(source!.importProvenance, "verified");
    const clean2 = buildExtractionInspectorModel({ importResult: withoutArtifact, artifact: available() }).sources[0]!;
    assert.equal(inspectorSourcePosture(clean2), "aligned");
    assert.equal(clean2.importProvenance, "unverified");
    assert.match(clean2.message, /Exact source spans are available\. Excerpts were not checked against the prepared artifact at import\.$/);
  });

  it("a rival value excluded from a claim slot stays visible on the item", async () => {
    // A real Traverse envelope: "Fee: 48000 per year. Summary Fee: 48000. Amended Fee: 52000."
    const envelope = JSON.parse(await readFile(new URL("../../tests/fixtures/traverse-envelopes/success-conflicting-fee.v1.json", import.meta.url), "utf8")) as PortableExtractionResultEnvelope;
    const text = "Fee: 48000 per year. Summary Fee: 48000. Amended Fee: 52000.";
    const clean = importExtractionEnvelope(envelope, options(available(text)));
    assert.deepEqual(clean.record.status, { state: "grounded", diagnostics: [], provenance: "verified" });
    assert.equal(clean.reviewItems.length, 1);
    assert.equal(clean.reviewItems[0]!.spec.candidateSetStatus, "conflict", "a verified conflict stays a conflict");

    // The rival's excerpt no longer matches its span.
    const rival = envelope.result.proposals[2]!;
    rival.candidateValue = 52001; rival.provenance.excerpt = "52001";
    const verified = importExtractionEnvelope(envelope, options(available(text)));
    const [item] = verified.reviewItems;
    assert.equal(verified.reviewItems.length, 1);
    assert.equal(item!.spec.candidates.length, 1);
    assert.deepEqual((item!.metadata.producer!["survey.kontourai.io/extraction-envelope"] as Record<string, unknown>).excludedProposals,
      [{ proposalIndex: 2, value: 52001, locator: "chars:54-59", excerpt: "52001", reason: "excerpt-mismatch" }]);
    assert.deepEqual(reimportExtractionEnvelope(exportExtractionEnvelopeImport(verified.record)), verified.record);
    assert.deepEqual(buildReviewItemsFromExtractionEnvelopeImport(verified.record), verified.reviewItems);
  });

  it("a digest mismatch makes the import unresolved", () => {
    const tampered = TEXT.replace("48000", "48001");
    for (const artifact of [
      available(tampered),                                    // honest digest of the wrong bytes
      available(tampered, sha256(TEXT)),                      // wrong bytes reported under the expected digest
      { status: "digest-mismatch", actualDigest: "0".repeat(64) } as const,
    ]) {
      const imported = importExtractionEnvelope(envelope([matching]), options(artifact));
      assert.equal(imported.record.status.state, "unresolved");
      assert.equal(imported.record.status.provenance, "unverified");
      assert.deepEqual(imported.reviewItems, []);
      const [diagnostic] = imported.record.status.diagnostics;
      assert.equal(diagnostic?.kind, "digest-mismatch");
      assert.equal(imported.record.status.diagnostics.length, 1);
      if (diagnostic?.kind === "digest-mismatch") {
        assert.equal(diagnostic.expectedDigest, sha256(TEXT));
        assert.notEqual(diagnostic.actualDigest, sha256(TEXT));
      }
      assert.deepEqual(reimportExtractionEnvelope(exportExtractionEnvelopeImport(imported.record)), imported.record);
    }
  });

  it("an unreadable or wrong-length artifact makes the import unresolved instead of defaulting to grounded", () => {
    const unreadable = importExtractionEnvelope(envelope([matching]), options({ status: "unavailable", code: "access-denied" }));
    assert.equal(unreadable.record.status.state, "unresolved");
    assert.equal(unreadable.record.status.provenance, "unverified");
    assert.deepEqual(unreadable.reviewItems, []);
    assert.deepEqual(unreadable.record.status.diagnostics.map((d) => [d.kind, "code" in d ? d.code : null]), [["artifact-unavailable", "access-denied"]]);

    const wrongLength = importExtractionEnvelope(envelope([matching], TEXT.length + 1), options(available()));
    assert.equal(wrongLength.record.status.state, "unresolved");
    assert.deepEqual(wrongLength.record.status.diagnostics.map((d) => d.kind), ["artifact-unavailable"]);
    assert.deepEqual(reimportExtractionEnvelope(exportExtractionEnvelopeImport(wrongLength.record)), wrongLength.record);
  });

  it("refuses an artifact it cannot bind or parse", () => {
    const bare = envelope([matching]);
    delete bare.result.preparedArtifact;
    assert.throws(() => importExtractionEnvelope(bare, options(available())), /requires result.preparedArtifact/);
    assert.throws(() => importExtractionEnvelope(envelope([matching]), options({ status: "available", text: TEXT } as never)), /Invalid available extraction artifact/);
    assert.throws(() => importExtractionEnvelope(envelope([matching]), options({ status: "unavailable", code: "gone" } as never)), /Invalid unavailable extraction artifact/);
  });

  it("a stored record's verification results must be ones the import could have written", () => {
    const mixed = importExtractionEnvelope(envelope([matching, fabricated]), options(available())).record;
    const edit = (change: (record: Record<string, any>) => void) => { const copy = JSON.parse(JSON.stringify(mixed)); change(copy); return copy; };
    // Not checkable without the text: deleting every mismatch leaves a coherent
    // "verified, all matched" record. Stored-record integrity stays the caller's
    // obligation (see the queue-binding boundary notes); this only rejects
    // results no import could have produced.
    assert.doesNotThrow(() => validateExtractionEnvelopeImport(edit((r) => { r.status.diagnostics = []; })));
    assert.throws(() => validateExtractionEnvelopeImport(edit((r) => { r.status.diagnostics[0].message = "fine"; })), /Import status does not match/);
    assert.throws(() => validateExtractionEnvelopeImport(edit((r) => { r.status.diagnostics[0].proposalIndex = 7; })), /Import status does not match/);
    assert.throws(() => validateExtractionEnvelopeImport(edit((r) => { r.status.diagnostics.push(r.status.diagnostics[0]); })), /Import status does not match/);
    assert.throws(() => validateExtractionEnvelopeImport(edit((r) => { r.status.provenance = "unverified"; })), /Import status does not match/);
    assert.throws(() => validateExtractionEnvelopeImport(edit((r) => { r.status.state = "unresolved"; })), /Import status does not match/);
    assert.throws(() => validateExtractionEnvelopeImport(edit((r) => { r.status.provenance = "trusted"; })), /status\.provenance must be "verified" or "unverified"/);
    const bare = importExtractionEnvelope((() => { const e = envelope([matching]); delete e.result.preparedArtifact; return e; })(), options()).record as Record<string, any>;
    bare.status.provenance = "verified";
    assert.throws(() => validateExtractionEnvelopeImport(bare), /Import status does not match/, "nothing to have verified against");
    // `provenance` is required (#320): a record without it is refused, so a
    // producer that strips it cannot pass the record off as the older shape.
    const stripped = importExtractionEnvelope(envelope([matching]), options()).record as Record<string, any>;
    delete stripped.status.provenance;
    assert.throws(() => validateExtractionEnvelopeImport(stripped), /status\.provenance is required/);
    assert.throws(() => reimportExtractionEnvelope(JSON.stringify(stripped)), /status\.provenance is required/);
    assert.throws(() => validateExtractionEnvelopeImport(edit((r) => { delete r.status.provenance; })), /status\.provenance is required/);
    for (const invalid of [null, "", "Verified", true, 1]) {
      assert.throws(() => validateExtractionEnvelopeImport(edit((r) => { r.status.provenance = invalid; })), /status\.provenance must be "verified" or "unverified"/, String(invalid));
    }
    // Both valid values still load where the import could have written them.
    assert.equal(validateExtractionEnvelopeImport(importExtractionEnvelope(envelope([matching]), options()).record).status.provenance, "unverified");
    assert.equal(validateExtractionEnvelopeImport(mixed).status.provenance, "verified");
  });
});
