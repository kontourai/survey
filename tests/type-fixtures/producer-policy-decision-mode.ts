// Compile-time regression fixture for the `ProducerPolicy.decisionMode`
// literal-union narrowing documented in docs/review-resource-contract.md's
// "TypeScript migration note: decisionMode is now a literal union" section.
//
// This file lives under `tests/**/*.ts`, which `tsconfig.json` includes, so
// both `npm run typecheck` and `npm run build` (`tsc`) typecheck it on every
// run. It is a permanent, repo-resident variant of the throwaway
// `verify-scratch/ac3-typecheck.ts` fixture used during iteration-1
// verification -- that one only checked positive compilation; this one also
// pins the negative case with `@ts-expect-error`.
//
// It intentionally does NOT end in `.test.ts`: it makes no runtime
// assertions and is not picked up by `node --test dist/tests/*.test.js`. Its
// only job is to make `tsc` fail if the literal-union narrowing regresses
// (e.g. `decisionMode` widens back to `string`) or if the documented one-line
// fix stops compiling.

import type { ProducerPolicy, ReviewDecisionMode } from "../../src/index.js";

// 1. The three literal values a producer may assign directly keep compiling
//    (the shape both known real consumers already produce).
const literalKeepCurrent: ProducerPolicy = { decisionMode: "keep-current" };
const literalCurrentProposed: ProducerPolicy = { decisionMode: "current-proposed" };
const literalFreeSelect: ProducerPolicy = { decisionMode: "free-select" };

// 2. A plain `string`-typed value must NOT be assignable directly to
//    `decisionMode` -- this is the documented source-breaking narrowing.
//    If this ever stops being a type error (e.g. `decisionMode` widens back
//    to `string`), `@ts-expect-error` makes `tsc` fail with "Unused
//    '@ts-expect-error' directive", catching the regression.
declare const dynamicMode: string;
// @ts-expect-error decisionMode is a literal union; a bare `string` is not assignable.
const rejectsPlainString: ProducerPolicy = { decisionMode: dynamicMode };

// 3. The documented one-line migration fix (narrow with an assertion once
//    the caller has verified the value) must keep compiling.
const acceptsNarrowedString: ProducerPolicy = {
  decisionMode: dynamicMode as ReviewDecisionMode,
};

// 4. Unrelated keys remain tolerated via the index signature.
const unrelatedKeysOnly: ProducerPolicy = { someOtherKey: { nested: true } };

console.log(
  "producer-policy-decision-mode typecheck fixture compiled OK",
  !!literalKeepCurrent,
  !!literalCurrentProposed,
  !!literalFreeSelect,
  !!rejectsPlainString,
  !!acceptsNarrowedString,
  !!unrelatedKeysOnly,
);
