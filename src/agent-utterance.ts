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

  const extractions: Extraction[] = [];
  const candidateSets: CandidateSet[] = [];
  const claims: ClaimTarget[] = [];

  for (let idx = 0; idx < extracted.length; idx++) {
    const statement = extracted[idx]!;
    const statementId = `${sourceId}.statement.${idx}`;
    const extractionId = `${statementId}.extraction`;
    const candidateId = `${statementId}.candidate`;
    const candidateSetId = `${statementId}.candidate-set`;
    const claimId = `${statementId}.claim`;

    // Compute locator — required for non-manual-entry sources
    // (assertProducerDiscipline throws without it)
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

    const candidate: Candidate = {
      id: candidateId,
      extractionId,
      value: statement.value ?? null,
      confidence: statement.confidence,
      metadata: {
        agentUtterance: {
          span: statement.span,
          excerpt: statement.excerpt,
          extractorName,
          confidence: statement.confidence,
        },
      },
    };

    // needs-review status → statusFor returns "proposed" (no review outcome)
    const candidateSet: CandidateSet = {
      id: candidateSetId,
      target: canonicalTargetKey(statement.target),
      candidates: [candidate],
      selectedCandidateId: candidateId,
      status: "needs-review",
      metadata: {
        agentUtterance: {
          subjectType: statement.target.subjectType,
          subjectId: statement.target.subjectId,
          fieldOrBehavior: statement.target.fieldOrBehavior,
        },
      },
    };

    // Unreviewed: status is omitted so statusFor() computes "proposed"
    // assertProducerDiscipline: no verified/assumed without review → compliant
    const claimTarget: ClaimTarget = {
      id: claimId,
      candidateSetId,
      candidateId,
      subjectType: statement.target.subjectType,
      subjectId: statement.target.subjectId,
      surface: "agent-utterance.profile",
      claimType: "agent-extraction",
      fieldOrBehavior: statement.target.fieldOrBehavior,
      value: statement.value,
      // status intentionally omitted → computed as "proposed" by statusFor
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
            locator,
          },
        },
      },
    };

    extractions.push(extraction);
    candidateSets.push(candidateSet);
    claims.push(claimTarget);
  }

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

  // Step 3 & 4: Resolve each statement and build the report
  const statements: UtteranceStatement[] = [];

  for (const statement of extracted) {
    const statementId = `${sourceId}.statement.${statements.length}`;

    // Build Survey records for provenance
    const extractionId = `${statementId}.extraction`;
    const extraction: Extraction = {
      id: extractionId,
      sourceId,
      target: canonicalTargetKey(statement.target),
      value: statement.value ?? null,
      confidence: statement.confidence,
      locator: statement.span ? `text-span:${statement.span.start}-${statement.span.end}` : undefined,
      excerpt: statement.excerpt,
      extractor: extractor.name,
      extractedAt: observedAt,
      metadata: {
        agentUtterance: {
          span: statement.span,
          excerpt: statement.excerpt,
          extractorName: extractor.name,
          confidence: statement.confidence,
        },
      },
    };

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

    // Suppress unused-variable warning for extraction
    void extraction;
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
