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
}

export interface ReviewResultPresentation {
  readonly result: ReviewWorkbenchResult;
  readonly item?: ReviewItem;
  readonly target: string;
  readonly targetLabel: string;
  readonly decisionLabel: string;
  readonly selectedValueText: string;
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

  return {
    result,
    item,
    target,
    targetLabel,
    decisionLabel: humanizeIdentifier(result.decision),
    selectedValueText: selectedCandidate && item
      ? buildReviewCandidatePresentation(item, selectedCandidate, adapter, targetLabel).valueText
      : result.selectedDisplayValue,
    applyMeaning: result.selectedCandidateRole === "proposed"
      ? "Saved decision applies proposed value"
      : "Saved decision keeps current value",
    reviewItemLink: item && itemContext ? adapter.linkForReviewItem?.(item, itemContext) : undefined,
    traceRefs: item
      ? traceRefsForResult(item, result, selectedCandidate, adapter)
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
    { label: "Selected candidate", value: result.selectedCandidateId, kind: "candidate" },
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
