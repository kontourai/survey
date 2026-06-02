import type { ConfidenceBasis, DerivationEdge, EvidenceMethod, EvidenceType, ImpactLevel, TrustStatus } from "@kontourai/surface";

export type RawSourceKind = "uploaded-document" | "web-page" | "api-record" | "manual-entry";
export type LocatorScheme = "pdf" | "text" | "html" | "structured-field";

export interface RawSource {
  id: string;
  kind: RawSourceKind;
  sourceRef: string;
  observedAt: string;
  fetchedAt?: string;
  checksum?: string;
  locatorScheme: LocatorScheme;
  metadata?: Record<string, unknown>;
}

export interface Extraction {
  id: string;
  sourceId: string;
  target: string;
  value: unknown;
  confidence?: number;
  locator?: string;
  excerpt?: string;
  extractor: string;
  extractedAt: string;
  metadata?: Record<string, unknown>;
}

export type CandidateSetStatus = "resolved" | "needs-review" | "conflict" | "escalated";
export type EscalationDimension = "framing" | "completeness" | "conclusion" | "citation";

export interface Candidate {
  id: string;
  extractionId: string;
  value: unknown;
  confidence?: number;
  sourceRank?: number;
  metadata?: Record<string, unknown>;
}

export interface CandidateSet {
  id: string;
  target: string;
  candidates: Candidate[];
  selectedCandidateId?: string;
  status: CandidateSetStatus;
  rationale?: string;
  metadata?: Record<string, unknown>;
}

export type ReviewStatus = Extract<TrustStatus, "verified" | "assumed" | "rejected" | "proposed">;

export interface ReviewOutcome {
  id: string;
  candidateSetId: string;
  candidateId?: string;
  status: ReviewStatus;
  actor?: string;
  reviewedAt?: string;
  rationale?: string;
  evidenceIds?: string[];
  withinComfortZone?: boolean;
  comfortZoneNote?: string;
  metadata?: Record<string, unknown>;
}

export interface EscalationRecord {
  id: string;
  target: string;
  dimension: EscalationDimension;
  reason: string;
  raisedBy: string;
  raisedAt: string;
  attachToClaimId?: string;
  resolvedBy?: string;
  metadata?: Record<string, unknown>;
}

export interface ClaimTarget {
  id: string;
  candidateSetId: string;
  candidateId?: string;
  subjectType: string;
  subjectId: string;
  surface: string;
  claimType: string;
  fieldOrBehavior: string;
  value?: unknown;
  status?: TrustStatus;
  impactLevel: ImpactLevel;
  createdAt?: string;
  updatedAt?: string;
  evidenceType?: EvidenceType;
  evidenceMethod?: EvidenceMethod;
  confidenceBasis?: ConfidenceBasis;
  derivedFrom?: string[];
  derivationEdges?: DerivationEdge[];
  collectedBy: string;
  actor?: string;
  eventMethod?: string;
  metadata?: Record<string, unknown>;
}

export interface SurveyInput {
  source: string;
  generatedAt: string;
  rawSources: RawSource[];
  extractions: Extraction[];
  candidateSets: CandidateSet[];
  reviewOutcomes: ReviewOutcome[];
  claims: ClaimTarget[];
  escalations?: EscalationRecord[];
}
