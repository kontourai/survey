import { foldCandidateVerifications, type CandidateVerification } from "./candidate-verification.js";
import {
  decisionReference,
  decisionResolution,
  validateDecisionCarryForward,
  validateDecisionSupersession,
  type DecisionBasis,
  type DecisionCarryForward,
  type DecisionSupersession,
} from "./decision-carry-forward.js";
import {
  buildReviewItemsFromExtractionEnvelopeImport,
  excerptMismatchProposalIndices,
  validateExtractionEnvelopeImport,
  type ExtractionEnvelopeImport,
} from "./extraction-envelope.js";
import type { ReviewCandidate, ReviewDecision, ReviewItem } from "./review-resource.js";
import { canonicalJson } from "./review-workbench/canonical.js";

/**
 * Per-field content and lifecycle states (#294), derived from records Survey
 * holds and never stored as labels.
 *
 * Only states with a producer ship. `not_found` (the source was read in full
 * and holds no value for the field) needs per-field chunk coverage and a
 * per-field dropped-proposal count from the extractor, which no producer
 * reports yet, so a field with no candidate in a complete run has no content
 * state at all. Absence of a state never means verified.
 */

/** The claim-metadata key under which the Surface projection carries a field's states. */
export const FIELD_STATE_METADATA_KEY = "survey.kontourai.io/field-state";

/**
 * What the extraction says about a field.
 *
 * - `value`: at least one candidate with evidence.
 * - `conflicting`: two or more distinct candidate values for the one claim.
 * - `unsupported`: every candidate has a verifier record saying contradicted
 *   or not-addressed for its current value, and none saying supported.
 * - `excluded`: the extraction proposed values for the field, but the import
 *   left every one out because its excerpt was not at its cited span. The
 *   field was read; its proposals are unverifiable, not disproven.
 * - `not_covered`: no proposal at all, and the extraction reported that part
 *   of the content was not read (a partial or failed run).
 */
export type FieldContentState = "value" | "conflicting" | "unsupported" | "excluded" | "not_covered";

/**
 * Where review stands for a field: `pending` (no decision), `accepted`,
 * `rejected`, `could_not_confirm`, or `superseded` (a supersession record
 * names the decision as replaced).
 */
export type FieldLifecycleState = "pending" | "accepted" | "rejected" | "could_not_confirm" | "superseded";

/** A claim slot: the claim a proposal would project to, at its path indices. */
export interface FieldSlot {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly facet: string;
  readonly claimType: string;
  readonly fieldOrBehavior: string;
  readonly claimId?: string;
  readonly pathIndices?: readonly number[];
}

/** Facts about a field that are not states. */
export interface FieldStateSignals {
  /** The run that produced this import stopped short or failed: other text may hold values. */
  readonly incompleteRun?: true;
  /** Proposals for this slot the import left out because their excerpt was not at their span. */
  readonly excludedProposals?: number;
  /** The import could not ground any candidate (its prepared artifact did not resolve or verify). */
  readonly unresolvedImport?: true;
}

export interface FieldState {
  readonly importName: string;
  readonly slot: FieldSlot;
  /** The ReviewItem for this slot, when the import produced one. */
  readonly reviewItemName?: string;
  /** Absent when no producer can state one (see the module note on `not_found`). */
  readonly content?: FieldContentState;
  /** Absent when the slot has no review item, so there is nothing to decide. */
  readonly lifecycle?: FieldLifecycleState;
  /** The decision the lifecycle comes from, when there is one. */
  readonly decisionName?: string;
  /** Whether that decision was made on this round's item or carried forward from an earlier one. */
  readonly decisionBasis?: DecisionBasis;
  readonly signals: FieldStateSignals;
}

export interface FieldStateImport {
  readonly record: ExtractionEnvelopeImport;
  /**
   * The fields the extraction was asked for, so a field with no proposal is
   * reported too. Without it only slots that have a proposal appear.
   */
  readonly expectedFields?: readonly FieldSlot[];
}

export interface DeriveFieldStatesInput {
  readonly imports: readonly FieldStateImport[];
  /** Decisions on this round's items. At most one per item. */
  readonly decisions?: readonly ReviewDecision[];
  /** Verifier records for this round's candidates (see `CandidateVerification`). */
  readonly verifications?: readonly CandidateVerification[];
  /** Records that the decisions they name as prior were replaced. */
  readonly supersessions?: readonly DecisionSupersession[];
  /** Earlier decisions carried forward onto this round's items. */
  readonly carryForwards?: readonly DecisionCarryForward[];
}

/**
 * Derives the content and lifecycle state of every field in the given
 * imports. Pure: reads only its input. Each state appears only when the input
 * that produces it is present: no verifications, no `unsupported`; no
 * supersessions, no `superseded`.
 */
export function deriveFieldStates(input: DeriveFieldStatesInput): FieldState[] {
  const decisionsByItem = new Map<string, ReviewDecision>();
  for (const decision of input.decisions ?? []) {
    const name = decision.spec.reviewItemName;
    if (decisionsByItem.has(name)) throw new Error(`ReviewItem ${name} has more than one decision; field states read one decision per item.`);
    decisionsByItem.set(name, decision);
  }
  const carriedByItem = new Map<string, DecisionCarryForward>();
  for (const raw of input.carryForwards ?? []) {
    const record = validateDecisionCarryForward(raw);
    if (carriedByItem.has(record.reviewItemName)) throw new Error(`ReviewItem ${record.reviewItemName} has more than one carried-forward decision.`);
    carriedByItem.set(record.reviewItemName, record);
  }
  const supersededDigests = new Set((input.supersessions ?? []).map((raw) => validateDecisionSupersession(raw).priorDecision.digest));
  const verifications = input.verifications;

  const states: FieldState[] = [];
  for (const entry of input.imports) {
    const record = validateExtractionEnvelopeImport(entry.record);
    const importName = record.metadata.name;
    const outcome = record.spec.envelope.result.outcome.status;
    const incompleteRun = outcome === "partial" || outcome === "failure";
    const unresolvedImport = record.status.state === "unresolved";
    const baseSignals = (excluded: number): FieldStateSignals => ({
      ...(incompleteRun ? { incompleteRun: true as const } : {}),
      ...(excluded > 0 ? { excludedProposals: excluded } : {}),
      ...(unresolvedImport ? { unresolvedImport: true as const } : {}),
    });

    const excludedBySlot = new Map<string, number>();
    for (const index of excerptMismatchProposalIndices(record)) {
      const key = slotKey(proposalSlot(record, index));
      excludedBySlot.set(key, (excludedBySlot.get(key) ?? 0) + 1);
    }
    const seen = new Set<string>();

    for (const item of buildReviewItemsFromExtractionEnvelopeImport(record)) {
      const slot = itemSlot(record, item);
      const key = slotKey(slot);
      seen.add(key);
      const lifecycle = lifecycleFor(item, decisionsByItem, carriedByItem, supersededDigests);
      states.push({
        importName,
        slot,
        reviewItemName: item.metadata.name,
        content: contentFor(item, verifications),
        ...lifecycle,
        signals: baseSignals(excludedBySlot.get(key) ?? 0),
      });
    }
    // A slot whose every proposal was excluded has no item; it still appears,
    // so a dropped proposal never vanishes from the field's record.
    for (const [key, count] of excludedBySlot) {
      if (seen.has(key)) continue;
      seen.add(key);
      const index = [...excerptMismatchProposalIndices(record)].find((proposalIndex) => slotKey(proposalSlot(record, proposalIndex)) === key)!;
      // Proposals were made, so the field was read: `excluded`, never `not_covered`.
      states.push({ importName, slot: proposalSlot(record, index), content: "excluded", signals: baseSignals(count) });
    }
    for (const expected of entry.expectedFields ?? []) {
      const slot = normalizeSlot(expected);
      const key = slotKey(slot);
      if (seen.has(key)) continue;
      seen.add(key);
      states.push({ importName, slot, ...(incompleteRun ? { content: "not_covered" as const } : {}), signals: baseSignals(0) });
    }
  }
  return states;
}

/** The lifecycle a workbench decision gives its item, as `deriveFieldStates` reads it. */
export function lifecycleForDecision(decision: ReviewDecision | undefined): Exclude<FieldLifecycleState, "superseded"> {
  if (!decision) return "pending";
  return decisionResolution(decision) ?? "pending";
}

/** The claim metadata the Surface projection carries for one field state. */
export function fieldStateClaimMetadata(state: FieldState): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ...(state.content !== undefined ? { content: state.content } : {}),
    ...(state.lifecycle !== undefined ? { lifecycle: state.lifecycle } : {}),
    ...(state.decisionBasis !== undefined ? { decisionBasis: state.decisionBasis } : {}),
    ...(Object.keys(state.signals).length ? { signals: { ...state.signals } } : {}),
  };
}

function lifecycleFor(
  item: ReviewItem,
  decisionsByItem: ReadonlyMap<string, ReviewDecision>,
  carriedByItem: ReadonlyMap<string, DecisionCarryForward>,
  supersededDigests: ReadonlySet<string>,
): Pick<FieldState, "lifecycle" | "decisionName" | "decisionBasis"> {
  const decision = decisionsByItem.get(item.metadata.name);
  if (decision) {
    const superseded = supersededDigests.has(decisionReference(decision).digest);
    return { lifecycle: superseded ? "superseded" : lifecycleForDecision(decision), decisionName: decision.metadata.name, decisionBasis: "affirmed" };
  }
  const carried = carriedByItem.get(item.metadata.name);
  if (carried) {
    if (carried.candidateId !== undefined && !item.spec.candidates.some((candidate) => candidate.id === carried.candidateId)) {
      throw new Error(`Carried-forward decision for ${item.metadata.name} names candidate ${carried.candidateId}, which the item does not hold.`);
    }
    const superseded = supersededDigests.has(carried.priorDecision.digest);
    return { lifecycle: superseded ? "superseded" : carried.resolution, decisionName: carried.priorDecision.name, decisionBasis: "carried-forward" };
  }
  return { lifecycle: "pending" };
}

function contentFor(item: ReviewItem, verifications: readonly CandidateVerification[] | undefined): FieldContentState {
  if (verifications !== undefined && item.spec.candidates.every((candidate) => candidateUnsupported(candidate, verifications))) return "unsupported";
  return item.spec.candidates.length > 1 ? "conflicting" : "value";
}

/** A candidate with a contradicted or not-addressed record for its current value, and no supported one. */
function candidateUnsupported(candidate: ReviewCandidate, verifications: readonly CandidateVerification[]): boolean {
  const { applicable } = foldCandidateVerifications({ candidateId: candidate.id, value: candidate.value }, verifications);
  const verdicts = applicable.filter((record) => record.result !== "abstain");
  return verdicts.length > 0 && verdicts.every((record) => record.result === "contradicted" || record.result === "not-addressed");
}

function itemSlot(record: ExtractionEnvelopeImport, item: ReviewItem): FieldSlot {
  const binding = item.metadata.producer?.["survey.kontourai.io/extraction-envelope"] as { proposalIndices?: number[] } | undefined;
  const first = binding?.proposalIndices?.[0];
  if (first === undefined) throw new Error(`ReviewItem ${item.metadata.name} carries no proposal binding.`);
  return proposalSlot(record, first);
}

function proposalSlot(record: ExtractionEnvelopeImport, index: number): FieldSlot {
  const target = record.spec.claimTargets[index]!;
  const proposal = record.spec.envelope.result.proposals[index]!;
  return normalizeSlot({
    subjectType: target.subjectType, subjectId: target.subjectId, facet: target.facet, claimType: target.claimType,
    fieldOrBehavior: target.fieldOrBehavior, ...(target.claimId !== undefined ? { claimId: target.claimId } : {}),
    ...(proposal.pathIndices !== undefined ? { pathIndices: proposal.pathIndices } : {}),
  });
}

function normalizeSlot(slot: FieldSlot): FieldSlot {
  for (const key of ["subjectType", "subjectId", "facet", "claimType", "fieldOrBehavior"] as const) {
    if (typeof slot[key] !== "string" || slot[key].trim() === "") throw new Error(`Field slot ${key} must be a non-empty string.`);
  }
  return {
    subjectType: slot.subjectType, subjectId: slot.subjectId, facet: slot.facet, claimType: slot.claimType, fieldOrBehavior: slot.fieldOrBehavior,
    ...(slot.claimId !== undefined ? { claimId: slot.claimId } : {}),
    ...(slot.pathIndices !== undefined ? { pathIndices: [...slot.pathIndices] } : {}),
  };
}

/** The same identity the importer groups a claim slot by. */
function slotKey(slot: FieldSlot): string {
  return canonicalJson({
    subjectType: slot.subjectType, subjectId: slot.subjectId, facet: slot.facet, claimType: slot.claimType,
    fieldOrBehavior: slot.fieldOrBehavior, claimId: slot.claimId ?? null, pathIndices: slot.pathIndices ?? null,
  });
}
