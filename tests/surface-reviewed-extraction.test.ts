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
  type ReviewDecision,
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
