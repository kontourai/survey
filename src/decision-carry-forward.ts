import { sha256Hex } from "./sha256.js";
import { canonicalJson } from "./review-workbench/canonical.js";
import type { ReviewCandidate, ReviewDecision, ReviewItem } from "./review-resource.js";

/**
 * Decisions across review rounds (#295).
 *
 * A new extraction of the same document gives every review item a new identity,
 * so on its own every re-extraction sends every field back to review. Given the
 * producer's stable slot identity and per-candidate version identity, a
 * decision on a slot whose candidates did not change is carried forward to the
 * new round, and a decision that a later one replaces is marked superseded.
 *
 * Vocabulary follows the round receipts producers already keep: a decision is
 * `carried-forward` (made in an earlier round and still holding because its
 * candidates are unchanged) or `affirmed` (made against this round's item).
 *
 * Survey does not invent slot or version identities: they come from the
 * producer, and every item and candidate must carry one. Survey additionally
 * compares each candidate's value, locator, excerpt and source evidence, so a
 * decision is never carried across a candidate whose content changed, even if a
 * producer reused a version identity.
 *
 * Both records are content-addressed (`id` is a digest of every other field)
 * and immutable: a record that changes is a new record.
 */

export const decisionCarryForwardKind = "survey.decision-carry-forward" as const;
export const decisionSupersessionKind = "survey.decision-supersession" as const;

/** How a decision reads in a round. */
export type DecisionBasis = "carried-forward" | "affirmed";

/** The terminal resolution a decision reached, as carry-forward reads it. */
export type CarriedResolution = "accepted" | "rejected" | "could_not_confirm";

/** One review item in a round, with the producer's slot and version identities. */
export interface RoundReviewItem {
  readonly item: ReviewItem;
  /** Producer slot identity: the same field of the same source lineage across rounds. */
  readonly slotId: string;
  /** Producer version identity of every candidate of `item`, keyed by candidate id. */
  readonly candidateVersionIds: Readonly<Record<string, string>>;
}

/** A decision made in an earlier round, with the round item it was made on. */
export interface PriorRoundDecision extends RoundReviewItem {
  readonly decision: ReviewDecision;
}

/** A decision named by content: its resource name and the digest of its canonical bytes. */
export interface DecisionReference {
  readonly name: string;
  readonly digest: string;
}

export interface DecisionCarryForward {
  /** `sha256:` digest of every other field; recomputed on validation. */
  readonly id: string;
  readonly kind: typeof decisionCarryForwardKind;
  readonly schemaVersion: 1;
  readonly priorDecision: DecisionReference;
  readonly slotId: string;
  /** Sorted, unique version ids of the slot's candidates, identical in both rounds. */
  readonly versionIds: readonly string[];
  readonly roundId: string;
  /** The new round's review item the decision now applies to. */
  readonly reviewItemName: string;
  /** The new round's candidate the prior decision selected, when it selected one. */
  readonly candidateId?: string;
  readonly resolution: CarriedResolution;
  readonly basis: "carried-forward";
}

/**
 * Why a decision was superseded: its slot's candidates changed and the new
 * version was decided (`candidate-changed`), or the unchanged slot was
 * reviewed again and decided anew (`re-reviewed`).
 */
export type SupersessionReason = "candidate-changed" | "re-reviewed";

export interface DecisionSupersession {
  /** `sha256:` digest of every other field; recomputed on validation. */
  readonly id: string;
  readonly kind: typeof decisionSupersessionKind;
  readonly schemaVersion: 1;
  readonly priorDecision: DecisionReference;
  readonly newDecision: DecisionReference;
  readonly slotId: string;
  readonly reason: SupersessionReason;
}

/**
 * Which prior resolutions may be carried forward. Only `accepted` is carried
 * unless a policy names others explicitly: a rejection or a could-not-confirm
 * is a judgment about evidence a new round may have changed around it.
 */
export interface CarryForwardPolicy {
  readonly carry: readonly CarriedResolution[];
}

export const defaultCarryForwardPolicy: CarryForwardPolicy = Object.freeze({ carry: Object.freeze(["accepted"] as const) });

export type NeedsReviewReason =
  /** No prior decision was made on this slot. */
  | "no-prior-decision"
  /** The slot's candidate versions differ from the ones the prior decision saw. */
  | "candidate-changed"
  /** A version id matched, but the candidate's value, excerpt, locator or source did not. */
  | "candidate-content-changed"
  /** The prior decision's resolution is not one the policy carries. */
  | "resolution-not-carried"
  /** More than one live prior decision names this slot. */
  | "ambiguous-prior-decisions";

export interface CarriedForwardItem {
  readonly item: RoundReviewItem;
  readonly carryForward: DecisionCarryForward;
}

export interface NeedsReviewItem {
  readonly item: RoundReviewItem;
  readonly reason: NeedsReviewReason;
  /** The prior decision the item could not inherit, when there was one. */
  readonly priorDecision?: DecisionReference;
}

export interface SplitRoundForCarryForwardInput {
  /** Identity of the new round. */
  readonly roundId: string;
  readonly items: readonly RoundReviewItem[];
  readonly priorDecisions: readonly PriorRoundDecision[];
  /** Supersessions already recorded: a prior decision they name is no longer live. */
  readonly supersessions?: readonly DecisionSupersession[];
  readonly policy?: CarryForwardPolicy;
}

export interface SplitRoundForCarryForwardResult {
  readonly carriedForward: readonly CarriedForwardItem[];
  readonly needsReview: readonly NeedsReviewItem[];
}

/**
 * Splits a new round's items into those that inherit a prior decision
 * (with a {@link DecisionCarryForward} record naming it) and those that need
 * review. Pure; performs no I/O. An item carries forward only when exactly one
 * live prior decision names its slot, the slot's candidates have the same
 * version ids in both rounds, each candidate's value, locator, excerpt and
 * source are unchanged, and the policy carries the prior resolution.
 */
export function splitRoundForCarryForward(input: SplitRoundForCarryForwardInput): SplitRoundForCarryForwardResult {
  const roundId = nonEmpty(input.roundId, "roundId");
  const policy = normalizePolicy(input.policy ?? defaultCarryForwardPolicy);
  const superseded = new Set((input.supersessions ?? []).map((record) => validateDecisionSupersession(record).priorDecision.digest));
  const priorBySlot = new Map<string, PriorRoundDecision[]>();
  for (const prior of input.priorDecisions) {
    assertRoundItem(prior, "prior decision");
    assertDecisionNamesItem(prior.decision, prior.item);
    if (superseded.has(decisionReference(prior.decision).digest)) continue;
    priorBySlot.set(prior.slotId, [...(priorBySlot.get(prior.slotId) ?? []), prior]);
  }
  const seenSlots = new Set<string>();
  const carriedForward: CarriedForwardItem[] = [];
  const needsReview: NeedsReviewItem[] = [];
  for (const item of input.items) {
    assertRoundItem(item, "round item");
    if (seenSlots.has(item.slotId)) throw new Error(`Round ${roundId} has two items for slot ${item.slotId}.`);
    seenSlots.add(item.slotId);
    const priors = priorBySlot.get(item.slotId) ?? [];
    if (priors.length === 0) { needsReview.push({ item, reason: "no-prior-decision" }); continue; }
    if (priors.length > 1) { needsReview.push({ item, reason: "ambiguous-prior-decisions" }); continue; }
    const prior = priors[0]!;
    const priorDecision = decisionReference(prior.decision);
    const priorVersions = sortedVersions(prior);
    const versions = sortedVersions(item);
    if (canonicalJson(priorVersions) !== canonicalJson(versions)) { needsReview.push({ item, reason: "candidate-changed", priorDecision }); continue; }
    if (!sameCandidateContent(prior, item)) { needsReview.push({ item, reason: "candidate-content-changed", priorDecision }); continue; }
    const resolution = decisionResolution(prior.decision);
    if (resolution === undefined || !policy.carry.includes(resolution)) { needsReview.push({ item, reason: "resolution-not-carried", priorDecision }); continue; }
    const priorCandidateId = prior.decision.spec.candidateId;
    const candidateId = priorCandidateId === undefined ? undefined : candidateWithVersion(item, prior.candidateVersionIds[priorCandidateId]!).id;
    carriedForward.push({
      item,
      carryForward: sealCarryForward({
        kind: decisionCarryForwardKind,
        schemaVersion: 1,
        priorDecision,
        slotId: item.slotId,
        versionIds: versions,
        roundId,
        reviewItemName: item.item.metadata.name,
        ...(candidateId !== undefined ? { candidateId } : {}),
        resolution,
        basis: "carried-forward",
      }),
    });
  }
  return Object.freeze({ carriedForward: Object.freeze(carriedForward), needsReview: Object.freeze(needsReview) });
}

export interface BuildDecisionSupersessionInput {
  readonly prior: PriorRoundDecision;
  /** The new round's item the new decision was made on. */
  readonly item: RoundReviewItem;
  readonly decision: ReviewDecision;
}

/**
 * Records that `decision`, made on the new round's item for the same slot,
 * replaces `prior`. The reason is derived: `candidate-changed` when the slot's
 * candidate versions or content differ, `re-reviewed` when they do not.
 */
export function buildDecisionSupersession(input: BuildDecisionSupersessionInput): DecisionSupersession {
  assertRoundItem(input.prior, "prior decision");
  assertRoundItem(input.item, "round item");
  assertDecisionNamesItem(input.prior.decision, input.prior.item);
  assertDecisionNamesItem(input.decision, input.item.item);
  if (input.prior.slotId !== input.item.slotId) throw new Error(`A supersession needs one slot; the prior decision is on ${input.prior.slotId} and the new one on ${input.item.slotId}.`);
  const priorDecision = decisionReference(input.prior.decision);
  const newDecision = decisionReference(input.decision);
  if (priorDecision.digest === newDecision.digest) throw new Error("A decision cannot supersede itself.");
  const unchanged = canonicalJson(sortedVersions(input.prior)) === canonicalJson(sortedVersions(input.item)) && sameCandidateContent(input.prior, input.item);
  return sealSupersession({
    kind: decisionSupersessionKind,
    schemaVersion: 1,
    priorDecision,
    newDecision,
    slotId: input.item.slotId,
    reason: unchanged ? "re-reviewed" : "candidate-changed",
  });
}

/** The name and canonical digest of a decision. */
export function decisionReference(decision: ReviewDecision): DecisionReference {
  if (decision?.kind !== "ReviewDecision") throw new Error("A decision reference needs a ReviewDecision.");
  return { name: nonEmpty(decision.metadata?.name, "decision name"), digest: `sha256:${sha256Hex(canonicalJson(decision))}` };
}

/**
 * The terminal resolution a decision reached: `could_not_confirm`, `rejected`
 * for a rejected status, `accepted` for a verified or assumed one. Undefined
 * for a decision that reached none (a `proposed` status without
 * could-not-confirm).
 */
export function decisionResolution(decision: ReviewDecision): CarriedResolution | undefined {
  if (decision.spec.resolution === "could_not_confirm") return "could_not_confirm";
  if (decision.spec.status === "rejected") return "rejected";
  if (decision.spec.status === "verified" || decision.spec.status === "assumed") return "accepted";
  return undefined;
}

/** Validates a stored carry-forward record: its shape and its content-addressed id. */
export function validateDecisionCarryForward(value: unknown): DecisionCarryForward {
  const record = object(value, "DecisionCarryForward");
  exactKeys(record, ["id", "kind", "schemaVersion", "priorDecision", "slotId", "versionIds", "roundId", "reviewItemName", "resolution", "basis"], ["candidateId"], "DecisionCarryForward");
  if (record.kind !== decisionCarryForwardKind || record.schemaVersion !== 1 || record.basis !== "carried-forward") throw new Error("DecisionCarryForward kind, schemaVersion or basis is invalid.");
  validateReference(record.priorDecision, "priorDecision");
  nonEmpty(record.slotId, "slotId"); nonEmpty(record.roundId, "roundId"); nonEmpty(record.reviewItemName, "reviewItemName");
  if (record.candidateId !== undefined) nonEmpty(record.candidateId, "candidateId");
  if (!Array.isArray(record.versionIds) || record.versionIds.length === 0) throw new Error("DecisionCarryForward versionIds must be a non-empty array.");
  record.versionIds.forEach((entry, index) => {
    nonEmpty(entry, "versionId");
    if (index > 0 && !((record.versionIds as string[])[index - 1]! < (entry as string))) throw new Error("DecisionCarryForward versionIds must be sorted and unique.");
  });
  if (!["accepted", "rejected", "could_not_confirm"].includes(record.resolution as string)) throw new Error("DecisionCarryForward resolution is invalid.");
  const { id, ...payload } = record;
  if (id !== recordDigest(decisionCarryForwardKind, payload)) throw new Error("DecisionCarryForward id is not the digest of its fields.");
  return deepFreeze(structuredClone(record)) as unknown as DecisionCarryForward;
}

/** Validates a stored supersession record: its shape and its content-addressed id. */
export function validateDecisionSupersession(value: unknown): DecisionSupersession {
  const record = object(value, "DecisionSupersession");
  exactKeys(record, ["id", "kind", "schemaVersion", "priorDecision", "newDecision", "slotId", "reason"], [], "DecisionSupersession");
  if (record.kind !== decisionSupersessionKind || record.schemaVersion !== 1) throw new Error("DecisionSupersession kind or schemaVersion is invalid.");
  validateReference(record.priorDecision, "priorDecision");
  validateReference(record.newDecision, "newDecision");
  nonEmpty(record.slotId, "slotId");
  if (record.reason !== "candidate-changed" && record.reason !== "re-reviewed") throw new Error("DecisionSupersession reason is invalid.");
  if ((record.priorDecision as DecisionReference).digest === (record.newDecision as DecisionReference).digest) throw new Error("A decision cannot supersede itself.");
  const { id, ...payload } = record;
  if (id !== recordDigest(decisionSupersessionKind, payload)) throw new Error("DecisionSupersession id is not the digest of its fields.");
  return deepFreeze(structuredClone(record)) as unknown as DecisionSupersession;
}

function sealCarryForward(payload: Omit<DecisionCarryForward, "id">): DecisionCarryForward {
  return deepFreeze({ id: recordDigest(decisionCarryForwardKind, payload), ...payload });
}

function sealSupersession(payload: Omit<DecisionSupersession, "id">): DecisionSupersession {
  return deepFreeze({ id: recordDigest(decisionSupersessionKind, payload), ...payload });
}

function recordDigest(kind: string, payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson({ kind: `${kind}/v1`, payload }))}`;
}

/** Every candidate of the item has exactly one non-empty version id, and ids are unique within the item. */
function assertRoundItem(entry: RoundReviewItem, label: string): void {
  nonEmpty(entry.slotId, `${label} slotId`);
  const candidateIds = entry.item.spec.candidates.map((candidate) => candidate.id);
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error(`ReviewItem ${entry.item.metadata.name} has duplicate candidate ids.`);
  const versionKeys = Object.keys(entry.candidateVersionIds ?? {}).sort();
  if (canonicalJson(versionKeys) !== canonicalJson([...candidateIds].sort())) {
    throw new Error(`ReviewItem ${entry.item.metadata.name} (${label}) must carry a producer version id for exactly its candidates.`);
  }
  const versions = Object.values(entry.candidateVersionIds);
  versions.forEach((version) => nonEmpty(version, `${label} versionId`));
  if (new Set(versions).size !== versions.length) throw new Error(`ReviewItem ${entry.item.metadata.name} (${label}) has two candidates with one version id.`);
}

function assertDecisionNamesItem(decision: ReviewDecision, item: ReviewItem): void {
  if (decision.spec.reviewItemName !== item.metadata.name) throw new Error(`ReviewDecision ${decision.metadata.name} names ${decision.spec.reviewItemName}, not ${item.metadata.name}.`);
  if (decision.spec.candidateId !== undefined && !item.spec.candidates.some((candidate) => candidate.id === decision.spec.candidateId)) {
    throw new Error(`ReviewDecision ${decision.metadata.name} selects candidate ${decision.spec.candidateId}, which ReviewItem ${item.metadata.name} does not hold.`);
  }
}

function sortedVersions(entry: RoundReviewItem): string[] {
  return Object.values(entry.candidateVersionIds).sort();
}

function candidateWithVersion(entry: RoundReviewItem, versionId: string): ReviewCandidate {
  const id = Object.keys(entry.candidateVersionIds).find((candidateId) => entry.candidateVersionIds[candidateId] === versionId)!;
  return entry.item.spec.candidates.find((candidate) => candidate.id === id)!;
}

/** For each version id, the prior and new candidates carry the same value and evidence. */
function sameCandidateContent(prior: RoundReviewItem, next: RoundReviewItem): boolean {
  return Object.entries(prior.candidateVersionIds).every(([candidateId, versionId]) => {
    const before = prior.item.spec.candidates.find((candidate) => candidate.id === candidateId)!;
    const after = candidateWithVersion(next, versionId);
    return canonicalJson(candidateContent(before)) === canonicalJson(candidateContent(after));
  });
}

/** What a decision was made about: the value and the evidence behind it. */
function candidateContent(candidate: ReviewCandidate): unknown {
  return {
    role: candidate.role ?? null,
    value: candidate.value,
    locator: candidate.locator?.locator ?? null,
    excerpt: candidate.locator?.excerpt ?? null,
    sourceRef: candidate.source.sourceRef,
    sourceChecksum: candidate.source.checksum ?? null,
  };
}

function normalizePolicy(policy: CarryForwardPolicy): CarryForwardPolicy {
  if (!policy || !Array.isArray(policy.carry)) throw new Error("A carry-forward policy must list the resolutions it carries.");
  for (const resolution of policy.carry) {
    if (!["accepted", "rejected", "could_not_confirm"].includes(resolution)) throw new Error(`Carry-forward policy names an unknown resolution: ${String(resolution)}.`);
  }
  return policy;
}

function validateReference(value: unknown, label: string): void {
  const reference = object(value, label);
  exactKeys(reference, ["name", "digest"], [], label);
  nonEmpty(reference.name, `${label}.name`);
  if (typeof reference.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(reference.digest)) throw new Error(`${label}.digest must be a sha256:<64 hex> digest.`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required.`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw new Error(`${label}.${key} is unexpected.`);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
