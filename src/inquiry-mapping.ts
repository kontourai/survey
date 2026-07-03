/**
 * Inquiry mapping — ADR 0003 step 5.
 *
 * This module implements the "memoize the mapping, never the answer" principle.
 * A MappingProposal is a reviewable record produced by a pluggable MappingProposer.
 * Proposals flow through Survey's existing candidate → review machinery.
 * The durable artifact after review is an InquiryMapping.
 * Answers always recompute live from the TrustBundle.
 *
 * Nothing here silently decides. Exact canonical-form matching is the only thing
 * that resolves without review. A proposer may suggest that a question maps to a
 * registered claim or rule — but every suggestion lands as a MappingProposal with
 * provenance before it counts. (ADR 0003 §4)
 *
 * Integration point: resolveQuestion is the entry point for consumers checking
 * whether a cached mapping already covers a question. Flow-agent hook wiring
 * (connecting this to an agent's output pipeline) is out of scope for this module
 * and lives in the flow-agents repo.
 */

import type { DerivationRule, InquiryRecord, TrustBundle } from "@kontourai/surface";
import { resolveInquiry } from "@kontourai/surface";
import type { CanonicalClaimTarget } from "@kontourai/surface";
import type { Candidate, CandidateSet, ReviewOutcome } from "./types.js";
import {
  evaluateAutoAccept,
  getProducerProposal,
  hasCandidateConflict,
  projectProposalsToCandidateSet,
} from "./producer-profile.js";
import type { CandidateSetProposal } from "./producer-profile.js";
import type { ReviewItem } from "./review-resource.js";
import { reviewResourceApiVersion } from "./review-resource.js";

// ---------------------------------------------------------------------------
// Core proposal and mapping types
// ---------------------------------------------------------------------------

/**
 * A single machine- or human-generated suggestion that a natural-language
 * question maps to a canonical claim target or a named derivation rule.
 *
 * Exactly one of proposedTarget / proposedRuleId must be set.
 */
export interface MappingProposal {
  id: string;
  question: string;
  /** The canonical claim target this question is proposed to map to. */
  proposedTarget?: CanonicalClaimTarget;
  /** The derivation rule id this question is proposed to map to. */
  proposedRuleId?: string;
  /** Proposer confidence in the mapping (0–1). */
  confidence: number;
  /** Human-readable rationale for the proposal. */
  rationale: string;
  /** Optional verbatim excerpt from the question that drove the suggestion. */
  excerpt?: string;
  /** Who or what generated this proposal (name of the MappingProposer). */
  proposedBy: string;
  /** ISO 8601 timestamp. */
  proposedAt: string;
}

/**
 * The durable reviewed artifact: a natural-language question has been mapped
 * to a canonical claim target or derivation rule and the mapping has been
 * given a status through review (or auto-accept policy).
 *
 * Per ADR 0003 §6: memoize the mapping, never the answer.  Answers always
 * recompute from live claim status; this record is never updated to carry
 * a cached answer.
 */
export interface InquiryMapping {
  id: string;
  /** Deterministic normalized form of the question (see normalizeQuestion). */
  normalizedQuestion: string;
  /** The canonical claim target this mapping resolves to. */
  target?: CanonicalClaimTarget;
  /** The derivation rule id this mapping resolves to. */
  ruleId?: string;
  /** Whether the mapping was accepted by a human reviewer or auto-accept policy. */
  status: "verified" | "assumed" | "rejected";
  /** Actor who performed the review (reviewer id or "auto-accept-policy"). */
  reviewedBy: string;
  /** ISO 8601 timestamp of review. */
  reviewedAt: string;
  /** Optional rationale for the decision. */
  rationale?: string;
  /**
   * Whether the reviewer was within their declared comfort zone.
   * Mirrors Survey's withinComfortZone semantics: false means a different
   * authority should confirm; true (or absent) means the reviewer was
   * comfortable making this decision.
   */
  withinComfortZone?: boolean;
  /** The id of the MappingProposal that was accepted or rejected. */
  proposalId: string;
}

// ---------------------------------------------------------------------------
// Proposer interface
// ---------------------------------------------------------------------------

/**
 * Pluggable interface for proposing a canonical mapping for a question.
 *
 * Implementations may be deterministic (like the reference proposer below),
 * embedding-based, or LLM-backed — but they are always proposers: their output
 * goes through review before it counts (ADR 0003 §4).
 *
 * The interface accepts both synchronous return values and Promises, matching
 * Survey's async-optional style.
 */
export interface MappingProposer {
  name: string;
  propose(
    question: string,
    context: { bundle?: TrustBundle; rules?: DerivationRule[] },
  ): MappingProposal[] | Promise<MappingProposal[]>;
}

// ---------------------------------------------------------------------------
// Question normalization
// ---------------------------------------------------------------------------

/**
 * Deterministic normalization for question strings.
 *
 * Rules:
 * - Lowercase
 * - Collapse internal whitespace runs to a single space
 * - Trim leading/trailing whitespace
 * - Strip terminal punctuation (. ? ! , ;) from the end
 *
 * This is exact normalized-text memoization, not semantic matching.
 * Two questions that differ only in case, whitespace, or trailing punctuation
 * are considered the same question.  Questions with different wording but the
 * same intent are NOT matched here; a MappingProposer handles that.
 */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!,;]+$/u, "");
}

// ---------------------------------------------------------------------------
// Proposal → CandidateSet projection
// ---------------------------------------------------------------------------

/**
 * The full payload carried under `Candidate.metadata[PRODUCER_PROPOSAL_METADATA_KEY]`
 * for inquiry-mapping candidates. Read back via getProducerProposal.
 */
interface MappingProposalMetadata {
  proposalId: string;
  proposedTarget?: CanonicalClaimTarget;
  proposedRuleId?: string;
  confidence?: number;
  rationale?: string;
  excerpt?: string;
  proposedBy?: string;
  proposedAt?: string;
}

/**
 * The Candidate Conflict comparison key for a single mapping proposal: keys
 * by canonical claim target (subjectType/subjectId/fieldOrBehavior) or by
 * derivation rule id. Two proposals with the same key "agree"; more than one
 * distinct key across a group of proposals is a conflict (see
 * hasCandidateConflict).
 */
function mappingEquivalenceKey(proposal: MappingProposal): string {
  return proposal.proposedTarget
    ? `target:${proposal.proposedTarget.subjectType}/${proposal.proposedTarget.subjectId}/${proposal.proposedTarget.fieldOrBehavior}`
    : `rule:${proposal.proposedRuleId}`;
}

/**
 * Project an array of proposals for a single question into Survey's existing
 * Candidate / CandidateSet shapes so they flow through the existing review
 * machinery rather than a parallel system.
 *
 * Status rules:
 * - All proposals agree on the same target/ruleId → "needs-review"
 * - Proposals disagree (more than one distinct resolved target/rule) → "conflict"
 * - Empty proposals → "needs-review" with empty candidates
 *
 * The CandidateSet target is the normalized question; each Candidate carries
 * the proposal id as extractionId and the proposal metadata.
 */
export function proposalsToCandidateSet(
  question: string,
  proposals: MappingProposal[],
): { candidateSet: CandidateSet; candidates: Candidate[] } {
  const normalized = normalizeQuestion(question);

  const candidateSetProposals: CandidateSetProposal<unknown, MappingProposalMetadata>[] = proposals.map(
    (proposal) => ({
      candidateId: `mapping-candidate.${proposal.id}`,
      extractionId: proposal.id,
      value: proposal.proposedTarget ?? proposal.proposedRuleId ?? null,
      confidence: proposal.confidence,
      equivalenceKey: mappingEquivalenceKey(proposal),
      metadata: {
        proposalId: proposal.id,
        proposedTarget: proposal.proposedTarget,
        proposedRuleId: proposal.proposedRuleId,
        confidence: proposal.confidence,
        rationale: proposal.rationale,
        excerpt: proposal.excerpt,
        proposedBy: proposal.proposedBy,
        proposedAt: proposal.proposedAt,
      },
    }),
  );

  return projectProposalsToCandidateSet(normalized, candidateSetProposals, {
    candidateSetId: `mapping-candidate-set.${normalized}`,
    candidateSetMetadata: {
      inquiryMapping: {
        question,
        normalizedQuestion: normalized,
        kind: "inquiry-question",
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Review outcome → InquiryMapping
// ---------------------------------------------------------------------------

/**
 * Turn a Survey ReviewOutcome on a mapping candidate set into a durable
 * InquiryMapping record.
 *
 * The candidateSet must have been built by proposalsToCandidateSet.
 * The reviewOutcome's candidateId must match one of the candidates.
 */
export function applyMappingReview(
  candidateSet: CandidateSet,
  reviewOutcome: ReviewOutcome,
): InquiryMapping {
  const normalized = candidateSet.target;

  // Find the reviewed candidate
  const candidateId = reviewOutcome.candidateId ?? candidateSet.selectedCandidateId ?? candidateSet.candidates[0]?.id;
  const candidate = candidateSet.candidates.find((c) => c.id === candidateId);
  if (!candidate) {
    throw new Error(`applyMappingReview: no candidate found for id ${candidateId ?? "<none>"}`);
  }

  const meta = getProducerProposal<MappingProposalMetadata>(candidate);

  const proposalId = meta?.proposalId ?? candidate.extractionId;
  const status = reviewOutcome.status === "verified" || reviewOutcome.status === "assumed" || reviewOutcome.status === "rejected"
    ? reviewOutcome.status
    : "rejected";

  return {
    id: `inquiry-mapping.${normalized}`,
    normalizedQuestion: normalized,
    target: meta?.proposedTarget,
    ruleId: meta?.proposedRuleId,
    status: status as "verified" | "assumed" | "rejected",
    reviewedBy: reviewOutcome.actor ?? "unknown",
    reviewedAt: reviewOutcome.reviewedAt ?? new Date().toISOString(),
    rationale: reviewOutcome.rationale,
    withinComfortZone: reviewOutcome.withinComfortZone,
    proposalId,
  };
}

// ---------------------------------------------------------------------------
// Auto-accept policy
// ---------------------------------------------------------------------------

export interface AutoAcceptPolicy {
  minConfidence: number;
}

/**
 * Apply an auto-accept policy to a list of proposals, returning InquiryMappings.
 *
 * Proposals at or above minConfidence → status "assumed", withinComfortZone: true
 * Proposals below minConfidence → return a "needs-review" mapping (not yet durable)
 *
 * Only non-conflicting proposals are auto-accepted. If proposals disagree, they
 * need human review regardless of confidence.
 *
 * Returns an array of InquiryMappings (only for accepted proposals).
 */
export function applyAutoAcceptPolicy(
  proposals: MappingProposal[],
  policy: AutoAcceptPolicy,
): InquiryMapping[] {
  if (proposals.length === 0) return [];

  // If proposals disagree, none can be auto-accepted
  if (hasCandidateConflict(proposals.map((p) => ({ equivalenceKey: mappingEquivalenceKey(p) })))) return [];

  return proposals.flatMap((proposal) => {
    const decision = evaluateAutoAccept(
      { confidence: proposal.confidence, rationale: proposal.rationale, proposedAt: proposal.proposedAt },
      false,
      policy,
      proposal.proposedAt,
    );
    if (!decision.accepted) return [];
    return [
      {
        id: `inquiry-mapping.auto.${normalizeQuestion(proposal.question)}`,
        normalizedQuestion: normalizeQuestion(proposal.question),
        target: proposal.proposedTarget,
        ruleId: proposal.proposedRuleId,
        status: "assumed" as const,
        reviewedBy: decision.actor,
        reviewedAt: decision.reviewedAt,
        rationale: decision.rationale,
        withinComfortZone: decision.withinComfortZone,
        proposalId: proposal.id,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Mapping lookup
// ---------------------------------------------------------------------------

/**
 * Look up an InquiryMapping for a question by exact normalized-text match.
 *
 * Rejected mappings are remembered but never resolve: this function returns
 * undefined for rejected mappings so callers treat the question as a miss.
 * To check whether a question was previously rejected (and should not be
 * re-proposed), call lookupRejectedMapping.
 */
export function lookupMapping(
  mappings: InquiryMapping[],
  question: string,
): InquiryMapping | undefined {
  const normalized = normalizeQuestion(question);
  const match = mappings.find((m) => m.normalizedQuestion === normalized);
  if (!match) return undefined;
  // Rejected mappings are remembered but never resolve
  if (match.status === "rejected") return undefined;
  return match;
}

/**
 * Check whether a question was previously rejected.
 * Rejected mappings prevent re-proposing: if this returns a mapping, the
 * question should not be sent to a proposer again without human escalation.
 */
export function lookupRejectedMapping(
  mappings: InquiryMapping[],
  question: string,
): InquiryMapping | undefined {
  const normalized = normalizeQuestion(question);
  return mappings.find((m) => m.normalizedQuestion === normalized && m.status === "rejected");
}

// ---------------------------------------------------------------------------
// Live question resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a natural-language question against a TrustBundle.
 *
 * On mapping hit (verified or assumed): constructs a Surface Inquiry from the
 * mapped target/rule and returns resolveInquiry(...) — answers always recompute
 * live from the current bundle state; the mapping is memoized, not the answer.
 *
 * On miss (no mapping, or rejected mapping): returns an InquiryRecord with
 * outcome "unsupported" so the gap is honest and recordable.
 *
 * This function is the clean integration point for consumers. Flow-agent hook
 * wiring (connecting this to an agent's output pipeline) lives in the
 * flow-agents repo.
 */
export function resolveQuestion(
  bundle: TrustBundle,
  question: string,
  options: {
    mappings: InquiryMapping[];
    rules?: DerivationRule[];
    now?: Date;
    askedBy: string;
  },
): InquiryRecord {
  const { mappings, rules, now, askedBy } = options;
  const normalized = normalizeQuestion(question);
  const mapping = lookupMapping(mappings, question);

  const askedAt = (now ?? new Date()).toISOString();
  const inquiryId = `inquiry.${normalized}.${askedAt}`;

  if (!mapping) {
    // No mapping or rejected: return honest unsupported record
    return {
      id: inquiryId,
      inquiry: {
        id: inquiryId,
        question,
        askedBy,
        askedAt,
      },
      outcome: "unsupported",
      resolutionPath: { claimIds: [] },
      inputSnapshot: [],
      statusFunctionVersion: "1",
      resolvedAt: askedAt,
    };
  }

  // Build a Surface Inquiry from the mapping
  const inquiry = {
    id: inquiryId,
    question,
    target: mapping.target,
    askedBy,
    askedAt,
    metadata: {
      inquiryMappingId: mapping.id,
      normalizedQuestion: normalized,
    },
  };

  return resolveInquiry(bundle, inquiry, { now, rules });
}

// ---------------------------------------------------------------------------
// Review workbench integration
// ---------------------------------------------------------------------------

/**
 * Build ReviewItem records for the existing review workbench from a list of
 * mapping candidate sets.
 *
 * Follow the existing ReviewItem contract exactly. This helper produces
 * ReviewItem payloads so mapping proposals can be reviewed through the same
 * workbench as other Survey candidates.
 */
export function buildMappingReviewItems(
  candidateSets: Array<{ candidateSet: CandidateSet; candidates: Candidate[] }>,
): ReviewItem[] {
  return candidateSets.map(({ candidateSet, candidates }) => ({
    apiVersion: reviewResourceApiVersion,
    kind: "ReviewItem" as const,
    metadata: {
      name: candidateSet.id,
      labels: { "survey.kontourai.io/kind": "inquiry-mapping" },
    },
    spec: {
      target: candidateSet.target,
      candidates: candidates.map((candidate) => {
        const meta = getProducerProposal<MappingProposalMetadata>(candidate);

        const targetOrRule = meta?.proposedTarget
          ? `${meta.proposedTarget.subjectType}/${meta.proposedTarget.subjectId}/${meta.proposedTarget.fieldOrBehavior}`
          : `rule:${meta?.proposedRuleId ?? "unknown"}`;

        return {
          id: candidate.id,
          role: "proposed" as const,
          value: candidate.value,
          confidence: candidate.confidence,
          source: {
            sourceRef: `inquiry-question:${candidateSet.target}`,
            kind: "inquiry-question" as const,
            observedAt: meta?.proposedAt ?? new Date().toISOString(),
            locatorScheme: "text" as const,
          },
          extraction: {
            target: targetOrRule,
            confidence: meta?.confidence,
            extractor: meta?.proposedBy ?? "unknown",
            extractedAt: meta?.proposedAt ?? new Date().toISOString(),
          },
          claimTarget: {
            subjectType: meta?.proposedTarget?.subjectType ?? "inquiry",
            subjectId: meta?.proposedTarget?.subjectId ?? candidateSet.target,
            facet: "inquiry.mapping",
            claimType: "inquiry-mapping",
            fieldOrBehavior: meta?.proposedTarget?.fieldOrBehavior ?? meta?.proposedRuleId ?? "unknown",
            impactLevel: "low" as const,
          },
          projection: {
            candidateSetId: candidateSet.id,
            candidateId: candidate.id,
          },
        };
      }),
      candidateSetStatus: candidateSet.status,
      rationale: candidateSet.rationale,
    },
    status: {
      observedCandidateCount: candidates.length,
    },
  }));
}

// ---------------------------------------------------------------------------
// Reference proposer (deterministic, for tests — not for production use)
// ---------------------------------------------------------------------------

/**
 * Reference MappingProposer for tests.
 *
 * REFERENCE IMPLEMENTATION ONLY — not suitable for production matching.
 *
 * Matching strategy: a question maps to a claim if it contains both the
 * claim's subjectId and fieldOrBehavior as token substrings (case-insensitive,
 * space-delimited token match). This is intentionally simple and transparent
 * so tests can be deterministic.
 */
export const referenceMappingProposer: MappingProposer = {
  name: "reference-mapping-proposer",
  propose(question: string, context: { bundle?: TrustBundle; rules?: DerivationRule[] }): MappingProposal[] {
    const q = question.toLowerCase();
    const proposals: MappingProposal[] = [];
    const now = new Date().toISOString();

    if (context.bundle) {
      for (const claim of context.bundle.claims) {
        const subjectTokens = claim.subjectId.toLowerCase().split(/[\s\-_.:/]+/);
        const fieldTokens = claim.fieldOrBehavior.toLowerCase().split(/[\s\-_.:/]+/);
        const subjectMatch = subjectTokens.some((tok) => tok.length > 2 && q.includes(tok));
        const fieldMatch = fieldTokens.some((tok) => tok.length > 2 && q.includes(tok));
        if (subjectMatch && fieldMatch) {
          const proposalId = `proposal.ref.${claim.subjectId}.${claim.fieldOrBehavior}.${Date.now()}`;
          proposals.push({
            id: proposalId,
            question,
            proposedTarget: {
              subjectType: claim.subjectType,
              subjectId: claim.subjectId,
              fieldOrBehavior: claim.fieldOrBehavior,
              qualifiers: claim.qualifiers,
            },
            confidence: 0.75,
            rationale: `Reference proposer: question contains subjectId token and fieldOrBehavior token for claim ${claim.id}.`,
            proposedBy: "reference-mapping-proposer",
            proposedAt: now,
          });
        }
      }
    }

    if (context.rules) {
      for (const rule of context.rules) {
        const ruleTokens = rule.name.toLowerCase().split(/[\s\-_.:/]+/);
        const ruleMatch = ruleTokens.some((tok) => tok.length > 2 && q.includes(tok));
        if (ruleMatch) {
          const proposalId = `proposal.ref.rule.${rule.id}.${Date.now()}`;
          proposals.push({
            id: proposalId,
            question,
            proposedRuleId: rule.id,
            confidence: 0.65,
            rationale: `Reference proposer: question contains rule name token for rule ${rule.id}.`,
            proposedBy: "reference-mapping-proposer",
            proposedAt: now,
          });
        }
      }
    }

    return proposals;
  },
};
