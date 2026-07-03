// Compile-time regression fixture for the Observation authoring core's shared
// base type (`ObservationAuthoringInput`), documented in
// `src/observation-helper.ts`'s module docblock as the shape common to
// `BuildObservationInput` and the two public skins' input types
// (`FieldObservationInput`, `RepeatedObservationInput`).
//
// This file lives under `tests/**/*.ts`, which `tsconfig.json` includes, so
// both `npm run typecheck` and `npm run build` (`tsc`) typecheck it on every
// run. It intentionally does NOT end in `.test.ts`: it makes no runtime
// assertions and is not picked up by `node --test dist/tests/*.test.js`. Its
// only job is to make `tsc` fail if the post-deepening `.d.ts` shape of
// `FieldObservationInput`/`RepeatedObservationInput` stops being
// assignment-compatible with pre-deepening usage, or if the `representation`
// literal unions widen.
//
// Follows the same fixture pattern and header convention as
// `tests/type-fixtures/producer-policy-decision-mode.ts`.

import type { FieldObservationInput, RepeatedObservationInput } from "../../src/index.js";

const rawSource = {
  kind: "api-record" as const,
  sourceRef: "public-records://entity/entity-1",
  observedAt: "2026-07-02T00:00:00.000Z",
  locatorScheme: "structured-field" as const,
};

// 1a. A value shaped exactly like the pre-deepening `FieldObservationInput`
//     inline interface (id/field/value/rawSource/extraction/reviewOutcome/
//     claim/candidate/candidateSet/representation/metadata, with no knowledge
//     of the post-deepening `ObservationAuthoringInput` base type) still
//     type-checks against the post-deepening exported type.
const preDeepeningShapedFieldInput: FieldObservationInput<string> = {
  id: "observation.fixture.field.pre-deepening-shape",
  field: "entity.name",
  value: "Acme Corp",
  rawSource,
  extraction: {
    locator: "json:$.name",
    extractor: "importer",
    extractedAt: "2026-07-02T00:00:00.000Z",
    target: "entity.name",
    excerpt: "entity.name: Acme Corp",
  },
  reviewOutcome: {
    status: "verified",
    actor: "reviewer-1",
    reviewedAt: "2026-07-02T00:00:00.000Z",
  },
  claim: {
    subjectType: "entity",
    subjectId: "entity-1",
    facet: "profile",
    claimType: "entity.name",
    impactLevel: "medium",
    collectedBy: "importer",
    fieldOrBehavior: "entity.name",
  },
  candidate: { confidence: 0.9 },
  candidateSet: { rationale: "single-source" },
  representation: "scalar",
  metadata: { producerField: "name", survey: { producerNote: "kept" } },
};

// 1b. Same for `RepeatedObservationInput` (`readonly TItem[]` value shape).
const preDeepeningShapedRepeatedInput: RepeatedObservationInput<string> = {
  id: "observation.fixture.repeated.pre-deepening-shape",
  field: "entity.aliases",
  value: ["Alias A", "Alias B"],
  rawSource,
  extraction: {
    locator: "json:$.aliases",
    extractor: "importer",
    extractedAt: "2026-07-02T00:00:00.000Z",
  },
  claim: {
    subjectType: "entity",
    subjectId: "entity-1",
    facet: "profile",
    claimType: "entity.aliases",
    impactLevel: "medium",
    collectedBy: "importer",
  },
  representation: "aggregate-array",
  metadata: { producerField: "aliases" },
};

// 2. Minimal-required-fields shape (no `representation`, no `metadata`, no
//    `reviewOutcome`/`candidate`/`candidateSet`) keeps compiling — confirms
//    those stayed optional through the shared-base collapse.
const minimalFieldInput: FieldObservationInput<number> = {
  id: "observation.fixture.field.minimal",
  field: "score",
  value: 42,
  rawSource,
  extraction: {
    locator: "json:$.score",
    extractor: "importer",
    extractedAt: "2026-07-02T00:00:00.000Z",
  },
  claim: {
    subjectType: "entity",
    subjectId: "entity-1",
    facet: "profile",
    claimType: "entity.score",
    impactLevel: "low",
    collectedBy: "importer",
  },
};

// 3a. `representation` literal union rejects a value outside "scalar" for
//     `FieldObservationInput`. If the shared-base collapse ever widens this
//     to `string`, this assignment stops being an error and `tsc` fails with
//     "Unused '@ts-expect-error' directive", catching the regression (the
//     plan's explicitly called-out Stop-short risk). Declared as a single-line
//     object literal so the reported error position lines up with the
//     directive, matching `producer-policy-decision-mode.ts`'s pattern.
declare const wrongFieldRepresentation: "aggregate-array";
// @ts-expect-error representation is the literal union "scalar" | undefined, not "aggregate-array".
const rejectsWrongFieldRepresentation: FieldObservationInput<string> = { ...minimalFieldInput, field: "entity.name", value: "Acme Corp", representation: wrongFieldRepresentation };

// 3b. Same for `RepeatedObservationInput`'s "aggregate-array" literal.
declare const wrongRepeatedRepresentation: "scalar";
// @ts-expect-error representation is the literal union "aggregate-array" | undefined, not "scalar".
const rejectsWrongRepeatedRepresentation: RepeatedObservationInput<string> = { ...preDeepeningShapedRepeatedInput, representation: wrongRepeatedRepresentation };

// 4a. Omitting a required base field (`id`) still fails to compile for
//     `FieldObservationInput`.
// @ts-expect-error id is required on the shared ObservationAuthoringInput base.
const missingIdFieldInput: FieldObservationInput<string> = {
  field: "entity.name",
  value: "Acme Corp",
  rawSource,
  extraction: {
    locator: "json:$.name",
    extractor: "importer",
    extractedAt: "2026-07-02T00:00:00.000Z",
  },
  claim: {
    subjectType: "entity",
    subjectId: "entity-1",
    facet: "profile",
    claimType: "entity.name",
    impactLevel: "medium",
    collectedBy: "importer",
  },
};

// 4b. Omitting a required base field (`claim`) still fails to compile for
//     `RepeatedObservationInput`.
// @ts-expect-error claim is required on the shared ObservationAuthoringInput base.
const missingClaimRepeatedInput: RepeatedObservationInput<string> = {
  id: "observation.fixture.repeated.missing-claim",
  field: "entity.aliases",
  value: ["Alias A"],
  rawSource,
  extraction: {
    locator: "json:$.aliases",
    extractor: "importer",
    extractedAt: "2026-07-02T00:00:00.000Z",
  },
};

console.log(
  "observation-authoring-skins typecheck fixture compiled OK",
  !!preDeepeningShapedFieldInput,
  !!preDeepeningShapedRepeatedInput,
  !!minimalFieldInput,
  !!rejectsWrongFieldRepresentation,
  !!rejectsWrongRepeatedRepresentation,
  !!missingIdFieldInput,
  !!missingClaimRepeatedInput,
);
