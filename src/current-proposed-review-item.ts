import type { CandidateSetStatus } from "./types.js";
import {
  reviewResourceApiVersion,
  type ClaimTargetHint,
  type ExtractionReference,
  type ProducerPolicy,
  type ReviewCandidate,
  type ReviewItem,
  type ReviewLocator,
  type SourceReference,
  type SurveyRecordProjectionHint,
} from "./review-resource.js";

/**
 * A single candidate value for a current/proposed {@link ReviewItem}. Carries
 * the candidate value plus its source, extraction, and claim-target evidence.
 * The builder owns id, role, and candidate-set wiring; the caller owns the
 * value and its domain vocabulary.
 */
export interface CurrentProposedCandidateInput {
  readonly value: unknown;
  readonly confidence?: number;
  readonly sourceRank?: number;
  readonly rejectionReason?: string;
  readonly source: SourceReference;
  readonly locator?: ReviewLocator;
  readonly extraction: ExtractionReference;
  readonly claimTarget: ClaimTargetHint;
  readonly projection?: SurveyRecordProjectionHint;
  readonly producer?: Record<string, unknown>;
}

/**
 * Input for {@link currentProposedReviewItem} — the generic envelope, id, and
 * role wiring for a two-candidate current/proposed ReviewItem.
 */
export interface CurrentProposedReviewItemInput {
  readonly name: string;
  readonly target: string;
  readonly current: CurrentProposedCandidateInput;
  readonly proposed: CurrentProposedCandidateInput;
  readonly candidateSetStatus?: CandidateSetStatus;
  readonly selectedCandidateRole?: "current" | "proposed";
  readonly rationale?: string;
  readonly labels?: Record<string, string>;
  readonly producerMetadata?: Record<string, unknown>;
  readonly producerPolicy?: ProducerPolicy;
  readonly projection?: SurveyRecordProjectionHint;
  readonly candidateIdSuffix?: { readonly current?: string; readonly proposed?: string };
  /**
   * Whether the reviewer may edit the proposed value inline. Defaults to
   * `true`. Pass `false` for keep/use/reject-only queues (see
   * {@link ReviewItemSpec.editable}).
   */
  readonly editable?: boolean;
}

/**
 * Builds the two-candidate current/proposed {@link ReviewItem} envelope that
 * producers otherwise hand-assemble: candidate ids, roles, candidate-set id,
 * observed-candidate count, and selected-candidate mirroring. The caller still
 * owns each candidate's value, source, extraction, and claim-target vocabulary.
 *
 * Candidate ids default to `<name>.current` / `<name>.proposed` (the trailing
 * segment is overridable via `candidateIdSuffix`); the candidate-set id defaults
 * to `<name>.candidates` (overridable via `projection.candidateSetId`);
 * `candidateSetStatus` defaults to `"needs-review"`. `status.observedCandidateCount`
 * is always 2, and `status.selectedCandidateId` mirrors `spec.selectedCandidateId`
 * when `selectedCandidateRole` is set.
 */
export function currentProposedReviewItem(input: CurrentProposedReviewItemInput): ReviewItem {
  const candidateSetId = input.projection?.candidateSetId ?? `${input.name}.candidates`;
  const currentId = `${input.name}.${input.candidateIdSuffix?.current ?? "current"}`;
  const proposedId = `${input.name}.${input.candidateIdSuffix?.proposed ?? "proposed"}`;

  const selectedCandidateId = input.selectedCandidateRole === "current"
    ? currentId
    : input.selectedCandidateRole === "proposed"
      ? proposedId
      : undefined;

  const currentCandidate = buildCandidate("current", currentId, input.current, candidateSetId);
  const proposedCandidate = buildCandidate("proposed", proposedId, input.proposed, candidateSetId);

  return {
    apiVersion: reviewResourceApiVersion,
    kind: "ReviewItem",
    metadata: {
      name: input.name,
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.producerMetadata ? { producer: input.producerMetadata } : {}),
    },
    spec: {
      target: input.target,
      candidates: [currentCandidate, proposedCandidate],
      candidateSetStatus: input.candidateSetStatus ?? "needs-review",
      ...(selectedCandidateId ? { selectedCandidateId } : {}),
      ...(input.rationale ? { rationale: input.rationale } : {}),
      ...(input.producerPolicy ? { producerPolicy: input.producerPolicy } : {}),
      ...(input.editable === false ? { editable: false } : {}),
      projection: { ...input.projection, candidateSetId },
    },
    status: {
      observedCandidateCount: 2,
      ...(selectedCandidateId ? { selectedCandidateId } : {}),
    },
  };
}

function buildCandidate(
  role: "current" | "proposed",
  id: string,
  input: CurrentProposedCandidateInput,
  candidateSetId: string,
): ReviewCandidate {
  return {
    id,
    role,
    value: input.value,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.sourceRank !== undefined ? { sourceRank: input.sourceRank } : {}),
    ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
    source: input.source,
    ...(input.locator ? { locator: input.locator } : {}),
    extraction: input.extraction,
    claimTarget: input.claimTarget,
    projection: { candidateSetId, candidateId: id, ...input.projection },
    ...(input.producer ? { producer: input.producer } : {}),
  };
}
