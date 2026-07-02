// Compile-time regression fixture for `defineProductVocabulary`'s `const`
// type-parameter modifier documented in `docs/upgrade-guide.md`'s
// "Consuming decisionEffects safely" section.
//
// This file lives under `tests/**/*.ts`, which `tsconfig.json` includes, so
// both `npm run typecheck` and `npm run build` (`tsc`) typecheck it on every
// run. It intentionally does NOT end in `.test.ts`: it makes no runtime
// assertions and is not picked up by `node --test dist/tests/*.test.js`. Its
// only job is to make `tsc` fail if the literal-preserving `const` type
// parameters regress (e.g. `claimTypes`/`decisionEffects` values widen back
// to `string` for a no-`as-const` call site) or if the documented fix stops
// compiling.
//
// Follows the same fixture pattern and header convention as
// `tests/type-fixtures/producer-policy-decision-mode.ts`.

import { defineProductVocabulary } from "../../src/vocabulary.js";
import type { ProducerPolicy, ReviewDecisionMode } from "../../src/index.js";

// 1. No `as const` at the call site (the shape a caller who has never heard
//    of this gotcha will naturally write). Before the `const` type-parameter
//    fix, `vocabulary.decisionEffects.keptCurrentValue` would widen to
//    `string`; with the fix, it keeps its specific string literal type.
const noAsConstVocabulary = defineProductVocabulary({
  subjectType: "public-directory.entity",
  surface: "public-directory.entity-profile",
  claimTypes: {
    scalarField: "public-data.field",
  },
  decisionEffects: {
    keptCurrentValue: "kept-current-value",
    acceptedCandidateValue: "accepted-candidate-value",
  },
});

type NoAsConstKeptCurrentValue = typeof noAsConstVocabulary.decisionEffects.keptCurrentValue;

// 1a. Positive case: the matching literal assignment compiles.
const noAsConstMatchingLiteral: NoAsConstKeptCurrentValue = "kept-current-value";

// 1b. Negative case: a mismatched literal is rejected. If the `const`
//     modifier is ever removed and `NoAsConstKeptCurrentValue` widens back to
//     `string`, this assignment stops being an error and `tsc` fails with
//     "Unused '@ts-expect-error' directive", catching the regression.
// @ts-expect-error keptCurrentValue is the literal "kept-current-value", not a mismatched literal.
const noAsConstMismatchedLiteral: NoAsConstKeptCurrentValue = "accepted-candidate-value";

// 2. The existing `as const` shape (a real prior-migration call-site pattern
//    from the friction journal) must keep compiling identically -- no
//    regression for callers who already wrote `as const`.
const asConstVocabulary = defineProductVocabulary({
  subjectType: "regulated-rule",
  surface: "regulated-rule.library",
  claimTypes: {
    rule: "regulated.rule",
  },
  decisionEffects: {
    keepCurrent: "keep-current",
    currentProposed: "current-proposed",
  },
} as const);

type AsConstKeepCurrent = typeof asConstVocabulary.decisionEffects.keepCurrent;
const asConstMatchingLiteral: AsConstKeepCurrent = "keep-current";
// @ts-expect-error keepCurrent is the literal "keep-current", not a mismatched literal.
const asConstMismatchedLiteral: AsConstKeepCurrent = "current-proposed";

// 3. A `decisionEffects` value flows with zero cast into a Survey-typed
//    literal union (`ProducerPolicy.decisionMode: ReviewDecisionMode`),
//    reproducing and closing the friction journal's "Iteration-2 fix pass"
//    failure mode: previously this required an `as ReviewDecisionMode`
//    assertion unless the vocabulary definition itself used `as const`; now
//    it does not, for either call-site shape.
const policyFromAsConstVocabulary: ProducerPolicy = {
  decisionMode: asConstVocabulary.decisionEffects.keepCurrent,
};

const noAsConstDecisionEffectsVocabulary = defineProductVocabulary({
  subjectType: "public-directory.entity",
  surface: "public-directory.entity-profile",
  claimTypes: {
    scalarField: "public-data.field",
  },
  decisionEffects: {
    currentProposed: "current-proposed",
    freeSelect: "free-select",
  },
});

const policyFromNoAsConstVocabulary: ProducerPolicy = {
  decisionMode: noAsConstDecisionEffectsVocabulary.decisionEffects.currentProposed,
};

// Confirm the zero-cast decisionMode values type-check against the exported
// literal union directly (belt and suspenders on top of the ProducerPolicy
// assignment above).
const decisionModeCheck: ReviewDecisionMode = asConstVocabulary.decisionEffects.keepCurrent;

console.log(
  "vocabulary-literal-preservation typecheck fixture compiled OK",
  !!noAsConstMatchingLiteral,
  !!noAsConstMismatchedLiteral,
  !!asConstMatchingLiteral,
  !!asConstMismatchedLiteral,
  !!policyFromAsConstVocabulary,
  !!policyFromNoAsConstVocabulary,
  !!decisionModeCheck,
);
