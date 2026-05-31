import type {
  CandidateSet,
  ClaimTarget,
  DerivedClaimTarget,
  Extraction,
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

export class SurveyInputBuilder {
  private readonly source: string;
  private readonly generatedAt: string;
  private readonly rawSources = new Map<string, RawSource>();
  private readonly extractions = new Map<string, Extraction>();
  private readonly candidateSets = new Map<string, CandidateSet>();
  private readonly reviewOutcomes = new Map<string, ReviewOutcome>();
  private readonly claims = new Map<string, ClaimTarget>();
  private readonly derivedClaims = new Map<string, DerivedClaimTarget>();

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

  addDerivedClaim(derivedClaim: DerivedClaimTarget): this {
    addUnique(this.derivedClaims, derivedClaim, "derived claim target");
    return this;
  }

  addClaimRecord(record: SurveyClaimRecord): this {
    this.addRawSource(record.rawSource);
    this.addExtraction(record.extraction);
    this.addCandidateSet(record.candidateSet);
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
      derivedClaims: [...this.derivedClaims.values()],
    };
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
