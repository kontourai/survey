import { createHash } from "node:crypto";
import { canonicalJson } from "./review-workbench/canonical.js";
import type { ClaimTarget, ProvenanceResolution, RawSourceKind, SurveyInput } from "./types.js";

export interface ReviewProofReference {
  kind: "review-proof";
  algorithm: "sha256";
  value: string;
  proofSchemaVersion: 2;
}

export interface ProvenanceReference {
  kind: "provenance";
  rawSourceId: string;
  origin: RawSourceKind;
  resolution: ProvenanceResolution;
  reviewOutcomeId: string;
}

export interface OpaqueEvidenceReference { kind: "evidence"; id: string }
export type LearningUpdateEvidenceReference = ReviewProofReference | ProvenanceReference | OpaqueEvidenceReference;

export interface LearningUpdateProposal {
  id: string;
  kind: "learning.update-proposal";
  source: string;
  createdAt: string;
  subject: Pick<ClaimTarget, "subjectType" | "subjectId" | "facet" | "claimType" | "fieldOrBehavior">;
  applicability: { target: string };
  proposedDelta: { previousValue: unknown; proposedValue: unknown };
  evidenceRefs: LearningUpdateEvidenceReference[];
  authorizationRef: { reviewOutcomeId: string; reviewProofHash: string };
  reviewLineage: {
    candidateSetId: string;
    selectedCandidateId: string;
    unselectedCandidateIds: string[];
    reviewOutcomeId: string;
    selectedClaimId: string;
  };
}

export interface ReviewedLearningUpdateProposalInput {
  survey: SurveyInput;
  candidateSetId: string;
  reviewOutcomeId: string;
  selectedClaimId: string;
  proof: ReviewProofReference;
}

/** Builds data for a producer-owned application decision. It performs no I/O or domain validation. */
export function buildReviewedLearningUpdateProposal(input: ReviewedLearningUpdateProposalInput): LearningUpdateProposal {
  const { survey } = input;
  const candidateSet = exactlyOne(survey.candidateSets, ({ id }) => id === input.candidateSetId, "candidate set");
  if (!candidateSet || candidateSet.status !== "resolved") throw new Error("learning update requires a resolved candidate set");

  const roleCandidates = candidateSet.candidates.filter((candidate) => {
    const role = candidate.metadata?.candidateRole;
    return role === "current" || role === "proposed";
  });
  const current = roleCandidates.filter(({ metadata }) => metadata?.candidateRole === "current");
  const proposed = roleCandidates.filter(({ metadata }) => metadata?.candidateRole === "proposed");
  assertUniqueIds(candidateSet.candidates, "candidate");
  if (current.length !== 1 || proposed.length !== 1) {
    throw new Error("learning update requires exactly one current and one proposed candidate role");
  }
  const currentCandidate = current[0]!;
  const proposedCandidate = proposed[0]!;
  if (candidateSet.selectedCandidateId !== proposedCandidate.id) throw new Error("learning update requires the proposed candidate to be selected");

  const review = exactlyOne(survey.reviewOutcomes, ({ id }) => id === input.reviewOutcomeId, "review outcome");
  if (!review || review.candidateSetId !== candidateSet.id || review.candidateId !== candidateSet.selectedCandidateId) {
    throw new Error("review outcome must identify the selected candidate and candidate set");
  }
  if (review.status !== "verified" && review.status !== "assumed") throw new Error("learning update requires an accepted review status");
  if (!review.reviewedAt) throw new Error("learning update requires reviewedAt");
  if (!review.authorizing) throw new Error("learning update requires authorizing review provenance");

  assertCanonicalProofReference(input.proof);
  const selectedClaim = exactlyOne(survey.claims, ({ id }) => id === input.selectedClaimId, "selected claim");
  if (!selectedClaim || selectedClaim.candidateSetId !== candidateSet.id || selectedClaim.candidateId !== proposedCandidate.id) {
    throw new Error("selected claim must identify the selected proposed candidate and candidate set");
  }
  if (selectedClaim.status !== "verified" && selectedClaim.status !== "assumed") {
    throw new Error("learning update requires an accepted selected claim status");
  }
  if (selectedClaim.status !== review.status) throw new Error("selected claim status must match the accepted review status");
  const currentClaim = exactlyOne(survey.claims, ({ candidateSetId, candidateId }) => candidateSetId === candidateSet.id && candidateId === currentCandidate.id, "current claim");
  if (!currentClaim || !sameSubject(currentClaim, selectedClaim)) throw new Error("current and selected claim lineage must share a subject");
  const unselectedCandidates = candidateSet.candidates.filter(({ id }) => id !== proposedCandidate.id);
  for (const candidate of unselectedCandidates) {
    const claim = exactlyOne(survey.claims, ({ candidateSetId, candidateId }) => candidateSetId === candidateSet.id && candidateId === candidate.id, "unselected claim");
    if (claim.status !== "superseded") throw new Error("unselected claim status must be superseded");
  }

  assertCanonicalJsonValue(currentCandidate.value);
  assertCanonicalJsonValue(proposedCandidate.value);

  const currentSource = sourceForCandidate(survey, candidateSet.target, currentCandidate.id, currentCandidate.extractionId, currentCandidate.value);
  const proposedSource = sourceForCandidate(survey, candidateSet.target, proposedCandidate.id, proposedCandidate.extractionId, proposedCandidate.value);
  const provenanceRefs = [currentSource, proposedSource].map((source): ProvenanceReference => {
    if (source.resolution !== "supersession") throw new Error(`candidate ${source.id} requires explicit supersession provenance`);
    return { kind: "provenance", rawSourceId: source.id, origin: source.kind, resolution: source.resolution, reviewOutcomeId: review.id };
  });
  const evidenceCandidates: LearningUpdateEvidenceReference[] = [
    ...(review.evidenceIds ?? []).map((id): OpaqueEvidenceReference => ({ kind: "evidence", id })),
    ...provenanceRefs,
    { ...input.proof },
  ];
  const evidenceRefs = [...new Map(evidenceCandidates.map((reference) => [canonicalJson(reference), reference])).values()]
    .sort((left, right) => evidenceRank(left) - evidenceRank(right) || canonicalJson(left).localeCompare(canonicalJson(right)));
  const subject = pickSubject(selectedClaim);
  const reviewLineage = {
    candidateSetId: candidateSet.id,
    selectedCandidateId: proposedCandidate.id,
    unselectedCandidateIds: unselectedCandidates.map(({ id }) => id).sort(),
    reviewOutcomeId: review.id,
    selectedClaimId: selectedClaim.id,
  };
  const authorizationRef = { reviewOutcomeId: review.id, reviewProofHash: input.proof.value };
  const proposalWithoutId = {
    kind: "learning.update-proposal" as const,
    source: survey.source,
    createdAt: review.reviewedAt,
    subject,
    applicability: { target: candidateSet.target },
    proposedDelta: { previousValue: currentCandidate.value, proposedValue: proposedCandidate.value },
    evidenceRefs,
    authorizationRef,
    reviewLineage,
  };
  const identityPayload = { identitySchemaVersion: 1, ...proposalWithoutId };
  return { id: createHash("sha256").update(canonicalJson(identityPayload)).digest("hex"), ...proposalWithoutId };
}

function assertCanonicalProofReference(proof: ReviewProofReference): void {
  if (proof?.kind !== "review-proof" || proof.algorithm !== "sha256" || proof.proofSchemaVersion !== 2) {
    throw new Error("learning update requires an identified canonical v2 review proof");
  }
  if (!/^[a-f0-9]{64}$/.test(proof.value)) throw new Error("canonical review proof must be a lowercase SHA-256 hash");
}

function sourceForCandidate(survey: SurveyInput, target: string, candidateId: string, extractionId: string, value: unknown) {
  const extraction = exactlyOne(survey.extractions, ({ id }) => id === extractionId, "extraction");
  assertCanonicalJsonValue(extraction.value);
  if (!extraction || extraction.target !== target || canonicalJson(extraction.value) !== canonicalJson(value)) {
    throw new Error(`candidate ${candidateId} has inconsistent extraction lineage`);
  }
  const source = exactlyOne(survey.rawSources, ({ id }) => id === extraction.sourceId, "raw source");
  if (!source) throw new Error(`candidate ${candidateId} has missing source lineage`);
  return source;
}

function pickSubject(claim: ClaimTarget): LearningUpdateProposal["subject"] {
  return { subjectType: claim.subjectType, subjectId: claim.subjectId, facet: claim.facet, claimType: claim.claimType, fieldOrBehavior: claim.fieldOrBehavior };
}

function sameSubject(left: ClaimTarget, right: ClaimTarget): boolean {
  return canonicalJson(pickSubject(left)) === canonicalJson(pickSubject(right));
}

function evidenceRank(reference: LearningUpdateEvidenceReference): number {
  if (reference.kind === "evidence") return 0;
  if (reference.kind === "provenance") return 1;
  return 2;
}

function exactlyOne<T>(records: T[], predicate: (record: T) => boolean, label: string): T {
  const matches = records.filter(predicate);
  if (matches.length !== 1) throw new Error(`learning update requires exactly one ${label}; found ${matches.length}`);
  return matches[0]!;
}

function assertUniqueIds(records: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const { id } of records) {
    if (ids.has(id)) throw new Error(`learning update rejects duplicate ${label} id ${id}`);
    ids.add(id);
  }
}

/** Values are limited to JSON primitives, arrays, and plain string-keyed objects. */
function assertCanonicalJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return;
    throw new Error("invalid canonical JSON value: number is not collision-free");
  }
  if (typeof value !== "object") throw new Error("invalid canonical JSON value: unsupported primitive");
  if (ancestors.has(value)) throw new Error("invalid canonical JSON value: cycle");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("invalid canonical JSON value: unsupported prototype");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("invalid canonical JSON value: symbol-keyed array property");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
    const actualKeys = Object.keys(descriptors).filter((key) => key !== "length");
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      throw new Error("invalid canonical JSON value: sparse or extra array property");
    }
    for (const key of expectedKeys) {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("invalid canonical JSON value: array accessor or hidden property");
      assertCanonicalJsonValue(descriptor.value, ancestors);
    }
  } else {
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("invalid canonical JSON value: symbol-keyed property");
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("invalid canonical JSON value: property is not enumerable data");
      assertCanonicalJsonValue(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}
