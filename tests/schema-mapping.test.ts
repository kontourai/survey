/**
 * Tests for the schema-mapping (EVIDENCED-ONTOLOGY) producer profile.
 *
 * Coverage:
 *  1. Extractor → proposals
 *  2. Proposals → candidate sets (needs-review, conflict)
 *  3. Review → claim + identity-link pairing
 *  4. End-to-end: two fake system schemas, accept a mapping, build bundle,
 *     call surface resolveInquiry for system B's field via system A's claim,
 *     assert resolution through the link AND that disputing the mapping claim
 *     caps the answer.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IdentityLink, TrustBundle } from "@kontourai/surface";
import { resolveInquiry } from "@kontourai/surface";
import {
  mappingReviewToSurface,
  referenceSchemaExtractor,
  surveySchemaMapping,
} from "../src/index.js";
import type {
  MappingProposalRecord,
  ReviewedMapping,
  SystemFieldRef,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const CRM_SCHEMA = `
Contact.email:string
Contact.phone:string
Contact.revenue:number
Account.name:string
Account.accountRevenue:number
`;

const ERP_SCHEMA = `
Customer.email:string
Customer.phone:string
Customer.totalRevenue:number
Company.name:string
`;

function makeProposalRecord(overrides: Partial<MappingProposalRecord> & {
  id: string;
  sourceField: SystemFieldRef;
  targetField: SystemFieldRef;
}): MappingProposalRecord {
  return {
    relation: "equivalent",
    evidence: [
      { system: overrides.sourceField.system, excerpt: `${overrides.sourceField.entity}.${overrides.sourceField.field}` },
      { system: overrides.targetField.system, excerpt: `${overrides.targetField.entity}.${overrides.targetField.field}` },
    ],
    confidence: 0.85,
    rationale: "test proposal",
    proposedBy: "test-extractor",
    proposedAt: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeReviewedMapping(
  proposal: MappingProposalRecord,
  status: "verified" | "assumed" | "rejected",
): ReviewedMapping {
  const pairKey = [
    `${proposal.sourceField.system}::${proposal.sourceField.entity}::${proposal.sourceField.field}`,
    `${proposal.targetField.system}::${proposal.targetField.entity}::${proposal.targetField.field}`,
  ].sort().join("|");

  const candidateId = `schema-mapping.candidate.${proposal.id}`;
  const candidateSetId = `schema-mapping.candidate-set.${pairKey}`;

  const selectedCandidate = {
    id: candidateId,
    extractionId: `schema-mapping.extraction.${proposal.id}`,
    value: { relation: proposal.relation, targetField: proposal.targetField, conversion: proposal.conversion },
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

  const candidateSet = {
    id: candidateSetId,
    target: `schema-mapping:${pairKey}`,
    candidates: [selectedCandidate],
    selectedCandidateId: candidateId,
    status: "resolved" as const,
    rationale: "test",
    metadata: {
      schemaMapping: {
        pairKey,
        sourceField: proposal.sourceField,
        targetField: proposal.targetField,
      },
    },
  };

  const reviewOutcome = {
    id: `review.${proposal.id}`,
    candidateSetId,
    candidateId,
    status,
    actor: "schema-reviewer",
    reviewedAt: "2026-06-10T12:00:00.000Z",
    rationale: `Test review: ${status}`,
    withinComfortZone: true,
  };

  return { pairKey, candidateSet, selectedCandidate, reviewOutcome, proposal };
}

// ---------------------------------------------------------------------------
// 1. Extractor → proposals
// ---------------------------------------------------------------------------

describe("referenceSchemaExtractor", () => {
  it("produces proposals for exact field-name matches across two systems", async () => {
    const proposals = referenceSchemaExtractor.extract({
      systems: [
        { system: "crm", schemaText: CRM_SCHEMA },
        { system: "erp", schemaText: ERP_SCHEMA },
      ],
    }) as MappingProposalRecord[];

    assert.ok(Array.isArray(proposals));
    assert.ok(proposals.length > 0, "should produce at least one proposal");

    // email matches between crm.Contact and erp.Customer
    const emailProposal = proposals.find(
      (p) =>
        p.sourceField.field === "email" &&
        p.sourceField.system === "crm" &&
        p.targetField.field === "email" &&
        p.targetField.system === "erp",
    );
    assert.ok(emailProposal, "should propose crm.Contact.email → erp.Customer.email");
    assert.equal(emailProposal.relation, "equivalent");
    assert.ok(emailProposal.confidence > 0, "confidence should be positive");
  });

  it("does not propose a match when type tokens differ", async () => {
    const sysA = `Entity.count:number`;
    const sysB = `Record.count:string`;

    const proposals = referenceSchemaExtractor.extract({
      systems: [
        { system: "sysA", schemaText: sysA },
        { system: "sysB", schemaText: sysB },
      ],
    }) as MappingProposalRecord[];

    // Different types → no proposal
    assert.equal(proposals.length, 0);
  });

  it("carries evidence excerpts from both system schemas", async () => {
    const proposals = referenceSchemaExtractor.extract({
      systems: [
        { system: "crm", schemaText: "Contact.email:string" },
        { system: "erp", schemaText: "Customer.email:string" },
      ],
    }) as MappingProposalRecord[];

    assert.equal(proposals.length, 1);
    const p = proposals[0]!;
    assert.ok(p.evidence.some((e) => e.system === "crm"), "should have crm evidence");
    assert.ok(p.evidence.some((e) => e.system === "erp"), "should have erp evidence");
  });

  it("returns empty for schemas with no shared field names", async () => {
    const proposals = referenceSchemaExtractor.extract({
      systems: [
        { system: "a", schemaText: "Foo.bar:string" },
        { system: "b", schemaText: "Baz.qux:string" },
      ],
    }) as MappingProposalRecord[];

    assert.equal(proposals.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. surveySchemaMapping → candidate sets
// ---------------------------------------------------------------------------

describe("surveySchemaMapping", () => {
  it("produces a SurveyInput with one RawSource per system", async () => {
    const result = await surveySchemaMapping(
      { systems: [{ system: "crm", schemaText: CRM_SCHEMA }, { system: "erp", schemaText: ERP_SCHEMA }] },
      referenceSchemaExtractor,
    );

    assert.ok(result.surveyInput.rawSources.some((r) => r.metadata?.system === "crm"), "should have crm raw source");
    assert.ok(result.surveyInput.rawSources.some((r) => r.metadata?.system === "erp"), "should have erp raw source");
    assert.ok(result.surveyInput.rawSources.every((r) => r.kind === "system-schema"), "all raw sources should be system-schema");
  });

  it("produces a needs-review candidate set when proposals agree", async () => {
    const result = await surveySchemaMapping(
      { systems: [{ system: "crm", schemaText: "Contact.email:string" }, { system: "erp", schemaText: "Customer.email:string" }] },
      referenceSchemaExtractor,
    );

    assert.equal(result.candidateSets.length, 1);
    assert.equal(result.candidateSets[0]?.status, "needs-review");
  });

  it("produces a conflict candidate set when proposals disagree on relation", async () => {
    // Use a custom extractor that produces conflicting proposals for the same pair
    const conflictingExtractor = {
      name: "conflicting-extractor",
      extract(): MappingProposalRecord[] {
        const base = {
          sourceField: { system: "crm", entity: "Contact", field: "revenue" },
          targetField: { system: "erp", entity: "Customer", field: "revenue" },
          evidence: [
            { system: "crm", excerpt: "Contact.revenue:number" },
            { system: "erp", excerpt: "Customer.revenue:number" },
          ],
          confidence: 0.8,
          rationale: "test",
          proposedBy: "conflicting-extractor",
          proposedAt: "2026-06-10T00:00:00.000Z",
        };
        return [
          { ...base, id: "p1", relation: "equivalent" },
          { ...base, id: "p2", relation: "converts", conversion: { factor: 1000, note: "USD to cents" } },
        ];
      },
    };

    const result = await surveySchemaMapping(
      { systems: [{ system: "crm", schemaText: "" }, { system: "erp", schemaText: "" }] },
      conflictingExtractor,
    );

    assert.equal(result.candidateSets.length, 1);
    assert.equal(result.candidateSets[0]?.status, "conflict");
  });

  it("auto-accepts proposals at or above the min confidence threshold", async () => {
    const result = await surveySchemaMapping(
      { systems: [{ system: "crm", schemaText: "Contact.email:string" }, { system: "erp", schemaText: "Customer.email:string" }] },
      referenceSchemaExtractor,
      { autoAcceptMinConfidence: 0.8 },
    );

    // email/email with matching types → confidence 0.9 → auto-accepted
    assert.ok(result.surveyInput.reviewOutcomes.length > 0, "should have at least one auto-accept review");
    const autoReview = result.surveyInput.reviewOutcomes.find((r) => r.actor === "auto-accept-policy");
    assert.ok(autoReview, "should have an auto-accept review outcome");
    assert.equal(autoReview?.status, "assumed");
  });

  it("does not auto-accept when confidence is below threshold", async () => {
    const result = await surveySchemaMapping(
      { systems: [{ system: "crm", schemaText: "Contact.email:string" }, { system: "erp", schemaText: "Customer.email:string" }] },
      referenceSchemaExtractor,
      { autoAcceptMinConfidence: 0.99 },
    );

    assert.equal(result.surveyInput.reviewOutcomes.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Review → claim + identity-link pairing
// ---------------------------------------------------------------------------

describe("mappingReviewToSurface — claim and identity-link pairing", () => {
  it("produces a claim for each accepted mapping", () => {
    const proposal = makeProposalRecord({
      id: "p1",
      sourceField: { system: "crm", entity: "Contact", field: "email" },
      targetField: { system: "erp", entity: "Customer", field: "email" },
    });

    const rm = makeReviewedMapping(proposal, "verified");
    const bundle = mappingReviewToSurface([rm]);

    const claim = bundle.claims.find((c) => c.fieldOrBehavior === "maps-to");
    assert.ok(claim, "should have a maps-to claim");
    assert.equal(claim?.subjectType, "system-field");
    assert.equal(claim?.status, "verified");
  });

  it("produces an IdentityLink for each accepted mapping", () => {
    const proposal = makeProposalRecord({
      id: "p1",
      sourceField: { system: "crm", entity: "Contact", field: "email" },
      targetField: { system: "erp", entity: "Customer", field: "email" },
    });

    const rm = makeReviewedMapping(proposal, "verified");
    const bundle = mappingReviewToSurface([rm]);

    assert.ok(Array.isArray(bundle.identityLinks), "should have identityLinks");
    assert.equal((bundle.identityLinks as IdentityLink[]).length, 1);

    const link = (bundle.identityLinks as IdentityLink[])[0]!;
    assert.equal(link.subjects.length, 2);
    assert.ok(
      link.subjects.some((s) => s.subjectId.includes("crm")),
      "link should include crm subject",
    );
    assert.ok(
      link.subjects.some((s) => s.subjectId.includes("erp")),
      "link should include erp subject",
    );
  });

  it("IdentityLink.mappingClaimId points at the maps-to claim", () => {
    const proposal = makeProposalRecord({
      id: "p1",
      sourceField: { system: "crm", entity: "Contact", field: "email" },
      targetField: { system: "erp", entity: "Customer", field: "email" },
    });

    const rm = makeReviewedMapping(proposal, "verified");
    const bundle = mappingReviewToSurface([rm]);

    const link = (bundle.identityLinks as IdentityLink[])[0]!;
    assert.ok(link.mappingClaimId, "link should have mappingClaimId");

    const mappingClaim = bundle.claims.find((c) => c.id === link.mappingClaimId);
    assert.ok(mappingClaim, "mappingClaimId should point at a real claim");
    assert.equal(mappingClaim?.fieldOrBehavior, "maps-to");
  });

  it("IdentityLink carries the relation from the proposal", () => {
    const proposal = makeProposalRecord({
      id: "p1",
      sourceField: { system: "crm", entity: "Contact", field: "revenue" },
      targetField: { system: "erp", entity: "Customer", field: "revenue" },
      relation: "converts",
      conversion: { factor: 0.01, note: "cents to dollars" },
    });

    const rm = makeReviewedMapping(proposal, "assumed");
    const bundle = mappingReviewToSurface([rm]);

    const link = (bundle.identityLinks as IdentityLink[])[0]!;
    assert.equal(link.relation, "converts");
    assert.ok(link.conversion, "link should carry conversion parameters");
    assert.equal((link.conversion as { factor?: number }).factor, 0.01);
  });

  it("omits rejected mappings from the bundle", () => {
    const proposal = makeProposalRecord({
      id: "p1",
      sourceField: { system: "crm", entity: "Contact", field: "email" },
      targetField: { system: "erp", entity: "Customer", field: "email" },
    });

    const rm = makeReviewedMapping(proposal, "rejected");
    const bundle = mappingReviewToSurface([rm]);

    assert.equal(bundle.claims.length, 0);
    assert.equal(bundle.identityLinks, undefined);
  });

  it("produces evidence for each accepted mapping claim", () => {
    const proposal = makeProposalRecord({
      id: "p1",
      sourceField: { system: "crm", entity: "Contact", field: "email" },
      targetField: { system: "erp", entity: "Customer", field: "email" },
    });

    const rm = makeReviewedMapping(proposal, "verified");
    const bundle = mappingReviewToSurface([rm]);

    const claim = bundle.claims.find((c) => c.fieldOrBehavior === "maps-to")!;
    const evidence = bundle.evidence.filter((e) => e.claimId === claim.id);
    assert.ok(evidence.length > 0, "mapping claim should have evidence");
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end: cross-system resolution + weakest-link capping
// ---------------------------------------------------------------------------

describe("end-to-end: cross-system resolveInquiry via IdentityLink", () => {
  /**
   * Scenario:
   *  - System "crm" has a claim about Contact.email (verified).
   *  - System "erp" has NO claim about Customer.email.
   *  - A schema mapping links crm::Contact::email ≡ erp::Customer::email.
   *  - Asking about erp.Customer.email should resolve through the link and
   *    return the crm claim's value, capped by the mapping claim's status.
   */
  function buildEndToEndBundle(mappingStatus: "verified" | "assumed" | "disputed"): TrustBundle {
    // Build a mapping bundle for the link
    const proposal = makeProposalRecord({
      id: "p-e2e",
      sourceField: { system: "crm", entity: "Contact", field: "email" },
      targetField: { system: "erp", entity: "Customer", field: "email" },
    });

    const rm = makeReviewedMapping(proposal, mappingStatus === "disputed" ? "verified" : mappingStatus);
    const mappingBundle = mappingReviewToSurface([rm], {
      source: "schema-mapping.e2e",
      generatedAt: "2026-06-10T00:00:00.000Z",
    });

    // Simulated data claim for crm::Contact::email
    const dataClaimId = "claim.crm.contact.email";
    const dataClaim = {
      id: dataClaimId,
      subjectType: "system-field",
      subjectId: "crm::Contact::email",
      facet: "crm.profile",
      claimType: "data.field",
      fieldOrBehavior: "value",
      value: "alice@example.com",
      status: "verified" as const,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z",
    };

    const dataEvent = {
      id: "event.crm.contact.email.verified",
      claimId: dataClaimId,
      status: "verified" as const,
      actor: "crm-reviewer",
      method: "survey-review",
      evidenceIds: [],
      createdAt: "2026-06-10T00:00:00.000Z",
      verifiedAt: "2026-06-10T00:00:00.000Z",
    };

    // If we want the mapping to appear disputed, add a dispute event for the mapping claim
    const disputeEvents = mappingStatus === "disputed"
      ? mappingBundle.claims
          .filter((c) => c.fieldOrBehavior === "maps-to")
          .map((c) => ({
            id: `event.dispute.${c.id}`,
            claimId: c.id,
            status: "disputed" as const,
            actor: "auditor",
            method: "candidate-escalation",
            evidenceIds: [],
            createdAt: "2026-06-10T20:00:00.000Z", // must be after reviewedAt (12:00) so it sorts as the latest event
            notes: "Mapping disputed: field semantics differ.",
          }))
      : [];

    // Merge: mappingBundle + data claim
    return {
      schemaVersion: 3,
      source: "e2e-test",
      claims: [...mappingBundle.claims, dataClaim],
      evidence: mappingBundle.evidence,
      policies: mappingBundle.policies,
      events: [...mappingBundle.events, dataEvent, ...disputeEvents],
      identityLinks: mappingBundle.identityLinks,
    };
  }

  it("resolves erp.Customer.email via the identity link to crm.Contact.email", () => {
    const bundle = buildEndToEndBundle("verified");

    const inquiry = {
      id: "inquiry.e2e.1",
      question: "What is the email for erp Customer?",
      target: {
        subjectType: "system-field",
        subjectId: "erp::Customer::email",
        fieldOrBehavior: "value",
      },
      askedBy: "test-consumer",
      askedAt: "2026-06-10T08:00:00.000Z",
    };

    const record = resolveInquiry(bundle, inquiry, { now: new Date("2026-06-10T08:00:00.000Z") });

    assert.equal(record.outcome, "matched", "should resolve through the identity link");
    assert.equal(record.answer?.value, "alice@example.com");
    // The mapping claim is verified, so the answer status reflects the data claim
    assert.ok(
      record.answer?.status === "verified" || record.answer?.status === "assumed",
      `expected verified or assumed, got ${record.answer?.status}`,
    );
  });

  it("answer status is capped to disputed when the mapping claim is disputed", () => {
    const bundle = buildEndToEndBundle("disputed");

    const inquiry = {
      id: "inquiry.e2e.2",
      question: "What is the email for erp Customer?",
      target: {
        subjectType: "system-field",
        subjectId: "erp::Customer::email",
        fieldOrBehavior: "value",
      },
      askedBy: "test-consumer",
      askedAt: "2026-06-10T08:00:00.000Z",
    };

    const record = resolveInquiry(bundle, inquiry, { now: new Date("2026-06-10T08:00:00.000Z") });

    // Even though the data claim is verified, the disputed mapping caps the answer
    assert.equal(record.outcome, "matched", "should still resolve (link traversal)");
    assert.equal(record.answer?.status, "disputed", "disputed mapping should cap the answer to disputed");
  });

  it("returns unsupported when no mapping exists for the target system field", () => {
    const bundle = buildEndToEndBundle("verified");

    const inquiry = {
      id: "inquiry.e2e.3",
      question: "What is the phone for erp Customer?",
      target: {
        subjectType: "system-field",
        subjectId: "erp::Customer::phone",
        fieldOrBehavior: "value",
      },
      askedBy: "test-consumer",
      askedAt: "2026-06-10T08:00:00.000Z",
    };

    const record = resolveInquiry(bundle, inquiry, { now: new Date("2026-06-10T08:00:00.000Z") });

    assert.equal(record.outcome, "unsupported", "no mapping → unsupported gap");
  });

  it("full pipeline: two fake system schemas, extract → accept → bundle → resolve", async () => {
    const now = new Date("2026-06-10T09:00:00.000Z");

    // Step 1: Run the extractor on two fake schemas
    const { surveyInput, proposals, candidateSets } = await surveySchemaMapping(
      {
        systems: [
          { system: "crm", schemaText: "Contact.email:string\nContact.phone:string" },
          { system: "erp", schemaText: "Customer.email:string\nCustomer.phone:string" },
        ],
      },
      referenceSchemaExtractor,
    );

    assert.ok(proposals.length >= 2, "should produce at least email and phone proposals");
    assert.ok(candidateSets.length >= 2, "should produce at least two candidate sets");

    // Step 2: Accept the email mapping via review
    const emailPairKey = ["crm::Contact::email", "erp::Customer::email"].sort().join("|");
    const emailCandidateSet = candidateSets.find((cs) =>
      cs.metadata?.schemaMapping &&
      typeof cs.metadata.schemaMapping === "object" &&
      "pairKey" in cs.metadata.schemaMapping &&
      cs.metadata.schemaMapping.pairKey === emailPairKey,
    );
    assert.ok(emailCandidateSet, "should find email candidate set");

    const emailProposal = proposals.find(
      (p) =>
        p.sourceField.field === "email" &&
        p.sourceField.system === "crm" &&
        p.targetField.field === "email" &&
        p.targetField.system === "erp",
    );
    assert.ok(emailProposal, "should find email proposal");

    const emailRM = makeReviewedMapping(emailProposal!, "assumed");
    const mappingBundle = mappingReviewToSurface([emailRM], {
      source: "schema-mapping.pipeline.test",
      generatedAt: now.toISOString(),
    });

    // Verify the bundle has the expected structure
    assert.equal(mappingBundle.claims.filter((c) => c.fieldOrBehavior === "maps-to").length, 1);
    assert.equal((mappingBundle.identityLinks ?? []).length, 1);

    // Step 3: Add a data claim for crm and resolve via erp
    const dataClaimId = "claim.crm.contact.email.pipeline";
    const bundle: TrustBundle = {
      schemaVersion: 3,
      source: "pipeline-test",
      claims: [
        ...mappingBundle.claims,
        {
          id: dataClaimId,
          subjectType: "system-field",
          subjectId: "crm::Contact::email",
          facet: "crm.profile",
          claimType: "data.field",
          fieldOrBehavior: "value",
          value: "bob@example.com",
          status: "assumed",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: now.toISOString(),
        },
      ],
      evidence: mappingBundle.evidence,
      policies: mappingBundle.policies,
      events: [
        ...mappingBundle.events,
        {
          id: "event.crm.contact.email.pipeline.assumed",
          claimId: dataClaimId,
          status: "assumed",
          actor: "crm-operator",
          method: "survey-assumption",
          evidenceIds: [],
          createdAt: now.toISOString(),
          verifiedAt: now.toISOString(),
        },
      ],
      identityLinks: mappingBundle.identityLinks,
    };

    // Step 4: Resolve erp Customer.email via the link
    const record = resolveInquiry(bundle, {
      id: "inquiry.pipeline.1",
      question: "erp Customer email value",
      target: {
        subjectType: "system-field",
        subjectId: "erp::Customer::email",
        fieldOrBehavior: "value",
      },
      askedBy: "pipeline-consumer",
      askedAt: now.toISOString(),
    }, { now });

    assert.equal(record.outcome, "matched");
    assert.equal(record.answer?.value, "bob@example.com");

    // void surveyInput to silence unused warning; we tested its structure above
    void surveyInput;
  });
});
