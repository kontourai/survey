# Kontour Survey

Survey is the producer-side contract for turning raw observations into
Surface-ready trust records.

This repo is intentionally small right now. It is a proof package, not an
ingestion platform:

- producers own acquisition, parsing, ranking, review UX, and vertical policy;
- Survey owns source, extraction, candidate, and review record shapes;
- `buildSurveyTrustInput` projects those records into `@kontourai/surface`
  `TrustInput`;
- Surface owns trust reporting, derivation, console projections, and downstream
  transparency.

The first success criterion is that generic corrected-document and public-field
fixtures can pass through Survey and produce valid Surface reports without
Survey absorbing vertical policy.

## Quickstart

```ts
import { buildTrustReport, validateTrustInput } from "@kontourai/surface";
import { buildSurveyTrustInput, SurveyInputBuilder } from "@kontourai/survey";

const surveyInput = new SurveyInputBuilder({
  source: "example-producer:run-1",
})
  .addObservation({
    id: "listing-123.availability.current",
    rawSource: {
      kind: "web-page",
      sourceRef: "https://example.test/listings/123",
      observedAt: new Date().toISOString(),
      locatorScheme: "html",
    },
    extraction: {
      target: "availabilityStatus",
      value: "AVAILABLE",
      confidence: 0.92,
      locator: "html:field=availabilityStatus",
      excerpt: "Availability is open.",
      extractor: "example-crawler",
      extractedAt: new Date().toISOString(),
    },
    reviewOutcome: {
      status: "verified",
      actor: "example-operator",
      reviewedAt: new Date().toISOString(),
    },
    claim: {
      subjectType: "public-record.entity",
      subjectId: "listing-123",
      surface: "public-record.profile",
      claimType: "public-data.field",
      fieldOrBehavior: "availabilityStatus",
      impactLevel: "medium",
      collectedBy: "example-crawler",
    },
  })
  .build();

const trustInput = validateTrustInput(buildSurveyTrustInput(surveyInput));
const report = buildTrustReport(trustInput);
```

## Product Boundary

Survey does not crawl pages, parse PDFs, rank candidates, decide review policy,
or claim a value is true. Producers own acquisition, extraction, ranking, review
UX, materiality, and domain policy. Survey gives those producers a consistent
source -> extraction -> candidate -> review -> claim contract before the records
enter Surface.

## Commands

```sh
npm install
npm run verify
```
