import type { SurveyObservationInput } from "./builder.js";
import { buildObservation } from "./observation-helper.js";

export interface FieldObservationInput<TValue> {
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
  representation?: "scalar";
  metadata?: Record<string, unknown>;
}

export function fieldObservation<TValue>(
  input: FieldObservationInput<TValue>,
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

function valueSummary(value: unknown): string {
  if (value === null || value === undefined) return "<empty>";
  return String(value);
}
