import { type ReviewCandidate, type ReviewItem } from "../review-resource.js";
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
  const selectedCandidate = item?.spec.candidates.find((candidate) =>
    candidate.role === result.selectedCandidateRole || candidate.id === result.selectedCandidateId);

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
