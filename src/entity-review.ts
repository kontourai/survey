import type { Claim, Evidence, IdentityLink, SubjectRef, VerificationEvent } from "@kontourai/surface";
import { valueDigest, type CandidateVerification } from "./candidate-verification.js";
import { decisionResolution } from "./decision-carry-forward.js";
import { reviewResourceApiVersion, type ReviewDecision, type ReviewItem } from "./review-resource.js";

/** A producer-supplied, exact source reference; the host is responsible for resolving it. */
export interface EntityEvidence {
  id: string;
  sourceRef: string;
  sourceId: string;
  checksum: string;
  observedAt: string;
  locatorScheme: "pdf" | "text" | "html" | "structured-field" | "text-span";
  locator: string;
  excerpt: string;
  stance: "supports" | "contradicts" | "context";
}
export type EntityOperation = "merge" | "split" | "alias" | "same-as" | "related-to" | `domain:${string}`;
export interface EntityAlternative {
  subjects: [SubjectRef, SubjectRef];
  operation: EntityOperation;
  evidence: EntityEvidence[];
  confidenceComponents: Record<string, number>;
  verifications?: CandidateVerification[];
}
export interface EntityProposalInput {
  revision: string;
  proposer: { id: string; model?: string; rule?: string };
  policy: { id: string; revision: string };
  alternatives: EntityAlternative[];
}
export interface EntityProposal {
  id: string;
  apiVersion: typeof reviewResourceApiVersion;
  metadata: { name: string };
  kind: "EntityProposal";
  spec: EntityProposalInput;
}
export type EntityDisposition = "accepted" | "rejected" | "abstained" | "disputed";
export interface EntityOutcome {
  id: string;
  apiVersion: typeof reviewResourceApiVersion;
  metadata: { name: string };
  kind: "EntityReviewOutcome";
  spec: {
    proposal: EntityProposal;
    decision: ReviewDecision;
    disposition: EntityDisposition;
    candidateId?: string;
    /** Previous immutable decision this review replaces; does not rewrite it. */
    supersedes?: string;
  };
}
export interface EntityProjectionRecord {
  proposalId: string;
  candidateId: string;
  status: "proposed" | "accepted" | "rejected" | "disputed" | "superseded" | "abstained";
  outcomeId?: string;
  supersededBy?: string;
  ambiguity?: "conflicting-reviews";
  /** A reviewed mapping assertion only. Admission to Surface is the host's responsibility. */
  identityLink?: IdentityLink;
  mappingClaim?: Claim;
  mappingEvidence?: Evidence[];
  mappingEvent?: VerificationEvent;
  alternative: EntityAlternative;
}

function required(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
}
function safeJson(value: unknown): void {
  const seen = new Set<object>();
  function visit(v: unknown): void {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || v === null || seen.has(v)) throw new Error("Expected lossless JSON");
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) throw new Error("Expected plain JSON");
    seen.add(v);
    if (Array.isArray(v)) { for (const item of v) visit(item); }
    else { for (const item of Object.values(v)) visit(item); }
    seen.delete(v);
  }
  visit(value);
}
function digest(domain: string, value: unknown): string { safeJson(value); return valueDigest({ domain, value }); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function candidateId(alternative: EntityAlternative): string { const { verifications: _verifications, ...content } = alternative; return digest("survey.entity-alternative/v1", content); }
const symmetricOperations: readonly EntityOperation[] = ["merge", "split", "alias", "same-as", "related-to"];
function pairKey(subjects: readonly SubjectRef[]): string {
  return JSON.stringify(subjects.map(s => [s.subjectType, s.subjectId]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
}
function normalizeAlternative(a: EntityAlternative): EntityAlternative {
  const subjects = symmetricOperations.includes(a.operation) && pairKey(a.subjects) !== JSON.stringify(a.subjects.map(s => [s.subjectType, s.subjectId])) ? [a.subjects[1], a.subjects[0]] as [SubjectRef, SubjectRef] : a.subjects;
  return { ...a, subjects, evidence: [...a.evidence].sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0) };
}
function validateAlternative(a: EntityAlternative): void {
  if (!a || !Array.isArray(a.subjects) || a.subjects.length !== 2) throw new Error("Two subject candidates are required");
  for (const s of a.subjects) { required(s?.subjectType, "subjectType"); required(s?.subjectId, "subjectId"); }
  if (a.subjects[0].subjectType === a.subjects[1].subjectType && a.subjects[0].subjectId === a.subjects[1].subjectId) throw new Error("Self relations are not reviewable");
  if (!["merge", "split", "alias", "same-as", "related-to"].includes(a.operation) && !(typeof a.operation === "string" && /^domain:\S+$/.test(a.operation))) throw new Error("Invalid entity operation");
  if (!Array.isArray(a.evidence) || !a.evidence.length) throw new Error("Exact evidence is required");
  const ids = new Set<string>();
  for (const e of a.evidence) {
    for (const field of ["id", "sourceRef", "sourceId", "checksum", "locator", "excerpt", "observedAt"] as const) required(e?.[field], `evidence ${field}`);
    if (!Number.isFinite(Date.parse(e.observedAt))) throw new Error("Invalid evidence time");
    if (!["supports", "contradicts", "context"].includes(e.stance) || ids.has(e.id)) throw new Error("Invalid or duplicate evidence");
    if (!["pdf", "text", "html", "structured-field", "text-span"].includes(e.locatorScheme)) throw new Error("Invalid locator scheme");
    ids.add(e.id);
  }
  if (!a.confidenceComponents || typeof a.confidenceComponents !== "object" || Array.isArray(a.confidenceComponents)) throw new Error("Confidence components must be an object");
  for (const [key, score] of Object.entries(a.confidenceComponents)) { required(key, "confidence component"); if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) throw new Error("Invalid confidence component"); }
}
/** Deterministic proposal identity and candidate ordering; identical alternatives collapse. */
export function createEntityProposal(input: EntityProposalInput): EntityProposal {
  safeJson(input); required(input?.revision, "revision"); required(input.proposer?.id, "proposer id");
  required(input.policy?.id, "policy id"); required(input.policy?.revision, "policy revision");
  if (!Array.isArray(input.alternatives) || !input.alternatives.length) throw new Error("Alternatives are required");
  const alternatives = new Map<string, EntityAlternative>();
  for (const raw of input.alternatives) { validateAlternative(raw); const a = normalizeAlternative(raw); const id = candidateId(a); const prior = alternatives.get(id); if (prior && digest("survey.entity-alternative-record/v1", prior) !== digest("survey.entity-alternative-record/v1", a)) throw new Error("Conflicting duplicate alternative"); alternatives.set(id, a); }
  const spec = clone({ ...input, alternatives: [...alternatives.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, a]) => a) });
  const id = digest("survey.entity-proposal/v1", spec);
  return { id, apiVersion: reviewResourceApiVersion, metadata: { name: id }, kind: "EntityProposal", spec };
}
function assertProposal(proposal: EntityProposal): void {
  if (proposal.apiVersion !== reviewResourceApiVersion || proposal.metadata?.name !== proposal.id || proposal.kind !== "EntityProposal" || createEntityProposal(proposal.spec).id !== proposal.id || digest("survey.entity-proposal/v1", proposal.spec) !== proposal.id) throw new Error("Invalid proposal identity");
}
/** Existing Workbench renders every candidate and its source; no confidence can accept it. */
export function entityProposalToReviewItem(proposal: EntityProposal): ReviewItem {
  assertProposal(proposal);
  const candidates = proposal.spec.alternatives.map((a) => {
    const e = a.evidence[0]!;
    return {
      id: candidateId(a), role: "proposed" as const,
      value: clone({ operation: a.operation, subjects: a.subjects, evidence: a.evidence, proposer: proposal.spec.proposer }),
      source: { sourceRef: e.sourceRef, sourceId: e.sourceId, checksum: e.checksum },
      locator: { scheme: e.locatorScheme, locator: e.locator, excerpt: e.excerpt },
      extraction: { target: "entity relationship", extractor: proposal.spec.proposer.id, ...(proposal.spec.proposer.model ? { model: proposal.spec.proposer.model } : {}) },
      claimTarget: { subjectType: a.subjects[0].subjectType, subjectId: a.subjects[0].subjectId, facet: "identity-review", claimType: "entity-relationship", fieldOrBehavior: a.operation, impactLevel: "medium" as const },
      ...(a.verifications ? { verifications: clone(a.verifications) } : {}),
    };
  });
  return { apiVersion: reviewResourceApiVersion, kind: "ReviewItem", metadata: { name: proposal.id }, spec: { target: "Entity relationship", candidates, candidateSetStatus: candidates.length > 1 ? "conflict" : "needs-review", editable: false, producerPolicy: { decisionMode: "free-select", entityPolicy: clone(proposal.spec.policy), revision: proposal.spec.revision } } };
}
/** Bind a durable Workbench decision to the exact proposal. */
export function entityOutcomeFromDecision(proposal: EntityProposal, decision: ReviewDecision, supersedes?: string): EntityOutcome {
  assertProposal(proposal);
  if (decision.apiVersion !== reviewResourceApiVersion || decision.kind !== "ReviewDecision" || decision.spec.reviewItemName !== proposal.id) throw new Error("Decision does not bind proposal");
  required(decision.metadata.name, "decision name"); required(decision.spec.actor?.id, "review actor"); required(decision.spec.reviewedAt, "reviewedAt");
  if (!Number.isFinite(Date.parse(decision.spec.reviewedAt))) throw new Error("Invalid review time");
  if (decision.spec.editedValue !== undefined) throw new Error("Entity decisions cannot edit proposed values");
  let disposition: EntityDisposition;
  const resolution = decisionResolution(decision);
  if (decision.spec.status === "verified" && !decision.spec.resolution && resolution === "accepted") disposition = "accepted";
  else if (!decision.spec.resolution && resolution === "rejected") disposition = "rejected";
  else if (decision.spec.status === "proposed" && !decision.spec.resolution && decision.metadata.labels?.["survey.kontourai.io/entity-disposition"] === "disputed") { required(decision.spec.rationale, "dispute rationale"); disposition = "disputed"; }
  else if (decision.spec.status === "proposed" && resolution === "could_not_confirm") { required(decision.spec.resolutionReason, "abstention reason"); disposition = "abstained"; }
  else throw new Error("Unsupported review disposition");
  const ids = proposal.spec.alternatives.map(candidateId);
  if (disposition === "accepted" && !decision.spec.candidateId) throw new Error("Acceptance requires a candidate");
  if (decision.spec.candidateId && !ids.includes(decision.spec.candidateId)) throw new Error("Unknown candidate");
  if (supersedes !== undefined) required(supersedes, "supersedes");
  if (supersedes && disposition === "abstained") throw new Error("Abstention cannot supersede an outcome");
  const chosen = proposal.spec.alternatives.find(a => candidateId(a) === decision.spec.candidateId);
  if (disposition === "accepted" && chosen?.operation === "split" && !supersedes) throw new Error("A split must name the earlier reviewed mapping");
  const payload = clone({ proposal, decision, disposition, ...(decision.spec.candidateId ? { candidateId: decision.spec.candidateId } : {}), ...(supersedes ? { supersedes } : {}) });
  const id = digest("survey.entity-outcome/v1", payload);
  return { id, apiVersion: reviewResourceApiVersion, metadata: { name: id }, kind: "EntityReviewOutcome", spec: payload };
}
function assertOutcome(outcome: EntityOutcome): void {
  const rebuilt = entityOutcomeFromDecision(outcome.spec.proposal, outcome.spec.decision, outcome.spec.supersedes);
  if (outcome.apiVersion !== reviewResourceApiVersion || outcome.metadata?.name !== outcome.id || outcome.kind !== rebuilt.kind || outcome.id !== rebuilt.id || outcome.spec.disposition !== rebuilt.spec.disposition || outcome.spec.candidateId !== rebuilt.spec.candidateId) throw new Error("Invalid outcome identity");
}
/** Audit projection, not Surface's temporal or authority admission fold. */
export function projectEntityReviews(proposals: readonly EntityProposal[], outcomes: readonly EntityOutcome[]): EntityProjectionRecord[] {
  const proposalMap = new Map<string, EntityProposal>();
  for (const proposal of proposals) { assertProposal(proposal); proposalMap.set(proposal.id, proposal); }
  const byId = new Map<string, EntityOutcome>();
  for (const outcome of outcomes) { assertOutcome(outcome); if (!proposalMap.has(outcome.spec.proposal.id)) throw new Error("Missing outcome proposal"); byId.set(outcome.id, outcome); }
  const successors = new Map<string, string>();
  for (const outcome of byId.values()) if (outcome.spec.supersedes) {
    const prior = byId.get(outcome.spec.supersedes);
    if (!prior || prior.id === outcome.id || successors.has(prior.id)) throw new Error("Missing or ambiguous supersession ancestry");
    const before = prior.spec.proposal.spec.alternatives.find(a => candidateId(a) === prior.spec.candidateId);
    const after = outcome.spec.proposal.spec.alternatives.find(a => candidateId(a) === outcome.spec.candidateId);
    if (!before || !after) throw new Error("Supersession must bind a prior candidate and a replacement candidate");
    const identityOperations = ["merge", "alias", "same-as", "split"];
    if (before.operation !== after.operation && !(identityOperations.includes(before.operation) && identityOperations.includes(after.operation))) throw new Error("Supersession relation differs");
    if (after.operation === "split" && (!identityOperations.includes(before.operation) || prior.spec.disposition !== "accepted" || outcome.spec.disposition !== "accepted")) throw new Error("Split must replace an accepted identity decision");
    if (pairKey(before.subjects) !== pairKey(after.subjects)) throw new Error("Supersession subjects differ");
    successors.set(prior.id, outcome.id);
  }
  for (const id of byId.keys()) { const seen = new Set<string>(); let at: string | undefined = id; while (at) { if (seen.has(at)) throw new Error("Cyclic supersession"); seen.add(at); at = successors.get(at); } }
  const liveIdentity = [...byId.values()].filter(o => !successors.has(o.id) && o.spec.disposition !== "abstained").flatMap(o => {
    const alternatives = o.spec.proposal.spec.alternatives.filter(a => !o.spec.candidateId || candidateId(a) === o.spec.candidateId);
    return alternatives.filter(a => ["merge", "alias", "same-as", "split"].includes(a.operation)).map(a => ({ outcome: o, alternative: a }));
  });
  const records: EntityProjectionRecord[] = [];
  for (const proposal of [...proposalMap.values()].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const reviews = [...byId.values()].filter(o => o.spec.proposal.id === proposal.id).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const liveReviews = reviews.filter(o => !successors.has(o.id) && o.spec.disposition !== "abstained");
    for (const a of proposal.spec.alternatives) {
      const id = candidateId(a);
      const applicable = reviews.filter(o => !o.spec.candidateId || o.spec.candidateId === id);
      const live = applicable.filter(o => !successors.has(o.id) && o.spec.disposition !== "abstained");
      const samePair = liveIdentity.filter(entry => pairKey(entry.alternative.subjects) === pairKey(a.subjects));
      const incompatiblePair = samePair.some(entry => entry.outcome.spec.disposition !== "accepted" || entry.alternative.operation === "split");
      const proposalConflict = liveReviews.some(entry => entry.spec.disposition !== "accepted" || entry.spec.candidateId !== id);
      if (!applicable.length) records.push({ proposalId: proposal.id, candidateId: id, status: "proposed", alternative: clone(a) });
      for (const o of applicable) {
        const supersededBy = successors.get(o.id);
        const status = supersededBy ? "superseded" : o.spec.disposition;
        const ambiguous = status === "accepted" && (proposalConflict || incompatiblePair);
        const identityLink: IdentityLink | undefined = status === "accepted" && live.length > 0 && !ambiguous && ["merge", "alias", "same-as"].includes(a.operation) ? { id: `entity-link:${o.id}`, subjects: clone(a.subjects), relation: "equivalent", mappingClaimId: `entity-claim:${o.id}`, attestedBy: o.spec.decision.spec.actor!.id, reason: o.spec.decision.spec.rationale } : undefined;
        const mappingClaim: Claim | undefined = identityLink ? { id: identityLink.mappingClaimId!, subjectType: a.subjects[0].subjectType, subjectId: a.subjects[0].subjectId, facet: "identity-review", claimType: "entity-relationship", fieldOrBehavior: a.operation, value: clone({ subjects: a.subjects, relation: "equivalent" }), status: "verified", createdAt: o.spec.decision.spec.reviewedAt!, updatedAt: o.spec.decision.spec.reviewedAt!, metadata: { survey: { proposalId: proposal.id, outcomeId: o.id, evidence: clone(a.evidence), policy: clone(proposal.spec.policy), reviewer: clone(o.spec.decision.spec.actor) } } } : undefined;
        const mappingEvidence: Evidence[] | undefined = mappingClaim ? a.evidence.map(e => ({ id: `entity-evidence:${o.id}:${e.id}`, claimId: mappingClaim.id, evidenceType: "source_excerpt", method: "extraction", sourceRef: e.sourceRef, sourceLocator: e.locator, excerptOrSummary: e.excerpt, observedAt: e.observedAt, collectedBy: proposal.spec.proposer.id, integrityRef: e.checksum, metadata: { sourceId: e.sourceId, locatorScheme: e.locatorScheme, stance: e.stance } })) : undefined;
        const mappingEvent: VerificationEvent | undefined = mappingClaim ? { id: `entity-event:${o.id}`, claimId: mappingClaim.id, status: "verified", actor: o.spec.decision.spec.actor!.id, method: "survey-entity-review", evidenceIds: mappingEvidence!.map(e => e.id), createdAt: o.spec.decision.spec.reviewedAt!, verifiedAt: o.spec.decision.spec.reviewedAt!, ...(o.spec.decision.spec.rationale ? { notes: o.spec.decision.spec.rationale } : {}) } : undefined;
        records.push({ proposalId: proposal.id, candidateId: id, status, outcomeId: o.id, ...(supersededBy ? { supersededBy } : {}), ...(ambiguous ? { ambiguity: "conflicting-reviews" as const } : {}), ...(identityLink ? { identityLink, mappingClaim, mappingEvidence, mappingEvent } : {}), alternative: clone(a) });
      }
    }
  }
  return records;
}
/** Bounded, side-effect-free bulk plan; the caller persists only after reviewing it. */
export function planEntityReviewBatch(entries: readonly { proposal: EntityProposal; decision: ReviewDecision; supersedes?: string }[], existingProposals: readonly EntityProposal[] = [], existingOutcomes: readonly EntityOutcome[] = []): { outcomes: EntityOutcome[]; projection: EntityProjectionRecord[] } {
  if (!entries.length || entries.length > 50) throw new Error("Bulk review must contain 1 to 50 decisions");
  const outcomes = entries.map(e => entityOutcomeFromDecision(e.proposal, e.decision, e.supersedes));
  if (new Set(outcomes.map(o => o.id)).size !== outcomes.length) throw new Error("Duplicate bulk decision");
  return { outcomes, projection: projectEntityReviews([...existingProposals, ...entries.map(e => e.proposal)], [...existingOutcomes, ...outcomes]) };
}
