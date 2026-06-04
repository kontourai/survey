import type {
  CandidateSetStatus,
  ClaimTarget,
  Extraction,
  RawSource,
  ReviewOutcome,
} from "./types.js";

export const reviewResourceApiVersion = "survey.kontourai.io/v1alpha1";

export type ReviewResourceApiVersion = typeof reviewResourceApiVersion;
export type ReviewResourceKind = "ReviewItem" | "ReviewDecision";

export interface ResourceMetadata {
  name: string;
  uid?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  producer?: Record<string, unknown>;
}

export interface ResourceEnvelope<K extends ReviewResourceKind, Spec, Status = Record<string, never>> {
  apiVersion: ReviewResourceApiVersion;
  kind: K;
  metadata: ResourceMetadata;
  spec: Spec;
  status?: Status;
}

export type CandidateRole = "current" | "proposed" | "alternative" | "source-version" | "computed";

export interface SourceReference {
  sourceRef: string;
  sourceId?: string;
  kind?: RawSource["kind"];
  observedAt?: string;
  fetchedAt?: string;
  checksum?: string;
  locatorScheme?: RawSource["locatorScheme"];
}

export interface ReviewLocator {
  scheme: RawSource["locatorScheme"];
  locator?: string;
  excerpt?: string;
}

export interface ExtractionReference {
  extractionId?: string;
  target: string;
  confidence?: number;
  extractor?: string;
  extractedAt?: string;
}

export interface ClaimTargetHint {
  claimId?: string;
  subjectType: string;
  subjectId: string;
  surface: string;
  claimType: string;
  fieldOrBehavior: string;
  impactLevel: ClaimTarget["impactLevel"];
  evidenceType?: ClaimTarget["evidenceType"];
  evidenceMethod?: ClaimTarget["evidenceMethod"];
  collectedBy?: string;
  derivedFrom?: string[];
}

export interface SurveyRecordProjectionHint {
  rawSourceId?: RawSource["id"];
  extractionId?: Extraction["id"];
  candidateSetId?: string;
  candidateId?: string;
  reviewOutcomeId?: ReviewOutcome["id"];
  claimId?: ClaimTarget["id"];
}

export interface ReviewCandidate {
  id: string;
  role?: CandidateRole;
  value: unknown;
  confidence?: number;
  sourceRank?: number;
  source: SourceReference;
  locator?: ReviewLocator;
  extraction: ExtractionReference;
  claimTarget: ClaimTargetHint;
  projection?: SurveyRecordProjectionHint;
  producer?: Record<string, unknown>;
}

export interface ReviewItemSpec {
  target: string;
  candidates: ReviewCandidate[];
  candidateSetStatus?: CandidateSetStatus;
  selectedCandidateId?: string;
  rationale?: string;
  producerPolicy?: Record<string, unknown>;
  projection?: SurveyRecordProjectionHint;
}

export interface ReviewItemStatus {
  observedCandidateCount?: number;
  selectedCandidateId?: string;
  reviewDecisionName?: string;
}

export type ReviewItem = ResourceEnvelope<"ReviewItem", ReviewItemSpec, ReviewItemStatus>;

export interface ReviewActor {
  id: string;
  displayName?: string;
}

export interface ReviewDecisionSpec {
  reviewItemName: string;
  candidateId?: string;
  status: ReviewOutcome["status"];
  actor?: ReviewActor;
  reviewedAt?: string;
  rationale?: string;
  evidenceIds?: string[];
  withinComfortZone?: boolean;
  comfortZoneNote?: string;
  projection?: SurveyRecordProjectionHint;
}

export interface ReviewDecisionStatus {
  appliedToClaimIds?: string[];
}

export type ReviewDecision = ResourceEnvelope<"ReviewDecision", ReviewDecisionSpec, ReviewDecisionStatus>;

export type ReviewResource = ReviewItem | ReviewDecision;
