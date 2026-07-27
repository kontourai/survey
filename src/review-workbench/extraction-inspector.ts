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
  /**
   * PUBLIC CONTRACT — the element id of the source-highlight anchor that
   * {@link mountExtractionInspector} renders for this candidate.
   *
   * A host that wants to link a fact back to the sentence it came from uses this
   * value directly (`href="#" + highlightElementId`, or
   * `document.getElementById(highlightElementId)`); it must never re-derive an id
   * from {@link ExtractionInspectorCandidate.id}. The renderer reads this same
   * field, so the value a host reads and the id in the DOM cannot drift apart.
   *
   * Optional **here** only because this type is also the shape a caller may hand
   * to {@link mountExtractionInspector} directly; a model that came from
   * {@link buildExtractionInspectorModel} is a
   * {@link BuiltExtractionInspectorModel}, where it is always present. Take the
   * builder's type if you want to link, and the guarantees below are yours.
   * Mount fills in an id for any candidate that arrives without one, so a
   * hand-authored model still renders — it just has nothing published to link to.
   *
   * Resolvable for **every** candidate in the model for as long as the inspector
   * is mounted, in every posture. Anchors are deliberately exempt from the
   * candidate list's paging and filtering (see
   * {@link ExtractionInspectorMountOptions.pageSize}), and are rendered even when
   * the prepared artifact is unavailable, digest-mismatched, or excerpt-
   * mismatched — there is no highlighted span to land on then, so the anchor sits
   * with the non-grounded posture message that explains why. A link that dies
   * when a reviewer pages, filters, or opens a source that failed verification is
   * the same broken promise as an id that drifted.
   *
   * Guaranteed unique across every candidate in one
   * {@link BuiltExtractionInspectorModel}, and a valid CSS/HTML identifier.
   *
   * The reverse lookup — DOM node to candidate — is the equally public
   * `data-highlight-candidate-id="<candidate.id>"` attribute on the same anchor.
   *
   * Deliberately omitted from {@link exportExtractionInspector}: the canonical
   * export records extraction evidence, and a DOM binding is not evidence.
   */
  highlightElementId?: string;
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

/**
 * A candidate from {@link buildExtractionInspectorModel}, where the DOM binding
 * is resolved rather than optional.
 *
 * The split exists so the linking guarantee can be unconditional without making
 * the *input* shape unbuildable by hand. `ExtractionInspectorModel` stays what a
 * caller may author and pass to mount; this is what the builder hands back, and
 * only the builder can promise the id is present, unique, and the one the
 * renderer will use.
 */
export interface BuiltExtractionInspectorCandidate extends ExtractionInspectorCandidate {
  highlightElementId: string;
}

/** The model {@link buildExtractionInspectorModel} returns. Assignable anywhere an {@link ExtractionInspectorModel} is accepted. */
export interface BuiltExtractionInspectorModel extends ExtractionInspectorModel {
  candidates: BuiltExtractionInspectorCandidate[];
}

export interface ExtractionInspectorFilters {
  field?: string; provider?: string; model?: string; attempt?: string; pass?: string;
  inferenceType?: "explicit" | "inferred"; alignment?: ExtractionAlignmentState;
  query?: string;
}

export interface ExtractionInspectorExportOptions {
  includePreparedText?: boolean;
  includeExcerpts?: boolean;
}

export interface ExtractionInspectorMountOptions {
  /**
   * Maximum candidate rows and painted source highlights mounted at once.
   * Defaults to 100 and is capped at 500.
   *
   * This governs the candidate list and the `<mark>` painting only. The
   * highlight *anchors* — the elements
   * {@link ExtractionInspectorCandidate.highlightElementId} names — are mounted
   * for every candidate in the model regardless of page or filter, because a
   * host's link to a span must not go dead when a reviewer types in the filter
   * box. Anchors are empty and inert; the per-candidate cost is one element.
   */
  pageSize?: number;
}

/**
 * Build a read-only view from one or more results already produced by Survey's
 * public import boundary. The function rechecks the result/ReviewItem binding
 * and fails closed if mutable caller data has drifted since import.
 */
export function buildExtractionInspectorModel(input: ExtractionInspectorInput): BuiltExtractionInspectorModel {
  const entries = "imports" in input ? input.imports : [input];
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("Extraction inspector requires at least one validated import result.");
  const sources: ExtractionInspectorSource[] = [];
  const candidates: UnboundInspectorCandidate[] = [];
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
  return { sources, candidates: bindHighlightElementIds(candidates) };
}

/** A candidate before its DOM binding is assigned; see {@link bindHighlightElementIds}. */
type UnboundInspectorCandidate = Omit<ExtractionInspectorCandidate, "highlightElementId">;


const HIGHLIGHT_ID_PREFIX = "highlight-";

/**
 * Assigns every candidate the element id its source highlight will carry.
 *
 * Done here, over the whole model, rather than by a pure per-id derivation:
 * sanitizing a candidate id to an HTML identifier is lossy (`a:b.c` and `a:b-c`
 * both reduce to `a-b-c`), and two anchors sharing an id silently resolve a
 * host's link to the wrong sentence. Today's candidate-id scheme happens not to
 * produce that collision — the entry index always separates two sources — so
 * the disambiguating suffix is defensive rather than a fix for a reachable bug.
 * It is here because uniqueness is now a published promise
 * ({@link ExtractionInspectorCandidate.highlightElementId}) that must survive a
 * later change to the key scheme rather than depend on one.
 */
function bindHighlightElementIds(candidates: UnboundInspectorCandidate[]): BuiltExtractionInspectorCandidate[] {
  const used = new Set<string>();
  return candidates.map((candidate) => ({
    ...candidate,
    highlightElementId: uniqueHighlightElementId(candidate.id, used),
  }));
}

/**
 * Derives an element id not already taken.
 *
 * `used` holds finished element ids — prefix included — and so does the value
 * returned, because the two have to be the same form to be comparable. They were
 * not: uniqueness was checked on the bare token while the set held prefixed ids,
 * so a published `highlight-alpha` did not stop a candidate with id `alpha` from
 * deriving `highlight-alpha` and mounting a second element under it. A host's
 * `href` then resolved to whichever came first.
 */
function uniqueHighlightElementId(candidateId: string, used: Set<string>): string {
  const base = `${HIGHLIGHT_ID_PREFIX}${safeId(candidateId)}`;
  let elementId = base;
  for (let suffix = 2; used.has(elementId); suffix += 1) elementId = `${base}-${suffix}`;
  used.add(elementId);
  return elementId;
}

/** The inspector's own candidate-list id, paired 1:1 with a highlight anchor. Not public. */
function candidateElementId(highlightElementId: string): string {
  return `candidate-${highlightElementId.slice(HIGHLIGHT_ID_PREFIX.length)}`;
}

/**
 * The element id each candidate's anchor will carry, for one mount.
 *
 * A model from {@link buildExtractionInspectorModel} already carries one per
 * candidate and it is used verbatim — rewriting a published id is precisely the
 * drift this contract exists to prevent. A hand-authored model may omit some or
 * all of them; those get an id derived here, seeded with the published ones so a
 * derived id can never collide with one a host is already linking to.
 *
 * Keyed on the candidate OBJECT, not on `candidate.id`. The builder's ids are
 * structurally unique, but this function exists for models a caller assembled,
 * where nothing enforces that — and an id-keyed map silently collapsed two such
 * candidates into one entry, handing the second's derived id to the first and
 * discarding the very `highlightElementId` a host was already linking to. Object
 * identity cannot collide, whatever the data says.
 */
function resolveHighlightElementIds(model: ExtractionInspectorModel): Map<ExtractionInspectorCandidate, string> {
  const used = new Set<string>();
  for (const candidate of model.candidates) if (candidate.highlightElementId) used.add(candidate.highlightElementId);
  const resolved = new Map<ExtractionInspectorCandidate, string>();
  for (const candidate of model.candidates) {
    resolved.set(candidate, candidate.highlightElementId ?? uniqueHighlightElementId(candidate.id, used));
  }
  return resolved;
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
): UnboundInspectorCandidate {
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
  const query = filters.query?.trim().toLocaleLowerCase();
  return model.candidates.filter((c) => (!filters.field || c.field === filters.field)
    && (!filters.provider || c.provider === filters.provider)
    && (!filters.model || c.model === filters.model)
    && (!filters.attempt || c.attempt === filters.attempt)
    && (!filters.pass || c.pass === filters.pass)
    && (!filters.inferenceType || c.inferenceType === filters.inferenceType)
    && (!filters.alignment || c.alignment === filters.alignment)
    && (!query || [c.field, c.excerpt, c.reviewItemName, c.provider, c.model ?? "", c.pass ?? ""]
      .some(value => value.toLocaleLowerCase().includes(query))));
}

export function exportExtractionInspector(model: ExtractionInspectorModel, options: ExtractionInspectorExportOptions = {}): string {
  return canonicalJson({ apiVersion: "survey.kontourai.io/v1alpha1", kind: "ExtractionInspectorExport", spec: {
    redaction: { preparedTextIncluded: options.includePreparedText === true, excerptsIncluded: options.includeExcerpts === true },
    sources: model.sources.map(({ artifactText, message: _message, ...source }) => ({ ...source, preparedText: options.includePreparedText ? artifactText ?? null : "[redacted]" })),
    // highlightElementId is a DOM binding for a live inspector, not extraction
    // evidence — it stays out of the canonical export (and out of its digest).
    candidates: model.candidates.map(({ highlightElementId: _highlightElementId, ...candidate }) => ({ ...candidate, excerpt: options.includeExcerpts ? candidate.excerpt : "[redacted]" })),
  } });
}

export function mountExtractionInspector(
  container: HTMLElement,
  model: ExtractionInspectorModel,
  options: ExtractionInspectorMountOptions = {},
): () => void {
  const pageSize = Number.isSafeInteger(options.pageSize) && Number(options.pageSize) > 0
    ? Math.min(Number(options.pageSize), 500)
    : 100;
  let page = 0;
  const highlightIds = resolveHighlightElementIds(model);
  const highlightIdFor = (candidate: ExtractionInspectorCandidate) => highlightIds.get(candidate)!;
  const root = document.createElement("section"); root.className = "extraction-inspector"; root.setAttribute("aria-label", "Source-linked extraction inspector");
  const choiceOptions = (values: Array<string | undefined>) => [...new Set(values.filter((v): v is string => Boolean(v)))].map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  root.innerHTML = `<div class="inspector-heading"><div><p class="eyebrow">Source inspector</p><h2>Extraction evidence</h2></div><div class="inspector-postures" aria-live="polite"></div></div><div class="inspector-filters" aria-label="Extraction filters"><label>Find candidates<input type="search" data-filter="query" placeholder="Field or excerpt"></label>${filterSelect("field", "Field", choiceOptions(model.candidates.map(c => c.field)))}${filterSelect("provider", "Provider", choiceOptions(model.candidates.map(c => c.provider)))}${filterSelect("model", "Model", choiceOptions(model.candidates.map(c => c.model)))}${filterSelect("attempt", "Attempt", choiceOptions(model.candidates.map(c => c.attempt)))}${filterSelect("pass", "Pass", choiceOptions(model.candidates.map(c => c.pass)))}${filterSelect("inferenceType", "Type origin", '<option value="explicit">explicit</option><option value="inferred">inferred</option>')}${filterSelect("alignment", "Alignment", choiceOptions(model.candidates.map(c => c.alignment)))}</div><nav class="inspector-pager" aria-label="Extraction candidate navigation"><span class="inspector-result-count" aria-live="polite"></span><button type="button" data-page="previous">Previous</button><span class="inspector-page"></span><button type="button" data-page="next">Next</button></nav><div class="inspector-layout"><ol class="inspector-candidates" aria-label="Extraction candidates"></ol><div class="inspector-sources"></div></div>`;
  container.appendChild(root);
  const list = root.querySelector("ol")!, sourcesRoot = root.querySelector<HTMLElement>(".inspector-sources")!, postures = root.querySelector<HTMLElement>(".inspector-postures")!;
  const resultCount = root.querySelector<HTMLElement>(".inspector-result-count")!, pageLabel = root.querySelector<HTMLElement>(".inspector-page")!;
  const previous = root.querySelector<HTMLButtonElement>('[data-page="previous"]')!, next = root.querySelector<HTMLButtonElement>('[data-page="next"]')!;
  const filters: ExtractionInspectorFilters = {};
  const render = () => {
    const matching = filterExtractionInspectorCandidates(model, filters);
    const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
    page = Math.min(page, pageCount - 1);
    const start = page * pageSize;
    const visible = matching.slice(start, start + pageSize);
    list.innerHTML = visible.map(c => `<li><button type="button" class="inspector-candidate" id="${escapeHtml(candidateElementId(highlightIdFor(c)))}" data-candidate-id="${escapeHtml(c.id)}" data-highlight-element-id="${escapeHtml(highlightIdFor(c))}" aria-controls="${escapeHtml(highlightIdFor(c))}"><strong>${escapeHtml(c.field)}</strong><span>${escapeHtml(c.provider)}${c.model ? ` / ${escapeHtml(c.model)}` : ""}</span><span>${escapeHtml(c.inferenceType)} ${escapeHtml(c.valueType)} · ${escapeHtml(c.alignment)}</span>${formatContext(c)}</button></li>`).join("") || "<li>No candidates match these filters.</li>";
    resultCount.textContent = matching.length === 0 ? "No matching candidates" : `${start + 1}–${Math.min(start + pageSize, matching.length)} of ${matching.length}`;
    pageLabel.textContent = `Page ${page + 1} of ${pageCount}`;
    pageLabel.hidden = pageCount === 1;
    previous.hidden = pageCount === 1;
    next.hidden = pageCount === 1;
    previous.disabled = page === 0;
    next.disabled = page >= pageCount - 1;
    postures.innerHTML = model.sources.map(s => `<div class="inspector-posture ${s.alignment}" role="status"><strong>${escapeHtml(s.importName)}: ${escapeHtml(s.alignment)}</strong><span>${escapeHtml(s.message)}</span></div>`).join("");
    sourcesRoot.innerHTML = model.sources.map(s => { const anchored = model.candidates.filter(c => c.sourceKey === s.key); const marked = visible.filter(c => c.sourceKey === s.key); return `<div class="inspector-source" aria-label="Prepared source for ${escapeHtml(s.importName)}"><h3>${escapeHtml(s.importName)}</h3><pre tabindex="0">${s.artifactText === undefined ? `${anchored.map(c => anchorHtml(c, highlightIdFor(c))).join("")}<span class="source-unavailable">${escapeHtml(s.message)}</span>` : renderSource(s.artifactText, anchored, marked, highlightIdFor)}</pre></div>`; }).join("");
  };
  root.querySelectorAll<HTMLSelectElement>("select").forEach(select => select.addEventListener("change", event => { event.stopPropagation(); const key = select.dataset.filter as keyof ExtractionInspectorFilters; if (select.value) (filters as Record<string,string>)[key] = select.value; else delete (filters as Record<string,string>)[key]; page = 0; render(); }));
  root.querySelector<HTMLInputElement>('input[data-filter="query"]')?.addEventListener("input", event => { event.stopPropagation(); const input = event.currentTarget as HTMLInputElement; if (input.value) filters.query = input.value; else delete filters.query; page = 0; render(); });
  previous.addEventListener("click", () => { page = Math.max(0, page - 1); render(); list.querySelector<HTMLButtonElement>("button")?.focus(); });
  next.addEventListener("click", () => { page += 1; render(); list.querySelector<HTMLButtonElement>("button")?.focus(); });
  // The event carries the resolved binding as well as the identity: a listener
  // that wants to focus the highlight must never reconstruct the id, and the
  // first-party custom element is the reference implementation of that rule.
  const candidateFor = (highlightElementId: string) => model.candidates.find(c => highlightIdFor(c) === highlightElementId);
  const activateCandidate = (highlightElementId: string) => { const candidate = candidateFor(highlightElementId); if (!candidate) return; root.dispatchEvent(new CustomEvent("survey-extraction-candidate-activate", { bubbles: true, composed: true, detail: { candidateId: candidate.id, reviewItemName: candidate.reviewItemName, highlightElementId } })); };
  const clearFilters = () => {
    for (const key of Object.keys(filters) as Array<keyof ExtractionInspectorFilters>) delete filters[key];
    root.querySelectorAll<HTMLSelectElement>("select[data-filter]").forEach(select => { select.value = ""; });
    const search = root.querySelector<HTMLInputElement>('input[data-filter="query"]');
    if (search) search.value = "";
  };
  /**
   * Brings a candidate's row onto the mounted page so it can be focused.
   *
   * Anchors exist for every candidate, so a highlight can be activated while its
   * candidate row is on another page or filtered out entirely. Returning focus
   * to a row that is not mounted would silently do nothing, so page to it —
   * clearing the filters first if they are what is hiding it.
   */
  const revealCandidateRow = (highlightElementId: string): ExtractionInspectorCandidate | undefined => {
    const candidate = candidateFor(highlightElementId);
    if (!candidate) return undefined;
    let index = filterExtractionInspectorCandidates(model, filters).indexOf(candidate);
    if (index < 0) { clearFilters(); index = model.candidates.indexOf(candidate); }
    if (index < 0) return undefined;
    page = Math.floor(index / pageSize);
    render();
    return candidate;
  };
  const returnToCandidate = (highlightElementId: string) => {
    if (revealCandidateRow(highlightElementId)) root.querySelector<HTMLElement>(`#${CSS.escape(candidateElementId(highlightElementId))}`)?.focus();
  };
  /**
   * Follows a host's `href="#<highlightElementId>"`.
   *
   * The anchor that id names always exists, but a candidate off the current page
   * or excluded by a filter has no painted highlight, so the link would land the
   * reader on an invisible marker in the middle of the source text. Page to the
   * candidate instead, so the highlight it points at is actually painted, and put
   * focus on it.
   */
  const followHighlightFragment = () => {
    const fragment = typeof location === "undefined" ? "" : location.hash.slice(1);
    if (!fragment) return;
    if (!candidateFor(fragment)) return;
    revealCandidateRow(fragment);
    // `~=` matches one whitespace-separated token: a mark painted over a span
    // shared by several candidates lists all of them, and this is the one the
    // reader asked for. Record it, so activating that mark returns to the
    // candidate they arrived by rather than to whichever is listed first.
    const mark = root.querySelector<HTMLElement>(`[data-highlight-return-to~="${CSS.escape(fragment)}"]`);
    if (!mark) return;
    mark.dataset.highlightArrivedBy = fragment;
    mark.focus();
    mark.scrollIntoView({ block: "center" });
  };
  const onHashChange = () => followHighlightFragment();
  if (typeof window !== "undefined") window.addEventListener("hashchange", onHashChange);
  /** The candidate a shared mark returns to: the one the reader arrived by, else the first it covers. */
  const returnTargetOf = (mark: HTMLElement) => mark.dataset.highlightArrivedBy ?? mark.dataset.highlightReturnTo!.split(" ")[0]!;
  root.addEventListener("click", event => { const candidate = (event.target as Element).closest<HTMLButtonElement>("button[data-highlight-element-id]"); if (candidate) { event.preventDefault(); event.stopPropagation(); activateCandidate(candidate.dataset.highlightElementId!); return; } const highlight = (event.target as Element).closest<HTMLElement>("[data-highlight-return-to]"); if (highlight) { event.preventDefault(); event.stopPropagation(); returnToCandidate(returnTargetOf(highlight)); } });
  root.addEventListener("keydown", event => { const highlight = (event.target as Element).closest<HTMLElement>("[data-highlight-return-to]"); if (highlight) { if (event.key !== "Enter" && event.key !== " ") return; event.preventDefault(); event.stopPropagation(); returnToCandidate(returnTargetOf(highlight)); return; } const button = (event.target as Element).closest<HTMLButtonElement>("button[data-highlight-element-id]"); if (!button) return; if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); activateCandidate(button.dataset.highlightElementId!); return; } if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const buttons = [...list.querySelectorAll<HTMLButtonElement>("button[data-highlight-element-id]")]; const index = buttons.indexOf(button); buttons[event.key === "ArrowDown" ? Math.min(index + 1, buttons.length - 1) : Math.max(index - 1, 0)]?.focus(); } });
  render();
  followHighlightFragment();
  return () => { if (typeof window !== "undefined") window.removeEventListener("hashchange", onHashChange); root.remove(); };
}

/**
 * Renders the prepared text with a return anchor for every candidate and a
 * `<mark>` for the ones on the current page.
 *
 * The two sets are deliberately different. `marked` follows the candidate
 * list's paging and filtering, so the painting tracks what the reviewer is
 * looking at. `anchored` is every candidate the source has, so that the element
 * id published on the model resolves whatever page the reviewer is on and
 * whatever they have typed into the filter box — the anchors carry the contract,
 * the marks carry the view.
 */
function renderSource(text: string, anchored: ExtractionInspectorCandidate[], marked: ExtractionInspectorCandidate[], highlightIdFor: (candidate: ExtractionInspectorCandidate) => string): string {
  const boundaries = new Set([0, text.length]);
  anchored.forEach(c => boundaries.add(c.start));
  marked.forEach(c => { boundaries.add(c.start); boundaries.add(c.end); });
  const points = [...boundaries].filter(point => point >= 0 && point <= text.length).sort((a,b) => a-b);
  let html = "";
  const starts = new Map<number, ExtractionInspectorCandidate[]>(); anchored.forEach(c => starts.set(c.start, [...(starts.get(c.start) ?? []), c]));
  const emitted = new Set<ExtractionInspectorCandidate>();
  for (let i=0; i<points.length-1; i++) { const start=points[i]!, end=points[i+1]!; for (const c of starts.get(start) ?? []) { emitted.add(c); html += anchorHtml(c, highlightIdFor(c)); } const segment=escapeHtml(text.slice(start,end)); const active=marked.filter(c => c.start < end && c.end > start); html += active.length ? markHtml(segment, active, highlightIdFor) : segment; }
  // A span starting at or past the end of the prepared text has no segment to
  // lead; its anchor still has to exist, or its published id resolves nowhere.
  for (const c of anchored) if (!emitted.has(c)) html += anchorHtml(c, highlightIdFor(c));
  return html;
}

/**
 * The link target a host's `href` resolves to: an empty, inert span at the start
 * of the candidate's span.
 *
 * Deliberately NOT a control. It exists for every candidate in the model, which
 * is what makes the published id resolve unconditionally — but a thing that
 * exists per candidate must cost nothing to a keyboard or screen-reader user, and
 * as a `<button>` it did: 600 candidates put 600 invisible tab stops in sequence,
 * several of them stacked together in the non-grounded postures. It was also a
 * one-pixel pointer target once its accidental user-agent chrome was removed —
 * an affordance in name only, at any size, because nothing about it was visible.
 *
 * Returning to the candidate is now the job of the thing a reader can actually
 * see and aim at: the highlight itself. See {@link markHtml}.
 */
function anchorHtml(candidate: ExtractionInspectorCandidate, highlightElementId: string): string {
  return `<span class="highlight-anchor" id="${escapeHtml(highlightElementId)}" data-highlight-candidate-id="${escapeHtml(candidate.id)}"></span>`;
}

/**
 * The painted highlight, and the control that returns to its candidate.
 *
 * The highlight is the only part of this surface a reader can see, so it is the
 * target: full phrase width rather than a sliver, discoverable because it is
 * already visibly marked, and one tab stop per painted highlight rather than one
 * per candidate in the model. `data-highlight-return-to` is separate from the
 * anchor's `data-highlight-candidate-id` so the documented reverse lookup keeps
 * resolving to exactly one element.
 */
function markHtml(segment: string, active: ExtractionInspectorCandidate[], highlightIdFor: (candidate: ExtractionInspectorCandidate) => string): string {
  const fields = active.map(c => escapeHtml(c.field)).join(", ");
  // Every candidate the mark covers, not just the first. Two claims over one
  // span is ordinary in extraction, and naming both in the label while binding
  // only one left the others with a highlight that could not be navigated to or
  // returned from — the label said two, the binding said one.
  const bindings = active.map(c => escapeHtml(highlightIdFor(c))).join(" ");
  return `<mark class="source-highlight" role="button" tabindex="0" data-highlight-return-to="${bindings}" aria-label="Highlighted for ${fields}; activate to return to candidate">${segment}</mark>`;
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
