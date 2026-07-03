import type { SurveyObservationInput } from "./builder.js";
import { buildRepeatedObservation, type ObservationAuthoringInput } from "./observation-helper.js";

export interface RepeatedObservationInput<TItem> extends ObservationAuthoringInput<readonly TItem[]> {
  representation?: "aggregate-array";
}

export function repeatedObservation<TItem>(
  input: RepeatedObservationInput<TItem>,
): SurveyObservationInput {
  return buildRepeatedObservation(input);
}
