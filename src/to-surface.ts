import type { Claim, Evidence, TrustInput, TrustStatus, VerificationEvent } from "@kontourai/surface";
import type {
  Candidate,
  CandidateSet,
  ClaimTarget,
  DerivedClaimTarget,
  Extraction,
  RawSource,
  ReviewOutcome,
  SurveyInput,
} from "./types.js";

export function buildSurveyTrustInput(input: SurveyInput): TrustInput {
  const rawSources = indexById(input.rawSources, "raw source");
  const extractions = indexById(input.extractions, "extraction");
  const candidateSets = indexById(input.candidateSets, "candidate set");
  const reviewsByCandidateSet = groupBy(input.reviewOutcomes, (review) => review.candidateSetId);

  const claims: Claim[] = [];
  const evidence: Evidence[] = [];
  const events: VerificationEvent[] = [];

  for (const projection of input.claims) {
    const candidateSet = requireMapValue(candidateSets, projection.candidateSetId, "candidate set");
    const candidate = selectCandidate(candidateSet, projection.candidateId);
    const extraction = requireMapValue(extractions, candidate.extractionId, "extraction");
    const rawSource = requireMapValue(rawSources, extraction.sourceId, "raw source");
    const review = selectReview(reviewsByCandidateSet.get(candidateSet.id) ?? [], candidate.id);
    const status = projection.status ?? statusFor({ candidateSet, candidate, review });
    assertProducerDiscipline({ status, review, extraction, rawSource, projection });
    const claimValue = projection.value ?? candidate.value;
    const createdAt = projection.createdAt ?? extraction.extractedAt;
    const updatedAt = projection.updatedAt ?? review?.reviewedAt ?? input.generatedAt;
    const evidenceId = `${projection.id}.evidence.source`;

    claims.push({
      id: projection.id,
      subjectType: projection.subjectType,
      subjectId: projection.subjectId,
      surface: projection.surface,
      claimType: projection.claimType,
      fieldOrBehavior: projection.fieldOrBehavior,
      value: claimValue,
      status,
      createdAt,
      updatedAt,
      impactLevel: projection.impactLevel,
      confidenceBasis: {
        sourceQuality: "moderate",
        extractionConfidence: candidate.confidence ?? extraction.confidence,
        reviewerAuthority: status === "verified" || status === "assumed" ? "operator" : "none",
        evidenceStrength: status === "verified" || status === "assumed" ? "moderate" : "weak",
        impactLevel: projection.impactLevel,
        ...projection.confidenceBasis,
      },
      metadata: {
        ...projection.metadata,
        survey: {
          ...(isRecord(projection.metadata?.survey) ? projection.metadata.survey : {}),
          rawSourceId: rawSource.id,
          extractionId: extraction.id,
          candidateSetId: candidateSet.id,
          candidateId: candidate.id,
          reviewOutcomeId: review?.id,
        },
      },
    });

    evidence.push({
      id: evidenceId,
      claimId: projection.id,
      evidenceType: projection.evidenceType ?? evidenceTypeFor(rawSource),
      method: projection.evidenceMethod ?? "extraction",
      sourceRef: rawSource.sourceRef,
      sourceLocator: extraction.locator,
      excerptOrSummary: extraction.excerpt ?? `Extracted ${projection.fieldOrBehavior} from ${rawSource.kind}.`,
      observedAt: rawSource.observedAt,
      collectedBy: projection.collectedBy,
      integrityRef: rawSource.checksum,
      metadata: {
        ...rawSource.metadata,
        ...extraction.metadata,
        ...candidate.metadata,
        rawSourceKind: rawSource.kind,
        locatorScheme: rawSource.locatorScheme,
        confidence: candidate.confidence ?? extraction.confidence,
      },
    });

    events.push({
      id: `${projection.id}.event.${status}`,
      claimId: projection.id,
      status,
      actor: projection.actor ?? review?.actor ?? projection.collectedBy,
      method: projection.eventMethod ?? eventMethodFor(status, candidateSet),
      evidenceIds: review?.evidenceIds?.length ? review.evidenceIds : [evidenceId],
      createdAt: review?.reviewedAt ?? input.generatedAt,
      verifiedAt: status === "verified" || status === "assumed" ? review?.reviewedAt ?? input.generatedAt : undefined,
      notes: review?.rationale ?? candidateSet.rationale,
    });
  }

  for (const derived of input.derivedClaims ?? []) {
    addDerivedClaim({ derived, claims, evidence, events });
  }

  return {
    schemaVersion: 3,
    source: input.source,
    claims,
    evidence,
    policies: [],
    events,
  };
}

function addDerivedClaim(input: {
  derived: DerivedClaimTarget;
  claims: Claim[];
  evidence: Evidence[];
  events: VerificationEvent[];
}): void {
  const { derived } = input;
  input.claims.push({
    id: derived.id,
    subjectType: derived.subjectType,
    subjectId: derived.subjectId,
    surface: derived.surface,
    claimType: derived.claimType,
    fieldOrBehavior: derived.fieldOrBehavior,
    value: derived.value,
    status: derived.status,
    createdAt: derived.createdAt,
    updatedAt: derived.updatedAt,
    impactLevel: derived.impactLevel,
    derivationEdges: derived.inputClaimIds.map((edge) => ({
      inputClaimId: edge.claimId,
      method: "rule-application",
      role: edge.role,
      supportStrength: edge.supportStrength,
    })),
    metadata: derived.metadata,
  });
  const evidenceId = `${derived.id}.evidence.calculation`;
  input.evidence.push({
    id: evidenceId,
    claimId: derived.id,
    evidenceType: "calculation_trace",
    method: "validation",
    sourceRef: derived.sourceRef,
    excerptOrSummary: derived.evidenceSummary,
    observedAt: derived.updatedAt,
    collectedBy: derived.collectedBy,
  });
  input.events.push({
    id: `${derived.id}.event.${derived.status}`,
    claimId: derived.id,
    status: derived.status,
    actor: derived.collectedBy,
    method: "rule-application",
    evidenceIds: [evidenceId],
    createdAt: derived.updatedAt,
    verifiedAt: derived.status === "verified" ? derived.updatedAt : undefined,
  });
}

function statusFor(input: {
  candidateSet: CandidateSet;
  candidate: Candidate;
  review?: ReviewOutcome;
}): TrustStatus {
  if (input.review) return input.review.status;
  if (input.candidateSet.status === "resolved" && input.candidateSet.selectedCandidateId === input.candidate.id) {
    return "proposed";
  }
  if (input.candidateSet.status === "conflict") return "disputed";
  return "proposed";
}

function assertProducerDiscipline(input: {
  status: TrustStatus;
  review?: ReviewOutcome;
  extraction: Extraction;
  rawSource: RawSource;
  projection: ClaimTarget;
}): void {
  if ((input.status === "verified" || input.status === "assumed") && !input.review) {
    throw new Error(`Claim ${input.projection.id} cannot be ${input.status} without a review outcome`);
  }
  if ((input.status === "verified" || input.status === "assumed") && !input.review?.actor) {
    throw new Error(`Claim ${input.projection.id} cannot be ${input.status} without review actor authority`);
  }
  if ((input.status === "verified" || input.status === "assumed") && !input.review?.reviewedAt) {
    throw new Error(`Claim ${input.projection.id} cannot be ${input.status} without reviewedAt`);
  }
  if (input.rawSource.kind !== "manual-entry" && !input.extraction.locator) {
    throw new Error(`Claim ${input.projection.id} needs a source locator for ${input.rawSource.kind}`);
  }
}

function selectCandidate(candidateSet: CandidateSet, candidateId?: string): Candidate {
  const id = candidateId ?? candidateSet.selectedCandidateId ?? candidateSet.candidates[0]?.id;
  const candidate = candidateSet.candidates.find((item) => item.id === id);
  if (!candidate) {
    throw new Error(`Candidate set ${candidateSet.id} does not contain candidate ${id ?? "<none>"}`);
  }
  return candidate;
}

function selectReview(reviews: ReviewOutcome[], candidateId: string): ReviewOutcome | undefined {
  return reviews.find((review) => review.candidateId === candidateId) ?? reviews.find((review) => !review.candidateId);
}

function evidenceTypeFor(rawSource: RawSource): "document_citation" | "crawl_observation" | "attestation" {
  if (rawSource.kind === "uploaded-document") return "document_citation";
  if (rawSource.kind === "web-page") return "crawl_observation";
  return "attestation";
}

function eventMethodFor(status: TrustStatus, candidateSet: CandidateSet): string {
  if (status === "verified") return "survey-review";
  if (status === "assumed") return "survey-assumption";
  if (status === "rejected") return "survey-rejection";
  if (candidateSet.status === "conflict") return "candidate-conflict";
  return "candidate-proposal";
}

function indexById<T extends { id: string }>(items: T[], label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) throw new Error(`Duplicate ${label} id: ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

function requireMapValue<T>(map: Map<string, T>, id: string, label: string): T {
  const value = map.get(id);
  if (!value) throw new Error(`Missing ${label}: ${id}`);
  return value;
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
