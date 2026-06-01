# Survey Context API Alignment Plan

## Goal

Align `@kontourai/survey` public API, docs, fixtures, and tests with the boundary language in `CONTEXT.md`: Survey only owns producer-side source -> extraction -> candidate -> review chain terms, while Surface owns Claim, Subject, Claim Type, Evidence, Status, Claim Dependency, and TrustInput.

The misleading Survey concept `DerivedClaimTarget` / `derivedClaims` / `addDerivedClaim` should be removed or renamed so computed values are represented as normal Surface Claims with Claim Dependencies. Add explicit coverage that a Survey Candidate Conflict projects to a Surface `disputed` claim.

## Current Findings

- `CONTEXT.md` is present and explicitly says not to use "Derived Claim" as a separate Survey concept; use Claim plus Claim Dependency.
- Old derived-claim language appears in:
  - `src/types.ts`: `DerivedClaimTarget`, `SurveyInput.derivedClaims`
  - `src/builder.ts`: `derivedClaims` map and `addDerivedClaim`
  - `src/to-surface.ts`: `addDerivedClaim` helper and conversion loop
  - `src/index.ts`: public export of `DerivedClaimTarget`
  - `fixtures/corrected-document-candidates.ts`: `derivedClaims` fixture data
  - `tests/contracts.test.ts`: test name "preserves derived recompute pressure"
- Surface `@kontourai/surface` already supports claim dependencies through `Claim.derivationEdges?: DerivationEdge[]`.
- Survey `ClaimTarget` currently does not expose `derivedFrom` or `derivationEdges`, so producers cannot express Claim Dependencies through the normal `claims` array without using the Survey-branded `derivedClaims` escape hatch.
- Candidate Conflict projection already exists in `src/to-surface.ts`: `CandidateSetStatus` includes `"conflict"`, `statusFor()` maps it to `"disputed"`, and `eventMethodFor()` returns `"candidate-conflict"`. There is no direct test coverage for that projection.
- Repo has no `docs/context-map.md`, `context/contracts`, or `schemas` directory in this checkout. This artifact follows the requested sidecar contract directly.

## Definition Of Done

The Survey package exposes and documents computed claims as normal `ClaimTarget` entries with Surface `derivationEdges` Claim Dependencies, with no public `DerivedClaimTarget`, `derivedClaims`, or `addDerivedClaim` API remaining. README and tests use the CONTEXT.md boundary language, and `npm run verify` passes with coverage proving Candidate Conflict projects to a Surface `disputed` claim.

## Acceptance Criteria

1. Public API cleanup: `src/index.ts` no longer exports `DerivedClaimTarget`, and repository source/docs/tests have no remaining `DerivedClaimTarget`, `derivedClaims`, or `addDerivedClaim` references.
   - Evidence: `rg -n "DerivedClaimTarget|derivedClaims|addDerivedClaim" src fixtures tests README.md CONTEXT.md package.json` returns no matches, except historical artifact files under `.agents` if searched globally.

2. Claim Dependency representation: `ClaimTarget` supports Surface dependency fields needed for computed claims, especially `derivationEdges` with Surface-compatible edge shape.
   - Evidence: TypeScript compiles with fixture computed claims represented inside `SurveyInput.claims`, and generated TrustInput computed claims include expected `derivationEdges`.

3. Projection behavior preserved: corrected-document fixture still projects six claims, preserves superseded/proposed counts, and still produces Surface recompute pressure such as `input-superseded`.
   - Evidence: updated contract test passes and asserts the computed statement-position claims are normal claims with dependency edges.

4. Candidate Conflict coverage: a test constructs a candidate set with status `"conflict"` and no review outcome, projects it through `buildSurveyTrustInput`, validates it with Surface, and asserts the resulting claim status is `disputed` and event method is `candidate-conflict`.
   - Evidence: named test passes in `tests/contracts.test.ts`.

5. Documentation alignment: README uses CONTEXT.md boundary language for Survey, TrustInput, Candidate Conflict, and Claim Dependency. It does not introduce Survey-branded terms for Surface-owned concepts.
   - Evidence: README examples and prose avoid "derived claim" as a Survey concept and explain computed values as Claims with Claim Dependencies.

6. Verification: package checks pass.
   - Evidence: `npm run verify` exits 0.

## Parallel Waves

### Wave 1: API and Projection Refactor

Owner: implementation worker A

Files:
- `src/types.ts`
- `src/to-surface.ts`
- `src/builder.ts`
- `src/index.ts`

Tasks:
1. Import Surface dependency types in `src/types.ts`, likely `DerivationEdge`, and add optional `derivedFrom?: string[]` and `derivationEdges?: DerivationEdge[]` to `ClaimTarget` if both are supported by Surface. `derivationEdges` is the main Claim Dependency shape.
2. Delete `DerivedClaimTarget`.
3. Delete `SurveyInput.derivedClaims`.
4. In `src/to-surface.ts`, remove the `input.derivedClaims` loop and `addDerivedClaim` helper.
5. While projecting every normal `ClaimTarget`, pass through `derivedFrom` and `derivationEdges` onto the Surface `Claim`.
6. In `src/builder.ts`, remove the derived-claim map and `addDerivedClaim` method, and remove `derivedClaims` from `build()`.
7. In `src/index.ts`, stop exporting `DerivedClaimTarget`.

Acceptance:
- `npm run typecheck` passes after fixtures/tests are updated by Wave 2.
- No production source reference remains to `DerivedClaimTarget`, `derivedClaims`, or `addDerivedClaim`.
- Existing claim projection behavior for evidence/events remains unchanged for ordinary candidate-backed claims.

Notes:
- Do not rename `ClaimTarget` to a Survey-branded synonym; CONTEXT.md says Claim is Surface-owned and should be reused.
- Keep `CandidateSetStatus = "resolved" | "needs-review" | "conflict"` because Candidate Conflict is a Survey-side pre-projection term.

### Wave 2: Fixtures and Tests

Owner: implementation worker B

Files:
- `fixtures/corrected-document-candidates.ts`
- `tests/contracts.test.ts`

Tasks:
1. Move the two computed statement-position records from `derivedClaims` into the normal `claims` array.
2. Give those computed `ClaimTarget` objects enough candidate linkage to satisfy the existing projection path, or coordinate with Wave 1 if the cleanest design needs a small optional path for claim records without candidate evidence. Prefer keeping one projection path and avoiding a new Survey-specific computed-claim concept.
3. Add `derivationEdges` to those computed claim records using the existing input claim IDs and support strengths.
4. Rename the corrected-document test from "derived recompute pressure" to "Claim Dependency recompute pressure" or equivalent CONTEXT.md language.
5. Strengthen the corrected-document assertions to check the computed claim exists in the normal claims list and has `derivationEdges`.
6. Add a focused Candidate Conflict test:
   - Build two candidate observations for one target, or construct a minimal `SurveyInput`.
   - Set `candidateSet.status` to `"conflict"`.
   - Omit review outcome.
   - Project and validate with Surface.
   - Assert claim status `disputed`.
   - Assert event method `candidate-conflict`.

Acceptance:
- Contract tests cover both Claim Dependency projection and Candidate Conflict -> disputed projection.
- Fixture still validates with `@kontourai/surface`.

Risk / Design Choice:
- Current `ClaimTarget` requires `candidateSetId` and `candidateId` because every claim is evidence-backed by a candidate extraction. For computed claims with only calculation evidence, there are two viable designs:
  - Preferred conservative design: keep computed claims in `claims` and add normal producer-side source/extraction/candidate records representing the computation trace, with evidence type/method overridden to `calculation_trace` / `validation`.
  - Alternative design: make candidate linkage optional for `ClaimTarget` and branch projection for claim-only records. This risks reintroducing a separate concept and should be avoided unless the preferred design is too awkward.

### Wave 3: README and Public Language

Owner: implementation worker C

Files:
- `README.md`

Tasks:
1. Update opening prose from "raw observations" / "trust records" to CONTEXT.md language: producer observations into Surface-ready `TrustInput`.
2. Add or adjust a short section explaining computed values: producers express them as normal Claims with Claim Dependencies through `derivationEdges`; Surface owns dependency semantics and recompute pressure.
3. Add a short Candidate Conflict note under Candidate review records: candidate-set `"conflict"` is Survey-side and projects to Surface `disputed` when no review outcome resolves it.
4. Ensure README does not present "derived claim" as a Survey concept.

Acceptance:
- README passes the grep in Acceptance Criterion 1.
- README examples remain syntactically consistent with exported API.

### Wave 4: Verification and Cleanup

Owner: verification worker

Tasks:
1. Run `rg -n "DerivedClaimTarget|derivedClaims|addDerivedClaim" src fixtures tests README.md CONTEXT.md package.json`.
2. Run `npm run verify`.
3. If failures appear, categorize them:
   - Type/API mismatch from changed `ClaimTarget`
   - Projection behavior regression
   - Surface validation rejection
   - Language cleanup miss
4. Record exact command outputs in the final evidence artifact.

Acceptance:
- Grep has no matches in production/docs/tests scope.
- `npm run verify` exits 0.

## Stop-Short Risks

- Surface package currently names dependency edges `derivationEdges`. README can call them Claim Dependencies, but code should use the Surface field name for compatibility.
- Making candidate linkage optional may accidentally create a second claim path. Prefer representing computation traces through normal Survey records unless implementation proves that too cumbersome.
- `dist/` is checked in or present locally. The package build regenerates it. Workers should avoid hand-editing `dist`.
- `CONTEXT.md` is currently untracked. Do not remove or overwrite it.

## Suggested Execution Order

1. Wave 1 and Wave 2 should coordinate tightly because type changes and fixture changes must compile together.
2. Wave 3 can run in parallel once the replacement API name/shape is confirmed.
3. Wave 4 runs after all edits.

