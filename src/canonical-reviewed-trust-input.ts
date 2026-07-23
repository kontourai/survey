import type {
  Candidate,
  CandidateSet,
  ClaimTarget,
  Extraction,
  RawSource,
  ReviewOutcome,
  SurveyInput,
} from "./types.js";
import { SURVEY_INPUT_CONTRACT_VERSION } from "./types.js";
import type { ReviewCandidate, ReviewItem } from "./review-resource.js";
import { canonicalJson } from "./review-workbench/canonical.js";
import type { ReviewWorkbenchResult } from "./review-workbench/review-workbench.js";
import { workbenchDecisionDefinitions } from "./review-workbench/review-queue-session.js";

export interface BuildCanonicalReviewedTrustInputOptions {
  /** Producer identity for the resulting SurveyInput batch. */
  readonly source: string;
  /** Server-controlled projection time. */
  readonly generatedAt: string;
  /** Stable producer-owned identity for this review projection. */
  readonly projectionContextId: string;
  /** Canonical ReviewItems from the server-owned pre-decision snapshot. */
  readonly items: readonly ReviewItem[];
  /** Results derived by Survey's server apply boundary from snapshot + events. */
  readonly results: readonly ReviewWorkbenchResult[];
}

export interface CanonicalReviewedTrustInput {
  readonly surveyInput: SurveyInput;
  /** Pass unchanged to buildSurveyTrustBundle's projectionContextId option. */
  readonly projectionContextId: string;
}

/**
 * Projects server-applied review records into the complete SurveyInput consumed
 * by buildSurveyTrustBundle. The ReviewItem and ReviewWorkbenchResult are the
 * authority: callers cannot override status, value, identity, or provenance.
 *
 * The helper deliberately returns the projection context beside SurveyInput
 * because repeated append-only projections need that context at the Surface
 * projection boundary, while SurveyInput's existing byte shape remains
 * unchanged for compatibility.
 */
export function buildCanonicalReviewedTrustInput(
  options: BuildCanonicalReviewedTrustInputOptions,
): CanonicalReviewedTrustInput {
  requireNonEmpty(options.source, "source");
  requireTimestamp(options.generatedAt, "generatedAt");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(options.projectionContextId)) {
    throw new Error("projectionContextId must be a non-empty portable resource-name fragment.");
  }

  const itemsByName = uniqueBy(options.items, (item) => item.metadata.name, "ReviewItem");
  const resultsByName = uniqueBy(options.results, (result) => result.reviewItemName, "ReviewWorkbenchResult");
  if (itemsByName.size !== resultsByName.size) {
    throw new Error("Canonical review projection requires exactly one resolved result for every ReviewItem.");
  }

  const rawSources = new Map<string, RawSource>();
  const extractions = new Map<string, Extraction>();
  const candidateSets = new Map<string, CandidateSet>();
  const reviewOutcomes = new Map<string, ReviewOutcome>();
  const claims = new Map<string, ClaimTarget>();

  for (const item of options.items) {
    const result = resultsByName.get(item.metadata.name);
    if (!result) {
      throw new Error(`ReviewItem ${item.metadata.name} has no canonical server-applied result.`);
    }
    assertCanonicalResult(item, result);

    const candidates = item.spec.candidates.map((candidate) => {
      const records = projectCandidate(item, candidate);
      addConsistent(rawSources, records.rawSource, "raw source");
      addConsistent(extractions, records.extraction, "extraction");
      return records.candidate;
    });

    const selected = item.spec.candidates.find((candidate) => candidate.id === result.selectedCandidateId)!;
    const selectedRecordId = selected.projection?.candidateId ?? selected.id;
    const candidateSetId = selected.projection?.candidateSetId
      ?? item.spec.projection?.candidateSetId
      ?? `${item.metadata.name}.candidates`;
    if (candidates.some((candidate) => candidate.metadata?.candidateSetId !== candidateSetId)) {
      throw new Error(`ReviewItem ${item.metadata.name} carries conflicting candidate-set projection ids.`);
    }

    const candidateSet: CandidateSet = {
      id: candidateSetId,
      target: item.spec.target,
      candidates: candidates.map(({ metadata, ...candidate }) => ({
        ...candidate,
        ...(metadata && Object.keys(metadata).length > 1
          ? { metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "candidateSetId")) }
          : {}),
      })),
      selectedCandidateId: selectedRecordId,
      status: result.decision === "could-not-confirm"
        ? (item.spec.candidateSetStatus ?? "needs-review")
        : "resolved",
      ...(result.rationale ?? item.spec.rationale
        ? { rationale: result.rationale ?? item.spec.rationale }
        : {}),
    };
    addConsistent(candidateSets, candidateSet, "candidate set");

    const decision = result.reviewDecision.spec;
    const reviewOutcomeId = decision.projection?.reviewOutcomeId
      ?? selected.projection?.reviewOutcomeId
      ?? `${item.metadata.name}.${result.decision}.review-outcome`;
    const reviewOutcome: ReviewOutcome = {
      id: reviewOutcomeId,
      candidateSetId,
      candidateId: selectedRecordId,
      status: result.status,
      ...(decision.resolution ? { resolution: decision.resolution } : {}),
      ...(decision.resolutionReason ? { resolutionReason: decision.resolutionReason } : {}),
      ...(decision.attemptEvidenceIds?.length ? { attemptEvidenceIds: [...decision.attemptEvidenceIds] } : {}),
      ...(decision.actor?.id ? { actor: decision.actor.id } : {}),
      ...(decision.reviewedAt ? { reviewedAt: decision.reviewedAt } : {}),
      ...(decision.rationale ? { rationale: decision.rationale } : {}),
      ...(decision.evidenceIds?.length ? { evidenceIds: [...decision.evidenceIds] } : {}),
      ...(decision.withinComfortZone !== undefined ? { withinComfortZone: decision.withinComfortZone } : {}),
      ...(decision.comfortZoneNote ? { comfortZoneNote: decision.comfortZoneNote } : {}),
      ...(decision.authorizing ? { authorizing: decision.authorizing } : {}),
      metadata: {
        workbenchDecision: result.decision,
        ...(result.editedValue !== undefined ? { editedValue: result.editedValue } : {}),
      },
    };
    addConsistent(reviewOutcomes, reviewOutcome, "review outcome");

    const hint = selected.claimTarget;
    assertSingleProjectionId("claim", item.metadata.name, [
      decision.projection?.claimId,
      item.spec.projection?.claimId,
      ...item.spec.candidates.flatMap((candidate) => [candidate.projection?.claimId, candidate.claimTarget.claimId]),
    ]);
    const claimId = decision.projection?.claimId
      ?? selected.projection?.claimId
      ?? item.spec.projection?.claimId
      ?? hint.claimId
      ?? `${item.metadata.name}.claim`;
    const claim: ClaimTarget = {
      id: claimId,
      candidateSetId,
      candidateId: selectedRecordId,
      subjectType: hint.subjectType,
      subjectId: hint.subjectId,
      facet: hint.facet,
      claimType: hint.claimType,
      fieldOrBehavior: hint.fieldOrBehavior,
      value: result.effectiveValue,
      status: result.status,
      impactLevel: hint.impactLevel,
      updatedAt: decision.reviewedAt ?? options.generatedAt,
      ...(hint.evidenceType ? { evidenceType: hint.evidenceType } : {}),
      ...(hint.evidenceMethod ? { evidenceMethod: hint.evidenceMethod } : {}),
      ...(hint.derivedFrom ? { derivedFrom: [...hint.derivedFrom] } : {}),
      collectedBy: hint.collectedBy ?? selected.extraction.extractor ?? options.source,
      ...(decision.actor?.id ? { actor: decision.actor.id } : {}),
    };
    addConsistent(claims, claim, "claim target");
  }

  return {
    projectionContextId: options.projectionContextId,
    surveyInput: {
      contractVersion: SURVEY_INPUT_CONTRACT_VERSION,
      source: options.source,
      generatedAt: options.generatedAt,
      rawSources: [...rawSources.values()],
      extractions: [...extractions.values()],
      candidateSets: [...candidateSets.values()],
      reviewOutcomes: [...reviewOutcomes.values()],
      claims: [...claims.values()],
    },
  };
}

function assertCanonicalResult(item: ReviewItem, result: ReviewWorkbenchResult): void {
  const selected = item.spec.candidates.find((candidate) => candidate.id === result.selectedCandidateId);
  if (!selected) {
    throw new Error(`Review result ${result.reviewItemName} selects an unknown candidate.`);
  }
  if (canonicalJson(selected) !== canonicalJson(result.selectedCandidate)) {
    throw new Error(`Review result ${result.reviewItemName} selected candidate does not match its canonical ReviewItem.`);
  }
  const unselected = item.spec.candidates.filter((candidate) => candidate.id !== selected.id);
  if (canonicalJson(unselected) !== canonicalJson(result.unselectedCandidates)) {
    throw new Error(`Review result ${result.reviewItemName} unselected candidates do not match its canonical ReviewItem.`);
  }
  if (result.selectedCandidateRole !== selected.role || canonicalJson(result.selectedValue) !== canonicalJson(selected.value)) {
    throw new Error(`Review result ${result.reviewItemName} selected identity does not match its canonical ReviewItem.`);
  }
  const decision = result.reviewDecision.spec;
  const definition = workbenchDecisionDefinitions[result.decision];
  if (decision.reviewItemName !== item.metadata.name
    || decision.candidateId !== result.selectedCandidateId
    || decision.status !== result.status
    || decision.status !== definition.status
    || decision.rationale !== result.rationale
    || canonicalJson(decision.editedValue) !== canonicalJson(result.editedValue)) {
    throw new Error(`Review result ${result.reviewItemName} contradicts its canonical ReviewDecision.`);
  }
  if ((result.decision === "could-not-confirm") !== (decision.resolution === "could_not_confirm")) {
    throw new Error(`Review result ${result.reviewItemName} contradicts its canonical review resolution.`);
  }
  const expectedEffective = result.editedValue !== undefined && result.decision === "accept-proposed"
    ? result.editedValue
    : selected.value;
  if (canonicalJson(expectedEffective) !== canonicalJson(result.effectiveValue)) {
    throw new Error(`Review result ${result.reviewItemName} effective value is not canonical.`);
  }
  for (const candidate of item.spec.candidates) {
    if (canonicalJson(claimTargetIdentity(candidate.claimTarget)) !== canonicalJson(claimTargetIdentity(selected.claimTarget))) {
      throw new Error(`ReviewItem ${item.metadata.name} candidates carry conflicting claim targets.`);
    }
  }
}

function claimTargetIdentity(target: ReviewCandidate["claimTarget"]): Omit<ReviewCandidate["claimTarget"], "claimId"> {
  const { claimId: _claimId, ...identity } = target;
  return identity;
}

function projectCandidate(item: ReviewItem, input: ReviewCandidate): {
  rawSource: RawSource;
  extraction: Extraction;
  candidate: Candidate;
} {
  const rawSourceId = input.projection?.rawSourceId ?? input.source.sourceId ?? `${item.metadata.name}.${input.id}.source`;
  const extractionId = input.projection?.extractionId ?? input.extraction.extractionId ?? `${item.metadata.name}.${input.id}.extraction`;
  const candidateSetId = input.projection?.candidateSetId ?? item.spec.projection?.candidateSetId ?? `${item.metadata.name}.candidates`;
  const sourceKind = input.source.kind;
  const observedAt = input.source.observedAt;
  const locatorScheme = input.source.locatorScheme ?? input.locator?.scheme;
  const extractor = input.extraction.extractor;
  const extractedAt = input.extraction.extractedAt;
  if (!sourceKind || !observedAt || !locatorScheme || !extractor || !extractedAt) {
    throw new Error(`ReviewCandidate ${input.id} lacks source or extraction provenance required for TrustInput projection.`);
  }
  const rawSource: RawSource = {
    id: rawSourceId,
    kind: sourceKind,
    sourceRef: input.source.sourceRef,
    observedAt,
    ...(input.source.fetchedAt ? { fetchedAt: input.source.fetchedAt } : {}),
    ...(input.source.checksum ? { checksum: input.source.checksum } : {}),
    locatorScheme,
  };
  const extraction: Extraction = {
    id: extractionId,
    sourceId: rawSourceId,
    target: input.extraction.target,
    value: input.value,
    ...(input.extraction.confidence ?? input.confidence) !== undefined
      ? { confidence: input.extraction.confidence ?? input.confidence }
      : {},
    ...(input.locator?.locator ? { locator: input.locator.locator } : {}),
    ...(input.locator?.excerpt ? { excerpt: input.locator.excerpt } : {}),
    extractor,
    extractedAt,
    ...(input.extraction.model ? { metadata: { model: input.extraction.model } } : {}),
  };
  const candidate: Candidate = {
    id: input.projection?.candidateId ?? input.id,
    extractionId,
    value: input.value,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.sourceRank !== undefined ? { sourceRank: input.sourceRank } : {}),
    ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
    metadata: {
      candidateSetId,
      ...(input.role ? { role: input.role } : {}),
      ...(input.producer ? { producer: input.producer } : {}),
    },
  };
  return { rawSource, extraction, candidate };
}

function uniqueBy<T>(values: readonly T[], id: (value: T) => string, label: string): Map<string, T> {
  const output = new Map<string, T>();
  for (const value of values) {
    const key = requireNonEmpty(id(value), `${label} identity`);
    if (output.has(key)) {
      throw new Error(`Canonical review projection received duplicate ${label} ${key}.`);
    }
    output.set(key, value);
  }
  return output;
}

function addConsistent<T extends { id: string }>(records: Map<string, T>, value: T, label: string): void {
  const existing = records.get(value.id);
  if (existing && canonicalJson(existing) !== canonicalJson(value)) {
    throw new Error(`Canonical review projection found conflicting ${label} ${value.id}.`);
  }
  records.set(value.id, value);
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must be non-empty.`);
  return value;
}

function requireTimestamp(value: string, label: string): void {
  if (!value.trim() || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
}

function assertSingleProjectionId(label: string, itemName: string, values: readonly (string | undefined)[]): void {
  const ids = new Set(values.filter((value): value is string => value !== undefined));
  if (ids.size > 1) {
    throw new Error(`ReviewItem ${itemName} carries conflicting ${label} projection ids.`);
  }
}
