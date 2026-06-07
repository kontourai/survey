import type {
  Candidate,
  CandidateSet,
  ClaimTarget,
  EscalationRecord,
  Extraction,
  Interpretation,
  ReviewStatus,
  RawSource,
  ReviewOutcome,
  SurveyInput,
} from "./types.js";

export interface SurveyInputBuilderArgs {
  source: string;
  generatedAt?: string;
}

export interface SurveyClaimRecord {
  rawSource: RawSource;
  extraction: Extraction;
  candidateSet: CandidateSet;
  reviewOutcome?: ReviewOutcome;
  claim: ClaimTarget;
}

export interface SurveyObservationInput {
  id: string;
  rawSource: Omit<RawSource, "id"> & { id?: string };
  extraction: Omit<Extraction, "id" | "sourceId"> & { id?: string };
  candidate?: {
    id?: string;
    confidence?: number;
    sourceRank?: number;
    metadata?: Record<string, unknown>;
  };
  candidateSet?: {
    id?: string;
    status?: CandidateSet["status"];
    rationale?: string;
    metadata?: Record<string, unknown>;
  };
  reviewOutcome?: Omit<ReviewOutcome, "id" | "candidateSetId" | "candidateId"> & { id?: string };
  claim: Omit<ClaimTarget, "id" | "candidateSetId" | "candidateId"> & { id?: string };
}

export interface CandidateReviewRecordInput {
  id: string;
  target: string;
  observations: SurveyObservationInput[];
  selectedCandidateId?: string;
  status?: CandidateSet["status"];
  rationale?: string;
  metadata?: Record<string, unknown>;
  reviewOutcome?: Omit<ReviewOutcome, "id" | "candidateSetId"> & {
    id?: string;
    candidateId?: string;
  };
}

export class SurveyInputBuilder {
  private readonly source: string;
  private readonly generatedAt: string;
  private readonly rawSources = new Map<string, RawSource>();
  private readonly extractions = new Map<string, Extraction>();
  private readonly candidateSets = new Map<string, CandidateSet>();
  private readonly reviewOutcomes = new Map<string, ReviewOutcome>();
  private readonly claims = new Map<string, ClaimTarget>();
  private readonly escalations = new Map<string, EscalationRecord>();
  private readonly interpretations = new Map<string, Interpretation>();

  constructor(args: SurveyInputBuilderArgs) {
    this.source = args.source;
    this.generatedAt = args.generatedAt ?? new Date().toISOString();
  }

  addRawSource(rawSource: RawSource): this {
    addUnique(this.rawSources, rawSource, "raw source");
    return this;
  }

  addExtraction(extraction: Extraction): this {
    addUnique(this.extractions, extraction, "extraction");
    return this;
  }

  addCandidateSet(candidateSet: CandidateSet): this {
    addUnique(this.candidateSets, candidateSet, "candidate set");
    return this;
  }

  addReviewOutcome(reviewOutcome: ReviewOutcome): this {
    addUnique(this.reviewOutcomes, reviewOutcome, "review outcome");
    return this;
  }

  addClaim(claim: ClaimTarget): this {
    addUnique(this.claims, claim, "claim target");
    return this;
  }

  addEscalation(escalation: EscalationRecord): this {
    addUnique(this.escalations, escalation, "escalation");
    return this;
  }

  addInterpretation(interpretation: Interpretation): this {
    addUnique(this.interpretations, interpretation, "interpretation");
    return this;
  }

  addClaimRecord(record: SurveyClaimRecord): this {
    this.addRecordRawSource(record.rawSource);
    this.addExtraction(record.extraction);
    this.addRecordCandidateSet(record.candidateSet);
    if (record.reviewOutcome) this.addReviewOutcome(record.reviewOutcome);
    this.addClaim(record.claim);
    return this;
  }

  addClaimRecords(records: SurveyClaimRecord[]): this {
    for (const record of records) this.addClaimRecord(record);
    return this;
  }

  addObservation(observation: SurveyObservationInput): this {
    return this.addClaimRecord(observationToClaimRecord(observation));
  }

  addObservations(observations: SurveyObservationInput[]): this {
    for (const observation of observations) this.addObservation(observation);
    return this;
  }

  build(): SurveyInput {
    return {
      source: this.source,
      generatedAt: this.generatedAt,
      rawSources: [...this.rawSources.values()],
      extractions: [...this.extractions.values()],
      candidateSets: [...this.candidateSets.values()],
      reviewOutcomes: [...this.reviewOutcomes.values()],
      claims: [...this.claims.values()],
      escalations: this.escalations.size > 0 ? [...this.escalations.values()] : undefined,
      interpretations: this.interpretations.size > 0 ? [...this.interpretations.values()] : undefined,
    };
  }

  private addRecordCandidateSet(candidateSet: CandidateSet): void {
    addIdempotent(this.candidateSets, candidateSet, "candidate set");
  }

  private addRecordRawSource(rawSource: RawSource): void {
    addIdempotent(this.rawSources, rawSource, "raw source");
  }
}

export function candidateReviewRecord(input: CandidateReviewRecordInput): SurveyClaimRecord[] {
  if (input.observations.length === 0) {
    throw new Error(`Candidate review record ${input.id} needs at least one observation`);
  }
  const records = input.observations.map((observation) => observationToClaimRecord(observation));
  const candidateSetId = input.id;
  const selectedCandidateId = input.selectedCandidateId ?? input.reviewOutcome?.candidateId;
  const candidates = records.map((record) => record.candidateSet.candidates[0]!);
  assertUniqueCandidateIds(candidates, candidateSetId);
  assertCandidateIdExists(candidates, selectedCandidateId, candidateSetId, "selected");
  if (input.selectedCandidateId && input.reviewOutcome?.candidateId && input.selectedCandidateId !== input.reviewOutcome.candidateId) {
    throw new Error(`Candidate review record ${candidateSetId} has conflicting selected and review candidate ids`);
  }
  if (input.reviewOutcome && !selectedCandidateId) {
    throw new Error(`Candidate review record ${candidateSetId} needs a selected candidate id for review outcome`);
  }
  const candidateSet: CandidateSet = {
    id: candidateSetId,
    target: input.target,
    candidates,
    selectedCandidateId,
    status: input.status ?? candidateSetStatusFor(input.reviewOutcome?.status),
    rationale: input.rationale,
    metadata: input.metadata,
  };
  const reviewCandidateId = input.reviewOutcome?.candidateId ?? selectedCandidateId;
  const reviewOutcome = input.reviewOutcome
    ? {
        id: input.reviewOutcome.id ?? `${candidateSetId}.review`,
        candidateSetId,
        ...input.reviewOutcome,
        candidateId: reviewCandidateId,
      }
    : undefined;
  assertCandidateIdExists(candidates, reviewCandidateId, candidateSetId, "review");

  return records.map((record) => {
    const candidate = record.candidateSet.candidates[0]!;
    return {
      ...record,
      candidateSet,
      reviewOutcome: candidate.id === reviewCandidateId ? reviewOutcome : undefined,
      claim: {
        ...record.claim,
        candidateSetId,
        candidateId: candidate.id,
      },
    };
  });
}

function assertUniqueCandidateIds(candidates: Candidate[], candidateSetId: string): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      throw new Error(`Candidate review record ${candidateSetId} has duplicate candidate id: ${candidate.id}`);
    }
    seen.add(candidate.id);
  }
}

function assertCandidateIdExists(
  candidates: Candidate[],
  candidateId: string | undefined,
  candidateSetId: string,
  role: "review" | "selected",
): void {
  if (!candidateId) return;
  if (!candidates.some((candidate) => candidate.id === candidateId)) {
    throw new Error(`Candidate review record ${candidateSetId} does not contain ${role} candidate ${candidateId}`);
  }
}

function observationToClaimRecord(observation: SurveyObservationInput): SurveyClaimRecord {
  const ids = observationIds(observation.id, observation);
  const value = observation.claim.value ?? observation.extraction.value;
  const confidence = observation.candidate?.confidence ?? observation.extraction.confidence;

  return {
    rawSource: {
      id: ids.sourceId,
      ...observation.rawSource,
    },
    extraction: {
      id: ids.extractionId,
      sourceId: ids.sourceId,
      ...observation.extraction,
    },
    candidateSet: {
      id: ids.candidateSetId,
      target: observation.extraction.target,
      selectedCandidateId: ids.candidateId,
      status: observation.candidateSet?.status ?? candidateSetStatusFor(observation.reviewOutcome?.status),
      rationale: observation.candidateSet?.rationale,
      metadata: observation.candidateSet?.metadata,
      candidates: [{
        id: ids.candidateId,
        extractionId: ids.extractionId,
        value,
        confidence,
        sourceRank: observation.candidate?.sourceRank,
        metadata: observation.candidate?.metadata,
      }],
    },
    reviewOutcome: observation.reviewOutcome
      ? {
          id: ids.reviewOutcomeId,
          candidateSetId: ids.candidateSetId,
          candidateId: ids.candidateId,
          ...observation.reviewOutcome,
        }
      : undefined,
    claim: {
      id: ids.claimId,
      candidateSetId: ids.candidateSetId,
      candidateId: ids.candidateId,
      ...observation.claim,
      value,
    },
  };
}

function observationIds(rootId: string, observation: SurveyObservationInput): {
  claimId: string;
  sourceId: string;
  extractionId: string;
  candidateId: string;
  candidateSetId: string;
  reviewOutcomeId: string;
} {
  const claimId = observation.claim.id ?? rootId;
  return {
    claimId,
    sourceId: observation.rawSource.id ?? `${rootId}.source`,
    extractionId: observation.extraction.id ?? `${rootId}.extraction`,
    candidateId: observation.candidate?.id ?? `${rootId}.candidate`,
    candidateSetId: observation.candidateSet?.id ?? `${rootId}.candidates`,
    reviewOutcomeId: observation.reviewOutcome?.id ?? `${rootId}.review`,
  };
}

function candidateSetStatusFor(reviewStatus?: ReviewStatus): CandidateSet["status"] {
  if (!reviewStatus || reviewStatus === "proposed") return "needs-review";
  return "resolved";
}

function addUnique<T extends { id: string }>(map: Map<string, T>, item: T, label: string): void {
  if (map.has(item.id)) throw new Error(`Duplicate ${label} id: ${item.id}`);
  map.set(item.id, item);
}

function addIdempotent<T extends { id: string }>(map: Map<string, T>, item: T, label: string): void {
  const existing = map.get(item.id);
  if (existing) {
    if (stableStringify(existing) !== stableStringify(item)) {
      throw new Error(`Conflicting ${label} id: ${item.id}`);
    }
    return;
  }
  map.set(item.id, item);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}
