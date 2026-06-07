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
  REVIEW_PROOF_CONTRACT_VERSION,
  REVIEW_PROOF_PACKAGE_NAME,
  REVIEW_PROOF_SCHEMA,
  REVIEW_PROOF_SCHEMA_VERSION,
} from "../src/index.js";
import type { ReviewProofInput } from "../src/index.js";

describe("review proof helper", () => {
  it("builds a deterministic hash anchor from portable review fields", () => {
    const input = reviewProofInput();
    const payload = buildCanonicalReviewProofPayload(input);
    const repeatedPayload = buildCanonicalReviewProofPayload(structuredClone(input));
    const anchor = buildReviewProofAnchor(input);
    const recomputedHash = createHash("sha256")
      .update(canonicalReviewProofJson(payload))
      .digest("hex");

    assert.equal(canonicalReviewProofJson(repeatedPayload), canonicalReviewProofJson(payload));
    assert.equal(hashCanonicalReviewProofPayload(repeatedPayload), hashCanonicalReviewProofPayload(payload));
    assert.equal(anchor.kind, "hash");
    assert.equal(anchor.algorithm, "sha256");
    assert.equal(anchor.value, recomputedHash);
    assert.equal(anchor.value, hashCanonicalReviewProofPayload(payload));
    assert.equal(anchor.id, `review-proof.${input.claim.id}.${anchor.value.slice(0, 16)}`);
    assert.equal(anchor.sourceRef, input.rawSource.sourceRef);
    assert.equal(anchor.observedAt, input.reviewOutcome?.reviewedAt);
    assert.equal(anchor.verificationStatus, "unverified");
  });

  it("includes explicit stable proof envelope fields", () => {
    const input = reviewProofInput();
    const payload = buildCanonicalReviewProofPayload(input);

    assert.equal(payload.schemaVersion, REVIEW_PROOF_SCHEMA_VERSION);
    assert.deepEqual(payload.proof, {
      schema: REVIEW_PROOF_SCHEMA,
      schemaVersion: REVIEW_PROOF_SCHEMA_VERSION,
      packageName: REVIEW_PROOF_PACKAGE_NAME,
      packageVersion: REVIEW_PROOF_CONTRACT_VERSION,
      issuer: input.claim.collectedBy,
      producer: input.extraction.extractor,
      issuedAt: input.reviewOutcome!.reviewedAt,
      subject: {
        claimId: input.claim.id,
        candidateSetId: input.claim.candidateSetId,
        candidateId: input.candidate.id,
        subjectType: input.claim.subjectType,
        subjectId: input.claim.subjectId,
        surface: input.claim.surface,
        claimType: input.claim.claimType,
        fieldOrBehavior: input.claim.fieldOrBehavior,
      },
      sourcePayload: {
        id: input.rawSource.id,
        sourceRef: input.rawSource.sourceRef,
        checksum: input.rawSource.checksum,
      },
    });
    assert.equal(payload.rawSource.checksum, input.rawSource.checksum);
    assert.equal(payload.extraction.id, input.extraction.id);
    assert.equal(payload.candidate.id, input.candidate.id);
    assert.equal(payload.candidate.value, input.candidate.value);
    assert.equal(payload.candidateSet.selectedCandidateId, input.candidateSet.selectedCandidateId);
    assert.equal(payload.reviewOutcome?.status, input.reviewOutcome?.status);
    assert.equal(payload.reviewOutcome?.actor, input.reviewOutcome?.actor);
    assert.equal(payload.reviewOutcome?.reviewedAt, input.reviewOutcome?.reviewedAt);
  });

  it("uses the reviewed candidate id in the proof subject when the claim omits candidateId", () => {
    const input = reviewProofInput();
    const payload = buildCanonicalReviewProofPayload({
      ...input,
      claim: { ...input.claim, candidateId: undefined },
    });

    assert.equal(payload.proof.subject.candidateId, input.candidate.id);
    assert.equal(payload.claim.candidateId, undefined);
  });

  it("rejects contradictory claim and reviewed candidate identities", () => {
    const input = reviewProofInput();

    assert.throws(
      () =>
        buildCanonicalReviewProofPayload({
          ...input,
          claim: { ...input.claim, candidateId: "candidate.registration-status.inactive" },
        }),
      /does not match reviewed candidate id/,
    );
  });

  it("rejects internally contradictory review graph identities", () => {
    const input = reviewProofInput();

    assert.throws(
      () =>
        buildCanonicalReviewProofPayload({
          ...input,
          reviewOutcome: { ...input.reviewOutcome!, candidateId: "candidate.registration-status.inactive" },
        }),
      /review outcome candidateId "candidate\.registration-status\.inactive" does not match reviewed candidate id/,
    );
    assert.throws(
      () =>
        buildCanonicalReviewProofPayload({
          ...input,
          candidateSet: { ...input.candidateSet, candidates: [] },
        }),
      /candidate id "candidate\.registration-status\.active" is not present in candidate set/,
    );
    assert.throws(
      () =>
        buildCanonicalReviewProofPayload({
          ...input,
          candidateSet: {
            ...input.candidateSet,
            candidates: [
              ...input.candidateSet.candidates,
              { ...input.candidate, id: "candidate.registration-status.inactive" },
            ],
            selectedCandidateId: "candidate.registration-status.inactive",
          },
        }),
      /candidate set selectedCandidateId "candidate\.registration-status\.inactive" does not match reviewed candidate id/,
    );
    assert.throws(
      () =>
        buildCanonicalReviewProofPayload({
          ...input,
          claim: { ...input.claim, candidateSetId: "candidate-set.entity-1.other-field" },
        }),
      /claim candidateSetId "candidate-set\.entity-1\.other-field" does not match candidate set id/,
    );
    assert.throws(
      () =>
        buildCanonicalReviewProofPayload({
          ...input,
          reviewOutcome: { ...input.reviewOutcome!, candidateSetId: "candidate-set.entity-1.other-field" },
        }),
      /review outcome candidateSetId "candidate-set\.entity-1\.other-field" does not match candidate set id/,
    );
    assert.throws(
      () =>
        buildCanonicalReviewProofPayload({
          ...input,
          candidate: { ...input.candidate, extractionId: "extraction.entity-1.other-field" },
        }),
      /candidate extractionId "extraction\.entity-1\.other-field" does not match extraction id/,
    );
    assert.throws(
      () =>
        buildCanonicalReviewProofPayload({
          ...input,
          extraction: { ...input.extraction, sourceId: "source.entity-1.other-field" },
        }),
      /extraction sourceId "source\.entity-1\.other-field" does not match raw source id/,
    );
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

  it("changes hash when source identity or checksum changes", () => {
    const input = reviewProofInput();
    const original = buildReviewProofAnchor(input);

    const sourceIdMutated = buildReviewProofAnchor({
      ...input,
      rawSource: { ...input.rawSource, id: "source.entity-1.registration-status.registry.v2" },
      extraction: { ...input.extraction, sourceId: "source.entity-1.registration-status.registry.v2" },
    });
    const checksumMutated = buildReviewProofAnchor({
      ...input,
      rawSource: { ...input.rawSource, checksum: "sha256:updated-public-payload" },
    });

    assert.notEqual(sourceIdMutated.value, original.value);
    assert.notEqual(checksumMutated.value, original.value);
  });

  it("changes hash when candidate identity or value changes", () => {
    const input = reviewProofInput();
    const original = buildReviewProofAnchor(input);

    const candidateIdMutated = buildReviewProofAnchor({
      ...input,
      candidate: { ...input.candidate, id: "candidate.registration-status.inactive" },
      candidateSet: {
        ...input.candidateSet,
        candidates: [
          { ...input.candidateSet.candidates[0]!, id: "candidate.registration-status.inactive" },
        ],
        selectedCandidateId: "candidate.registration-status.inactive",
      },
      reviewOutcome: { ...input.reviewOutcome!, candidateId: "candidate.registration-status.inactive" },
      claim: { ...input.claim, candidateId: "candidate.registration-status.inactive" },
    });
    const candidateValueMutated = buildReviewProofAnchor({
      ...input,
      candidate: { ...input.candidate, value: "INACTIVE" },
    });

    assert.notEqual(candidateIdMutated.value, original.value);
    assert.notEqual(candidateValueMutated.value, original.value);
  });

  it("changes hash when review actor, review time, or decision changes", () => {
    const input = reviewProofInput();
    const original = buildReviewProofAnchor(input);

    const actorMutated = buildReviewProofAnchor({
      ...input,
      reviewOutcome: { ...input.reviewOutcome!, actor: "second-reviewer" },
    });
    const reviewedAtMutated = buildReviewProofAnchor({
      ...input,
      reviewOutcome: { ...input.reviewOutcome!, reviewedAt: "2026-05-31T16:05:00.000Z" },
    });
    const statusMutated = buildReviewProofAnchor({
      ...input,
      reviewOutcome: { ...input.reviewOutcome!, status: "rejected" },
    });

    assert.notEqual(actorMutated.value, original.value);
    assert.notEqual(reviewedAtMutated.value, original.value);
    assert.notEqual(statusMutated.value, original.value);
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
