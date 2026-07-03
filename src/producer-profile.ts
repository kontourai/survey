/**
 * Producer Profile core — ADR 0003 §4, CONTEXT.md "Producer Profile".
 *
 * This module carries the shared scaffolding every Producer Profile
 * (inquiry-mapping, schema-mapping, and — from Slice 4 — agent-utterance)
 * needs to turn its own proposals into Survey's existing Candidate/Candidate
 * Set records: a generic proposal -> Candidate Set projection grouped by
 * target, the Candidate Conflict rule, and one canonical `Candidate.metadata`
 * key with a typed accessor, replacing each profile's hand-rolled projection,
 * conflict check, and `as`-cast metadata round-trip.
 *
 * This is a module-internal seam: its exports are consumed directly by
 * profile modules via relative import and are NOT re-exported from
 * `src/index.ts`.
 *
 * Hard constraint (ADR 0003 §4): this module never decides a review outcome
 * or a claim status. It only shapes proposal-backed Candidate/Candidate Set
 * records — every profile still routes its output through Survey's existing
 * review -> claim machinery unchanged.
 */

import type { Candidate, CandidateSet, CandidateSetStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Canonical proposal-metadata key
// ---------------------------------------------------------------------------

/**
 * The one canonical `Candidate.metadata` key every Producer Profile uses to
 * carry its profile-specific proposal payload. Replaces the per-profile keys
 * (`mappingProposal`, `schemaMappingProposal`) each profile used before
 * adopting this core module.
 */
export const PRODUCER_PROPOSAL_METADATA_KEY = "producerProposal" as const;

// ---------------------------------------------------------------------------
// Proposal shape
// ---------------------------------------------------------------------------

/**
 * One profile-adapted proposal, ready to be projected into a Candidate inside
 * a shared Candidate Set.
 */
export interface CandidateSetProposal<TValue = unknown, TMetadata = unknown> {
  /**
   * Caller-supplied, fully-formed Candidate id. Not templated by the core so
   * each profile keeps its own distinct id scheme byte-for-byte.
   */
  candidateId: string;
  /**
   * Caller-supplied, fully-formed Extraction id this proposal traces back to.
   * Not templated by the core for the same reason as `candidateId`.
   */
  extractionId: string;
  /** The proposed value, copied through to the projected Candidate verbatim. */
  value: TValue;
  /** Optional proposer confidence, copied through to the projected Candidate. */
  confidence?: number;
  /**
   * The Candidate Conflict comparison key. Required, and deliberately not
   * derived from `value` by the core, so each profile controls exactly what
   * "agrees" means for its own domain (e.g. a compound value may still be
   * considered equivalent under a narrower key than a full deep-compare).
   */
  equivalenceKey: string;
  /**
   * The profile's own payload, stored verbatim under
   * {@link PRODUCER_PROPOSAL_METADATA_KEY} on the projected Candidate's
   * `metadata`.
   */
  metadata: TMetadata;
}

// ---------------------------------------------------------------------------
// Candidate Conflict rule
// ---------------------------------------------------------------------------

/**
 * The shared Candidate Conflict rule: a group of proposals conflicts iff it
 * carries more than one distinct `equivalenceKey`. A group of 0 or 1
 * proposals can never conflict.
 */
export function hasCandidateConflict(proposals: Array<Pick<CandidateSetProposal, "equivalenceKey">>): boolean {
  return new Set(proposals.map((p) => p.equivalenceKey)).size > 1;
}

// ---------------------------------------------------------------------------
// Proposal -> Candidate Set projection
// ---------------------------------------------------------------------------

export interface ProjectProposalsToCandidateSetOptions {
  /** The id for the projected Candidate Set. */
  candidateSetId: string;
  /** Optional metadata to attach to the projected Candidate Set. */
  candidateSetMetadata?: Record<string, unknown>;
  /**
   * Optional rationale-builder for the projected Candidate Set, given the
   * computed status and the input proposals.
   */
  candidateSetRationale?: (status: CandidateSetStatus, proposals: CandidateSetProposal[]) => string | undefined;
}

/**
 * Build one Candidate Set (and its Candidates) from one target's proposal
 * group. Grouping proposals by target itself stays a caller concern — this
 * function projects exactly one group per call; it never reaches across
 * multiple targets on its own. `status` is `"conflict"` when
 * {@link hasCandidateConflict} is true for `proposals`, otherwise
 * `"needs-review"` (an empty `proposals` array yields `"needs-review"` with
 * an empty `candidates` array). `selectedCandidateId` is left unset — both
 * profiles compute it themselves, or not at all, per their own review flow.
 */
export function projectProposalsToCandidateSet<TValue = unknown, TMetadata = unknown>(
  target: string,
  proposals: Array<CandidateSetProposal<TValue, TMetadata>>,
  options: ProjectProposalsToCandidateSetOptions,
): { candidateSet: CandidateSet; candidates: Candidate[] } {
  const candidates: Candidate[] = proposals.map((proposal) => ({
    id: proposal.candidateId,
    extractionId: proposal.extractionId,
    value: proposal.value,
    confidence: proposal.confidence,
    metadata: {
      [PRODUCER_PROPOSAL_METADATA_KEY]: proposal.metadata,
    },
  }));

  const status: CandidateSetStatus = hasCandidateConflict(proposals) ? "conflict" : "needs-review";

  const candidateSet: CandidateSet = {
    id: options.candidateSetId,
    target,
    candidates,
    status,
    rationale: options.candidateSetRationale?.(status, proposals),
    metadata: options.candidateSetMetadata,
  };

  return { candidateSet, candidates };
}

// ---------------------------------------------------------------------------
// Typed proposal-metadata accessor
// ---------------------------------------------------------------------------

/**
 * Typed read-back of the proposal payload a Candidate carries under
 * {@link PRODUCER_PROPOSAL_METADATA_KEY}. Returns `undefined` if the
 * Candidate, its `metadata`, or the key itself is absent — never throws.
 *
 * No fallback reads of any legacy per-profile metadata key are performed
 * (Owner decision: no legacy support).
 */
export function getProducerProposal<TMetadata>(candidate: Candidate | undefined): TMetadata | undefined {
  return candidate?.metadata?.[PRODUCER_PROPOSAL_METADATA_KEY] as TMetadata | undefined;
}

// ---------------------------------------------------------------------------
// Shared auto-accept primitives
// ---------------------------------------------------------------------------

/**
 * Actor identity every Producer Profile's auto-accept policy uses when it
 * accepts a proposal without human review. Shared literal — see ADR 0003
 * §4 (the core never decides "verified"; auto-accept only ever produces
 * "assumed" + comfort-zone true).
 */
export const AUTO_ACCEPT_ACTOR = "auto-accept-policy" as const;

/**
 * The comfort-zone posture every Producer Profile's auto-accept policy
 * sets when it accepts a proposal: `withinComfortZone: true` always — an
 * auto-accepted proposal is, by definition, one the policy's declared
 * threshold covers, so there is nothing "outside comfort zone" about an
 * auto-accept decision (ADR 0003 §4).
 */
export const AUTO_ACCEPT_WITHIN_COMFORT_ZONE = true as const;

/**
 * The one auto-accept threshold rule every Producer Profile applies: a
 * confidence value clears an auto-accept policy iff it is at or above
 * (inclusive) the policy's minimum confidence.
 *
 * This is a low-level primitive used by {@link evaluateAutoAccept} below,
 * which is now the single place that decides the gate/rationale/`reviewedAt`
 * auto-accept policy for both profiles (see
 * `docs/decisions/producer-profile.md`, "Auto-accept policy unification").
 * What still stays entirely per-profile: output record shapes (e.g.
 * `InquiryMapping` vs. schema-mapping's inline `ReviewOutcome`), id
 * templates, and each profile's own selection/iteration algorithm for which
 * candidate's evidence gets passed into that decision.
 */
export function meetsAutoAcceptThreshold(confidence: number, minConfidence: number): boolean {
  return confidence >= minConfidence;
}

// ---------------------------------------------------------------------------
// Unified auto-accept decision
// ---------------------------------------------------------------------------

/**
 * The accepted-candidate-shaped evidence `evaluateAutoAccept` decides over.
 * Deliberately narrow: only the fields the auto-accept policy itself reads,
 * not a whole proposal/candidate shape, so any profile can adapt its own
 * proposal type into this without a dependency the other direction.
 */
export interface AutoAcceptEvidence {
  /**
   * The accepted evidence's OWN confidence — this is what gates AND what the
   * composed rationale cites (owner-accepted decisions 1 and 2 in
   * `docs/decisions/producer-profile.md`; fixes schema-mapping's pre-Slice-3
   * group-max-gate / selected-candidate-confidence-rationale mismatch).
   */
  confidence: number;
  /**
   * The evidence's own rationale, appended to the composed rationale when
   * present (decision 2; mirrors inquiry-mapping's pre-existing behavior).
   * Presence is decided with `!== undefined`, not truthiness, so an
   * empty-string rationale is still appended.
   */
  rationale?: string;
  /**
   * ISO 8601 timestamp of when this specific evidence was proposed (decision
   * 3). When absent, `evaluateAutoAccept` falls back to `fallbackTimestamp`
   * and reports that in `reviewedAtSource`.
   */
  proposedAt?: string;
}

/** The auto-accept policy `evaluateAutoAccept` gates against. */
export interface AutoAcceptPolicy {
  /** Minimum confidence (inclusive) a proposal must clear to auto-accept. */
  minConfidence: number;
}

/** The unified auto-accept decision `evaluateAutoAccept` returns. */
export interface AutoAcceptDecision {
  /** `true` iff there is no conflict and `evidence.confidence` clears `policy.minConfidence`. */
  accepted: boolean;
  /** The confidence value that was gated on (== `evidence.confidence`). */
  confidence: number;
  /** Composed rationale — always computed; callers only use it when `accepted`. */
  rationale: string;
  /** The resolved review timestamp — `evidence.proposedAt` when present, `fallbackTimestamp` otherwise. */
  reviewedAt: string;
  /** Which source `reviewedAt` came from. */
  reviewedAtSource: "proposedAt" | "fallback";
  /** Always `AUTO_ACCEPT_ACTOR`. */
  actor: typeof AUTO_ACCEPT_ACTOR;
  /** Always `AUTO_ACCEPT_WITHIN_COMFORT_ZONE`. */
  withinComfortZone: typeof AUTO_ACCEPT_WITHIN_COMFORT_ZONE;
}

/**
 * The one core auto-accept policy decision every Producer Profile delegates
 * to, per the owner-accepted semantics recorded in
 * `docs/decisions/producer-profile.md` ("Auto-accept policy unification"):
 *
 * 1. Gate on the accepted evidence's OWN confidence (not a group's), via
 *    {@link meetsAutoAcceptThreshold} — and never accept when `hasConflict`.
 * 2. Compose a rationale citing that same gate-clearing confidence, and
 *    append `evidence.rationale` when present (`!== undefined`).
 * 3. Stamp `reviewedAt` from `evidence.proposedAt` when present, falling
 *    back to `fallbackTimestamp` (and reporting which source was used via
 *    `reviewedAtSource`) when a profile's evidence carries no timestamp of
 *    its own.
 * 4. Always report `actor: AUTO_ACCEPT_ACTOR` and
 *    `withinComfortZone: AUTO_ACCEPT_WITHIN_COMFORT_ZONE` (ADR 0003 §4:
 *    auto-accept only ever yields "assumed" with the comfort-zone posture).
 *
 * This function decides the policy only — it never renders a review outcome
 * or claim-status record itself (ADR 0003 §4). Each profile still renders
 * its own distinct record shape (`InquiryMapping` vs. schema-mapping's
 * inline `ReviewOutcome`) from this decision's fields.
 */
export function evaluateAutoAccept(
  evidence: AutoAcceptEvidence,
  hasConflict: boolean,
  policy: AutoAcceptPolicy,
  fallbackTimestamp: string,
): AutoAcceptDecision {
  const accepted = !hasConflict && meetsAutoAcceptThreshold(evidence.confidence, policy.minConfidence);
  const rationale =
    `Auto-accepted: confidence ${evidence.confidence} >= threshold ${policy.minConfidence}.` +
    (evidence.rationale !== undefined ? ` ${evidence.rationale}` : "");
  const reviewedAt = evidence.proposedAt ?? fallbackTimestamp;

  return {
    accepted,
    confidence: evidence.confidence,
    rationale,
    reviewedAt,
    reviewedAtSource: evidence.proposedAt !== undefined ? "proposedAt" : "fallback",
    actor: AUTO_ACCEPT_ACTOR,
    withinComfortZone: AUTO_ACCEPT_WITHIN_COMFORT_ZONE,
  };
}
