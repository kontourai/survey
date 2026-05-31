import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTrustReport, validateTrustInput } from "@kontourai/surface";
import { correctedDocumentCandidatesFixture } from "../fixtures/corrected-document-candidates.js";
import { publicFieldReviewFixture } from "../fixtures/public-field-review.js";
import { buildSurveyTrustInput, fieldObservation, repeatedObservation, SurveyInputBuilder } from "../src/index.js";

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

  it("projects corrected document candidates and preserves derived recompute pressure", () => {
    const input = buildSurveyTrustInput(correctedDocumentCandidatesFixture);
    const valid = validateTrustInput(input);
    const report = buildTrustReport(valid);

    assert.equal(report.claims.length, 6);
    assert.ok(report.summary.byStatus.superseded >= 2);
    assert.equal(report.summary.byStatus.proposed, 3);
    assert.ok(report.changeRecords.some((record) => record.reason === "input-superseded"));
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
