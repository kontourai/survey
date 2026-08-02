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

import type { DerivationRule, InquiryRecord, TrustBundle, TrustStatus } from "@kontourai/surface";
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
 * Badge values for each extracted statement.
 *
 * A badge grades THE STATEMENT, not the target. It is a function of two
 * things: the status of the bundle's answer for the statement's canonical
 * target, and how the statement's own asserted value compares to that
 * answer's value.
 *
 * The status half of the vocabulary is Surface's `TrustStatus` verbatim —
 * Survey does not mint parallel status terms for concepts Surface (and the
 * Hachure core record shapes it implements) already name. Only two badge
 * values are Survey-side additions, because they describe the
 * statement-vs-answer relation rather than a claim's standing:
 *
 * - "contradicted": the bundle has an answer that would otherwise read as
 *   support ("verified", "assumed", "stale") and the statement asserts a
 *   DIFFERENT value. Mirrors the Hachure `contradiction` transparency-gap
 *   type (merge.md §7b): a value conflict is surfaced, never silently
 *   resolved in favour of one side.
 * - "unsupported": the inquiry did not resolve to an answer at all — no
 *   mapping and no registered claim for the target. This value means "there
 *   is nothing here to compare against", and nothing else: a claim that is
 *   registered but merely awaiting review badges "proposed", and one with no
 *   evidence badges "unknown".
 *
 * Every other badge is the answer's `TrustStatus` passed through unchanged,
 * so there is no fall-through path that can report a real status under a
 * label meaning "no such claim".
 */
export type StatementBadge = TrustStatus | "contradicted" | "unsupported";

/**
 * How a statement's asserted value compares to the bundle's answer value.
 *
 * - "agrees": both are comparable scalars and equivalent under
 *   `assertionComparisonKey`.
 * - "contradicts": both are comparable scalars and NOT equivalent.
 * - "not-compared": no comparison was possible — the inquiry produced no
 *   answer, or the extractor parsed no value out of the statement
 *   (`ExtractedStatement.value` absent), or one side is not a scalar.
 *   Never treated as agreement.
 */
export type StatementValueComparison = "agrees" | "contradicts" | "not-compared";

/**
 * How the Extraction's `text-span:` locator was resolved for a statement.
 *
 * - "span": the extractor supplied an explicit character span; the locator
 *   points where the extractor said it does.
 * - "excerpt-match": no span, but the excerpt was found verbatim in the
 *   utterance; the locator points at that occurrence.
 * - "unanchored-fallback": no span AND the excerpt does not occur in the
 *   utterance. The locator is still well-formed (`text-span:0-<length>`) so
 *   downstream producer discipline holds, but it is a length-shaped
 *   placeholder anchored at offset 0 — it does NOT point at the excerpt, and
 *   the text it spans is unrelated prose. Anything that resolves the locator
 *   against the source MUST check this field first; a hallucinated excerpt
 *   lands here.
 */
export type LocatorResolution = "span" | "excerpt-match" | "unanchored-fallback";

export interface UtteranceStatement {
  excerpt: string;
  span?: { start: number; end: number };
  target: CanonicalClaimTarget;
  /**
   * The value the statement asserted, verbatim from the extractor
   * (`ExtractedStatement.value`) — not normalized, not defaulted. Absent when
   * the extractor parsed no value, which is exactly when `valueComparison`
   * is "not-compared". This is the field a reader needs to see WHAT was
   * compared against the bundle's answer.
   */
  assertedValue?: unknown;
  /** How `assertedValue` compares to `inquiryRecord.answer?.value`. */
  valueComparison: StatementValueComparison;
  /** Human-readable account of the comparison, naming both sides. */
  comparisonRationale: string;
  /**
   * The Survey provenance records this statement produced: its Extraction,
   * its Candidate, and the per-target Candidate Set it belongs to. The
   * Candidate Set carries the Candidate Conflict verdict and rationale when
   * two statements in the SAME utterance disagree about one target
   * (`candidateSet.status === "conflict"`), which is a different signal from
   * `valueComparison` (statement vs bundle).
   */
  records: UtteranceStatementRecords;
  /** How this statement's Extraction locator was resolved. */
  locatorResolution: LocatorResolution;
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
 * Extractors do not normalize `value` before it reaches
 * `ExtractedStatement` — case and internal formatting are preserved
 * verbatim. String values are the only case where "representation noise"
 * (leading/trailing whitespace from excerpt boundaries, incidental case
 * differences like "Healthy" vs "healthy") is plausible in producer output,
 * so this key trims + lowercases STRING values
 * in the COMPARISON KEY ONLY — the stored `Candidate.value`/`Extraction.value`
 * stay byte-for-byte verbatim; this function only feeds `equivalenceKey`,
 * never `value`. Non-string values (number, boolean, null — the other types
 * supported by the portable record contract) compare via exact canonical
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
  locatorResolution: LocatorResolution;
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
  // span-first, excerpt-fallback — locator VALUES unchanged from Slice 1;
  // what is new is that the record now says which branch produced them, so
  // an unanchored placeholder is never mistaken for a resolved pointer.
  const { locator, resolution: locatorResolution } = resolveUtteranceLocator(utterance, statement);

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
        locatorResolution,
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

  return { extraction, proposal, locatorResolution };
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
  /**
   * `locatorResolutions[idx]` is how `records[idx]`'s Extraction locator was
   * resolved — a parallel array rather than a fourth key on
   * `UtteranceStatementRecords`, whose shape is a pinned contract. The same
   * value is also on `records[idx].extraction.metadata.agentUtterance`.
   */
  locatorResolutions: LocatorResolution[];
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
    const { extraction, proposal, locatorResolution } = buildUtteranceExtraction({
      sourceId,
      idx,
      statement,
      utterance,
      extractorName,
      observedAt,
    });
    return { statement, extraction, proposal, locatorResolution };
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
    locatorResolutions: items.map((i) => i.locatorResolution),
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
  const { records, extractions, candidateSets, locatorResolutions } = buildUtteranceRecords({
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
            // Travels with the locator so a downstream reader of the Claim
            // never has to assume the locator resolved.
            locatorResolution: locatorResolutions[idx]!,
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

  // Batched, grouped provenance construction. Grouping needs every statement
  // of a target's group present at once, so this cannot be a per-statement
  // call. The result is now carried onto every UtteranceStatement
  // (`records`), so the extractor's confidence, locator, Candidate and
  // Candidate Set — including the Candidate Conflict verdict when two
  // statements in this utterance disagree about one target — are observable
  // in the report instead of being computed and dropped on the floor.
  const { records, locatorResolutions } = buildUtteranceRecords({
    sourceId,
    utterance,
    extracted,
    extractorName: extractor.name,
    observedAt,
  });

  // Step 3 & 4: Resolve each statement and build the report
  const statements: UtteranceStatement[] = [];

  for (const [idx, statement] of extracted.entries()) {
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

    const comparison = compareAssertedValue(statement, inquiryRecord);
    const badge = badgeFor(inquiryRecord, comparison.valueComparison);

    statements.push({
      excerpt: statement.excerpt,
      span: statement.span,
      target: statement.target,
      ...(hasAssertedValue(statement) ? { assertedValue: statement.value } : {}),
      valueComparison: comparison.valueComparison,
      comparisonRationale: comparison.rationale,
      records: records[idx]!,
      locatorResolution: locatorResolutions[idx]!,
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

/**
 * Answer statuses a reader takes as support for what the statement said.
 * These — and only these — are the statuses a contradiction must override:
 * badging a statement "verified" when it asserts a value the verified claim
 * denies is the exact failure this profile exists to prevent. For any other
 * status the claim's own standing is already the more informative thing to
 * show, and the contradiction stays legible in `valueComparison`.
 */
const SUPPORTING_STATUSES: ReadonlySet<TrustStatus> = new Set<TrustStatus>(["verified", "assumed", "stale"]);

function hasAssertedValue(statement: ExtractedStatement): boolean {
  return statement.value !== undefined;
}

/**
 * Whether a value can take part in a statement-vs-answer comparison at all.
 * Scalars can; objects and arrays cannot, because an utterance extractor
 * pulls a token out of prose and there is no defensible way to decide
 * whether that token "is" a structured value. Those report "not-compared"
 * rather than being asserted to contradict.
 */
function isComparableScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * The statement-vs-answer comparison key.
 *
 * This is deliberately NOT `utteranceEquivalenceKey`. That key compares two
 * values from the SAME extractor, which share one type discipline, so it
 * refuses cross-type equality on purpose (5 and "5" from one extractor
 * really are different findings). A statement-vs-answer comparison crosses a
 * boundary: the left side is a token the extractor pulled out of prose, the
 * right side is a value the producer typed. Comparing those two by
 * `typeof` would badge every true statement about a numeric or boolean field
 * as a contradiction — a false accusation, which damages the badge exactly
 * as much as a false green does.
 *
 * So scalars are compared by their canonical TEXT rendering, trimmed and
 * lowercased. This bridges "the agent wrote 95" to "the producer stored 95"
 * without losing a genuine disagreement: "5" and "6" still differ, and the
 * bridge is named in `comparisonRationale` rather than applied silently.
 */
function assertionComparisonKey(value: unknown): string {
  return String(value).trim().toLowerCase();
}

/**
 * Compare the statement's own asserted value against the bundle's answer.
 *
 * An absent asserted value is never treated as agreement: an extractor that
 * parsed no value has asserted nothing to check, so it reports
 * "not-compared".
 */
function compareAssertedValue(
  statement: ExtractedStatement,
  record: InquiryRecord,
): { valueComparison: StatementValueComparison; rationale: string } {
  const targetKey = canonicalTargetKey(statement.target);
  const answer = record.answer;
  if (!answer) {
    return {
      valueComparison: "not-compared",
      rationale: `No answer for ${targetKey} (inquiry outcome: ${record.outcome}); nothing to compare the statement against.`,
    };
  }
  if (!hasAssertedValue(statement)) {
    return {
      valueComparison: "not-compared",
      rationale: `The extractor parsed no value out of this statement, so nothing was compared against the ${answer.status} answer for ${targetKey}.`,
    };
  }
  if (!isComparableScalar(statement.value) || !isComparableScalar(answer.value)) {
    return {
      valueComparison: "not-compared",
      rationale: `Statement value ${JSON.stringify(statement.value) ?? "undefined"} and the ${answer.status} answer ${JSON.stringify(answer.value) ?? "undefined"} for ${targetKey} are not both scalars; no comparison was attempted.`,
    };
  }
  const asserted = assertionComparisonKey(statement.value);
  const answered = assertionComparisonKey(answer.value);
  const shown = `statement "${asserted}" vs ${answer.status} answer "${answered}" (compared as text)`;
  return asserted === answered
    ? { valueComparison: "agrees", rationale: `Agrees for ${targetKey}: ${shown}.` }
    : { valueComparison: "contradicts", rationale: `Contradicts for ${targetKey}: ${shown}.` };
}

/**
 * Grade the STATEMENT: the answer's status, overridden by "contradicted"
 * when the statement asserts something the answer denies and that answer
 * would otherwise have read as support.
 */
function badgeFor(record: InquiryRecord, valueComparison: StatementValueComparison): StatementBadge {
  if (record.outcome === "unsupported") return "unsupported";
  const status = record.answer?.status;
  if (!status) return "unsupported";
  if (valueComparison === "contradicts" && SUPPORTING_STATUSES.has(status)) return "contradicted";
  return status;
}

/**
 * The single Source Locator rule this module guarantees: span-first,
 * excerpt-match second, unanchored placeholder last — and it always reports
 * WHICH of the three produced the locator.
 *
 * The locator strings are unchanged from Slice 1, including the last branch's
 * `text-span:0-<excerpt.length>` placeholder. That placeholder is deliberate
 * (producer discipline requires a locator on a non-manual-entry source), but
 * it is well-formed and therefore resolvable — it will happily span real,
 * unrelated prose at the head of the utterance. Returning the resolution
 * alongside it is what keeps a hallucinated excerpt from acquiring a pointer
 * that looks exactly like a found one: the record now says the lookup failed
 * instead of leaving the reader to re-derive it.
 */
function resolveUtteranceLocator(
  utterance: string,
  statement: ExtractedStatement,
): { locator: string; resolution: LocatorResolution } {
  if (statement.span) {
    return { locator: `text-span:${statement.span.start}-${statement.span.end}`, resolution: "span" };
  }
  const idx = utterance.indexOf(statement.excerpt);
  if (idx >= 0) {
    return { locator: `text-span:${idx}-${idx + statement.excerpt.length}`, resolution: "excerpt-match" };
  }
  return { locator: `text-span:0-${statement.excerpt.length}`, resolution: "unanchored-fallback" };
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
