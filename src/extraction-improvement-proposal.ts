import { createHash } from "node:crypto";
import { buildReviewItemsFromExtractionEnvelopeImport, type ExtractionEnvelopeImport } from "./extraction-envelope.js";
import { reviewResourceApiVersion, type ReviewDecision, type ReviewItem } from "./review-resource.js";
import { canonicalJson } from "./review-workbench/canonical.js";
import type { ReviewOutcome, SurveyInput } from "./types.js";

/** Portable reference to a producer-owned task. Survey never copies its executable schema. */
export interface ExtractionTaskSpecReference {
  version: string;
  digest: string;
  exampleDigests: string[];
}

export interface ExtractionImprovementRecordDigests {
  extractionImport: string;
  reviewItem: string;
  reviewDecision: string;
  reviewOutcome: string;
}

/** Canonical projection derived from validated Survey records and their joins. */
export interface ExtractionImprovementLineage {
  taskSpec: ExtractionTaskSpecReference;
  extractionImportName: string;
  extractionId: string;
  proposalId: string;
  reviewItemName: string;
  reviewDecisionName: string;
  reviewOutcomeId: string;
  sourceSnapshotRef: string;
  preparedArtifact: { ref: string; digest: string };
  excerptLocator: string;
  recordDigests: ExtractionImprovementRecordDigests;
}

export interface BadExtractionDiagnosis {
  kind: "bad-extraction";
  requestedTaskChanges: Array<"example-addition" | "guidance-update">;
}

export interface AcceptedExtractionDiagnosis {
  kind: "accepted-extraction";
  requestedTaskChanges: Array<"grounded-positive-example" | "guidance-affirmation">;
}

export interface InsufficientSourceEvidenceDiagnosis {
  kind: "insufficient-source-evidence";
  sourceRemediation: "obtain-authoritative-source" | "refresh-source-snapshot" | "expand-source-scope";
}

/** Caller-supplied diagnosis; Survey never infers it from rationale prose. */
export type ExtractionImprovementDiagnosis =
  | BadExtractionDiagnosis
  | AcceptedExtractionDiagnosis
  | InsufficientSourceEvidenceDiagnosis;

export interface ExtractionImprovementReview {
  resolution: "accepted" | "rejected" | "could_not_confirm";
  status: ReviewOutcome["status"];
  reviewedAt: string;
  rationale: string;
  evidenceIds: string[];
  attemptEvidenceIds: string[];
}

export interface ExtractionImprovementDraft {
  id: string;
  kind: "survey.extraction-improvement-proposal";
  schemaVersion: 1;
  state: "draft";
  createdAt: string;
  lineage: ExtractionImprovementLineage;
  diagnosis: ExtractionImprovementDiagnosis;
  review: ExtractionImprovementReview;
}

export interface BuildExtractionImprovementProposalInput {
  createdAt: string;
  /** Version label paired with the task digest carried by the canonical import. */
  priorTaskSpecVersion: string;
  extractionImport: ExtractionEnvelopeImport;
  proposalIndex: number;
  reviewItem: ReviewItem;
  reviewDecision: ReviewDecision;
  survey: SurveyInput;
  reviewOutcomeId: string;
  diagnosis: ExtractionImprovementDiagnosis;
}

export interface ProducerApproval {
  id: string;
  actor: string;
  approvedAt: string;
  rationale: string;
  evidenceIds: string[];
}

/** Data-only request; the task owner must validate, store, and activate it. */
export interface ExtractionImprovementActivationRequest {
  id: string;
  dispositionKey: string;
  kind: "survey.extraction-improvement-activation-request";
  schemaVersion: 1;
  state: "approved";
  draftId: string;
  approval: ProducerApproval;
  nextTaskSpec: ExtractionTaskSpecReference;
  rollbackTaskSpec: ExtractionTaskSpecReference;
  guidanceChangeProofDigest?: string;
}

export interface ApproveExtractionImprovementProposalInput {
  draft: ExtractionImprovementDraft;
  approval: ProducerApproval;
  nextTaskSpec: ExtractionTaskSpecReference;
  rollbackTaskSpec: ExtractionTaskSpecReference;
  /** Required when the explicit remedy updates or affirms guidance. */
  guidanceChangeProofDigest?: string;
}

export interface ExtractionImprovementRejection {
  id: string;
  dispositionKey: string;
  kind: "survey.extraction-improvement-rejection";
  schemaVersion: 1;
  state: "rejected";
  draftId: string;
  rejection: {
    id: string;
    actor: string;
    rejectedAt: string;
    rationale: string;
    evidenceIds: string[];
  };
}

export interface RejectExtractionImprovementProposalInput {
  draft: ExtractionImprovementDraft;
  rejection: ExtractionImprovementRejection["rejection"];
}

/** One producer/store disposition is allowed for each shared dispositionKey. */
export type ExtractionImprovementDisposition = ExtractionImprovementActivationRequest | ExtractionImprovementRejection;

export interface ExtractionImprovementDispositionConflict {
  kind: "survey.extraction-improvement-disposition-conflict";
  dispositionKey: string;
  /** Canonically ordered distinct records. The fold never selects a winner. */
  dispositions: readonly ExtractionImprovementDisposition[];
}

export interface FoldExtractionImprovementDispositionsResult {
  /** One canonically ordered record for each uncontested disposition key. */
  dispositions: readonly ExtractionImprovementDisposition[];
  /** Canonically ordered conflicts for keys with more than one distinct record. */
  conflicts: readonly ExtractionImprovementDispositionConflict[];
}

/**
 * Folds producer-owned disposition records without performing I/O or selecting
 * between conflicting decisions. Byte-equivalent replay is idempotent.
 */
export function foldExtractionImprovementDispositions(
  input: readonly ExtractionImprovementDisposition[],
): FoldExtractionImprovementDispositionsResult {
  const byKey = new Map<string, Map<string, ExtractionImprovementDisposition>>();
  for (const disposition of input) {
    const records = byKey.get(disposition.dispositionKey) ?? new Map<string, ExtractionImprovementDisposition>();
    records.set(canonicalJson(disposition), disposition);
    byKey.set(disposition.dispositionKey, records);
  }

  const dispositions: ExtractionImprovementDisposition[] = [];
  const conflicts: ExtractionImprovementDispositionConflict[] = [];
  for (const dispositionKey of [...byKey.keys()].sort()) {
    const records = [...byKey.get(dispositionKey)!.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, disposition]) => disposition);
    if (records.length === 1) {
      dispositions.push(records[0]!);
    } else {
      conflicts.push(Object.freeze({
        kind: "survey.extraction-improvement-disposition-conflict" as const,
        dispositionKey,
        dispositions: Object.freeze(records),
      }));
    }
  }

  return Object.freeze({
    dispositions: Object.freeze(dispositions),
    conflicts: Object.freeze(conflicts),
  });
}

/** Builds a frozen draft from validated canonical records. Performs no I/O. */
export function buildExtractionImprovementProposal(input: BuildExtractionImprovementProposalInput): ExtractionImprovementDraft {
  const diagnosis = normalizeDiagnosis(input.diagnosis);
  const lineage = projectValidatedLineage(input);
  const review = projectValidatedReview(input, diagnosis, lineage.proposalId);
  const outcome = exactlyOne(input.survey.reviewOutcomes, ({ id }) => id === input.reviewOutcomeId, "review outcome");
  lineage.recordDigests.reviewOutcome = recordDigest("ReviewOutcome", outcome);
  const payload = {
    kind: "survey.extraction-improvement-proposal" as const,
    schemaVersion: 1 as const,
    state: "draft" as const,
    createdAt: canonicalTimestamp(input.createdAt, "createdAt"),
    lineage,
    diagnosis,
    review,
  };
  return freeze({ id: digest("survey.extraction-improvement-proposal/v1", payload), ...payload });
}

/** Emits a reversible activation request, never an activation. */
export function approveExtractionImprovementProposal(input: ApproveExtractionImprovementProposalInput): ExtractionImprovementActivationRequest {
  assertDraftIntegrity(input.draft);
  if (input.draft.diagnosis.kind === "insufficient-source-evidence") {
    throw new Error("insufficient-source-evidence proposals cannot request a task-spec change");
  }
  const approval = normalizeApproval(input.approval);
  const nextTaskSpec = normalizeTaskSpecReference(input.nextTaskSpec, "nextTaskSpec");
  const rollbackTaskSpec = normalizeTaskSpecReference(input.rollbackTaskSpec, "rollbackTaskSpec");
  if (nextTaskSpec.version === input.draft.lineage.taskSpec.version || nextTaskSpec.digest === input.draft.lineage.taskSpec.digest) {
    throw new Error("nextTaskSpec must be a new version with a new digest");
  }
  if (canonicalJson(rollbackTaskSpec) !== canonicalJson(input.draft.lineage.taskSpec)) {
    throw new Error("rollbackTaskSpec must exactly identify the draft's prior task spec");
  }

  const changes: readonly string[] = input.draft.diagnosis.requestedTaskChanges;
  const addsExample = changes.includes("example-addition") || changes.includes("grounded-positive-example");
  const changesGuidance = changes.includes("guidance-update") || changes.includes("guidance-affirmation");
  assertExampleDigestChange(input.draft.lineage.taskSpec.exampleDigests, nextTaskSpec.exampleDigests, addsExample);
  const guidanceChangeProofDigest = input.guidanceChangeProofDigest === undefined
    ? undefined
    : sha256Digest(input.guidanceChangeProofDigest, "guidanceChangeProofDigest");
  if (changesGuidance && guidanceChangeProofDigest === undefined) {
    throw new Error("guidance changes require guidanceChangeProofDigest");
  }
  if (!changesGuidance && guidanceChangeProofDigest !== undefined) {
    throw new Error("guidanceChangeProofDigest is not allowed without a guidance remedy");
  }

  const dispositionKey = dispositionKeyFor(input.draft.id);
  const payload = {
    dispositionKey,
    kind: "survey.extraction-improvement-activation-request" as const,
    schemaVersion: 1 as const,
    state: "approved" as const,
    draftId: input.draft.id,
    approval,
    nextTaskSpec,
    rollbackTaskSpec,
    ...(guidanceChangeProofDigest ? { guidanceChangeProofDigest } : {}),
  };
  return freeze({ id: digest("survey.extraction-improvement-activation-request/v1", payload), ...payload });
}

/** Emits an idempotent terminal rejection with the same disposition key as approval. */
export function rejectExtractionImprovementProposal(input: RejectExtractionImprovementProposalInput): ExtractionImprovementRejection {
  assertDraftIntegrity(input.draft);
  const rejection = normalizeRejection(input.rejection);
  const payload = {
    dispositionKey: dispositionKeyFor(input.draft.id),
    kind: "survey.extraction-improvement-rejection" as const,
    schemaVersion: 1 as const,
    state: "rejected" as const,
    draftId: input.draft.id,
    rejection,
  };
  return freeze({ id: digest("survey.extraction-improvement-rejection/v1", payload), ...payload });
}

function projectValidatedLineage(input: BuildExtractionImprovementProposalInput): ExtractionImprovementLineage {
  const canonicalItems = buildReviewItemsFromExtractionEnvelopeImport(input.extractionImport);
  if (!Number.isSafeInteger(input.proposalIndex) || input.proposalIndex < 0 || input.proposalIndex >= canonicalItems.length) {
    throw new Error("proposalIndex does not identify a grounded extraction proposal");
  }
  const canonicalItem = canonicalItems[input.proposalIndex]!;
  if (canonicalJson(canonicalItem) !== canonicalJson(input.reviewItem)) {
    throw new Error("reviewItem is not the canonical projection of extractionImport and proposalIndex");
  }
  const envelope = input.extractionImport.spec.envelope;
  const proposal = envelope.result.proposals[input.proposalIndex]!;
  const artifact = envelope.result.preparedArtifact;
  if (!envelope.result.taskDigest || !artifact || !envelope.source.snapshotRef) {
    throw new Error("extraction improvement requires task, prepared-artifact, and source-snapshot grounding");
  }
  const candidate = exactlyOne(input.reviewItem.spec.candidates, () => true, "review candidate");
  if (!candidate.extraction.extractionId) throw new Error("canonical review candidate requires an extraction id");
  return {
    taskSpec: normalizeTaskSpecReference({
      version: nonEmpty(input.priorTaskSpecVersion, "priorTaskSpecVersion"),
      digest: envelope.result.taskDigest,
      exampleDigests: envelope.result.exampleDigests ?? [],
    }, "lineage.taskSpec"),
    extractionImportName: input.extractionImport.metadata.name,
    extractionId: candidate.extraction.extractionId,
    proposalId: candidate.id,
    reviewItemName: input.reviewItem.metadata.name,
    reviewDecisionName: validateReviewDecision(input.reviewDecision, input.reviewItem),
    reviewOutcomeId: nonEmpty(input.reviewOutcomeId, "reviewOutcomeId"),
    sourceSnapshotRef: envelope.source.snapshotRef,
    preparedArtifact: { ref: artifact.ref, digest: rawSha256Digest(artifact.digest, "preparedArtifact.digest") },
    excerptLocator: nonEmpty(proposal.provenance.locator, "proposal.provenance.locator"),
    recordDigests: {
      extractionImport: recordDigest("ExtractionEnvelopeImport", input.extractionImport),
      reviewItem: recordDigest("ReviewItem", input.reviewItem),
      reviewDecision: recordDigest("ReviewDecision", input.reviewDecision),
      reviewOutcome: "",
    },
  };
}

function projectValidatedReview(input: BuildExtractionImprovementProposalInput, diagnosis: ExtractionImprovementDiagnosis, proposalId: string): ExtractionImprovementReview {
  const outcome = exactlyOne(input.survey.reviewOutcomes, ({ id }) => id === input.reviewOutcomeId, "review outcome");
  const decision = input.reviewDecision;
  const projection = decision.spec.projection;
  if (!projection || projection.reviewOutcomeId !== outcome.id || projection.candidateSetId !== outcome.candidateSetId) {
    throw new Error("reviewDecision projection must identify the concrete Survey review outcome and candidate set");
  }
  if (decision.spec.candidateId !== outcome.candidateId || projection.candidateId !== outcome.candidateId) {
    throw new Error("reviewDecision and reviewOutcome candidate lineage do not match");
  }
  if (outcome.candidateId !== undefined && outcome.candidateId !== proposalId) {
    throw new Error("any identified review candidate must be the canonical imported proposal");
  }
  assertDecisionOutcomeField(decision.spec.status, outcome.status, "status");
  assertDecisionOutcomeField(decision.spec.resolution, outcome.resolution, "resolution");
  assertDecisionOutcomeField(decision.spec.resolutionReason, outcome.resolutionReason, "resolutionReason");
  assertDecisionOutcomeField(decision.spec.actor?.id, outcome.actor, "actor");
  assertDecisionOutcomeField(decision.spec.reviewedAt, outcome.reviewedAt, "reviewedAt");
  assertDecisionOutcomeField(decision.spec.rationale, outcome.rationale, "rationale");
  assertSetEqual(decision.spec.evidenceIds ?? [], outcome.evidenceIds ?? [], "evidenceIds");
  assertSetEqual(decision.spec.attemptEvidenceIds ?? [], outcome.attemptEvidenceIds ?? [], "attemptEvidenceIds");
  assertDiagnosisReview(diagnosis, outcome);

  const review = {
    resolution: outcome.resolution!,
    status: outcome.status,
    reviewedAt: canonicalTimestamp(outcome.reviewedAt, "reviewOutcome.reviewedAt"),
    rationale: nonEmpty(outcome.rationale ?? outcome.resolutionReason, "review rationale"),
    evidenceIds: sortedUnique(outcome.evidenceIds ?? [], "review.evidenceIds", nonEmpty),
    attemptEvidenceIds: sortedUnique(outcome.attemptEvidenceIds ?? [], "review.attemptEvidenceIds", nonEmpty),
  } as ExtractionImprovementReview;
  return review;
}

function validateReviewDecision(decision: ReviewDecision, item: ReviewItem): string {
  if (!decision || decision.apiVersion !== reviewResourceApiVersion || decision.kind !== "ReviewDecision") {
    throw new Error("reviewDecision must be a canonical ReviewDecision resource");
  }
  if (decision.spec.reviewItemName !== item.metadata.name) throw new Error("reviewDecision does not join to reviewItem");
  return nonEmpty(decision.metadata.name, "reviewDecision.metadata.name");
}

function assertDiagnosisReview(diagnosis: ExtractionImprovementDiagnosis, outcome: ReviewOutcome): void {
  if (diagnosis.kind === "accepted-extraction") {
    if (outcome.resolution !== "accepted" || (outcome.status !== "verified" && outcome.status !== "assumed")) {
      throw new Error("accepted-extraction requires an accepted verified or assumed review outcome");
    }
  } else if (diagnosis.kind === "bad-extraction") {
    if (outcome.resolution !== "rejected" || outcome.status !== "rejected") {
      throw new Error("bad-extraction requires an explicit rejected review outcome");
    }
  } else if (outcome.resolution !== "could_not_confirm") {
    throw new Error("insufficient-source-evidence requires an explicit could_not_confirm review outcome");
  }
}

function normalizeDiagnosis(value: ExtractionImprovementDiagnosis): ExtractionImprovementDiagnosis {
  const diagnosis = requiredObject(value, "diagnosis");
  if (diagnosis.kind === "bad-extraction") {
    const requestedTaskChanges = normalizeChanges(diagnosis.requestedTaskChanges, "diagnosis.requestedTaskChanges", ["example-addition", "guidance-update"] as const);
    return { kind: "bad-extraction", requestedTaskChanges };
  }
  if (diagnosis.kind === "accepted-extraction") {
    const requestedTaskChanges = normalizeChanges(diagnosis.requestedTaskChanges, "diagnosis.requestedTaskChanges", ["grounded-positive-example", "guidance-affirmation"] as const);
    return { kind: "accepted-extraction", requestedTaskChanges };
  }
  if (diagnosis.kind === "insufficient-source-evidence") {
    const sourceRemediation = diagnosis.sourceRemediation;
    if (sourceRemediation !== "obtain-authoritative-source" && sourceRemediation !== "refresh-source-snapshot" && sourceRemediation !== "expand-source-scope") {
      throw new Error("insufficient-source-evidence requires an explicit source remediation");
    }
    return { kind: "insufficient-source-evidence", sourceRemediation };
  }
  throw new Error("diagnosis.kind must be explicit");
}

function normalizeChanges<T extends string>(value: unknown, label: string, allowed: readonly T[]): T[] {
  const changes = sortedUnique(value as unknown[], label, (change, field) => {
    if (typeof change !== "string" || !allowed.includes(change as T)) throw new Error(`${field} contains an unsupported task change`);
    return change as T;
  });
  if (changes.length === 0) throw new Error(`${label} requires at least one explicit task change`);
  return changes;
}

function assertExampleDigestChange(prior: string[], next: string[], addsExample: boolean): void {
  const priorSet = new Set(prior);
  const nextSet = new Set(next);
  const strictSuperset = prior.every((value) => nextSet.has(value)) && next.length > prior.length;
  if (addsExample && !strictSuperset) throw new Error("example remedy requires next example digests to be a strict superset");
  if (!addsExample && canonicalJson(prior) !== canonicalJson(next)) throw new Error("next example digests changed without an example remedy");
}

function assertDraftIntegrity(draft: ExtractionImprovementDraft): void {
  if (!draft || draft.kind !== "survey.extraction-improvement-proposal" || draft.schemaVersion !== 1 || draft.state !== "draft") {
    throw new Error("disposition requires a draft extraction improvement proposal");
  }
  const normalizedDiagnosis = normalizeDiagnosis(draft.diagnosis);
  if (canonicalJson(normalizedDiagnosis) !== canonicalJson(draft.diagnosis)) throw new Error("draft diagnosis is not canonical");
  const normalizedTask = normalizeTaskSpecReference(draft.lineage.taskSpec, "draft.lineage.taskSpec");
  if (canonicalJson(normalizedTask) !== canonicalJson(draft.lineage.taskSpec)) throw new Error("draft task reference is not canonical");
  for (const [field, value] of Object.entries(draft.lineage.recordDigests)) sha256Digest(value, `draft.lineage.recordDigests.${field}`);
  rawSha256Digest(draft.lineage.preparedArtifact.digest, "draft.lineage.preparedArtifact.digest");
  nonEmpty(draft.lineage.preparedArtifact.ref, "draft.lineage.preparedArtifact.ref");
  for (const [field, value] of Object.entries({
    extractionImportName: draft.lineage.extractionImportName,
    extractionId: draft.lineage.extractionId,
    proposalId: draft.lineage.proposalId,
    reviewItemName: draft.lineage.reviewItemName,
    reviewDecisionName: draft.lineage.reviewDecisionName,
    reviewOutcomeId: draft.lineage.reviewOutcomeId,
    sourceSnapshotRef: draft.lineage.sourceSnapshotRef,
    excerptLocator: draft.lineage.excerptLocator,
  })) nonEmpty(value, `draft.lineage.${field}`);
  canonicalTimestamp(draft.createdAt, "draft.createdAt");
  canonicalTimestamp(draft.review.reviewedAt, "draft.review.reviewedAt");
  nonEmpty(draft.review.rationale, "draft.review.rationale");
  const evidenceIds = sortedUnique(draft.review.evidenceIds, "draft.review.evidenceIds", nonEmpty);
  const attemptEvidenceIds = sortedUnique(draft.review.attemptEvidenceIds, "draft.review.attemptEvidenceIds", nonEmpty);
  if (canonicalJson(evidenceIds) !== canonicalJson(draft.review.evidenceIds)
    || canonicalJson(attemptEvidenceIds) !== canonicalJson(draft.review.attemptEvidenceIds)) {
    throw new Error("draft review evidence is not canonical");
  }
  assertDraftDiagnosisReview(draft.diagnosis, draft.review);
  const { id, ...payload } = draft;
  if (id !== digest("survey.extraction-improvement-proposal/v1", payload)) {
    throw new Error("extraction improvement draft does not match its immutable identity");
  }
}

function assertDraftDiagnosisReview(diagnosis: ExtractionImprovementDiagnosis, review: ExtractionImprovementReview): void {
  if (diagnosis.kind === "accepted-extraction") {
    if (review.resolution !== "accepted" || (review.status !== "verified" && review.status !== "assumed")) {
      throw new Error("draft accepted-extraction review is inconsistent");
    }
  } else if (diagnosis.kind === "bad-extraction") {
    if (review.resolution !== "rejected" || review.status !== "rejected") throw new Error("draft bad-extraction review is inconsistent");
  } else if (review.resolution !== "could_not_confirm") {
    throw new Error("draft insufficient-source-evidence review is inconsistent");
  }
}

function normalizeTaskSpecReference(value: ExtractionTaskSpecReference, label: string): ExtractionTaskSpecReference {
  const task = requiredObject(value, label);
  return {
    version: nonEmpty(task.version, `${label}.version`),
    digest: sha256Digest(task.digest, `${label}.digest`),
    exampleDigests: sortedUnique(task.exampleDigests as unknown[], `${label}.exampleDigests`, sha256Digest),
  };
}

function normalizeApproval(value: ProducerApproval): ProducerApproval {
  const approval = requiredObject(value, "approval");
  return {
    id: nonEmpty(approval.id, "approval.id"), actor: nonEmpty(approval.actor, "approval.actor"),
    approvedAt: canonicalTimestamp(approval.approvedAt, "approval.approvedAt"),
    rationale: nonEmpty(approval.rationale, "approval.rationale"),
    evidenceIds: sortedUnique(approval.evidenceIds as unknown[], "approval.evidenceIds", nonEmpty),
  };
}

function normalizeRejection(value: ExtractionImprovementRejection["rejection"]): ExtractionImprovementRejection["rejection"] {
  const rejection = requiredObject(value, "rejection");
  return {
    id: nonEmpty(rejection.id, "rejection.id"), actor: nonEmpty(rejection.actor, "rejection.actor"),
    rejectedAt: canonicalTimestamp(rejection.rejectedAt, "rejection.rejectedAt"),
    rationale: nonEmpty(rejection.rationale, "rejection.rationale"),
    evidenceIds: sortedUnique(rejection.evidenceIds as unknown[], "rejection.evidenceIds", nonEmpty),
  };
}

function dispositionKeyFor(draftId: string): string {
  return digest("survey.extraction-improvement-disposition/v1", { draftId });
}

function recordDigest(kind: string, value: unknown): string {
  return digest("survey.extraction-improvement-record/v1", { kind, value });
}

function assertDecisionOutcomeField(left: unknown, right: unknown, label: string): void {
  if (canonicalJson(left ?? null) !== canonicalJson(right ?? null)) throw new Error(`reviewDecision and reviewOutcome ${label} do not match`);
}

function assertSetEqual(left: string[], right: string[], label: string): void {
  const a = sortedUnique(left, `reviewDecision.${label}`, nonEmpty);
  const b = sortedUnique(right, `reviewOutcome.${label}`, nonEmpty);
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(`reviewDecision and reviewOutcome ${label} do not match`);
}

function exactlyOne<T>(records: T[], predicate: (record: T) => boolean, label: string): T {
  const matches = records.filter(predicate);
  if (matches.length !== 1) throw new Error(`extraction improvement requires exactly one ${label}; found ${matches.length}`);
  return matches[0]!;
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function sha256Digest(value: unknown, label: string): string {
  const digestValue = nonEmpty(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(digestValue)) throw new Error(`${label} must be a sha256 digest`);
  return digestValue;
}

function rawSha256Digest(value: unknown, label: string): string {
  const digestValue = nonEmpty(value, label);
  if (!/^[a-f0-9]{64}$/.test(digestValue)) throw new Error(`${label} must be an unprefixed sha256 digest`);
  return digestValue;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = nonEmpty(value, label);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) throw new Error(`${label} must be a canonical ISO timestamp`);
  return timestamp;
}

function sortedUnique<T>(values: unknown[], label: string, normalize: (value: unknown, label: string) => T): T[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const keyed = values.map((value, index) => normalize(value, `${label}[${index}]`))
    .map((value) => [canonicalJson(value), value] as const).sort(([left], [right]) => left.localeCompare(right));
  if (keyed.some(([value], index) => index > 0 && keyed[index - 1]![0] === value)) throw new Error(`${label} must not contain duplicate values`);
  return keyed.map(([, value]) => value);
}

function digest(domain: string, payload: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson({ domain, payload })).digest("hex")}`;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
