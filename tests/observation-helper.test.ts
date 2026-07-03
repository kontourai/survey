/**
 * Tests for the Observation authoring core's merge seam — src/observation-helper.ts.
 *
 * Imports `mergeObservationMetadata`/`mergeNestedRecords` directly (module-internal
 * seam, matching `tests/producer-discipline.test.ts`'s pattern) and pins the exact,
 * current characterization of `mergeNestedRecords`'s per-key branch logic and
 * `mergeObservationMetadata`'s claimMetadata/metadata/surveyMetadata precedence —
 * including the asymmetric nested-record-vs-scalar collision handling and the `??`
 * null/undefined coalescing called out in the plan's Stop-short risks. These are
 * characterization tests: they pin what the code does today, not what a "cleaner"
 * implementation would do (see `src/observation-helper.ts`'s docblock and the
 * "dead-code redundancy" note on `mergeObservationMetadata`'s leading two spreads).
 *
 * Also covers representation-layer parity: `buildFieldObservation`/
 * `buildRepeatedObservation` (the internal representation-keyed layer) must produce
 * byte-identical `SurveyObservationInput` output to calling the public
 * `fieldObservation`/`repeatedObservation` skins directly, for both representations,
 * with and without explicit `excerpt`/`metadata`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeObservationMetadata,
  mergeNestedRecords,
  buildFieldObservation,
  buildRepeatedObservation,
  type ObservationAuthoringInput,
} from "../src/observation-helper.js";
import { fieldObservation } from "../src/field-observation.js";
import { repeatedObservation } from "../src/repeated-observation.js";

describe("mergeNestedRecords", () => {
  it("branch A: all-three-records 3-way shallow merge, helper wins on key collision", () => {
    const result = mergeNestedRecords(
      { k: { a: 1, shared: "claim" } },
      { k: { b: 2, shared: "metadata" } },
      { k: { c: 3, shared: "helper" } },
    );

    assert.deepEqual(result, {
      k: { a: 1, b: 2, c: 3, shared: "helper" },
    });
  });

  it("branch B: claim+helper both records with the metadata key absent (undefined) — no metadata involvement", () => {
    const result = mergeNestedRecords(
      { k: { a: 1, shared: "claim" } },
      {}, // metadata's "survey" record has no "k" key at all -> metadataValue undefined for "k"
      { k: { c: 3, shared: "helper" } },
    );

    assert.deepEqual(result, {
      k: { a: 1, c: 3, shared: "helper" },
    });
  });

  it("branch C: metadata+helper both records, claim also a populated record (but absent at this key) — metadata+helper pair wins, claim's contribution to this key is dropped entirely", () => {
    // claimSurvey is itself a populated record ("also a record") with its own
    // "source" key, but it does not have a "labels" key at all. Because
    // mergeNestedRecords' branch order checks the all-three-records branch (A)
    // first, branch C (isRecord(metadataValue) && isRecord(helperValue)) can
    // only fire for a given key when claimValue is NOT a record at that key —
    // so "claim also a record" describes the container, not this key's value.
    const result = mergeNestedRecords(
      { source: { origin: "claim-only" } },
      { labels: { advisory: true } },
      { labels: { authoritative: true } },
    );

    assert.deepEqual(result, {
      source: { origin: "claim-only" },
      labels: { advisory: true, authoritative: true },
    });
  });

  it("nested-record-vs-scalar collision, direction 1: claim=record, metadata=defined non-record scalar, helper=record -> helper record wholesale (metadata's scalar and claim's record keys both discarded, no merge)", () => {
    const result = mergeNestedRecords(
      { labels: { a: 1, b: 2 } },
      { labels: "scalar-value" },
      { labels: { c: 3 } },
    );

    assert.deepEqual(result, { labels: { c: 3 } });
  });

  it("nested-record-vs-scalar collision, direction 2: claim=scalar, metadata=record, helper=record -> metadata+helper merge (claim's scalar discarded; contrast with direction 1's no-merge-just-overwrite to show the asymmetry)", () => {
    const result = mergeNestedRecords(
      { labels: "scalar-value" },
      { labels: { a: 1 } },
      { labels: { b: 2 } },
    );

    assert.deepEqual(result, { labels: { a: 1, b: 2 } });
  });

  it("pins the ASYMMETRY exactly as it behaves today: claim-record + metadata-scalar + helper-record does NOT merge (helper wins wholesale), but claim-scalar + metadata-record + helper-record DOES merge (metadata+helper combine) — the two directions are not symmetric", () => {
    const direction1 = mergeNestedRecords(
      { field: { keep: "claim-a", drop: "claim-b" } },
      { field: "metadata-scalar" },
      { field: { keep: "helper-a" } },
    );
    const direction2 = mergeNestedRecords(
      { field: "claim-scalar" },
      { field: { keep: "metadata-a" } },
      { field: { keep: "helper-a", extra: "helper-b" } },
    );

    // Direction 1: no merge at all — the helper record replaces everything;
    // claim's "drop" key and metadata's scalar are both gone, not just overwritten-per-key.
    assert.deepEqual(direction1, { field: { keep: "helper-a" } });
    // Direction 2: metadata and helper DO shallow-merge (helper wins on collision),
    // claim's scalar is simply discarded.
    assert.deepEqual(direction2, { field: { keep: "helper-a", extra: "helper-b" } });
  });

  it("explicit null helper value is coalesced away by ?? in favor of the metadata value (null treated identically to undefined, not as an explicit clear)", () => {
    const result = mergeNestedRecords(
      { flag: "claim-val" },
      { flag: "metadata-val" },
      { flag: null },
    );

    assert.deepEqual(result, { flag: "metadata-val" });
  });

  it("explicit null helper value, with metadata also absent, falls through to the claim value (proving the full ?? chain, not just the first fallback)", () => {
    const result = mergeNestedRecords(
      { flag: "claim-val" },
      {},
      { flag: null },
    );

    assert.deepEqual(result, { flag: "claim-val" });
  });
});

describe("mergeObservationMetadata", () => {
  it("a key present only in claimMetadata.survey passes through unchanged when metadata/helper omit it", () => {
    const result = mergeObservationMetadata({ survey: { onlyClaim: "x" } }, undefined, {});

    assert.deepEqual(result, { survey: { onlyClaim: "x" } });
  });

  it("a key present only in metadata.survey passes through unchanged when claim/helper omit it", () => {
    const result = mergeObservationMetadata(undefined, { survey: { onlyMetadata: "y" } }, {});

    assert.deepEqual(result, { survey: { onlyMetadata: "y" } });
  });

  it("a key present only in the helper-supplied surveyMetadata passes through unchanged", () => {
    const result = mergeObservationMetadata(undefined, undefined, { onlyHelper: "z" });

    assert.deepEqual(result, { survey: { onlyHelper: "z" } });
  });

  it("top-level (non-survey) key collision between claimMetadata and metadata: metadata (the helper-facing option) wins, per the {...claimMetadata, ...metadata, ...} spread order", () => {
    const result = mergeObservationMetadata(
      { shared: "claim", survey: {} },
      { shared: "metadata", survey: {} },
      {},
    );

    assert.deepEqual(result, { shared: "metadata", survey: {} });
  });

  it("key-precedence order across claimMetadata.survey / metadata.survey / surveyMetadata: helper wins over metadata, metadata wins over claim, when all three define the same key", () => {
    const result = mergeObservationMetadata(
      { survey: { note: "claim-note" } },
      { survey: { note: "metadata-note" } },
      { note: "helper-note" },
    );

    assert.deepEqual(result, { survey: { note: "helper-note" } });
  });

  it("explicit null on a surveyMetadata (helper) key is coalesced away by ?? in favor of claimMetadata.survey / metadata.survey, exactly as mergeNestedRecords behaves", () => {
    const favorsMetadata = mergeObservationMetadata(
      { survey: { flag: "claim-val" } },
      { survey: { flag: "metadata-val" } },
      { flag: null },
    );
    assert.deepEqual(favorsMetadata, { survey: { flag: "metadata-val" } });

    const favorsClaim = mergeObservationMetadata(
      { survey: { flag: "claim-val" } },
      undefined,
      { flag: null },
    );
    assert.deepEqual(favorsClaim, { survey: { flag: "claim-val" } });
  });

  it("a non-record claimMetadata.survey value is treated as an empty record (does not throw, does not leak into the merge)", () => {
    const result = mergeObservationMetadata({ survey: "not-a-record" }, undefined, {});

    assert.deepEqual(result, { survey: {} });
  });
});

describe("representation-layer parity: buildFieldObservation/buildRepeatedObservation vs the public skins", () => {
  const rawSource = {
    kind: "api-record" as const,
    sourceRef: "public-records://entity/entity-1",
    observedAt: "2026-07-02T00:00:00.000Z",
    locatorScheme: "structured-field" as const,
  };

  const scalarInput: ObservationAuthoringInput<string> = {
    id: "observation.parity.field.minimal",
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

  const scalarInputWithExtras: ObservationAuthoringInput<string> = {
    ...scalarInput,
    id: "observation.parity.field.full",
    extraction: {
      ...scalarInput.extraction,
      target: "custom.target",
      excerpt: "explicit excerpt text",
    },
    metadata: {
      producerField: "name",
      survey: { producerNote: "kept", field: { extra: "x" } },
    },
  };

  const aggregateInput: ObservationAuthoringInput<readonly string[]> = {
    id: "observation.parity.repeated.minimal",
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
  };

  const aggregateInputWithExtras: ObservationAuthoringInput<readonly string[]> = {
    ...aggregateInput,
    id: "observation.parity.repeated.full",
    extraction: {
      ...aggregateInput.extraction,
      target: "custom.target",
      excerpt: "explicit excerpt text",
    },
    metadata: {
      producerField: "aliases",
      survey: { producerNote: "kept", repeated: { extra: "x" } },
    },
  };

  it("buildFieldObservation matches fieldObservation byte-identically for a scalar fixture without explicit excerpt/metadata", () => {
    assert.deepEqual(buildFieldObservation(scalarInput), fieldObservation(scalarInput));
  });

  it("buildFieldObservation matches fieldObservation byte-identically for a scalar fixture with explicit excerpt/metadata", () => {
    assert.deepEqual(
      buildFieldObservation(scalarInputWithExtras),
      fieldObservation(scalarInputWithExtras),
    );
  });

  it("buildRepeatedObservation matches repeatedObservation byte-identically for an aggregate-array fixture without explicit excerpt/metadata", () => {
    assert.deepEqual(
      buildRepeatedObservation(aggregateInput),
      repeatedObservation(aggregateInput),
    );
  });

  it("buildRepeatedObservation matches repeatedObservation byte-identically for an aggregate-array fixture with explicit excerpt/metadata", () => {
    assert.deepEqual(
      buildRepeatedObservation(aggregateInputWithExtras),
      repeatedObservation(aggregateInputWithExtras),
    );
  });
});
