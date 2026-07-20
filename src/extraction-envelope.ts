import { createHash, randomUUID } from "node:crypto";
import type { RawSource } from "./types.js";
import type { ClaimTargetHint, ReviewCandidate, ReviewItem, ReviewValueType } from "./review-resource.js";
import { reviewResourceApiVersion } from "./review-resource.js";
import { canonicalJson } from "./review-workbench/canonical.js";

/** The upstream-owned portable extraction-result wire identifiers accepted by this adapter. */
export const portableExtractionResultFormat = "traverse-extraction-result";
export const portableExtractionResultVersion = 1;
export const extractionEnvelopeImportApiVersion = "survey.kontourai.io/v1alpha1";

export interface PortableExtractionOccurrence {
  resolverVersion: "exact-occurrence-v1";
  count: number;
  selected: { index: number; start: number; end: number };
  selection: "source-order" | "occurrence-hint";
  hintUsed: boolean;
  ambiguous: boolean;
}

export interface PortableExtractionProposal {
  fieldPath: string;
  candidateValue: unknown;
  confidence: number;
  provenance: { excerpt: string; locator: string; occurrence: PortableExtractionOccurrence };
  extractor: string;
  pathIndices?: number[];
  inferenceType?: "explicit" | "inferred";
  valueType?: ReviewValueType;
  enumValues?: string[];
}

export type PortablePreparedArtifactState =
  | { status: "available" | "unavailable" | "storage-error"; requestedRef: string; canonicalRef: string }
  | { status: "identity-mismatch"; requestedRef: string; canonicalRef: string }
  | { status: "invalid-artifact"; reason: string; canonicalRef: string }
  | { status: "digest-mismatch"; requestedRef: string; canonicalRef: string; actualDigest: string; actualContentLength: number };

export interface PortableExtractionResultEnvelope {
  format: typeof portableExtractionResultFormat;
  version: typeof portableExtractionResultVersion;
  source: { ref: string; snapshotRef?: string };
  result: {
    proposals: PortableExtractionProposal[];
    provider: string;
    model?: string;
    runId: string;
    raw: { tokensUsed?: number };
    outcome:
      | { status: "success" }
      | { status: "partial"; reason: "cancelled" | "max-provider-calls" | "max-total-tokens" }
      | { status: "failure"; category: "invalid-config" | "invalid-task" | "preparation" | "provider" | "unexpected"; code: string };
    warningClassifications?: Array<{ category: "provider" | "normalization" | "preparation" | "limit" | "storage" | "content" | "other"; code: string }>;
    extractedAt: string;
    providerCalls: number;
    totalTokensUsed: number;
    partial?: { reason: "cancelled" | "max-provider-calls" | "max-total-tokens"; completedChunks: number; remainingChunks: number; tokenOvershoot?: number };
    providerFailures?: Array<{ provider: string; kind: "authentication" | "rate-limit" | "timeout" | "invalid-request" | "unavailable" | "unknown"; retryable: boolean }>;
    taskDigest?: string;
    exampleDigests?: string[];
    pdfPageOffsets?: number[];
    ocrDerived?: true;
    preparedArtifact?: {
      format: "traverse-prepared-artifact";
      version: 1;
      digest: string;
      ref: string;
      preparationMode: string;
      preparationVersion: string;
      contentLength: number;
      sourceSnapshotRef?: string;
    };
    preparedArtifactState?: PortablePreparedArtifactState;
  };
}

export interface ExtractionEnvelopeImportOptions {
  /** Stable Survey import identity. Defaults to the upstream run id. */
  importName?: string;
  /** Producer namespace used to avoid cross-producer identity collisions. */
  producerNamespace?: string;
  sourceKind: RawSource["kind"];
  /** Survey meaning is supplied at the boundary; it is not added to the upstream wire contract. */
  claimTarget: (proposal: PortableExtractionProposal, index: number) => ClaimTargetHint;
}

export type ExtractionEnvelopeImportDiagnostic =
  | { kind: "artifact-unavailable"; status: "unavailable" | "storage-error" | "identity-mismatch" | "invalid-artifact"; artifactRef?: string; message: string }
  | { kind: "digest-mismatch"; artifactRef: string; expectedDigest: string; actualDigest: string; message: string };

export interface ExtractionEnvelopeImport {
  apiVersion: typeof extractionEnvelopeImportApiVersion;
  kind: "ExtractionEnvelopeImport";
  metadata: { name: string; producerNamespace: string };
  spec: { envelope: PortableExtractionResultEnvelope; sourceKind: RawSource["kind"]; claimTargets: ClaimTargetHint[] };
  status: { state: "grounded" | "unresolved"; diagnostics: ExtractionEnvelopeImportDiagnostic[] };
}

export interface ExtractionEnvelopeImportResult { record: ExtractionEnvelopeImport; reviewItems: ReviewItem[] }
export interface ExtractionEnvelopeResolutionIdentity { evidenceId: string; eventId: string }

/** Parse an untrusted upstream document and create Survey's durable import projection. */
export function importExtractionEnvelope(serialized: string | PortableExtractionResultEnvelope, options: ExtractionEnvelopeImportOptions): ExtractionEnvelopeImportResult {
  let parsed: unknown;
  if (typeof serialized === "string") {
    try { parsed = JSON.parse(serialized); } catch { throw new Error("Portable extraction envelope is not valid JSON."); }
  } else parsed = serialized;
  const envelope = validateEnvelope(parsed);
  const claimTargets = envelope.result.proposals.map(options.claimTarget);
  claimTargets.forEach(validateClaimTarget);
  const name = options.importName ?? envelope.result.runId;
  const producerNamespace = options.producerNamespace ?? envelope.result.provider;
  nonEmpty(name, "Extraction envelope import name");
  nonEmpty(producerNamespace, "Extraction envelope producer namespace");
  const diagnostics = diagnosticsFor(envelope);
  const record: ExtractionEnvelopeImport = {
    apiVersion: extractionEnvelopeImportApiVersion,
    kind: "ExtractionEnvelopeImport",
    metadata: { name, producerNamespace },
    spec: { envelope, sourceKind: options.sourceKind, claimTargets: cloneJson(claimTargets) as ClaimTargetHint[] },
    status: { state: diagnostics.length ? "unresolved" : "grounded", diagnostics },
  };
  return { record, reviewItems: buildReviewItemsFromExtractionEnvelopeImport(record) };
}

export function buildReviewItemsFromExtractionEnvelopeImport(record: ExtractionEnvelopeImport): ReviewItem[] {
  validateImport(record);
  if (record.status.state !== "grounded") return [];
  return record.spec.envelope.result.proposals.map((proposal, index) => buildReviewItem(record, proposal, index));
}

export function exportExtractionEnvelopeImport(record: ExtractionEnvelopeImport): string {
  validateImport(record);
  return canonicalJson(record);
}

export function reimportExtractionEnvelope(serialized: string): ExtractionEnvelopeImport {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new Error("Extraction envelope import is not valid JSON."); }
  validateImport(parsed);
  return cloneJson(parsed) as ExtractionEnvelopeImport;
}

export function createExtractionEnvelopeResolutionIdentity(record: ExtractionEnvelopeImport, proposalIndex: number): ExtractionEnvelopeResolutionIdentity {
  validateImport(record);
  if (!Number.isSafeInteger(proposalIndex) || proposalIndex < 0 || proposalIndex >= record.spec.envelope.result.proposals.length) {
    throw new Error(`Extraction envelope import ${record.metadata.name} has no proposal at index ${proposalIndex}.`);
  }
  const base = identityHash(identityInputs(record, record.spec.envelope.result.proposals[proposalIndex]!, proposalIndex));
  const nonce = randomUUID();
  return { evidenceId: `survey.extraction.${base}.resolution-evidence.${nonce}`, eventId: `survey.extraction.${base}.resolution-event.${nonce}` };
}

function buildReviewItem(record: ExtractionEnvelopeImport, proposal: PortableExtractionProposal, index: number): ReviewItem {
  const envelope = record.spec.envelope;
  const identity = identityHash(identityInputs(record, proposal, index));
  const evidence = identityHash(evidenceInputs(record, proposal));
  const target = record.spec.claimTargets[index]!;
  const valueType = proposal.valueType ?? inferValueType(proposal.candidateValue);
  const candidate: ReviewCandidate = {
    id: `extraction-envelope.${identity}.proposed`, role: "proposed", value: proposal.candidateValue,
    confidence: proposal.confidence,
    source: {
      sourceRef: envelope.source.ref,
      sourceId: envelope.source.snapshotRef ?? envelope.source.ref,
      kind: record.spec.sourceKind,
      observedAt: envelope.result.extractedAt,
      ...(envelope.result.preparedArtifact?.digest ? { checksum: envelope.result.preparedArtifact.digest } : {}),
      locatorScheme: "text-span",
    },
    locator: { scheme: "text-span", locator: proposal.provenance.locator, excerpt: proposal.provenance.excerpt },
    extraction: {
      extractionId: `extraction-envelope.${identity}`,
      target: proposal.fieldPath,
      confidence: proposal.confidence,
      extractor: proposal.extractor,
      ...(envelope.result.model ? { model: envelope.result.model } : {}),
    },
    claimTarget: target,
    producer: { "survey.kontourai.io/extraction-envelope": {
      importName: record.metadata.name, proposalIndex: index,
      evidenceId: `survey.extraction.${evidence}.source-evidence`,
      runId: envelope.result.runId, provider: envelope.result.provider,
      ...(envelope.result.model ? { model: envelope.result.model } : {}),
      ...(envelope.result.taskDigest ? { taskDigest: envelope.result.taskDigest } : {}),
      ...(envelope.result.exampleDigests ? { exampleDigests: envelope.result.exampleDigests } : {}),
      valueType: { type: valueType, origin: proposal.inferenceType ?? "inferred" },
      occurrence: proposal.provenance.occurrence,
      attempt: { id: envelope.result.runId, providerCalls: envelope.result.providerCalls },
      ...(envelope.result.warningClassifications ? { warnings: envelope.result.warningClassifications } : {}),
      outcome: envelope.result.outcome,
    } },
  };
  return {
    apiVersion: reviewResourceApiVersion, kind: "ReviewItem",
    metadata: { name: `extraction-envelope.${identity}`, producer: { "survey.kontourai.io/extraction-envelope": {
      importName: record.metadata.name,
      evidenceId: `survey.extraction.${evidence}.source-evidence`,
      source: envelope.source,
      ...(envelope.result.preparedArtifact ? { preparedArtifact: envelope.result.preparedArtifact } : {}),
    } } },
    spec: { target: proposal.fieldPath, candidates: [candidate], candidateSetStatus: "needs-review", valueDescriptor: { type: valueType }, editable: false },
    status: { observedCandidateCount: 1 },
  };
}

function identityInputs(record: ExtractionEnvelopeImport, proposal: PortableExtractionProposal, index: number): unknown {
  return { producerNamespace: record.metadata.producerNamespace, importName: record.metadata.name, source: record.spec.envelope.source,
    preparedArtifact: record.spec.envelope.result.preparedArtifact, runId: record.spec.envelope.result.runId,
    proposalIndex: index, proposal, claimTarget: record.spec.claimTargets[index] };
}
function evidenceInputs(record: ExtractionEnvelopeImport, proposal: PortableExtractionProposal): unknown {
  return { producerNamespace: record.metadata.producerNamespace, importName: record.metadata.name, source: record.spec.envelope.source,
    sourceKind: record.spec.sourceKind, preparedArtifact: record.spec.envelope.result.preparedArtifact,
    extractedAt: record.spec.envelope.result.extractedAt,
    provenance: proposal.provenance };
}

function diagnosticsFor(envelope: PortableExtractionResultEnvelope): ExtractionEnvelopeImportDiagnostic[] {
  const state = envelope.result.preparedArtifactState;
  if (!state || state.status === "available") return [];
  if (state.status === "digest-mismatch") return [{ kind: "digest-mismatch", artifactRef: state.canonicalRef,
    expectedDigest: envelope.result.preparedArtifact!.digest, actualDigest: state.actualDigest,
    message: "Prepared artifact digest does not match the expected extraction artifact." }];
  return [{ kind: "artifact-unavailable", status: state.status,
    ...(state.status === "invalid-artifact" ? { artifactRef: state.canonicalRef } : { artifactRef: state.requestedRef }),
    message: `Prepared artifact resolution is ${state.status}.` }];
}

function validateImport(value: unknown): asserts value is ExtractionEnvelopeImport {
  jsonSafe(value, "Extraction envelope import");
  const record = obj(value, "Extraction envelope import");
  exact(record, ["apiVersion", "kind", "metadata", "spec", "status"], "Extraction envelope import");
  if (record.apiVersion !== extractionEnvelopeImportApiVersion || record.kind !== "ExtractionEnvelopeImport") throw new Error("Invalid extraction envelope import resource identity.");
  const metadata = obj(record.metadata, "metadata"); exact(metadata, ["name", "producerNamespace"], "metadata"); nonEmpty(metadata.name, "metadata.name"); nonEmpty(metadata.producerNamespace, "metadata.producerNamespace");
  const spec = obj(record.spec, "spec"); exact(spec, ["envelope", "sourceKind", "claimTargets"], "spec");
  const envelope = validateEnvelope(spec.envelope);
  if (!RAW_SOURCE_KINDS.has(spec.sourceKind as RawSource["kind"])) throw new Error("spec.sourceKind is invalid.");
  const targets = array(spec.claimTargets, "spec.claimTargets"); targets.forEach(validateClaimTarget);
  if (targets.length !== envelope.result.proposals.length) throw new Error("spec.claimTargets must align with proposals.");
  const status = obj(record.status, "status"); exact(status, ["state", "diagnostics"], "status");
  const expected = diagnosticsFor(envelope);
  if (canonicalJson(status.diagnostics) !== canonicalJson(expected) || status.state !== (expected.length ? "unresolved" : "grounded")) throw new Error("Import status does not match envelope state.");
}

function validateEnvelope(input: unknown): PortableExtractionResultEnvelope {
  jsonSafe(input, "Portable extraction envelope");
  const e = obj(input, "envelope"); exact(e, ["format", "version", "source", "result"], "envelope");
  if (e.format !== portableExtractionResultFormat || e.version !== portableExtractionResultVersion) throw new Error("Unsupported portable extraction envelope format or version.");
  const source = obj(e.source, "source"); exact(source, ["ref"], "source", ["snapshotRef"]); safeReference(source.ref, "source.ref"); if (source.snapshotRef !== undefined) safeReference(source.snapshotRef, "source.snapshotRef");
  const r = obj(e.result, "result");
  exact(r, ["proposals", "provider", "runId", "raw", "outcome", "extractedAt", "providerCalls", "totalTokensUsed"], "result", ["model", "warningClassifications", "partial", "providerFailures", "taskDigest", "exampleDigests", "pdfPageOffsets", "ocrDerived", "preparedArtifact", "preparedArtifactState"]);
  stableIdentity(r.provider, "result.provider"); if (r.model !== undefined) stableIdentity(r.model, "result.model"); if (typeof r.runId !== "string" || !RUN_ID.test(r.runId)) throw new Error("result.runId is invalid."); wireNonEmpty(r.extractedAt, "result.extractedAt"); integer(r.providerCalls, "result.providerCalls"); integer(r.totalTokensUsed, "result.totalTokensUsed");
  const raw = obj(r.raw, "result.raw"); exact(raw, [], "result.raw", ["tokensUsed"]); if (raw.tokensUsed !== undefined) integer(raw.tokensUsed, "result.raw.tokensUsed");
  validateOutcome(r.outcome, r.partial);
  if (r.warningClassifications !== undefined) array(r.warningClassifications, "warnings").forEach(validateWarning);
  if (r.providerFailures !== undefined) array(r.providerFailures, "providerFailures").forEach(validateFailure);
  optionalDigest(r.taskDigest, "result.taskDigest"); if (r.exampleDigests !== undefined) array(r.exampleDigests, "exampleDigests").forEach((v) => digest(v, "exampleDigest"));
  if (r.pdfPageOffsets !== undefined) { const offsets = array(r.pdfPageOffsets, "pdfPageOffsets"); offsets.forEach((v) => integer(v, "pageOffset")); if (offsets.some((v, i) => i > 0 && (v as number) <= (offsets[i - 1] as number))) throw new Error("pdfPageOffsets must ascend strictly."); }
  if (r.ocrDerived !== undefined && r.ocrDerived !== true) throw new Error("result.ocrDerived must be true.");
  const artifact = r.preparedArtifact === undefined ? undefined : validateArtifact(r.preparedArtifact);
  const state = r.preparedArtifactState === undefined ? undefined : validateArtifactState(r.preparedArtifactState, artifact);
  if (source.snapshotRef !== undefined && artifact?.sourceSnapshotRef !== undefined && source.snapshotRef !== artifact.sourceSnapshotRef) throw new Error("Source snapshot identity mismatch.");
  const proposals = array(r.proposals, "result.proposals").map((p, i) => validateProposal(p, i, artifact?.contentLength));
  return cloneJson({ ...e, source, result: { ...r, proposals, ...(artifact ? { preparedArtifact: artifact } : {}), ...(state ? { preparedArtifactState: state } : {}) } }) as PortableExtractionResultEnvelope;
}

function validateProposal(input: unknown, index: number, contentLength?: number): PortableExtractionProposal {
  const p = obj(input, `proposal[${index}]`); exact(p, ["fieldPath", "candidateValue", "confidence", "provenance", "extractor"], `proposal[${index}]`, ["pathIndices", "inferenceType", "valueType", "enumValues"]);
  wireNonEmpty(p.fieldPath, "proposal.fieldPath"); stableIdentity(p.extractor, "proposal.extractor"); finite(p.confidence, "proposal.confidence", 0, 1);
  const provenance = obj(p.provenance, "proposal.provenance"); exact(provenance, ["excerpt", "locator", "occurrence"], "proposal.provenance"); wireNonEmpty(provenance.excerpt, "proposal.provenance.excerpt");
  if (typeof provenance.locator !== "string") throw new Error("proposal locator must be chars:start-end.");
  const match = /^chars:(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(provenance.locator); if (!match) throw new Error("proposal locator must be chars:start-end.");
  const start = Number(match[1]), end = Number(match[2]); if (end < start || end - start !== (provenance.excerpt as string).length || (contentLength !== undefined && end > contentLength)) throw new Error("proposal locator/excerpt span is incoherent.");
  validateOccurrence(provenance.occurrence, start, end);
  if (p.pathIndices !== undefined) array(p.pathIndices, "pathIndices").forEach((v) => integer(v, "pathIndex"));
  if (p.inferenceType !== undefined && p.inferenceType !== "explicit" && p.inferenceType !== "inferred") throw new Error("proposal inferenceType is invalid.");
  if (p.valueType !== undefined && !VALUE_TYPES.has(p.valueType as ReviewValueType)) throw new Error("proposal valueType is invalid.");
  if (p.enumValues !== undefined) array(p.enumValues, "enumValues").forEach((v) => wellFormedString(v, "enumValue"));
  return cloneJson(p) as unknown as PortableExtractionProposal;
}

function validateOccurrence(input: unknown, start: number, end: number): void { const o = obj(input, "occurrence"); exact(o, ["resolverVersion", "count", "selected", "selection", "hintUsed", "ambiguous"], "occurrence"); if (o.resolverVersion !== "exact-occurrence-v1") throw new Error("occurrence resolver version is invalid."); integer(o.count, "occurrence.count"); const s = obj(o.selected, "occurrence.selected"); exact(s, ["index", "start", "end"], "occurrence.selected"); integer(s.index, "selected.index"); integer(s.start, "selected.start"); integer(s.end, "selected.end"); if (s.start !== start || s.end !== end || (s.index as number) >= (o.count as number) || (o.count as number) < 1) throw new Error("occurrence selection is incoherent."); if (o.selection !== "source-order" && o.selection !== "occurrence-hint") throw new Error("occurrence selection is invalid."); if (typeof o.hintUsed !== "boolean" || typeof o.ambiguous !== "boolean") throw new Error("occurrence flags must be booleans."); if (o.hintUsed !== (o.selection === "occurrence-hint")) throw new Error("occurrence hintUsed does not match selection."); if (o.ambiguous !== ((o.count as number) > 1)) throw new Error("occurrence ambiguous does not match count."); }
function validateArtifact(input: unknown): PortableExtractionResultEnvelope["result"]["preparedArtifact"] { const a = obj(input, "preparedArtifact"); exact(a, ["format", "version", "digest", "ref", "preparationMode", "preparationVersion", "contentLength"], "preparedArtifact", ["sourceSnapshotRef"]); if (a.format !== "traverse-prepared-artifact" || a.version !== 1) throw new Error("prepared artifact format is invalid."); digest(a.digest, "artifact.digest", false); if (!PREPARATION_MODES.has(a.preparationMode as string)) throw new Error("artifact.preparationMode is invalid."); nonEmpty(a.preparationVersion, "artifact.preparationVersion"); integer(a.contentLength, "artifact.contentLength"); if (a.sourceSnapshotRef !== undefined) wireNonEmpty(a.sourceSnapshotRef, "artifact.sourceSnapshotRef"); const binding = JSON.stringify({ format: a.format, version: a.version, digest: a.digest, preparationMode: a.preparationMode, preparationVersion: a.preparationVersion, contentLength: a.contentLength, sourceSnapshotRef: a.sourceSnapshotRef ?? null }); const expectedRef = `traverse-prepared-artifact:v1:sha256:${createHash("sha256").update(binding).digest("hex")}`; if (a.ref !== expectedRef) throw new Error("prepared artifact ref does not match its identity binding."); return cloneJson(a) as PortableExtractionResultEnvelope["result"]["preparedArtifact"]; }
function validateArtifactState(input: unknown, artifact?: PortableExtractionResultEnvelope["result"]["preparedArtifact"]): PortablePreparedArtifactState { if (!artifact) throw new Error("prepared artifact state requires prepared artifact."); const s = obj(input, "preparedArtifactState"); const status = s.status; if (status === "digest-mismatch") { exact(s, ["status", "requestedRef", "canonicalRef", "actualDigest", "actualContentLength"], "preparedArtifactState"); digest(s.actualDigest, "actualDigest", false); integer(s.actualContentLength, "actualContentLength"); } else if (status === "invalid-artifact") { exact(s, ["status", "reason", "canonicalRef"], "preparedArtifactState"); if (!ARTIFACT_INVALID_REASONS.has(s.reason as string)) throw new Error("prepared artifact invalid reason is invalid."); } else if (["available", "unavailable", "storage-error", "identity-mismatch"].includes(status as string)) exact(s, ["status", "requestedRef", "canonicalRef"], "preparedArtifactState"); else throw new Error("prepared artifact state is invalid."); preparedReference(s.canonicalRef, "canonicalRef"); if (s.canonicalRef !== artifact.ref) throw new Error("prepared artifact canonical ref mismatch."); if (s.requestedRef !== undefined) { safeReference(s.requestedRef, "requestedRef"); if (status !== "identity-mismatch") preparedReference(s.requestedRef, "requestedRef"); if (status === "identity-mismatch" ? s.requestedRef === s.canonicalRef : s.requestedRef !== s.canonicalRef) throw new Error(`prepared artifact ${status} requestedRef relationship is invalid.`); } return cloneJson(s) as PortablePreparedArtifactState; }
function validateOutcome(input: unknown, partial: unknown): void { const o = obj(input, "outcome"); if (o.status === "success") exact(o, ["status"], "outcome"); else if (o.status === "partial") { exact(o, ["status", "reason"], "outcome"); if (!PARTIAL.has(o.reason as string)) throw new Error("partial reason is invalid."); const p = obj(partial, "partial"); exact(p, ["reason", "completedChunks", "remainingChunks"], "partial", ["tokenOvershoot"]); if (p.reason !== o.reason) throw new Error("partial reason mismatch."); integer(p.completedChunks, "completedChunks"); integer(p.remainingChunks, "remainingChunks"); if (p.tokenOvershoot !== undefined) { integer(p.tokenOvershoot, "tokenOvershoot"); if (p.tokenOvershoot === 0) throw new Error("tokenOvershoot must be positive."); } } else if (o.status === "failure") { exact(o, ["status", "category", "code"], "outcome"); if (!FAILURE_CATEGORIES.has(o.category as string)) throw new Error("failure category is invalid."); stableIdentity(o.code, "failure code"); } else throw new Error("outcome status is invalid."); if (o.status !== "partial" && partial !== undefined) throw new Error("partial requires partial outcome."); }
function validateWarning(v: unknown): void { const w = obj(v, "warning"); exact(w, ["category", "code"], "warning"); if (!WARNING_CATEGORIES.has(w.category as string)) throw new Error("warning category invalid."); stableIdentity(w.code, "warning.code"); }
function validateFailure(v: unknown): void { const f = obj(v, "providerFailure"); exact(f, ["provider", "kind", "retryable"], "providerFailure"); stableIdentity(f.provider, "failure.provider"); if (!FAILURE_KINDS.has(f.kind as string) || typeof f.retryable !== "boolean") throw new Error("provider failure invalid."); }
function validateClaimTarget(v: unknown): void { const t = obj(v, "claimTarget"); exact(t, ["subjectType", "subjectId", "facet", "claimType", "fieldOrBehavior", "impactLevel"], "claimTarget", ["claimId", "evidenceType", "evidenceMethod", "collectedBy", "derivedFrom"]); for (const key of ["subjectType", "subjectId", "facet", "claimType", "fieldOrBehavior"]) nonEmpty(t[key], `claimTarget.${key}`); if (!["low", "medium", "high", "critical"].includes(t.impactLevel as string)) throw new Error("claimTarget.impactLevel invalid."); for (const key of ["claimId", "evidenceType", "evidenceMethod", "collectedBy"] as const) optionalString(t[key], `claimTarget.${key}`); if (t.derivedFrom !== undefined) array(t.derivedFrom, "claimTarget.derivedFrom").forEach((entry) => nonEmpty(entry, "claimTarget.derivedFrom entry")); }

function inferValueType(v: unknown): ReviewValueType { if (Array.isArray(v)) return "array"; if (v === null || typeof v === "object") return "object"; if (["string", "number", "boolean"].includes(typeof v)) return typeof v as ReviewValueType; return "string"; }
function obj(v: unknown, subject: string): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${subject} must be an object.`); return v as Record<string, unknown>; }
function array(v: unknown, subject: string): unknown[] { if (!Array.isArray(v)) throw new Error(`${subject} must be an array.`); return v; }
function exact(v: Record<string, unknown>, required: string[], subject: string, optional: string[] = []): void { for (const k of required) if (!Object.hasOwn(v, k)) throw new Error(`${subject}.${k} is required.`); for (const k of Object.keys(v)) if (![...required, ...optional].includes(k)) throw new Error(`${subject}.${k} is unexpected.`); }
function nonEmpty(v: unknown, subject: string): asserts v is string { if (typeof v !== "string" || !v.trim()) throw new Error(`${subject} must be a non-empty string.`); }
function wireNonEmpty(v: unknown, subject: string): asserts v is string { wellFormedString(v, subject); if (v.length === 0) throw new Error(`${subject} must be non-empty.`); }
function wellFormedString(v: unknown, subject: string): asserts v is string { if (typeof v !== "string" || !isWellFormedUnicode(v)) throw new Error(`${subject} must be a well-formed string.`); }
function optionalString(v: unknown, subject: string): void { if (v !== undefined) nonEmpty(v, subject); }
function finite(v: unknown, subject: string, min: number, max: number): void { if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error(`${subject} is invalid.`); }
function integer(v: unknown, subject: string): void { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error(`${subject} must be a non-negative safe integer.`); }
function digest(v: unknown, subject: string, prefixed = true): void { if (typeof v !== "string" || !(prefixed ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(v)) throw new Error(`${subject} is invalid.`); }
function optionalDigest(v: unknown, subject: string): void { if (v !== undefined) digest(v, subject); }
function safeReference(v: unknown, subject: string): asserts v is string { wireNonEmpty(v, subject); if (referenceContainsAuthorization(v)) throw new Error(`${subject} contains authorization material.`); }
function referenceContainsAuthorization(value: string, depth = 0): boolean { if (depth > 2 || /authorization\s*[:=]|bearer\s+[a-z0-9._~-]+/i.test(value)) return true; let parsed: URL; try { parsed = new URL(value); } catch { return false; } if (parsed.username || parsed.password) return true; for (const [key, nested] of parsed.searchParams) { if (/(?:^|[-_])(token|secret|password|passwd|api[-_]?key|authorization|signature|credential)(?:$|[-_])/i.test(key) || referenceContainsAuthorization(nested, depth + 1)) return true; } return false; }
function stableIdentity(v: unknown, subject: string): asserts v is string { wireNonEmpty(v, subject); if (!STABLE_IDENTITY.test(v) || CREDENTIAL_IDENTITY.test(v) || referenceContainsAuthorization(v)) throw new Error(`${subject} must be a credential-free stable identity.`); }
function preparedReference(v: unknown, subject: string): asserts v is string { safeReference(v, subject); if (!/^traverse-prepared-artifact:v1:sha256:[a-f0-9]{64}$/.test(v)) throw new Error(`${subject} must be a prepared-artifact reference.`); }
function cloneJson(v: unknown): unknown { return JSON.parse(JSON.stringify(v)); }
function identityHash(v: unknown): string { return createHash("sha256").update(canonicalJson(v)).digest("hex").slice(0, 20); }
function jsonSafe(v: unknown, subject: string, seen = new Set<object>()): void { if (v === null || typeof v === "boolean") return; if (typeof v === "string") { if (!isWellFormedUnicode(v)) throw new Error(`${subject} contains ill-formed Unicode.`); return; } if (typeof v === "number") { if (!Number.isFinite(v) || Object.is(v, -0)) throw new Error(`${subject} contains a non-lossless number.`); return; } if (Array.isArray(v)) { if (seen.has(v)) throw new Error(`${subject} contains a cycle.`); const keys = Reflect.ownKeys(v); const expected = new Set<PropertyKey>(["length", ...Array.from({ length: v.length }, (_, index) => String(index))]); for (const key of keys) { if (typeof key === "symbol" || !expected.has(key)) throw new Error(`${subject} is sparse or has unexpected array properties.`); const descriptor = Object.getOwnPropertyDescriptor(v, key); if (!descriptor || !("value" in descriptor)) throw new Error(`${subject} has an array accessor property.`); if (key !== "length" && !descriptor.enumerable) throw new Error(`${subject} has a non-enumerable array item.`); } if (keys.length !== expected.size) throw new Error(`${subject} contains a sparse array slot.`); seen.add(v); for (let i=0;i<v.length;i++) { const descriptor = Object.getOwnPropertyDescriptor(v, String(i))!; jsonSafe(descriptor.value, `${subject}[${i}]`, seen); } seen.delete(v); return; } if (typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) throw new Error(`${subject} contains a non-JSON value.`); if (seen.has(v)) throw new Error(`${subject} contains a cycle.`); seen.add(v); for (const key of Reflect.ownKeys(v)) { if (typeof key !== "string") throw new Error(`${subject} contains a symbol key.`); const d=Object.getOwnPropertyDescriptor(v,key); if (!d?.enumerable || !("value" in d) || !isWellFormedUnicode(key)) throw new Error(`${subject}.${key} is not a lossless JSON property.`); jsonSafe(d.value, `${subject}.${key}`, seen); } seen.delete(v); }
function isWellFormedUnicode(value: string): boolean { for (let index = 0; index < value.length; index += 1) { const unit = value.charCodeAt(index); if (unit >= 0xd800 && unit <= 0xdbff) { if (index + 1 >= value.length) return false; const next = value.charCodeAt(index + 1); if (next < 0xdc00 || next > 0xdfff) return false; index += 1; } else if (unit >= 0xdc00 && unit <= 0xdfff) return false; } return true; }

const RAW_SOURCE_KINDS = new Set<RawSource["kind"]>(["uploaded-document", "web-page", "api-record", "manual-entry", "policy-standard", "inquiry-question", "agent-utterance", "system-schema"]);
const VALUE_TYPES = new Set<ReviewValueType>(["string", "number", "boolean", "date", "enum", "array", "object"]);
const PARTIAL = new Set(["cancelled", "max-provider-calls", "max-total-tokens"]);
const FAILURE_CATEGORIES = new Set(["invalid-config", "invalid-task", "preparation", "provider", "unexpected"]);
const WARNING_CATEGORIES = new Set(["provider", "normalization", "preparation", "limit", "storage", "content", "other"]);
const FAILURE_KINDS = new Set(["authentication", "rate-limit", "timeout", "invalid-request", "unavailable", "unknown"]);
const PREPARATION_MODES = new Set(["text", "markdown", "transcript", "pdf-text", "image-ocr"]);
const ARTIFACT_INVALID_REASONS = new Set(["not-an-object", "invalid-format", "invalid-version", "invalid-digest", "invalid-ref", "invalid-preparation-mode", "invalid-preparation-version", "invalid-content-length", "invalid-source-snapshot-ref", "ill-formed-unicode", "invalid-resolved-text"]);
const STABLE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/;
const CREDENTIAL_IDENTITY = /^(?:gh[pousr]_|sk-[A-Za-z0-9]|AKIA[A-Z0-9]|ASIA[A-Z0-9]|eyJ[A-Za-z0-9_-]+\.eyJ)/;
const RUN_ID = /^traverse-extraction-run:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
