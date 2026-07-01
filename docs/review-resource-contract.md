# Review Resource Contract

Survey review resources are producer-neutral envelopes for UI prototypes and
adapter tests. They sit beside the existing record contract and keep Survey out
of producer policy, queue state, reviewer form state, and product-specific
field catalogs.

Each resource uses a Kubernetes-inspired shape:

```ts
{
  apiVersion: "survey.kontourai.io/v1alpha1",
  kind: "ReviewItem" | "ReviewDecision" | "ReviewSession" | "ReviewSessionEvent",
  metadata: { name, uid?, labels?, annotations?, producer? },
  spec: { ...producer-declared intent },
  status: { ...Survey-readable observation hints }
}
```

## Resources

`ReviewItem` describes one reviewable target and its candidates. It carries
source references, locator or excerpt context, extraction confidence, candidate
roles, claim target hints, and optional projection hints for Survey records.
Roles include `current` and `proposed`, but also neutral roles such as
`alternative`, `source-version`, and `computed` so regulated-document reviews
do not have to pretend every comparison is a current/proposed pair.

`ReviewCandidate` is embedded inside `ReviewItem`. It is intentionally not a
top-level resource because candidate lifecycle belongs to the producer and the
portable contract only needs the serializable candidate payload.

`ReviewDecision` describes the reviewer decision for a `ReviewItem`: candidate,
status, actor, reviewed time, rationale, evidence ids, comfort-zone notes, and
projection hints.

`ReviewSession` is a portable envelope for one review session. It carries the
session snapshot hash, item count, event count, and status so downstream systems
can validate replay without importing workbench mechanics. A session does not own
queue position, assignment, retry, lock, or workflow state — those remain in the
producer's own system.

`ReviewSessionEvent` is a single event in a review session, such as a decision,
undo, or session-complete marker. Events are replayed against the session
snapshot to derive the final apply result. See
[`consumer-integration-guide.md`](consumer-integration-guide.md) for the full
replay and apply boundary.

## Ownership

Producers own acquisition, parsing, candidate ranking, review UX, vertical
policy, field catalogs, reviewer assignment, and operational state. Survey owns
the portable source, extraction, candidate, review, claim target, and projection
record shapes needed to build a Surface Trust Bundle.

Field ownership:

| Field area | Owner | Notes |
| --- | --- | --- |
| `metadata.name`, `labels`, `annotations` | producer | Stable producer identity and grouping labels. |
| `metadata.producer`, `spec.producerPolicy`, `candidate.producer` | producer | Domain context and policy hints; Survey treats these as opaque data. As of this delivery, the well-known `decisionMode` sub-key is typed (`ReviewDecisionMode`) and can be optionally enforced via `applyReviewSession`'s `enforceProducerPolicy` option or `assertReviewDecisionModeAllows` directly; all other keys remain opaque, and enforcement is off by default — unset `producerPolicy`/`decisionMode` never changes behavior. |
| `candidate.source` | producer declares, Survey maps | Maps to `RawSource` when an adapter emits Survey records. |
| `candidate.locator`, `candidate.extraction` | producer declares, Survey maps | Maps to `Extraction`, including locator, excerpt, confidence, extractor, and extracted time. |
| `candidate.role`, `spec.selectedCandidateId` | producer declares | Survey does not enforce current/proposed-only policy by default. A producer may opt in via `producerPolicy.decisionMode` (see [Producer decision mode](#producer-decision-mode)). |
| `candidate.rejectionReason` | producer declares | Optional rationale for a candidate the producer already treats as non-selected, superseded, or rejected; Survey records it without ranking candidates or defining rejection policy. A rejection reason is not a comfort-zone signal by itself. |
| `candidate.claimTarget` | shared boundary | Producer identifies the desired Surface claim target; Survey preserves compatible `ClaimTarget` fields. |
| `ReviewDecision.spec` | producer reviewer event | Maps to `ReviewOutcome` without bringing producer queues into Survey. |
| `projection` hints | Survey-readable | Optional ids linking resources to `RawSource`, `Extraction`, `CandidateSet`, `ReviewOutcome`, and `ClaimTarget` records. |

## Mapping To Survey Records

| Resource field | Survey record |
| --- | --- |
| `ReviewCandidate.source.sourceRef`, `kind`, `observedAt`, `checksum`, `locatorScheme` | `RawSource` |
| `ReviewCandidate.extraction.target`, `confidence`, `extractor`, `extractedAt` plus `locator` | `Extraction` |
| `ReviewItem.spec.target`, `candidates`, `selectedCandidateId`, `candidateSetStatus`, `rationale`, `candidate.rejectionReason` | `CandidateSet` and `Candidate` |
| `ReviewDecision.spec.status`, `actor`, `reviewedAt`, `rationale`, `evidenceIds`, `withinComfortZone` | `ReviewOutcome` |
| `ReviewCandidate.claimTarget` | `ClaimTarget` |
| `projection` | Optional id bridge for tests and adapters |
| `ReviewSession.spec.snapshot`, `itemCount`, `eventCount` | Replay envelope for session validation |
| `ReviewSessionEvent.spec.type`, `reviewItemName`, `candidateId`, `status`, `actor` | Replayable event log for derive/apply |

Session resource mapping and the snapshot-safe replay/export helpers are covered
in detail in [`consumer-integration-guide.md`](consumer-integration-guide.md).

Adapters should emit normal `SurveyInput` records and then call
`buildSurveyTrustBundle`. Review resources are a durable neutral contract for
review payloads, not a second Surface projection path.

Rejected candidates and comfort-zone review posture are separate signals.
Ordinary rejected-candidate feedback should stay on the candidate/review record
and, when Survey supports it, project as rejected-candidate learning. It should
not be modeled as `withinComfortZone: false` just to produce
`learning.comfort-zone`. Use `withinComfortZone: false` only when the reviewer
explicitly records that the conclusion is outside their authority or domain
comfort and needs a different authority to confirm.

## Examples

The public-directory example demonstrates a current/proposed field review. The
regulated-document example demonstrates multi-candidate source-version and
computed roles without requiring current/proposed semantics. Both examples are
plain serializable TypeScript objects and avoid private downstream product
names.

## Prototype

See [`review-workbench-prototype.md`](review-workbench-prototype.md) for the
example-backed browser prototype that renders a browser-safe copy of the
public-directory `ReviewItem`, guarded against drift from the canonical example,
and emits local in-memory `ReviewDecision` payloads for accept proposed, keep
current, and reject proposed decisions.

See [`consumer-integration-guide.md`](consumer-integration-guide.md) for the
recommended consumer path from `ReviewItem` construction through persisted
review events, exported results, and optional Surface projection. A generic
review adapter builder is deliberately deferred until another producer proof
shows repeated, policy-free Survey-shape friction.

## Collection provenance

A `ReviewDecision` can carry an `authorizing` block inside its spec (mapped
from `ReviewOutcome.authorizing`). This block records how the reviewer was asked
and what action they took — the testimony provenance that makes a decision
self-contained for downstream admissibility checks.

Three kinds are admissible: `explicit-statement` (reviewer typed a free-form
statement), `exchange` (a prompt was shown and the reviewer responded — both
halves required), and `authorized-action` (reviewer clicked a named action
against a versioned prompt; requires `promptRef`, `renderedPrompt`, `action`,
and `authorityRef`).

**Vertical UIs inherit correct collection by using the workbench.** `buildReviewDecision`
now populates `authorizing` automatically on every workbench decision. The block
kind is `authorized-action` with:

- `promptRef`: `"review-workbench/decision-card@v1"` — a stable versioned identifier
  for the decision card control.
- `renderedPrompt`: the review question rendered for that item, including the target
  label and both candidate values, so the block is self-contained.
- `action`: `"affirmed-control"` for a pure button click, `"typed"` when the
  reviewer also supplied a rationale note.
- `authorityRef`: `"actor:<actorId>"` — the actor identity already on the outcome.

The provenance logic lives in the workbench boundary, not in the vertical UI, so
consumer products do not need to re-implement it. The `authorizing` field is
optional; existing records without it remain valid.

If `buildAuthorizedActionAuthorizing` returns an invalid block (e.g., an empty
`actorId` during testing), the workbench records the outcome without `authorizing`
and emits a `console.warn`. This is a transparency gap, not a hard block, per
ADR 0004.

For consumers building outcomes outside the workbench, `buildAuthorizedActionAuthorizing`
is exported from `@kontourai/survey`. It constructs and validates the block,
throwing on invalid inputs so callers catch configuration errors at build time.

Validation is available via `validateAuthorizing(block)` from
`@kontourai/survey`. It returns structured issues for transparency-gap reporting;
it does not hard-block decisions. Gaps are flagged for human review, never
silently resolved by model judgment.

For consumers building an `authorized-action` `promptRef` outside the workbench,
use `buildPromptRef({ module, component, version?, scheme? })` from
`@kontourai/survey` to construct a well-formed `promptRef` for
`buildAuthorizedActionAuthorizing` instead of hand-formatting the string. Without
a `scheme` it yields the bare workbench form
(`"review-workbench/decision-card@v1"`); with a `scheme` it yields the prefixed
form (`"survey://rules-admin/keep-current@v1"`).

## Producer decision mode

`producerPolicy.decisionMode` declares how a `ReviewItem` is allowed to be
resolved. It is typed as `ReviewDecisionMode` and takes one of three values:

- `keep-current` — only a keep-current decision is admissible.
- `current-proposed` — only the current or proposed candidate may be selected.
- `free-select` — any candidate declared on the item may be selected.

Enforcement is **opt-in**. Survey never inspects `decisionMode` unless a consumer
asks it to, either by passing `enforceProducerPolicy: true` to `applyReviewSession`
or by calling `assertReviewDecisionModeAllows(item, result)` /
`validateReviewDecisionMode(item, result)` from `@kontourai/survey/review-workbench`
directly. When `producerPolicy` or `decisionMode` is absent, the validators are a
no-op and behavior is unchanged.

Enforcement fails closed: an unrecognized `decisionMode` string reports an
`unknown-decision-mode` issue rather than being silently ignored. All other
`producerPolicy` keys (for example `sourceAuthorityProjection`, `feedbackTags`)
remain opaque and are never inspected.

### TypeScript migration note: `decisionMode` is now a literal union

`ProducerPolicy.decisionMode` is typed as `ReviewDecisionMode`, a 3-value
string-literal union (`"keep-current" | "current-proposed" | "free-select"`),
not `string`. Object literals using one of the three literal values (the shape
both known real consumers already produce) keep typechecking unchanged. The
index signature on `ProducerPolicy` still tolerates unknown keys, but it does
**not** widen `decisionMode` back to `string` — this is a source-breaking
narrowing for a TypeScript caller that assigns a plain `string`-typed value
(for example, a value read from configuration, or a `switch` default branch)
to `decisionMode`:

```ts
declare const dynamicMode: string;

// Before this delivery: producerPolicy was Record<string, unknown>, so this
// compiled unconditionally.
const policy: ProducerPolicy = {
  decisionMode: dynamicMode, // ts(2322): Type 'string' is not assignable to type 'ReviewDecisionMode | undefined'.
};
```

Fix by narrowing the value to the literal union before assigning it — either
validate it explicitly, or assert it with `as const`/a type assertion once you
know it is one of the three allowed values:

```ts
const policy: ProducerPolicy = {
  decisionMode: dynamicMode as ReviewDecisionMode, // caller-verified narrowing
};
```

Producers that always assign one of the three literal values directly (as both
known real consumers do) are unaffected and require no changes.
