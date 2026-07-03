import type { SurveyObservationInput } from "./builder.js";
import { buildFieldObservation, type ObservationAuthoringInput } from "./observation-helper.js";

export interface FieldObservationInput<TValue> extends ObservationAuthoringInput<TValue> {
  representation?: "scalar";
}

export function fieldObservation<TValue>(
  input: FieldObservationInput<TValue>,
): SurveyObservationInput {
  return buildFieldObservation(input);
}
