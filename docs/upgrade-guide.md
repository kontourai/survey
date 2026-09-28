# Upgrade Guide

This guide is for a consumer already integrated with `@kontourai/survey`
(see [consumer-integration-guide.md](consumer-integration-guide.md) for a
first-time integration) who is starting a version upgrade — anywhere from
0.5.x up through the current 2.x line, including the 1.x → 2.0.0 major hop.
The general sections cover three things a real migration had to
discover by direct experience because no upgrade guide existed on Survey's
side: how to safely bump the dependency, how to decide what to adopt versus
keep from newly shipped helpers, and a `decisionEffects`-consumption gotcha
that this release closes. Version-specific sections follow, oldest first.

## Upgrading a version

Bump `@kontourai/survey` (and its `@kontourai/surface` dependency) directly
to the newest published patch, not an intermediate minor — patch releases on
both packages land frequently and an intermediate minor can carry a
transitive dependency range that a newer patch has already fixed.

**Re-check `npm view` at execution time, not just at planning time.** A real
migration's plan called out a stale transitive dependency range as a
"verified upstream gap" — true when the plan was written, but resolved by a
same-day patch release before execution started. A plan-time finding about a
package's dependency range can go stale within hours if that package is
actively receiving patches. Before starting the actual upgrade work, re-run:

```sh
npm view @kontourai/survey@<exact-target-version> dependencies
npm view @kontourai/surface@<exact-target-version> dependencies
```

and compare against what the plan assumed. If the ranges have already
tightened, the gap the plan was built around may no longer exist — do not
carry a stale finding into execution unverified.

Once versions are pinned, confirm the install tree actually deduplicates to
a single copy of `@kontourai/surface` (a peer-range mismatch between
`@kontourai/survey` and other dependencies can otherwise leave two Surface
majors installed side by side):

```sh
npm ls @kontourai/surface
```

A single deduped entry in that output means the dependency graph is clean;
more than one means something in the tree still pins an older `@kontourai/surface`
range and needs its own bump before you rely on a single shared Surface
instance.

## What to adopt: the adoption scorecard

Not every helper Survey ships is a drop-in replacement for logic a consumer
already has. Track, per shipped helper, whether you adopted it and why (or
why not) — a lightweight table works well as a durable record of the
decision, not just the outcome:

| Helper | Adopted? | Why / why not |
| --- | --- | --- |
| `currentProposedReviewItem` | Yes | Matches our current/proposed review shape exactly; no domain-specific deviation to preserve. |
| `applyReviewSession` | Yes | Server-owned apply boundary from pre-decision snapshot + events is exactly our existing pattern, just typed. |
| `buildAuthorizedActionAuthorizing` / `buildPromptRef` | Yes | Thin id/ref builders; no behavior to diverge from. |
| `stableId` | Yes | Matches our existing slugification exactly (see `docs/consumer-integration-guide.md`'s reference algorithm parity test). |
| `defineProductVocabulary` | Yes | Discoverable, frozen vocabulary beats scattered top-level constants; no runtime behavior change to reconcile. |
| `confidenceBasisForReview` | **No — kept our own mapping** | See worked example below. |
| `deriveCalibration` / `buildSurveyTrustBundle({ calibration })` (1.10.0) | Optional, experimental | Opt-in. Turns your review outcomes into a descriptive calibration curve and, only with `experimentalConclusionValue: true`, attaches a group affirmation rate as `conclusionConfidence.value` on affirmed claims. `suggestedThreshold` is not an evaluated auto-accept gate (see [Calibration guards](#calibration-guards-279)). See [record-contracts.md](record-contracts.md#confidence-calibration). |
| `buildSurveyTrustBundle({ projectionContextId })` | Required for repeated append-only projections | Supply one stable producer-owned context id per review session, proposal, or resolution when the same claim can be projected more than once. It scopes generated evidence/event ids without changing claim identity; omission preserves legacy ids. See [record-contracts.md](record-contracts.md#repeated-projection-identity). |

### Worked example: when *not* to adopt `confidenceBasisForReview`

`confidenceBasisForReview` is deliberately conservative by default: it does
not attempt to reproduce any one consumer's confidence-scoring algorithm.
Its own doc comment says so directly (`src/vocabulary.ts`):

> "The two known real-world consumers hand-roll *different* five-field
> mappings, not one shared algorithm ... There is no single formula that
> reproduces both, so this helper does not attempt to guess one."

A consumer with real domain-specific confidence heuristics — for example,
deriving `sourceQuality` from an extracted `regulated-document`'s source
type rather than from Survey's conservative `"unknown"` floor — should keep
its own algorithm rather than force-adopt this helper and lose that
domain knowledge. The documented pattern (already established in
[consumer-integration-guide.md](consumer-integration-guide.md#vocabulary-and-id-primitives))
is to leave a one-line "why" comment at the call site your own logic
replaces, so a future reader does not "helpfully" swap it back in:

```ts
// NOT using confidenceBasisForReview here: our sourceQuality derivation is
// keyed off regulated-document.sourceType, which confidenceBasisForReview's
// conservative default does not model. See docs/upgrade-guide.md.
const basis = ourOwnConfidenceBasisFor(sourceType, status, extracted);
```

This is not a rejection of the helper — it is the documented, intentional
"keep our own" outcome the helper's own docstring anticipates, and it is
just as legitimate a scorecard row as an "adopted" one.

## Consuming `decisionEffects` safely

> **TypeScript 5.0+ required from this release.** `defineProductVocabulary`'s
> published type declarations use the `const` type-parameter modifier (a
> TypeScript 5.0, March 2023+, language feature — see the before/after
> example below) to preserve `claimTypes`/`decisionEffects` literal types
> without requiring `as const` at the call site. This changes the *minimum*
> TypeScript version that can parse `@kontourai/survey`'s type declarations
> at all: a project still on TypeScript &lt;5.0 will fail to compile against
> this release's `.d.ts` files with a parse error, not a graceful
> type-checking warning, because older `tsc` cannot parse the `const`
> modifier syntax, and that parse failure blocks every export re-exported
> from the package root, not just `defineProductVocabulary`. If your
> project's toolchain is pinned to TypeScript &lt;5.0, **stay on
> `@kontourai/survey@1.2.x`** until you can upgrade your TypeScript
> compiler — there is no workaround on the consuming side other than
> upgrading TypeScript itself. `@kontourai/survey` declares this floor via
> `package.json`'s `peerDependencies.typescript: ">=5.0.0"` (marked optional
> so plain-JavaScript installs see no friction — **JavaScript consumers, and
> any consumer that does not typecheck against this package's `.d.ts`
> files, are unaffected** by this floor).

As of this release, `defineProductVocabulary`'s `claimTypes` and
`decisionEffects` values keep their specific string-literal types **without**
requiring `as const` at the call site:

```ts
// Before this release: claimTypes/decisionEffects widened to `string` unless
// the caller added `as const` — an undocumented requirement discovered mid-migration.
const vocabulary = defineProductVocabulary({
  subjectType: "public-directory.entity",
  facet: "public-directory.entity-profile",
  claimTypes: { scalarField: "public-data.field" },
  decisionEffects: { currentProposed: "current-proposed" },
});
// typeof vocabulary.decisionEffects.currentProposed used to be `string`.
```

```ts
// As of this release: the same call, with no `as const`, now preserves
// `"current-proposed"` as a literal type.
const vocabulary = defineProductVocabulary({
  subjectType: "public-directory.entity",
  facet: "public-directory.entity-profile",
  claimTypes: { scalarField: "public-data.field" },
  decisionEffects: { currentProposed: "current-proposed" },
});
// typeof vocabulary.decisionEffects.currentProposed is now the literal "current-proposed".
```

A caller that already wrote `as const` on an older pattern is unaffected —
that shape compiles identically before and after this release.

This closes a concrete failure mode: assigning a `decisionEffects` value into
one of Survey's own typed literal-union fields, such as
`ProducerPolicy.decisionMode` (`ReviewDecisionMode`), previously required a
cast unless the vocabulary definition itself used `as const`:

```ts
// Previously required a cast unless `defineProductVocabulary`'s argument used `as const`:
const policy: ProducerPolicy = {
  decisionMode: vocabulary.decisionEffects.currentProposed as ReviewDecisionMode,
};

// As of this release, the cast is no longer needed — the literal type flows
// through end to end:
const policy: ProducerPolicy = {
  decisionMode: vocabulary.decisionEffects.currentProposed,
};
```

This is specific to `defineProductVocabulary`'s own type parameters. For the
general background on `decisionMode`'s literal-union narrowing itself (why a
plain `string`-typed value is not assignable to `decisionMode` at all), see
the existing TypeScript migration notes in
[consumer-integration-guide.md](consumer-integration-guide.md#regulated-rule-example)
and
[review-resource-contract.md](review-resource-contract.md#typescript-migration-note-decisionmode-is-now-a-literal-union) —
this section documents the vocabulary-object-specific root cause those notes
do not cover.

## Facet rename (Hachure schema 5)

`@kontourai/surface@2.0.0` renames the Claim field `surface` to `facet`
(optional) and bumps `CURRENT_SCHEMA_VERSION` to `5`. This release of
`@kontourai/survey` follows that rename across every place it emits or
declares a claim-target facet:

- `ClaimTarget.facet`, `ClaimTargetHint.facet`, and
  `OversightMetricsClaimsSubject.facet` (previously `.surface`) — renamed,
  no compatibility alias. Update object literals and property accesses from
  `surface` to `facet`.
- `buildSurveyTrustBundle` now writes `Claim.facet` (not `Claim.surface`) and
  stamps `schemaVersion: 5` on every bundle it builds.
- `defineProductVocabulary`'s `surface` option is renamed to `facet`, but —
  unlike the fields above — this one keeps a **deprecated `surface` alias**
  for one release: the function accepts either `facet` or `surface` (`facet`
  wins if both are given), and the returned vocabulary carries both `.facet`
  (canonical) and a deprecated `.surface` mirror. Passing `surface` alone
  emits one `console.warn` per process, not one per call:

  ```ts
  // Still compiles for one release, but warns once per process:
  const vocabulary = defineProductVocabulary({
    subjectType: "public-directory.entity",
    surface: "public-directory.entity-profile", // deprecated — use facet
    claimTypes: { scalarField: "public-data.field" },
    decisionEffects: { currentProposed: "current-proposed" },
  });
  vocabulary.facet;   // "public-directory.entity-profile"
  vocabulary.surface; // "public-directory.entity-profile" (deprecated mirror)
  ```

  Migrate call sites to the canonical option; the alias is not guaranteed
  to survive the next release:

  ```ts
  const vocabulary = defineProductVocabulary({
    subjectType: "public-directory.entity",
    facet: "public-directory.entity-profile",
    claimTypes: { scalarField: "public-data.field" },
    decisionEffects: { currentProposed: "current-proposed" },
  });
  ```

Surface's own `validateTrustBundle` separately carries a read-tolerance shim
for *legacy bundles on disk* that still have `Claim.surface` (warn-once,
mapped onto `facet` at read time) — that shim is orthogonal to Survey's
`defineProductVocabulary` alias above and lives entirely in
`@kontourai/surface`; see that package's own release notes for its scope and
lifetime.

## 2.0.0 — model-provider adapters removed

`2.0.0` carries exactly one breaking change
([#180](https://github.com/kontourai/survey/pull/180), commit `9f31487`):
the `@kontourai/survey/anthropic` entry point is removed. Every other
change in the release is additive
([CHANGELOG](https://github.com/kontourai/survey/blob/main/CHANGELOG.md)).

**What was removed.** The `./anthropic` subpath export and the module
behind it — `createAnthropicMappingProposer`,
`createAnthropicUtteranceExtractor`, and the `Anthropic*` client, message,
and tool types — plus the optional `@anthropic-ai/sdk` peer dependency.
Model prompting, response parsing, and credential handling are the
producer application's concern now: Survey defines the extractor and
proposer contracts and no longer ships an adapter for any model provider.

**What was kept.** The pluggable interfaces those adapters implemented are
unchanged and still exported from the package root: `MappingProposer`,
`SchemaMappingExtractor`, and `UtteranceClaimExtractor`, along with their
deterministic reference implementations (`referenceMappingProposer`,
`referenceSchemaExtractor`, `referenceUtteranceExtractor`). All review and
projection behavior is untouched by this release. A model-backed adapter
you write in your own application implements the same interface the
removed one did, so downstream review and projection code cannot tell the
difference.

**There is no compatibility layer, by design.** #180 deleted the module,
its tests, and its `exports` map entry outright — no deprecation window,
no re-export shim. `import "@kontourai/survey/anthropic"` fails at module
resolution after the bump, and TypeScript fails the build with it, so
exposure cannot survive silently into runtime.

**Check your exposure with one search:**

```sh
grep -rn "@kontourai/survey/anthropic" src/
```

No hits means the major is a no-op at your call sites — bump and run your
suite. That was the finding for all three real consuming applications when
this was checked (kontourai/survey#211): none imported the adapter entry
point. If you do have hits, move the model call into your own code — the
"What was kept" interfaces above are the seam to implement — and delete the
`@anthropic-ai/sdk` peer install if nothing else in your application uses
it.

**Node floor reminder while you are here.** `engines.node` has required
`>=22` since `1.0.0` (0.x required only `>=20`). This is not new in 2.0.0,
but a CI matrix created before your 1.x adoption may still be running Node
20 — that exact gap surfaced in a real consumer's 0.5.x → 1.x migration —
so check your workflow files in the same pass.

`2.1.0` and `2.2.0` (and the `2.2.x` patches) are additive; the `2.3.0`
and `2.4.0` sections below continue the path from there.

## 2.3.0 — embedded workbench DOM

`2.3.0` is a minor release: it adds two extension points, and no supported API
is removed, renamed, or repointed at a different meaning. Two things still
deserve your attention before you bump.

This section assumes you are arriving from `2.x`. If you are on `1.x`, take
the `1.x` → `2.0.0` hop documented in the 2.0.0 section above first.

**At the type level it is additive, but only just.**
`ExtractionInspectorCandidate` gains an optional `highlightElementId`, and
`buildExtractionInspectorModel` now returns the narrower
`BuiltExtractionInspectorModel`, where that field is required. If you assemble
an `ExtractionInspectorModel` yourself rather than taking one from the builder —
a supported thing to do — your code keeps compiling, because the field is
optional on the shape you author and `mountExtractionInspector` resolves an id
for any candidate that arrives without one. Making it required outright would
have broken that authoring path, which is a major-release change, not a minor
one. If you *read* `highlightElementId`, take the builder's return type and it
is a plain `string`.

**At the DOM level it is genuinely breaking for embedders.** If you reach into
the review workbench's markup, what is underneath you changed, and a host that
was compensating for a Survey defect can end up hiding real data. Migrate before
or with the bump rather than after.

**If you slug row labels to build selectors, stop.** Every AUDIT DETAILS row now
carries `data-audit-row="<key>"`, and `reviewAuditRowKeys` (exported from
`@kontourai/survey/review-workbench`) is the complete set. Keys are stable
across label copy changes; slugs are not.

There was nothing on a row to select, so a host had to stamp its own attribute
from the label text in JavaScript and then style that:

```js
// before — a slug derived from display copy, in the host's MutationObserver
for (const row of host.querySelectorAll(".audit-body .kv")) {
  row.dataset.auditRow = row.querySelector(".field-label")
    ?.textContent?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") ?? "";
}
```

```css
/* before — breaks the day someone edits a label */
[data-audit-row="raw-source-id"] /* ...stamped by the snippet above */
/* after — Survey stamps it, and the key is the contract */
[data-audit-row="raw-source-id"]
```

Delete the stamping; keep the selector.

**If you prune duplicated audit rows, re-check those rules — most are now
redundant.** Survey deduplicates four rows: `raw-source-id`, `extractor`,
`extraction-id` and `excerpt`. A rule suppressing one of those is now hiding the
only copy. One repeat is deliberately kept — the Unselected candidate history's
`candidate-id`, which on a two-candidate item repeats the ID stack — so a rule
against that one is still doing something. Keeping a rule that hides one of them now hides the only
copy. Rules that reflect a *host* decision — you promote the locator onto your
own card face, you keep identifiers out of the UI entirely — are still
legitimate; re-point them at `data-audit-row` keys.

**If you select on structure, re-check those selectors.** These sections are no
longer rendered when they would carry only a constant reporting an absence: the
authority trace when none was supplied, the unselected-candidate history when
there is nothing unselected, and the review event of a `could_not_confirm`
resolution. The `.preview-section.is-neutral` class is gone with the first of
them. Relational selectors such as
`[data-testid="surface-candidate-history"]:not(:has(.reference-details))` still
behave as they did — every reference disclosure keeps at least one reference
that can never be suppressed, so the disclosure does not blink in and out — but
this is the class of coupling worth re-reading rather than assuming.

**If you style or script the source highlight, it changed shape.** The return
control is now the painted `<mark class="source-highlight">` — a real target the
width of the highlighted phrase, carrying `role="button"`, `tabindex="0"` and
`data-highlight-return-to`, a space-separated list of the `highlightElementId`s
it covers (select with `~=`, since two candidates can share one span). The element the published id names
is now an inert, zero-width `<span class="highlight-anchor">` that exists for
every candidate and is not focusable or clickable. If you were stripping the
anchor's user-agent button chrome host-side, delete that rule: it is not a button
any more.

**If your ReviewItems can carry two candidates under one id, the workbench now
throws.** A `ReviewDecision` names its candidate by id and nothing else, so an
ambiguous id makes the decision undecidable — the workbench used to take the
first match and could project one candidate's value under another's decision.
The Surface record builder already rejected this shape; the workbench now does
too, naming the item and the id.

Specifically, it throws wherever a candidate id becomes durable or is resolved
back to a candidate: `buildReviewDecision`, `buildReviewDecisionsFromSession`,
`buildReviewWorkbenchResultsFromSession`, `buildReviewSessionEvents`,
`buildReviewWorkbenchSessionExport`, `renderReviewWorkbenchHtml` and
`buildReviewResultPresentation` — everything downstream of
`candidateForDecision`, which is the shared selector they go through. It does
**not** validate an item on construction or on assignment to the workbench: an
item with duplicate ids can be held and displayed in the queue list, and fails at
the point a decision would be made from it.

**If you reconstruct source-highlight element ids, delete that code.**
`buildExtractionInspectorModel` publishes the id on each candidate, resolvable
for every candidate whatever page or filter the inspector is on, and in the
non-grounded postures where there is no highlighted span to land on. Re-deriving
one from `candidate.id` was never supported and the private sanitizer behind it
can change.

**A required input inside a collapsed region no longer kills its control.** If
you patched around "Could not confirm" doing nothing (kontourai/survey#208),
that patch is now redundant; the workbench states the requirement next to the
button and opens the accordion holding the input.

## 2.4.0 — queue-binding attestation

`2.4.0` is a minor release: everything below is additive, and no existing API
changes shape or behavior unless you pass the new inputs.

**What is new.** `bindReviewQueue`, `validateReviewQueueBinding` /
`assertReviewQueueBinding`, `validateReviewQueueAgainstExtractionImport` /
`assertReviewQueueAgainstExtractionImport`, `hashReviewQueueSnapshot`, and the
`ReviewQueueBinding` record type, exported from the package root and
`@kontourai/survey/review-workbench`. `deriveServerReviewSessionApplyResult`
accepts an optional `binding`. See the consumer integration guide's
"Queue-Binding Attestation" section for the contract.

**What the extraction cross-check attests — and what it does not.**
`validateReviewQueueAgainstExtractionImport` attests queue-to-record
*consistency*: the stored queue is exactly the set of items the presented
import record derives, byte-identical per item, in both directions, with the
record revalidated through the import boundary first. It does **not** attest
record *integrity*: the portable envelope carries the prepared artifact's
digest, not its bytes, so a record whose proposals were edited — with the
queue re-derived from the edited record — passes both the binding and the
cross-check (pinned as a boundary test and by `npm run check:guards`).
Keeping the stored record equal to the record originally imported is the
consumer's storage obligation. Note that validating prepared bytes against
`result.preparedArtifact.digest` protects artifact integrity only — the
digest does not cover the proposals, so it stays green through a record
rewrite. Preserving record integrity requires an independently anchored
record digest/MAC, immutable or authenticated record storage, or
independently re-deriving the proposals from trusted prepared bytes and
comparing; Survey enforces none of these.

**Nothing existing breaks.** `deriveServerReviewSessionApplyResult` without a
`binding` behaves exactly as in 2.3.x — the new assertion runs only inside
`if (options.binding)`. `hashReviewQueueSnapshot` is byte-identical to
`hashReviewSessionSnapshot` (pinned by test), so digests you already persist
remain valid; adopting the binding does not invalidate stored state.

**What passing a `binding` changes.** The derivation throws
`UnattestedReviewQueueError` when the record's snapshot — or `currentSnapshot`,
when you supply one — no longer matches the bound bytes or the bound item set,
in either direction. It does not validate your storage, and it cannot tell a
stored binding from a freshly computed one: a binding recomputed at call time
from the snapshot being checked passes by construction. Bind at queue
construction, persist, and pass the stored record — that half of the contract
is yours.

**Empty queues and duplicate names are refused, not warned about.**
`bindReviewQueue` throws on both; `validateReviewQueueBinding` reports
`empty-queue` and `ambiguous-item-identity` as issues and
`assertReviewQueueBinding` throws on any issue. A malformed binding fails
closed with `binding-malformed` rather than skipping the checks it cannot run.

## Calibration guards (#279)

Calibration output is now experimental and guarded. If you use
`deriveCalibration` or `buildSurveyTrustBundle({ calibration })`:

- **`conclusionConfidence.value` needs an explicit opt-in.** `calibration: true`
  (or an object without the flag) no longer sets a value. Pass
  `calibration: { experimentalConclusionValue: true, ... }` to keep it, knowing
  it is a group base rate, not a per-claim probability. Passing `calibration`
  without the flag logs one `console.warn` per process; pass
  `experimentalConclusionValue: false` (or drop the option) to silence it.
- **`suggestedThreshold` is withheld more often.** The default `minBinSamples`
  rose from 1 to 30, and each contributing decile's one-sided 95% Wilson lower
  bound (`CalibrationBin.accuracyLowerBound`) must meet `targetAccuracy`. An
  explicit `minBinSamples` does not bypass the bound.
- **Labels follow the proposer role.** In a multi-candidate set the prediction
  is the one candidate marked `"proposed"` (`metadata.candidateRole` or
  `metadata.role`); a multi-candidate set without exactly one such marker is
  skipped. Mark your proposed candidate if you hand-build multi-candidate sets.
  A one-candidate set is still sampled whatever its role (`computed`,
  `source-version`, `current`, a free-form role, or none), as before: with one
  candidate there is no reviewer pick to mistake for the proposal.

## Claims must agree with their review (#290)

A `verified` or `assumed` claim now has to restate the review it cites.
`buildSurveyTrustBundle` throws `ReviewAgreementError` (exported, with a
`code`) instead of projecting a contradiction:

- **`status-mismatch`.** An explicit `ClaimTarget.status` of `verified` or
  `assumed` must equal the selected review's `status`. A claim can still be
  projected with a weaker status than its review (for example `proposed`).
  `reviewedCandidateResolution` and `reviewedCurrentProposedResolution` throw
  the same error when `selectedClaimStatus`, or the selected observation's own
  `claim.status`, is `verified`/`assumed` and differs from
  `reviewOutcome.status`.
- **`value-mismatch`.** A trusted claim's value must equal the reviewed value
  by canonical JSON: the candidate value, or an accepted edit. An accepted
  edit is `metadata.editedValue` on a review whose `metadata.workbenchDecision`
  is `accept-proposed`, which is what `buildCanonicalReviewedTrustInput` writes.
  Any other `editedValue` is ignored. A claim that takes an edit carries
  `metadata.survey.valueEdit: { edited: true, originalValue, reviewOutcomeId }`,
  so the bundle shows the value was edited and what it was edited from. Without
  an accepted edit, drop `ClaimTarget.value` (the claim then takes the
  candidate value) or make the candidate carry the value you want to claim.
  With an accepted edit, set `ClaimTarget.value` to the edited value, as
  `buildCanonicalReviewedTrustInput` does; omitting it projects the candidate
  value, which is not what was reviewed, and throws. `ClaimTarget.value` is
  still free for claims that are not trusted.
- **`ambiguous-review-order`.** When several reviews apply to one candidate,
  the latest by `reviewedAt` now governs, whatever their array order (before,
  the first one in the array won). Reviews bound to the exact candidate still
  take precedence over reviews without a `candidateId`. Timestamps compare as
  instants, so `…T00:00:00Z` and `…T09:00:00+09:00` are the same time. Reviews
  at the latest instant that record the same decision count as one review
  (the claim cites the lowest id). The projection throws if reviews at that
  instant record different decisions, or if any of several reviews has a
  missing or unparseable `reviewedAt`.

Schema mapping: candidate and extraction values from `surveySchemaMapping`
now carry the whole mapping (`relation`, `sourceField`, `targetField`,
`conversion`; exported as `SchemaMappingValue`), and neither
`surveySchemaMapping` nor `mappingReviewToSurface` overrides the claim value.
The projected claim value is unchanged for mappings built by
`surveySchemaMapping`. If you hand-build a `ReviewedMapping`, give its
`selectedCandidate.value` the same four keys.

## Envelope imports: one item per claim, partial coverage, optional confidence

`importExtractionEnvelope` changed in three ways
([extraction-envelope-import.md](extraction-envelope-import.md)):

- **One `ReviewItem` per claim.** Proposals whose claim targets name the same
  claim at the same `pathIndices` are one candidate set, with one candidate per
  distinct value; two or more values make it `conflict`. Item names are now
  derived from that claim slot rather than the proposal index, so every
  imported item name changes and envelopes that repeat a claim yield fewer
  items. Stored review rounds keyed by the old names do not carry over. Read
  `metadata.producer["survey.kontourai.io/extraction-envelope"].proposalIndices`
  to map proposals to items instead of assuming item `i` is proposal `i`.
  Proposals that share a claim must now return identical claim targets. To keep
  a multi-valued field as separate items, give each value its own claim id or
  subject in `claimTarget`, or use an array field so each value has its own
  `pathIndices`.
- **Role-based decisions refuse ambiguity.** `candidateForDecision` (and so the
  workbench, the session event builders, and the MCP decide tool) throws when
  the decision's role names more than one candidate, instead of using the
  first. A `conflict` item from the importer cannot be decided in the workbench.
- **Partial runs and confidence.** The importer accepts the partial reasons
  `provider-failure`, `content-truncated`, and `output-truncated`, an optional
  `result.coverage` list, and proposals without `confidence`. Candidates carry
  `partial` and `coverage` next to `outcome` in their producer metadata. A
  candidate from a proposal without confidence has no `confidence` on the
  candidate or its extraction; code that read `candidate.confidence` as a
  number must handle `undefined`. Imported candidates now carry
  `extraction.extractedAt`, so they project through
  `buildCanonicalReviewedTrustInput`. `toSurfaceReviewedExtractionImport`
  refuses a record with a proposal that has no confidence, because Surface's
  reviewed-extraction profile still requires one.

## See also

- [consumer-integration-guide.md](consumer-integration-guide.md) — first-time
  integration path.
- [review-resource-contract.md](review-resource-contract.md) — the review
  resource envelope and `decisionMode` enforcement details.
