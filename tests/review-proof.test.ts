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
  validateAuthorizing,
  verifyCanonicalReviewProofPayload,
} from "../src/index.js";
import type { CanonicalReviewProofPayload, ReviewAuthorizing, ReviewProofInput } from "../src/index.js";

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
        facet: input.claim.facet,
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

  it("preserves all ReviewAuthorizing variants through canonical JSON verification and readback", () => {
    const cases: Array<{ name: string; authorizing: ReviewAuthorizing }> = [
      {
        name: "explicit statement with source",
        authorizing: {
          kind: "explicit-statement",
          statement: "I confirm this reviewed value for downstream use.",
          source: "operator-attestation",
        },
      },
      {
        name: "exchange with source",
        authorizing: {
          kind: "exchange",
          prompt: "Should this reviewed value be accepted?",
          response: "Yes, accept this reviewed value.",
          source: "review-exchange",
        },
      },
      {
        name: "authorized action with authority reference",
        authorizing: {
          kind: "authorized-action",
          promptRef: "review-prompt://registration-status/approve",
          renderedPrompt: "Approve the reviewed registration status?",
          action: "affirmed-control",
          authorityRef: "authority-trace://review-session/registration-status",
        },
      },
    ];

    for (const { name, authorizing } of cases) {
      assert.deepEqual(validateAuthorizing(authorizing), [], `${name} fixture must be admissible`);
      const input = reviewProofInput();
      input.reviewOutcome = {
        ...input.reviewOutcome!,
        evidenceIds: ["evidence.registration-status.secondary", "evidence.registration-status.registry"],
        authorizing,
      };

      const payload = buildCanonicalReviewProofPayload(input);
      assert.equal(payload.schemaVersion, 3, `${name} must use the v3 envelope`);
      const hash = hashCanonicalReviewProofPayload(payload);
      const parsed = JSON.parse(canonicalReviewProofJson(payload)) as CanonicalReviewProofPayload;

      assert.equal(parsed.schemaVersion, 3);
      assert.equal(verifyCanonicalReviewProofPayload(parsed, hash), true, `${name} must verify after JSON readback`);
      assert.deepEqual(parsed.reviewOutcome?.authorizing, authorizing, `${name} must survive readback losslessly`);
      assert.deepEqual(parsed.reviewOutcome?.evidenceIds, [
        "evidence.registration-status.registry",
        "evidence.registration-status.secondary",
      ]);
      if (authorizing.kind === "explicit-statement" || authorizing.kind === "exchange") {
        assert.equal(parsed.reviewOutcome?.authorizing?.source, authorizing.source);
      } else {
        assert.equal(parsed.reviewOutcome?.authorizing?.authorityRef, authorizing.authorityRef);
      }
    }
  });

  it("rejects invalid ReviewAuthorizing at canonical projection", () => {
    const input = reviewProofInput();
    input.reviewOutcome = {
      ...input.reviewOutcome!,
      authorizing: {
        kind: "exchange",
        prompt: "Should this reviewed value be accepted?",
      } as ReviewAuthorizing,
    };

    assert.throws(
      () => buildCanonicalReviewProofPayload(input),
      /canonical review proof.*invalid authorizing|invalid authorizing.*canonical review proof/i,
    );
  });

  it("snapshots state-changing builder authorizing before validation and projection", () => {
    let statementReads = 0;
    const authorizing = new Proxy(
      { kind: "explicit-statement", statement: "unused" },
      {
        get(target, property, receiver) {
          if (property === "statement") {
            statementReads += 1;
            return statementReads === 1 ? "ok" : "";
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as ReviewAuthorizing;
    const input = reviewProofInput();
    input.reviewOutcome = { ...input.reviewOutcome!, authorizing };

    const payload = buildCanonicalReviewProofPayload(input);

    assert.equal(payload.reviewOutcome?.authorizing?.kind, "explicit-statement");
    assert.equal(payload.reviewOutcome?.authorizing?.statement, "ok");
    assert.equal(statementReads, 1);
  });

  it("rejects malformed optional source values at canonical projection", () => {
    const authorizingCases: unknown[] = [
      { kind: "explicit-statement", statement: "Confirmed.", source: 42 },
      { kind: "explicit-statement", statement: "Confirmed.", source: {} },
      { kind: "explicit-statement", statement: "Confirmed.", source: "" },
      { kind: "explicit-statement", statement: "Confirmed.", source: "   " },
      { kind: "exchange", prompt: "Is this correct?", response: "Yes.", source: 42 },
      { kind: "exchange", prompt: "Is this correct?", response: "Yes.", source: {} },
      { kind: "exchange", prompt: "Is this correct?", response: "Yes.", source: "" },
      { kind: "exchange", prompt: "Is this correct?", response: "Yes.", source: "   " },
    ];

    for (const authorizing of authorizingCases) {
      const input = reviewProofInput();
      input.reviewOutcome = {
        ...input.reviewOutcome!,
        authorizing: authorizing as ReviewAuthorizing,
      };
      assert.throws(
        () => buildCanonicalReviewProofPayload(input),
        /canonical review proof.*invalid authorizing|invalid authorizing.*canonical review proof/i,
      );
    }
  });

  it("verifies a persisted v1 payload without authorizing", () => {
    assert.equal(verifyCanonicalReviewProofPayload(LEGACY_V1_PAYLOAD, LEGACY_V1_HASH), true);
    assert.equal("authorizing" in LEGACY_V1_PAYLOAD.reviewOutcome!, false);
    assert.equal(buildCanonicalReviewProofPayload(reviewProofInput()).schemaVersion, 3);
  });

  it("verifies persisted v2 proofs and emits v3 proofs that commit could-not-confirm details", () => {
    assert.equal(verifyCanonicalReviewProofPayload(LEGACY_V2_PAYLOAD, LEGACY_V2_HASH), true);

    const input = reviewProofInput();
    input.reviewOutcome = {
      ...input.reviewOutcome!,
      status: "proposed",
      resolution: "could_not_confirm",
      resolutionReason: "The registry timed out after two independent attempts.",
      attemptEvidenceIds: ["attempt.second", "attempt.first"],
    };
    input.claim = { ...input.claim, status: "proposed" };
    const payload = buildCanonicalReviewProofPayload(input);
    const hash = hashCanonicalReviewProofPayload(payload);

    assert.equal(payload.schemaVersion, 3);
    assert.equal(payload.reviewOutcome?.resolution, "could_not_confirm");
    assert.equal(payload.reviewOutcome?.resolutionReason, "The registry timed out after two independent attempts.");
    assert.deepEqual(payload.reviewOutcome?.attemptEvidenceIds, ["attempt.first", "attempt.second"]);
    assert.equal(verifyCanonicalReviewProofPayload(payload, hash), true);

    const tampered = structuredClone(payload);
    tampered.reviewOutcome!.resolutionReason = "No attempt was made.";
    assert.equal(verifyCanonicalReviewProofPayload(tampered, hash), false);
  });

  it("rejects invalid could-not-confirm proof combinations", () => {
    for (const reviewOutcome of [
      { status: "proposed" as const, resolutionReason: "   " },
      { status: "verified" as const, resolutionReason: "Source unavailable." },
      { status: "rejected" as const, resolutionReason: "Source unavailable." },
    ]) {
      const input = reviewProofInput();
      input.reviewOutcome = {
        ...input.reviewOutcome!,
        ...reviewOutcome,
        resolution: "could_not_confirm",
      };
      assert.throws(() => buildCanonicalReviewProofPayload(input), /could_not_confirm/);
    }
  });

  it("rejects contradictory explicit resolution/status proof combinations", () => {
    for (const { resolution, status } of [
      { resolution: "accepted" as const, status: "rejected" as const },
      { resolution: "accepted" as const, status: "proposed" as const },
      { resolution: "rejected" as const, status: "verified" as const },
      { resolution: "held" as const, status: "rejected" as const },
    ]) {
      const input = reviewProofInput();
      input.reviewOutcome = { ...input.reviewOutcome!, resolution, status };
      assert.throws(
        () => buildCanonicalReviewProofPayload(input),
        new RegExp(`resolution ${resolution} cannot use status ${status}`),
      );
    }
  });

  it("rejects hybrid review proof version envelopes and v1 authorizing", () => {
    const malformedPayloads: unknown[] = [
      withLegacyEnvelope({ proofSchemaVersion: 2 }),
      withLegacyEnvelope({ outerSchemaVersion: 2 }),
      withLegacyEnvelope({ packageVersion: "2" }),
      withLegacyEnvelope({ outerSchemaVersion: 2, proofSchemaVersion: 2, packageVersion: "1" }),
      withLegacyEnvelope({ outerSchemaVersion: 4, proofSchemaVersion: 4, packageVersion: "4" }),
      withLegacyEnvelope({
        authorizing: {
          kind: "explicit-statement",
          statement: "This field was never part of the v1 contract.",
        },
      }),
    ];

    for (const malformed of malformedPayloads) {
      const matchingMalformedHash = hashUnknownCanonicalPayload(malformed);
      assert.equal(
        verifyCanonicalReviewProofPayload(malformed as CanonicalReviewProofPayload, matchingMalformedHash),
        false,
        "invalid envelopes must be rejected even when their malformed bytes match the supplied hash",
      );
    }
  });

  it("rejects persisted authorizing with numeric or object source despite a matching hash", () => {
    const validAuthorizing: ReviewAuthorizing[] = [
      { kind: "explicit-statement", statement: "Confirmed." },
      { kind: "exchange", prompt: "Is this correct?", response: "Yes." },
    ];
    const malformedSources: unknown[] = [42, { channel: "review" }];

    for (const authorizing of validAuthorizing) {
      for (const source of malformedSources) {
        const input = reviewProofInput();
        input.reviewOutcome = { ...input.reviewOutcome!, authorizing };
        const payload = buildCanonicalReviewProofPayload(input);
        assert.equal(payload.schemaVersion, 3);
        if (!payload.reviewOutcome?.authorizing) {
          throw new Error("expected a canonical v3 authorizing payload");
        }
        (payload.reviewOutcome.authorizing as unknown as Record<string, unknown>).source = source;
        const matchingMalformedHash = hashUnknownCanonicalPayload(payload);

        assert.equal(verifyCanonicalReviewProofPayload(payload, matchingMalformedHash), false);
      }
    }
  });

  it("fails verification for the state-changing authorizing proxy reproduction", () => {
    const input = reviewProofInput();
    input.reviewOutcome = {
      ...input.reviewOutcome!,
      authorizing: { kind: "explicit-statement", statement: "ok" },
    };
    const payload = buildCanonicalReviewProofPayload(input);
    assert.equal(payload.schemaVersion, 3);
    if (!payload.reviewOutcome) {
      throw new Error("expected a canonical v3 review outcome");
    }

    const invalidPayload = structuredClone(payload);
    assert.equal(invalidPayload.schemaVersion, 3);
    if (invalidPayload.reviewOutcome?.authorizing?.kind !== "explicit-statement") {
      throw new Error("expected an explicit-statement fixture");
    }
    invalidPayload.reviewOutcome.authorizing.statement = "";
    const invalidHash = hashUnknownCanonicalPayload(invalidPayload);

    let statementReads = 0;
    payload.reviewOutcome.authorizing = new Proxy(
      { kind: "explicit-statement", statement: "unused" },
      {
        get(target, property, receiver) {
          if (property === "statement") {
            statementReads += 1;
            return statementReads <= 3 ? "ok" : "";
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as ReviewAuthorizing;

    assert.equal(verifyCanonicalReviewProofPayload(payload, invalidHash), false);
    assert.equal(statementReads, 1);
  });

  it("fails verification when canonical authorizing is tampered after hashing", () => {
    const mutations: Array<{
      authorizing: ReviewAuthorizing;
      mutate: (authorizing: ReviewAuthorizing) => void;
    }> = [
      {
        authorizing: { kind: "explicit-statement", statement: "I approve this reviewed value." },
        mutate: (authorizing) => {
          if (authorizing.kind === "explicit-statement") authorizing.statement = "I reject this reviewed value.";
        },
      },
      {
        authorizing: {
          kind: "exchange",
          prompt: "Accept this reviewed value?",
          response: "Accept it.",
        },
        mutate: (authorizing) => {
          if (authorizing.kind === "exchange") authorizing.response = "Do not accept it.";
        },
      },
      {
        authorizing: {
          kind: "authorized-action",
          promptRef: "review-prompt://registration-status/approve",
          renderedPrompt: "Approve this reviewed value?",
          action: "typed",
          authorityRef: "authority-trace://review-session/original",
        },
        mutate: (authorizing) => {
          if (authorizing.kind === "authorized-action") {
            authorizing.authorityRef = "authority-trace://review-session/substituted";
          }
        },
      },
    ];

    for (const { authorizing, mutate } of mutations) {
      const input = reviewProofInput();
      input.reviewOutcome = { ...input.reviewOutcome!, authorizing };
      const payload = buildCanonicalReviewProofPayload(input);
      assert.equal(payload.schemaVersion, 3);
      const capturedHash = hashCanonicalReviewProofPayload(payload);
      const tampered = structuredClone(payload);
      assert.ok(tampered.reviewOutcome?.authorizing);
      mutate(tampered.reviewOutcome.authorizing);

      assert.equal(verifyCanonicalReviewProofPayload(tampered, capturedHash), false);
    }
  });

  it("canonical authorizing object insertion order does not affect verification", () => {
    const input = reviewProofInput();
    input.reviewOutcome = {
      ...input.reviewOutcome!,
      authorizing: {
        kind: "exchange",
        prompt: "  Preserve this prompt exactly?  ",
        response: "Yes — preserve spacing and punctuation exactly.",
        source: "review-exchange",
      },
    };
    const payload = buildCanonicalReviewProofPayload(input);
    assert.equal(payload.schemaVersion, 3);
    const hash = hashCanonicalReviewProofPayload(payload);
    const reordered = structuredClone(payload);
    assert.ok(reordered.reviewOutcome?.authorizing?.kind === "exchange");
    reordered.reviewOutcome.authorizing = {
      source: reordered.reviewOutcome.authorizing.source,
      response: reordered.reviewOutcome.authorizing.response,
      prompt: reordered.reviewOutcome.authorizing.prompt,
      kind: "exchange",
    };

    assert.equal(verifyCanonicalReviewProofPayload(reordered, hash), true);
    assert.equal(reordered.reviewOutcome.authorizing.prompt, "  Preserve this prompt exactly?  ");
  });

  it("returns false for supported review proof envelopes that cannot be canonicalized", () => {
    const cyclicPayload = buildCanonicalReviewProofPayload(reviewProofInput());
    const cyclicValue: Record<string, unknown> = {};
    cyclicValue.self = cyclicValue;
    cyclicPayload.claim.value = cyclicValue;

    const bigIntPayload = buildCanonicalReviewProofPayload(reviewProofInput());
    bigIntPayload.claim.value = 1n;

    const throwingGetterPayload = buildCanonicalReviewProofPayload(reviewProofInput());
    Object.defineProperty(throwingGetterPayload.claim, "value", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("fixture getter must not escape boolean verification");
      },
    });

    const throwingEnvelopePayload = new Proxy(
      buildCanonicalReviewProofPayload(reviewProofInput()),
      {
        get(target, property, receiver) {
          if (property === "proof") {
            throw new Error("fixture envelope getter must not escape boolean verification");
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    for (const payload of [cyclicPayload, bigIntPayload, throwingGetterPayload, throwingEnvelopePayload]) {
      let result: boolean | undefined;
      assert.doesNotThrow(() => {
        result = verifyCanonicalReviewProofPayload(payload, "not-a-matching-hash");
      });
      assert.equal(result, false);
    }
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

const LEGACY_V1_CANONICAL_JSON = '{"candidate":{"extractionId":"extraction.fixture.status","id":"candidate.fixture.status","value":"ACTIVE"},"candidateSet":{"candidateIds":["candidate.fixture.status"],"id":"candidate-set.fixture.status","selectedCandidateId":"candidate.fixture.status","status":"resolved","target":"status"},"claim":{"candidateId":"candidate.fixture.status","candidateSetId":"candidate-set.fixture.status","claimType":"fixture.field","collectedBy":"fixture-producer","facet":"fixture.profile","fieldOrBehavior":"status","id":"claim.fixture.status","impactLevel":"medium","status":"verified","subjectId":"fixture-1","subjectType":"fixture-record","value":"ACTIVE"},"extraction":{"extractedAt":"2026-01-02T03:01:00.000Z","extractor":"fixture-extractor","id":"extraction.fixture.status","locator":"json:$.status","sourceId":"source.fixture.status","target":"status","value":"ACTIVE"},"proof":{"issuedAt":"2026-01-02T03:04:05.000Z","issuer":"fixture-producer","packageName":"@kontourai/survey","packageVersion":"1","producer":"fixture-extractor","schema":"survey.review-proof","schemaVersion":1,"sourcePayload":{"checksum":"sha256:legacy-fixture","id":"source.fixture.status","sourceRef":"fixture://record/status"},"subject":{"candidateId":"candidate.fixture.status","candidateSetId":"candidate-set.fixture.status","claimId":"claim.fixture.status","claimType":"fixture.field","facet":"fixture.profile","fieldOrBehavior":"status","subjectId":"fixture-1","subjectType":"fixture-record"}},"rawSource":{"checksum":"sha256:legacy-fixture","id":"source.fixture.status","kind":"api-record","locatorScheme":"structured-field","observedAt":"2026-01-02T03:00:00.000Z","sourceRef":"fixture://record/status"},"reviewOutcome":{"actor":"fixture-reviewer","candidateId":"candidate.fixture.status","candidateSetId":"candidate-set.fixture.status","evidenceIds":["evidence.fixture.status"],"id":"review.fixture.status","reviewedAt":"2026-01-02T03:04:05.000Z","status":"verified"},"schemaVersion":1}';
const LEGACY_V1_HASH = "7d52f65d7d1c72f1ce8d5a9412f46a42a277a13247ca951d028b2d1db1a4fe78";
const LEGACY_V1_PAYLOAD = deepFreeze(
  JSON.parse(LEGACY_V1_CANONICAL_JSON) as CanonicalReviewProofPayload,
);

// Captured by running the unmodified HEAD (v2) builder from an isolated
// `git archive HEAD`, not by downgrading a v3 payload.
const LEGACY_V2_CANONICAL_JSON = '{"candidate":{"confidence":0.9,"extractionId":"extraction.v2.fixture","id":"candidate.v2.fixture","sourceRank":1,"value":"ACTIVE"},"candidateSet":{"candidateIds":["candidate.v2.fixture"],"id":"candidate-set.v2.fixture","rationale":"Selected fixture value.","selectedCandidateId":"candidate.v2.fixture","status":"resolved","target":"status"},"claim":{"candidateId":"candidate.v2.fixture","candidateSetId":"candidate-set.v2.fixture","claimType":"fixture.field","collectedBy":"fixture-producer","facet":"fixture.profile","fieldOrBehavior":"status","id":"claim.v2.fixture","impactLevel":"medium","status":"verified","subjectId":"fixture-v2","subjectType":"fixture-record","value":"ACTIVE"},"extraction":{"confidence":0.9,"excerpt":"Status is ACTIVE.","extractedAt":"2026-01-02T03:01:00.000Z","extractor":"fixture-extractor","id":"extraction.v2.fixture","locator":"json:$.status","sourceId":"source.v2.fixture","target":"status","value":"ACTIVE"},"proof":{"issuedAt":"2026-01-02T03:04:05.000Z","issuer":"fixture-producer","packageName":"@kontourai/survey","packageVersion":"2","producer":"fixture-extractor","schema":"survey.review-proof","schemaVersion":2,"sourcePayload":{"checksum":"sha256:v2-fixture","id":"source.v2.fixture","sourceRef":"fixture://v2/status"},"subject":{"candidateId":"candidate.v2.fixture","candidateSetId":"candidate-set.v2.fixture","claimId":"claim.v2.fixture","claimType":"fixture.field","facet":"fixture.profile","fieldOrBehavior":"status","subjectId":"fixture-v2","subjectType":"fixture-record"}},"rawSource":{"checksum":"sha256:v2-fixture","id":"source.v2.fixture","kind":"api-record","locatorScheme":"structured-field","observedAt":"2026-01-02T03:00:00.000Z","sourceRef":"fixture://v2/status"},"reviewOutcome":{"actor":"fixture-reviewer","authorizing":{"kind":"explicit-statement","source":"fixture-attestation","statement":"I confirm the v2 fixture."},"candidateId":"candidate.v2.fixture","candidateSetId":"candidate-set.v2.fixture","evidenceIds":["evidence.v2.primary","evidence.v2.secondary"],"id":"review.v2.fixture","rationale":"Confirmed from fixture.","reviewedAt":"2026-01-02T03:04:05.000Z","status":"verified"},"schemaVersion":2}';
const LEGACY_V2_HASH = "2ceaa561977003401103e774dcc0a08cc761b96c7783b2574fe32e1cb104039e";
const LEGACY_V2_PAYLOAD = deepFreeze(
  JSON.parse(LEGACY_V2_CANONICAL_JSON) as CanonicalReviewProofPayload,
);

function withLegacyEnvelope(options: {
  outerSchemaVersion?: number;
  proofSchemaVersion?: number;
  packageVersion?: string;
  authorizing?: ReviewAuthorizing;
}): unknown {
  const payload = structuredClone(LEGACY_V1_PAYLOAD) as unknown as {
    schemaVersion: number;
    proof: { schemaVersion: number; packageVersion: string };
    reviewOutcome: Record<string, unknown>;
  };
  payload.schemaVersion = options.outerSchemaVersion ?? 1;
  payload.proof.schemaVersion = options.proofSchemaVersion ?? 1;
  payload.proof.packageVersion = options.packageVersion ?? "1";
  if (options.authorizing) payload.reviewOutcome.authorizing = options.authorizing;
  return payload;
}

function hashUnknownCanonicalPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeUnknown(payload))).digest("hex");
}

function canonicalizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeUnknown);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonicalizeUnknown((value as Record<string, unknown>)[key])]),
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

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
          facet: "public-record.profile",
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
