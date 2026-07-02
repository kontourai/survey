import { buildTrustReport, validateTrustBundle } from "@kontourai/surface";
import { buildSurveyTrustBundle, SurveyInputBuilder } from "../src/index.js";

const observedAt = "2026-05-31T16:00:00.000Z";

const surveyInput = new SurveyInputBuilder({
  source: "example-producer:public-field",
  generatedAt: observedAt,
})
  .addObservation({
    id: "example.entity-1.availability.current",
    rawSource: {
      kind: "web-page",
      sourceRef: "https://example.test/entities/1",
      observedAt,
      locatorScheme: "html",
    },
    extraction: {
      target: "availabilityStatus",
      value: "AVAILABLE",
      confidence: 0.92,
      locator: "html:field=availabilityStatus",
      excerpt: "Availability is open.",
      extractor: "example-crawler",
      extractedAt: observedAt,
    },
    reviewOutcome: {
      status: "verified",
      actor: "example-operator",
      reviewedAt: observedAt,
    },
    claim: {
      subjectType: "public-record.entity",
      subjectId: "entity-1",
      facet: "public-record.profile",
      claimType: "public-data.field",
      fieldOrBehavior: "availabilityStatus",
      impactLevel: "medium",
      collectedBy: "example-crawler",
    },
  })
  .build();

const trustBundle = validateTrustBundle(buildSurveyTrustBundle(surveyInput));
const report = buildTrustReport(trustBundle);

console.log(JSON.stringify(report.summary, null, 2));
