import { foldCandidateVerifications, type CandidateVerificationStatus, type SupportAbstainReason, type SupportVerificationMethod, type SupportVerificationResult } from "../candidate-verification.js";
import { findSoleCandidateById, type ReviewCandidate, type ReviewItem } from "../review-resource.js";
import type { InterpretationAnswerImpact, InterpretationReadingKind } from "../types.js";
import { type ReviewWorkbenchResult } from "./review-workbench.js";
import { formatValue } from "./review-surface-preview.js";

export interface ReviewPresentationAdapter {
  readonly labelForTarget?: (target: string, context: ReviewItemPresentationContext) => string | undefined;
  readonly labelForCandidateRole?: (role: ReviewCandidate["role"] | undefined, context: ReviewCandidatePresentationContext) => string | undefined;
  readonly summarizeValue?: (value: unknown, context: ReviewValuePresentationContext) => string | undefined;
  readonly linkForReviewItem?: (item: ReviewItem, context: ReviewItemPresentationContext) => ReviewPresentationLink | undefined;
  readonly linkForSource?: (sourceRef: string, context: ReviewCandidatePresentationContext) => ReviewPresentationLink | undefined;
  readonly linkForTraceRef?: (ref: ReviewTraceRef, context: ReviewTracePresentationContext) => ReviewPresentationLink | undefined;
  readonly statusLabel?: (status: string, context: ReviewItemPresentationContext) => string | undefined;
}

export interface ReviewItemPresentationContext {
  readonly item: ReviewItem;
}

export interface ReviewCandidatePresentationContext extends ReviewItemPresentationContext {
  readonly candidate: ReviewCandidate;
}

export interface ReviewValuePresentationContext extends ReviewCandidatePresentationContext {
  readonly value: unknown;
}

export interface ReviewTracePresentationContext extends ReviewItemPresentationContext {
  readonly candidate?: ReviewCandidate;
}

export interface ReviewPresentationLink {
  readonly label?: string;
  readonly href: string;
}

export interface ReviewTraceRef {
  readonly label: string;
  readonly value: string;
  readonly kind: "review-item" | "candidate" | "candidate-set" | "claim" | "source" | "locator" | "proposal" | "external-record";
  readonly link?: ReviewPresentationLink;
}

export interface ReviewCandidatePresentation {
  readonly candidate: ReviewCandidate;
  readonly roleLabel: string;
  readonly valueLabel: string;
  readonly valueText: string;
  readonly sourceLabel: string;
  readonly sourceText: string;
  readonly sourceLink?: ReviewPresentationLink;
  readonly traceRefs: readonly ReviewTraceRef[];
}

export interface ReviewItemPresentation {
  readonly item: ReviewItem;
  readonly target: string;
  readonly targetLabel: string;
  readonly statusLabel: string;
  readonly reviewItemLink?: ReviewPresentationLink;
  readonly traceRefs: readonly ReviewTraceRef[];
  readonly candidates: readonly ReviewCandidatePresentation[];
  /**
   * Proposals for this claim that an envelope import left out because the
   * source text at their cited span is not their excerpt. Unverifiable, not
   * disproven: every decision surface shows them. Empty for other items.
   */
  readonly excludedProposals: readonly ExcludedProposalPresentation[];
  /**
   * Stored `excludedProposals` entries that {@link excludedProposals} cannot
   * show: malformed entries, or every entry of an item whose envelope binding
   * is not intact. Hiding a rival is the unsafe direction, so every surface
   * that shows excluded proposals shows this notice too. Absent when every
   * stored entry is shown.
   */
  readonly excludedProposalsUnreadable?: ExcludedProposalsUnreadable;
  /**
   * For an envelope-imported item, whether its import checked excerpts
   * against the prepared artifact. Absent for other items, and for an item
   * whose envelope binding is missing, which cannot claim either.
   */
  readonly excerptVerification?: "verified" | "unverified";
}

export interface ExcludedProposalPresentation {
  readonly proposalIndex: number;
  readonly value: unknown;
  readonly valueText: string;
  readonly locator: string;
  readonly excerpt: string;
}

export interface ExcludedProposalsUnreadable {
  /**
   * `malformed-entries`: some stored entries are not well-formed.
   * `binding-broken`: the item's extraction binding is not intact, so none of
   * its stored entries can be vouched for.
   */
  readonly reason: "malformed-entries" | "binding-broken";
  /** How many stored entries are not shown; absent when the stored field is not a list. */
  readonly count?: number;
}

export interface ReviewResultPresentation {
  readonly result: ReviewWorkbenchResult;
  readonly item?: ReviewItem;
  readonly target: string;
  readonly targetLabel: string;
  readonly decisionLabel: string;
  /** Absent when the decision selects no candidate (reject-all or could-not-confirm on a conflict). */
  readonly selectedValueText?: string;
  readonly applyMeaning: string;
  readonly reviewItemLink?: ReviewPresentationLink;
  readonly traceRefs: readonly ReviewTraceRef[];
}

/**
 * Structural input for {@link buildInterpretationReadingPresentation}: either
 * a Survey `Interpretation` record (`id`) or the entry Survey projects onto a
 * claim at `metadata.survey.interpretations[]` (`interpretationId`). Kind and
 * impact arrive as plain strings when read back from projected metadata.
 */
export interface InterpretationReadingSource {
  readonly id?: string;
  readonly interpretationId?: string;
  readonly readingKind?: string;
  readonly answerImpact?: string;
  readonly ruleLocator: string;
  readonly reading: string;
  readonly actor: string;
  readonly recordedAt: string;
}

export interface InterpretationReadingPresentation {
  readonly interpretationId: string;
  readonly readingKind: InterpretationReadingKind;
  readonly kindLabel: string;
  readonly answerImpact?: InterpretationAnswerImpact;
  readonly answerImpactLabel?: string;
  readonly reading: string;
  readonly actor: string;
  readonly recordedAt: string;
  readonly ruleLocator: string;
  /**
   * Always `"authored-judgment"`. This is DERIVED from the record type, not a
   * stored flag: every Interpretation reading is a producer-authored reading
   * by contract (CONTEXT.md "Interpretation Record"), never a machine-observed
   * fact. Renderers must present readings under this marking, visually
   * distinct from machine-observed values — the StatementBadge / ADR 0003 §4
   * discipline (blending the two is the defect class of #247).
   */
  readonly provenance: "authored-judgment";
  readonly provenanceLabel: string;
}

const INTERPRETATION_KIND_LABELS: Record<InterpretationReadingKind, string> = {
  "policy-standard": "Policy-standard reading",
  gleaned: "Gleaned from results",
  answerImpact: "Answer impact",
};

const ANSWER_IMPACT_LABELS: Record<InterpretationAnswerImpact, string> = {
  supported: "Supported the answer",
  narrowed: "Narrowed the answer",
  "accepted-risk": "Accepted as a risk",
};

/**
 * Presents one interpretation reading as authored judgment. Fails closed on
 * unknown reading-kind / answer-impact vocabulary rather than rendering an
 * authored record under a label nothing derived.
 */
export function buildInterpretationReadingPresentation(
  source: InterpretationReadingSource,
): InterpretationReadingPresentation {
  const interpretationId = source.interpretationId ?? source.id;
  if (!interpretationId) {
    throw new Error("Interpretation reading presentation requires an id or interpretationId.");
  }
  const readingKind = (source.readingKind ?? "policy-standard") as InterpretationReadingKind;
  const kindLabel = INTERPRETATION_KIND_LABELS[readingKind];
  if (!kindLabel) {
    throw new Error(`Interpretation ${interpretationId} has unknown readingKind ${String(source.readingKind)}`);
  }
  const answerImpact = source.answerImpact as InterpretationAnswerImpact | undefined;
  const answerImpactLabel = answerImpact === undefined ? undefined : ANSWER_IMPACT_LABELS[answerImpact];
  if (answerImpact !== undefined && !answerImpactLabel) {
    throw new Error(`Interpretation ${interpretationId} has unknown answerImpact ${String(source.answerImpact)}`);
  }
  if (readingKind === "answerImpact" && answerImpact === undefined) {
    throw new Error(`Interpretation ${interpretationId} readingKind answerImpact requires an answerImpact value`);
  }
  if (readingKind !== "answerImpact" && answerImpact !== undefined) {
    throw new Error(`Interpretation ${interpretationId} sets answerImpact but readingKind is ${readingKind}`);
  }

  return {
    interpretationId,
    readingKind,
    kindLabel,
    ...(answerImpact !== undefined ? { answerImpact, answerImpactLabel } : {}),
    reading: source.reading,
    actor: source.actor,
    recordedAt: source.recordedAt,
    ruleLocator: source.ruleLocator,
    provenance: "authored-judgment",
    provenanceLabel: "Authored judgment",
  };
}

const EXTRACTION_ENVELOPE_PRODUCER = "survey.kontourai.io/extraction-envelope";

/**
 * The envelope-import binding an item carries, or undefined when it has none.
 * A binding names its import and proposals, and every candidate points back
 * at the same import; anything less cannot vouch for what the import checked.
 */
function extractionEnvelopeBinding(item: ReviewItem): Record<string, unknown> | undefined {
  const metadata = item.metadata?.producer?.[EXTRACTION_ENVELOPE_PRODUCER];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const binding = metadata as Record<string, unknown>;
  if (typeof binding.importName !== "string" || !binding.importName || !Array.isArray(binding.proposalIndices) || binding.proposalIndices.length === 0) return undefined;
  const bound = item.spec.candidates.length > 0 && item.spec.candidates.every((candidate) => {
    const own = candidate.producer?.[EXTRACTION_ENVELOPE_PRODUCER] as { importName?: unknown } | undefined;
    return own?.importName === binding.importName;
  });
  return bound ? binding : undefined;
}

/**
 * The well-formed `excludedProposals` entries of a bound envelope item, and
 * what the item stores but cannot show: malformed entries, or every entry
 * when the binding is not intact. Nothing stored is dropped silently.
 */
function excludedProposalsOf(item: ReviewItem, binding: Record<string, unknown> | undefined, adapter: ReviewPresentationAdapter): Pick<ReviewItemPresentation, "excludedProposals" | "excludedProposalsUnreadable"> {
  const metadata = item.metadata?.producer?.[EXTRACTION_ENVELOPE_PRODUCER];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    // Candidates that still carry the envelope binding came from an import,
    // whose item metadata is gone or replaced: what it stored is unknown.
    const candidatesBound = item.spec.candidates.some((candidate) => candidate.producer?.[EXTRACTION_ENVELOPE_PRODUCER] !== undefined);
    return candidatesBound ? { excludedProposals: [], excludedProposalsUnreadable: { reason: "binding-broken" } } : { excludedProposals: [] };
  }
  const stored = (metadata as Record<string, unknown>).excludedProposals;
  if (stored === undefined) return { excludedProposals: [] };
  const count = Array.isArray(stored) ? stored.length : undefined;
  if (!binding) return count === 0 ? { excludedProposals: [] } : { excludedProposals: [], excludedProposalsUnreadable: { reason: "binding-broken", ...(count !== undefined ? { count } : {}) } };
  if (!Array.isArray(stored)) return { excludedProposals: [], excludedProposalsUnreadable: { reason: "malformed-entries" } };
  const proposed = item.spec.candidates.find((candidate) => candidate.role === "proposed");
  const excludedProposals = stored.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const e = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(e.proposalIndex) || typeof e.locator !== "string" || typeof e.excerpt !== "string" || !("value" in e)) return [];
    const valueText = (proposed ? adapter.summarizeValue?.(e.value, { item, candidate: proposed, value: e.value }) : undefined) ?? formatValue(e.value);
    return [{ proposalIndex: e.proposalIndex as number, value: e.value, valueText, locator: e.locator, excerpt: e.excerpt }];
  });
  const unreadable = stored.length - excludedProposals.length;
  return { excludedProposals, ...(unreadable > 0 ? { excludedProposalsUnreadable: { reason: "malformed-entries" as const, count: unreadable } } : {}) };
}

/**
 * One sentence naming every excluded proposal, for surfaces that speak in
 * text (the MCP item, the recorded decision prompt). Undefined when none.
 */
export function excludedProposalsSentence(excluded: readonly ExcludedProposalPresentation[]): string | undefined {
  if (excluded.length === 0) return undefined;
  const named = excluded.map((entry) => `${entry.valueText} (proposal ${entry.proposalIndex}, ${entry.locator})`).join(", ");
  return `${excluded.length === 1 ? "Another proposed value was" : `${excluded.length} other proposed values were`} excluded at import because the source text at the cited span is not the excerpt: ${named}. Unverifiable is not disproven.`;
}

/**
 * One sentence saying that stored excluded proposals cannot be shown, for
 * every surface that shows excluded proposals. Undefined when none are hidden.
 */
export function excludedProposalsUnreadableSentence(unreadable: ExcludedProposalsUnreadable | undefined): string | undefined {
  if (!unreadable) return undefined;
  const { count } = unreadable;
  const entries = count === undefined ? "Stored excluded proposals are" : `${count} stored excluded ${count === 1 ? "entry is" : "entries are"}`;
  const why = unreadable.reason === "binding-broken"
    ? "not shown because this item's extraction binding is broken"
    : "unreadable and not shown";
  return `${entries} ${why}. Another value may have been proposed for this field.`;
}

export interface CandidateVerificationRecordPresentation {
  readonly recordId: string;
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly method: SupportVerificationMethod;
  readonly result: SupportVerificationResult;
  readonly abstainReason?: SupportAbstainReason;
  readonly createdAt: string;
}

/**
 * What the verifier records on one candidate say about the value under
 * review. Only candidates that carry `verifications` get a note, so a
 * candidate no verifier looked at shows nothing rather than a verdict.
 */
export interface CandidateVerificationNote {
  /** Position in `item.spec.candidates`; ids are not assumed unique. */
  readonly candidateIndex: number;
  readonly candidateId: string;
  readonly subjectLabel: string;
  /** As {@link foldCandidateVerifications}: `not-evaluated`, `abstained` (only abstentions apply) or `evaluated`. */
  readonly status: CandidateVerificationStatus;
  readonly records: readonly CandidateVerificationRecordPresentation[];
  /** Valid records bound to another value, candidate or input. */
  readonly inapplicableCount: number;
  /** Records that failed validation (edited, inconsistent or malformed); never shown as verdicts. */
  readonly rejectedCount: number;
  readonly sentence: string;
}

const VERIFICATION_RESULT_TEXT: Record<Exclude<SupportVerificationResult, "abstain">, string> = {
  supported: "supported",
  contradicted: "contradicted",
  "not-addressed": "not addressed by the evidence",
};

/**
 * Verifier notes for every candidate that carries records, read against the
 * value each surface is deciding on: the candidate's own value, or the
 * reviewer's edit when an accept carries one (records on the proposed value do
 * not apply to an edited value). Records are validated here, so an inconsistent
 * record is counted and ignored on every surface alike.
 */
export function candidateVerificationNotes(item: ReviewItem, editedValue?: unknown): CandidateVerificationNote[] {
  const proposed = item.spec.candidates.filter((candidate) => candidate.role === "proposed");
  return item.spec.candidates.flatMap((candidate, candidateIndex) => {
    if (candidate.verifications === undefined) return [];
    const edited = editedValue !== undefined && proposed.length === 1 && candidate === proposed[0];
    const subjectLabel = edited
      ? "the edited value"
      : candidate.role === "current"
        ? "the current value"
        : candidate.role === "proposed"
          ? proposed.length > 1 ? `proposed value ${proposed.indexOf(candidate) + 1} of ${proposed.length}` : "the proposed value"
          : `candidate ${candidate.id}`;
    const records: readonly unknown[] = Array.isArray(candidate.verifications) ? candidate.verifications : [candidate.verifications];
    const fold = foldCandidateVerifications({ candidateId: candidate.id, value: edited ? editedValue : candidate.value }, records);
    const presented = fold.applicable.map((record) => ({
      recordId: record.id,
      verifierId: record.verifier.id,
      verifierVersion: record.verifier.version,
      method: record.method,
      result: record.result,
      ...(record.abstainReason ? { abstainReason: record.abstainReason } : {}),
      createdAt: record.createdAt,
    }));
    const said = presented.map((record) => `${record.verifierId} ${record.verifierVersion} (${record.method}) ${record.result === "abstain" ? `abstained: ${record.abstainReason}` : `said ${VERIFICATION_RESULT_TEXT[record.result]}`}`);
    const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
    const sentence = [
      said.length ? `Verifier records for ${subjectLabel} (what a verifier said: not proof, not a review decision): ${said.join("; ")}.` : `No verifier record applies to ${subjectLabel}.`,
      ...(fold.inapplicable.length ? [`${plural(fold.inapplicable.length, "record was", "records were")} made for a different value or evidence and ${fold.inapplicable.length === 1 ? "does" : "do"} not apply.`] : []),
      ...(fold.rejected.length ? [`${plural(fold.rejected.length, "record", "records")} failed validation and ${fold.rejected.length === 1 ? "was" : "were"} ignored.`] : []),
    ].join(" ");
    return [{
      candidateIndex,
      candidateId: candidate.id,
      subjectLabel,
      status: fold.status,
      records: presented,
      inapplicableCount: fold.inapplicable.length,
      rejectedCount: fold.rejected.length,
      sentence,
    }];
  });
}

export function buildReviewItemPresentation(
  item: ReviewItem,
  adapter: ReviewPresentationAdapter = {},
): ReviewItemPresentation {
  const context = { item };
  const targetLabel = adapter.labelForTarget?.(item.spec.target, context) ?? humanizeIdentifier(item.spec.target);
  const status = item.spec.candidateSetStatus ?? "needs-review";

  return {
    item,
    target: item.spec.target,
    targetLabel,
    statusLabel: adapter.statusLabel?.(status, context) ?? humanizeIdentifier(status),
    reviewItemLink: adapter.linkForReviewItem?.(item, context),
    traceRefs: traceRefsForReviewItem(item, adapter),
    candidates: item.spec.candidates.map((candidate) => buildReviewCandidatePresentation(item, candidate, adapter, targetLabel)),
    ...extractionPresentation(item, adapter),
  };
}

function extractionPresentation(item: ReviewItem, adapter: ReviewPresentationAdapter): Pick<ReviewItemPresentation, "excludedProposals" | "excludedProposalsUnreadable" | "excerptVerification"> {
  const binding = extractionEnvelopeBinding(item);
  return {
    ...excludedProposalsOf(item, binding, adapter),
    ...(binding ? { excerptVerification: binding.excerptVerification === "verified" ? "verified" as const : "unverified" as const } : {}),
  };
}

export function buildReviewCandidatePresentation(
  item: ReviewItem,
  candidate: ReviewCandidate,
  adapter: ReviewPresentationAdapter = {},
  targetLabel = adapter.labelForTarget?.(item.spec.target, { item }) ?? humanizeIdentifier(item.spec.target),
): ReviewCandidatePresentation {
  const context = { item, candidate };
  const sourceRef = candidate.source.sourceRef;
  const sourceLink = adapter.linkForSource?.(sourceRef, context) ?? urlLink(sourceRef);

  return {
    candidate,
    roleLabel: adapter.labelForCandidateRole?.(candidate.role, context) ?? defaultCandidateRoleLabel(candidate.role),
    valueLabel: targetLabel,
    valueText: adapter.summarizeValue?.(candidate.value, { ...context, value: candidate.value }) ?? formatValue(candidate.value),
    sourceLabel: "Source Reference",
    sourceText: sourceLink?.label ?? sourceRef,
    sourceLink,
    traceRefs: traceRefsForCandidate(item, candidate, adapter),
  };
}

export function buildReviewResultPresentation(
  result: ReviewWorkbenchResult,
  item: ReviewItem | undefined,
  adapter: ReviewPresentationAdapter = {},
): ReviewResultPresentation {
  const target = item?.spec.target ?? result.reviewItemName;
  const itemContext = item ? { item } : undefined;
  const targetLabel = item && itemContext
    ? adapter.labelForTarget?.(target, itemContext) ?? humanizeIdentifier(target)
    : humanizeIdentifier(target);
  const selectedCandidate = item ? selectedCandidateForResult(item, result) : undefined;

  // A decision that selects no candidate presents no selected value and no
  // selected trace; it names every candidate instead.
  if (result.selectedCandidateId === undefined) {
    const rejected = result.decision === "reject-proposed";
    return {
      result,
      item,
      target,
      targetLabel,
      decisionLabel: humanizeIdentifier(result.decision),
      applyMeaning: rejected
        ? "Saved decision rejects every proposed value; none is applied"
        : "Saved decision records that no proposed value could be confirmed; none is applied",
      reviewItemLink: item && itemContext ? adapter.linkForReviewItem?.(item, itemContext) : undefined,
      traceRefs: [
        { label: "Survey ReviewItem", value: result.reviewItemName, kind: "review-item" as const, context: undefined },
        ...result.unselectedCandidates.map((candidate) => ({
          label: rejected ? "Rejected candidate" : "Unconfirmed candidate", value: candidate.id, kind: "candidate" as const, context: candidate,
        })),
      ].flatMap(({ context, ...ref }) => (item ? withTraceLinks([ref], { item, candidate: context }, adapter) : [ref])),
    };
  }

  return {
    result,
    item,
    target,
    targetLabel,
    decisionLabel: humanizeIdentifier(result.decision),
    selectedValueText: selectedCandidate && item
      ? buildReviewCandidatePresentation(item, selectedCandidate, adapter, targetLabel).valueText
      : result.selectedDisplayValue,
    applyMeaning: result.decision === "select-proposed"
      ? "Saved decision applies the chosen value; the other proposed values were seen and not chosen"
      : result.selectedCandidateRole === "proposed"
        ? "Saved decision applies proposed value"
        : "Saved decision keeps current value",
    reviewItemLink: item && itemContext ? adapter.linkForReviewItem?.(item, itemContext) : undefined,
    traceRefs: item
      ? [
          ...traceRefsForResult(item, result, selectedCandidate, adapter),
          // A choice between conflicting values names the values it passed over.
          ...(result.decision === "select-proposed"
            ? result.unselectedCandidates.filter((candidate) => candidate.role === "proposed").flatMap((candidate) =>
              withTraceLinks([{ label: "Not chosen candidate", value: candidate.id, kind: "candidate" }], { item, candidate }, adapter))
            : []),
        ]
      : [{ label: "Survey ReviewItem", value: result.reviewItemName, kind: "review-item" }],
  };
}

/**
 * The candidate a result selected, resolved by its complete identity.
 *
 * `find(role === … || id === …)` returned whichever candidate matched EITHER
 * half, so on an item carrying a repeated candidate id it could return a
 * different candidate than the result names — presenting one candidate's value
 * against another's decision, which is exactly what it did.
 *
 * The id is the identity; {@link findSoleCandidateById} makes it fail closed
 * rather than pick a winner when it is ambiguous, and the declared role has to
 * agree when the result states one. Falling back to the role alone is kept for
 * results that carry no id, and requires the role to be unambiguous too.
 */
function selectedCandidateForResult(
  item: ReviewItem,
  result: ReviewWorkbenchResult,
): ReviewCandidate | undefined {
  if (result.selectedCandidateId) {
    const candidate = findSoleCandidateById(item, result.selectedCandidateId);
    if (candidate && (result.selectedCandidateRole === undefined || candidate.role === result.selectedCandidateRole)) {
      return candidate;
    }
  }
  if (result.selectedCandidateRole === undefined) {
    return undefined;
  }
  const byRole = item.spec.candidates.filter((candidate) => candidate.role === result.selectedCandidateRole);
  return byRole.length === 1 ? byRole[0] : undefined;
}

export function humanizeIdentifier(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function traceRefsForReviewItem(item: ReviewItem, adapter: ReviewPresentationAdapter): ReviewTraceRef[] {
  const refs: ReviewTraceRef[] = [
    { label: "Survey ReviewItem", value: item.metadata.name, kind: "review-item" },
  ];
  const candidateSetId = item.spec.projection?.candidateSetId;
  if (candidateSetId) {
    refs.push({ label: "Candidate set", value: candidateSetId, kind: "candidate-set" });
  }

  return withTraceLinks(refs, { item }, adapter);
}

function traceRefsForCandidate(
  item: ReviewItem,
  candidate: ReviewCandidate,
  adapter: ReviewPresentationAdapter,
): ReviewTraceRef[] {
  const refs: ReviewTraceRef[] = [
    { label: "Candidate ID", value: candidate.id, kind: "candidate" },
    {
      label: "Claim ID",
      value: candidate.claimTarget.claimId ?? candidate.claimTarget.fieldOrBehavior,
      kind: "claim",
    },
    {
      label: "Raw Source ID",
      value: candidate.source.sourceId ?? candidate.source.sourceRef,
      kind: "source",
    },
  ];
  const locator = candidate.locator?.locator ?? candidate.locator?.scheme;
  if (locator) {
    refs.push({ label: "Locator", value: locator, kind: "locator" });
  }

  return withTraceLinks(refs, { item, candidate }, adapter);
}

function traceRefsForResult(
  item: ReviewItem,
  result: ReviewWorkbenchResult,
  selectedCandidate: ReviewCandidate | undefined,
  adapter: ReviewPresentationAdapter,
): ReviewTraceRef[] {
  return withTraceLinks([
    { label: "Survey ReviewItem", value: result.reviewItemName, kind: "review-item" },
    { label: "Selected candidate", value: result.selectedCandidateId ?? "none", kind: "candidate" },
    {
      label: "Selected claim",
      value: selectedCandidate?.claimTarget.claimId ?? "not provided",
      kind: "claim",
    },
  ], { item, candidate: selectedCandidate }, adapter);
}

function withTraceLinks(
  refs: readonly ReviewTraceRef[],
  context: ReviewTracePresentationContext,
  adapter: ReviewPresentationAdapter,
): ReviewTraceRef[] {
  return refs.map((ref) => ({
    ...ref,
    link: ref.link ?? adapter.linkForTraceRef?.(ref, context),
  }));
}

function defaultCandidateRoleLabel(role: ReviewCandidate["role"] | undefined): string {
  if (role === "current") return "Current value";
  if (role === "proposed") return "Proposed value";
  return "Candidate";
}

function urlLink(value: string): ReviewPresentationLink | undefined {
  if (!/^https?:\/\//.test(value)) {
    return undefined;
  }

  return {
    label: displayUrl(value),
    href: value,
  };
}

function displayUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return value;
  }
}
