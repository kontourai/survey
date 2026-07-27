/**
 * Builds a review queue in the exact shape a producer gets from
 * `importExtractionEnvelope`: one `proposed` candidate per field, no `current`
 * candidate, `editable: false`, and a declared value type. This is the shape the
 * embedded workbench mis-handled in kontourai/survey#201 and #203, so the
 * regression cover — node and browser alike — drives the real importer rather
 * than a hand-written approximation of what it emits.
 */
import { importExtractionEnvelope, type PortableExtractionProposal } from "../src/extraction-envelope.js";
import type { ExtractionInspectorEntry } from "../src/review-workbench/extraction-inspector.js";
import { initialReviewQueueSessionState, type ReviewQueueSessionState } from "../src/review-workbench/review-queue-session.js";
import { sha256Hex } from "../src/sha256.js";

export interface EnvelopeProposalSeed {
  readonly fieldPath: string;
  readonly candidateValue: unknown;
  readonly excerpt: string;
  readonly valueType: PortableExtractionProposal["valueType"];
  readonly enumValues?: string[];
}

/** One seed per declared value type, matching the queue the defects were found on. */
export const envelopeQueueSeeds: readonly EnvelopeProposalSeed[] = [
  { fieldPath: "vendor.name", candidateValue: "Northwind Supply", excerpt: "Northwind Supply", valueType: "string" },
  { fieldPath: "commercial.annualFeeUsd", candidateValue: 48000, excerpt: "48000", valueType: "number" },
  { fieldPath: "renewal.date", candidateValue: "2027-03-31", excerpt: "2027-03-31", valueType: "date" },
  {
    fieldPath: "renewal.posture",
    candidateValue: "auto-renew",
    excerpt: "auto-renew",
    valueType: "enum",
    enumValues: ["auto-renew", "manual"],
  },
];

/**
 * A queue with more candidates than one mounted page, so paging and filtering
 * are actually exercised. Field paths and excerpts are distinct so a filter can
 * select a strict subset, and every excerpt has its own span in the prepared
 * text.
 */
export function paginatingEnvelopeSeeds(count: number): readonly EnvelopeProposalSeed[] {
  return Array.from({ length: count }, (_unused, index) => ({
    fieldPath: `line.item${String(index).padStart(2, "0")}`,
    candidateValue: `value-${index}`,
    excerpt: `LineItem${String(index).padStart(2, "0")}`,
    valueType: "string" as const,
  }));
}

const SOURCE_REF = "https://example.test/contract.pdf";
const SNAPSHOT_REF = "snapshot:envelope-review-fixture";
const RUN_ID = "traverse-extraction-run:00000000-0000-4000-8000-00000000f001";

/**
 * The prepared-artifact text the proposals are located in: the excerpts laid out
 * end to end so every `chars:start-end` locator resolves to its own excerpt.
 */
export function envelopeArtifactText(seeds: readonly EnvelopeProposalSeed[] = envelopeQueueSeeds): string {
  return seeds.map((seed) => seed.excerpt).join(" ");
}

function buildProposals(seeds: readonly EnvelopeProposalSeed[]): PortableExtractionProposal[] {
  let cursor = 0;
  return seeds.map((seed) => {
    const start = cursor;
    const end = start + seed.excerpt.length;
    cursor = end + 1; // the single-space separator in envelopeArtifactText
    return {
      fieldPath: seed.fieldPath,
      candidateValue: seed.candidateValue,
      confidence: 0.9,
      extractor: "envelope-fixture",
      inferenceType: "explicit" as const,
      valueType: seed.valueType,
      ...(seed.enumValues ? { enumValues: [...seed.enumValues] } : {}),
      provenance: {
        excerpt: seed.excerpt,
        locator: `chars:${start}-${end}`,
        occurrence: {
          resolverVersion: "exact-occurrence-v1" as const,
          count: 1,
          selected: { index: 0, start, end },
          selection: "source-order" as const,
          hintUsed: false,
          ambiguous: false,
        },
      },
    };
  });
}

function buildPreparedArtifact(text: string): {
  format: "traverse-prepared-artifact";
  version: 1;
  digest: string;
  ref: string;
  preparationMode: string;
  preparationVersion: string;
  contentLength: number;
  sourceSnapshotRef: string;
} {
  const digest = sha256Hex(text);
  const identity = {
    format: "traverse-prepared-artifact" as const,
    version: 1 as const,
    digest,
    preparationMode: "text",
    preparationVersion: "1",
    contentLength: text.length,
    sourceSnapshotRef: SNAPSHOT_REF,
  };
  // Mirrors the identity binding asserted by validateArtifact in extraction-envelope.ts.
  const binding = JSON.stringify({ ...identity, sourceSnapshotRef: identity.sourceSnapshotRef ?? null });
  return { ...identity, ref: `traverse-prepared-artifact:v1:sha256:${sha256Hex(binding)}` };
}

export function buildEnvelopeImportFixture(seeds: readonly EnvelopeProposalSeed[] = envelopeQueueSeeds) {
  const text = envelopeArtifactText(seeds);
  const preparedArtifact = buildPreparedArtifact(text);

  return importExtractionEnvelope({
    format: "traverse-extraction-result",
    version: 1,
    source: { ref: SOURCE_REF, snapshotRef: SNAPSHOT_REF },
    result: {
      proposals: buildProposals(seeds),
      provider: "envelope-fixture",
      model: "envelope-fixture-model",
      runId: RUN_ID,
      raw: { tokensUsed: 12 },
      outcome: { status: "success" },
      extractedAt: "2026-06-04T00:00:00.000Z",
      providerCalls: 1,
      totalTokensUsed: 12,
      preparedArtifact,
      preparedArtifactState: {
        status: "available",
        requestedRef: preparedArtifact.ref,
        canonicalRef: preparedArtifact.ref,
      },
    },
  }, {
    sourceKind: "uploaded-document",
    claimTarget: (proposal) => ({
      subjectType: "vendor.entity",
      subjectId: "vendor-1",
      facet: "vendor.contract",
      claimType: "vendor.field-candidate",
      fieldOrBehavior: proposal.fieldPath,
      impactLevel: "medium",
    }),
  });
}

export function envelopeReviewQueueSession(
  seeds: readonly EnvelopeProposalSeed[] = envelopeQueueSeeds,
): ReviewQueueSessionState {
  return initialReviewQueueSessionState(buildEnvelopeImportFixture(seeds).reviewItems);
}

/** Import plus its resolved artifact, ready for `buildExtractionInspectorModel`. */
export function envelopeInspectorEntry(
  seeds: readonly EnvelopeProposalSeed[] = envelopeQueueSeeds,
): ExtractionInspectorEntry {
  const text = envelopeArtifactText(seeds);
  return {
    importResult: buildEnvelopeImportFixture(seeds),
    artifact: { status: "available", text, actualDigest: sha256Hex(text) },
  };
}
