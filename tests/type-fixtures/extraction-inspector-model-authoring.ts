// Compile-time regression fixture for the input/output split on the extraction
// inspector's model, documented on `BuiltExtractionInspectorCandidate` in
// `src/review-workbench/extraction-inspector.ts` and in
// docs/extraction-envelope-import.md.
//
// `highlightElementId` is the DOM binding a host links against. It is REQUIRED
// on what `buildExtractionInspectorModel` returns, so a host reading it never
// has to null-check the thing it was told to rely on — but it must stay OPTIONAL
// on `ExtractionInspectorCandidate`, because that type is also the shape a
// caller may author and hand to `mountExtractionInspector` /
// `exportExtractionInspector` / `filterExtractionInspectorCandidates`. Making it
// required outright type-broke consumer-authored models on a minor release.
//
// This file lives under `tests/**/*.ts`, which `tsconfig.json` includes, so both
// `npm run typecheck` and `npm run build` (`tsc`) typecheck it on every run. It
// intentionally does NOT end in `.test.ts`: it makes no runtime assertions. Its
// only job is to make `tsc` fail if either half of that split regresses.
//
// Follows the same fixture pattern and header convention as
// `tests/type-fixtures/producer-policy-decision-mode.ts`.

import type {
  BuiltExtractionInspectorModel,
  ExtractionInspectorCandidate,
  ExtractionInspectorModel,
} from "../../src/index.js";

// --- 1. A hand-authored model still type-checks without a DOM binding. --------
// This is the pre-2.3.0 authoring shape verbatim. If `highlightElementId` ever
// becomes required on `ExtractionInspectorCandidate` again, this stops
// compiling — which is exactly the break it must not reintroduce.
const authoredCandidate: ExtractionInspectorCandidate = {
  id: "authored:proposal:0",
  sourceKey: "authored:source:0",
  reviewItemName: "authored-review-item",
  proposalIndex: 0,
  field: "vendor.name",
  provider: "authored-provider",
  attempt: "authored-run",
  valueType: "string",
  inferenceType: "explicit",
  start: 0,
  end: 5,
  excerpt: "Acme",
  alignment: "aligned",
};

const authoredModel: ExtractionInspectorModel = {
  sources: [{
    key: "authored:source:0",
    importName: "authored-import",
    alignment: "aligned",
    message: "Prepared artifact identity verified.",
    artifactText: "Acme Supply",
  }],
  candidates: [authoredCandidate],
};

// The public functions that ACCEPT a model must keep accepting that.
export type AuthoredModelIsAcceptedInput = typeof authoredModel extends ExtractionInspectorModel ? true : never;
export const authoredModelIsAcceptedInput: AuthoredModelIsAcceptedInput = true;

// --- 2. A built model resolves the binding, with no null-check at the use site.
declare const built: BuiltExtractionInspectorModel;

// `string`, not `string | undefined`: usable directly as an href fragment.
export const href: string = `#${built.candidates[0]!.highlightElementId}`;

// --- 3. A built model is still assignable wherever an input model is expected.
export const builtIsAlsoAnInputModel: ExtractionInspectorModel = built;
