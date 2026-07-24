import { buildReviewItemsFromExtractionEnvelopeImport, validateExtractionEnvelopeImport, type ExtractionEnvelopeImport, type ExtractionEnvelopeImportResult, type PortableExtractionProposal } from "../extraction-envelope.js";
import { canonicalJson } from "./canonical.js";
import { sha256Hex } from "../sha256.js";
import {
  resolvePortablePdfRegion,
  type PortablePdfLayout,
  type PortablePdfRegionContext,
} from "../pdf-layout.js";

export type ExtractionAlignmentState = "aligned" | "excerpt-mismatch" | "artifact-unavailable" | "digest-mismatch";
export type ArtifactUnavailableCode = "not-found" | "storage-error" | "access-denied" | "invalid-artifact" | "unknown";

export type ResolvedExtractionArtifact =
  | { status: "available"; text: string; actualDigest: string }
  | { status: "unavailable"; code: ArtifactUnavailableCode }
  | { status: "digest-mismatch"; actualDigest: string };

export interface ExtractionInspectorEntry {
  /** Result returned by importExtractionEnvelope; includes authoritative ReviewItem identities. */
  importResult: ExtractionEnvelopeImportResult;
  artifact: ResolvedExtractionArtifact;
  /** Optional producer-declared pass label, kept outside the upstream envelope. */
  pass?: string;
}

export type ExtractionInspectorInput = ExtractionInspectorEntry | { imports: ExtractionInspectorEntry[] };

export interface ExtractionInspectorCandidate {
  id: string;
  sourceKey: string;
  reviewItemName: string;
  proposalIndex: number;
  field: string;
  provider: string;
  model?: string;
  attempt: string;
  pass?: string;
  valueType: string;
  inferenceType: "explicit" | "inferred";
  start: number;
  end: number;
  excerpt: string;
  alignment: ExtractionAlignmentState;
  pdfRegion?: PortablePdfRegionContext;
  ocrDerived?: true;
}

export interface ExtractionInspectorSource {
  key: string;
  importName: string;
  artifactRef?: string;
  expectedDigest?: string;
  actualDigest?: string;
  artifactText?: string;
  ocrDerived?: true;
  alignment: ExtractionAlignmentState;
  message: string;
}

export interface ExtractionInspectorModel {
  sources: ExtractionInspectorSource[];
  candidates: ExtractionInspectorCandidate[];
}

export interface ExtractionInspectorFilters {
  field?: string; provider?: string; model?: string; attempt?: string; pass?: string;
  inferenceType?: "explicit" | "inferred"; alignment?: ExtractionAlignmentState;
}

export interface ExtractionInspectorExportOptions {
  includePreparedText?: boolean;
  includeExcerpts?: boolean;
}

/**
 * Build a read-only view from one or more results already produced by Survey's
 * public import boundary. The function rechecks the result/ReviewItem binding
 * and fails closed if mutable caller data has drifted since import.
 */
export function buildExtractionInspectorModel(input: ExtractionInspectorInput): ExtractionInspectorModel {
  const entries = "imports" in input ? input.imports : [input];
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Extraction inspector requires at least one validated import result.");
  const sources: ExtractionInspectorSource[] = [];
  const candidates: ExtractionInspectorCandidate[] = [];
  const sourceKeys = new Set<string>();
  for (const [entryIndex, entry] of entries.entries()) {
    if (!entry.importResult || typeof entry.importResult !== "object") throw new Error("Invalid extraction import result.");
    const record = validateExtractionEnvelopeImport(entry.importResult.record);
    assertImportedResult(entry.importResult, record);
    assertResolvedArtifact(entry.artifact);
    const envelope = record.spec.envelope;
    const prepared = envelope.result.preparedArtifact;
    const sourceKey = `${record.metadata.producerNamespace}:${record.metadata.name}:${entryIndex}`;
    if (sourceKeys.has(sourceKey)) throw new Error("Extraction inspector source identity collision.");
    sourceKeys.add(sourceKey);
    const source = sourceModel(
      sourceKey,
      record.metadata.name,
      prepared,
      record.status.state,
      entry.artifact,
      envelope.result.ocrDerived,
    );
    sources.push(source);
    const candidateStart = candidates.length;
    envelope.result.proposals.forEach((proposal, proposalIndex) => {
      const item = entry.importResult.reviewItems[proposalIndex];
      if (!item) return; // unresolved imports legitimately produce no ReviewItems
      candidates.push(candidateModel(
        source,
        item.metadata.name,
        proposal,
        proposalIndex,
        envelope.result.provider,
        envelope.result.model,
        envelope.result.runId,
        entry.pass,
        envelope.result.pdfPageOffsets,
        envelope.result.pdfLayout,
        envelope.result.ocrDerived,
      ));
    });
    if (source.alignment === "excerpt-mismatch") {
      delete source.artifactText;
      for (let index = candidateStart; index < candidates.length; index += 1) candidates[index]!.alignment = "excerpt-mismatch";
    }
  }
  return { sources, candidates };
}

function assertResolvedArtifact(artifact: ResolvedExtractionArtifact): void {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("Invalid resolved extraction artifact.");
  const keys = Object.keys(artifact).sort();
  if (artifact.status === "available") {
    if (keys.join(",") !== "actualDigest,status,text" || typeof artifact.text !== "string" || !/^[a-f0-9]{64}$/.test(artifact.actualDigest)) throw new Error("Invalid available extraction artifact.");
  } else if (artifact.status === "digest-mismatch") {
    if (keys.join(",") !== "actualDigest,status" || !/^[a-f0-9]{64}$/.test(artifact.actualDigest)) throw new Error("Invalid digest-mismatch extraction artifact.");
  } else if (artifact.status === "unavailable") {
    if (keys.join(",") !== "code,status" || !["not-found", "storage-error", "access-denied", "invalid-artifact", "unknown"].includes(artifact.code)) throw new Error("Invalid unavailable extraction artifact.");
  } else throw new Error("Invalid resolved extraction artifact status.");
}

function assertImportedResult(result: ExtractionEnvelopeImportResult, record: ExtractionEnvelopeImport): void {
  if (!result || typeof result !== "object" || !result.record || !Array.isArray(result.reviewItems)) throw new Error("Invalid extraction import result.");
  const { reviewItems } = result;
  if (record.apiVersion !== "survey.kontourai.io/v1alpha1" || record.kind !== "ExtractionEnvelopeImport") throw new Error("Invalid extraction import resource identity.");
  if (!record.metadata?.name || !record.metadata.producerNamespace || !record.spec?.envelope?.result || !Array.isArray(record.spec.envelope.result.proposals)) throw new Error("Malformed extraction import result.");
  const grounded = record.status?.state === "grounded";
  if ((!grounded && reviewItems.length !== 0) || (grounded && reviewItems.length !== record.spec.envelope.result.proposals.length)) throw new Error("Extraction import ReviewItems do not match its grounding state.");
  const canonicalItems = buildReviewItemsFromExtractionEnvelopeImport(record);
  if (canonicalJson(reviewItems) !== canonicalJson(canonicalItems)) throw new Error("Extraction import ReviewItems do not match their canonical identities and bindings.");
  reviewItems.forEach((item, index) => {
    const proposal = record.spec.envelope.result.proposals[index]!;
    const metadata = item.metadata?.producer?.["survey.kontourai.io/extraction-envelope"] as { importName?: unknown } | undefined;
    const candidate = item.spec?.candidates?.[0];
    const binding = candidate?.producer?.["survey.kontourai.io/extraction-envelope"] as { importName?: unknown; proposalIndex?: unknown; runId?: unknown; provider?: unknown } | undefined;
    if (item.kind !== "ReviewItem" || !item.metadata.name || item.spec.candidates.length !== 1
      || metadata?.importName !== record.metadata.name || binding?.importName !== record.metadata.name
      || binding.proposalIndex !== index || binding.runId !== record.spec.envelope.result.runId || binding.provider !== record.spec.envelope.result.provider
      || item.spec.target !== proposal.fieldPath || candidate?.locator?.locator !== proposal.provenance.locator || candidate.locator.excerpt !== proposal.provenance.excerpt) {
      throw new Error(`Extraction import ReviewItem ${index} is inconsistent with its validated proposal.`);
    }
  });
}

function sourceModel(
  key: string,
  importName: string,
  prepared: ExtractionEnvelopeImportResult["record"]["spec"]["envelope"]["result"]["preparedArtifact"],
  state: string,
  artifact: ResolvedExtractionArtifact,
  ocrDerived: true | undefined,
): ExtractionInspectorSource {
  let alignment: ExtractionAlignmentState;
  let message: string;
  if (state !== "grounded" || artifact.status === "unavailable") {
    alignment = "artifact-unavailable"; message = `Prepared artifact unavailable (${artifact.status === "unavailable" ? artifact.code : "invalid-artifact"}). Candidates are not grounded.`;
  } else if (artifact.status === "digest-mismatch" || !prepared || artifact.actualDigest !== prepared.digest
    || sha256Hex(artifact.text) !== artifact.actualDigest) {
    alignment = "digest-mismatch"; message = "Prepared artifact digest does not match the extraction artifact. Candidates are not grounded.";
  } else if (artifact.text.length !== prepared.contentLength) {
    alignment = "artifact-unavailable"; message = "Prepared artifact content has the wrong length. Candidates are not grounded.";
  } else {
    alignment = "aligned"; message = `Prepared artifact identity verified. Exact source spans are available.${ocrDerived ? " Prepared text is OCR-derived." : ""}`;
  }
  return { key, importName, ...(prepared?.ref ? { artifactRef: prepared.ref } : {}), ...(prepared?.digest ? { expectedDigest: prepared.digest } : {}), ...("actualDigest" in artifact ? { actualDigest: artifact.actualDigest } : {}), ...(alignment === "aligned" && artifact.status === "available" ? { artifactText: artifact.text } : {}), ...(ocrDerived ? { ocrDerived: true as const } : {}), alignment, message };
}

function candidateModel(
  source: ExtractionInspectorSource,
  reviewItemName: string,
  proposal: PortableExtractionProposal,
  index: number,
  provider: string,
  model: string | undefined,
  attempt: string,
  pass: string | undefined,
  pdfPageOffsets: number[] | undefined,
  pdfLayout: PortablePdfLayout | undefined,
  ocrDerived: true | undefined,
): ExtractionInspectorCandidate {
  const match = /^chars:(\d+)-(\d+)$/.exec(proposal.provenance.locator);
  if (!match) throw new Error(`Extraction proposal ${index} has an invalid text span.`);
  const start = Number(match[1]), end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error(`Extraction proposal ${index} has an invalid text span.`);
  const alignment = source.alignment === "aligned" && source.artifactText!.slice(start, end) !== proposal.provenance.excerpt ? "excerpt-mismatch" : source.alignment;
  if (alignment === "excerpt-mismatch") { source.alignment = alignment; source.message = "One or more source spans do not match their recorded excerpts. Affected candidates are not grounded."; }
  let pdfRegion = pdfLayout ? resolvePortablePdfRegion(pdfLayout, proposal.provenance.locator) : undefined;
  const page = resolvePdfPage(pdfPageOffsets, start);
  if (page !== undefined) {
    pdfRegion = {
      pages: [...new Set([...(pdfRegion?.pages ?? []), page])].sort((left, right) => left - right),
      elements: pdfRegion?.elements ?? [],
      tableCells: pdfRegion?.tableCells ?? [],
    };
  }
  return { id: `${source.key}:proposal:${index}`, sourceKey: source.key, reviewItemName, proposalIndex: index, field: proposal.fieldPath, provider, ...(model ? { model } : {}), attempt, ...(pass ? { pass } : {}), valueType: proposal.valueType ?? inferValueType(proposal.candidateValue), inferenceType: proposal.inferenceType ?? "inferred", start, end, excerpt: proposal.provenance.excerpt, alignment, ...(pdfRegion ? { pdfRegion } : {}), ...(ocrDerived ? { ocrDerived: true as const } : {}) };
}

function inferValueType(value: unknown): string { if (Array.isArray(value)) return "array"; if (value !== null && typeof value === "object") return "object"; return typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string"; }
function resolvePdfPage(offsets: number[] | undefined, start: number): number | undefined {
  if (!offsets || offsets.length === 0) return undefined;
  let page: number | undefined;
  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index]! > start) break;
    page = index + 1;
  }
  return page;
}

export function filterExtractionInspectorCandidates(model: ExtractionInspectorModel, filters: ExtractionInspectorFilters): ExtractionInspectorCandidate[] {
  return model.candidates.filter((c) => (!filters.field || c.field === filters.field) && (!filters.provider || c.provider === filters.provider) && (!filters.model || c.model === filters.model) && (!filters.attempt || c.attempt === filters.attempt) && (!filters.pass || c.pass === filters.pass) && (!filters.inferenceType || c.inferenceType === filters.inferenceType) && (!filters.alignment || c.alignment === filters.alignment));
}

export function exportExtractionInspector(model: ExtractionInspectorModel, options: ExtractionInspectorExportOptions = {}): string {
  return canonicalJson({ apiVersion: "survey.kontourai.io/v1alpha1", kind: "ExtractionInspectorExport", spec: {
    redaction: { preparedTextIncluded: options.includePreparedText === true, excerptsIncluded: options.includeExcerpts === true },
    sources: model.sources.map(({ artifactText, message: _message, ...source }) => ({ ...source, preparedText: options.includePreparedText ? artifactText ?? null : "[redacted]" })),
    candidates: model.candidates.map((candidate) => ({ ...candidate, excerpt: options.includeExcerpts ? candidate.excerpt : "[redacted]" })),
  } });
}

export function mountExtractionInspector(container: HTMLElement, model: ExtractionInspectorModel): () => void {
  const root = document.createElement("section"); root.className = "extraction-inspector"; root.setAttribute("aria-label", "Source-linked extraction inspector");
  const options = (values: Array<string | undefined>) => [...new Set(values.filter((v): v is string => Boolean(v)))].map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  root.innerHTML = `<div class="inspector-heading"><div><p class="eyebrow">Source inspector</p><h2>Extraction evidence</h2></div><div class="inspector-postures" aria-live="polite"></div></div><div class="inspector-filters" aria-label="Extraction filters">${filterSelect("field", "Field", options(model.candidates.map(c => c.field)))}${filterSelect("provider", "Provider", options(model.candidates.map(c => c.provider)))}${filterSelect("model", "Model", options(model.candidates.map(c => c.model)))}${filterSelect("attempt", "Attempt", options(model.candidates.map(c => c.attempt)))}${filterSelect("pass", "Pass", options(model.candidates.map(c => c.pass)))}${filterSelect("inferenceType", "Type origin", '<option value="explicit">explicit</option><option value="inferred">inferred</option>')}${filterSelect("alignment", "Alignment", options(model.candidates.map(c => c.alignment)))}</div><div class="inspector-layout"><ol class="inspector-candidates" aria-label="Extraction candidates"></ol><div class="inspector-sources"></div></div>`;
  container.appendChild(root);
  const list = root.querySelector("ol")!, sourcesRoot = root.querySelector<HTMLElement>(".inspector-sources")!, postures = root.querySelector<HTMLElement>(".inspector-postures")!;
  const filters: ExtractionInspectorFilters = {};
  const render = () => {
    const visible = filterExtractionInspectorCandidates(model, filters);
    list.innerHTML = visible.map(c => `<li><button type="button" class="inspector-candidate" id="candidate-${safeId(c.id)}" data-candidate-id="${escapeHtml(c.id)}" aria-controls="highlight-${safeId(c.id)}"><strong>${escapeHtml(c.field)}</strong><span>${escapeHtml(c.provider)}${c.model ? ` / ${escapeHtml(c.model)}` : ""}</span><span>${escapeHtml(c.inferenceType)} ${escapeHtml(c.valueType)} · ${escapeHtml(c.alignment)}</span>${formatContext(c)}</button></li>`).join("") || "<li>No candidates match these filters.</li>";
    postures.innerHTML = model.sources.map(s => `<div class="inspector-posture ${s.alignment}" role="status"><strong>${escapeHtml(s.importName)}: ${escapeHtml(s.alignment)}</strong><span>${escapeHtml(s.message)}</span></div>`).join("");
    sourcesRoot.innerHTML = model.sources.map(s => { const candidates = visible.filter(c => c.sourceKey === s.key); return `<div class="inspector-source" aria-label="Prepared source for ${escapeHtml(s.importName)}"><h3>${escapeHtml(s.importName)}</h3><pre tabindex="0">${s.artifactText === undefined ? `<span class="source-unavailable">${escapeHtml(s.message)}</span>` : renderSource(s.artifactText, candidates)}</pre></div>`; }).join("");
  };
  root.querySelectorAll<HTMLSelectElement>("select").forEach(select => select.addEventListener("change", event => { event.stopPropagation(); const key = select.dataset.filter as keyof ExtractionInspectorFilters; if (select.value) (filters as Record<string,string>)[key] = select.value; else delete (filters as Record<string,string>)[key]; render(); }));
  const activateCandidate = (id: string) => { const candidate = model.candidates.find(c => c.id === id); if (!candidate) return; root.dispatchEvent(new CustomEvent("survey-extraction-candidate-activate", { bubbles: true, composed: true, detail: { candidateId: id, reviewItemName: candidate.reviewItemName } })); };
  root.addEventListener("click", event => { const candidate = (event.target as Element).closest<HTMLButtonElement>("button[data-candidate-id]"); if (candidate) { event.preventDefault(); event.stopPropagation(); activateCandidate(candidate.dataset.candidateId!); return; } const highlight = (event.target as Element).closest<HTMLButtonElement>("button[data-highlight-candidate-id]"); if (highlight) { event.preventDefault(); event.stopPropagation(); root.querySelector<HTMLElement>(`#candidate-${CSS.escape(safeId(highlight.dataset.highlightCandidateId!))}`)?.focus(); } });
  root.addEventListener("keydown", event => { const button = (event.target as Element).closest<HTMLButtonElement>("button[data-candidate-id]"); if (button && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); activateCandidate(button.dataset.candidateId!); } });
  render(); return () => root.remove();
}

function renderSource(text: string, candidates: ExtractionInspectorCandidate[]): string {
  const boundaries = new Set([0, text.length]); candidates.forEach(c => { boundaries.add(c.start); boundaries.add(c.end); }); const points = [...boundaries].sort((a,b) => a-b);
  let html = "";
  const starts = new Map<number, ExtractionInspectorCandidate[]>(); candidates.forEach(c => starts.set(c.start, [...(starts.get(c.start) ?? []), c]));
  for (let i=0; i<points.length-1; i++) { const start=points[i]!, end=points[i+1]!; for (const c of starts.get(start) ?? []) html += `<button type="button" class="highlight-anchor" id="highlight-${safeId(c.id)}" data-highlight-candidate-id="${escapeHtml(c.id)}" aria-label="Source highlight for ${escapeHtml(c.field)}; activate to return to candidate"></button>`; const segment=escapeHtml(text.slice(start,end)); const active=candidates.filter(c => c.start < end && c.end > start); html += active.length ? `<mark aria-label="Highlighted for ${active.map(c => escapeHtml(c.field)).join(", ")}">${segment}</mark>` : segment; }
  return html;
}
function formatContext(candidate: ExtractionInspectorCandidate): string {
  const context: string[] = [];
  if (candidate.pdfRegion) {
    if (candidate.pdfRegion.pages.length > 0) context.push(`PDF page${candidate.pdfRegion.pages.length === 1 ? "" : "s"} ${candidate.pdfRegion.pages.join(", ")}`);
    if (candidate.pdfRegion.elements.length > 0) context.push(`${candidate.pdfRegion.elements.length} layout element${candidate.pdfRegion.elements.length === 1 ? "" : "s"}`);
    if (candidate.pdfRegion.tableCells.length > 0) context.push(`${candidate.pdfRegion.tableCells.length} table cell${candidate.pdfRegion.tableCells.length === 1 ? "" : "s"}`);
  }
  if (candidate.ocrDerived) context.push("OCR-derived");
  return context.length > 0 ? `<span class="inspector-format-context">${escapeHtml(context.join(" · "))}</span>` : "";
}
function filterSelect(key:string,label:string,choices:string):string { return `<label>${escapeHtml(label)}<select data-filter="${key}"><option value="">All</option>${choices}</select></label>`; }
function safeId(value:string):string { return value.replace(/[^a-zA-Z0-9_-]/g,"-"); }
function escapeHtml(text:string):string { return text.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }
