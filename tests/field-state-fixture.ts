/**
 * Minimal envelopes for field-state and carry-forward tests, built through the
 * real importer so every item, candidate and diagnostic is exactly what a
 * producer gets.
 */
import {
  importExtractionEnvelope,
  type ExtractionEnvelopeImportResult,
  type PortableExtractionProposal,
  type PortableExtractionResultEnvelope,
} from "../src/extraction-envelope.js";
import type { FieldSlot } from "../src/field-states.js";
import { sha256Hex } from "../src/sha256.js";

export interface FieldProposalSeed {
  readonly field: string;
  readonly value: unknown;
  readonly excerpt: string;
  readonly confidence?: number;
}

export interface FieldEnvelopeOptions {
  readonly runId?: string;
  readonly importName?: string;
  /** A typed partial run that lost the second half of the text (`content-truncated`). */
  readonly partial?: boolean;
  /** Proposal indices whose excerpt is not at their span in the supplied text. */
  readonly mismatched?: readonly number[];
}

export const SUBJECT = { subjectType: "vendor", subjectId: "acme", facet: "vendor.contract", claimType: "vendor.field" } as const;

export function slot(field: string): FieldSlot {
  return { ...SUBJECT, fieldOrBehavior: field };
}

/** Imports seeds laid out end to end in one prepared text; the import is verified against that text. */
export function importFields(seeds: readonly FieldProposalSeed[], options: FieldEnvelopeOptions = {}): ExtractionEnvelopeImportResult {
  let cursor = 0;
  const spans = seeds.map((seed) => {
    const start = cursor;
    cursor = start + seed.excerpt.length + 1;
    return { start, end: start + seed.excerpt.length };
  });
  const text = seeds.map((seed) => seed.excerpt).join(" ") + " ".repeat(40);
  // A mismatched proposal's excerpt is not what the verified text holds at its span.
  const verifiedText = [...text].map((char, index) =>
    (options.mismatched ?? []).some((proposal) => index >= spans[proposal]!.start && index < spans[proposal]!.end) ? "#" : char).join("");
  const digest = sha256Hex(verifiedText);
  const identity = { format: "traverse-prepared-artifact" as const, version: 1 as const, digest, preparationMode: "text", preparationVersion: "1", contentLength: verifiedText.length, sourceSnapshotRef: "snapshot:field-states" };
  const preparedArtifact = { ...identity, ref: `traverse-prepared-artifact:v1:sha256:${sha256Hex(JSON.stringify({ ...identity }))}` };
  const proposals: PortableExtractionProposal[] = seeds.map((seed, index) => ({
    fieldPath: seed.field,
    candidateValue: seed.value,
    ...(seed.confidence !== undefined ? { confidence: seed.confidence } : {}),
    extractor: "field-state-fixture",
    provenance: {
      excerpt: seed.excerpt,
      locator: `chars:${spans[index]!.start}-${spans[index]!.end}`,
      occurrence: { resolverVersion: "exact-occurrence-v1", count: 1, selected: { index: 0, start: spans[index]!.start, end: spans[index]!.end }, selection: "source-order", hintUsed: false, ambiguous: false },
    },
  }));
  const half = Math.floor(verifiedText.length / 2);
  const envelope: PortableExtractionResultEnvelope = {
    format: "traverse-extraction-result",
    version: 1,
    source: { ref: "https://example.test/acme-contract.pdf", snapshotRef: "snapshot:field-states" },
    result: {
      proposals,
      provider: "field-state-fixture",
      runId: options.runId ?? "traverse-extraction-run:00000000-0000-4000-8000-0000000000f5",
      raw: {},
      outcome: options.partial ? { status: "partial", reason: "content-truncated" } : { status: "success" },
      ...(options.partial ? {
        partial: { reason: "content-truncated" as const, completedChunks: 1, remainingChunks: 0 },
        coverage: [
          { chunk: 1, start: 0, end: half, status: "complete" as const },
          { chunk: 2, start: half, end: verifiedText.length, status: "unread" as const, reason: "content-truncated" as const },
        ],
      } : {}),
      extractedAt: "2026-09-28T10:00:00.000Z",
      providerCalls: 1,
      totalTokensUsed: 10,
      preparedArtifact,
      preparedArtifactState: { status: "available", requestedRef: preparedArtifact.ref, canonicalRef: preparedArtifact.ref },
    },
  };
  return importExtractionEnvelope(envelope, {
    ...(options.importName ? { importName: options.importName } : {}),
    sourceKind: "uploaded-document",
    claimTarget: (proposal) => ({ ...SUBJECT, fieldOrBehavior: proposal.fieldPath, impactLevel: "medium" }),
    artifact: { status: "available", text: verifiedText, actualDigest: digest },
  });
}
