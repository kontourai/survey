import { createHash } from "node:crypto";
import type { IntegrityAnchor } from "@kontourai/surface";
import type {
  Candidate,
  CandidateSet,
  ClaimTarget,
  Extraction,
  RawSource,
  ReviewAuthorizing,
  ReviewOutcome,
} from "./types.js";
import { validateAuthorizing } from "./review-authorizing.js";
import { assertReviewResolutionConsistency } from "./producer-discipline.js";

export const REVIEW_PROOF_SCHEMA = "survey.review-proof";
export const REVIEW_PROOF_SCHEMA_VERSION = 3;
export const REVIEW_PROOF_PACKAGE_NAME = "@kontourai/survey";
// Version of the review proof contract emitted by this helper. This is intentionally
// independent from the npm package release version because it participates in hashes.
export const REVIEW_PROOF_CONTRACT_VERSION = "3";

const LEGACY_REVIEW_PROOF_SCHEMA_VERSION = 1;
const LEGACY_REVIEW_PROOF_CONTRACT_VERSION = "1";
const REVIEW_PROOF_SCHEMA_VERSION_V2 = 2;
const REVIEW_PROOF_CONTRACT_VERSION_V2 = "2";

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

export interface CanonicalReviewProofPayloadV1 {
  schemaVersion: 1;
  proof: {
    schema: typeof REVIEW_PROOF_SCHEMA;
    schemaVersion: typeof LEGACY_REVIEW_PROOF_SCHEMA_VERSION;
    packageName: typeof REVIEW_PROOF_PACKAGE_NAME;
    packageVersion: typeof LEGACY_REVIEW_PROOF_CONTRACT_VERSION;
    issuer: string;
    producer: string;
    issuedAt: string;
    subject: {
      claimId: string;
      candidateSetId: string;
      candidateId?: string;
      subjectType: string;
      subjectId: string;
      facet: string;
      claimType: string;
      fieldOrBehavior: string;
    };
    sourcePayload: {
      id: string;
      sourceRef: string;
      checksum?: string;
    };
  };
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
    facet: string;
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

type CanonicalReviewAuthorizing =
  | (Extract<ReviewAuthorizing, { kind: "explicit-statement" }> & { authorityRef?: never })
  | (Extract<ReviewAuthorizing, { kind: "exchange" }> & { authorityRef?: never })
  | (Extract<ReviewAuthorizing, { kind: "authorized-action" }> & { source?: never });

export type CanonicalReviewProofPayloadV2 = Omit<
  CanonicalReviewProofPayloadV1,
  "schemaVersion" | "proof" | "reviewOutcome"
> & {
  schemaVersion: 2;
  proof: Omit<CanonicalReviewProofPayloadV1["proof"], "schemaVersion" | "packageVersion"> & {
    schemaVersion: typeof REVIEW_PROOF_SCHEMA_VERSION_V2;
    packageVersion: typeof REVIEW_PROOF_CONTRACT_VERSION_V2;
  };
  reviewOutcome?: NonNullable<CanonicalReviewProofPayloadV1["reviewOutcome"]> & {
    authorizing?: CanonicalReviewAuthorizing;
  };
};

export type CanonicalReviewProofPayloadV3 = Omit<
  CanonicalReviewProofPayloadV2,
  "schemaVersion" | "proof" | "reviewOutcome"
> & {
  schemaVersion: 3;
  proof: Omit<CanonicalReviewProofPayloadV2["proof"], "schemaVersion" | "packageVersion"> & {
    schemaVersion: typeof REVIEW_PROOF_SCHEMA_VERSION;
    packageVersion: typeof REVIEW_PROOF_CONTRACT_VERSION;
  };
  reviewOutcome?: NonNullable<CanonicalReviewProofPayloadV2["reviewOutcome"]> & {
    resolution?: ReviewOutcome["resolution"];
    resolutionReason?: string;
    attemptEvidenceIds?: string[];
  };
};

export type CanonicalReviewProofPayload =
  | CanonicalReviewProofPayloadV1
  | CanonicalReviewProofPayloadV2
  | CanonicalReviewProofPayloadV3;

export function buildCanonicalReviewProofPayload(input: ReviewProofInput): CanonicalReviewProofPayloadV3 {
  assertCandidateConsistency(input);
  if (input.reviewOutcome) {
    assertReviewResolutionConsistency("Canonical review proof", input.reviewOutcome);
  }

  return {
    schemaVersion: REVIEW_PROOF_SCHEMA_VERSION,
    proof: {
      schema: REVIEW_PROOF_SCHEMA,
      schemaVersion: REVIEW_PROOF_SCHEMA_VERSION,
      packageName: REVIEW_PROOF_PACKAGE_NAME,
      packageVersion: REVIEW_PROOF_CONTRACT_VERSION,
      issuer: input.claim.collectedBy,
      producer: input.extraction.extractor,
      issuedAt: input.reviewOutcome?.reviewedAt ?? input.claim.updatedAt ?? input.extraction.extractedAt,
      subject: {
        claimId: input.claim.id,
        candidateSetId: input.claim.candidateSetId,
        candidateId: input.candidate.id,
        subjectType: input.claim.subjectType,
        subjectId: input.claim.subjectId,
        facet: input.claim.facet,
        claimType: input.claim.claimType,
        fieldOrBehavior: input.claim.fieldOrBehavior,
      },
      sourcePayload: {
        id: input.rawSource.id,
        sourceRef: input.rawSource.sourceRef,
        checksum: input.rawSource.checksum,
      },
    },
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
          ...(input.reviewOutcome.resolution !== undefined ? { resolution: input.reviewOutcome.resolution } : {}),
          ...(input.reviewOutcome.resolutionReason !== undefined
            ? { resolutionReason: input.reviewOutcome.resolutionReason }
            : {}),
          ...(input.reviewOutcome.attemptEvidenceIds
            ? { attemptEvidenceIds: [...input.reviewOutcome.attemptEvidenceIds].sort() }
            : {}),
          actor: input.reviewOutcome.actor,
          reviewedAt: input.reviewOutcome.reviewedAt,
          rationale: input.reviewOutcome.rationale,
          evidenceIds: input.reviewOutcome.evidenceIds ? [...input.reviewOutcome.evidenceIds].sort() : undefined,
          authorizing: copyCanonicalAuthorizing(input.reviewOutcome.authorizing),
        }
      : undefined,
    claim: {
      id: input.claim.id,
      candidateSetId: input.claim.candidateSetId,
      candidateId: input.claim.candidateId,
      subjectType: input.claim.subjectType,
      subjectId: input.claim.subjectId,
      facet: input.claim.facet,
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

function copyCanonicalAuthorizing(authorizing: ReviewAuthorizing | undefined): CanonicalReviewAuthorizing | undefined {
  if (authorizing === undefined) return undefined;

  const kind = authorizing.kind;
  let snapshot: CanonicalReviewAuthorizing;

  switch (kind) {
    case "explicit-statement":
      snapshot = {
        kind,
        statement: authorizing.statement,
        source: authorizing.source,
      };
      break;
    case "exchange":
      snapshot = {
        kind,
        prompt: authorizing.prompt,
        response: authorizing.response,
        source: authorizing.source,
      };
      break;
    case "authorized-action":
      snapshot = {
        kind,
        promptRef: authorizing.promptRef,
        renderedPrompt: authorizing.renderedPrompt,
        action: authorizing.action,
        authorityRef: authorizing.authorityRef,
      };
      break;
    default:
      snapshot = { kind } as unknown as CanonicalReviewAuthorizing;
  }

  const issues = validateAuthorizing(snapshot);
  if (issues.length > 0) {
    throw new Error(
      `Canonical review proof has invalid authorizing: ${issues.map((issue) => issue.message).join(" ")}`,
    );
  }
  return snapshot;
}

function assertCandidateConsistency(input: ReviewProofInput): void {
  if (input.extraction.sourceId !== input.rawSource.id) {
    throw new Error(
      `Review proof extraction sourceId "${input.extraction.sourceId}" does not match raw source id "${input.rawSource.id}".`,
    );
  }
  if (input.candidate.extractionId !== input.extraction.id) {
    throw new Error(
      `Review proof candidate extractionId "${input.candidate.extractionId}" does not match extraction id "${input.extraction.id}".`,
    );
  }
  if (!input.candidateSet.candidates.some((candidate) => candidate.id === input.candidate.id)) {
    throw new Error(
      `Review proof candidate id "${input.candidate.id}" is not present in candidate set "${input.candidateSet.id}".`,
    );
  }
  if (input.candidateSet.selectedCandidateId && input.candidateSet.selectedCandidateId !== input.candidate.id) {
    throw new Error(
      `Review proof candidate set selectedCandidateId "${input.candidateSet.selectedCandidateId}" does not match reviewed candidate id "${input.candidate.id}".`,
    );
  }
  if (input.claim.candidateSetId !== input.candidateSet.id) {
    throw new Error(
      `Review proof claim candidateSetId "${input.claim.candidateSetId}" does not match candidate set id "${input.candidateSet.id}".`,
    );
  }
  if (input.claim.candidateId && input.claim.candidateId !== input.candidate.id) {
    throw new Error(
      `Review proof claim candidateId "${input.claim.candidateId}" does not match reviewed candidate id "${input.candidate.id}".`,
    );
  }
  if (input.reviewOutcome && input.reviewOutcome.candidateSetId !== input.candidateSet.id) {
    throw new Error(
      `Review proof review outcome candidateSetId "${input.reviewOutcome.candidateSetId}" does not match candidate set id "${input.candidateSet.id}".`,
    );
  }
  if (input.reviewOutcome?.candidateId && input.reviewOutcome.candidateId !== input.candidate.id) {
    throw new Error(
      `Review proof review outcome candidateId "${input.reviewOutcome.candidateId}" does not match reviewed candidate id "${input.candidate.id}".`,
    );
  }
}

export function canonicalReviewProofJson(payload: CanonicalReviewProofPayload): string {
  return JSON.stringify(canonicalize(payload));
}

export function hashCanonicalReviewProofPayload(payload: CanonicalReviewProofPayload): string {
  return createHash("sha256").update(canonicalReviewProofJson(payload)).digest("hex");
}

/**
 * Verifies the integrity hash of a persisted v1, v2, or v3 canonical review proof.
 * Envelope compatibility and version-specific admissibility are checked before
 * the expected hash is compared.
 */
export function verifyCanonicalReviewProofPayload(payload: unknown, expectedHash: string): boolean {
  try {
    const snapshot = canonicalize(payload);
    const canonicalJson = JSON.stringify(snapshot);
    if (typeof canonicalJson !== "string" || !isRecord(snapshot) || !isRecord(snapshot.proof)) return false;
    if (snapshot.proof.schema !== REVIEW_PROOF_SCHEMA) return false;
    if (snapshot.proof.packageName !== REVIEW_PROOF_PACKAGE_NAME) return false;

    const schemaVersion = snapshot.schemaVersion;
    const proofSchemaVersion = snapshot.proof.schemaVersion;
    const packageVersion = snapshot.proof.packageVersion;
    const reviewOutcome = snapshot.reviewOutcome;

    if (schemaVersion === LEGACY_REVIEW_PROOF_SCHEMA_VERSION) {
      if (
        proofSchemaVersion !== LEGACY_REVIEW_PROOF_SCHEMA_VERSION
        || packageVersion !== LEGACY_REVIEW_PROOF_CONTRACT_VERSION
      ) {
        return false;
      }
      if (
        isRecord(reviewOutcome)
        && (Object.prototype.hasOwnProperty.call(reviewOutcome, "authorizing")
          || Object.prototype.hasOwnProperty.call(reviewOutcome, "resolution")
          || Object.prototype.hasOwnProperty.call(reviewOutcome, "resolutionReason")
          || Object.prototype.hasOwnProperty.call(reviewOutcome, "attemptEvidenceIds"))
      ) {
        return false;
      }
    } else if (schemaVersion === REVIEW_PROOF_SCHEMA_VERSION_V2) {
      if (proofSchemaVersion !== REVIEW_PROOF_SCHEMA_VERSION_V2 || packageVersion !== REVIEW_PROOF_CONTRACT_VERSION_V2) {
        return false;
      }
      if (reviewOutcome !== undefined && !isRecord(reviewOutcome)) return false;
      if (
        isRecord(reviewOutcome)
        && Object.prototype.hasOwnProperty.call(reviewOutcome, "authorizing")
        && reviewOutcome.authorizing !== undefined
        && validateAuthorizing(reviewOutcome.authorizing).length > 0
      ) {
        return false;
      }
      if (
        isRecord(reviewOutcome)
        && (Object.prototype.hasOwnProperty.call(reviewOutcome, "resolution")
          || Object.prototype.hasOwnProperty.call(reviewOutcome, "resolutionReason")
          || Object.prototype.hasOwnProperty.call(reviewOutcome, "attemptEvidenceIds"))
      ) {
        return false;
      }
    } else if (schemaVersion === REVIEW_PROOF_SCHEMA_VERSION) {
      if (proofSchemaVersion !== REVIEW_PROOF_SCHEMA_VERSION || packageVersion !== REVIEW_PROOF_CONTRACT_VERSION) {
        return false;
      }
      if (reviewOutcome !== undefined && !isRecord(reviewOutcome)) return false;
      if (
        isRecord(reviewOutcome)
        && Object.prototype.hasOwnProperty.call(reviewOutcome, "authorizing")
        && reviewOutcome.authorizing !== undefined
        && validateAuthorizing(reviewOutcome.authorizing).length > 0
      ) {
        return false;
      }
      if (isRecord(reviewOutcome)) {
        if (
          reviewOutcome.resolution !== undefined
          && reviewOutcome.resolution !== "accepted"
          && reviewOutcome.resolution !== "rejected"
          && reviewOutcome.resolution !== "held"
          && reviewOutcome.resolution !== "could_not_confirm"
        ) {
          return false;
        }
        if (
          reviewOutcome.attemptEvidenceIds !== undefined
          && (!Array.isArray(reviewOutcome.attemptEvidenceIds)
            || reviewOutcome.attemptEvidenceIds.some((id) => typeof id !== "string"))
        ) {
          return false;
        }
        assertReviewResolutionConsistency(
          "Canonical review proof",
          reviewOutcome as unknown as ReviewOutcome,
        );
      }
    } else {
      return false;
    }

    return createHash("sha256").update(canonicalJson).digest("hex") === expectedHash;
  } catch {
    return false;
  }
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
