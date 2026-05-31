import type { SurveyObservationInput } from "./builder.js";

export interface RepeatedObservationInput<TItem> {
  id: string;
  field: string;
  value: readonly TItem[];
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
  representation?: "aggregate-array";
  metadata?: Record<string, unknown>;
}

export function repeatedObservation<TItem>(
  input: RepeatedObservationInput<TItem>,
): SurveyObservationInput {
  const representation = input.representation ?? "aggregate-array";
  const value = [...input.value];

  return {
    id: input.id,
    rawSource: input.rawSource,
    extraction: {
      ...input.extraction,
      target: input.extraction.target ?? input.field,
      value,
      excerpt: input.extraction.excerpt ?? `${input.field}: ${value.length} item(s)`,
    },
    candidate: input.candidate,
    candidateSet: input.candidateSet,
    reviewOutcome: input.reviewOutcome,
    claim: {
      ...input.claim,
      fieldOrBehavior: input.claim.fieldOrBehavior ?? input.field,
      value,
      metadata: repeatedMetadata(input.claim.metadata, input.metadata, representation, value.length),
    },
  };
}

function repeatedMetadata(
  claimMetadata: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  representation: "aggregate-array",
  itemCount: number,
): Record<string, unknown> {
  const claimSurvey = claimMetadata?.survey && isRecord(claimMetadata.survey) ? claimMetadata.survey : {};
  const survey = metadata?.survey && isRecord(metadata.survey) ? metadata.survey : {};

  return {
    ...claimMetadata,
    ...metadata,
    survey: {
      ...claimSurvey,
      ...survey,
      repeated: {
        representation,
        itemCount,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
