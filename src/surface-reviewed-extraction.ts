import type {
  SurveyExtractionEnvelopeImport,
  SurveyExtractionReviewDecision,
  SurveyExtractionReviewItem,
} from "@kontourai/surface";
import type { ExtractionEnvelopeImport, PortableExtractionProposal, PortableExtractionResultEnvelope } from "./extraction-envelope.js";
import type { ReviewDecision, ReviewItem } from "./review-resource.js";

/**
 * Typed bridge to surface's reviewed-extraction-evidence contract.
 *
 * Surface cannot import these shapes from this package — the dependency runs
 * the other way — so its contract redeclares them structurally, and the first
 * consumer had to bridge with unchecked casts (surface#194). Direct assignment
 * is rejected only because surface's declarations carry index signatures
 * (open records) that closed interfaces never satisfy; the known fields match.
 *
 * The casts below are therefore guarded by `FieldsAssignable` assertions:
 * `DeepKnown` strips index signatures from surface's type at every depth,
 * leaving exactly its declared fields, and the assertion fails THIS package's
 * compile if this package's shapes stop satisfying them. Drift breaks the
 * owner's build, not a consumer's runtime.
 */
type DeepKnown<T> = T extends readonly (infer U)[]
  ? DeepKnown<U>[]
  : T extends object
    ? { [K in keyof T as string extends K ? never : K]: DeepKnown<T[K]> }
    : T;

type FieldsAssignable<A, B> = [A] extends [DeepKnown<B>] ? true : false;
type Assert<T extends true> = T;

/**
 * Surface's reviewed-extraction profile still requires a proposer confidence on
 * every proposal, while the envelope now allows it to be absent. The bridge
 * therefore only covers records whose proposals all carry one, and
 * {@link toSurfaceReviewedExtractionImport} refuses the rest by name instead of
 * casting them into a type they do not satisfy.
 */
type WithReportedConfidence = Omit<ExtractionEnvelopeImport, "spec"> & {
  spec: Omit<ExtractionEnvelopeImport["spec"], "envelope"> & {
    envelope: Omit<PortableExtractionResultEnvelope, "result"> & {
      result: Omit<PortableExtractionResultEnvelope["result"], "proposals"> & {
        proposals: Array<PortableExtractionProposal & { confidence: number }>;
      };
    };
  };
};

type _ImportBridgeHolds = Assert<FieldsAssignable<WithReportedConfidence, SurveyExtractionEnvelopeImport>>;
type _ItemBridgeHolds = Assert<FieldsAssignable<ReviewItem, SurveyExtractionReviewItem>>;
type _DecisionBridgeHolds = Assert<FieldsAssignable<ReviewDecision, SurveyExtractionReviewDecision>>;

export function toSurfaceReviewedExtractionImport(record: ExtractionEnvelopeImport): SurveyExtractionEnvelopeImport {
  const unreported = record.spec.envelope.result.proposals.findIndex((proposal) => proposal.confidence === undefined);
  if (unreported !== -1) {
    throw new Error(`Surface's reviewed-extraction profile requires a proposer confidence on every proposal; proposal ${unreported} of ${record.metadata.name} reports none.`);
  }
  return record as unknown as SurveyExtractionEnvelopeImport;
}

export function toSurfaceReviewedExtractionItem(item: ReviewItem): SurveyExtractionReviewItem {
  return item as unknown as SurveyExtractionReviewItem;
}

export function toSurfaceReviewedExtractionDecision(decision: ReviewDecision): SurveyExtractionReviewDecision {
  return decision as unknown as SurveyExtractionReviewDecision;
}
