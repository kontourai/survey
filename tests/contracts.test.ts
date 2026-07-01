import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTrustReport, validateTrustBundle } from "@kontourai/surface";
import { correctedDocumentCandidatesExample } from "../example-data/corrected-document-candidates.js";
import { publicFieldReviewExample } from "../example-data/public-field-review.js";
import { SURVEY_INPUT_CONTRACT_VERSION } from "../src/types.js";
import {
  buildCanonicalReviewProofPayload,
  buildSurveyTrustBundle,
  candidateReviewRecord,
  apiRecordSource,
  fieldObservation,
  hashCanonicalReviewProofPayload,
  manualEntrySource,
  policyStandardSource,
  repeatedObservation,
  reviewedCandidateResolution,
  reviewedCurrentProposedResolution,
  sourceOfAuthorityObservation,
  sourceOfAuthorityObservationBuilder,
  SurveyInputBuilder,
  type SurveyInput,
  uploadedDocumentSource,
  webPageSource,
} from "../src/index.js";

describe("Survey Surface projection", () => {
  it("projects a reviewed public field into valid Surface trust input", () => {
    const input = buildSurveyTrustBundle(publicFieldReviewExample);
    const valid = validateTrustBundle(input);
    const report = buildTrustReport(valid);

    assert.equal(report.claims.length, 2);
    assert.equal(report.evidence.length, 2);
    assert.equal(report.summary.byStatus.verified, 1);
    assert.equal(report.summary.byStatus.proposed, 1);
    assert.equal(report.claims[0]?.metadata?.survey && typeof report.claims[0].metadata.survey, "object");
  });

  it("optionally attaches recomputable review proof anchors to reviewed Surface claims", () => {
    const input = buildSurveyTrustBundle(publicFieldReviewExample, { reviewProofs: true });
    const valid = validateTrustBundle(input);
    const report = buildTrustReport(valid);
    const claim = report.claims.find((item) => item.id === "public-field.entity-123.availability-status.current");
    const proposedClaim = report.claims.find((item) => item.id === "public-field.entity-123.availability-status.proposal-456");
    const rawSource = publicFieldReviewExample.rawSources[0]!;
    const extraction = publicFieldReviewExample.extractions[0]!;
    const candidateSet = publicFieldReviewExample.candidateSets[0]!;
    const candidate = candidateSet.candidates[0]!;
    const reviewOutcome = publicFieldReviewExample.reviewOutcomes[0]!;
    const projection = publicFieldReviewExample.claims[0]!;
    const payload = buildCanonicalReviewProofPayload({
      rawSource,
      extraction,
      candidate,
      candidateSet,
      reviewOutcome,
      claim: {
        ...projection,
        value: candidate.value,
        status: reviewOutcome.status,
      },
    });
    const expectedHash = hashCanonicalReviewProofPayload(payload);

    assert.equal(claim?.currentIntegrityAnchor?.kind, "hash");
    assert.equal(claim?.currentIntegrityAnchor?.algorithm, "sha256");
    assert.equal(claim?.currentIntegrityAnchor?.value, expectedHash);
    assert.equal(claim?.currentIntegrityAnchor?.sourceRef, rawSource.sourceRef);
    assert.equal(claim?.currentIntegrityAnchor?.observedAt, reviewOutcome.reviewedAt);
    assert.equal(proposedClaim?.currentIntegrityAnchor, undefined);
    assert.equal(claim?.metadata?.producer && typeof claim.metadata.producer, "object");
    assert.equal(claim?.currentIntegrityAnchor?.metadata, undefined);

    const mutatedPayload = structuredClone(payload);
    mutatedPayload.reviewOutcome!.status = "rejected";
    assert.notEqual(hashCanonicalReviewProofPayload(mutatedPayload), claim?.currentIntegrityAnchor?.value);
  });

  it("projects corrected document candidates and preserves Claim Dependency recompute pressure", () => {
    const input = buildSurveyTrustBundle(correctedDocumentCandidatesExample);
    const valid = validateTrustBundle(input);
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

  it("builds generic raw sources with stable identities and checksum normalization", () => {
    const observedAt = "2026-05-31T15:00:00.000Z";
    const uploaded = uploadedDocumentSource({
      id: "source.document.entity-1",
      sourceRef: "documents://entity-1/profile.pdf",
      observedAt,
      checksum: "abc123",
      locatorScheme: "pdf",
      metadata: { fileName: "profile.pdf" },
    });
    const api = apiRecordSource({
      sourceRef: "public-records://entity/entity-1",
      observedAt,
      checksum: { algorithm: "sha512", value: "def456" },
      metadata: { provider: "registry" },
    });
    const page = webPageSource({
      sourceRef: "https://records.example.test/entities/entity-1",
      observedAt,
      fetchedAt: "2026-05-31T15:01:00.000Z",
      checksum: "sha256:already-normalized",
    });
    const manual = manualEntrySource({
      sourceRef: "operator://entity/entity-1/status",
      observedAt,
      metadata: { entryReason: "operator attestation" },
    });
    const policyStandard = policyStandardSource({
      sourceRef: "policy-standard://example/rules/2026#paragraph-4",
      observedAt,
      checksum: "policy-standard-text",
      inlineText: "Applications must include a complete evidence reference.",
      standardVersion: "2026-06-01",
      paragraphRef: "paragraph-4",
      reference: "Example Rules 2026 paragraph 4",
      metadata: { publisher: "Example Standards Body" },
    });

    assert.equal(uploaded.id, "source.document.entity-1");
    assert.equal(uploaded.kind, "uploaded-document");
    assert.equal(uploaded.checksum, "sha256:abc123");
    assert.equal(uploaded.locatorScheme, "pdf");
    assert.equal(uploaded.metadata?.fileName, "profile.pdf");
    assert.equal(api.id, "api-record:public-records://entity/entity-1");
    assert.equal(api.kind, "api-record");
    assert.equal(api.checksum, "sha512:def456");
    assert.equal(api.locatorScheme, "structured-field");
    assert.equal(page.kind, "web-page");
    assert.equal(page.checksum, "sha256:already-normalized");
    assert.equal(page.locatorScheme, "html");
    assert.equal(manual.kind, "manual-entry");
    assert.equal(manual.locatorScheme, "structured-field");
    assert.equal(policyStandard.id, "policy-standard:policy-standard://example/rules/2026#paragraph-4");
    assert.equal(policyStandard.kind, "policy-standard");
    assert.equal(policyStandard.checksum, "sha256:policy-standard-text");
    assert.equal(policyStandard.locatorScheme, "text");
    assert.equal(policyStandard.inlineText, "Applications must include a complete evidence reference.");
    assert.equal(policyStandard.standardVersion, "2026-06-01");
    assert.equal(policyStandard.paragraphRef, "paragraph-4");
    assert.equal(policyStandard.metadata?.publisher, "Example Standards Body");
    assert.deepEqual(policyStandard.metadata?.policyStandard, {
      inlineText: "Applications must include a complete evidence reference.",
      standardVersion: "2026-06-01",
      paragraphRef: "paragraph-4",
      reference: "Example Rules 2026 paragraph 4",
    });
  });

  it("round-trips policy-standard raw sources through the Survey input builder", () => {
    const observedAt = "2026-06-07T12:00:00.000Z";
    const text = "The producer must cite the applied standard paragraph.";
    const rawSource = policyStandardSource({
      sourceRef: "policy-standard://example/standard/2026#section-2.1",
      observedAt,
      inlineText: text,
      standardVersion: "2026.1",
      paragraphRef: "section-2.1",
      reference: "Example Standard 2026 section 2.1",
    });

    const input = new SurveyInputBuilder({
      source: "survey.policy-standard.roundtrip",
      generatedAt: "2026-06-07T12:05:00.000Z",
    })
      .addObservation(fieldObservation({
        id: "observation.example.standard.section-2-1",
        field: "appliedStandard.text",
        value: text,
        rawSource,
        extraction: {
          target: "appliedStandard.text",
          locator: "text:paragraph=section-2.1",
          extractor: "standard-loader",
          extractedAt: observedAt,
        },
        claim: {
          id: "claim.example.standard.section-2-1",
          subjectType: "policy-standard",
          subjectId: "example-standard-2026",
          surface: "policy.library",
          claimType: "applied-standard.text",
          impactLevel: "medium",
          collectedBy: "standard-loader",
        },
      }))
      .build();

    const policyStandard = input.rawSources[0]?.metadata?.policyStandard as {
      inlineText?: string;
      standardVersion?: string;
      paragraphRef?: string;
      reference?: string;
    } | undefined;

    assert.equal(input.rawSources[0]?.kind, "policy-standard");
    assert.equal(input.rawSources[0]?.inlineText, text);
    assert.equal(input.rawSources[0]?.standardVersion, "2026.1");
    assert.equal(input.rawSources[0]?.paragraphRef, "section-2.1");
    assert.equal(policyStandard?.inlineText, text);
    assert.equal(policyStandard?.standardVersion, "2026.1");
    assert.equal(policyStandard?.paragraphRef, "section-2.1");
    assert.equal(policyStandard?.reference, "Example Standard 2026 section 2.1");
    assert.equal(input.extractions[0]?.sourceId, input.rawSources[0]?.id);
  });

  it("projects policy-standard sources to Surface policy_rule evidence by default", () => {
    const observedAt = "2026-06-07T12:00:00.000Z";
    const text = "The producer must retain the applied standard text and version.";
    const rawSource = policyStandardSource({
      id: "source.example.policy-standard.2026",
      sourceRef: "policy-standard://example/standard/2026#paragraph-9",
      observedAt,
      checksum: "standard-paragraph-9",
      inlineText: text,
      standardVersion: "2026.2",
      paragraphRef: "paragraph-9",
      reference: "Example Standard 2026 paragraph 9",
      metadata: { standardFamily: "example-standard" },
    });
    const input = new SurveyInputBuilder({
      source: "survey.policy-standard.projection",
      generatedAt: "2026-06-07T12:05:00.000Z",
    })
      .addObservation(fieldObservation({
        id: "observation.example.policy-standard.paragraph-9",
        field: "appliedStandard.paragraph9",
        value: text,
        rawSource,
        extraction: {
          target: "appliedStandard.paragraph9",
          locator: "text:paragraph=paragraph-9",
          extractor: "standard-loader",
          extractedAt: observedAt,
        },
        claim: {
          id: "claim.example.policy-standard.paragraph-9",
          subjectType: "policy-standard",
          subjectId: "example-standard-2026",
          surface: "policy.library",
          claimType: "applied-standard.rule-text",
          impactLevel: "medium",
          collectedBy: "standard-loader",
        },
      }))
      .build();

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
    const evidence = report.evidence.find((item) => item.claimId === "claim.example.policy-standard.paragraph-9");
    const policyStandard = evidence?.metadata?.policyStandard as {
      inlineText?: string;
      standardVersion?: string;
      paragraphRef?: string;
      reference?: string;
    } | undefined;

    assert.equal(evidence?.evidenceType, "policy_rule");
    assert.equal(evidence?.sourceRef, rawSource.sourceRef);
    assert.equal(evidence?.sourceLocator, "text:paragraph=paragraph-9");
    assert.equal(evidence?.excerptOrSummary, text);
    assert.equal(evidence?.integrityRef, "sha256:standard-paragraph-9");
    assert.equal(evidence?.metadata?.rawSourceKind, "policy-standard");
    assert.equal(evidence?.metadata?.locatorScheme, "text");
    assert.equal(evidence?.metadata?.standardFamily, "example-standard");
    assert.equal(policyStandard?.inlineText, text);
    assert.equal(policyStandard?.standardVersion, "2026.2");
    assert.equal(policyStandard?.paragraphRef, "paragraph-9");
    assert.equal(policyStandard?.reference, "Example Standard 2026 paragraph 9");
  });

  it("projects interpretation records as Surface-compatible events and typed claim metadata", () => {
    const observedAt = "2026-06-07T12:00:00.000Z";
    const policyText = "A producer reading must cite the specific applied rule paragraph.";
    const policySource = policyStandardSource({
      id: "source.example.policy-standard.rule-1",
      sourceRef: "policy-standard://example/rules/2026#rule-1",
      observedAt,
      checksum: "rule-1",
      inlineText: policyText,
      standardVersion: "2026.1",
      paragraphRef: "rule-1",
      reference: "Example Rules 2026 rule 1",
      metadata: { publisher: "Example Standards Body" },
    });
    const input = new SurveyInputBuilder({
      source: "survey.interpretation.fixture",
      generatedAt: "2026-06-07T12:05:00.000Z",
    })
      .addObservation(fieldObservation({
        id: "observation.example.policy-application",
        field: "policyApplication.status",
        value: "DOCUMENTED",
        rawSource: apiRecordSource({
          id: "source.example.application-record",
          sourceRef: "example-records://application/application-1",
          observedAt,
          checksum: "application-1",
        }),
        extraction: {
          target: "policyApplication.status",
          locator: "json:$.policyApplication.status",
          extractor: "example-extractor",
          extractedAt: observedAt,
        },
        claim: {
          id: "claim.example.policy-application",
          subjectType: "example.application",
          subjectId: "application-1",
          surface: "example.review",
          claimType: "policy-application.status",
          impactLevel: "medium",
          collectedBy: "example-extractor",
        },
      }))
      .addRawSource(policySource)
      .addInterpretation({
        id: "interpretation.example.rule-1",
        appliesToClaimId: "claim.example.policy-application",
        anchorsToSourceId: policySource.id,
        ruleLocator: "text:paragraph=rule-1",
        reading: "The producer read rule 1 as requiring a documented policy application status.",
        actor: "producer-operator",
        recordedAt: "2026-06-07T12:04:00.000Z",
        metadata: { readingKind: "producer-reading" },
      })
      .build();

    assert.equal(input.interpretations?.length, 1);

    const trustBundle = buildSurveyTrustBundle(input);
    const valid = validateTrustBundle(trustBundle);
    const report = buildTrustReport(valid);
    const interpretationEvent = report.events.find((event) => event.method === "survey-interpretation");
    const unsupportedEventKeys = Object.keys(interpretationEvent ?? {}).filter(
      (key) => !["id", "claimId", "status", "actor", "method", "evidenceIds", "createdAt", "verifiedAt", "notes"].includes(key),
    );
    const claim = report.claims.find((item) => item.id === "claim.example.policy-application");
    const surveyMetadata = claim?.metadata?.survey as {
      interpretations?: Array<{
        interpretationId?: string;
        ruleLocator?: string;
        reading?: string;
        edges?: Array<Record<string, unknown>>;
      }>;
    } | undefined;
    const interpretationMetadata = surveyMetadata?.interpretations?.[0];
    const anchorEvidence = report.evidence.find((item) => item.id === "interpretation.example.rule-1.evidence.anchor");
    const policyStandard = anchorEvidence?.metadata?.policyStandard as {
      inlineText?: string;
      standardVersion?: string;
      paragraphRef?: string;
      reference?: string;
    } | undefined;

    assert.equal(interpretationEvent?.id, "interpretation.example.rule-1.event");
    assert.equal(interpretationEvent?.claimId, "claim.example.policy-application");
    assert.deepEqual(interpretationEvent?.evidenceIds, ["interpretation.example.rule-1.evidence.anchor"]);
    assert.deepEqual(unsupportedEventKeys, []);
    assert.equal(anchorEvidence?.claimId, "claim.example.policy-application");
    assert.equal(anchorEvidence?.evidenceType, "policy_rule");
    assert.equal(anchorEvidence?.method, "anchoring");
    assert.equal(anchorEvidence?.sourceLocator, "text:paragraph=rule-1");
    assert.equal(policyStandard?.inlineText, policyText);
    assert.equal(policyStandard?.standardVersion, "2026.1");
    assert.equal(policyStandard?.paragraphRef, "rule-1");
    assert.equal(policyStandard?.reference, "Example Rules 2026 rule 1");
    assert.equal(interpretationMetadata?.interpretationId, "interpretation.example.rule-1");
    assert.equal(interpretationMetadata?.ruleLocator, "text:paragraph=rule-1");
    assert.equal(interpretationMetadata?.reading, "The producer read rule 1 as requiring a documented policy application status.");
    assert.deepEqual(interpretationMetadata?.edges, [
      {
        type: "appliesTo",
        targetKind: "claim",
        targetId: "claim.example.policy-application",
      },
      {
        type: "anchorsTo",
        targetKind: "rawSource",
        targetId: policySource.id,
        evidenceId: "interpretation.example.rule-1.evidence.anchor",
        ruleLocator: "text:paragraph=rule-1",
      },
    ]);
  });

  it("throws a clear error when an interpretation anchor raw source is missing", () => {
    const input = new SurveyInputBuilder({
      source: "survey.interpretation.missing-anchor",
      generatedAt: "2026-06-07T12:05:00.000Z",
    })
      .addObservation(fieldObservation({
        id: "observation.example.missing-anchor-target",
        field: "policyApplication.status",
        value: "DOCUMENTED",
        rawSource: manualEntrySource({
          id: "source.example.manual-policy-application",
          sourceRef: "operator://application/application-1/policy-status",
          observedAt: "2026-06-07T12:00:00.000Z",
        }),
        extraction: {
          target: "policyApplication.status",
          extractor: "example-operator",
          extractedAt: "2026-06-07T12:00:00.000Z",
        },
        claim: {
          id: "claim.example.missing-anchor-target",
          subjectType: "example.application",
          subjectId: "application-1",
          surface: "example.review",
          claimType: "policy-application.status",
          impactLevel: "medium",
          collectedBy: "example-operator",
        },
      }))
      .addInterpretation({
        id: "interpretation.example.missing-anchor",
        appliesToClaimId: "claim.example.missing-anchor-target",
        anchorsToSourceId: "source.example.unknown-policy-standard",
        ruleLocator: "text:paragraph=rule-1",
        reading: "The producer recorded a reading against a missing anchor.",
        actor: "producer-operator",
        recordedAt: "2026-06-07T12:04:00.000Z",
      })
      .build();

    assert.throws(
      () => buildSurveyTrustBundle(input),
      /Missing interpretation anchor raw source: source\.example\.unknown-policy-standard/,
    );
  });

  it("throws a clear error for duplicate interpretation ids in raw Survey input", () => {
    const policySource = policyStandardSource({
      id: "source.example.policy-standard.duplicate-interpretation",
      sourceRef: "policy-standard://example/rules/2026#duplicate-interpretation",
      observedAt: "2026-06-07T12:00:00.000Z",
      inlineText: "A producer reading must have one stable interpretation identifier.",
      standardVersion: "2026.1",
      paragraphRef: "duplicate-interpretation",
    });
    const input = new SurveyInputBuilder({
      source: "survey.interpretation.duplicate-id",
      generatedAt: "2026-06-07T12:05:00.000Z",
    })
      .addRawSource(policySource)
      .addObservation(fieldObservation({
        id: "observation.example.duplicate-interpretation",
        field: "policyApplication.status",
        value: "DOCUMENTED",
        rawSource: manualEntrySource({
          id: "source.example.duplicate-interpretation-manual",
          sourceRef: "operator://application/application-1/policy-status",
          observedAt: "2026-06-07T12:00:00.000Z",
        }),
        extraction: {
          target: "policyApplication.status",
          extractor: "example-operator",
          extractedAt: "2026-06-07T12:00:00.000Z",
        },
        claim: {
          id: "claim.example.duplicate-interpretation",
          subjectType: "example.application",
          subjectId: "application-1",
          surface: "example.review",
          claimType: "policy-application.status",
          impactLevel: "medium",
          collectedBy: "example-operator",
        },
      }))
      .addInterpretation({
        id: "interpretation.example.duplicate",
        appliesToClaimId: "claim.example.duplicate-interpretation",
        anchorsToSourceId: policySource.id,
        ruleLocator: "text:paragraph=duplicate-interpretation",
        reading: "The producer recorded the first reading.",
        actor: "producer-operator",
        recordedAt: "2026-06-07T12:04:00.000Z",
      })
      .build();

    const duplicateInput = {
      ...input,
      interpretations: [
        input.interpretations![0]!,
        {
          ...input.interpretations![0]!,
          reading: "The producer recorded a duplicate reading with the same id.",
        },
      ],
    };

    assert.throws(
      () => buildSurveyTrustBundle(duplicateInput),
      /Duplicate interpretation id: interpretation\.example\.duplicate/,
    );
  });

  it("throws a clear error when interpretation claim id and target conflict", () => {
    const policySource = policyStandardSource({
      id: "source.example.policy-standard.conflicting-target",
      sourceRef: "policy-standard://example/rules/2026#conflicting-target",
      observedAt: "2026-06-07T12:00:00.000Z",
      inlineText: "A producer reading must identify one matching claim target.",
      standardVersion: "2026.1",
      paragraphRef: "conflicting-target",
    });
    const input = new SurveyInputBuilder({
      source: "survey.interpretation.conflicting-target",
      generatedAt: "2026-06-07T12:05:00.000Z",
    })
      .addRawSource(policySource)
      .addObservation(fieldObservation({
        id: "observation.example.conflicting-target.status",
        field: "policyApplication.status",
        value: "DOCUMENTED",
        rawSource: manualEntrySource({
          id: "source.example.conflicting-target-status",
          sourceRef: "operator://application/application-1/policy-status",
          observedAt: "2026-06-07T12:00:00.000Z",
        }),
        extraction: {
          target: "policyApplication.status",
          extractor: "example-operator",
          extractedAt: "2026-06-07T12:00:00.000Z",
        },
        claim: {
          id: "claim.example.conflicting-target.status",
          subjectType: "example.application",
          subjectId: "application-1",
          surface: "example.review",
          claimType: "policy-application.status",
          impactLevel: "medium",
          collectedBy: "example-operator",
        },
      }))
      .addObservation(fieldObservation({
        id: "observation.example.conflicting-target.summary",
        field: "policyApplication.summary",
        value: "READY",
        rawSource: manualEntrySource({
          id: "source.example.conflicting-target-summary",
          sourceRef: "operator://application/application-1/policy-summary",
          observedAt: "2026-06-07T12:01:00.000Z",
        }),
        extraction: {
          target: "policyApplication.summary",
          extractor: "example-operator",
          extractedAt: "2026-06-07T12:01:00.000Z",
        },
        claim: {
          id: "claim.example.conflicting-target.summary",
          subjectType: "example.application",
          subjectId: "application-1",
          surface: "example.review",
          claimType: "policy-application.summary",
          impactLevel: "medium",
          collectedBy: "example-operator",
        },
      }))
      .addInterpretation({
        id: "interpretation.example.conflicting-target",
        appliesToClaimId: "claim.example.conflicting-target.status",
        appliesToTarget: "policyApplication.summary",
        anchorsToSourceId: policySource.id,
        ruleLocator: "text:paragraph=conflicting-target",
        reading: "The producer reading intentionally references conflicting targets.",
        actor: "producer-operator",
        recordedAt: "2026-06-07T12:04:00.000Z",
      })
      .build();

    assert.throws(
      () => buildSurveyTrustBundle(input),
      /Interpretation interpretation\.example\.conflicting-target has conflicting appliesToClaimId claim\.example\.conflicting-target\.status and appliesToTarget policyApplication\.summary resolved to claim\.example\.conflicting-target\.summary/,
    );
  });

  it("resolves interpretation target strings only when unambiguous", () => {
    const policySource = policyStandardSource({
      id: "source.example.policy-standard.target-resolution",
      sourceRef: "policy-standard://example/rules/2026#target-resolution",
      observedAt: "2026-06-07T12:00:00.000Z",
      inlineText: "A producer reading may target one unambiguous claim.",
      standardVersion: "2026.1",
      paragraphRef: "target-resolution",
    });
    const builder = new SurveyInputBuilder({
      source: "survey.interpretation.target-resolution",
      generatedAt: "2026-06-07T12:05:00.000Z",
    })
      .addRawSource(policySource)
      .addObservation(fieldObservation({
        id: "observation.example.target-resolution",
        field: "policyApplication.status",
        value: "DOCUMENTED",
        rawSource: manualEntrySource({
          id: "source.example.target-resolution-manual",
          sourceRef: "operator://application/application-1/policy-status",
          observedAt: "2026-06-07T12:00:00.000Z",
        }),
        extraction: {
          target: "policyApplication.status",
          extractor: "example-operator",
          extractedAt: "2026-06-07T12:00:00.000Z",
        },
        claim: {
          id: "claim.example.target-resolution",
          subjectType: "example.application",
          subjectId: "application-1",
          surface: "example.review",
          claimType: "policy-application.status",
          impactLevel: "medium",
          collectedBy: "example-operator",
        },
      }))
      .addInterpretation({
        id: "interpretation.example.target-resolution",
        appliesToTarget: "policyApplication.status",
        anchorsToSourceId: policySource.id,
        ruleLocator: "text:paragraph=target-resolution",
        reading: "The producer reading targets the policy application status.",
        actor: "producer-operator",
        recordedAt: "2026-06-07T12:04:00.000Z",
      });

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(builder.build())));
    const event = report.events.find((item) => item.method === "survey-interpretation");

    assert.equal(event?.claimId, "claim.example.target-resolution");

    const ambiguousInput = {
      ...builder.build(),
      claims: [
        ...builder.build().claims,
        {
          ...builder.build().claims[0]!,
          id: "claim.example.target-resolution.second",
        },
      ],
    };

    assert.throws(
      () => buildSurveyTrustBundle(ambiguousInput),
      /Interpretation interpretation\.example\.target-resolution target policyApplication\.status is ambiguous/,
    );
  });

  it("uses raw source helpers in scalar observations projected to Surface", () => {
    const observedAt = "2026-05-31T15:00:00.000Z";
    const rawSource = apiRecordSource({
      sourceRef: "public-records://entity/entity-1",
      observedAt,
      checksum: "abc123",
      metadata: { provider: "registry" },
    });
    const input = new SurveyInputBuilder({
      source: "survey.raw-source.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    })
      .addObservation(fieldObservation({
        id: "observation.entity-1.registration-status",
        field: "registrationStatus",
        value: "ACTIVE",
        rawSource,
        extraction: {
          confidence: 0.97,
          locator: "json:$.registrationStatus",
          extractor: "public-record-importer",
          extractedAt: observedAt,
        },
        reviewOutcome: {
          status: "verified",
          actor: "records-operator",
          reviewedAt: "2026-05-31T15:05:00.000Z",
        },
        claim: {
          id: "claim.entity-1.registration-status",
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

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
    const evidence = report.evidence.find((item) => item.claimId === "claim.entity-1.registration-status");

    assert.equal(input.rawSources[0]?.id, "api-record:public-records://entity/entity-1");
    assert.equal(evidence?.sourceRef, rawSource.sourceRef);
    assert.equal(evidence?.integrityRef, "sha256:abc123");
    assert.equal(evidence?.metadata?.rawSourceKind, "api-record");
    assert.equal(evidence?.metadata?.locatorScheme, "structured-field");
    assert.equal(evidence?.metadata?.provider, "registry");
  });

  it("projects a verified regulated source-of-authority observation through Surface evidence metadata", () => {
    const observedAt = "2026-06-01T10:00:00.000Z";
    const rawSource = uploadedDocumentSource({
      id: "source.authority.publication-2026",
      sourceRef: "https://authority.example.test/pub/2026-threshold.pdf",
      observedAt,
      checksum: "rule-source",
      locatorScheme: "pdf",
      metadata: { publication: "Authority Publication Example" },
    });
    const input = new SurveyInputBuilder({
      source: "survey.source-of-authority.regulated-rule",
      generatedAt: "2026-06-01T11:00:00.000Z",
    })
      .addObservation(sourceOfAuthorityObservation({
        id: "observation.rule.threshold.primary.2026",
        field: "regulatedRule.threshold.primary.2026",
        value: 30000,
        sourceAuthority: {
          authorityClass: "official_publication",
          scope: {
            jurisdiction: "example",
            productArea: "regulated-rule",
            effectiveYear: 2026,
          },
          effectiveFrom: "2026-01-01",
          effectiveUntil: "2026-12-31",
          sourceVersion: "2026-draft",
          sourceOwner: "authority.example.test",
          declaredBy: "regulated-rule-importer",
        },
        rawSource,
        extraction: {
          confidence: 0.94,
          locator: "pdf:page=12;table=thresholds;row=primary",
          extractor: "regulated-rule-importer",
          extractedAt: observedAt,
        },
        reviewOutcome: {
          status: "verified",
          actor: "rule-reviewer@example.test",
          reviewedAt: "2026-06-01T10:15:00.000Z",
          rationale: "Reviewer accepted the extracted threshold row.",
        },
        claim: {
          id: "claim.rule.threshold.primary.2026",
          subjectType: "regulated-rule",
          subjectId: "example:threshold:primary:2026",
          surface: "regulated.rules",
          claimType: "regulated.rule-value",
          status: "verified",
          impactLevel: "high",
          evidenceType: "policy_rule",
          evidenceMethod: "extraction",
          collectedBy: "regulated-rule-importer",
        },
      }))
      .build();

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
    const claim = report.claims.find((item) => item.id === "claim.rule.threshold.primary.2026");
    const evidence = report.evidence.find((item) => item.claimId === claim?.id);

    assert.equal(claim?.status, "verified");
    assert.equal(claim?.metadata?.survey && typeof claim.metadata.survey, "object");
    assert.equal(
      (claim?.metadata?.survey as { sourceOfAuthority?: { authorityClass?: string } } | undefined)?.sourceOfAuthority?.authorityClass,
      "official_publication",
    );
    assert.equal(evidence?.evidenceType, "policy_rule");
    assert.equal(evidence?.metadata?.sourceAuthority && typeof evidence.metadata.sourceAuthority, "object");
    assert.equal(
      (evidence?.metadata?.sourceAuthority as { authorityClass?: string } | undefined)?.authorityClass,
      "official_publication",
    );
    assert.deepEqual(
      (evidence?.metadata?.sourceAuthority as { scope?: Record<string, unknown> } | undefined)?.scope,
      {
        jurisdiction: "example",
        productArea: "regulated-rule",
        effectiveYear: 2026,
      },
    );
    assert.equal(report.authorityTrace?.length ?? 0, 0);
  });

  it("builds source-of-authority observations through the producer-facing builder", () => {
    const observedAt = "2026-06-02T14:00:00.000Z";
    const observation = sourceOfAuthorityObservationBuilder({
      id: "observation.rule.maximum-value.2026",
      field: "regulatedRule.maximumValue.2026",
      value: 1200,
    })
      .withSourceAuthority({
        authorityClass: "official_publication",
        scope: {
          productArea: "regulated-rule",
          ruleSet: "example",
          effectiveYear: 2026,
        },
        sourceVersion: "2026",
        declaredBy: "regulated-rule-importer",
      })
      .fromSource(uploadedDocumentSource({
        sourceRef: "https://rules.example.test/2026-maximum-value.pdf",
        observedAt,
        checksum: "maximum-value-source",
        locatorScheme: "pdf",
      }))
      .withExtraction({
        confidence: 0.96,
        locator: "pdf:page=4;table=limits;row=maximum",
        extractor: "regulated-rule-importer",
        extractedAt: observedAt,
      })
      .withReviewOutcome({
        status: "verified",
        actor: "rule-reviewer@example.test",
        reviewedAt: "2026-06-02T14:15:00.000Z",
      })
      .forClaim({
        id: "claim.rule.maximum-value.2026",
        subjectType: "regulated-rule",
        subjectId: "example:maximum-value:2026",
        surface: "regulated.rules",
        claimType: "regulated.rule-value",
        status: "verified",
        impactLevel: "high",
        evidenceType: "policy_rule",
        evidenceMethod: "extraction",
        collectedBy: "regulated-rule-importer",
      })
      .build();

    const input = new SurveyInputBuilder({
      source: "survey.source-of-authority.builder",
      generatedAt: "2026-06-02T15:00:00.000Z",
    })
      .addObservation(observation)
      .build();

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
    const claim = report.claims.find((item) => item.id === "claim.rule.maximum-value.2026");
    const evidence = report.evidence.find((item) => item.claimId === claim?.id);

    assert.equal(input.claims[0]?.fieldOrBehavior, "regulatedRule.maximumValue.2026");
    assert.equal(claim?.status, "verified");
    assert.equal(evidence?.metadata?.sourceAuthority && typeof evidence.metadata.sourceAuthority, "object");
    assert.equal(
      (evidence?.metadata?.sourceAuthority as { scope?: { effectiveYear?: number } } | undefined)?.scope?.effectiveYear,
      2026,
    );
    assert.equal(report.authorityTrace?.length ?? 0, 0);
  });

  it("rejects incomplete source-of-authority builder chains before projection", () => {
    const observedAt = "2026-06-02T14:00:00.000Z";
    const builder = () => sourceOfAuthorityObservationBuilder({
      id: "observation.incomplete",
      field: "regulatedRule.status",
      value: "ACTIVE",
    });
    const rawSource = webPageSource({
      sourceRef: "https://policy.example.test/rules",
      observedAt,
      checksum: "policy-page",
    });

    assert.throws(
      () => builder()
        .withSourceAuthority({
          authorityClass: "policy_document",
          scope: { productArea: "regulated-rule" },
          declaredBy: "regulated-rule-importer",
        })
        .build(),
      /builder needs rawSource/,
    );
    assert.throws(
      () => builder()
        .withSourceAuthority({
          authorityClass: "policy_document",
          scope: {},
          declaredBy: "regulated-rule-importer",
        })
        .fromSource(rawSource)
        .withExtraction({
          confidence: 0.9,
          locator: "css:#status",
          extractor: "regulated-rule-importer",
          extractedAt: observedAt,
        })
        .withReviewOutcome({
          status: "verified",
          actor: "rule-reviewer@example.test",
          reviewedAt: "2026-06-02T14:15:00.000Z",
        })
        .forClaim({
          subjectType: "regulated-rule",
          subjectId: "example:status:2026",
          surface: "regulated.rules",
          claimType: "regulated.rule-value",
          status: "verified",
          impactLevel: "high",
          collectedBy: "regulated-rule-importer",
        })
        .build(),
      /needs sourceAuthority\.scope/,
    );
    assert.throws(
      () => builder()
        .withSourceAuthority({
          authorityClass: "policy_document",
          scope: { productArea: "regulated-rule" },
          declaredBy: "regulated-rule-importer",
        })
        .fromSource(rawSource)
        .withExtraction({
          confidence: 0.9,
          extractor: "regulated-rule-importer",
          extractedAt: observedAt,
        })
        .withReviewOutcome({
          status: "verified",
          actor: "rule-reviewer@example.test",
          reviewedAt: "2026-06-02T14:15:00.000Z",
        })
        .forClaim({
          subjectType: "regulated-rule",
          subjectId: "example:status:2026",
          surface: "regulated.rules",
          claimType: "regulated.rule-value",
          status: "verified",
          impactLevel: "high",
          collectedBy: "regulated-rule-importer",
        })
        .build(),
      /without a source locator/,
    );
    assert.throws(
      () => builder()
        .withSourceAuthority({
          authorityClass: "policy_document",
          scope: { productArea: "regulated-rule" },
          declaredBy: "regulated-rule-importer",
        })
        .fromSource(rawSource)
        .withExtraction({
          confidence: 0.9,
          locator: "css:#status",
          extractor: "regulated-rule-importer",
          extractedAt: observedAt,
        })
        .withReviewOutcome({
          status: "verified",
          reviewedAt: "2026-06-02T14:15:00.000Z",
        })
        .forClaim({
          subjectType: "regulated-rule",
          subjectId: "example:status:2026",
          surface: "regulated.rules",
          claimType: "regulated.rule-value",
          status: "verified",
          impactLevel: "high",
          collectedBy: "regulated-rule-importer",
        })
        .build(),
      /without review actor authority/,
    );
    assert.throws(
      () => builder()
        .withSourceAuthority({
          authorityClass: "policy_document",
          scope: { productArea: "regulated-rule" },
          declaredBy: "regulated-rule-importer",
        })
        .fromSource(rawSource)
        .withExtraction({
          confidence: 0.9,
          locator: "css:#status",
          extractor: "regulated-rule-importer",
          extractedAt: observedAt,
        })
        .withReviewOutcome({
          status: "verified",
          actor: "rule-reviewer@example.test",
        })
        .forClaim({
          subjectType: "regulated-rule",
          subjectId: "example:status:2026",
          surface: "regulated.rules",
          claimType: "regulated.rule-value",
          status: "verified",
          impactLevel: "high",
          collectedBy: "regulated-rule-importer",
        })
        .build(),
      /without reviewedAt/,
    );
  });

  it("projects a proposed public-directory source-of-authority observation without reviewer authority", () => {
    const observedAt = "2026-06-01T09:00:00.000Z";
    const rawSource = webPageSource({
      sourceRef: "https://publisher.example.test/listings/item-1",
      observedAt,
      fetchedAt: "2026-06-01T09:01:00.000Z",
      checksum: "listing-page",
      metadata: { provider: "Example Publisher" },
    });
    const input = new SurveyInputBuilder({
      source: "survey.source-of-authority.public-directory",
      generatedAt: "2026-06-01T09:10:00.000Z",
    })
      .addObservation(sourceOfAuthorityObservation({
        id: "observation.listing.item-1.eligibility-range",
        field: "listing.item.eligibilityRange",
        value: { min: 7, max: 12 },
        sourceAuthority: {
          authorityClass: "publisher_owned_page",
          scope: {
            productArea: "provider-listing",
            providerId: "provider.example-publisher",
            listingId: "item-1",
          },
          sourceOwner: "Example Publisher",
          declaredBy: "listing-crawler",
        },
        rawSource,
        extraction: {
          confidence: 0.88,
          locator: "css:[data-field='eligibility-range']",
          extractor: "listing-crawler",
          extractedAt: observedAt,
          excerpt: "Eligibility range 7-12",
        },
        claim: {
          id: "claim.listing.item-1.eligibility-range.proposed",
          subjectType: "provider-listing",
          subjectId: "item-1",
          surface: "public-directory.listings",
          claimType: "published-field",
          status: "proposed",
          impactLevel: "medium",
          collectedBy: "listing-crawler",
        },
      }))
      .build();

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
    const claim = report.claims.find((item) => item.id === "claim.listing.item-1.eligibility-range.proposed");
    const evidence = report.evidence.find((item) => item.claimId === claim?.id);

    assert.equal(claim?.status, "proposed");
    assert.equal(evidence?.metadata?.sourceAuthority && typeof evidence.metadata.sourceAuthority, "object");
    assert.equal(
      (evidence?.metadata?.sourceAuthority as { authorityClass?: string } | undefined)?.authorityClass,
      "publisher_owned_page",
    );
    assert.equal(report.authorityTrace?.length ?? 0, 0);
  });

  it("rejects verified source-of-authority observations without source posture and review posture", () => {
    const observedAt = "2026-06-01T10:00:00.000Z";
    const rawSource = webPageSource({
      sourceRef: "https://policy.example.test/rules",
      observedAt,
      checksum: "policy-page",
    });
    const base = {
      id: "observation.policy.status",
      field: "policy.status",
      value: "ACTIVE",
      sourceAuthority: {
        authorityClass: "policy_document" as const,
        scope: { productArea: "policy" },
        declaredBy: "policy-importer",
      },
      rawSource,
      extraction: {
        confidence: 0.9,
        locator: "css:#status",
        extractor: "policy-importer",
        extractedAt: observedAt,
      },
      reviewOutcome: {
        status: "verified" as const,
        actor: "policy-reviewer",
        reviewedAt: "2026-06-01T10:05:00.000Z",
      },
      claim: {
        subjectType: "policy",
        subjectId: "policy-1",
        surface: "policy.library",
        claimType: "policy-field",
        status: "verified" as const,
        impactLevel: "medium" as const,
        collectedBy: "policy-importer",
      },
    };

    assert.throws(
      () => sourceOfAuthorityObservation({
        ...base,
        sourceAuthority: { ...base.sourceAuthority, scope: {} },
      }),
      /needs sourceAuthority\.scope/,
    );
    assert.throws(
      () => sourceOfAuthorityObservation({
        ...base,
        extraction: { ...base.extraction, locator: undefined },
      }),
      /without a source locator/,
    );
    assert.throws(
      () => sourceOfAuthorityObservation({
        ...base,
        reviewOutcome: { ...base.reviewOutcome, actor: undefined },
      }),
      /without review actor authority/,
    );
    assert.throws(
      () => sourceOfAuthorityObservation({
        ...base,
        reviewOutcome: { ...base.reviewOutcome, reviewedAt: undefined },
      }),
      /without reviewedAt/,
    );
  });

  it("projects Candidate Conflict to a disputed claim with candidate-conflict event", () => {
    const input = buildSurveyTrustBundle({
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
    const valid = validateTrustBundle(input);
    const report = buildTrustReport(valid);

    assert.equal(report.summary.byStatus.disputed, 1);
    assert.equal(report.claims[0]?.status, "disputed");
    assert.equal(report.events[0]?.method, "candidate-conflict");
  });

  it("builds a reviewed candidate resolution with superseded unselected candidates", () => {
    const observedAt = "2026-05-31T15:00:00.000Z";
    const originalSource = uploadedDocumentSource({
      id: "source.original",
      sourceRef: "documents://entity-1/original.pdf",
      observedAt,
      checksum: "original",
      locatorScheme: "structured-field",
    });
    const correctedSource = uploadedDocumentSource({
      id: "source.corrected",
      sourceRef: "documents://entity-1/corrected.pdf",
      observedAt,
      checksum: "corrected",
      locatorScheme: "structured-field",
    });
    const records = reviewedCandidateResolution({
      id: "candidate-set.entity-1.amount",
      target: "reportedAmount",
      selectedCandidateId: "candidate.corrected",
      rationale: "Reviewer selected the corrected document.",
      reviewOutcome: {
        status: "verified",
        actor: "records-operator",
        reviewedAt: "2026-05-31T15:05:00.000Z",
        rationale: "Corrected document supersedes the original document.",
      },
      observations: [
        fieldObservation({
          id: "observation.entity-1.amount.original",
          field: "reportedAmount",
          value: 82000,
          rawSource: originalSource,
          extraction: {
            confidence: 0.94,
            locator: "structured-field:amount",
            extractor: "document-parser",
            extractedAt: observedAt,
          },
          candidate: {
            id: "candidate.original",
            confidence: 0.94,
            rejectionReason: "Corrected source superseded the earlier amount.",
          },
          claim: {
            id: "claim.entity-1.amount.original",
            subjectType: "record.entity",
            subjectId: "entity-1",
            surface: "record.profile",
            claimType: "record.field-candidate",
            impactLevel: "high",
            collectedBy: "document-parser",
          },
        }),
        fieldObservation({
          id: "observation.entity-1.amount.corrected",
          field: "reportedAmount",
          value: 86000,
          rawSource: correctedSource,
          extraction: {
            confidence: 0.96,
            locator: "structured-field:amount",
            extractor: "document-parser",
            extractedAt: observedAt,
          },
          candidate: {
            id: "candidate.corrected",
            confidence: 0.96,
          },
          claim: {
            id: "claim.entity-1.amount.corrected",
            subjectType: "record.entity",
            subjectId: "entity-1",
            surface: "record.profile",
            claimType: "record.field-candidate",
            impactLevel: "high",
            collectedBy: "document-parser",
          },
        }),
      ],
    });
    const input = new SurveyInputBuilder({
      source: "survey.reviewed-candidate-resolution.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    }).addClaimRecords(records).build();

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
    const selected = report.claims.find((claim) => claim.id === "claim.entity-1.amount.corrected");
    const unselected = report.claims.find((claim) => claim.id === "claim.entity-1.amount.original");
    const selectedSurveyMetadata = selected?.metadata?.survey as
      | { candidate?: { rejectionReason?: string } }
      | undefined;
    const unselectedSurveyMetadata = unselected?.metadata?.survey as
      | { candidate?: { rejectionReason?: string } }
      | undefined;

    assert.equal(report.summary.byStatus.verified, 1);
    assert.equal(report.summary.byStatus.superseded, 1);
    assert.equal(selected?.status, "verified");
    assert.equal(selected?.confidenceBasis?.reviewerAuthority, "operator");
    assert.equal(unselected?.status, "superseded");
    assert.equal(input.candidateSets[0]?.selectedCandidateId, "candidate.corrected");
    assert.equal(
      input.candidateSets[0]?.candidates.find((candidate) => candidate.id === "candidate.original")?.rejectionReason,
      "Corrected source superseded the earlier amount.",
    );
    assert.equal(unselectedSurveyMetadata?.candidate?.rejectionReason, "Corrected source superseded the earlier amount.");
    assert.equal(selectedSurveyMetadata?.candidate?.rejectionReason, undefined);
    assert.equal(input.reviewOutcomes[0]?.candidateId, "candidate.corrected");
  });

  it("nests candidate rejection reason without overwriting producer survey metadata", () => {
    const input = new SurveyInputBuilder({
      source: "survey.candidate-rejection-reason.metadata-collision.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    })
      .addRawSource(
        uploadedDocumentSource({
          id: "source.original",
          sourceRef: "documents://entity-1/original.pdf",
          observedAt: "2026-05-31T15:00:00.000Z",
          checksum: "original",
          locatorScheme: "structured-field",
        }),
      )
      .addExtraction({
        id: "extraction.original.amount",
        sourceId: "source.original",
        target: "reportedAmount",
        value: 82000,
        confidence: 0.94,
        locator: "structured-field:amount",
        extractor: "document-parser",
        extractedAt: "2026-05-31T15:00:00.000Z",
      })
      .addCandidateSet({
        id: "candidate-set.entity-1.amount",
        target: "reportedAmount",
        status: "resolved",
        candidates: [
          {
            id: "candidate.original",
            extractionId: "extraction.original.amount",
            value: 82000,
            confidence: 0.94,
            rejectionReason: "",
          },
        ],
      })
      .addClaim({
        id: "claim.entity-1.amount.original",
        candidateSetId: "candidate-set.entity-1.amount",
        candidateId: "candidate.original",
        subjectType: "record.entity",
        subjectId: "entity-1",
        surface: "record.profile",
        claimType: "record.field-candidate",
        fieldOrBehavior: "reportedAmount",
        impactLevel: "high",
        collectedBy: "document-parser",
        metadata: {
          survey: {
            rejectionReason: "producer-owned-top-level-value",
            producerFlag: true,
            candidate: {
              producerCandidateFlag: true,
            },
          },
        },
      })
      .build();

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
    const surveyMetadata = report.claims[0]?.metadata?.survey as
      | {
          rejectionReason?: string;
          producerFlag?: boolean;
          candidate?: { rejectionReason?: string; producerCandidateFlag?: boolean };
        }
      | undefined;

    assert.equal(surveyMetadata?.rejectionReason, "producer-owned-top-level-value");
    assert.equal(surveyMetadata?.producerFlag, true);
    assert.equal(surveyMetadata?.candidate?.producerCandidateFlag, true);
    assert.equal(surveyMetadata?.candidate?.rejectionReason, "");
  });

  it("builds a reviewed current/proposed resolution with a retained current value", () => {
    const observedAt = "2026-05-31T15:00:00.000Z";
    const reviewedAt = "2026-05-31T15:05:00.000Z";
    const records = reviewedCurrentProposedResolution({
      id: "candidate-set.entity-1.contact-phone",
      target: "contactPhone",
      selectedCandidateRole: "current",
      selectedClaimId: "claim.entity-1.contact-phone",
      rationale: "Reviewer kept the current value because the proposed source was ambiguous.",
      reviewOutcome: {
        status: "verified",
        actor: "records-operator",
        reviewedAt,
        rationale: "The proposed contact phone belongs to a different location.",
      },
      unselectedClaimStatus: "rejected",
      currentObservation: fieldObservation({
        id: "observation.entity-1.contact-phone.current",
        field: "contactPhone",
        value: "303-555-0000",
        rawSource: manualEntrySource({
          id: "source.entity-1.contact-phone.current",
          sourceRef: "records://entity-1/current/contact-phone",
          observedAt: reviewedAt,
        }),
        extraction: {
          locator: "structured-field:contactPhone",
          extractor: "current-record",
          extractedAt: reviewedAt,
        },
        claim: {
          id: "claim.entity-1.contact-phone.current-candidate",
          subjectType: "public-record.entity",
          subjectId: "entity-1",
          surface: "public-record.profile",
          claimType: "public-data.field",
          impactLevel: "medium",
          collectedBy: "current-record",
        },
      }),
      proposedObservation: fieldObservation({
        id: "observation.entity-1.contact-phone.proposed",
        field: "contactPhone",
        value: "303-555-0100",
        rawSource: webPageSource({
          id: "source.entity-1.contact-phone.proposed",
          sourceRef: "https://records.example.test/entity-1/contact",
          observedAt,
        }),
        extraction: {
          confidence: 0.64,
          locator: "html:field=contactPhone",
          excerpt: "Call 303-555-0100",
          extractor: "records-crawler",
          extractedAt: observedAt,
        },
        claim: {
          id: "claim.entity-1.contact-phone.proposed-candidate",
          subjectType: "public-record.entity",
          subjectId: "entity-1",
          surface: "public-record.profile",
          claimType: "public-data.field-candidate",
          impactLevel: "medium",
          collectedBy: "records-crawler",
        },
      }),
    });
    const input = new SurveyInputBuilder({
      source: "survey.reviewed-current-proposed-resolution.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    }).addClaimRecords(records).build();

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
    const selected = report.claims.find((claim) => claim.id === "claim.entity-1.contact-phone");
    const unselected = report.claims.find((claim) => claim.id === "claim.entity-1.contact-phone.proposed-candidate");

    assert.equal(report.summary.byStatus.verified, 1);
    assert.equal(report.summary.byStatus.rejected, 1);
    assert.equal(selected?.status, "verified");
    assert.equal(selected?.value, "303-555-0000");
    assert.equal(unselected?.status, "rejected");
    assert.equal(unselected?.value, "303-555-0100");
    assert.equal(input.candidateSets[0]?.selectedCandidateId, "candidate-set.entity-1.contact-phone.current.candidate");
    assert.equal(input.reviewOutcomes[0]?.candidateId, "candidate-set.entity-1.contact-phone.current.candidate");
    assert.equal(report.evidence.find((item) => item.claimId === selected?.id)?.metadata?.candidateRole, "current");
    assert.equal(report.evidence.find((item) => item.claimId === unselected?.id)?.metadata?.candidateRole, "proposed");
  });

  it("rejects verified claims without review authority", () => {
    const broken = structuredClone(publicFieldReviewExample);
    broken.reviewOutcomes = [];
    broken.claims[0] = { ...broken.claims[0], status: "verified" };

    assert.throws(
      () => buildSurveyTrustBundle(broken),
      /cannot be verified without a review outcome/,
    );
  });

  it("rejects non-manual source claims without locators", () => {
    const broken = structuredClone(publicFieldReviewExample);
    broken.extractions[0] = { ...broken.extractions[0], locator: undefined };

    assert.throws(
      () => buildSurveyTrustBundle(broken),
      /needs a source locator/,
    );
  });

  it("builds Survey input through the record builder", () => {
    const input = new SurveyInputBuilder({
        source: "survey.builder.fixture",
        generatedAt: "2026-05-31T16:00:00.000Z",
      })
      .addClaimRecord({
        rawSource: publicFieldReviewExample.rawSources[0]!,
        extraction: publicFieldReviewExample.extractions[0]!,
        candidateSet: publicFieldReviewExample.candidateSets[0]!,
        reviewOutcome: publicFieldReviewExample.reviewOutcomes[0]!,
        claim: publicFieldReviewExample.claims[0]!,
      })
      .build();

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
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

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
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

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
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

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
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

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
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

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
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

  it("projects an escalated candidate set to a disputed claim with candidate-escalation event", () => {
    const input = buildSurveyTrustBundle({
      source: "survey.escalated.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
      rawSources: [{
        id: "source.registry",
        kind: "api-record",
        sourceRef: "records://entity-1/registry",
        observedAt: "2026-05-31T15:00:00.000Z",
        locatorScheme: "structured-field",
      }],
      extractions: [{
        id: "extraction.registry.status",
        sourceId: "source.registry",
        target: "registrationStatus",
        value: "ACTIVE",
        confidence: 0.61,
        locator: "json:$.registrationStatus",
        extractor: "records-importer",
        extractedAt: "2026-05-31T15:00:00.000Z",
      }],
      candidateSets: [{
        id: "candidate-set.entity-1.registration-status",
        target: "registrationStatus",
        status: "escalated",
        rationale: "Low confidence extraction requires specialist review before any status can be proposed.",
        candidates: [{
          id: "candidate.registry.status",
          extractionId: "extraction.registry.status",
          value: "ACTIVE",
          confidence: 0.61,
        }],
      }],
      reviewOutcomes: [],
      claims: [{
        id: "claim.entity-1.registration-status",
        candidateSetId: "candidate-set.entity-1.registration-status",
        candidateId: "candidate.registry.status",
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        fieldOrBehavior: "registrationStatus",
        impactLevel: "high",
        collectedBy: "records-importer",
      }],
    });
    const report = buildTrustReport(validateTrustBundle(input));

    assert.equal(report.summary.byStatus.disputed, 1);
    assert.equal(report.claims[0]?.status, "disputed");
    assert.equal(report.events[0]?.method, "candidate-escalation");
  });

  it("projects a comfort-zone flag to structured claim metadata", () => {
    const input = buildSurveyTrustBundle({
      source: "survey.comfort-zone.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
      rawSources: [{
        id: "source.registry",
        kind: "api-record",
        sourceRef: "records://entity-1/registry",
        observedAt: "2026-05-31T15:00:00.000Z",
        locatorScheme: "structured-field",
      }],
      extractions: [{
        id: "extraction.registry.status",
        sourceId: "source.registry",
        target: "registrationStatus",
        value: "ACTIVE",
        confidence: 0.9,
        locator: "json:$.registrationStatus",
        extractor: "records-importer",
        extractedAt: "2026-05-31T15:00:00.000Z",
      }],
      candidateSets: [{
        id: "candidate-set.entity-1.registration-status",
        target: "registrationStatus",
        status: "resolved",
        selectedCandidateId: "candidate.registry.status",
        candidates: [{
          id: "candidate.registry.status",
          extractionId: "extraction.registry.status",
          value: "ACTIVE",
          confidence: 0.9,
        }],
      }],
      reviewOutcomes: [{
        id: "review.registry.status",
        candidateSetId: "candidate-set.entity-1.registration-status",
        candidateId: "candidate.registry.status",
        status: "assumed",
        actor: "records-operator",
        reviewedAt: "2026-05-31T15:05:00.000Z",
        rationale: "Assumed from registry source.",
        withinComfortZone: false,
        comfortZoneNote: "Renewal clause interpretation requires specialist counsel.",
      }],
      claims: [{
        id: "claim.entity-1.registration-status",
        candidateSetId: "candidate-set.entity-1.registration-status",
        candidateId: "candidate.registry.status",
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        fieldOrBehavior: "registrationStatus",
        impactLevel: "medium",
        collectedBy: "records-importer",
        metadata: {
          survey: {
            producerBatchId: "registry-import-2026-05-31",
            existingReviewSignal: { source: "producer-supplied" },
          },
        },
      }],
    });
    const report = buildTrustReport(validateTrustBundle(input));
    const event = report.events[0];
    const surveyMetadata = report.claims[0]?.metadata?.survey as
      | {
          comfortZone?: { withinComfortZone?: boolean; note?: string };
          existingReviewSignal?: { source?: string };
          producerBatchId?: string;
        }
      | undefined;

    assert.equal(report.claims[0]?.status, "assumed");
    assert.equal(event?.notes, "Assumed from registry source.");
    assert.ok(!event?.notes?.includes("[outside comfort zone]"));
    assert.ok(!event?.notes?.includes("Renewal clause interpretation requires specialist counsel."));
    assert.equal(surveyMetadata?.producerBatchId, "registry-import-2026-05-31");
    assert.deepEqual(surveyMetadata?.existingReviewSignal, { source: "producer-supplied" });
    assert.deepEqual(surveyMetadata?.comfortZone, {
      withinComfortZone: false,
      note: "Renewal clause interpretation requires specialist counsel.",
    });
  });

  it("projects an unresolved attached escalation record as a disputed event on the target claim", () => {
    const builder = new SurveyInputBuilder({
      source: "survey.escalation.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    });
    builder.addObservation(fieldObservation({
      id: "observation.entity-1.fair-value.current",
      field: "fairValue",
      value: 1200000,
      rawSource: {
        kind: "api-record",
        sourceRef: "records://entity-1/valuation",
        observedAt: "2026-05-31T15:00:00.000Z",
        locatorScheme: "structured-field",
      },
      extraction: {
        confidence: 0.85,
        locator: "json:$.fairValue",
        extractor: "valuation-importer",
        extractedAt: "2026-05-31T15:00:00.000Z",
      },
      claim: {
        id: "claim.entity-1.fair-value",
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        impactLevel: "high",
        collectedBy: "valuation-importer",
      },
    }));
    builder.addEscalation({
      id: "escalation.entity-1.fair-value.completeness",
      target: "fairValue",
      dimension: "completeness",
      reason: "ASC 820 Level 3 inputs were not documented; sensitivity range and unobservable input assumptions are missing.",
      raisedBy: "adversary-v1",
      raisedAt: "2026-05-31T15:30:00.000Z",
      attachToClaimId: "claim.entity-1.fair-value",
    });

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(builder.build())));
    const escalationEvent = report.events.find((e) => e.method === "candidate-escalation");

    assert.ok(escalationEvent, "escalation event should exist");
    assert.equal(escalationEvent?.claimId, "claim.entity-1.fair-value");
    assert.equal(escalationEvent?.status, "disputed");
    assert.ok(escalationEvent?.notes?.includes("[completeness]"));
    assert.ok(escalationEvent?.notes?.includes("ASC 820 Level 3 inputs were not documented"));
  });

  it("does not project a resolved escalation record", () => {
    const builder = new SurveyInputBuilder({
      source: "survey.resolved-escalation.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    });
    builder.addObservation(fieldObservation({
      id: "observation.entity-1.fair-value.current",
      field: "fairValue",
      value: 1200000,
      rawSource: {
        kind: "api-record",
        sourceRef: "records://entity-1/valuation",
        observedAt: "2026-05-31T15:00:00.000Z",
        locatorScheme: "structured-field",
      },
      extraction: {
        confidence: 0.91,
        locator: "json:$.fairValue",
        extractor: "valuation-importer",
        extractedAt: "2026-05-31T15:00:00.000Z",
      },
      claim: {
        id: "claim.entity-1.fair-value",
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        impactLevel: "high",
        collectedBy: "valuation-importer",
      },
    }));
    builder.addEscalation({
      id: "escalation.entity-1.fair-value.completeness",
      target: "fairValue",
      dimension: "completeness",
      reason: "Level 3 inputs not documented.",
      raisedBy: "adversary-v1",
      raisedAt: "2026-05-31T15:30:00.000Z",
      attachToClaimId: "claim.entity-1.fair-value",
      resolvedBy: "observation.entity-1.fair-value.current",
    });

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(builder.build())));
    const escalationEvent = report.events.find((e) => e.method === "candidate-escalation");

    assert.equal(escalationEvent, undefined, "resolved escalation should not generate an event");
  });

  it("rejects escalation records that reference unknown claims", () => {
    const builder = new SurveyInputBuilder({
      source: "survey.bad-escalation.fixture",
      generatedAt: "2026-05-31T16:00:00.000Z",
    });
    builder.addEscalation({
      id: "escalation.missing-claim",
      target: "someField",
      dimension: "framing",
      reason: "Wrong question was framed.",
      raisedBy: "adversary-v1",
      raisedAt: "2026-05-31T15:30:00.000Z",
      attachToClaimId: "claim.does-not-exist",
    });

    assert.throws(
      () => buildSurveyTrustBundle(builder.build()),
      /references unknown claim claim\.does-not-exist/,
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

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
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

    const report = buildTrustReport(validateTrustBundle(buildSurveyTrustBundle(input)));
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


describe("SurveyInput contract version", () => {
  it("stamps the default contract version on builder output", () => {
    const input = new SurveyInputBuilder({
      source: "survey.contract-version.default",
      generatedAt: "2026-06-07T12:00:00.000Z",
    }).build();

    assert.equal(input.contractVersion, SURVEY_INPUT_CONTRACT_VERSION);
    assert.equal(input.contractVersion, "1");
  });

  it("respects an explicit contract version override on the builder", () => {
    const input = new SurveyInputBuilder({
      source: "survey.contract-version.override",
      generatedAt: "2026-06-07T12:00:00.000Z",
      contractVersion: "2",
    }).build();

    assert.equal(input.contractVersion, "2");
  });

  it("keeps hand-built SurveyInput records without a contract version valid", () => {
    const input: SurveyInput = {
      source: "survey.contract-version.legacy",
      generatedAt: "2026-06-07T12:00:00.000Z",
      rawSources: [],
      extractions: [],
      candidateSets: [],
      reviewOutcomes: [],
      claims: [],
    };

    assert.equal(input.contractVersion, undefined);
    assert.doesNotThrow(() => buildSurveyTrustBundle(input));
  });
});
