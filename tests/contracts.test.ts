import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTrustReport, validateTrustInput } from "@kontourai/surface";
import { correctedDocumentCandidatesFixture } from "../fixtures/corrected-document-candidates.js";
import { publicFieldReviewFixture } from "../fixtures/public-field-review.js";
import {
  buildSurveyTrustInput,
  candidateReviewRecord,
  fieldObservation,
  repeatedObservation,
  SurveyInputBuilder,
} from "../src/index.js";

describe("Survey Surface projection", () => {
  it("projects a reviewed public field into valid Surface trust input", () => {
    const input = buildSurveyTrustInput(publicFieldReviewFixture);
    const valid = validateTrustInput(input);
    const report = buildTrustReport(valid);

    assert.equal(report.claims.length, 2);
    assert.equal(report.evidence.length, 2);
    assert.equal(report.summary.byStatus.verified, 1);
    assert.equal(report.summary.byStatus.proposed, 1);
    assert.equal(report.claims[0]?.metadata?.survey && typeof report.claims[0].metadata.survey, "object");
  });

  it("projects corrected document candidates and preserves Claim Dependency recompute pressure", () => {
    const input = buildSurveyTrustInput(correctedDocumentCandidatesFixture);
    const valid = validateTrustInput(input);
    const report = buildTrustReport(valid);
    const currentPosition = report.claims.find((claim) => claim.id === "document.entity-1.statement-position.current");
    const originalPosition = report.claims.find((claim) => claim.id === "document.entity-1.statement-position.original");

    assert.equal(report.claims.length, 6);
    assert.ok(report.summary.byStatus.superseded >= 2);
    assert.equal(report.summary.byStatus.proposed, 3);
    assert.equal(currentPosition?.claimType, "computed-field");
    assert.deepEqual(currentPosition?.derivedFrom, [
      "document.entity-1.statement.amount.corrected",
      "document.entity-1.statement.credit.corrected",
    ]);
    assert.deepEqual(currentPosition?.derivationEdges?.map((edge) => edge.inputClaimId), [
      "document.entity-1.statement.amount.corrected",
      "document.entity-1.statement.credit.corrected",
    ]);
    assert.equal(originalPosition?.derivationEdges?.[0]?.supportStrength, "strong");
    assert.ok(report.changeRecords.some((record) => record.reason === "input-superseded"));
  });

  it("projects Candidate Conflict to a disputed claim with candidate-conflict event", () => {
    const input = buildSurveyTrustInput({
      source: "survey.candidate-conflict.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
      rawSources: [
        {
          id: "source.registry",
          kind: "api-record",
          sourceRef: "records://entity-1/registry",
          observedAt: "2026-05-31T15:00:00.000Z",
          locatorScheme: "structured-field",
        },
        {
          id: "source.archive",
          kind: "web-page",
          sourceRef: "https://records.example.test/entity-1/archive",
          observedAt: "2026-05-31T14:00:00.000Z",
          locatorScheme: "html",
        },
      ],
      extractions: [
        {
          id: "extraction.registry.status",
          sourceId: "source.registry",
          target: "registrationStatus",
          value: "ACTIVE",
          confidence: 0.89,
          locator: "json:$.registrationStatus",
          extractor: "records-importer",
          extractedAt: "2026-05-31T15:00:00.000Z",
        },
        {
          id: "extraction.archive.status",
          sourceId: "source.archive",
          target: "registrationStatus",
          value: "INACTIVE",
          confidence: 0.87,
          locator: "css:#registration-status",
          extractor: "records-crawler",
          extractedAt: "2026-05-31T14:00:00.000Z",
        },
      ],
      candidateSets: [
        {
          id: "candidate-set.entity-1.registration-status",
          target: "registrationStatus",
          status: "conflict",
          rationale: "Registry and archive disagree and no review has resolved the candidate conflict.",
          candidates: [
            {
              id: "candidate.registry.status",
              extractionId: "extraction.registry.status",
              value: "ACTIVE",
              confidence: 0.89,
              sourceRank: 1,
            },
            {
              id: "candidate.archive.status",
              extractionId: "extraction.archive.status",
              value: "INACTIVE",
              confidence: 0.87,
              sourceRank: 1,
            },
          ],
        },
      ],
      reviewOutcomes: [],
      claims: [
        {
          id: "claim.entity-1.registration-status.registry",
          candidateSetId: "candidate-set.entity-1.registration-status",
          candidateId: "candidate.registry.status",
          subjectType: "public-record.entity",
          subjectId: "entity-1",
          surface: "public-record.profile",
          claimType: "public-data.field",
          fieldOrBehavior: "registrationStatus",
          impactLevel: "high",
          collectedBy: "records-importer",
        },
      ],
    });
    const valid = validateTrustInput(input);
    const report = buildTrustReport(valid);

    assert.equal(report.summary.byStatus.disputed, 1);
    assert.equal(report.claims[0]?.status, "disputed");
    assert.equal(report.events[0]?.method, "candidate-conflict");
  });

  it("rejects verified claims without review authority", () => {
    const broken = structuredClone(publicFieldReviewFixture);
    broken.reviewOutcomes = [];
    broken.claims[0] = { ...broken.claims[0], status: "verified" };

    assert.throws(
      () => buildSurveyTrustInput(broken),
      /cannot be verified without a review outcome/,
    );
  });

  it("rejects non-manual source claims without locators", () => {
    const broken = structuredClone(publicFieldReviewFixture);
    broken.extractions[0] = { ...broken.extractions[0], locator: undefined };

    assert.throws(
      () => buildSurveyTrustInput(broken),
      /needs a source locator/,
    );
  });

  it("builds Survey input through the record builder", () => {
    const input = new SurveyInputBuilder({
        source: "survey.builder.fixture",
        generatedAt: "2026-05-31T16:00:00.000Z",
      })
      .addClaimRecord({
        rawSource: publicFieldReviewFixture.rawSources[0]!,
        extraction: publicFieldReviewFixture.extractions[0]!,
        candidateSet: publicFieldReviewFixture.candidateSets[0]!,
        reviewOutcome: publicFieldReviewFixture.reviewOutcomes[0]!,
        claim: publicFieldReviewFixture.claims[0]!,
      })
      .build();

    const report = buildTrustReport(validateTrustInput(buildSurveyTrustInput(input)));
    assert.equal(report.summary.byStatus.verified, 1);
  });

  it("builds a single claim observation without manual link IDs", () => {
    const input = new SurveyInputBuilder({
      source: "survey.observation.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    })
      .addObservation({
        id: "observation.entity-1.availability",
        rawSource: {
          kind: "web-page",
          sourceRef: "https://example.test/listing",
          observedAt: "2026-05-31T15:00:00.000Z",
          locatorScheme: "html",
        },
        extraction: {
          target: "availabilityStatus",
          value: "AVAILABLE",
          confidence: 0.9,
          locator: "html:field=availabilityStatus",
          excerpt: "Availability is open.",
          extractor: "example-crawler",
          extractedAt: "2026-05-31T15:00:00.000Z",
        },
        reviewOutcome: {
          status: "verified",
          actor: "example-operator",
          reviewedAt: "2026-05-31T15:05:00.000Z",
        },
        claim: {
          subjectType: "public-record.entity",
          subjectId: "entity-1",
          surface: "public-record.profile",
          claimType: "public-data.field",
          fieldOrBehavior: "availabilityStatus",
          impactLevel: "medium",
          collectedBy: "example-crawler",
        },
      })
      .build();

    const report = buildTrustReport(validateTrustInput(buildSurveyTrustInput(input)));
    assert.equal(report.summary.byStatus.verified, 1);
    const surveyMetadata = report.claims[0]?.metadata?.survey as { candidateSetId?: string } | undefined;
    assert.equal(surveyMetadata?.candidateSetId, "observation.entity-1.availability.candidates");
  });

  it("builds a verified repeated public-record observation", () => {
    const aliases = [
      { name: "North Annex", sourceLabel: "record row 1" },
      { name: "East Annex", sourceLabel: "record row 2" },
    ];
    const input = new SurveyInputBuilder({
      source: "survey.repeated.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    })
      .addObservation(repeatedObservation({
        id: "observation.entity-1.aliases.current",
        field: "knownAliases",
        value: aliases,
        rawSource: {
          kind: "api-record",
          sourceRef: "public-records://entity/entity-1",
          observedAt: "2026-05-31T15:00:00.000Z",
          locatorScheme: "structured-field",
          metadata: { producer: "public-record-import" },
        },
        extraction: {
          confidence: 0.88,
          locator: "json:$.aliases",
          extractor: "public-record-importer",
          extractedAt: "2026-05-31T15:00:00.000Z",
        },
        reviewOutcome: {
          status: "verified",
          actor: "records-operator",
          reviewedAt: "2026-05-31T15:05:00.000Z",
        },
        claim: {
          subjectType: "public-record.entity",
          subjectId: "entity-1",
          surface: "public-record.profile",
          claimType: "public-data.repeated-field",
          status: "verified",
          impactLevel: "medium",
          collectedBy: "public-record-importer",
          metadata: {
            claimScope: "profile",
            survey: { claimNote: "also kept" },
          },
        },
        metadata: {
          producerField: "aliases",
          survey: {
            producerNote: "kept",
            repeated: { sourceCollection: "aliases" },
          },
        },
      }))
      .build();

    const report = buildTrustReport(validateTrustInput(buildSurveyTrustInput(input)));
    const claim = report.claims[0]!;
    const surveyMetadata = claim.metadata?.survey as {
      repeated?: { representation?: string; itemCount?: number; sourceCollection?: string };
      producerNote?: string;
      claimNote?: string;
    } | undefined;

    assert.equal(report.summary.byStatus.verified, 1);
    assert.deepEqual(claim.value, aliases);
    assert.equal(claim.fieldOrBehavior, "knownAliases");
    assert.equal(claim.metadata?.claimScope, "profile");
    assert.equal(claim.metadata?.producerField, "aliases");
    assert.equal(surveyMetadata?.claimNote, "also kept");
    assert.equal(surveyMetadata?.producerNote, "kept");
    assert.equal(surveyMetadata?.repeated?.representation, "aggregate-array");
    assert.equal(surveyMetadata?.repeated?.itemCount, 2);
    assert.equal(surveyMetadata?.repeated?.sourceCollection, "aliases");
    assert.equal(report.evidence[0]?.excerptOrSummary, "knownAliases: 2 item(s)");
  });

  it("builds a verified scalar field observation", () => {
    const input = new SurveyInputBuilder({
      source: "survey.field.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    })
      .addObservation(fieldObservation({
        id: "observation.entity-1.registration-status.current",
        field: "registrationStatus",
        value: "ACTIVE",
        rawSource: {
          kind: "api-record",
          sourceRef: "public-records://entity/entity-1",
          observedAt: "2026-05-31T15:00:00.000Z",
          locatorScheme: "structured-field",
        },
        extraction: {
          confidence: 0.97,
          locator: "json:$.registrationStatus",
          extractor: "public-record-importer",
          extractedAt: "2026-05-31T15:00:00.000Z",
        },
        reviewOutcome: {
          status: "verified",
          actor: "records-operator",
          reviewedAt: "2026-05-31T15:05:00.000Z",
        },
        claim: {
          subjectType: "public-record.entity",
          subjectId: "entity-1",
          surface: "public-record.profile",
          claimType: "public-data.field",
          status: "verified",
          impactLevel: "medium",
          collectedBy: "public-record-importer",
        },
      }))
      .build();

    const report = buildTrustReport(validateTrustInput(buildSurveyTrustInput(input)));
    const claim = report.claims[0]!;
    const surveyMetadata = claim.metadata?.survey as {
      field?: { representation?: string };
    } | undefined;

    assert.equal(report.summary.byStatus.verified, 1);
    assert.equal(claim.fieldOrBehavior, "registrationStatus");
    assert.equal(claim.value, "ACTIVE");
    assert.equal(surveyMetadata?.field?.representation, "scalar");
    assert.equal(report.evidence[0]?.excerptOrSummary, "registrationStatus: ACTIVE");
  });

  it("builds a proposed scalar field observation candidate", () => {
    const input = new SurveyInputBuilder({
      source: "survey.field.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    })
      .addObservation(fieldObservation({
        id: "observation.entity-1.license-count.proposed",
        field: "licenseCount",
        value: 3,
        rawSource: {
          kind: "web-page",
          sourceRef: "https://records.example.test/entities/entity-1",
          observedAt: "2026-05-31T15:00:00.000Z",
          locatorScheme: "html",
        },
        extraction: {
          target: "licenseCountCandidate",
          confidence: 0.72,
          locator: "css:#license-count",
          excerpt: "Three listed licenses.",
          extractor: "records-crawler",
          extractedAt: "2026-05-31T15:00:00.000Z",
        },
        candidateSet: {
          status: "needs-review",
          rationale: "New scalar candidate pending operator review.",
        },
        candidate: {
          confidence: 0.72,
          sourceRank: 1,
        },
        claim: {
          subjectType: "public-record.entity",
          subjectId: "entity-1",
          surface: "public-record.profile",
          claimType: "public-data.field-candidate",
          fieldOrBehavior: "licenses.activeCount",
          impactLevel: "high",
          collectedBy: "records-crawler",
        },
      }))
      .build();

    const report = buildTrustReport(validateTrustInput(buildSurveyTrustInput(input)));
    const claim = report.claims[0]!;

    assert.equal(report.summary.byStatus.proposed, 1);
    assert.equal(claim.fieldOrBehavior, "licenses.activeCount");
    assert.equal(claim.value, 3);
    assert.equal(report.evidence[0]?.excerptOrSummary, "Three listed licenses.");
  });

  it("builds candidate review records from scalar field observations", () => {
    const records = candidateReviewRecord({
      id: "candidate-set.entity-1.registration-status",
      target: "registrationStatus",
      selectedCandidateId: "candidate.registration-status.active",
      status: "resolved",
      rationale: "Operator selected the registry value.",
      metadata: {
        reviewBatch: "batch-1",
        survey: { candidateSetNote: "kept" },
      },
      reviewOutcome: {
        id: "review.registration-status.active",
        status: "verified",
        actor: "records-operator",
        reviewedAt: "2026-05-31T15:05:00.000Z",
        rationale: "Registry source is authoritative for this field.",
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
            metadata: { sourceName: "registry" },
          },
          extraction: {
            confidence: 0.97,
            locator: "json:$.registrationStatus",
            extractor: "public-record-importer",
            extractedAt: "2026-05-31T15:00:00.000Z",
            metadata: { extractionRun: "run-1" },
          },
          candidate: {
            id: "candidate.registration-status.active",
            confidence: 0.97,
            sourceRank: 1,
            metadata: { normalizedValue: "active" },
          },
          claim: {
            id: "claim.entity-1.registration-status.registry",
            subjectType: "public-record.entity",
            subjectId: "entity-1",
            surface: "public-record.profile",
            claimType: "public-data.field",
            status: "verified",
            impactLevel: "medium",
            collectedBy: "public-record-importer",
            metadata: { candidateRole: "selected" },
          },
          metadata: { producerField: "registrationStatus" },
        }),
        fieldObservation({
          id: "observation.entity-1.registration-status.archive",
          field: "registrationStatus",
          value: "INACTIVE",
          rawSource: {
            kind: "web-page",
            sourceRef: "https://records.example.test/entities/entity-1/archive",
            observedAt: "2026-05-31T14:00:00.000Z",
            locatorScheme: "html",
            metadata: { sourceName: "archive" },
          },
          extraction: {
            confidence: 0.71,
            locator: "css:#registration-status",
            extractor: "records-crawler",
            extractedAt: "2026-05-31T14:00:00.000Z",
            metadata: { extractionRun: "run-2" },
          },
          candidate: {
            id: "candidate.registration-status.inactive",
            confidence: 0.71,
            sourceRank: 2,
            metadata: { normalizedValue: "inactive" },
          },
          claim: {
            id: "claim.entity-1.registration-status.archive",
            subjectType: "public-record.entity",
            subjectId: "entity-1",
            surface: "public-record.profile",
            claimType: "public-data.field",
            status: "superseded",
            impactLevel: "medium",
            collectedBy: "records-crawler",
            metadata: { candidateRole: "superseded" },
          },
          metadata: { producerField: "registrationStatus" },
        }),
      ],
    });
    const input = new SurveyInputBuilder({
      source: "survey.candidate-review.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    })
      .addClaimRecords(records)
      .build();

    assert.equal(input.rawSources.length, 2);
    assert.equal(input.extractions.length, 2);
    assert.equal(input.candidateSets.length, 1);
    assert.equal(input.reviewOutcomes.length, 1);
    assert.equal(input.claims.length, 2);

    const candidateSet = input.candidateSets[0]!;
    assert.equal(candidateSet.id, "candidate-set.entity-1.registration-status");
    assert.equal(candidateSet.selectedCandidateId, "candidate.registration-status.active");
    assert.equal(candidateSet.status, "resolved");
    assert.equal(candidateSet.rationale, "Operator selected the registry value.");
    assert.equal(candidateSet.metadata?.reviewBatch, "batch-1");
    assert.equal(candidateSet.candidates.length, 2);
    assert.deepEqual(candidateSet.candidates.map((candidate) => candidate.id), [
      "candidate.registration-status.active",
      "candidate.registration-status.inactive",
    ]);
    assert.notEqual(candidateSet.candidates[0]?.extractionId, candidateSet.candidates[1]?.extractionId);
    assert.equal(candidateSet.candidates[0]?.metadata?.normalizedValue, "active");
    assert.equal(candidateSet.candidates[1]?.metadata?.normalizedValue, "inactive");

    assert.equal(input.claims[0]?.candidateSetId, candidateSet.id);
    assert.equal(input.claims[1]?.candidateSetId, candidateSet.id);
    assert.notEqual(input.claims[0]?.id, input.claims[1]?.id);
    assert.equal(input.claims[0]?.candidateId, "candidate.registration-status.active");
    assert.equal(input.claims[1]?.candidateId, "candidate.registration-status.inactive");
    assert.equal(input.reviewOutcomes[0]?.candidateSetId, candidateSet.id);
    assert.equal(input.reviewOutcomes[0]?.candidateId, "candidate.registration-status.active");
    assert.equal(input.reviewOutcomes[0]?.status, "verified");

    const report = buildTrustReport(validateTrustInput(buildSurveyTrustInput(input)));
    const verifiedClaim = report.claims.find((claim) => claim.id === "claim.entity-1.registration-status.registry");
    const supersededClaim = report.claims.find((claim) => claim.id === "claim.entity-1.registration-status.archive");
    const registryEvidence = report.evidence.find((evidence) => evidence.claimId === verifiedClaim?.id);
    const archiveEvidence = report.evidence.find((evidence) => evidence.claimId === supersededClaim?.id);

    assert.equal(report.claims.length, 2);
    assert.equal(report.summary.byStatus.verified, 1);
    assert.equal(report.summary.byStatus.superseded, 1);
    assert.equal(verifiedClaim?.status, "verified");
    assert.equal(verifiedClaim?.value, "ACTIVE");
    assert.equal(supersededClaim?.status, "superseded");
    assert.equal(supersededClaim?.value, "INACTIVE");
    assert.equal(verifiedClaim?.metadata?.candidateRole, "selected");
    assert.equal(supersededClaim?.metadata?.candidateRole, "superseded");
    assert.equal(registryEvidence?.metadata?.sourceName, "registry");
    assert.equal(registryEvidence?.metadata?.extractionRun, "run-1");
    assert.equal(registryEvidence?.metadata?.normalizedValue, "active");
    assert.equal(archiveEvidence?.metadata?.sourceName, "archive");
    assert.equal(archiveEvidence?.metadata?.extractionRun, "run-2");
    assert.equal(archiveEvidence?.metadata?.normalizedValue, "inactive");
  });

  it("accepts claim records that reuse an identical raw source", () => {
    const sharedRawSource = {
      id: "source.entity-1.registry",
      kind: "api-record" as const,
      sourceRef: "public-records://entity/entity-1",
      observedAt: "2026-05-31T15:00:00.000Z",
      locatorScheme: "structured-field" as const,
      metadata: { sourceName: "registry" },
    };
    const records = candidateReviewRecord({
      id: "candidate-set.entity-1.reused-source",
      target: "profileField",
      selectedCandidateId: "candidate.field-a",
      status: "resolved",
      observations: [
        fieldObservation({
          id: "observation.entity-1.field-a",
          field: "profileField.a",
          value: "A",
          rawSource: sharedRawSource,
          extraction: {
            confidence: 0.96,
            locator: "json:$.fieldA",
            extractor: "public-record-importer",
            extractedAt: "2026-05-31T15:00:00.000Z",
          },
          candidate: { id: "candidate.field-a", confidence: 0.96 },
          claim: {
            id: "claim.entity-1.field-a",
            subjectType: "public-record.entity",
            subjectId: "entity-1",
            surface: "public-record.profile",
            claimType: "public-data.field",
            status: "verified",
            impactLevel: "low",
            collectedBy: "public-record-importer",
          },
        }),
        fieldObservation({
          id: "observation.entity-1.field-b",
          field: "profileField.b",
          value: "B",
          rawSource: { ...sharedRawSource },
          extraction: {
            confidence: 0.95,
            locator: "json:$.fieldB",
            extractor: "public-record-importer",
            extractedAt: "2026-05-31T15:00:00.000Z",
          },
          candidate: { id: "candidate.field-b", confidence: 0.95 },
          claim: {
            id: "claim.entity-1.field-b",
            subjectType: "public-record.entity",
            subjectId: "entity-1",
            surface: "public-record.profile",
            claimType: "public-data.field",
            status: "verified",
            impactLevel: "low",
            collectedBy: "public-record-importer",
          },
        }),
      ],
    });

    const input = new SurveyInputBuilder({
      source: "survey.reused-source.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    })
      .addRawSource(sharedRawSource)
      .addClaimRecords(records)
      .build();

    assert.equal(input.rawSources.length, 1);
    assert.equal(input.extractions.length, 2);
    assert.equal(input.claims.length, 2);
  });

  it("rejects duplicate candidate ids in candidate review records", () => {
    const observation = fieldObservation({
      id: "observation.entity-1.status.registry",
      field: "registrationStatus",
      value: "ACTIVE",
      rawSource: {
        kind: "api-record",
        sourceRef: "public-records://entity/entity-1",
        observedAt: "2026-05-31T15:00:00.000Z",
        locatorScheme: "structured-field",
      },
      extraction: {
        confidence: 0.96,
        locator: "json:$.registrationStatus",
        extractor: "public-record-importer",
        extractedAt: "2026-05-31T15:00:00.000Z",
      },
      candidate: { id: "candidate.registration-status", confidence: 0.96 },
      claim: {
        id: "claim.entity-1.status.registry",
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        status: "verified",
        impactLevel: "medium",
        collectedBy: "public-record-importer",
      },
    });

    assert.throws(
      () => candidateReviewRecord({
        id: "candidate-set.entity-1.registration-status",
        target: "registrationStatus",
        observations: [
          observation,
          {
            ...observation,
            id: "observation.entity-1.status.archive",
            claim: { ...observation.claim, id: "claim.entity-1.status.archive", value: "INACTIVE" },
          },
        ],
      }),
      /duplicate candidate id: candidate\.registration-status/,
    );
  });

  it("rejects review outcomes without a selected candidate", () => {
    assert.throws(
      () => candidateReviewRecord({
        id: "candidate-set.entity-1.registration-status",
        target: "registrationStatus",
        reviewOutcome: {
          status: "verified",
          actor: "records-operator",
          reviewedAt: "2026-05-31T15:05:00.000Z",
        },
        observations: [
          fieldObservation({
            id: "observation.entity-1.status.registry",
            field: "registrationStatus",
            value: "ACTIVE",
            rawSource: {
              kind: "api-record",
              sourceRef: "public-records://entity/entity-1",
              observedAt: "2026-05-31T15:00:00.000Z",
              locatorScheme: "structured-field",
            },
            extraction: {
              confidence: 0.96,
              locator: "json:$.registrationStatus",
              extractor: "public-record-importer",
              extractedAt: "2026-05-31T15:00:00.000Z",
            },
            claim: {
              id: "claim.entity-1.status.registry",
              subjectType: "public-record.entity",
              subjectId: "entity-1",
              surface: "public-record.profile",
              claimType: "public-data.field",
              status: "verified",
              impactLevel: "medium",
              collectedBy: "public-record-importer",
            },
          }),
        ],
      }),
      /needs a selected candidate id for review outcome/,
    );
  });

  it("rejects conflicting selected and review candidate ids", () => {
    assert.throws(
      () => candidateReviewRecord({
        id: "candidate-set.entity-1.registration-status",
        target: "registrationStatus",
        selectedCandidateId: "candidate.registry",
        reviewOutcome: {
          candidateId: "candidate.archive",
          status: "verified",
          actor: "records-operator",
          reviewedAt: "2026-05-31T15:05:00.000Z",
        },
        observations: [
          fieldObservation({
            id: "observation.entity-1.status.registry",
            field: "registrationStatus",
            value: "ACTIVE",
            rawSource: {
              kind: "api-record",
              sourceRef: "public-records://entity/entity-1",
              observedAt: "2026-05-31T15:00:00.000Z",
              locatorScheme: "structured-field",
            },
            extraction: {
              confidence: 0.96,
              locator: "json:$.registrationStatus",
              extractor: "public-record-importer",
              extractedAt: "2026-05-31T15:00:00.000Z",
            },
            candidate: { id: "candidate.registry", confidence: 0.96 },
            claim: {
              id: "claim.entity-1.status.registry",
              subjectType: "public-record.entity",
              subjectId: "entity-1",
              surface: "public-record.profile",
              claimType: "public-data.field",
              status: "verified",
              impactLevel: "medium",
              collectedBy: "public-record-importer",
            },
          }),
          fieldObservation({
            id: "observation.entity-1.status.archive",
            field: "registrationStatus",
            value: "INACTIVE",
            rawSource: {
              kind: "web-page",
              sourceRef: "https://records.example.test/entities/entity-1/archive",
              observedAt: "2026-05-31T14:00:00.000Z",
              locatorScheme: "html",
            },
            extraction: {
              confidence: 0.71,
              locator: "css:#registration-status",
              extractor: "records-crawler",
              extractedAt: "2026-05-31T14:00:00.000Z",
            },
            candidate: { id: "candidate.archive", confidence: 0.71 },
            claim: {
              id: "claim.entity-1.status.archive",
              subjectType: "public-record.entity",
              subjectId: "entity-1",
              surface: "public-record.profile",
              claimType: "public-data.field",
              status: "superseded",
              impactLevel: "medium",
              collectedBy: "records-crawler",
            },
          }),
        ],
      }),
      /conflicting selected and review candidate ids/,
    );
  });

  it("rejects selected candidate ids outside the candidate set", () => {
    assert.throws(
      () => candidateReviewRecord({
        id: "candidate-set.entity-1.registration-status",
        target: "registrationStatus",
        selectedCandidateId: "candidate.missing",
        observations: [
          fieldObservation({
            id: "observation.entity-1.status.registry",
            field: "registrationStatus",
            value: "ACTIVE",
            rawSource: {
              kind: "api-record",
              sourceRef: "public-records://entity/entity-1",
              observedAt: "2026-05-31T15:00:00.000Z",
              locatorScheme: "structured-field",
            },
            extraction: {
              confidence: 0.96,
              locator: "json:$.registrationStatus",
              extractor: "public-record-importer",
              extractedAt: "2026-05-31T15:00:00.000Z",
            },
            candidate: { id: "candidate.registry", confidence: 0.96 },
            claim: {
              id: "claim.entity-1.status.registry",
              subjectType: "public-record.entity",
              subjectId: "entity-1",
              surface: "public-record.profile",
              claimType: "public-data.field",
              status: "verified",
              impactLevel: "medium",
              collectedBy: "public-record-importer",
            },
          }),
        ],
      }),
      /does not contain selected candidate candidate\.missing/,
    );
  });

  it("rejects candidate review records without observations", () => {
    assert.throws(
      () => candidateReviewRecord({
        id: "candidate-set.entity-1.empty",
        target: "registrationStatus",
        observations: [],
      }),
      /needs at least one observation/,
    );
  });

  it("merges scalar field metadata without overwriting producer survey metadata", () => {
    const observation = fieldObservation({
      id: "observation.entity-1.status.current",
      field: "status",
      value: "OPEN",
      rawSource: {
        kind: "manual-entry",
        sourceRef: "operator://entry/entity-1",
        observedAt: "2026-05-31T15:00:00.000Z",
        locatorScheme: "structured-field",
      },
      extraction: {
        extractor: "operator-entry",
        extractedAt: "2026-05-31T15:00:00.000Z",
      },
      claim: {
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        impactLevel: "low",
        collectedBy: "operator-entry",
        metadata: {
          claimScope: "profile",
          survey: {
            claimNote: "also kept",
            field: { claimScope: "profile-field" },
          },
        },
      },
      metadata: {
        producerField: "status",
        survey: {
          producerNote: "kept",
          field: { sourceColumn: "status_code" },
        },
      },
    });
    const surveyMetadata = observation.claim.metadata?.survey as {
      field?: { representation?: string; claimScope?: string; sourceColumn?: string };
      producerNote?: string;
      claimNote?: string;
    } | undefined;

    assert.equal(observation.claim.metadata?.claimScope, "profile");
    assert.equal(observation.claim.metadata?.producerField, "status");
    assert.equal(surveyMetadata?.claimNote, "also kept");
    assert.equal(surveyMetadata?.producerNote, "kept");
    assert.equal(surveyMetadata?.field?.representation, "scalar");
    assert.equal(surveyMetadata?.field?.claimScope, "profile-field");
    assert.equal(surveyMetadata?.field?.sourceColumn, "status_code");
  });

  it("defaults scalar target, fieldOrBehavior, and empty excerpt", () => {
    const observation = fieldObservation({
      id: "observation.entity-1.optional-code.current",
      field: "optionalCode",
      value: null,
      rawSource: {
        kind: "manual-entry",
        sourceRef: "operator://entry/entity-1",
        observedAt: "2026-05-31T15:00:00.000Z",
        locatorScheme: "structured-field",
      },
      extraction: {
        extractor: "operator-entry",
        extractedAt: "2026-05-31T15:00:00.000Z",
      },
      claim: {
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        impactLevel: "low",
        collectedBy: "operator-entry",
      },
    });

    assert.equal(observation.extraction.target, "optionalCode");
    assert.equal(observation.claim.fieldOrBehavior, "optionalCode");
    assert.equal(observation.extraction.excerpt, "optionalCode: <empty>");
  });

  it("builds a proposed repeated candidate observation", () => {
    const officers = [
      { name: "Riley Chen", role: "Director" },
      { name: "Morgan Lee", role: "Secretary" },
    ];
    const input = new SurveyInputBuilder({
      source: "survey.repeated.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    })
      .addObservation(repeatedObservation({
        id: "observation.entity-1.officers.proposed",
        field: "listedOfficers",
        value: officers,
        rawSource: {
          kind: "web-page",
          sourceRef: "https://records.example.test/entities/entity-1",
          observedAt: "2026-05-31T15:00:00.000Z",
          locatorScheme: "html",
        },
        extraction: {
          target: "officerCandidates",
          confidence: 0.76,
          locator: "css:#officers",
          excerpt: "Officer table contains two rows.",
          extractor: "records-crawler",
          extractedAt: "2026-05-31T15:00:00.000Z",
        },
        candidateSet: {
          status: "needs-review",
          rationale: "New public-record candidate pending operator review.",
          metadata: { candidateGroup: "officers" },
        },
        candidate: {
          confidence: 0.76,
          metadata: { normalizedBy: "records-crawler" },
        },
        claim: {
          subjectType: "public-record.entity",
          subjectId: "entity-1",
          surface: "public-record.profile",
          claimType: "public-data.repeated-field-candidate",
          impactLevel: "high",
          collectedBy: "records-crawler",
        },
      }))
      .build();

    const report = buildTrustReport(validateTrustInput(buildSurveyTrustInput(input)));
    const claim = report.claims[0]!;
    const surveyMetadata = claim.metadata?.survey as {
      repeated?: { representation?: string; itemCount?: number };
    } | undefined;

    assert.equal(report.summary.byStatus.proposed, 1);
    assert.equal(claim.fieldOrBehavior, "listedOfficers");
    assert.deepEqual(claim.value, officers);
    assert.equal(surveyMetadata?.repeated?.representation, "aggregate-array");
    assert.equal(surveyMetadata?.repeated?.itemCount, 2);
    assert.equal(report.evidence[0]?.excerptOrSummary, "Officer table contains two rows.");
  });

  it("builds an empty verified repeated public-record observation", () => {
    const input = new SurveyInputBuilder({
      source: "survey.repeated.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    })
      .addObservation(repeatedObservation({
        id: "observation.entity-1.public-notices.current",
        field: "publicNotices",
        value: [],
        rawSource: {
          kind: "api-record",
          sourceRef: "public-records://entity/entity-1/notices",
          observedAt: "2026-05-31T15:00:00.000Z",
          locatorScheme: "structured-field",
        },
        extraction: {
          confidence: 0.99,
          locator: "json:$.notices",
          extractor: "public-record-importer",
          extractedAt: "2026-05-31T15:00:00.000Z",
        },
        reviewOutcome: {
          status: "verified",
          actor: "records-operator",
          reviewedAt: "2026-05-31T15:05:00.000Z",
        },
        claim: {
          subjectType: "public-record.entity",
          subjectId: "entity-1",
          surface: "public-record.profile",
          claimType: "public-data.repeated-field",
          status: "verified",
          impactLevel: "low",
          collectedBy: "public-record-importer",
        },
      }))
      .build();

    const report = buildTrustReport(validateTrustInput(buildSurveyTrustInput(input)));
    const claim = report.claims[0]!;
    const surveyMetadata = claim.metadata?.survey as {
      repeated?: { representation?: string; itemCount?: number };
    } | undefined;

    assert.equal(report.summary.byStatus.verified, 1);
    assert.deepEqual(claim.value, []);
    assert.equal(surveyMetadata?.repeated?.representation, "aggregate-array");
    assert.equal(surveyMetadata?.repeated?.itemCount, 0);
    assert.equal(report.evidence[0]?.excerptOrSummary, "publicNotices: 0 item(s)");
  });
});
