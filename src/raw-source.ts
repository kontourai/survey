import type { LocatorScheme, ProvenanceResolution, RawSource, RawSourceKind } from "./types.js";

export type ChecksumInput = string | {
  algorithm?: string;
  value: string;
};

export interface RawSourceInput {
  id?: string;
  sourceRef: string;
  observedAt: string;
  resolution?: ProvenanceResolution;
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

export interface PolicyStandardMetadata {
  inlineText: string;
  standardVersion: string;
  paragraphRef?: string;
  reference?: string;
}

export interface PolicyStandardSourceInput extends Omit<RawSourceInput, "locatorScheme" | "metadata"> {
  inlineText: string;
  standardVersion: string;
  paragraphRef?: string;
  reference?: string;
  locatorScheme?: LocatorScheme;
  metadata?: Record<string, unknown>;
}

/**
 * Raw Source kinds whose factories accept a caller-supplied `locatorScheme`
 * override and otherwise fall back to a per-kind default. `uploaded-document`
 * has no default (`undefined`) because `UploadedDocumentSourceInput.locatorScheme`
 * is required, not optional — modeled here as a real, explicit table entry
 * rather than an omission, so a caller-supplied value is the only source of
 * truth for that kind.
 *
 * Module-internal seam: consumed by relative import from
 * `rawSourceWithDefaultLocatorScheme` below and by
 * `tests/raw-source-defaults.test.ts`, NOT re-exported from `src/index.ts`.
 */
export const DEFAULT_LOCATOR_SCHEME: {
  "uploaded-document": undefined;
  "api-record": LocatorScheme;
  "web-page": LocatorScheme;
  "manual-entry": LocatorScheme;
} = {
  "uploaded-document": undefined,
  "api-record": "structured-field",
  "web-page": "html",
  "manual-entry": "structured-field",
};

type LocatorSchemeDefaultKind = keyof typeof DEFAULT_LOCATOR_SCHEME;

function rawSourceWithDefaultLocatorScheme(
  kind: LocatorSchemeDefaultKind,
  input: Omit<RawSourceInput, "locatorScheme"> & { locatorScheme?: LocatorScheme },
): RawSource {
  return rawSource(kind, {
    locatorScheme: DEFAULT_LOCATOR_SCHEME[kind],
    ...input,
  } as RawSourceInput);
}

export function uploadedDocumentSource(input: UploadedDocumentSourceInput): RawSource {
  return rawSourceWithDefaultLocatorScheme("uploaded-document", input);
}

export function apiRecordSource(input: ApiRecordSourceInput): RawSource {
  return rawSourceWithDefaultLocatorScheme("api-record", input);
}

export function webPageSource(input: WebPageSourceInput): RawSource {
  return rawSourceWithDefaultLocatorScheme("web-page", input);
}

export function manualEntrySource(input: ManualEntrySourceInput): RawSource {
  return rawSourceWithDefaultLocatorScheme("manual-entry", input);
}

export function policyStandardSource(input: PolicyStandardSourceInput): RawSource {
  const policyStandard: PolicyStandardMetadata = {
    inlineText: input.inlineText,
    standardVersion: input.standardVersion,
    paragraphRef: input.paragraphRef,
    reference: input.reference,
  };

  const source = rawSource("policy-standard", {
    locatorScheme: "text",
    ...input,
    metadata: {
      ...input.metadata,
      policyStandard,
    },
  });

  return {
    ...source,
    inlineText: input.inlineText,
    standardVersion: input.standardVersion,
    paragraphRef: input.paragraphRef,
  };
}

function rawSource(kind: RawSourceKind, input: RawSourceInput): RawSource {
  return {
    id: input.id ?? sourceId(kind, input.sourceRef),
    kind,
    resolution: input.resolution,
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
