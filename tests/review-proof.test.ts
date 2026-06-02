import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  buildCanonicalReviewProofPayload,
  buildReviewProofAnchor,
  candidateReviewRecord,
  canonicalReviewProofJson,
  fieldObservation,
  hashCanonicalReviewProofPayload,
} from "../src/index.js";
import type { ReviewProofInput } from "../src/index.js";

describe("review proof helper", () => {
  it("builds a deterministic hash anchor from portable review fields", () => {
    const input = reviewProofInput();
    const payload = buildCanonicalReviewProofPayload(input);
    const anchor = buildReviewProofAnchor(input);
    const recomputedHash = createHash("sha256")
      .update(canonicalReviewProofJson(payload))
      .digest("hex");

    assert.equal(anchor.kind, "hash");
    assert.equal(anchor.algorithm, "sha256");
    assert.equal(anchor.value, recomputedHash);
    assert.equal(anchor.value, hashCanonicalReviewProofPayload(payload));
    assert.equal(anchor.id, `review-proof.${input.claim.id}.${anchor.value.slice(0, 16)}`);
    assert.equal(anchor.sourceRef, input.rawSource.sourceRef);
    assert.equal(anchor.observedAt, input.reviewOutcome?.reviewedAt);
    assert.equal(anchor.verificationStatus, "unverified");
  });

  it("excludes producer metadata from the canonical payload", () => {
    const input = reviewProofInput();
    const payloadJson = canonicalReviewProofJson(buildCanonicalReviewProofPayload(input));

    assert.equal(payloadJson.includes("metadata"), false);
    assert.equal(payloadJson.includes("private-source-context"), false);
    assert.equal(payloadJson.includes("private-extraction-context"), false);
    assert.equal(payloadJson.includes("private-candidate-context"), false);
    assert.equal(payloadJson.includes("private-set-context"), false);
    assert.equal(payloadJson.includes("private-review-context"), false);
    assert.equal(payloadJson.includes("private-claim-context"), false);
    assert.equal(payloadJson.includes("private-edge-context"), false);
  });

  it("changes hash when a canonical review field changes", () => {
    const input = reviewProofInput();
    const original = buildReviewProofAnchor(input);
    const mutated = buildReviewProofAnchor({
      ...input,
      reviewOutcome: {
        ...input.reviewOutcome!,
        rationale: "Updated rationale after second review.",
      },
    });

    assert.notEqual(mutated.value, original.value);
    assert.notEqual(mutated.id, original.id);
  });

  it("changes hash when a canonical claim interpretation field changes", () => {
    const input = reviewProofInput();
    const original = buildReviewProofAnchor(input);
    const mutated = buildReviewProofAnchor({
      ...input,
      claim: {
        ...input.claim,
        impactLevel: "high",
      },
    });

    assert.notEqual(mutated.value, original.value);
    assert.notEqual(mutated.id, original.id);
  });

  it("preserves hostile keys as canonical data without prototype mutation", () => {
    const payload = buildCanonicalReviewProofPayload(reviewProofInput());
    const hostileValue: Record<string, unknown> = { constructor: "constructor-data" };
    payload.claim.value = { stable: true };
    Object.defineProperty(hostileValue, "__proto__", {
      value: "proto-data",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(payload.claim.value as Record<string, unknown>, "__proto__", {
      value: "nested-proto-data",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(payload.claim.value as Record<string, unknown>, "constructor", {
      value: hostileValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const canonicalJson = canonicalReviewProofJson(payload);

    assert.match(canonicalJson, /"__proto__":"nested-proto-data"/);
    assert.match(canonicalJson, /"constructor":\{"__proto__":"proto-data","constructor":"constructor-data"\}/);
    assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  });
});

function reviewProofInput(): ReviewProofInput {
  const records = candidateReviewRecord({
    id: "candidate-set.entity-1.registration-status",
    target: "registrationStatus",
    selectedCandidateId: "candidate.registration-status.active",
    status: "resolved",
    rationale: "Operator selected the registry value.",
    metadata: { privateSetContext: "private-set-context" },
    reviewOutcome: {
      id: "review.registration-status.active",
      status: "verified",
      actor: "records-operator",
      reviewedAt: "2026-05-31T15:05:00.000Z",
      rationale: "Registry source is authoritative for this field.",
      evidenceIds: ["evidence.registration-status.registry"],
      metadata: { privateReviewContext: "private-review-context" },
    },
    observations: [
      fieldObservation({
        id: "observation.entity-1.registration-status.registry",
        field: "registrationStatus",
        value: "ACTIVE",
        rawSource: {
          kind: "api-record",
          sourceRef: "public-records://entity/entity-1",
          observedAt: "2026-05-31T15:00:00.000Z",
          locatorScheme: "structured-field",
          metadata: { privateSourceContext: "private-source-context" },
        },
        extraction: {
          confidence: 0.97,
          locator: "json:$.registrationStatus",
          extractor: "public-record-importer",
          extractedAt: "2026-05-31T15:00:00.000Z",
          metadata: { privateExtractionContext: "private-extraction-context" },
        },
        candidate: {
          id: "candidate.registration-status.active",
          confidence: 0.97,
          sourceRank: 1,
          metadata: { privateCandidateContext: "private-candidate-context" },
        },
        claim: {
          id: "claim.entity-1.registration-status.registry",
          subjectType: "public-record.entity",
          subjectId: "entity-1",
          surface: "public-record.profile",
          claimType: "public-data.field",
          status: "verified",
          impactLevel: "medium",
          createdAt: "2026-05-31T15:01:00.000Z",
          updatedAt: "2026-05-31T15:05:00.000Z",
          evidenceType: "source_excerpt",
          evidenceMethod: "extraction",
          confidenceBasis: {
            sourceQuality: "strong",
            extractionConfidence: 0.97,
            reviewerAuthority: "operator",
            evidenceStrength: "strong",
            impactLevel: "medium",
          },
          derivedFrom: ["claim.entity-1.registration-source.registry"],
          derivationEdges: [
            {
              inputClaimId: "claim.entity-1.registration-source.registry",
              method: "copy",
              role: "supporting-source",
              supportStrength: "strong",
              rationale: "Registry status was copied from the supporting source claim.",
              metadata: { privateEdgeContext: "private-edge-context" },
            },
          ],
          collectedBy: "public-record-importer",
          actor: "records-operator",
          eventMethod: "operator-review",
          metadata: { privateClaimContext: "private-claim-context" },
        },
      }),
    ],
  });
  const record = records[0]!;
  const candidate = record.candidateSet.candidates[0]!;

  return {
    rawSource: record.rawSource,
    extraction: record.extraction,
    candidate,
    candidateSet: record.candidateSet,
    reviewOutcome: record.reviewOutcome,
    claim: record.claim,
  };
}
