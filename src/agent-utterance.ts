/**
 * Agent-utterance producer profile — ADR 0003 step 6.
 *
 * This module implements Survey as a producer pointed at agent utterances
 * instead of web sources. Each factual statement in agent prose is extracted
 * as a candidate claim and run through the Inquiry pipeline.
 *
 * Integration point: surveyAgentUtterance is the clean entry point for
 * consumers wanting to "spell-check" an agent's output for evidence. Flow-agent
 * hook wiring (connecting this function to a live agent's output pipeline) is
 * out of scope for this module and lives in the flow-agents repo.
 *
 * Hard constraint (ADR 0003 §4): nothing here silently decides. The
 * UtteranceClaimExtractor is a pluggable interface; implementations may be
 * deterministic or model-backed, but they are always extractors — their output
 * has full provenance (excerpt, span, extractor name, confidence) and is
 * run through the Inquiry pipeline rather than treated as authoritative.
 */

import type { DerivationRule, InquiryRecord, TrustBundle } from "@kontourai/surface";
import { resolveInquiry } from "@kontourai/surface";
import type { CanonicalClaimTarget } from "@kontourai/surface";
import type { Candidate, CandidateSet, ClaimTarget, Extraction, RawSource, SurveyInput } from "./types.js";
import type { InquiryMapping } from "./inquiry-mapping.js";
import { lookupMapping, resolveQuestion } from "./inquiry-mapping.js";
import { projectProposalsToCandidateSet } from "./producer-profile.js";
import type { CandidateSetProposal } from "./producer-profile.js";

// ---------------------------------------------------------------------------
// Extractor interface
// ---------------------------------------------------------------------------

/**
 * A single extracted statement from an utterance.
 */
export interface ExtractedStatement {
  /** The canonical claim target this statement is about. */
  target: CanonicalClaimTarget;
  /** The value claimed (if parseable). */
  value?: unknown;
  /** The verbatim text segment that contains this claim. */
  excerpt: string;
  /** Character-offset span within the utterance (0-indexed). */
  span?: { start: number; end: number };
  /** Extractor confidence (0–1). */
  confidence: number;
}

/**
 * Pluggable interface for extracting canonical claim statements from
 * agent-generated text.
 *
 * Implementations may be deterministic (like the reference extractor below),
 * regex-based, NLP-based, or LLM-backed — but they are always extractors:
 * their output carries full provenance and goes through the Inquiry pipeline
 * rather than being treated as an authoritative answer.
 */
export interface UtteranceClaimExtractor {
  name: string;
  extract(utterance: string): ExtractedStatement[] | Promise<ExtractedStatement[]>;
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/**
 * Badge values for each extracted statement, derived from the inquiry outcome
 * and the answer status.
 *
 * - "verified": inquiry matched/derived and answer status is "verified"
 * - "assumed": inquiry matched/derived and answer status is "assumed"
 * - "stale": inquiry matched/derived and answer status is "stale"
 * - "disputed": inquiry matched/derived and answer status is "disputed"
 * - "rejected": inquiry matched/derived and answer status is "rejected"
 * - "unsupported": inquiry outcome is "unsupported" (no mapping or no registered claim)
 */
export type StatementBadge = "verified" | "assumed" | "stale" | "disputed" | "rejected" | "unsupported";

export interface UtteranceStatement {
  excerpt: string;
  span?: { start: number; end: number };
  target: CanonicalClaimTarget;
  inquiryRecord: InquiryRecord;
  badge: StatementBadge;
}

/**
 * The result of surveying an agent utterance.
 *
 * source: the RawSource representing the utterance (kind: "agent-utterance").
 * statements: per-statement verdicts, each with full provenance.
 *
 * This is the "spell-check for evidence" projection. Flow-agent hook wiring
 * is out of scope for this module (lives in flow-agents repo).
 */
export interface UtteranceTrustReport {
  source: RawSource;
  statements: UtteranceStatement[];
}

// ---------------------------------------------------------------------------
// Internal Survey record types for utterance projection
// ---------------------------------------------------------------------------

/**
 * Full set of Survey records generated for a single extracted statement.
 * These are produced for provenance but not projected to Surface directly —
 * the report is the consumer-facing artifact.
 */
export interface UtteranceStatementRecords {
  extraction: Extraction;
  candidate: Candidate;
  candidateSet: CandidateSet;
}

/**
 * The Candidate Conflict comparison key for an utterance-proposed value.
 *
 * Neither extractor (the reference extractor below, nor the Anthropic-backed
 * one in `./anthropic.js`) normalizes `value` before it reaches
 * `ExtractedStatement` — case and internal formatting are preserved
 * verbatim. String values are the only case where "representation noise"
 * (leading/trailing whitespace from excerpt boundaries, incidental case
 * differences like "Healthy" vs "healthy") is plausible given the two
 * extractors' actual output, so this key trims + lowercases STRING values
 * in the COMPARISON KEY ONLY — the stored `Candidate.value`/`Extraction.value`
 * stay byte-for-byte verbatim; this function only feeds `equivalenceKey`,
 * never `value`. Non-string values (number, boolean, null — the other types
 * the Anthropic tool schema permits) compare via exact canonical
 * `JSON.stringify`, so there is no cross-type coercion that could silently
 * equate e.g. "5" and 5, or lose a genuine numeric disagreement (5 vs 6 is
 * never noise). This mirrors the Producer Profile core's established
 * pattern: each profile decides its own narrow equivalence definition
 * (see `./producer-profile.js`); the core itself does not own this decision.
 */
function utteranceEquivalenceKey(value: unknown): string {
  const normalized = value ?? null;
  if (typeof normalized === "string") {
    return `str:${normalized.trim().toLowerCase()}`;
  }
  return `json:${JSON.stringify(normalized)}`;
}

/**
 * The profile-specific payload every utterance-sourced Candidate carries
 * under the Producer Profile core's canonical `producerProposal` metadata
 * key (`PRODUCER_PROPOSAL_METADATA_KEY`), read back via `getProducerProposal`.
 */
interface UtteranceProposalMetadata {
  span?: { start: number; end: number };
  excerpt: string;
  extractorName: string;
  confidence: number;
}

interface BuildUtteranceExtractionParams {
  sourceId: string;
  idx: number;
  statement: ExtractedStatement;
  utterance: string;
  extractorName: string;
  observedAt: string;
}

interface UtteranceExtractionAndProposal {
  extraction: Extraction;
  proposal: CandidateSetProposal<unknown, UtteranceProposalMetadata>;
}

/**
 * Build the Extraction and CandidateSetProposal for a single extracted
 * statement. This centralizes the Source Locator rule (span-first,
 * excerpt-fallback — the single locator rule this module guarantees) and
 * hands the resulting proposal off to `groupUtteranceExtractionsByTarget`
 * for per-target projection through the Producer Profile core.
 */
function buildUtteranceExtraction(params: BuildUtteranceExtractionParams): UtteranceExtractionAndProposal {
  const { sourceId, idx, statement, utterance, extractorName, observedAt } = params;
  const statementId = `${sourceId}.statement.${idx}`;
  const extractionId = `${statementId}.extraction`;
  const candidateId = `${statementId}.candidate`;

  // Compute locator — required for non-manual-entry sources
  // (assertProducerDiscipline throws without it). Source Locator rule:
  // span-first, excerpt-fallback — UNCHANGED from Slice 1.
  const locator = spanToLocator(statement.span) ?? excerptLocator(utterance, statement.excerpt);

  const extraction: Extraction = {
    id: extractionId,
    sourceId,
    target: canonicalTargetKey(statement.target),
    value: statement.value ?? null,
    confidence: statement.confidence,
    locator,
    excerpt: statement.excerpt,
    extractor: extractorName,
    extractedAt: observedAt,
    metadata: {
      agentUtterance: {
        span: statement.span,
        excerpt: statement.excerpt,
        extractorName,
        confidence: statement.confidence,
      },
    },
  };

  const proposal: CandidateSetProposal<unknown, UtteranceProposalMetadata> = {
    candidateId,
    extractionId,
    value: statement.value ?? null,
    confidence: statement.confidence,
    equivalenceKey: utteranceEquivalenceKey(statement.value),
    metadata: {
      span: statement.span,
      excerpt: statement.excerpt,
      extractorName,
      confidence: statement.confidence,
    },
  };

  return { extraction, proposal };
}

/** One target group's projected Candidate Set plus its own Candidates. */
interface UtteranceCandidateSetGroup {
  targetKey: string;
  candidateSet: CandidateSet;
  candidates: Candidate[];
}

/**
 * Group extraction/proposal pairs by canonical target and project each
 * group through the Producer Profile core's `projectProposalsToCandidateSet`
 * — one Candidate Set per target, carrying every statement's Candidate for
 * that target. Status is `"conflict"` when the group's statements disagree
 * under `utteranceEquivalenceKey`, `"needs-review"` otherwise (including the
 * common single-statement case, which reproduces Slice 1's exact prior
 * per-statement behavior).
 *
 * `Map` preserves insertion order, so the returned groups (and therefore the
 * `candidateSets` array `buildUtteranceRecords` derives from them) are in
 * deterministic first-occurrence-of-target order across the utterance's
 * statements.
 */
function groupUtteranceExtractionsByTarget(
  sourceId: string,
  items: Array<{
    statement: ExtractedStatement;
    extraction: Extraction;
    proposal: CandidateSetProposal<unknown, UtteranceProposalMetadata>;
  }>,
): Map<string, UtteranceCandidateSetGroup> {
  const order: string[] = [];
  const byTarget = new Map<string, typeof items>();
  for (const item of items) {
    const key = canonicalTargetKey(item.statement.target);
    if (!byTarget.has(key)) {
      byTarget.set(key, []);
      order.push(key);
    }
    byTarget.get(key)!.push(item);
  }

  const groups = new Map<string, UtteranceCandidateSetGroup>();
  for (const targetKey of order) {
    const groupItems = byTarget.get(targetKey)!;
    const first = groupItems[0]!.statement.target;
    const proposals = groupItems.map((i) => i.proposal);

    const { candidateSet, candidates } = projectProposalsToCandidateSet(targetKey, proposals, {
      candidateSetId: `${sourceId}.target.${targetKey}.candidate-set`,
      candidateSetMetadata: {
        agentUtterance: {
          target: {
            subjectType: first.subjectType,
            subjectId: first.subjectId,
            fieldOrBehavior: first.fieldOrBehavior,
          },
          statementCount: proposals.length,
        },
      },
      candidateSetRationale: (status, groupProposals) =>
        status === "conflict"
          ? `${groupProposals.length} statement(s) disagree for ${targetKey}: ${[...new Set(groupProposals.map((p) => p.equivalenceKey))].join(", ")}`
          : `${groupProposals.length} statement(s) agree for ${targetKey}.`,
    });
    // Mirrors schema-mapping's post-core convention: a winner only exists
    // when the group agrees; a conflicting group has no selected candidate
    // yet (nothing to select — that's the point of a Candidate Conflict,
    // CONTEXT.md's "Candidate Conflict" entry). For a single-statement group
    // this reproduces Slice 1's exact old behavior (selectedCandidateId ===
    // the one candidate's id).
    candidateSet.selectedCandidateId = candidateSet.status !== "conflict" ? candidates[0]?.id : undefined;

    groups.set(targetKey, { targetKey, candidateSet, candidates });
  }

  return groups;
}

interface BuildUtteranceRecordsParams {
  sourceId: string;
  utterance: string;
  extracted: ExtractedStatement[];
  extractorName: string;
  observedAt: string;
}

interface UtteranceRecordsResult {
  records: UtteranceStatementRecords[];
  extractions: Extraction[];
  candidateSets: CandidateSet[];
}

/**
 * Build the full set of Survey records for every extracted statement in one
 * utterance: per-statement Extractions/Candidates plus per-target grouped
 * Candidate Sets. This is the shared orchestrator both `utteranceToSurveyInput`
 * and `surveyAgentUtterance` call, so both callers derive these records
 * identically — Slice 1's "single derivation path" invariant, preserved.
 *
 * `records[idx]` corresponds to `extracted[idx]` for every idx — `items` and
 * `records` are both built via `.map` over the same `extracted[]` array in
 * the same order; only `candidateSets` is deduped/grouped by target.
 */
export function buildUtteranceRecords(params: BuildUtteranceRecordsParams): UtteranceRecordsResult {
  const { sourceId, utterance, extracted, extractorName, observedAt } = params;

  const items = extracted.map((statement, idx) => {
    const { extraction, proposal } = buildUtteranceExtraction({
      sourceId,
      idx,
      statement,
      utterance,
      extractorName,
      observedAt,
    });
    return { statement, extraction, proposal };
  });

  const groups = groupUtteranceExtractionsByTarget(sourceId, items);

  const records: UtteranceStatementRecords[] = items.map((item) => {
    const group = groups.get(canonicalTargetKey(item.statement.target))!;
    const candidate = group.candidates.find((c) => c.id === item.proposal.candidateId)!;
    return { extraction: item.extraction, candidate, candidateSet: group.candidateSet };
  });

  return {
    records,
    extractions: items.map((i) => i.extraction),
    candidateSets: [...groups.values()].map((g) => g.candidateSet),
  };
}

// ---------------------------------------------------------------------------
// SurveyInput projection
// ---------------------------------------------------------------------------

/**
 * Project an agent utterance and its extracted statements into the standard
 * SurveyInput shape so they can flow into buildSurveyTrustBundle.
 *
 * Each extracted statement lands as:
 *   RawSource (agent-utterance) → Extraction (with text-span locator) →
 *   Candidate → CandidateSet (needs-review, no review outcome) → ClaimTarget
 *
 * Status discipline (ADR 0003 §4, to-surface.ts producer rules):
 * - All claims project as "proposed" — unreviewed extractions are proposals,
 *   never authoritative. assertProducerDiscipline forbids verified/assumed
 *   without a review outcome.
 * - agent-utterance is not a manual-entry source, so extraction.locator is
 *   required. Span-located statements use text-span:start-end; span-less
 *   statements use text-span derived from the excerpt offset in the utterance
 *   (best-effort, 0-based).
 *
 * The returned SurveyInput can be passed directly to buildSurveyTrustBundle
 * to produce a TrustBundle with full provenance in the Trust Bundle metadata.
 *
 * @param utterance - The raw agent utterance text.
 * @param extracted - ExtractedStatements produced by a UtteranceClaimExtractor.
 * @param context - agentId, extractor name, optional now timestamp.
 */
export function utteranceToSurveyInput(
  utterance: string,
  extracted: ExtractedStatement[],
  context: {
    agentId: string;
    extractorName: string;
    now?: Date;
    source?: string;
  },
): SurveyInput {
  const { agentId, extractorName, now } = context;
  const observedAt = (now ?? new Date()).toISOString();
  const source = context.source ?? `agent-utterance:${agentId}`;

  // One shared RawSource for the entire utterance
  const sourceId = `agent-utterance:${agentId}:${observedAt}`;
  const rawSource: RawSource = {
    id: sourceId,
    kind: "agent-utterance",
    sourceRef: `agent-utterance://${agentId}/${observedAt}`,
    observedAt,
    locatorScheme: "text-span",
    inlineText: utterance,
    metadata: { agentId },
  };

  // Batched, per-target-grouped provenance construction (Producer Profile
  // core) — replaces the old per-statement builder call. Claims below stay
  // one-per-statement; `record.candidateSet.id`/`record.candidate.id` may be
  // shared across several claims when statements share a target (legal).
  const { records, extractions, candidateSets } = buildUtteranceRecords({
    sourceId,
    utterance,
    extracted,
    extractorName,
    observedAt,
  });

  const claims: ClaimTarget[] = extracted.map((statement, idx) => {
    const statementId = `${sourceId}.statement.${idx}`;
    const claimId = `${statementId}.claim`;
    const record = records[idx]!;

    // Unreviewed: status is omitted so statusFor() computes "proposed" (or
    // "disputed" for a claim whose shared candidateSet.status is "conflict").
    // assertProducerDiscipline: no verified/assumed without review → compliant.
    return {
      id: claimId,
      candidateSetId: record.candidateSet.id,
      candidateId: record.candidate.id,
      subjectType: statement.target.subjectType,
      subjectId: statement.target.subjectId,
      facet: "agent-utterance.profile",
      claimType: "agent-extraction",
      fieldOrBehavior: statement.target.fieldOrBehavior,
      value: statement.value,
      // status intentionally omitted → computed by statusFor
      impactLevel: "low",
      collectedBy: extractorName,
      metadata: {
        survey: {
          agentUtterance: {
            agentId,
            extractorName,
            excerpt: statement.excerpt,
            span: statement.span,
            confidence: statement.confidence,
            locator: record.extraction.locator,
          },
        },
      },
    };
  });

  return {
    source,
    generatedAt: observedAt,
    rawSources: [rawSource],
    extractions,
    candidateSets,
    reviewOutcomes: [],
    claims,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Survey an agent utterance, returning a trust report for each extracted claim.
 *
 * Steps:
 * 1. Build a RawSource for the utterance (kind: "agent-utterance").
 * 2. Run the extractor → project each statement into Survey records with full
 *    provenance (excerpt, span locator, extractor name, confidence).
 * 3. Resolve each extracted claim against the bundle via resolveInquiry or
 *    resolveQuestion (if mappings are provided).
 * 4. Return an UtteranceTrustReport with per-statement badges.
 *
 * This function is the integration point for consumers. Flow-agent hook wiring
 * lives in the flow-agents repo.
 */
export async function surveyAgentUtterance(
  utterance: string,
  extractor: UtteranceClaimExtractor,
  context: {
    bundle: TrustBundle;
    mappings?: InquiryMapping[];
    rules?: DerivationRule[];
    now?: Date;
    agentId: string;
  },
): Promise<UtteranceTrustReport> {
  const { bundle, mappings, rules, now, agentId } = context;
  const observedAt = (now ?? new Date()).toISOString();

  // Step 1: Build a RawSource for this utterance
  const sourceId = `agent-utterance:${agentId}:${observedAt}`;
  const source: RawSource = {
    id: sourceId,
    kind: "agent-utterance",
    sourceRef: `agent-utterance://${agentId}/${observedAt}`,
    observedAt,
    locatorScheme: "text-span",
    inlineText: utterance,
    metadata: { agentId },
  };

  // Step 2: Extract statements
  const extracted = await Promise.resolve(extractor.extract(utterance));

  // Batched, grouped provenance construction — kept for provenance/doc-comment
  // fidelity across the whole utterance (grouping needs every statement of a
  // target's group present at once; a per-statement call cannot compute it).
  // Still not surfaced on UtteranceStatement/UtteranceTrustReport this slice
  // (unchanged from Slice 1's own scoping note) — wiring is left for a future
  // slice, same as before.
  buildUtteranceRecords({
    sourceId,
    utterance,
    extracted,
    extractorName: extractor.name,
    observedAt,
  });

  // Step 3 & 4: Resolve each statement and build the report
  const statements: UtteranceStatement[] = [];

  for (const statement of extracted) {
    // Resolve the claim
    let inquiryRecord: InquiryRecord;

    if (mappings && mappings.length > 0) {
      // If we have question-level mappings, check them first by building
      // a question from the target
      const syntheticQuestion = targetToQuestion(statement.target);
      const mapping = lookupMapping(mappings, syntheticQuestion);
      if (mapping) {
        inquiryRecord = resolveQuestion(bundle, syntheticQuestion, {
          mappings,
          rules,
          now,
          askedBy: agentId,
        });
      } else {
        // No mapping: resolve directly by canonical target
        inquiryRecord = resolveByTarget(bundle, statement.target, agentId, observedAt, rules, now);
      }
    } else {
      // Resolve directly by canonical target
      inquiryRecord = resolveByTarget(bundle, statement.target, agentId, observedAt, rules, now);
    }

    const badge = badgeFromRecord(inquiryRecord);

    statements.push({
      excerpt: statement.excerpt,
      span: statement.span,
      target: statement.target,
      inquiryRecord,
      badge,
    });
  }

  return { source, statements };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveByTarget(
  bundle: TrustBundle,
  target: CanonicalClaimTarget,
  askedBy: string,
  askedAt: string,
  rules?: DerivationRule[],
  now?: Date,
): InquiryRecord {
  const id = `inquiry.direct.${canonicalTargetKey(target)}.${askedAt}`;
  const inquiry = {
    id,
    question: targetToQuestion(target),
    target,
    askedBy,
    askedAt,
  };
  return resolveInquiry(bundle, inquiry, { now, rules });
}

function canonicalTargetKey(target: CanonicalClaimTarget): string {
  return `${target.subjectType}/${target.subjectId}/${target.fieldOrBehavior}`;
}

function targetToQuestion(target: CanonicalClaimTarget): string {
  return `${target.subjectId} ${target.fieldOrBehavior}`;
}

function badgeFromRecord(record: InquiryRecord): StatementBadge {
  if (record.outcome === "unsupported") return "unsupported";
  const status = record.answer?.status;
  if (!status) return "unsupported";
  if (status === "verified") return "verified";
  if (status === "assumed") return "assumed";
  if (status === "stale") return "stale";
  if (status === "disputed") return "disputed";
  if (status === "rejected" || status === "superseded") return "rejected";
  return "unsupported";
}

/**
 * Convert a text-span to a locator string.
 */
function spanToLocator(span?: { start: number; end: number }): string | undefined {
  if (!span) return undefined;
  return `text-span:${span.start}-${span.end}`;
}

/**
 * Best-effort locator from excerpt text — find the first occurrence of the
 * excerpt in the utterance and use that as a text-span locator.
 * Falls back to text-span:0-0 if the excerpt is not found.
 */
function excerptLocator(utterance: string, excerpt: string): string {
  const idx = utterance.indexOf(excerpt);
  if (idx >= 0) {
    return `text-span:${idx}-${idx + excerpt.length}`;
  }
  // Fallback: anchor to start (preserves discipline contract; locator is
  // best-effort for span-less extractors)
  return `text-span:0-${excerpt.length}`;
}

// ---------------------------------------------------------------------------
// Reference extractor (deterministic, for tests — not for production use)
// ---------------------------------------------------------------------------

/**
 * Reference UtteranceClaimExtractor for tests.
 *
 * REFERENCE IMPLEMENTATION ONLY — not suitable for production extraction.
 *
 * Parsing strategy: looks for statements matching the pattern:
 *   "<subjectId> <fieldOrBehavior> is <value>"
 * or
 *   "<subjectId> <fieldOrBehavior>: <value>"
 *
 * where subjectId and fieldOrBehavior are single words. This intentionally
 * simple and transparent pattern lets tests be deterministic.
 *
 * The subjectType is always "unknown" since it cannot be inferred from text
 * alone in this reference implementation.
 */
export const referenceUtteranceExtractor: UtteranceClaimExtractor = {
  name: "reference-utterance-extractor",
  extract(utterance: string): ExtractedStatement[] {
    const results: ExtractedStatement[] = [];

    // Pattern: "<word> <word> is <value>" or "<word> <word>: <value>"
    // Value is a single non-whitespace token; trailing punctuation is stripped.
    const isPattern = /\b(\S+)\s+(\S+)\s+is\s+(\S+)/giu;
    const colonPattern = /\b(\S+)\s+(\S+):\s*(\S+)/giu;

    for (const pattern of [isPattern, colonPattern]) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(utterance)) !== null) {
        const [full, subjectId, fieldOrBehavior, rawValue] = match;
        if (!subjectId || !fieldOrBehavior || rawValue === undefined) continue;

        const start = match.index;
        const end = start + full.length;
        // Strip trailing punctuation from the captured value
        const value = rawValue.replace(/[.!?,;]+$/u, "");

        results.push({
          target: {
            subjectType: "unknown",
            subjectId: subjectId.toLowerCase(),
            fieldOrBehavior: fieldOrBehavior.toLowerCase(),
          },
          value,
          excerpt: full.replace(/[.!?,;]+$/u, ""),
          span: { start, end },
          confidence: 0.6,
        });
      }
    }

    return results;
  },
};
