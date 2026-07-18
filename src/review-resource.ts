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
  /** The extraction tool/pipeline that produced this candidate (e.g. a crawler or parser). */
  extractor?: string;
  /**
   * The model or model-version that generated this candidate, when the producer
   * knows it (e.g. an LLM id or a dated extraction-model tag). Distinct from
   * `extractor` (the tool): a reviewer wants to know *which model* proposed a
   * value for trust/calibration. Producer-provided provenance; Survey only
   * carries and displays it.
   */
  model?: string;
  extractedAt?: string;
}

export interface ClaimTargetHint {
  claimId?: string;
  subjectType: string;
  subjectId: string;
  /**
   * Producer-defined grouping or namespace for this claim (Hachure schema 5,
   * surface@2.0.0: Claim.surface -> Claim.facet).
   */
  facet: string;
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

/**
 * Well-known neutral value-type vocabulary for {@link ReviewValueDescriptor}.
 * Survey defines NO field-schema system of its own; this deliberately MIRRORS
 * the shape an upstream field-schema owner already uses (e.g. traverse's
 * `TargetFieldSchema.type` / `ExtractionProposal.valueType`), so a producer can
 * carry a reviewed field's declared type down to the review UI WITHOUT Survey
 * importing that owner's package (structural match, zero coupling).
 */
export type ReviewValueType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "enum"
  | "array"
  | "object";

/**
 * Optional, producer-supplied descriptor of a reviewed field's declared value
 * shape. Purely descriptive: the workbench uses it ONLY to pick a typed editor
 * (an enum `<select>`, a date/number input) and to validate a reviewer's edit
 * before "Use proposed". Survey never re-derives, coerces, or overrides a
 * candidate's value from it — a producer can still surface an out-of-shape
 * candidate, which is exactly what a typed reviewer catches.
 */
export interface ReviewValueDescriptor {
  type: ReviewValueType;
  /** Allowed values — meaningful with `type: "enum"`; ignored otherwise. */
  enumValues?: string[];
}

export interface ReviewItemSpec {
  target: string;
  candidates: ReviewCandidate[];
  candidateSetStatus?: CandidateSetStatus;
  selectedCandidateId?: string;
  rationale?: string;
  producerPolicy?: ProducerPolicy;
  projection?: SurveyRecordProjectionHint;
  /**
   * Optional neutral descriptor of the reviewed field's declared value type.
   * When present, the workbench renders a typed editor and validates a
   * reviewer's inline edit against it before accepting the proposed value.
   * Absent → a plain text editor with no validation (today's behavior).
   */
  valueDescriptor?: ReviewValueDescriptor;
  /**
   * Whether the reviewer may edit the proposed value inline before accepting
   * it. Defaults to `true` (today's behavior). Set `false` for queues where an
   * edited value is meaningless or must not be accepted — an approve/keep
   * identity decision, a value the producer will re-derive, a review that only
   * chooses between the two candidates as given. The workbench then renders no
   * editor at all: the decision is keep-current / use-proposed / reject only,
   * and `effectiveValue` is always the selected candidate's own value. This is
   * enforcement (the affordance is absent), not a cosmetic hide.
   */
  editable?: boolean;
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
  resolution?: ReviewOutcome["resolution"];
  resolutionReason?: string;
  attemptEvidenceIds?: string[];
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
  /**
   * Reviewer-edited override for the proposed candidate's value, captured when the
   * reviewer edits the inline proposed-value editor before choosing "Use proposed".
   * Only meaningful when the decision selects the proposed candidate. Downstream
   * consumers should read the effective value as `editedValue ?? <selected candidate value>`
   * rather than assuming the candidate's original value was applied verbatim.
   * Additive/optional: absent means the candidate's original value was used unchanged.
   */
  editedValue?: unknown;
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
  resolution?: ReviewOutcome["resolution"];
  resolutionReason?: string;
  attemptEvidenceIds?: string[];
  rationale?: string;
  data?: Record<string, unknown>;
}

export interface ReviewSessionEventStatus {
  replayed?: boolean;
}

export type ReviewSession = ResourceEnvelope<"ReviewSession", ReviewSessionSpec, ReviewSessionStatus>;
export type ReviewSessionEvent = ResourceEnvelope<"ReviewSessionEvent", ReviewSessionEventSpec, ReviewSessionEventStatus>;

export type ReviewResource = ReviewItem | ReviewDecision | ReviewSession | ReviewSessionEvent;
