import { createHash } from "node:crypto";
import type { Claim, Evidence, TrustBundle, TrustStatus, VerificationEvent } from "@kontourai/surface";
import { buildReviewProofAnchor } from "./review-proof.js";
import { assertReviewOutcomeDiscipline } from "./producer-discipline.js";
import { deriveCalibration, type CalibrationMetrics } from "./calibration.js";
import { AUTO_ACCEPT_ACTOR } from "./producer-profile.js";
import { canonicalJson } from "./review-workbench/canonical.js";
import type {
  Candidate,
  CandidateSet,
  ClaimTarget,
  Extraction,
  Interpretation,
  InterpretationAnswerImpact,
  InterpretationReadingKind,
  RawSource,
  ReviewOutcome,
  SurveyInput,
} from "./types.js";

type PolicyStandardFields = {
  inlineText?: string;
  standardVersion?: string;
  paragraphRef?: string;
  reference?: string;
};

/** Minimum labeled samples a calibration group needs before its empirical
 *  accuracy is emitted as a `conclusionConfidence.value`. */
const DEFAULT_CALIBRATION_MIN_SAMPLES = 20;

export interface SurveyCalibrationOptions {
  /**
   * EXPERIMENTAL opt-in, required for any `conclusionConfidence.value` to be
   * set (#279). The value is the affirmation rate of the claim's whole
   * extractor/field GROUP — a base rate every affirmed claim in the group
   * shares — not a per-claim probability. Without this flag the `calibration`
   * option sets no value.
   */
  experimentalConclusionValue?: boolean;
  /**
   * Precomputed calibration to source the value from — typically derived over a
   * LONGER history than the current batch (a better-grounded curve, and it avoids
   * the mild self-reference of a claim's own review outcome feeding its value).
   * When omitted, calibration is derived from THIS batch's review outcomes.
   */
  metrics?: CalibrationMetrics;
  /**
   * Minimum labeled samples a group needs before its accuracy is emitted as a
   * value. Groups below the floor leave `value` unset rather than emitting a
   * poorly-grounded number. Default {@link DEFAULT_CALIBRATION_MIN_SAMPLES}.
   */
  minSamples?: number;
}

export interface BuildSurveyTrustBundleOptions {
  reviewProofs?: boolean;
  /**
   * Caller-owned identity for one projection or resolution context, such as a
   * review-session, proposal, or append-only persistence record id. When set,
   * Survey folds it into generated Evidence and VerificationEvent ids so
   * repeated projections of the same Claim cannot collide. Claim ids and all
   * legacy output remain unchanged when omitted.
   *
   * Use a portable resource-name fragment: ASCII letters, digits, `.`, `_`,
   * `:`, or `-`, beginning with a letter or digit.
   */
  projectionContextId?: string;
  /**
   * EXPERIMENTAL. Populate `conclusionConfidence.value` from empirical review
   * calibration — the affirmation rate of the claim's extractor/field group
   * (a group base rate, not a per-claim probability; see #114/#137/#279).
   * A value is set ONLY with `{ experimentalConclusionValue: true }`; `true` or
   * an object without that flag sets no value. The object may also supply
   * precomputed `metrics` and/or a `minSamples` floor. Absent → `value` stays
   * unset and only the comfort-zone signal is carried.
   *
   * ADVISORY (ADR 0003 §4): this only enriches the emitted conclusion confidence;
   * it never changes a claim's `status`.
   */
  calibration?: boolean | SurveyCalibrationOptions;
}

/**
 * Thrown when a claim's trusted status or value does not agree with the review
 * outcome it cites, or when the governing review cannot be chosen.
 * - `status-mismatch`: a `verified`/`assumed` claim cites a review whose status differs.
 * - `value-mismatch`: a `verified`/`assumed` claim carries a value other than the reviewed value.
 * - `ambiguous-review-order`: several reviews apply to one candidate and the latest
 *   cannot be determined from `reviewedAt` (missing, unparseable, or tied).
 */
export class ReviewAgreementError extends Error {
  readonly name = "ReviewAgreementError";
  readonly code: "status-mismatch" | "value-mismatch" | "ambiguous-review-order";

  constructor(code: ReviewAgreementError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function buildSurveyTrustBundle(input: SurveyInput, options: BuildSurveyTrustBundleOptions = {}): TrustBundle {
  const projectionContextId = validateProjectionContextId(options.projectionContextId);
  const rawSources = indexById(input.rawSources, "raw source");
  const extractions = indexById(input.extractions, "extraction");
  const candidateSets = indexById(input.candidateSets, "candidate set");
  const reviewsByCandidateSet = groupBy(input.reviewOutcomes, (review) => review.candidateSetId);

  // Only the explicit experimental opt-in produces a value (#279).
  const calibrationOptions = normalizeCalibrationOptions(options.calibration);
  const calibrationMetrics = calibrationOptions
    ? (calibrationOptions.metrics ?? deriveCalibration({
        reviewOutcomes: input.reviewOutcomes,
        candidateSets: input.candidateSets,
        extractions: input.extractions,
      }))
    : undefined;
  const calibrationMinSamples = calibrationOptions?.minSamples ?? DEFAULT_CALIBRATION_MIN_SAMPLES;

  const claims: Claim[] = [];
  const evidence: Evidence[] = [];
  const events: VerificationEvent[] = [];

  for (const projection of input.claims) {
    const candidateSet = requireMapValue(candidateSets, projection.candidateSetId, "candidate set");
    if (projection.candidateId === undefined && candidateSet.selectedCandidateId === undefined && candidateSet.candidates.length > 1) {
      projectUnselectedSetClaim({ input, projection, candidateSet, rawSources, extractions, reviewsByCandidateSet, projectionContextId, claims, evidence, events });
      continue;
    }
    const candidate = selectCandidate(candidateSet, projection.candidateId);
    const extraction = requireMapValue(extractions, candidate.extractionId, "extraction");
    const rawSource = requireMapValue(rawSources, extraction.sourceId, "raw source");
    const review = selectReview(reviewsByCandidateSet.get(candidateSet.id) ?? [], candidate.id, projection.id);
    const projectionReview = review?.resolution === "could_not_confirm" ? undefined : review;
    const unreviewedStatus = statusFor({ candidateSet, candidate });
    const status = projection.status
      ?? (review?.resolution === "could_not_confirm"
        ? (unreviewedStatus === "disputed" ? unreviewedStatus : review.status)
        : statusFor({ candidateSet, candidate, review }));
    const claimValue = projection.value ?? candidate.value;
    assertProducerDiscipline({ status, review, candidateSet, candidate, extraction, rawSource, projection, claimValue });
    const createdAt = projection.createdAt ?? extraction.extractedAt;
    const updatedAt = projection.updatedAt ?? projectionReview?.reviewedAt ?? input.generatedAt;
    const evidenceId = projectionRecordId(projection.id, projectionContextId, "claim-evidence", "evidence.source");
    const autoAccepted = projectionReview?.actor === AUTO_ACCEPT_ACTOR;

    const claim: Claim = {
      id: projection.id,
      subjectType: projection.subjectType,
      subjectId: projection.subjectId,
      facet: projection.facet,
      claimType: projection.claimType,
      fieldOrBehavior: projection.fieldOrBehavior,
      value: claimValue,
      status,
      createdAt,
      updatedAt,
      impactLevel: projection.impactLevel,
      derivedFrom: projection.derivedFrom,
      derivationEdges: projection.derivationEdges,
      confidenceBasis: {
        sourceQuality: "moderate",
        extractionConfidence: candidate.confidence ?? extraction.confidence,
        // An auto-accept policy checked nothing but the proposer's own
        // confidence, so its claims carry system authority and weak evidence;
        // only a human review earns operator authority.
        reviewerAuthority: status === "verified" || status === "assumed"
          ? (autoAccepted ? "system" : "operator")
          : "none",
        evidenceStrength: (status === "verified" || status === "assumed") && !autoAccepted ? "moderate" : "weak",
        impactLevel: projection.impactLevel,
        ...projection.confidenceBasis,
      },
      metadata: {
        ...projection.metadata,
        survey: buildSurveyMetadata({
          projection,
          rawSource,
          extraction,
          candidateSet,
          candidate,
          review: projectionReview,
          comfortZoneReview: review,
          valueEdit: (status === "verified" || status === "assumed") && review ? acceptedEdit(review) : undefined,
        }),
      },
    };

    // Promote the review's comfort-zone signal — and, under the experimental
    // calibration opt-in, the group affirmation rate — into the
    // first-class conclusionConfidence field (Surface 2.9 / Hachure 0.14) so the
    // signal is portable and comparable, not buried in producer metadata.
    //
    // comfortZone is CARRIED from the review. `value` is PRODUCED, only under the
    // experimental opt-in, from empirical review calibration (#114/#137/#279):
    // the affirmation rate of this claim's extractor/field GROUP. It is a group
    // base rate shared by every affirmed claim in the group, not a per-claim
    // probability, and distinct from the extraction-confidence ingredient in
    // confidenceBasis.
    //
    // A value is produced only for an AFFIRMED conclusion (status verified/assumed)
    // that clears the sample floor. conclusionConfidence.value is "probability the
    // conclusion is correct"; attaching an affirmation rate to a REJECTED (or
    // not-yet-reviewed) conclusion would assert the opposite of what the human
    // decided, so those claims get no value.
    const comfortZone = review?.withinComfortZone !== undefined
      ? {
          within: review.withinComfortZone,
          ...(review.comfortZoneNote ? { reason: review.comfortZoneNote } : {}),
        }
      : undefined;
    const affirmedConclusion = status === "verified" || status === "assumed";
    const calibrated = calibrationMetrics && projectionReview && affirmedConclusion
      ? lookupCalibratedValue(calibrationMetrics, extraction.extractor, extraction.target, calibrationMinSamples)
      : undefined;
    if (comfortZone || calibrated) {
      claim.conclusionConfidence = {
        ...(calibrated ? { value: calibrated.value, method: calibrated.method } : {}),
        ...(comfortZone ? { comfortZone } : {}),
      };
    }

    // Could-not-confirm stays byte-quiet at the Surface boundary. In particular,
    // do not attach an anchor whose public observedAt would disclose review time;
    // callers can persist/recompute Survey's canonical v3 proof separately.
    if (options.reviewProofs && projectionReview) {
      claim.currentIntegrityAnchor = buildReviewProofAnchor({
        rawSource,
        extraction,
        candidate,
        candidateSet,
        reviewOutcome: projectionReview,
        claim: {
          ...projection,
          value: claimValue,
          status,
        },
      });
    }

    claims.push(claim);

    const policyStandard = policyStandardFields(rawSource);

    evidence.push({
      id: evidenceId,
      claimId: projection.id,
      evidenceType: projection.evidenceType ?? (rawSource.resolution ? evidenceTypeForResolution(rawSource, rawSource.resolution) : evidenceTypeFor(rawSource)),
      method: projection.evidenceMethod ?? "extraction",
      sourceRef: rawSource.sourceRef,
      sourceLocator: extraction.locator,
      excerptOrSummary: evidenceExcerptOrSummary({ rawSource, extraction, projection, policyStandard }),
      observedAt: rawSource.observedAt,
      collectedBy: projection.collectedBy,
      integrityRef: rawSource.checksum,
      metadata: {
        ...rawSource.metadata,
        ...extraction.metadata,
        ...candidate.metadata,
        ...(policyStandard ? { policyStandard } : {}),
        rawSourceKind: rawSource.kind,
        locatorScheme: rawSource.locatorScheme,
        ...(rawSource.resolution ? { provenanceResolution: rawSource.resolution } : {}),
        confidence: candidate.confidence ?? extraction.confidence,
      },
    });

    const rationale = projectionReview?.rationale ?? candidateSet.rationale;
    events.push({
      id: projectionRecordId(projection.id, projectionContextId, "claim-event", `event.${status}`),
      claimId: projection.id,
      status,
      actor: projection.actor ?? projectionReview?.actor ?? projection.collectedBy,
      method: projection.eventMethod ?? eventMethodFor(status, candidateSet),
      evidenceIds: projectionReview?.evidenceIds?.length ? projectionReview.evidenceIds : [evidenceId],
      createdAt: projectionReview?.reviewedAt ?? input.generatedAt,
      verifiedAt: status === "verified" || status === "assumed" ? projectionReview?.reviewedAt ?? input.generatedAt : undefined,
      notes: rationale,
    });
  }

  projectInterpretations({ input, rawSources, claims, evidence, events, projectionContextId });

  if (input.escalations) {
    const claimIds = new Set(claims.map((c) => c.id));
    for (const escalation of input.escalations) {
      if (escalation.resolvedBy) continue;
      if (!escalation.attachToClaimId) continue;
      if (!claimIds.has(escalation.attachToClaimId)) {
        throw new Error(`Escalation ${escalation.id} references unknown claim ${escalation.attachToClaimId}`);
      }
      events.push({
        id: projectionRecordId(escalation.id, projectionContextId, "escalation-event", "event"),
        claimId: escalation.attachToClaimId,
        status: "disputed",
        actor: escalation.raisedBy,
        method: "candidate-escalation",
        evidenceIds: [],
        createdAt: escalation.raisedAt,
        notes: `[${escalation.dimension}] ${escalation.reason}`,
      });
    }
  }

  return {
    schemaVersion: 5,
    source: input.source,
    claims,
    evidence,
    policies: [],
    events,
  };
}

/**
 * A claim over a candidate set that selects none of its candidates (a review
 * rejected every conflicting value, or could not confirm any). No single value
 * is presented: the claim value is the projection's own (null from the
 * canonical path), every candidate is listed in `metadata.survey.candidates`
 * and backed by its own evidence record, and the status can never be trusted.
 * A review that names one candidate cannot apply to such a claim and is
 * refused rather than dropped. With `reviewProofs`, no integrity anchor is
 * attached: the anchor commits one reviewed candidate, and this claim has none
 * (it is never `verified` or `assumed`).
 */
function projectUnselectedSetClaim(context: {
  input: SurveyInput;
  projection: ClaimTarget;
  candidateSet: CandidateSet;
  rawSources: Map<string, RawSource>;
  extractions: Map<string, Extraction>;
  reviewsByCandidateSet: Map<string, ReviewOutcome[]>;
  projectionContextId: string | undefined;
  claims: Claim[];
  evidence: Evidence[];
  events: VerificationEvent[];
}): void {
  const { input, projection, candidateSet, projectionContextId } = context;
  const setReviews = context.reviewsByCandidateSet.get(candidateSet.id) ?? [];
  const candidateReviews = setReviews.filter((review) => review.candidateId);
  if (candidateReviews.length) {
    throw new Error(`Claim ${projection.id} names no candidate of set ${candidateSet.id}, but review ${candidateReviews.map((review) => review.id).join(", ")} is about candidate ${candidateReviews.map((review) => review.candidateId).join(", ")}: a candidate-level review needs a selectedCandidateId on the set or a candidateId on the claim.`);
  }
  const reviews = setReviews;
  const review = latestReview(reviews, projection.id);
  const setStatus = statusFor({ candidateSet, candidate: { id: "", extractionId: "", value: null } });
  const status = projection.status
    ?? (review?.resolution === "could_not_confirm"
      ? (setStatus === "disputed" ? setStatus : review.status)
      : review?.status ?? setStatus);
  if (status === "verified" || status === "assumed") {
    throw new ReviewAgreementError("status-mismatch", `Claim ${projection.id} selects no candidate of set ${candidateSet.id}, so it cannot be ${status}`);
  }
  assertReviewOutcomeDiscipline({ subject: `Claim ${projection.id}`, status, review, candidateSetStatus: candidateSet.status });

  const sources = candidateSet.candidates.map((candidate) => {
    const extraction = requireMapValue(context.extractions, candidate.extractionId, "extraction");
    const rawSource = requireMapValue(context.rawSources, extraction.sourceId, "raw source");
    return { candidate, extraction, rawSource };
  });
  const evidenceIds = sources.map(({ candidate, extraction, rawSource }) => {
    const id = projectionRecordId(projection.id, projectionContextId, "claim-evidence", `evidence.source.${candidate.id}`);
    const policyStandard = policyStandardFields(rawSource);
    context.evidence.push({
      id,
      claimId: projection.id,
      evidenceType: projection.evidenceType ?? (rawSource.resolution ? evidenceTypeForResolution(rawSource, rawSource.resolution) : evidenceTypeFor(rawSource)),
      method: projection.evidenceMethod ?? "extraction",
      sourceRef: rawSource.sourceRef,
      sourceLocator: extraction.locator,
      excerptOrSummary: evidenceExcerptOrSummary({ rawSource, extraction, projection, policyStandard }),
      observedAt: rawSource.observedAt,
      collectedBy: projection.collectedBy,
      integrityRef: rawSource.checksum,
      metadata: {
        ...rawSource.metadata,
        ...extraction.metadata,
        ...candidate.metadata,
        ...(policyStandard ? { policyStandard } : {}),
        rawSourceKind: rawSource.kind,
        locatorScheme: rawSource.locatorScheme,
        candidateId: candidate.id,
        ...(candidate.confidence ?? extraction.confidence) !== undefined ? { confidence: candidate.confidence ?? extraction.confidence } : {},
      },
    });
    return id;
  });

  const producerSurvey = isRecord(projection.metadata?.survey) ? projection.metadata.survey : {};
  context.claims.push({
    id: projection.id,
    subjectType: projection.subjectType,
    subjectId: projection.subjectId,
    facet: projection.facet,
    claimType: projection.claimType,
    fieldOrBehavior: projection.fieldOrBehavior,
    value: "value" in projection ? projection.value : null,
    status,
    createdAt: projection.createdAt ?? sources.map(({ extraction }) => extraction.extractedAt).sort()[0]!,
    updatedAt: projection.updatedAt ?? review?.reviewedAt ?? input.generatedAt,
    impactLevel: projection.impactLevel,
    derivedFrom: projection.derivedFrom,
    derivationEdges: projection.derivationEdges,
    confidenceBasis: {
      sourceQuality: "moderate",
      reviewerAuthority: "none",
      evidenceStrength: "weak",
      impactLevel: projection.impactLevel,
      ...projection.confidenceBasis,
    },
    metadata: {
      ...projection.metadata,
      survey: {
        ...producerSurvey,
        candidateSetId: candidateSet.id,
        candidateSetStatus: candidateSet.status,
        // No candidate is selected; every value the set held, in set order.
        candidates: candidateSet.candidates.map((candidate) => ({
          candidateId: candidate.id,
          value: candidate.value,
          ...(candidate.rejectionReason !== undefined ? { rejectionReason: candidate.rejectionReason } : {}),
        })),
        reviewOutcomeId: review?.id,
      },
    },
  });
  context.events.push({
    id: projectionRecordId(projection.id, projectionContextId, "claim-event", `event.${status}`),
    claimId: projection.id,
    status,
    actor: projection.actor ?? (review?.resolution === "could_not_confirm" ? undefined : review?.actor) ?? projection.collectedBy,
    method: projection.eventMethod ?? eventMethodFor(status, candidateSet),
    evidenceIds,
    createdAt: review?.reviewedAt ?? input.generatedAt,
    notes: review?.rationale ?? candidateSet.rationale,
  });
}

function validateProjectionContextId(contextId: string | undefined): string | undefined {
  if (contextId === undefined) return undefined;
  if (typeof contextId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(contextId)) {
    throw new Error("projectionContextId must be a non-empty portable resource-name fragment");
  }
  return contextId;
}

function projectionRecordId(ownerId: string, contextId: string | undefined, recordKind: string, legacySuffix: string): string {
  if (!contextId) return `${ownerId}.${legacySuffix}`;
  const digest = createHash("sha256")
    .update(JSON.stringify(["survey-projection-context-v1", recordKind, ownerId, contextId]))
    .digest("hex");
  return `survey.projection.v1.${digest}.${legacySuffix}`;
}

function projectInterpretations(input: {
  input: SurveyInput;
  rawSources: Map<string, RawSource>;
  claims: Claim[];
  evidence: Evidence[];
  events: VerificationEvent[];
  projectionContextId: string | undefined;
}): void {
  const interpretations = input.input.interpretations
    ? [...indexById(input.input.interpretations, "interpretation").values()]
    : [];
  if (interpretations.length === 0) return;

  const claimsById = new Map(input.claims.map((claim) => [claim.id, claim]));
  for (const interpretation of interpretations) {
    const projection = buildInterpretationProjection({
      interpretation,
      rawSources: input.rawSources,
      claims: input.claims,
      claimsById,
      input: input.input,
      projectionContextId: input.projectionContextId,
    });
    input.evidence.push(projection.evidence);
    input.events.push(projection.event);
    attachInterpretationClaimMetadata({
      claim: projection.claim,
      interpretation,
      anchorSource: projection.anchorSource,
      evidenceId: projection.evidence.id,
    });
  }
}

function buildInterpretationProjection(input: {
  interpretation: Interpretation;
  rawSources: Map<string, RawSource>;
  claims: Claim[];
  claimsById: Map<string, Claim>;
  input: SurveyInput;
  projectionContextId: string | undefined;
}): {
  claim: Claim;
  anchorSource: RawSource;
  evidence: Evidence;
  event: VerificationEvent;
} {
  assertInterpretationReadingShape(input.interpretation);
  const anchorSource = requireInterpretationAnchor(input.interpretation, input.rawSources);
  const claim = resolveInterpretationClaim(input.interpretation, input.claims, input.input);
  if (!input.claimsById.has(claim.id)) {
    throw new Error(`Interpretation ${input.interpretation.id} resolved unknown claim ${claim.id}`);
  }

  const policyStandard = policyStandardFields(anchorSource);
  const evidence = createInterpretationAnchorEvidence({
    interpretation: input.interpretation,
    claim,
    anchorSource,
    policyStandard,
    projectionContextId: input.projectionContextId,
  });
  return {
    claim,
    anchorSource,
    evidence,
    event: createInterpretationEvent({
      interpretation: input.interpretation,
      claim,
      evidenceId: evidence.id,
      projectionContextId: input.projectionContextId,
    }),
  };
}

const INTERPRETATION_READING_KINDS: readonly InterpretationReadingKind[] = ["policy-standard", "gleaned", "answerImpact"];
const INTERPRETATION_ANSWER_IMPACTS: readonly InterpretationAnswerImpact[] = ["supported", "narrowed", "accepted-risk"];

/** Absent readingKind means the original policy-standard reading (pre-#259 records). */
function interpretationReadingKind(interpretation: Interpretation): InterpretationReadingKind {
  return interpretation.readingKind ?? "policy-standard";
}

/**
 * Fail-closed shape validation for the reading dimension (#259). Records come
 * from JSON as often as from typed callers, so unknown vocabulary throws
 * instead of silently projecting under a label nothing derived.
 */
function assertInterpretationReadingShape(interpretation: Interpretation): void {
  if (interpretation.readingKind !== undefined && !INTERPRETATION_READING_KINDS.includes(interpretation.readingKind)) {
    throw new Error(
      `Interpretation ${interpretation.id} has unknown readingKind ${String(interpretation.readingKind)}; expected one of ${INTERPRETATION_READING_KINDS.join(", ")}`,
    );
  }
  const kind = interpretationReadingKind(interpretation);
  if (kind === "answerImpact") {
    if (interpretation.answerImpact === undefined) {
      throw new Error(`Interpretation ${interpretation.id} readingKind answerImpact requires an answerImpact value`);
    }
    if (!INTERPRETATION_ANSWER_IMPACTS.includes(interpretation.answerImpact)) {
      throw new Error(
        `Interpretation ${interpretation.id} has unknown answerImpact ${String(interpretation.answerImpact)}; expected one of ${INTERPRETATION_ANSWER_IMPACTS.join(", ")}`,
      );
    }
    return;
  }
  if (interpretation.answerImpact !== undefined) {
    throw new Error(
      `Interpretation ${interpretation.id} sets answerImpact but readingKind is ${kind}; answerImpact is only valid on answerImpact readings`,
    );
  }
}

/**
 * Resolves an interpretation's anchor raw source. Every reading kind requires
 * a KNOWN raw source (referential integrity per #16 R3); only the original
 * policy-standard reading additionally requires the source kind to be
 * `policy-standard`. The gleaned / answerImpact readings (#259) anchor to the
 * result source the producer read, whatever its kind.
 */
function requireInterpretationAnchor(interpretation: Interpretation, rawSources: Map<string, RawSource>): RawSource {
  if (interpretationReadingKind(interpretation) === "policy-standard") {
    return requirePolicyStandardAnchor(interpretation, rawSources);
  }
  return requireMapValue(rawSources, interpretation.anchorsToSourceId, "interpretation anchor raw source");
}

function requirePolicyStandardAnchor(interpretation: Interpretation, rawSources: Map<string, RawSource>): RawSource {
  const anchorSource = requireMapValue(rawSources, interpretation.anchorsToSourceId, "interpretation anchor raw source");
  if (anchorSource.kind !== "policy-standard") {
    throw new Error(
      `Interpretation ${interpretation.id} anchors to raw source ${anchorSource.id}, but expected policy-standard source`,
    );
  }
  return anchorSource;
}

function createInterpretationAnchorEvidence(input: {
  interpretation: Interpretation;
  claim: Claim;
  anchorSource: RawSource;
  policyStandard?: PolicyStandardFields;
  projectionContextId: string | undefined;
}): Evidence {
  const readingKind = interpretationReadingKind(input.interpretation);
  return {
    id: projectionRecordId(input.interpretation.id, input.projectionContextId, "interpretation-evidence", "evidence.anchor"),
    claimId: input.claim.id,
    // The policy-standard reading keeps its exact prior projection; the new
    // reading kinds (#259) derive the evidence type from the anchor source
    // they actually read, via the same mapping extraction evidence uses.
    evidenceType: readingKind === "policy-standard" ? "policy_rule" : evidenceTypeFor(input.anchorSource),
    method: "anchoring",
    sourceRef: input.anchorSource.sourceRef,
    sourceLocator: input.interpretation.ruleLocator,
    excerptOrSummary:
      readingKind === "policy-standard"
        ? input.policyStandard?.inlineText ?? `Anchored policy-standard reading at ${input.interpretation.ruleLocator}.`
        : input.anchorSource.inlineText ?? `Anchored ${readingKind} reading at ${input.interpretation.ruleLocator}.`,
    observedAt: input.anchorSource.observedAt,
    collectedBy: input.interpretation.actor,
    integrityRef: input.anchorSource.checksum,
    metadata: {
      ...input.anchorSource.metadata,
      ...(input.interpretation.metadata ? { interpretation: input.interpretation.metadata } : {}),
      ...(input.policyStandard ? { policyStandard: input.policyStandard } : {}),
      rawSourceKind: input.anchorSource.kind,
      locatorScheme: input.anchorSource.locatorScheme,
      anchorsToSourceId: input.anchorSource.id,
      ruleLocator: input.interpretation.ruleLocator,
      // Only explicitly-set reading kinds project, so legacy batches stay
      // byte-identical. Authored-judgment provenance markers, not machine facts.
      ...(input.interpretation.readingKind ? { readingKind: input.interpretation.readingKind } : {}),
      ...(input.interpretation.answerImpact ? { answerImpact: input.interpretation.answerImpact } : {}),
    },
  };
}

function createInterpretationEvent(input: {
  interpretation: Interpretation;
  claim: Claim;
  evidenceId: string;
  projectionContextId: string | undefined;
}): VerificationEvent {
  return {
    id: projectionRecordId(input.interpretation.id, input.projectionContextId, "interpretation-event", "event"),
    claimId: input.claim.id,
    status: input.claim.status ?? "proposed",
    actor: input.interpretation.actor,
    method: "survey-interpretation",
    evidenceIds: [input.evidenceId],
    createdAt: input.interpretation.recordedAt,
    verifiedAt:
      input.claim.status === "verified" || input.claim.status === "assumed" ? input.interpretation.recordedAt : undefined,
    notes: input.interpretation.reading,
  };
}

function attachInterpretationClaimMetadata(input: {
  claim: Claim;
  interpretation: Interpretation;
  anchorSource: RawSource;
  evidenceId: string;
}): void {
  const claimMetadata = isRecord(input.claim.metadata) ? input.claim.metadata : {};
  const surveyMetadata = isRecord(claimMetadata.survey) ? claimMetadata.survey : {};
  const existingInterpretations = Array.isArray(surveyMetadata.interpretations) ? surveyMetadata.interpretations : [];
  input.claim.metadata = {
    ...claimMetadata,
    survey: {
      ...surveyMetadata,
      interpretations: [
        ...existingInterpretations,
        {
          interpretationId: input.interpretation.id,
          ruleLocator: input.interpretation.ruleLocator,
          reading: input.interpretation.reading,
          actor: input.interpretation.actor,
          recordedAt: input.interpretation.recordedAt,
          // Explicit reading dimension only (#259): legacy entries keep their
          // exact prior bytes; absent readingKind means policy-standard.
          ...(input.interpretation.readingKind ? { readingKind: input.interpretation.readingKind } : {}),
          ...(input.interpretation.answerImpact ? { answerImpact: input.interpretation.answerImpact } : {}),
          ...(input.interpretation.metadata ? { metadata: input.interpretation.metadata } : {}),
          edges: [
            {
              type: "appliesTo",
              targetKind: "claim",
              targetId: input.claim.id,
            },
            {
              type: "anchorsTo",
              targetKind: "rawSource",
              targetId: input.anchorSource.id,
              evidenceId: input.evidenceId,
              ruleLocator: input.interpretation.ruleLocator,
            },
          ],
        },
      ],
    },
  };
}

function resolveInterpretationClaim(interpretation: Interpretation, claims: Claim[], input: SurveyInput): Claim {
  if (interpretation.appliesToClaimId) {
    const claim = claims.find((item) => item.id === interpretation.appliesToClaimId);
    if (!claim) {
      throw new Error(`Interpretation ${interpretation.id} references unknown claim ${interpretation.appliesToClaimId}`);
    }
    if (interpretation.appliesToTarget) {
      const targetClaim = resolveInterpretationTargetClaim(interpretation, claims, input);
      if (targetClaim.id !== claim.id) {
        throw new Error(
          `Interpretation ${interpretation.id} has conflicting appliesToClaimId ${claim.id} and appliesToTarget ${interpretation.appliesToTarget} resolved to ${targetClaim.id}`,
        );
      }
    }
    return claim;
  }

  if (!interpretation.appliesToTarget) {
    throw new Error(`Interpretation ${interpretation.id} needs appliesToClaimId or appliesToTarget`);
  }

  return resolveInterpretationTargetClaim(interpretation, claims, input);
}

function resolveInterpretationTargetClaim(interpretation: Interpretation, claims: Claim[], input: SurveyInput): Claim {
  const candidateSetIdsByTarget = new Set(
    input.candidateSets
      .filter((candidateSet) => candidateSet.target === interpretation.appliesToTarget)
      .map((candidateSet) => candidateSet.id),
  );
  const matches = input.claims.filter((claim) =>
    claim.fieldOrBehavior === interpretation.appliesToTarget ||
    candidateSetIdsByTarget.has(claim.candidateSetId),
  );
  const uniqueClaimIds = [...new Set(matches.map((claim) => claim.id))];

  if (uniqueClaimIds.length === 0) {
    throw new Error(`Interpretation ${interpretation.id} target ${interpretation.appliesToTarget} did not match any claim`);
  }
  if (uniqueClaimIds.length > 1) {
    throw new Error(
      `Interpretation ${interpretation.id} target ${interpretation.appliesToTarget} is ambiguous across claims: ${uniqueClaimIds.join(", ")}`,
    );
  }

  const claim = claims.find((item) => item.id === uniqueClaimIds[0]);
  if (!claim) throw new Error(`Interpretation ${interpretation.id} resolved unknown claim ${uniqueClaimIds[0]}`);
  return claim;
}

function buildSurveyMetadata(input: {
  projection: ClaimTarget;
  rawSource: RawSource;
  extraction: Extraction;
  candidateSet: CandidateSet;
  candidate: Candidate;
  review?: ReviewOutcome;
  comfortZoneReview?: ReviewOutcome;
  valueEdit?: { value: unknown };
}): Record<string, unknown> {
  const producerSurveyMetadata = isRecord(input.projection.metadata?.survey) ? input.projection.metadata.survey : {};
  const producerCandidateMetadata = isRecord(producerSurveyMetadata.candidate) ? producerSurveyMetadata.candidate : {};
  return {
    ...producerSurveyMetadata,
    rawSourceId: input.rawSource.id,
    extractionId: input.extraction.id,
    candidateSetId: input.candidateSet.id,
    candidateId: input.candidate.id,
    reviewOutcomeId: input.review?.id,
    ...(input.candidate.rejectionReason !== undefined
      ? {
          candidate: {
            ...producerCandidateMetadata,
            rejectionReason: input.candidate.rejectionReason,
          },
        }
      : {}),
    // A trusted claim whose value is a reviewer's edit says so, and keeps the
    // value the reviewer was shown.
    ...(input.valueEdit
      ? { valueEdit: { edited: true, originalValue: input.candidate.value, reviewOutcomeId: input.comfortZoneReview?.id } }
      : {}),
    ...(input.comfortZoneReview?.withinComfortZone === false
      ? {
          comfortZone: {
            withinComfortZone: false,
            ...(input.comfortZoneReview.comfortZoneNote ? { note: input.comfortZoneReview.comfortZoneNote } : {}),
          },
        }
      : {}),
  };
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
  if (input.candidateSet.status === "escalated") return "disputed";
  if (input.candidateSet.status === "rejected") return "rejected";
  return "proposed";
}

function assertProducerDiscipline(input: {
  status: TrustStatus;
  review?: ReviewOutcome;
  candidateSet: CandidateSet;
  candidate: Candidate;
  extraction: Extraction;
  rawSource: RawSource;
  projection: ClaimTarget;
  claimValue: unknown;
}): void {
  assertReviewOutcomeDiscipline({
    subject: `Claim ${input.projection.id}`,
    status: input.status,
    review: input.review,
    candidateSetStatus: input.candidateSet.status,
  });
  if ((input.status === "verified" || input.status === "assumed") && input.review) {
    // A trusted claim may only restate its review: same status, and the value
    // the reviewer saw (the candidate value, or the edit the review records).
    if (input.review.status !== input.status) {
      throw new ReviewAgreementError(
        "status-mismatch",
        `Claim ${input.projection.id} status ${input.status} disagrees with review outcome ${input.review.id} status ${input.review.status}`,
      );
    }
    const reviewedValue = reviewedValueFor(input.review, input.candidate);
    if (canonicalJson(input.claimValue) !== canonicalJson(reviewedValue)) {
      throw new ReviewAgreementError(
        "value-mismatch",
        `Claim ${input.projection.id} is ${input.status} but its value differs from the value reviewed in ${input.review.id}`,
      );
    }
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

/** An accepted edit the review records. `buildCanonicalReviewedTrustInput`
 *  writes `metadata.editedValue` next to `metadata.workbenchDecision`; only an
 *  edit on an `accept-proposed` decision replaces the reviewed value. Any other
 *  `editedValue` (a bare one, or one on a reject or keep decision) is not an
 *  accepted edit and is ignored. */
function acceptedEdit(review: ReviewOutcome): { value: unknown } | undefined {
  const metadata = review.metadata;
  return metadata?.workbenchDecision === "accept-proposed" && Object.hasOwn(metadata, "editedValue")
    ? { value: metadata.editedValue }
    : undefined;
}

/** The value a review outcome attests: its accepted edit, else the candidate value that was reviewed. */
function reviewedValueFor(review: ReviewOutcome, candidate: Candidate): unknown {
  const edit = acceptedEdit(review);
  return edit ? edit.value : candidate.value;
}

/** The latest applicable review governs. Exact candidate bindings take
 *  precedence over unbound (set-wide) reviews; within a tier, several reviews
 *  are ordered by `reviewedAt`, and an order that cannot be established is
 *  refused rather than guessed. */
function selectReview(reviews: ReviewOutcome[], candidateId: string, claimId: string): ReviewOutcome | undefined {
  const exact = reviews.filter((review) => review.candidateId === candidateId);
  return latestReview(exact.length ? exact : reviews.filter((review) => !review.candidateId), claimId);
}

function latestReview(reviews: ReviewOutcome[], claimId: string): ReviewOutcome | undefined {
  if (reviews.length <= 1) return reviews[0];
  const timed = reviews.map((review) => ({ review, at: review.reviewedAt ? Date.parse(review.reviewedAt) : Number.NaN }));
  const untimed = timed.find((entry) => Number.isNaN(entry.at));
  if (untimed) {
    throw new ReviewAgreementError(
      "ambiguous-review-order",
      `Claim ${claimId} has ${reviews.length} applicable review outcomes but ${untimed.review.id} has no parseable reviewedAt`,
    );
  }
  const latestAt = Math.max(...timed.map((entry) => entry.at));
  const latest = timed.filter((entry) => entry.at === latestAt).map((entry) => entry.review);
  // Reviews at the same instant (however the timestamp is spelled) that record
  // the same decision are one review recorded twice; conflicting ones are refused.
  if (new Set(latest.map(reviewDecisionKey)).size > 1) {
    throw new ReviewAgreementError(
      "ambiguous-review-order",
      `Claim ${claimId} has conflicting review outcomes ${latest.map((review) => review.id).join(", ")} at the latest reviewedAt`,
    );
  }
  return [...latest].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0]!;
}

function reviewDecisionKey(review: ReviewOutcome): string {
  const edit = acceptedEdit(review);
  return canonicalJson({
    candidateId: review.candidateId ?? null,
    status: review.status,
    resolution: review.resolution ?? null,
    edit: edit ? { value: edit.value } : null,
    // These reach the claim (comfort zone, testimony provenance), so reviews
    // that differ in them are different decisions, not one recorded twice.
    withinComfortZone: review.withinComfortZone ?? null,
    comfortZoneNote: review.comfortZoneNote ?? null,
    authorizing: review.authorizing ?? null,
  });
}

function normalizeCalibrationOptions(
  calibration: BuildSurveyTrustBundleOptions["calibration"],
): SurveyCalibrationOptions | undefined {
  if (calibration === undefined || calibration === false) return undefined;
  if (calibration === true || calibration.experimentalConclusionValue === undefined) {
    // Callers written before #279 asked for a value this way; tell them it is
    // now ignored instead of silently dropping it. An explicit `false` is a
    // deliberate opt-out and stays quiet.
    warnCalibrationOptInMissingOnce();
    return undefined;
  }
  return calibration.experimentalConclusionValue === true ? calibration : undefined;
}

let warnedCalibrationOptInMissing = false;

/**
 * Warn once per process, matching the `defineProductVocabulary` deprecation
 * notice: `buildSurveyTrustBundle` has no diagnostics channel in its return
 * value (it returns a TrustBundle), and a per-call warning would flood batch
 * projections.
 */
function warnCalibrationOptInMissingOnce(): void {
  if (warnedCalibrationOptInMissing) return;
  warnedCalibrationOptInMissing = true;
  console.warn(
    "[@kontourai/survey] buildSurveyTrustBundle: the `calibration` option no longer sets " +
      "conclusionConfidence.value without `calibration: { experimentalConclusionValue: true }` (#279). " +
      "The value is an experimental extractor/field group base rate, not a per-claim probability. " +
      "Pass the flag to keep it, or `experimentalConclusionValue: false` / omit `calibration` to silence this warning.",
  );
}

/** Test-only: re-arm the once-per-process calibration opt-in warning. Not exported from the package index. */
export function resetCalibrationOptInWarningForTests(): void {
  warnedCalibrationOptInMissing = false;
}

/**
 * Looks up the empirical affirmation rate for an extractor/field, preferring the
 * finer (extractor, field) group and falling back to the extractor-level group
 * when the field group is below the sample floor. Returns undefined when neither
 * group clears the floor, so an ungrounded claim leaves `value` unset. The
 * `method` records which granularity produced the value.
 */
function lookupCalibratedValue(
  metrics: CalibrationMetrics,
  extractor: string,
  field: string,
  minSamples: number,
): { value: number; method: string } | undefined {
  const fieldGroup = metrics.byExtractorField.find((g) => g.extractor === extractor && g.field === field);
  if (fieldGroup && fieldGroup.sampleCount >= minSamples && fieldGroup.empiricalAccuracy !== undefined) {
    return { value: fieldGroup.empiricalAccuracy, method: "empirical-review-calibration:extractor-field" };
  }
  const extractorGroup = metrics.byExtractor.find((g) => g.extractor === extractor);
  if (extractorGroup && extractorGroup.sampleCount >= minSamples && extractorGroup.empiricalAccuracy !== undefined) {
    return { value: extractorGroup.empiricalAccuracy, method: "empirical-review-calibration:extractor" };
  }
  return undefined;
}

function evidenceTypeFor(rawSource: RawSource): "document_citation" | "crawl_observation" | "attestation" | "policy_rule" {
  if (rawSource.kind === "policy-standard") return "policy_rule";
  if (rawSource.kind === "uploaded-document") return "document_citation";
  if (rawSource.kind === "web-page") return "crawl_observation";
  return "attestation";
}

function evidenceTypeForResolution(rawSource: RawSource, resolution: NonNullable<RawSource["resolution"]>): "source_excerpt" | "document_citation" | "crawl_observation" | "attestation" | "policy_rule" {
  switch (resolution) {
    case "testimony":
    case "supersession":
      return "attestation";
    case "observation":
      return rawSource.kind === "web-page" ? "crawl_observation" : "source_excerpt";
    case "extraction":
      return evidenceTypeForOrigin(rawSource.kind);
    case "precedence-selection":
    case "carry-forward":
      return evidenceTypeForOrigin(rawSource.kind);
    default:
      return assertNever(resolution);
  }
}

function evidenceTypeForOrigin(kind: RawSource["kind"]): "source_excerpt" | "document_citation" | "crawl_observation" | "attestation" | "policy_rule" {
  if (kind === "policy-standard") return "policy_rule";
  if (kind === "uploaded-document") return "document_citation";
  if (kind === "web-page") return "crawl_observation";
  if (kind === "manual-entry") return "attestation";
  return "source_excerpt";
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provenance resolution: ${String(value)}`);
}

function policyStandardFields(rawSource: RawSource): PolicyStandardFields | undefined {
  const metadata = rawSource.metadata?.policyStandard;
  const metadataRecord = isRecord(metadata) ? metadata : {};
  const inlineText = rawSource.inlineText ?? stringValue(metadataRecord.inlineText) ?? stringValue(metadataRecord.text);
  const standardVersion = rawSource.standardVersion ?? stringValue(metadataRecord.standardVersion) ?? stringValue(metadataRecord.version);
  const paragraphRef = rawSource.paragraphRef ?? stringValue(metadataRecord.paragraphRef);
  const reference = stringValue(metadataRecord.reference);
  if (!inlineText && !standardVersion && !paragraphRef && !reference) return undefined;
  return {
    inlineText,
    standardVersion,
    paragraphRef,
    reference,
  };
}

function evidenceExcerptOrSummary(input: {
  rawSource: RawSource;
  extraction: Extraction;
  projection: ClaimTarget;
  policyStandard?: { inlineText?: string };
}): string {
  if (input.rawSource.kind === "policy-standard" && input.policyStandard?.inlineText) {
    return input.policyStandard.inlineText;
  }
  return input.extraction.excerpt ?? `Extracted ${input.projection.fieldOrBehavior} from ${input.rawSource.kind}.`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function eventMethodFor(status: TrustStatus, candidateSet: CandidateSet): string {
  if (status === "verified") return "survey-review";
  if (status === "assumed") return "survey-assumption";
  if (status === "rejected") return "survey-rejection";
  if (candidateSet.status === "conflict") return "candidate-conflict";
  if (candidateSet.status === "escalated") return "candidate-escalation";
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
