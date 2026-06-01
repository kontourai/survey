import type { LocatorScheme, RawSource, RawSourceKind } from "./types.js";

export type ChecksumInput = string | {
  algorithm?: string;
  value: string;
};

export interface RawSourceInput {
  id?: string;
  sourceRef: string;
  observedAt: string;
  fetchedAt?: string;
  checksum?: ChecksumInput;
  locatorScheme: LocatorScheme;
  metadata?: Record<string, unknown>;
}

export interface UploadedDocumentSourceInput extends RawSourceInput {
  locatorScheme: LocatorScheme;
}

export interface ApiRecordSourceInput extends Omit<RawSourceInput, "locatorScheme"> {
  locatorScheme?: LocatorScheme;
}

export interface WebPageSourceInput extends Omit<RawSourceInput, "locatorScheme"> {
  locatorScheme?: LocatorScheme;
}

export interface ManualEntrySourceInput extends Omit<RawSourceInput, "checksum" | "locatorScheme"> {
  checksum?: ChecksumInput;
  locatorScheme?: LocatorScheme;
}

export function uploadedDocumentSource(input: UploadedDocumentSourceInput): RawSource {
  return rawSource("uploaded-document", input);
}

export function apiRecordSource(input: ApiRecordSourceInput): RawSource {
  return rawSource("api-record", {
    locatorScheme: "structured-field",
    ...input,
  });
}

export function webPageSource(input: WebPageSourceInput): RawSource {
  return rawSource("web-page", {
    locatorScheme: "html",
    ...input,
  });
}

export function manualEntrySource(input: ManualEntrySourceInput): RawSource {
  return rawSource("manual-entry", {
    locatorScheme: "structured-field",
    ...input,
  });
}

function rawSource(kind: RawSourceKind, input: RawSourceInput): RawSource {
  return {
    id: input.id ?? sourceId(kind, input.sourceRef),
    kind,
    sourceRef: input.sourceRef,
    observedAt: input.observedAt,
    fetchedAt: input.fetchedAt,
    checksum: normalizeChecksum(input.checksum),
    locatorScheme: input.locatorScheme,
    metadata: input.metadata,
  };
}

function sourceId(kind: RawSourceKind, sourceRef: string): string {
  return `${kind}:${sourceRef}`;
}

function normalizeChecksum(checksum: ChecksumInput | undefined): string | undefined {
  if (!checksum) return undefined;

  if (typeof checksum === "string") {
    if (checksum.includes(":")) return checksum;
    return `sha256:${checksum}`;
  }

  if (checksum.value.includes(":")) return checksum.value;
  return `${checksum.algorithm ?? "sha256"}:${checksum.value}`;
}
