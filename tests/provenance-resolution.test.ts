import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  apiRecordSource,
  buildSurveyTrustBundle,
  fieldObservation,
  manualEntrySource,
  policyStandardSource,
  SurveyInputBuilder,
  type ProvenanceResolution,
  type RawSource,
  type ReviewAuthorizing,
  type RawSourceKind,
  uploadedDocumentSource,
  webPageSource,
} from "../src/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;
type ExpectedResolution =
  | "extraction"
  | "testimony"
  | "supersession"
  | "precedence-selection"
  | "carry-forward"
  | "observation";
type _ResolutionIsExact = Assert<Equal<ProvenanceResolution, ExpectedResolution>>;

const observedAt = "2026-07-10T12:00:00.000Z";
const explicitAuthorization: ReviewAuthorizing = {
  kind: "explicit-statement",
  statement: "The operator confirmed the recorded value.",
  source: "review://session/1",
};

const conformanceShapes: Array<{
  label: string;
  origin: RawSourceKind;
  resolution: ProvenanceResolution;
  authorization?: ReviewAuthorizing;
  metadata?: Record<string, unknown>;
}> = [
  // Merged fixture shape: anchored document field.
  { label: "anchored document field", origin: "uploaded-document", resolution: "extraction" },
  // Merged fixture shape: replacement of an earlier recorded value.
  { label: "replacement record", origin: "manual-entry", resolution: "supersession", authorization: explicitAuthorization },
  // Merged fixture shape: per-row operator statement retained outside the triple.
  { label: "row statement", origin: "manual-entry", resolution: "testimony", metadata: { rowStatement: "Confirmed for row 2" } },
  // Merged fixture shape: one candidate chosen from several.
  { label: "selected candidate", origin: "api-record", resolution: "precedence-selection" },
  // Merged fixture shape: a prior period record reused in the current period.
  { label: "prior period record", origin: "system-schema", resolution: "carry-forward", metadata: { priorPeriodRef: "period://2025" } },
  // Merged fixture shape: an anchored snapshot before review.
  { label: "unreviewed snapshot", origin: "web-page", resolution: "observation" },
  // Merged fixture shape: authorized statement with an independent supporting reference.
  { label: "authorized statement", origin: "policy-standard", resolution: "testimony", authorization: { kind: "authorized-action", promptRef: "prompt://1", renderedPrompt: "Confirm the statement", action: "affirmed-control", authorityRef: "authority://1" }, metadata: { supportingReference: "source://support/1" } },
];

function sourceForShape(shape: (typeof conformanceShapes)[number]): RawSource {
  const input = {
    sourceRef: `source://${shape.label.replaceAll(" ", "-")}`,
    observedAt,
    resolution: shape.resolution,
    metadata: shape.metadata,
  };
  switch (shape.origin) {
    case "uploaded-document":
      return uploadedDocumentSource({ ...input, locatorScheme: "pdf" });
    case "web-page":
      return webPageSource(input);
    case "manual-entry":
      return manualEntrySource(input);
    case "policy-standard":
      return policyStandardSource({ ...input, inlineText: "A recorded statement.", standardVersion: "1" });
    case "api-record":
      return apiRecordSource(input);
    default:
      return { ...apiRecordSource(input), kind: shape.origin };
  }
}

function inputForShape(shape: (typeof conformanceShapes)[number]) {
  const rawSource = sourceForShape(shape);
  return new SurveyInputBuilder({ source: "generic-producer", generatedAt: observedAt })
    .addObservation(fieldObservation({
      id: `shape.${shape.label.replaceAll(" ", "-")}`,
      field: "recordedValue",
      value: "present",
      rawSource,
      extraction: { locator: "field:recordedValue", excerpt: "present", extractor: "generic-extractor", extractedAt: observedAt },
      reviewOutcome: shape.authorization ? {
        status: "proposed",
        actor: "operator",
        reviewedAt: observedAt,
        authorizing: shape.authorization,
      } : undefined,
      claim: {
        subjectType: "record",
        subjectId: "record-1",
        facet: "record.current",
        claimType: "recorded-value",
        status: "proposed",
        impactLevel: "low",
        collectedBy: "generic-extractor",
      },
    }))
    .build();
}

function project(origin: RawSourceKind, resolution?: ProvenanceResolution, evidenceType?: "test_output") {
  const common = { sourceRef: `source://${origin}/${resolution ?? "legacy"}`, observedAt, resolution };
  const rawSource = origin === "uploaded-document"
    ? uploadedDocumentSource({ ...common, locatorScheme: "pdf" })
    : origin === "web-page"
      ? webPageSource(common)
      : origin === "manual-entry"
        ? manualEntrySource(common)
        : origin === "policy-standard"
          ? policyStandardSource({ ...common, inlineText: "A recorded statement.", standardVersion: "1" })
          : apiRecordSource(common);
  rawSource.kind = origin;

  const input = new SurveyInputBuilder({ source: "generic-producer", generatedAt: observedAt })
    .addObservation(fieldObservation({
      id: `record.${origin}`,
      field: "recordedValue",
      value: "present",
      rawSource,
      extraction: { locator: "field:recordedValue", excerpt: "present", extractor: "generic-extractor", extractedAt: observedAt },
      claim: {
        subjectType: "record",
        subjectId: "record-1",
        facet: "record.current",
        claimType: "recorded-value",
        status: "proposed",
        impactLevel: "low",
        collectedBy: "generic-extractor",
        evidenceType,
      },
    }))
    .build();
  return buildSurveyTrustBundle(input);
}

describe("orthogonal provenance", () => {
  it("represents merged shapes losslessly as independent triples", () => {
    const records = conformanceShapes.map(inputForShape);
    assert.deepEqual(
      records.map((input) => [
        input.rawSources[0]?.kind,
        input.rawSources[0]?.resolution,
        input.reviewOutcomes[0]?.authorizing?.kind ?? null,
      ]),
      [
        ["uploaded-document", "extraction", null],
        ["manual-entry", "supersession", "explicit-statement"],
        ["manual-entry", "testimony", null],
        ["api-record", "precedence-selection", null],
        ["system-schema", "carry-forward", null],
        ["web-page", "observation", null],
        ["policy-standard", "testimony", "authorized-action"],
      ],
    );
    const rowEvidence = buildSurveyTrustBundle(records[2]!).evidence[0];
    const authorizedEvidence = buildSurveyTrustBundle(records[6]!).evidence[0];
    assert.equal(rowEvidence?.metadata?.rowStatement, "Confirmed for row 2");
    assert.equal(authorizedEvidence?.metadata?.supportingReference, "source://support/1");
    assert.deepEqual(records[1]?.reviewOutcomes[0]?.authorizing, explicitAuthorization);
    assert.deepEqual(records[6]?.reviewOutcomes[0]?.authorizing, conformanceShapes[6]?.authorization);
  });

  it("keeps the public resolution set exact", () => {
    const values: ProvenanceResolution[] = ["extraction", "testimony", "supersession", "precedence-selection", "carry-forward", "observation"];
    assert.equal(new Set(values).size, 6);
    // @ts-expect-error quality-qualified origin labels are not resolution modes
    const invalidQualityLabel: ProvenanceResolution = "high-confidence-document";
    // @ts-expect-error producer override labels are not resolution modes
    const invalidOverrideLabel: ProvenanceResolution = "operator-override";
    assert.ok(invalidQualityLabel && invalidOverrideLabel);
  });

  it("preserves resolution and source anchors through every public source factory", () => {
    const metadata = { producerField: "kept" };
    const sources = [
      uploadedDocumentSource({ sourceRef: "document://1", observedAt, fetchedAt: observedAt, checksum: "abc", locatorScheme: "pdf", resolution: "extraction", metadata }),
      apiRecordSource({ sourceRef: "record://1", observedAt, fetchedAt: observedAt, checksum: { algorithm: "sha512", value: "def" }, resolution: "precedence-selection", metadata }),
      webPageSource({ sourceRef: "https://example.test/1", observedAt, fetchedAt: observedAt, checksum: "sha256:ghi", resolution: "observation", metadata }),
      manualEntrySource({ sourceRef: "operator://1", observedAt, fetchedAt: observedAt, checksum: "jkl", resolution: "testimony", metadata }),
      policyStandardSource({ sourceRef: "standard://1", observedAt, fetchedAt: observedAt, checksum: "mno", resolution: "carry-forward", inlineText: "A statement.", standardVersion: "1", metadata }),
    ];
    assert.deepEqual(sources.map((source) => source.resolution), ["extraction", "precedence-selection", "observation", "testimony", "carry-forward"]);
    assert.deepEqual(sources.map((source) => source.sourceRef), ["document://1", "record://1", "https://example.test/1", "operator://1", "standard://1"]);
    assert.ok(sources.every((source) => source.fetchedAt === observedAt && source.metadata?.producerField === "kept"));
    assert.deepEqual(sources.map((source) => source.locatorScheme), ["pdf", "structured-field", "html", "structured-field", "text"]);
    assert.deepEqual(sources.map((source) => source.checksum), ["sha256:abc", "sha512:def", "sha256:ghi", "sha256:jkl", "sha256:mno"]);
  });

  it("maps axis-bearing inputs without inferring executable output", () => {
    const cases: Array<[RawSourceKind, ProvenanceResolution, string]> = [
      ["uploaded-document", "extraction", "document_citation"], ["web-page", "extraction", "crawl_observation"],
      ["policy-standard", "extraction", "policy_rule"], ["api-record", "extraction", "source_excerpt"],
      ["web-page", "observation", "crawl_observation"], ["manual-entry", "observation", "source_excerpt"],
      ["manual-entry", "testimony", "attestation"], ["policy-standard", "supersession", "attestation"],
      ["uploaded-document", "precedence-selection", "document_citation"], ["api-record", "carry-forward", "source_excerpt"],
      ["manual-entry", "precedence-selection", "attestation"],
    ];
    for (const [origin, resolution, expected] of cases) {
      const bundle = project(origin, resolution);
      assert.equal(bundle.evidence[0]?.evidenceType, expected, `${origin}/${resolution}`);
      assert.equal(bundle.evidence[0]?.metadata?.provenanceResolution, resolution);
      assert.notEqual(bundle.evidence[0]?.evidenceType, "test_output");
    }
    assert.equal(project("system-schema", "precedence-selection", "test_output").evidence[0]?.evidenceType, "test_output");
  });

  it("pins byte-identical legacy mapping and stable projected ids", () => {
    const expected = { "policy-standard": "policy_rule", "uploaded-document": "document_citation", "web-page": "crawl_observation", "api-record": "attestation", "manual-entry": "attestation", "inquiry-question": "attestation", "agent-utterance": "attestation", "system-schema": "attestation" } as const;
    for (const [origin, evidenceType] of Object.entries(expected) as Array<[RawSourceKind, string]>) {
      const legacy = project(origin);
      const axis = project(origin, "extraction");
      const locatorScheme = origin === "uploaded-document" ? "pdf"
        : origin === "web-page" ? "html"
          : origin === "policy-standard" ? "text"
            : "structured-field";
      const policyStandard = origin === "policy-standard"
        ? { policyStandard: { inlineText: "A recorded statement.", standardVersion: "1" } }
        : {};
      assert.equal(
        JSON.stringify(legacy.evidence[0]),
        JSON.stringify({
          id: `record.${origin}.evidence.source`,
          claimId: `record.${origin}`,
          evidenceType,
          method: "extraction",
          sourceRef: `source://${origin}/legacy`,
          sourceLocator: "field:recordedValue",
          excerptOrSummary: origin === "policy-standard" ? "A recorded statement." : "present",
          observedAt,
          collectedBy: "generic-extractor",
          metadata: {
            ...policyStandard,
            rawSourceKind: origin,
            locatorScheme,
          },
        }),
        origin,
      );
      assert.equal(Object.hasOwn(legacy.evidence[0]?.metadata ?? {}, "provenanceResolution"), false);
      assert.deepEqual(axis.claims.map(({ id }) => id), legacy.claims.map(({ id }) => id));
      assert.deepEqual(axis.evidence.map(({ id }) => id), legacy.evidence.map(({ id }) => id));
      assert.deepEqual(axis.events.map(({ id }) => id), legacy.events.map(({ id }) => id));
    }
  });
});
