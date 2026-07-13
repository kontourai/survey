import type { Claim, Evidence, TrustBundle, TrustStatus, VerificationEvent } from "@kontourai/surface";
import { buildReviewProofAnchor } from "./review-proof.js";
import { assertReviewOutcomeDiscipline } from "./producer-discipline.js";
import { deriveCalibration, type CalibrationMetrics } from "./calibration.js";
import type {
  Candidate,
  CandidateSet,
  ClaimTarget,
  Extraction,
  Interpretation,
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
   * Populate `conclusionConfidence.value` from empirical review calibration —
   * "how often this extractor's proposals at this confidence were affirmed by a
   * human reviewer" (the produce side of the confidence loop; see #114/#137).
   * `true` derives calibration from this batch; an object supplies precomputed
   * metrics and/or a `minSamples` floor. Absent → `value` stays unset and only
   * the comfort-zone signal is carried (unchanged behavior).
   *
   * ADVISORY (ADR 0003 §4): this only enriches the emitted conclusion confidence;
   * it never changes a claim's `status`.
   */
  calibration?: boolean | SurveyCalibrationOptions;
}

export function buildSurveyTrustBundle(input: SurveyInput, options: BuildSurveyTrustBundleOptions = {}): TrustBundle {
  const rawSources = indexById(input.rawSources, "raw source");
  const extractions = indexById(input.extractions, "extraction");
  const candidateSets = indexById(input.candidateSets, "candidate set");
  const reviewsByCandidateSet = groupBy(input.reviewOutcomes, (review) => review.candidateSetId);

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
        reviewerAuthority: status === "verified" || status === "assumed" ? "operator" : "none",
        evidenceStrength: status === "verified" || status === "assumed" ? "moderate" : "weak",
        impactLevel: projection.impactLevel,
        ...projection.confidenceBasis,
      },
      metadata: {
        ...projection.metadata,
        survey: buildSurveyMetadata({ projection, rawSource, extraction, candidateSet, candidate, review }),
      },
    };

    // Promote the review's comfort-zone signal — and, when calibration is
    // enabled, an empirically-calibrated conclusion probability — into the
    // first-class conclusionConfidence field (Surface 2.9 / Hachure 0.14) so the
    // signal is portable and comparable, not buried in producer metadata.
    //
    // comfortZone is CARRIED from the review. `value` is PRODUCED from empirical
    // review calibration (#114/#137): the affirmation rate of this extractor's
    // proposals at this confidence — a calibrated conclusion probability, distinct
    // from the extraction-confidence ingredient in confidenceBasis. Only reviewed
    // claims get a value, and only when the group clears the sample floor.
    const comfortZone = review?.withinComfortZone !== undefined
      ? {
          within: review.withinComfortZone,
          ...(review.comfortZoneNote ? { reason: review.comfortZoneNote } : {}),
        }
      : undefined;
    const calibrated = calibrationMetrics && review
      ? lookupCalibratedValue(calibrationMetrics, extraction.extractor, extraction.target, calibrationMinSamples)
      : undefined;
    if (comfortZone || calibrated) {
      claim.conclusionConfidence = {
        ...(calibrated ? { value: calibrated.value, method: calibrated.method } : {}),
        ...(comfortZone ? { comfortZone } : {}),
      };
    }

    if (options.reviewProofs && review) {
      claim.currentIntegrityAnchor = buildReviewProofAnchor({
        rawSource,
        extraction,
        candidate,
        candidateSet,
        reviewOutcome: review,
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

    const rationale = review?.rationale ?? candidateSet.rationale;
    events.push({
      id: `${projection.id}.event.${status}`,
      claimId: projection.id,
      status,
      actor: projection.actor ?? review?.actor ?? projection.collectedBy,
      method: projection.eventMethod ?? eventMethodFor(status, candidateSet),
      evidenceIds: review?.evidenceIds?.length ? review.evidenceIds : [evidenceId],
      createdAt: review?.reviewedAt ?? input.generatedAt,
      verifiedAt: status === "verified" || status === "assumed" ? review?.reviewedAt ?? input.generatedAt : undefined,
      notes: rationale,
    });
  }

  projectInterpretations({ input, rawSources, claims, evidence, events });

  if (input.escalations) {
    const claimIds = new Set(claims.map((c) => c.id));
    for (const escalation of input.escalations) {
      if (escalation.resolvedBy) continue;
      if (!escalation.attachToClaimId) continue;
      if (!claimIds.has(escalation.attachToClaimId)) {
        throw new Error(`Escalation ${escalation.id} references unknown claim ${escalation.attachToClaimId}`);
      }
      events.push({
        id: `${escalation.id}.event`,
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

function projectInterpretations(input: {
  input: SurveyInput;
  rawSources: Map<string, RawSource>;
  claims: Claim[];
  evidence: Evidence[];
  events: VerificationEvent[];
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
}): {
  claim: Claim;
  anchorSource: RawSource;
  evidence: Evidence;
  event: VerificationEvent;
} {
  const anchorSource = requirePolicyStandardAnchor(input.interpretation, input.rawSources);
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
  });
  return {
    claim,
    anchorSource,
    evidence,
    event: createInterpretationEvent({
      interpretation: input.interpretation,
      claim,
      evidenceId: evidence.id,
    }),
  };
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
}): Evidence {
  return {
    id: `${input.interpretation.id}.evidence.anchor`,
    claimId: input.claim.id,
    evidenceType: "policy_rule",
    method: "anchoring",
    sourceRef: input.anchorSource.sourceRef,
    sourceLocator: input.interpretation.ruleLocator,
    excerptOrSummary:
      input.policyStandard?.inlineText ?? `Anchored policy-standard reading at ${input.interpretation.ruleLocator}.`,
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
    },
  };
}

function createInterpretationEvent(input: {
  interpretation: Interpretation;
  claim: Claim;
  evidenceId: string;
}): VerificationEvent {
  return {
    id: `${input.interpretation.id}.event`,
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
    ...(input.review?.withinComfortZone === false
      ? {
          comfortZone: {
            withinComfortZone: false,
            ...(input.review.comfortZoneNote ? { note: input.review.comfortZoneNote } : {}),
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
  return "proposed";
}

function assertProducerDiscipline(input: {
  status: TrustStatus;
  review?: ReviewOutcome;
  extraction: Extraction;
  rawSource: RawSource;
  projection: ClaimTarget;
}): void {
  assertReviewOutcomeDiscipline({
    subject: `Claim ${input.projection.id}`,
    status: input.status,
    review: input.review,
  });
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

function normalizeCalibrationOptions(
  calibration: BuildSurveyTrustBundleOptions["calibration"],
): SurveyCalibrationOptions | undefined {
  if (calibration === undefined || calibration === false) return undefined;
  if (calibration === true) return {};
  return calibration;
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
