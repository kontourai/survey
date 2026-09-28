import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { projectReviewedExtractionEvidence, restoreReviewedExtractionEvidence } from "@kontourai/surface";
import {
  importExtractionEnvelope,
  toSurfaceReviewedExtractionDecision,
  toSurfaceReviewedExtractionImport,
  toSurfaceReviewedExtractionItem,
  type ExtractionEnvelopeImportOptions,
  type PortableExtractionResultEnvelope,
  type ReviewDecision,
  type ReviewItem,
} from "../src/index.js";

const fixtureUrl = new URL("../../tests/fixtures/portable-extraction-result.v1.json", import.meta.url);

function options(): ExtractionEnvelopeImportOptions {
  return {
    importName: "bridge-fixture-import",
    producerNamespace: "bridge-fixture-producer",
    sourceKind: "api-record",
    claimTarget: (proposal) => ({
      subjectType: "fixture", subjectId: "one", facet: "fixture.record",
      claimType: "fixture.field", fieldOrBehavior: proposal.fieldPath, impactLevel: "medium",
    }),
  };
}

function acceptedDecision(item: ReviewItem): ReviewDecision {
  return {
    apiVersion: "survey.kontourai.io/v1alpha1",
    kind: "ReviewDecision",
    metadata: { name: `${item.metadata.name}-decision` },
    spec: {
      reviewItemName: item.metadata.name,
      candidateId: item.spec.candidates[0]!.id,
      status: "verified",
      resolution: "accepted",
      actor: { id: "bridge-test-reviewer" },
      reviewedAt: "2026-07-29T00:00:00.000Z",
    },
  };
}

function project(imported: ReturnType<typeof importExtractionEnvelope>, index: number, item = imported.reviewItems[index]!) {
  const claim = imported.record.spec.claimTargets[index]!;
  return projectReviewedExtractionEvidence({
    evidenceId: `bridge-evidence-model-${index}`,
    claimId: `${claim.subjectType}:${claim.fieldOrBehavior}`,
    proposalIndex: index,
    importRecord: toSurfaceReviewedExtractionImport(imported.record),
    reviewItem: toSurfaceReviewedExtractionItem(item),
    reviewDecision: toSurfaceReviewedExtractionDecision(acceptedDecision(item)),
    collectedBy: "survey-bridge-test",
    structuralTrust: "validated",
  });
}

/** Major version of the Surface this test run resolved (CI pins each supported major). */
async function installedSurfaceMajor(): Promise<number> {
  let dir = new URL(".", import.meta.resolve("@kontourai/surface"));
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(new URL("package.json", dir), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@kontourai/surface" && typeof pkg.version === "string") return Number(pkg.version.split(".")[0]);
    } catch { /* keep walking up */ }
    const parent = new URL("..", dir);
    if (parent.href === dir.href) throw new Error("installed @kontourai/surface package.json not found");
    dir = parent;
  }
}

async function servedBy(models: [string, string]): Promise<PortableExtractionResultEnvelope> {
  const envelope = JSON.parse(await readFile(fixtureUrl, "utf8")) as PortableExtractionResultEnvelope;
  envelope.result.proposals.forEach((proposal, index) => {
    proposal.producedBy = { model: models[index]!, modelSource: "provider-reported", requestDigest: `sha256:${String(index).repeat(64)}` };
  });
  return envelope;
}

describe("surface reviewed-extraction bridge", () => {
  it("survey-produced records flow through surface's projection with no consumer casts", async () => {
    // This is the living contract test surface#194 asked for: every survey
    // build passes real survey output through surface's actual validator via
    // the typed adapters. Shape drift on either side fails here (or, for
    // declared-field drift, at the FieldsAssignable compile-time assertions
    // in src/surface-reviewed-extraction.ts) — in the package that owns the
    // shapes, not in a downstream consumer at runtime.
    const imported = importExtractionEnvelope(await readFile(fixtureUrl, "utf8"), options());
    const item = imported.reviewItems[0]!;
    const claim = imported.record.spec.claimTargets[0]!;
    const decision: ReviewDecision = {
      apiVersion: "survey.kontourai.io/v1alpha1",
      kind: "ReviewDecision",
      metadata: { name: `${item.metadata.name}-decision` },
      spec: {
        reviewItemName: item.metadata.name,
        candidateId: item.spec.candidates[0]!.id,
        status: "verified",
        resolution: "accepted",
        actor: { id: "bridge-test-reviewer" },
        reviewedAt: "2026-07-29T00:00:00.000Z",
      },
    };

    const projection = projectReviewedExtractionEvidence({
      evidenceId: "bridge-evidence-1",
      claimId: `${claim.subjectType}:${claim.fieldOrBehavior}`,
      proposalIndex: 0,
      importRecord: toSurfaceReviewedExtractionImport(imported.record),
      reviewItem: toSurfaceReviewedExtractionItem(item),
      reviewDecision: toSurfaceReviewedExtractionDecision(decision),
      collectedBy: "survey-bridge-test",
      structuralTrust: "validated",
    });

    assert.equal(projection.evidence.evidenceType, "source_excerpt");
    assert.equal(projection.compatibility.upstreamSchemaChangeNeeded, false);
    assert.deepEqual(projection.gaps, [], `expected no provenance gaps, got ${JSON.stringify(projection.gaps)}`);
    assert.equal(projection.evidence.supportStrength, "entails");

    // Round-trip: surface re-derives and cross-checks the digest-bound profile.
    const restored = restoreReviewedExtractionEvidence(projection.evidence);
    assert.equal(restored.evidenceId, "bridge-evidence-1");
  });

  it("a multi-model envelope projects through Surface 4.x, which binds the proposal's own model", async () => {
    // Proposal 0 was served by a fallback model; the run-level model names
    // only the last chunk's. Surface 4.x binds the candidate's model to
    // `producedBy.model` and accepts every candidate. Surface 3.3 and older
    // bind it to `result.model` and refuse the fallback candidate; no released
    // producer emits such envelopes before Traverse 1.0.0.
    const imported = importExtractionEnvelope(await servedBy(["fallback-model", "generic-model"]), options());
    assert.equal(imported.record.spec.envelope.result.model, "generic-model");
    assert.deepEqual(imported.reviewItems.map((item) => item.spec.candidates[0]!.extraction.model), ["fallback-model", "generic-model"]);

    // The same fallback candidate, presented with the run-level model.
    const runLevel = structuredClone(imported.reviewItems[0]!);
    runLevel.spec.candidates[0]!.extraction.model = "generic-model";

    if (await installedSurfaceMajor() >= 4) {
      for (const index of [0, 1]) {
        const projection = project(imported, index);
        assert.deepEqual(projection.gaps, [], `proposal ${index}: ${JSON.stringify(projection.gaps)}`);
        assert.equal(projection.evidence.supportStrength, "entails");
        assert.equal(restoreReviewedExtractionEvidence(projection.evidence).evidenceId, `bridge-evidence-model-${index}`);
      }
      assert.throws(() => project(imported, 0, runLevel), /candidate extraction does not match proposal/);
    } else {
      assert.throws(() => project(imported, 0), /candidate extraction does not match proposal/);
      assert.equal(project(imported, 1).evidence.supportStrength, "entails");
      assert.equal(project(imported, 0, runLevel).evidence.supportStrength, "entails");
    }
  });

  it("a single-model envelope with producedBy projects as before on every Surface", async () => {
    const imported = importExtractionEnvelope(await servedBy(["generic-model", "generic-model"]), options());
    for (const index of [0, 1]) {
      assert.equal(imported.reviewItems[index]!.spec.candidates[0]!.extraction.model, "generic-model");
      const projection = project(imported, index);
      assert.deepEqual(projection.gaps, []);
      assert.equal(restoreReviewedExtractionEvidence(projection.evidence).evidenceId, `bridge-evidence-model-${index}`);
    }
  });

  it("a rejected decision degrades to cited support with the typed gap, through the same bridge", async () => {
    const imported = importExtractionEnvelope(await readFile(fixtureUrl, "utf8"), options());
    const item = imported.reviewItems[0]!;
    const decision: ReviewDecision = {
      apiVersion: "survey.kontourai.io/v1alpha1",
      kind: "ReviewDecision",
      metadata: { name: `${item.metadata.name}-decision` },
      spec: { reviewItemName: item.metadata.name, status: "rejected", resolution: "rejected" },
    };
    const projection = projectReviewedExtractionEvidence({
      evidenceId: "bridge-evidence-2",
      claimId: "fixture:title",
      proposalIndex: 0,
      importRecord: toSurfaceReviewedExtractionImport(imported.record),
      reviewItem: toSurfaceReviewedExtractionItem(item),
      reviewDecision: toSurfaceReviewedExtractionDecision(decision),
      collectedBy: "survey-bridge-test",
      structuralTrust: "validated",
    });
    assert.equal(projection.evidence.supportStrength, "cited");
    assert.ok(projection.gaps.some((gap) => gap.kind === "review-not-accepted"));
  });
});
