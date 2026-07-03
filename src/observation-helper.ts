import type { SurveyObservationInput } from "./builder.js";

/**
 * Observation authoring core — CONTEXT.md "Observation" / "Field Observation
 * and Repeated Observation" ("helper shapes for authoring Observations, not
 * separate domain concepts").
 *
 * `buildObservation`/`BuildObservationInput` are the shared authoring
 * primitive: they own the `extraction.target`/`value`/`excerpt` and
 * `claim.fieldOrBehavior`/`value`/`metadata` assembly (including the
 * three-way `claim.metadata` / caller `metadata` / representation-supplied
 * `surveyMetadata` merge below). Consumed by relative import from
 * `field-observation.ts`, `repeated-observation.ts` (via the
 * representation-keyed `buildFieldObservation`/`buildRepeatedObservation`
 * wrappers below), and `source-of-authority-observation.ts`, which calls
 * `buildObservation` directly with its own `surveyMetadata`/`defaultExcerpt`.
 * None of this is re-exported from `src/index.ts`.
 *
 * `ObservationAuthoringInput` is the shared base shape (id/field/value/
 * rawSource/extraction/reviewOutcome/claim/candidate/candidateSet/metadata)
 * common to `BuildObservationInput` and the two public skins' input types
 * (`FieldObservationInput`, `RepeatedObservationInput`); the skins extend it
 * with only their own `representation` literal.
 *
 * `buildFieldObservation`/`buildRepeatedObservation` are the representation-
 * keyed layer above `buildObservation`: each owns the default-excerpt
 * formula and the `surveyMetadata` sub-key (`field` vs `repeated`) for its
 * representation. They do not change `buildObservation`'s own signature or
 * body — `source-of-authority-observation.ts` depends on that staying
 * exactly as-is.
 *
 * `mergeObservationMetadata`/`mergeNestedRecords` are exported as a
 * module-internal seam (like `src/producer-discipline.ts`) purely for direct
 * test import (`tests/observation-helper.test.ts`) — consumed by relative
 * import only, NOT re-exported from `src/index.ts`. Their bodies, including
 * the `mergeNestedRecords` nested-record-vs-scalar asymmetry and the `??`
 * null/undefined coalescing, are unchanged characterization, not a defect.
 */

export interface ObservationAuthoringInput<TValue> {
  id: string;
  field: string;
  value: TValue;
  rawSource: SurveyObservationInput["rawSource"];
  extraction: Omit<SurveyObservationInput["extraction"], "target" | "value" | "excerpt"> & {
    target?: string;
    excerpt?: string | null;
  };
  reviewOutcome?: SurveyObservationInput["reviewOutcome"];
  claim: Omit<SurveyObservationInput["claim"], "fieldOrBehavior" | "value"> & {
    fieldOrBehavior?: string;
  };
  candidate?: SurveyObservationInput["candidate"];
  candidateSet?: SurveyObservationInput["candidateSet"];
  metadata?: Record<string, unknown>;
}

export interface BuildObservationInput<TValue> extends ObservationAuthoringInput<TValue> {
  surveyMetadata: Record<string, unknown>;
  defaultExcerpt: string;
}

export function buildObservation<TValue>(
  input: BuildObservationInput<TValue>,
): SurveyObservationInput {
  return {
    id: input.id,
    rawSource: input.rawSource,
    extraction: {
      ...input.extraction,
      target: input.extraction.target ?? input.field,
      value: input.value,
      excerpt: input.extraction.excerpt ?? input.defaultExcerpt,
    },
    candidate: input.candidate,
    candidateSet: input.candidateSet,
    reviewOutcome: input.reviewOutcome,
    claim: {
      ...input.claim,
      fieldOrBehavior: input.claim.fieldOrBehavior ?? input.field,
      value: input.value,
      metadata: mergeObservationMetadata(input.claim.metadata, input.metadata, input.surveyMetadata),
    },
  };
}

/**
 * Representation-keyed layer above `buildObservation`. Owns the
 * `surveyMetadata` sub-key name, the default-`representation` literal, and
 * the default-excerpt formula for the "field" (scalar) and "repeated"
 * (aggregate-array) representations — the knowledge previously duplicated
 * inline in `field-observation.ts`/`repeated-observation.ts`. Called only by
 * the two thin public skins; `buildObservation` itself stays representation-
 * agnostic.
 */

function valueSummary(value: unknown): string {
  if (value === null || value === undefined) return "<empty>";
  return String(value);
}

export function buildFieldObservation<TValue>(
  input: ObservationAuthoringInput<TValue> & { representation?: "scalar" },
): SurveyObservationInput {
  const representation = input.representation ?? "scalar";

  return buildObservation({
    ...input,
    surveyMetadata: {
      field: { representation },
    },
    defaultExcerpt: `${input.field}: ${valueSummary(input.value)}`,
  });
}

export function buildRepeatedObservation<TItem>(
  input: ObservationAuthoringInput<readonly TItem[]> & { representation?: "aggregate-array" },
): SurveyObservationInput {
  const representation = input.representation ?? "aggregate-array";
  const value = [...input.value];

  return buildObservation({
    ...input,
    value,
    surveyMetadata: {
      repeated: {
        representation,
        itemCount: value.length,
      },
    },
    defaultExcerpt: `${input.field}: ${value.length} item(s)`,
  });
}

export function mergeObservationMetadata(
  claimMetadata: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  surveyMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const claimSurvey = claimMetadata?.survey && isRecord(claimMetadata.survey) ? claimMetadata.survey : {};
  const survey = metadata?.survey && isRecord(metadata.survey) ? metadata.survey : {};

  return {
    ...claimMetadata,
    ...metadata,
    survey: {
      ...claimSurvey,
      ...survey,
      ...mergeNestedRecords(claimSurvey, survey, surveyMetadata),
    },
  };
}

export function mergeNestedRecords(
  claimSurvey: Record<string, unknown>,
  survey: Record<string, unknown>,
  surveyMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.keys(claimSurvey),
    ...Object.keys(survey),
    ...Object.keys(surveyMetadata),
  ]);

  for (const key of keys) {
    const claimValue = claimSurvey[key];
    const metadataValue = survey[key];
    const helperValue = surveyMetadata[key];

    if (isRecord(claimValue) && isRecord(metadataValue) && isRecord(helperValue)) {
      merged[key] = { ...claimValue, ...metadataValue, ...helperValue };
    } else if (isRecord(claimValue) && isRecord(helperValue) && metadataValue === undefined) {
      merged[key] = { ...claimValue, ...helperValue };
    } else if (isRecord(metadataValue) && isRecord(helperValue)) {
      merged[key] = { ...metadataValue, ...helperValue };
    } else {
      merged[key] = helperValue ?? metadataValue ?? claimValue;
    }
  }

  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
