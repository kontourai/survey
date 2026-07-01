import type {
  CandidateSetStatus,
  ClaimTarget,
  Extraction,
  RawSource,
  ReviewAuthorizing,
  ReviewOutcome,
} from "./types.js";

export const reviewResourceApiVersion = "survey.kontourai.io/v1alpha1";

export type ReviewResourceApiVersion = typeof reviewResourceApiVersion;
export type ReviewResourceKind = "ReviewItem" | "ReviewDecision" | "ReviewSession" | "ReviewSessionEvent";

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

/**
 * Well-known decision-mode vocabulary for {@link ProducerPolicy.decisionMode}.
 * A producer declares how a ReviewItem is allowed to be resolved:
 *   `keep-current`     — only a keep-current decision is admissible.
 *   `current-proposed` — only the current or proposed candidate may be selected.
 *   `free-select`      — any declared candidate may be selected.
 * Enforcement is opt-in; see `assertReviewDecisionModeAllows` and the
 * `enforceProducerPolicy` option on `applyReviewSession`.
 */
export type ReviewDecisionMode = "keep-current" | "current-proposed" | "free-select";

/**
 * Producer-declared policy carried on a ReviewItem. The well-known
 * `decisionMode` sub-key is typed and optionally enforceable; all other keys
 * remain opaque to Survey (tolerated via the index signature, never inspected).
 */
export interface ProducerPolicy {
  decisionMode?: ReviewDecisionMode;
  [key: string]: unknown;
}

export interface ReviewCandidate {
  id: string;
  role?: CandidateRole;
  value: unknown;
  confidence?: number;
  sourceRank?: number;
  rejectionReason?: string;
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
  producerPolicy?: ProducerPolicy;
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
  /** Optional testimony provenance. Populated by the workbench on the
   *  `authorized-action` channel; consumers on other channels may supply
   *  their own admissible block. */
  authorizing?: ReviewAuthorizing;
  projection?: SurveyRecordProjectionHint;
}

export interface ReviewDecisionStatus {
  appliedToClaimIds?: string[];
}

export type ReviewDecision = ResourceEnvelope<"ReviewDecision", ReviewDecisionSpec, ReviewDecisionStatus>;

export interface ReviewSessionSpec {
  reviewItemNames: string[];
  actor?: ReviewActor;
  startedAt: string;
  completedAt?: string;
}

export interface ReviewSessionStatus {
  activeItemName?: string;
  eventCount?: number;
  decisionCount?: number;
}

export type ReviewSessionEventType =
  | "session-started"
  | "item-selected"
  | "decision-changed"
  | "note-changed"
  | "decision-submitted"
  | "session-completed";

export interface ReviewSessionEventSpec {
  sessionName: string;
  sequence: number;
  eventType: ReviewSessionEventType;
  occurredAt: string;
  actor?: ReviewActor;
  reviewItemName?: string;
  activeItemName?: string;
  reviewDecisionName?: string;
  candidateId?: string;
  status?: ReviewOutcome["status"];
  rationale?: string;
  data?: Record<string, unknown>;
}

export interface ReviewSessionEventStatus {
  replayed?: boolean;
}

export type ReviewSession = ResourceEnvelope<"ReviewSession", ReviewSessionSpec, ReviewSessionStatus>;
export type ReviewSessionEvent = ResourceEnvelope<"ReviewSessionEvent", ReviewSessionEventSpec, ReviewSessionEventStatus>;

export type ReviewResource = ReviewItem | ReviewDecision | ReviewSession | ReviewSessionEvent;
