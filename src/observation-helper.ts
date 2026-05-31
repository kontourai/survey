import type { SurveyObservationInput } from "./builder.js";

export interface BuildObservationInput<TValue> {
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

function mergeObservationMetadata(
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

function mergeNestedRecords(
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
