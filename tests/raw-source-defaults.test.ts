/**
 * Direct tests for the Raw Source default-locatorScheme table and
 * constructor seam — src/raw-source.ts.
 *
 * `DEFAULT_LOCATOR_SCHEME` and `apiRecordSource`/`webPageSource`/
 * `manualEntrySource`/`uploadedDocumentSource` are consumed here by relative
 * import, matching the `tests/producer-discipline.test.ts` convention for a
 * module-internal seam.
 *
 * Covers:
 * - Each factory's per-kind default `locatorScheme` (apiRecordSource,
 *   webPageSource -> structured-field/html; manualEntrySource ->
 *   structured-field).
 * - `uploadedDocumentSource`'s no-default behavior: its required
 *   `locatorScheme` always passes through, and the table's own
 *   `uploaded-document` entry is `undefined` (a real, explicit "no default"
 *   state, not an omission).
 * - The previously-untested gap: an explicit `locatorScheme` argument
 *   overrides the per-kind default for `apiRecordSource`/`webPageSource`/
 *   `manualEntrySource`.
 * - The `DEFAULT_LOCATOR_SCHEME` literal values, pinned directly.
 * - Spot assertions that `policyStandardSource` and `normalizeChecksum`
 *   (checksum normalization, exercised indirectly through every factory)
 *   remain unaffected by the table/constructor consolidation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  apiRecordSource,
  DEFAULT_LOCATOR_SCHEME,
  manualEntrySource,
  policyStandardSource,
  uploadedDocumentSource,
  webPageSource,
} from "../src/raw-source.js";

const observedAt = "2026-06-01T00:00:00.000Z";

describe("DEFAULT_LOCATOR_SCHEME", () => {
  it("pins the literal default locatorScheme for each kind with a default", () => {
    assert.equal(DEFAULT_LOCATOR_SCHEME["api-record"], "structured-field");
    assert.equal(DEFAULT_LOCATOR_SCHEME["web-page"], "html");
    assert.equal(DEFAULT_LOCATOR_SCHEME["manual-entry"], "structured-field");
  });

  it("models uploaded-document as a real, explicit no-default entry", () => {
    assert.ok("uploaded-document" in DEFAULT_LOCATOR_SCHEME);
    assert.equal(DEFAULT_LOCATOR_SCHEME["uploaded-document"], undefined);
  });
});

describe("apiRecordSource default locatorScheme", () => {
  it("defaults locatorScheme to structured-field when not supplied", () => {
    const source = apiRecordSource({
      sourceRef: "public-records://entity/entity-1",
      observedAt,
    });

    assert.equal(source.locatorScheme, "structured-field");
  });

  it("uses an explicit locatorScheme override instead of the default", () => {
    const source = apiRecordSource({
      sourceRef: "public-records://entity/entity-1",
      observedAt,
      locatorScheme: "text-span",
    });

    assert.equal(source.locatorScheme, "text-span");
  });
});

describe("webPageSource default locatorScheme", () => {
  it("defaults locatorScheme to html when not supplied", () => {
    const source = webPageSource({
      sourceRef: "https://records.example.test/entities/entity-1",
      observedAt,
    });

    assert.equal(source.locatorScheme, "html");
  });

  it("uses an explicit locatorScheme override instead of the default", () => {
    const source = webPageSource({
      sourceRef: "https://records.example.test/entities/entity-1",
      observedAt,
      locatorScheme: "pdf",
    });

    assert.equal(source.locatorScheme, "pdf");
  });
});

describe("manualEntrySource default locatorScheme", () => {
  it("defaults locatorScheme to structured-field when not supplied", () => {
    const source = manualEntrySource({
      sourceRef: "operator://entity/entity-1/status",
      observedAt,
    });

    assert.equal(source.locatorScheme, "structured-field");
  });

  it("uses an explicit locatorScheme override instead of the default", () => {
    const source = manualEntrySource({
      sourceRef: "operator://entity/entity-1/status",
      observedAt,
      locatorScheme: "text",
    });

    assert.equal(source.locatorScheme, "text");
  });
});

describe("uploadedDocumentSource has no default locatorScheme", () => {
  it("requires and passes through the caller-supplied locatorScheme unchanged", () => {
    const source = uploadedDocumentSource({
      sourceRef: "documents://entity-1/profile.pdf",
      observedAt,
      locatorScheme: "pdf",
    });

    assert.equal(source.locatorScheme, "pdf");
  });

  it("passes through a different caller-supplied locatorScheme with no silent override", () => {
    const source = uploadedDocumentSource({
      sourceRef: "documents://entity-1/profile.pdf",
      observedAt,
      locatorScheme: "structured-field",
    });

    assert.equal(source.locatorScheme, "structured-field");
  });
});

describe("policyStandardSource and normalizeChecksum remain unaffected", () => {
  it("still defaults locatorScheme to text and normalizes a checksum", () => {
    const source = policyStandardSource({
      sourceRef: "policy-standard://example/rules/2026#paragraph-4",
      observedAt,
      checksum: "abc123",
      inlineText: "Applications must include a complete evidence reference.",
      standardVersion: "2026-06-01",
      paragraphRef: "paragraph-4",
    });

    assert.equal(source.locatorScheme, "text");
    assert.equal(source.checksum, "sha256:abc123");
  });

  it("normalizes checksum objects with a supplied algorithm across factories", () => {
    const source = apiRecordSource({
      sourceRef: "public-records://entity/entity-1",
      observedAt,
      checksum: { algorithm: "sha512", value: "def456" },
    });

    assert.equal(source.checksum, "sha512:def456");
  });

  it("leaves an already-normalized checksum string untouched", () => {
    const source = webPageSource({
      sourceRef: "https://records.example.test/entities/entity-1",
      observedAt,
      checksum: "sha256:already-normalized",
    });

    assert.equal(source.checksum, "sha256:already-normalized");
  });
});
