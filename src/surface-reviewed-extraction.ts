import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * Surface 4.1.0 and later accept a proposal without a proposer confidence and
 * leave it absent; earlier Surface versions, which the dependency range still
 * admits, reject it. Which one applies is a property of the Surface installed
 * next to this package, so the check reads its version at runtime.
 *
 * At compile time the full record is asserted against Surface's declared
 * import type whenever those types accept an absent confidence; against older
 * types, only records whose proposals all carry one are asserted.
 */
type SurfaceProposal = SurveyExtractionEnvelopeImport["spec"]["envelope"]["result"]["proposals"][number];
type SurfaceAcceptsAbsentConfidence = undefined extends SurfaceProposal["confidence"] ? true : false;

type WithReportedConfidence = Omit<ExtractionEnvelopeImport, "spec"> & {
  spec: Omit<ExtractionEnvelopeImport["spec"], "envelope"> & {
    envelope: Omit<PortableExtractionResultEnvelope, "result"> & {
      result: Omit<PortableExtractionResultEnvelope["result"], "proposals"> & {
        proposals: Array<PortableExtractionProposal & { confidence: number }>;
      };
    };
  };
};

type _ImportBridgeHolds = Assert<FieldsAssignable<SurfaceAcceptsAbsentConfidence extends true ? ExtractionEnvelopeImport : WithReportedConfidence, SurveyExtractionEnvelopeImport>>;
type _ItemBridgeHolds = Assert<FieldsAssignable<ReviewItem, SurveyExtractionReviewItem>>;
type _DecisionBridgeHolds = Assert<FieldsAssignable<ReviewDecision, SurveyExtractionReviewDecision>>;

/** The first Surface release whose reviewed-extraction profile accepts a proposal without confidence. */
const ABSENT_CONFIDENCE_SINCE: readonly [number, number] = [4, 1];

let resolvedSurfaceVersion: string | undefined;

const UNKNOWN_SURFACE_VERSION = "Cannot determine the installed @kontourai/surface version; refusing to export proposals without confidence.";

/**
 * The version of the `@kontourai/surface` package whose entry point
 * `resolveEntry` returns. Surface does not export its package.json, so this
 * walks up from the entry to the nearest package.json named
 * `@kontourai/surface`; other package.json files on the way (a nested
 * `{ "type": "module" }`, say) are skipped. Throws a Survey error when the
 * entry cannot be resolved, as in a bundle without `import.meta.resolve`, or
 * no such package.json exists.
 */
export function surfaceVersionFromEntry(resolveEntry: () => string): string {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(resolveEntry()));
  } catch (error) {
    throw new Error(UNKNOWN_SURFACE_VERSION, { cause: error });
  }
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "@kontourai/surface" && typeof pkg.version === "string") return pkg.version;
    } catch { /* no readable package.json here; keep walking up */ }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(UNKNOWN_SURFACE_VERSION);
    dir = parent;
  }
}

/** The version of the `@kontourai/surface` copy this module resolves, cached once found. */
function installedSurfaceVersion(): string {
  return resolvedSurfaceVersion ??= surfaceVersionFromEntry(() => import.meta.resolve("@kontourai/surface"));
}

/** Whether a Surface version accepts proposals without confidence. An unparseable version does not. */
export function surfaceAcceptsAbsentConfidence(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.\d+/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > ABSENT_CONFIDENCE_SINCE[0] || (major === ABSENT_CONFIDENCE_SINCE[0] && minor >= ABSENT_CONFIDENCE_SINCE[1]);
}

/**
 * The record, typed for Surface's reviewed-extraction profile. A proposal
 * without confidence passes through without one; no number is substituted.
 * On a Surface older than 4.1.0, which rejects such a proposal, the record is
 * refused by name instead.
 *
 * The version checked is that of the Surface copy Survey itself resolves. A
 * consumer that projects with a different copy (for example Surface 4.0.0 of
 * its own next to Survey's 4.2.0) gets Surface's own refusal instead of this
 * one; dedupe Surface so that one copy is installed.
 */
export function toSurfaceReviewedExtractionImport(record: ExtractionEnvelopeImport): SurveyExtractionEnvelopeImport {
  const unreported = record.spec.envelope.result.proposals.findIndex((proposal) => proposal.confidence === undefined);
  if (unreported !== -1) {
    const version = installedSurfaceVersion();
    if (!surfaceAcceptsAbsentConfidence(version)) {
      throw new Error(`@kontourai/surface ${version} requires a proposer confidence on every proposal (4.1.0 and later do not); proposal ${unreported} of ${record.metadata.name} reports none.`);
    }
  }
  return record as unknown as SurveyExtractionEnvelopeImport;
}

export function toSurfaceReviewedExtractionItem(item: ReviewItem): SurveyExtractionReviewItem {
  return item as unknown as SurveyExtractionReviewItem;
}

export function toSurfaceReviewedExtractionDecision(decision: ReviewDecision): SurveyExtractionReviewDecision {
  return decision as unknown as SurveyExtractionReviewDecision;
}
