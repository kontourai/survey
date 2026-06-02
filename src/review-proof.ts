import { createHash } from "node:crypto";
import type { IntegrityAnchor } from "@kontourai/surface";
import type {
  Candidate,
  CandidateSet,
  ClaimTarget,
  Extraction,
  RawSource,
  ReviewOutcome,
} from "./types.js";

export interface ReviewProofInput {
  rawSource: RawSource;
  extraction: Extraction;
  candidate: Candidate;
  candidateSet: CandidateSet;
  reviewOutcome?: ReviewOutcome;
  claim: ClaimTarget;
  sourceRef?: string;
  observedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalReviewProofPayload {
  schemaVersion: 1;
  rawSource: {
    id: string;
    kind: RawSource["kind"];
    sourceRef: string;
    observedAt: string;
    fetchedAt?: string;
    checksum?: string;
    locatorScheme: RawSource["locatorScheme"];
  };
  extraction: {
    id: string;
    sourceId: string;
    target: string;
    value: unknown;
    confidence?: number;
    locator?: string;
    excerpt?: string;
    extractor: string;
    extractedAt: string;
  };
  candidate: {
    id: string;
    extractionId: string;
    value: unknown;
    confidence?: number;
    sourceRank?: number;
  };
  candidateSet: {
    id: string;
    target: string;
    candidateIds: string[];
    selectedCandidateId?: string;
    status: CandidateSet["status"];
    rationale?: string;
  };
  reviewOutcome?: {
    id: string;
    candidateSetId: string;
    candidateId?: string;
    status: ReviewOutcome["status"];
    actor?: string;
    reviewedAt?: string;
    rationale?: string;
    evidenceIds?: string[];
  };
  claim: {
    id: string;
    candidateSetId: string;
    candidateId?: string;
    subjectType: string;
    subjectId: string;
    surface: string;
    claimType: string;
    fieldOrBehavior: string;
    value?: unknown;
    status?: ClaimTarget["status"];
    impactLevel: ClaimTarget["impactLevel"];
    createdAt?: string;
    updatedAt?: string;
    evidenceType?: ClaimTarget["evidenceType"];
    evidenceMethod?: ClaimTarget["evidenceMethod"];
    confidenceBasis?: ClaimTarget["confidenceBasis"];
    derivedFrom?: string[];
    derivationEdges?: Array<Omit<NonNullable<ClaimTarget["derivationEdges"]>[number], "metadata">>;
    collectedBy: string;
    actor?: string;
    eventMethod?: string;
  };
}

export function buildCanonicalReviewProofPayload(input: ReviewProofInput): CanonicalReviewProofPayload {
  return {
    schemaVersion: 1,
    rawSource: {
      id: input.rawSource.id,
      kind: input.rawSource.kind,
      sourceRef: input.rawSource.sourceRef,
      observedAt: input.rawSource.observedAt,
      fetchedAt: input.rawSource.fetchedAt,
      checksum: input.rawSource.checksum,
      locatorScheme: input.rawSource.locatorScheme,
    },
    extraction: {
      id: input.extraction.id,
      sourceId: input.extraction.sourceId,
      target: input.extraction.target,
      value: input.extraction.value,
      confidence: input.extraction.confidence,
      locator: input.extraction.locator,
      excerpt: input.extraction.excerpt,
      extractor: input.extraction.extractor,
      extractedAt: input.extraction.extractedAt,
    },
    candidate: {
      id: input.candidate.id,
      extractionId: input.candidate.extractionId,
      value: input.candidate.value,
      confidence: input.candidate.confidence,
      sourceRank: input.candidate.sourceRank,
    },
    candidateSet: {
      id: input.candidateSet.id,
      target: input.candidateSet.target,
      candidateIds: input.candidateSet.candidates.map((candidate) => candidate.id).sort(),
      selectedCandidateId: input.candidateSet.selectedCandidateId,
      status: input.candidateSet.status,
      rationale: input.candidateSet.rationale,
    },
    reviewOutcome: input.reviewOutcome
      ? {
          id: input.reviewOutcome.id,
          candidateSetId: input.reviewOutcome.candidateSetId,
          candidateId: input.reviewOutcome.candidateId,
          status: input.reviewOutcome.status,
          actor: input.reviewOutcome.actor,
          reviewedAt: input.reviewOutcome.reviewedAt,
          rationale: input.reviewOutcome.rationale,
          evidenceIds: input.reviewOutcome.evidenceIds ? [...input.reviewOutcome.evidenceIds].sort() : undefined,
        }
      : undefined,
    claim: {
      id: input.claim.id,
      candidateSetId: input.claim.candidateSetId,
      candidateId: input.claim.candidateId,
      subjectType: input.claim.subjectType,
      subjectId: input.claim.subjectId,
      surface: input.claim.surface,
      claimType: input.claim.claimType,
      fieldOrBehavior: input.claim.fieldOrBehavior,
      value: input.claim.value,
      status: input.claim.status,
      impactLevel: input.claim.impactLevel,
      createdAt: input.claim.createdAt,
      updatedAt: input.claim.updatedAt,
      evidenceType: input.claim.evidenceType,
      evidenceMethod: input.claim.evidenceMethod,
      confidenceBasis: input.claim.confidenceBasis,
      derivedFrom: input.claim.derivedFrom ? [...input.claim.derivedFrom].sort() : undefined,
      derivationEdges: input.claim.derivationEdges?.map((edge) => ({
        inputClaimId: edge.inputClaimId,
        method: edge.method,
        role: edge.role,
        supportStrength: edge.supportStrength,
        rationale: edge.rationale,
      })),
      collectedBy: input.claim.collectedBy,
      actor: input.claim.actor,
      eventMethod: input.claim.eventMethod,
    },
  };
}

export function canonicalReviewProofJson(payload: CanonicalReviewProofPayload): string {
  return JSON.stringify(canonicalize(payload));
}

export function hashCanonicalReviewProofPayload(payload: CanonicalReviewProofPayload): string {
  return createHash("sha256").update(canonicalReviewProofJson(payload)).digest("hex");
}

export function buildReviewProofAnchor(input: ReviewProofInput): IntegrityAnchor {
  const payload = buildCanonicalReviewProofPayload(input);
  const hash = hashCanonicalReviewProofPayload(payload);
  return {
    id: `review-proof.${input.claim.id}.${hash.slice(0, 16)}`,
    kind: "hash",
    algorithm: "sha256",
    value: hash,
    sourceRef: input.sourceRef ?? input.rawSource.sourceRef,
    observedAt: input.observedAt ?? input.reviewOutcome?.reviewedAt ?? input.rawSource.observedAt,
    verificationStatus: "unverified",
    metadata: input.metadata,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!isRecord(value)) return value;

  const canonical: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) {
      Object.defineProperty(canonical, key, {
        value: canonicalize(item),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return canonical;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
