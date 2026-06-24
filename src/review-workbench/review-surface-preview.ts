import { type ReviewCandidate, type ReviewDecision, type ReviewItem } from "../review-resource.js";
import { type ReviewPresentationAdapter } from "./review-presentation.js";

export interface SurfaceProjectionPreview {
  readonly canonicalClaim: PreviewClaim;
  readonly candidateHistory: PreviewCandidateHistory[];
  readonly sourceEvidence: PreviewSourceEvidence;
  readonly reviewEvent?: PreviewReviewEvent;
  readonly integrityPosture: PreviewIntegrityPosture;
  readonly authorityTrace: PreviewAuthorityTrace;
  readonly postureDisclaimer: string;
}

export interface PreviewClaim {
  readonly candidateId: string;
  readonly claimId: string;
  readonly value: string;
  readonly status: string;
}

export interface PreviewCandidateHistory {
  readonly candidateId: string;
  readonly value: string;
  readonly historyLabel: string;
}

export interface PreviewSourceEvidence {
  readonly sourceRef: string;
  readonly sourceId: string;
  readonly excerpt: string;
  readonly extractionId: string;
  readonly extractor: string;
  readonly observedAt: string;
  readonly sourceAuthority?: PreviewSourceAuthority;
}

export interface PreviewSourceAuthority {
  readonly authorityClass: string;
  readonly declaredBy: string;
  readonly scope: string;
}

export interface PreviewReviewEvent {
  readonly actor: string;
  readonly reviewedAt: string;
  readonly status: string;
  readonly rationale: string;
  readonly reviewOutcomeId: string;
}

export interface PreviewIntegrityPosture {
  readonly candidateSetId: string;
  readonly rawSourceId: string;
  readonly extractionId: string;
  readonly checksum: string;
}

export interface PreviewAuthorityTrace {
  readonly status: "empty" | "provided";
  readonly label: string;
  readonly detail: string;
}

export function buildSurfaceProjectionPreview(
  item: ReviewItem,
  decision: ReviewDecision | undefined,
  presentationAdapter: ReviewPresentationAdapter = {},
): SurfaceProjectionPreview | undefined {
  const selectedCandidate = selectedPreviewCandidate(item, decision);
  if (!selectedCandidate || !decision) {
    return undefined;
  }

  const projection = decision.spec.projection ?? selectedCandidate.projection;

  return {
    canonicalClaim: buildPreviewClaim(item, selectedCandidate, decision, projection, presentationAdapter),
    candidateHistory: buildCandidateHistory(item, selectedCandidate, presentationAdapter),
    sourceEvidence: buildSourceEvidence(selectedCandidate),
    reviewEvent: buildReviewEvent(decision, projection),
    integrityPosture: buildIntegrityPosture(item, selectedCandidate, projection),
    authorityTrace: portableAuthorityTrace(selectedCandidate.producer?.authorityTrace),
    postureDisclaimer: postureDisclaimer(),
  };
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function selectedPreviewCandidate(
  item: ReviewItem,
  decision: ReviewDecision | undefined,
): ReviewCandidate | undefined {
  if (!decision?.spec.candidateId) {
    return undefined;
  }

  const candidate = item.spec.candidates.find((entry) => entry.id === decision.spec.candidateId);
  if (!candidate) {
    throw new Error(`ReviewItem ${item.metadata.name} has no candidate ${decision.spec.candidateId}.`);
  }

  return candidate;
}

function buildPreviewClaim(
  item: ReviewItem,
  candidate: ReviewCandidate,
  decision: ReviewDecision,
  projection: ReviewDecision["spec"]["projection"] | ReviewCandidate["projection"],
  presentationAdapter: ReviewPresentationAdapter,
): PreviewClaim {
  return {
    candidateId: candidate.id,
    claimId: projection?.claimId ?? candidate.claimTarget.claimId ?? candidate.claimTarget.fieldOrBehavior,
    value: presentationAdapter.summarizeValue?.(candidate.value, { item, candidate, value: candidate.value })
      ?? formatValue(candidate.value),
    status: decision.spec.status,
  };
}

function buildCandidateHistory(
  item: ReviewItem,
  selectedCandidate: ReviewCandidate,
  presentationAdapter: ReviewPresentationAdapter,
): PreviewCandidateHistory[] {
  return item.spec.candidates
    .filter((candidate) => candidate.id !== selectedCandidate.id)
    .map((candidate) => ({
      candidateId: candidate.id,
      value: presentationAdapter.summarizeValue?.(candidate.value, { item, candidate, value: candidate.value })
        ?? formatValue(candidate.value),
      historyLabel: "Unselected candidate history",
    }));
}

function buildSourceEvidence(candidate: ReviewCandidate): PreviewSourceEvidence {
  return {
    sourceRef: candidate.source.sourceRef,
    sourceId: candidate.source.sourceId ?? candidate.source.sourceRef,
    excerpt: candidate.locator?.excerpt ?? "No source excerpt provided.",
    extractionId: candidate.extraction.extractionId ?? "not provided",
    extractor: candidate.extraction.extractor ?? "unknown",
    observedAt: candidate.source.observedAt ?? candidate.source.fetchedAt ?? "unknown",
    sourceAuthority: sourceAuthorityFromProducer(candidate.producer?.sourceAuthority),
  };
}

function buildReviewEvent(
  decision: ReviewDecision,
  projection: ReviewDecision["spec"]["projection"] | ReviewCandidate["projection"],
): PreviewReviewEvent {
  return {
    actor: decision.spec.actor?.id ?? "unknown",
    reviewedAt: decision.spec.reviewedAt ?? "not recorded",
    status: decision.spec.status,
    rationale: decision.spec.rationale || "No reviewer rationale provided.",
    reviewOutcomeId: projection?.reviewOutcomeId ?? "not provided",
  };
}

function buildIntegrityPosture(
  item: ReviewItem,
  candidate: ReviewCandidate,
  projection: ReviewDecision["spec"]["projection"] | ReviewCandidate["projection"],
): PreviewIntegrityPosture {
  return {
    candidateSetId: projection?.candidateSetId ?? item.spec.projection?.candidateSetId ?? "not provided",
    rawSourceId: projection?.rawSourceId ?? candidate.source.sourceId ?? "not provided",
    extractionId: projection?.extractionId ?? candidate.extraction.extractionId ?? "not provided",
    checksum: candidate.source.checksum ?? "not provided",
  };
}

function postureDisclaimer(): string {
  return "Survey records Raw Source, Source Reference, and review posture for projection; it does not validate real-world truth.";
}

function sourceAuthorityFromProducer(value: unknown): PreviewSourceAuthority | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    authorityClass: String(value.authorityClass ?? "not provided"),
    declaredBy: String(value.declaredBy ?? "not provided"),
    scope: String(value.scope ?? "not provided"),
  };
}

function portableAuthorityTrace(value: unknown): PreviewAuthorityTrace {
  if (Array.isArray(value) && value.length > 0) {
    return {
      status: "provided",
      label: "Portable authority trace provided",
      detail: `${value.length} authority trace entr${value.length === 1 ? "y" : "ies"} supplied by the example.`,
    };
  }

  return {
    status: "empty",
    label: "Empty / not provided",
    detail: "No portable authority trace is present. SourceAuthority metadata is shown with Raw Source and Source Reference posture and is not promoted into authorityTrace.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
