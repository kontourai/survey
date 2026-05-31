import type {
  CandidateSet,
  ClaimTarget,
  DerivedClaimTarget,
  Extraction,
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

function addUnique<T extends { id: string }>(map: Map<string, T>, item: T, label: string): void {
  if (map.has(item.id)) throw new Error(`Duplicate ${label} id: ${item.id}`);
  map.set(item.id, item);
}
