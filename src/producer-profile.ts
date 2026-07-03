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
