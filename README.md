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

## Field observations

Use `fieldObservation` when a producer wants to describe one scalar field value
without hand-assembling the repeated source, extraction, candidate, review, and
claim defaults. The helper returns a normal `SurveyObservationInput`, so it
works with `SurveyInputBuilder.addObservation` and the same Surface projection
path.

```ts
import {
  buildSurveyTrustInput,
  fieldObservation,
  SurveyInputBuilder,
} from "@kontourai/survey";

const surveyInput = new SurveyInputBuilder({
  source: "example-producer:run-1",
})
  .addObservation(fieldObservation({
    id: "entity-123.status.current",
    field: "registrationStatus",
    value: "ACTIVE",
    rawSource: {
      kind: "api-record",
      sourceRef: "example-records://entity/entity-123",
      observedAt: new Date().toISOString(),
      locatorScheme: "structured-field",
    },
    extraction: {
      confidence: 0.97,
      locator: "json:$.registrationStatus",
      extractor: "example-extractor",
      extractedAt: new Date().toISOString(),
    },
    reviewOutcome: {
      status: "verified",
      actor: "records-operator",
      reviewedAt: new Date().toISOString(),
    },
    claim: {
      subjectType: "public-record.entity",
      subjectId: "entity-123",
      surface: "example.profile",
      claimType: "public-data.field",
      status: "verified",
      impactLevel: "medium",
      collectedBy: "example-extractor",
    },
    metadata: {
      producerField: "registration_status",
    },
  }))
  .build();

const trustInput = buildSurveyTrustInput(surveyInput);
```

`fieldObservation` sets `extraction.target` and `claim.fieldOrBehavior` from
`field` when omitted, uses the scalar as both the extraction and claim value,
and adds neutral helper metadata at
`metadata.survey.field = { representation: "scalar" }`. Producer metadata is
preserved. Producers still own scalar semantics, validation, candidate ranking,
review policy, and whether a value should be verified, proposed, rejected, or
assumed.

## Repeated observations

Use `repeatedObservation` when a producer wants to describe a repeated field or
entity list as one aggregate observation. The helper returns a normal
`SurveyObservationInput`, so it works with `SurveyInputBuilder.addObservation`
and the same Surface projection path.

```ts
import {
  buildSurveyTrustInput,
  repeatedObservation,
  SurveyInputBuilder,
} from "@kontourai/survey";

const aliases = [
  { name: "North Annex", sourceLabel: "record row 1" },
  { name: "East Annex", sourceLabel: "record row 2" },
];

const surveyInput = new SurveyInputBuilder({
  source: "example-producer:run-1",
})
  .addObservation(repeatedObservation({
    id: "entity-123.aliases.current",
    field: "knownAliases",
    value: aliases,
    rawSource: {
      kind: "api-record",
      sourceRef: "example-records://entity/entity-123",
      observedAt: new Date().toISOString(),
      locatorScheme: "structured-field",
    },
    extraction: {
      confidence: 0.88,
      locator: "json:$.aliases",
      extractor: "example-extractor",
      extractedAt: new Date().toISOString(),
    },
    reviewOutcome: {
      status: "verified",
      actor: "records-operator",
      reviewedAt: new Date().toISOString(),
    },
    claim: {
      subjectType: "public-record.entity",
      subjectId: "entity-123",
      surface: "example.profile",
      claimType: "public-data.repeated-field",
      status: "verified",
      impactLevel: "medium",
      collectedBy: "example-extractor",
    },
    metadata: {
      producerField: "aliases",
    },
  }))
  .build();

const trustInput = buildSurveyTrustInput(surveyInput);
```

`repeatedObservation` sets `extraction.target` and
`claim.fieldOrBehavior` from `field` when omitted, uses the array as both the
extraction and claim value, and adds neutral helper metadata at
`metadata.survey.repeated = { representation: "aggregate-array", itemCount }`.
Producer metadata is preserved. Producers still own item semantics,
validation, candidate ranking, review policy, and whether a value should be
verified, proposed, rejected, or assumed.

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
