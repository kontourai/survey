/**
 * Schema-mapping producer profile — EVIDENCED-ONTOLOGY layer.
 *
 * Every other semantic-layer mapping is unaudited config. Here every mapping
 * shows its work: proposals carry schema-doc evidence, confidence, and
 * rationale; they flow through Survey's candidate → review machinery before
 * any mapping is accepted. Nothing here silently decides (ADR 0003 §4).
 *
 * The wedge: in every other semantic layer the mapping is unaudited config;
 * here every mapping shows its work.
 *
 * Integration pattern:
 *   1. Call surveySchemaMapping(context, extractor, options) to produce a
 *      SurveyInput from two or more system schemas.
 *   2. Review the CandidateSets (kind: "needs-review" or "conflict").
 *   3. Call mappingReviewToSurface(reviewedMappings) to project accepted
 *      mappings into a TrustBundle where each accepted mapping is BOTH:
 *        (a) a Claim  (subjectType "system-field", fieldOrBehavior "maps-to")
 *        (b) an IdentityLink with relation/conversion and mappingClaimId
 *      so that resolveInquiry can resolve across systems with weakest-link
 *      capping.
 */

import type { IdentityLink, IdentityLinkConversion, TrustBundle } from "@kontourai/surface";
import { buildSurveyTrustBundle } from "./to-surface.js";
import type {
  Candidate,
  CandidateSet,
  ClaimTarget,
  Extraction,
  RawSource,
  ReviewOutcome,
  SurveyInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * A stable reference to one field within one system's schema.
 */
export interface SystemFieldRef {
  /** The system identifier (e.g. "crm", "erp", "salesforce"). */
  system: string;
  /** The entity/table/resource name within that system. */
  entity: string;
  /** The field/column/attribute name within that entity. */
  field: string;
  /**
   * Optional structural locator within a schema document (e.g.
   * "json:$.definitions.Contact.properties.phoneNumber").
   */
  locator?: string;
}

/**
 * A proposed link between two SystemFieldRefs, with evidence from schema
 * documents or profiling output.
 *
 * This is the "show your work" record: every mapping carries excerpts from
 * the relevant schema docs, a confidence score, a rationale, and the name
 * of the extractor that produced the proposal.  Nothing is accepted until
 * it flows through review.
 */
export interface MappingProposalRecord {
  id: string;
  /** The source field being mapped. */
  sourceField: SystemFieldRef;
  /** The target field being mapped. */
  targetField: SystemFieldRef;
  /**
   * Semantic relation between the two fields.
   * "equivalent" — same real-world fact, same unit.
   * "subsumes" — the source field contains / is a superset of the target.
   * "converts" — related by a numeric unit/scale conversion; supply conversion.
   */
  relation: "equivalent" | "subsumes" | "converts";
  /**
   * Numeric conversion parameters.  Only meaningful when relation = "converts".
   * target_value = source_value * factor + offset
   */
  conversion?: {
    factor?: number;
    offset?: number;
    note?: string;
  };
  /**
   * Schema document excerpts that support the proposal.
   * One entry per system that the extractor consulted.
   */
  evidence: Array<{
    system: string;
    excerpt: string;
  }>;
  /** Extractor confidence in the mapping (0–1). */
  confidence: number;
  /** Human-readable rationale for the proposal. */
  rationale: string;
  /** Name of the SchemaMappingExtractor that produced this proposal. */
  proposedBy: string;
  /** ISO 8601 timestamp. */
  proposedAt: string;
}

// ---------------------------------------------------------------------------
// Extractor interface
// ---------------------------------------------------------------------------

/**
 * Pluggable interface for proposing field mappings across system schemas.
 *
 * Implementations may be deterministic (like referenceSchemaExtractor below),
 * embedding-based, or LLM-backed — but they are always proposers: their output
 * carries full provenance and goes through review before it counts.
 *
 * Supports both synchronous and async implementations.
 */
export interface SchemaMappingExtractor {
  name: string;
  extract(context: {
    systems: Array<{ system: string; schemaText: string }>;
  }): MappingProposalRecord[] | Promise<MappingProposalRecord[]>;
}

// ---------------------------------------------------------------------------
// Canonical pair key
// ---------------------------------------------------------------------------

/** Stable key for a field pair (order-independent alphabetic sort). */
function fieldPairKey(a: SystemFieldRef, b: SystemFieldRef): string {
  const aKey = `${a.system}::${a.entity}::${a.field}`;
  const bKey = `${b.system}::${b.entity}::${b.field}`;
  return aKey <= bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

/** Canonical mapping claim subject id. */
function mappingSubjectId(a: SystemFieldRef, b: SystemFieldRef): string {
  return fieldPairKey(a, b);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SchemaMappingOptions {
  /**
   * If set, proposals at or above this confidence threshold are auto-accepted
   * as "assumed" (mirrors applyAutoAcceptPolicy in inquiry-mapping).
   * Conflicting proposals are never auto-accepted.
   */
  autoAcceptMinConfidence?: number;
  /** ISO 8601 timestamp; defaults to new Date().toISOString(). */
  generatedAt?: string;
  /** Identifies the Survey producer run. */
  source?: string;
}

// ---------------------------------------------------------------------------
// surveySchemaMapping
// ---------------------------------------------------------------------------

/**
 * Run the extractor against the provided system schemas and project the
 * resulting proposals into the standard Survey chain:
 *
 *   RawSource (kind "system-schema") per system
 *   → Extraction per proposal
 *   → Candidate per proposal
 *   → CandidateSet per field pair
 *       status "conflict" when proposals disagree about the same field pair
 *       status "needs-review" otherwise
 *
 * If options.autoAcceptMinConfidence is set, non-conflicting proposals above
 * the threshold gain a ReviewOutcome with status "assumed".
 *
 * The returned SurveyInput is ready for buildSurveyTrustBundle (for provenance
 * storage) or for mappingReviewToSurface after human review.
 */
export async function surveySchemaMapping(
  context: {
    systems: Array<{ system: string; schemaText: string }>;
  },
  extractor: SchemaMappingExtractor,
  options: SchemaMappingOptions = {},
): Promise<{
  surveyInput: SurveyInput;
  proposals: MappingProposalRecord[];
  candidateSets: CandidateSet[];
}> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const source = options.source ?? `schema-mapping:${extractor.name}`;

  const proposals = await Promise.resolve(extractor.extract(context));

  // One RawSource per system schema
  const rawSources: RawSource[] = context.systems.map((s) => ({
    id: `schema-mapping.source.${s.system}`,
    kind: "system-schema" as const,
    sourceRef: `system-schema://${s.system}`,
    observedAt: generatedAt,
    locatorScheme: "structured-field" as const,
    inlineText: s.schemaText,
    metadata: { system: s.system },
  }));

  const sourceById = new Map(rawSources.map((r) => [r.metadata?.system as string, r]));

  // Group proposals by canonical field-pair key to detect conflicts
  const proposalsByPair = new Map<string, MappingProposalRecord[]>();
  for (const proposal of proposals) {
    const key = fieldPairKey(proposal.sourceField, proposal.targetField);
    proposalsByPair.set(key, [...(proposalsByPair.get(key) ?? []), proposal]);
  }

  const extractions: Extraction[] = [];
  const candidateSets: CandidateSet[] = [];
  const reviewOutcomes: ReviewOutcome[] = [];
  const claims: ClaimTarget[] = [];

  for (const [pairKey, pairProposals] of proposalsByPair) {
    const first = pairProposals[0]!;
    const subjectId = mappingSubjectId(first.sourceField, first.targetField);
    const candidateSetId = `schema-mapping.candidate-set.${pairKey}`;
    const claimId = `schema-mapping.claim.${pairKey}`;

    // Detect conflict: proposals disagree on relation
    const relations = new Set(pairProposals.map((p) => p.relation));
    const status = relations.size > 1 ? "conflict" : "needs-review";

    const candidates: Candidate[] = pairProposals.map((proposal) => {
      // Use the source system's RawSource for this extraction
      const rawSource = sourceById.get(proposal.sourceField.system) ?? rawSources[0]!;
      const extractionId = `schema-mapping.extraction.${proposal.id}`;

      const extraction: Extraction = {
        id: extractionId,
        sourceId: rawSource.id,
        target: `${proposal.sourceField.entity}.${proposal.sourceField.field}:maps-to:${proposal.targetField.entity}.${proposal.targetField.field}`,
        value: {
          relation: proposal.relation,
          targetField: proposal.targetField,
          conversion: proposal.conversion,
        },
        confidence: proposal.confidence,
        locator: proposal.sourceField.locator ?? `structured-field:${proposal.sourceField.entity}.${proposal.sourceField.field}`,
        excerpt: proposal.evidence.map((e) => `[${e.system}] ${e.excerpt}`).join(" | "),
        extractor: proposal.proposedBy,
        extractedAt: proposal.proposedAt,
        metadata: {
          schemaMappingProposal: {
            proposalId: proposal.id,
            sourceField: proposal.sourceField,
            targetField: proposal.targetField,
            relation: proposal.relation,
            conversion: proposal.conversion,
            evidence: proposal.evidence,
            confidence: proposal.confidence,
            rationale: proposal.rationale,
          },
        },
      };

      extractions.push(extraction);

      return {
        id: `schema-mapping.candidate.${proposal.id}`,
        extractionId,
        value: {
          relation: proposal.relation,
          targetField: proposal.targetField,
          conversion: proposal.conversion,
        },
        confidence: proposal.confidence,
        metadata: {
          schemaMappingProposal: {
            proposalId: proposal.id,
            sourceField: proposal.sourceField,
            targetField: proposal.targetField,
            relation: proposal.relation,
            conversion: proposal.conversion,
            evidence: proposal.evidence,
            confidence: proposal.confidence,
            rationale: proposal.rationale,
            proposedBy: proposal.proposedBy,
            proposedAt: proposal.proposedAt,
          },
        },
      };
    });

    const candidateSet: CandidateSet = {
      id: candidateSetId,
      target: `schema-mapping:${pairKey}`,
      candidates,
      selectedCandidateId: status !== "conflict" ? candidates[0]?.id : undefined,
      status,
      rationale: status === "conflict"
        ? `Proposals disagree on relation for pair ${pairKey}: ${[...relations].join(", ")}`
        : `${candidates.length} proposal(s) agree on relation "${first.relation}" for pair ${pairKey}.`,
      metadata: {
        schemaMapping: {
          pairKey,
          sourceField: first.sourceField,
          targetField: first.targetField,
        },
      },
    };
    candidateSets.push(candidateSet);

    // Auto-accept policy: non-conflicting proposals above threshold → assumed
    let autoReviewStatus: "assumed" | undefined;
    if (status !== "conflict" && options.autoAcceptMinConfidence !== undefined) {
      const topConfidence = Math.max(...pairProposals.map((p) => p.confidence));
      if (topConfidence >= options.autoAcceptMinConfidence) {
        autoReviewStatus = "assumed";
      }
    }

    const selectedCandidate = candidateSet.selectedCandidateId
      ? candidates.find((c) => c.id === candidateSet.selectedCandidateId)
      : candidates[0];

    if (autoReviewStatus && selectedCandidate) {
      const reviewId = `schema-mapping.review.${pairKey}`;
      reviewOutcomes.push({
        id: reviewId,
        candidateSetId,
        candidateId: selectedCandidate.id,
        status: autoReviewStatus,
        actor: "auto-accept-policy",
        reviewedAt: generatedAt,
        rationale: `Auto-accepted: confidence ${selectedCandidate.confidence} >= threshold ${options.autoAcceptMinConfidence}`,
        withinComfortZone: true,
      });
    }

    // Project to ClaimTarget (subjectType "system-field", fieldOrBehavior "maps-to")
    if (selectedCandidate) {
      const review = reviewOutcomes.find((r) => r.candidateSetId === candidateSetId);
      const claimStatus = review
        ? review.status
        : (status === "conflict" ? "disputed" : undefined);

      const claimTarget: ClaimTarget = {
        id: claimId,
        candidateSetId,
        candidateId: selectedCandidate.id,
        subjectType: "system-field",
        subjectId: subjectId,
        facet: "schema-mapping.profile",
        claimType: "schema-mapping.field-link",
        fieldOrBehavior: "maps-to",
        value: {
          relation: first.relation,
          sourceField: first.sourceField,
          targetField: first.targetField,
          conversion: first.conversion,
        },
        ...(claimStatus ? { status: claimStatus } : {}),
        impactLevel: "medium",
        collectedBy: extractor.name,
        metadata: {
          survey: {
            schemaMapping: {
              pairKey,
              sourceField: first.sourceField,
              targetField: first.targetField,
              relation: first.relation,
              conversion: first.conversion,
            },
          },
        },
      };

      claims.push(claimTarget);
    }
  }

  const surveyInput: SurveyInput = {
    source,
    generatedAt,
    rawSources,
    extractions,
    candidateSets,
    reviewOutcomes,
    claims,
  };

  return { surveyInput, proposals, candidateSets };
}

// ---------------------------------------------------------------------------
// Reviewed mapping record
// ---------------------------------------------------------------------------

/**
 * A reviewed (accepted or rejected) mapping record: the CandidateSet, the
 * selected candidate, and the review outcome.
 */
export interface ReviewedMapping {
  pairKey: string;
  candidateSet: CandidateSet;
  /** The selected candidate (winner of review). */
  selectedCandidate: Candidate;
  reviewOutcome: ReviewOutcome;
  /** Original proposal record. */
  proposal: MappingProposalRecord;
}

// ---------------------------------------------------------------------------
// mappingReviewToSurface
// ---------------------------------------------------------------------------

/**
 * Project reviewed (accepted) mappings into a TrustBundle.
 *
 * For each accepted mapping, the bundle contains BOTH:
 *   (a) a Claim: subjectType "system-field", fieldOrBehavior "maps-to"
 *       whose status reflects the review outcome; disputing this claim caps
 *       the identity-link answer via weakest-link (see mappingClaimId).
 *   (b) an IdentityLink: links the source and target system-field subjects
 *       with relation/conversion, and sets mappingClaimId to the claim id.
 *
 * This means resolveInquiry can traverse the link when asked about system B's
 * field while only system A's claim exists in the bundle, with the mapping
 * claim's status as the weakest-link ceiling.
 *
 * Rejected mappings are omitted from the bundle (but can be retained for
 * audit by calling buildSurveyTrustBundle on the original SurveyInput).
 */
export function mappingReviewToSurface(
  reviewedMappings: ReviewedMapping[],
  options: {
    source?: string;
    generatedAt?: string;
  } = {},
): TrustBundle {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const source = options.source ?? "schema-mapping.reviewed";

  // Filter to accepted mappings only
  const accepted = reviewedMappings.filter(
    (m) => m.reviewOutcome.status === "verified" || m.reviewOutcome.status === "assumed",
  );

  // Build a SurveyInput for the accepted mappings so buildSurveyTrustBundle
  // handles the full projection (provenance, events, evidence).
  const rawSources: RawSource[] = [];
  const seenSources = new Set<string>();
  for (const rm of accepted) {
    const meta = rm.selectedCandidate.metadata?.schemaMappingProposal as {
      sourceField?: SystemFieldRef;
      evidence?: Array<{ system: string; excerpt: string }>;
    } | undefined;
    const sourceField = meta?.sourceField ?? rm.proposal.sourceField;
    const sourceId = `schema-mapping.source.${sourceField.system}`;
    if (!seenSources.has(sourceId)) {
      seenSources.add(sourceId);
      rawSources.push({
        id: sourceId,
        kind: "system-schema" as const,
        sourceRef: `system-schema://${sourceField.system}`,
        observedAt: generatedAt,
        locatorScheme: "structured-field" as const,
        inlineText: (meta?.evidence ?? rm.proposal.evidence)
          .filter((e) => e.system === sourceField.system)
          .map((e) => e.excerpt)
          .join("\n"),
        metadata: { system: sourceField.system },
      });
    }
  }

  const extractions: Extraction[] = [];
  const candidateSets: CandidateSet[] = [];
  const reviewOutcomes: ReviewOutcome[] = [];
  const claims: ClaimTarget[] = [];

  for (const rm of accepted) {
    const meta = rm.selectedCandidate.metadata?.schemaMappingProposal as {
      proposalId?: string;
      sourceField?: SystemFieldRef;
      targetField?: SystemFieldRef;
      relation?: string;
      conversion?: { factor?: number; offset?: number; note?: string };
      evidence?: Array<{ system: string; excerpt: string }>;
      confidence?: number;
      rationale?: string;
      proposedBy?: string;
      proposedAt?: string;
    } | undefined;

    const sourceField = meta?.sourceField ?? rm.proposal.sourceField;
    const targetField = meta?.targetField ?? rm.proposal.targetField;
    const relation = (meta?.relation ?? rm.proposal.relation) as "equivalent" | "subsumes" | "converts";
    const conversion = meta?.conversion ?? rm.proposal.conversion;
    const evidence = meta?.evidence ?? rm.proposal.evidence;
    const confidence = meta?.confidence ?? rm.proposal.confidence;
    const proposedAt = meta?.proposedAt ?? rm.proposal.proposedAt;
    const proposedBy = meta?.proposedBy ?? rm.proposal.proposedBy;

    const rawSourceId = `schema-mapping.source.${sourceField.system}`;
    const extractionId = `${rm.selectedCandidate.extractionId}`;
    const candidateSetId = rm.candidateSet.id;
    const claimId = `schema-mapping.claim.${rm.pairKey}`;
    const subjectId = mappingSubjectId(sourceField, targetField);

    const extraction: Extraction = {
      id: extractionId,
      sourceId: rawSourceId,
      target: `${sourceField.entity}.${sourceField.field}:maps-to:${targetField.entity}.${targetField.field}`,
      value: { relation, targetField, conversion },
      confidence,
      locator: sourceField.locator ?? `structured-field:${sourceField.entity}.${sourceField.field}`,
      excerpt: evidence.map((e) => `[${e.system}] ${e.excerpt}`).join(" | "),
      extractor: proposedBy,
      extractedAt: proposedAt,
      metadata: {
        schemaMappingProposal: {
          sourceField,
          targetField,
          relation,
          conversion,
          evidence,
          confidence,
        },
      },
    };
    extractions.push(extraction);

    // Rebuild the candidate set with exactly the accepted candidate
    const candidateSet: CandidateSet = {
      ...rm.candidateSet,
      id: candidateSetId,
      candidates: [rm.selectedCandidate],
      selectedCandidateId: rm.selectedCandidate.id,
      status: "resolved",
    };
    candidateSets.push(candidateSet);

    reviewOutcomes.push(rm.reviewOutcome);

    const claimTarget: ClaimTarget = {
      id: claimId,
      candidateSetId,
      candidateId: rm.selectedCandidate.id,
      subjectType: "system-field",
      subjectId,
      facet: "schema-mapping.profile",
      claimType: "schema-mapping.field-link",
      fieldOrBehavior: "maps-to",
      value: { relation, sourceField, targetField, conversion },
      status: rm.reviewOutcome.status as "verified" | "assumed",
      impactLevel: "medium",
      collectedBy: proposedBy,
      actor: rm.reviewOutcome.actor,
      metadata: {
        survey: {
          schemaMapping: {
            pairKey: rm.pairKey,
            sourceField,
            targetField,
            relation,
            conversion,
          },
        },
      },
    };
    claims.push(claimTarget);
  }

  const surveyInput: SurveyInput = {
    source,
    generatedAt,
    rawSources,
    extractions,
    candidateSets,
    reviewOutcomes,
    claims,
  };

  const bundle = buildSurveyTrustBundle(surveyInput);

  // Attach IdentityLinks: one per accepted mapping.
  // Each link ties the source-system-field subject to the target-system-field
  // subject and back-references the mapping claim via mappingClaimId.
  const identityLinks: IdentityLink[] = [];

  for (const rm of accepted) {
    const meta = rm.selectedCandidate.metadata?.schemaMappingProposal as {
      sourceField?: SystemFieldRef;
      targetField?: SystemFieldRef;
      relation?: string;
      conversion?: IdentityLinkConversion;
    } | undefined;

    const sourceField = meta?.sourceField ?? rm.proposal.sourceField;
    const targetField = meta?.targetField ?? rm.proposal.targetField;
    const relation = ((meta?.relation ?? rm.proposal.relation) as "equivalent" | "subsumes" | "converts");
    const conversion = (meta?.conversion ?? rm.proposal.conversion) as IdentityLinkConversion | undefined;
    const claimId = `schema-mapping.claim.${rm.pairKey}`;

    const link: IdentityLink = {
      id: `schema-mapping.link.${rm.pairKey}`,
      subjects: [
        { subjectType: "system-field", subjectId: `${sourceField.system}::${sourceField.entity}::${sourceField.field}` },
        { subjectType: "system-field", subjectId: `${targetField.system}::${targetField.entity}::${targetField.field}` },
      ],
      reason: `Schema mapping: ${sourceField.system}.${sourceField.entity}.${sourceField.field} ${relation} ${targetField.system}.${targetField.entity}.${targetField.field}`,
      attestedBy: rm.reviewOutcome.actor,
      relation,
      ...(conversion ? { conversion } : {}),
      mappingClaimId: claimId,
    };

    identityLinks.push(link);
  }

  return {
    ...bundle,
    identityLinks: identityLinks.length > 0 ? identityLinks : undefined,
  };
}

// ---------------------------------------------------------------------------
// Reference extractor (deterministic, for tests — not for production use)
// ---------------------------------------------------------------------------

/**
 * Reference SchemaMappingExtractor for tests.
 *
 * REFERENCE IMPLEMENTATION ONLY — not suitable for production matching.
 *
 * Matching strategy: two fields are proposed as "equivalent" when they share
 * the same field name (case-insensitive) and the same inferred type token
 * ("string", "number", "boolean", "date", or absent) across two system schemas.
 *
 * Schema text format expected by this reference extractor:
 *   Each non-empty line is: "<entity>.<field>[:<type>]"
 *   e.g. "Contact.email:string" or "Account.revenue:number"
 *
 * This format is intentionally simple and transparent so tests can be
 * deterministic without depending on any schema parsing library.
 */
export const referenceSchemaExtractor: SchemaMappingExtractor = {
  name: "reference-schema-extractor",
  extract(context: { systems: Array<{ system: string; schemaText: string }> }): MappingProposalRecord[] {
    const now = new Date().toISOString();

    // Parse each system's schema into a list of { entity, field, type } triples
    type ParsedField = { entity: string; field: string; type: string; locator: string };
    const parsed: Array<{ system: string; fields: ParsedField[] }> = context.systems.map(({ system, schemaText }) => {
      const fields: ParsedField[] = [];
      for (const line of schemaText.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        // Format: entity.field[:type]
        const colonIdx = trimmed.indexOf(":");
        const namepart = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
        const type = colonIdx >= 0 ? trimmed.slice(colonIdx + 1).trim().toLowerCase() : "";
        const dotIdx = namepart.indexOf(".");
        if (dotIdx < 0) continue;
        const entity = namepart.slice(0, dotIdx).trim();
        const field = namepart.slice(dotIdx + 1).trim();
        if (!entity || !field) continue;
        fields.push({ entity, field, type, locator: `structured-field:${entity}.${field}` });
      }
      return { system, fields };
    });

    const proposals: MappingProposalRecord[] = [];

    // Compare all pairs of systems
    for (let i = 0; i < parsed.length; i++) {
      for (let j = i + 1; j < parsed.length; j++) {
        const sysA = parsed[i]!;
        const sysB = parsed[j]!;

        for (const fa of sysA.fields) {
          for (const fb of sysB.fields) {
            // Exact-name match (case-insensitive)
            if (fa.field.toLowerCase() !== fb.field.toLowerCase()) continue;
            // Type match (if both specified, they must be the same)
            if (fa.type && fb.type && fa.type !== fb.type) continue;

            const confidence = fa.type && fb.type && fa.type === fb.type ? 0.9 : 0.75;

            proposals.push({
              id: `ref-schema-prop.${sysA.system}.${fa.entity}.${fa.field}__${sysB.system}.${fb.entity}.${fb.field}.${Date.now()}`,
              sourceField: { system: sysA.system, entity: fa.entity, field: fa.field, locator: fa.locator },
              targetField: { system: sysB.system, entity: fb.entity, field: fb.field, locator: fb.locator },
              relation: "equivalent",
              evidence: [
                { system: sysA.system, excerpt: `${fa.entity}.${fa.field}${fa.type ? `:${fa.type}` : ""}` },
                { system: sysB.system, excerpt: `${fb.entity}.${fb.field}${fb.type ? `:${fb.type}` : ""}` },
              ],
              confidence,
              rationale: `Reference extractor: exact field-name match "${fa.field}"${fa.type && fb.type ? ` with matching type "${fa.type}"` : ""} across ${sysA.system} and ${sysB.system}.`,
              proposedBy: "reference-schema-extractor",
              proposedAt: now,
            });
          }
        }
      }
    }

    return proposals;
  },
};
