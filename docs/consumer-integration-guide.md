# Consumer Integration Guide

Survey is the producer-side contract for reviewable claims before they cross
into Surface. A consumer should be able to keep its product workflow local while
using Survey for the portable source, extraction, candidate, review, and result
records.

The canonical integration path is:

1. Producer creates `ReviewItem` resources from its own queue or reconciliation
   state.
2. Producer mounts the review workbench with a `ReviewQueueSessionState`.
3. Producer persists `ReviewSessionEvent` resources through a product-owned
   event store.
4. Producer exports `ReviewWorkbenchResult` and `ReviewDecision` resources.
5. Producer applies product policy locally and, when appropriate, projects
   Survey records into Surface with `buildSurveyTrustBundle`.

Survey should not own the producer queue, auth, tenancy, parser policy, source
ranking policy, final apply semantics, or product field catalog.

## Consumer Adapter Contract

The reusable boundary is intentionally small:

| Step | Producer owns | Survey owns |
| --- | --- | --- |
| Queue | Which product records need review, who can see them, and tenancy/auth rules. | `ReviewQueueSessionState` as the portable queue/session shape. |
| Item | Stable ids, field catalog, candidate ranking, source authority posture, and product policy notes. | `ReviewItem`, `ReviewCandidate`, source, extraction, locator, claim target, and projection hints. |
| Presentation | Human labels, value summaries, and links back to product records, sources, claims, or traces. | `ReviewPresentationAdapter` hooks plus deterministic item/result presentation builders. |
| Events | Durable event storage, optimistic concurrency, and reviewer identity from trusted product context. | `ReviewSessionEvent` resources and replay/validation helpers. |
| Apply | Current-state validation, product policy, mutating writes, audit tables, and downstream jobs. | `ReviewWorkbenchResult` and `ReviewDecision` derived from a pre-decision review snapshot plus persisted events. |
| Surface handoff | Which reviewed observations become claims and when to publish them. | Normal Survey observation/claim records and `buildSurveyTrustBundle` projection into Surface. |

`ReviewPresentationAdapter` is display-only. It lets a product explain ids and
values without changing canonical `ReviewItem` data or apply authority.

```ts
import {
  buildReviewItemPresentation,
  buildReviewResultPresentation,
  type ReviewPresentationAdapter,
} from "@kontourai/survey/review-workbench";

const presentationAdapter = {
  labelForTarget: (target) => target === "operatingLicenseCredential"
    ? "Operating license credential"
    : undefined,
  labelForCandidateRole: (role) => role === "current"
    ? "Current managed credential"
    : role === "proposed"
      ? "Registry candidate"
      : undefined,
  summarizeValue: (value) => summarizeCredentialValue(value),
  linkForReviewItem: (item) => ({
    label: typeof item.metadata.producer?.displayName === "string"
      ? item.metadata.producer.displayName
      : "Review item",
    href: `/review/items/${encodeURIComponent(item.metadata.name)}`,
  }),
  linkForSource: (sourceRef) => ({ href: sourceRef }),
  linkForTraceRef: (ref) => ref.kind === "claim"
    ? { label: "Claim target", href: `/claims/${encodeURIComponent(ref.value)}` }
    : undefined,
} satisfies ReviewPresentationAdapter;

const itemPresentation = buildReviewItemPresentation(reviewItem, presentationAdapter);
const resultPresentation = buildReviewResultPresentation(result, reviewItem, presentationAdapter);
```

A server apply path should treat persisted events as the auditable input and
derive results again from the pre-decision review queue snapshot. Browser
exports and presentation payloads are useful for inspection, not write
authority.


## Vocabulary And Id Primitives

Producers that project into Survey repeatedly need the same three primitives:
stable identifiers, a typed product vocabulary, and a `ConfidenceBasis`. Survey
exports them so consumers do not hand-roll a copy each.

`stableId(parts)` builds a deterministic, url-safe id from ordered parts —
lowercased, non-alphanumeric runs collapsed to a hyphen, joined with a dot:

```ts
import { stableId } from "@kontourai/survey";

const candidateSetId = stableId(["public-directory", "entity-123", "availabilityStatus"]);
// "public-directory.entity-123.availabilitystatus"
```

`defineProductVocabulary(def)` freezes a product's subject type, facet,
claim-type names, and decision-effect names into one discoverable value
(the deprecated `surface` option is still accepted for one release — see
the [Upgrade Guide](upgrade-guide.md#facet-rename-hachure-schema-5)):

```ts
import { defineProductVocabulary } from "@kontourai/survey";

const vocabulary = defineProductVocabulary({
  subjectType: "public-directory.entity",
  facet: "public-directory.entity-profile",
  claimTypes: {
    scalarField: "public-data.field",
    scalarFieldCandidate: "public-data.field-candidate",
  },
  decisionEffects: {
    acceptedCandidateValue: "accepted-candidate-value",
    keptCurrentValue: "kept-current-value",
  },
});
```

`defineProductVocabulary`'s type declarations require TypeScript 5.0+ to
parse (`const` type parameters preserve `claimTypes`/`decisionEffects`
literal types without `as const`); see the [Upgrade Guide's TypeScript
5.0+ callout](upgrade-guide.md#consuming-decisioneffects-safely) if your
project is still on an older TypeScript compiler.

`confidenceBasisForReview(input)` maps a reviewed status and impact level into a
Surface `ConfidenceBasis`. It is **conservative by default**: `sourceQuality`
defaults to `"unknown"` and `evidenceStrength` defaults to `"none"` — the
weakest values Surface accepts — unless the caller passes an explicit value.
The only field derived from `status` without an override is
`reviewerAuthority` (`"operator"` when `status` is `"verified"`, otherwise
`"none"`). This helper does not reproduce any one app's hand-rolled confidence
algorithm; known consumers use different domain heuristics for `sourceQuality`
and `evidenceStrength` (for example, deriving `sourceQuality` from an
extracted document's source type), so producers with that kind of domain
knowledge should pass `sourceQuality`/`evidenceStrength` explicitly rather
than rely on the bare defaults:

```ts
import { confidenceBasisForReview } from "@kontourai/survey";

// Bare defaults: conservative floor values, only reviewerAuthority is status-driven.
const conservativeBasis = confidenceBasisForReview({
  status: "verified",
  impactLevel: "medium",
  extractionConfidence: 0.91,
});
// -> { sourceQuality: "unknown", reviewerAuthority: "operator", evidenceStrength: "none",
//      impactLevel: "medium", extractionConfidence: 0.91 }

// A producer with domain knowledge of its own source quality passes it explicitly,
// e.g. a source-type-driven mapping (strong for a corrected/high-confidence
// document, moderate for medium-confidence, weak otherwise):
const domainAwareBasis = confidenceBasisForReview({
  status: "verified",
  impactLevel: "medium",
  extractionConfidence: 0.91,
  sourceQuality: "strong",
  evidenceStrength: "strong",
});
```

## Server-Owned Review Sessions

For browser-backed review flows, the server should own the review snapshot. A
consumer typically stores a local session row or file containing:

- a product session id;
- the Survey `sessionName`;
- the pre-decision `ReviewQueueSessionState` snapshot;
- `hashReviewSessionSnapshot(snapshot)`;
- optional event-count or optimistic-concurrency metadata.

The browser may submit `ReviewSessionEvent` resources and a server session id,
but it should not submit the authoritative snapshot or derived apply result.
Before saving or applying events, validate that the request still matches the
server snapshot:

```ts
import {
  deriveReviewSessionApplyResultForSnapshot,
} from "@kontourai/survey/review-workbench";
import {
  assertServerReviewSessionEvents,
  assertServerReviewSessionFreshness,
  createServerReviewSessionRecord,
  deriveServerReviewSessionApplyResult,
} from "@kontourai/survey/review-workbench/server-review-session";

const record = createServerReviewSessionRecord({
  sessionName: "review-workbench-session",
  snapshot: reviewSessionSnapshot,
  eventCount: persistedEventCount,
  updatedAt: storedSessionUpdatedAt,
});

assertServerReviewSessionFreshness(record, rebuildCurrentSnapshot(), persistedEventCount);
assertServerReviewSessionEvents(record, submittedEvents);

const applyResult = deriveServerReviewSessionApplyResult({
  record,
  currentSnapshot: rebuildCurrentSnapshot(),
  events: submittedEvents,
  requiredResolvedItems: "all",
});
```

`assertServerReviewSessionFreshness` compares stable snapshot hashes and, when
both sides provide an event count, the expected event count. A producer that
synthesizes events server-side from a trusted action can omit event-count
checking and still use the snapshot hash to detect stale ReviewItems.
`assertServerReviewSessionEvents` reuses Survey replay validation and also
rejects events for the wrong `sessionName`, unknown ReviewItems, active items,
or candidates outside the server-owned snapshot.
`deriveServerReviewSessionApplyResult` composes those server-side checks before
deriving the same typed apply result as `deriveReviewSessionApplyResultForSnapshot`.

```ts
import {
  buildReviewSessionEvents,
  deriveReviewSessionApplyResultForSnapshot,
  persistReviewSessionEvents,
} from "@kontourai/survey/review-workbench";

const currentRecord = await loadCurrentProductRecord(recordId);
const reviewSessionSnapshot = await loadReviewSessionSnapshot(reviewId);
const reviewedSession = buildReviewedSession(reviewSessionSnapshot, reviewerInput);
const eventsToPersist = buildReviewSessionEvents(reviewedSession);
const persisted = await persistReviewSessionEvents({
  session: reviewedSession,
  events: eventsToPersist,
  expectedEventCount: await countPersistedReviewEvents(reviewId),
  persist: ({ events, expectedEventCount }) =>
    saveReviewEvents({ reviewId, events, expectedEventCount }),
});

const applyResult = deriveReviewSessionApplyResultForSnapshot({
  snapshot: reviewSessionSnapshot,
  events: persisted.events,
  requiredResolvedItems: "all",
});
if (!applyResult.ok) {
  throw new Error("Review events do not match the review session snapshot.");
}

for (const result of applyResult.results) {
  assertProductTargetStillMatches(currentRecord, result);
  await applyProductPolicy({
    decision: result.decision,
    selectedCandidateId: result.selectedCandidateId,
    selectedValue: result.selectedValue,
    actorId: auth.user.id,
    appliedAt: new Date().toISOString(),
  });
}
```

Surface projection is still the normal Survey path. A review result tells the
producer which candidate was selected; producer code then emits the reviewed
source/extraction/candidate/review/claim records it wants to publish and calls
`buildSurveyTrustBundle`. The workbench also exposes a projection preview for UI
explanation, but that preview is not a separate write path.

`persistReviewSessionEvents` returns the event array accepted for replay. If a
producer's persistence layer canonicalizes or reads back stored resources, its
`persist` callback should return `{ events, eventCount }`; otherwise the
callback must atomically commit exactly the supplied array before returning.

The generic, test-covered workbench example lives at
[`examples/review-workbench/facility-credential-consumer.ts`](../examples/review-workbench/facility-credential-consumer.ts).
It shows a `ReviewItem`, `ReviewPresentationAdapter`, persisted
`ReviewSessionEvent` resources, event replay, derived `ReviewWorkbenchResult`,
and a Surface projection preview without product-specific policy embedded in
Survey.

For the smallest server apply boundary, see
[`examples/review-workbench/server-apply-consumer.ts`](../examples/review-workbench/server-apply-consumer.ts).
That example intentionally keeps the product mutation local: Survey derives the
review result from the pre-decision snapshot and persisted events, while the
consumer validates current state, rejects already-applied results, stamps the
authenticated actor, and prepares its own write.

## Public-Directory Example

A public-directory producer often has an existing value and a proposed value
from a crawl or API ingestion pass. The producer owns what "approve" means, but
Survey can carry the reviewable candidate shape.

```ts
import {
  reviewResourceApiVersion,
  type ReviewItem,
} from "@kontourai/survey";

const registrationStatusReviewItem = {
  apiVersion: reviewResourceApiVersion,
  kind: "ReviewItem",
  metadata: {
    name: "public-record.entity-123.registrationStatus.review-1",
    labels: {
      domain: "public-directory",
      field: "registrationStatus",
    },
  },
  spec: {
    target: "registrationStatus",
    candidateSetStatus: "needs-review",
    producerPolicy: {
      decisionMode: "current-proposed",
    },
    projection: {
      candidateSetId: "public-record.entity-123.registrationStatus.candidates",
    },
    candidates: [
      {
        id: "public-record.entity-123.registrationStatus.current",
        role: "current",
        value: "ACTIVE",
        source: {
          sourceRef: "current-record:entity-123:registrationStatus",
          kind: "manual-entry",
          observedAt: "2026-06-01T12:00:00.000Z",
          locatorScheme: "structured-field",
        },
        locator: {
          scheme: "structured-field",
          locator: "field:registrationStatus",
          excerpt: "Current reviewed value.",
        },
        extraction: {
          extractionId: "public-record.entity-123.registrationStatus.current.extraction",
          target: "registrationStatus",
          confidence: 1,
          extractor: "current-record",
          extractedAt: "2026-06-01T12:00:00.000Z",
        },
        claimTarget: {
          claimId: "public-record.entity-123.registrationStatus.current.claim",
          subjectType: "public-record.entity",
          subjectId: "entity-123",
          facet: "public-directory.profile",
          claimType: "public-data.field",
          fieldOrBehavior: "registrationStatus",
          impactLevel: "medium",
          evidenceType: "human_attestation",
          evidenceMethod: "observation",
          collectedBy: "current-record",
        },
        projection: {
          rawSourceId: "public-record.entity-123.registrationStatus.current.source",
          extractionId: "public-record.entity-123.registrationStatus.current.extraction",
          candidateSetId: "public-record.entity-123.registrationStatus.candidates",
          candidateId: "public-record.entity-123.registrationStatus.current",
          claimId: "public-record.entity-123.registrationStatus.current.claim",
        },
      },
      {
        id: "public-record.entity-123.registrationStatus.proposed",
        role: "proposed",
        value: "WAITLIST",
        confidence: 0.84,
        sourceRank: 1,
        source: {
          sourceRef: "https://records.example.test/entities/123",
          kind: "web-page",
          observedAt: "2026-06-01T12:30:00.000Z",
          locatorScheme: "html",
        },
        locator: {
          scheme: "html",
          locator: "css:#registration-status",
          excerpt: "Registration status: waitlist",
        },
        extraction: {
          extractionId: "public-record.entity-123.registrationStatus.proposed.extraction",
          target: "registrationStatus",
          confidence: 0.84,
          extractor: "example-crawler",
          extractedAt: "2026-06-01T12:30:00.000Z",
        },
        claimTarget: {
          claimId: "public-record.entity-123.registrationStatus.proposed.claim",
          subjectType: "public-record.entity",
          subjectId: "entity-123",
          facet: "public-directory.profile",
          claimType: "public-data.field",
          fieldOrBehavior: "registrationStatus",
          impactLevel: "medium",
          evidenceType: "crawl_observation",
          evidenceMethod: "extraction",
          collectedBy: "example-crawler",
        },
        projection: {
          rawSourceId: "public-record.entity-123.registrationStatus.proposed.source",
          extractionId: "public-record.entity-123.registrationStatus.proposed.extraction",
          candidateSetId: "public-record.entity-123.registrationStatus.candidates",
          candidateId: "public-record.entity-123.registrationStatus.proposed",
          claimId: "public-record.entity-123.registrationStatus.proposed.claim",
        },
      },
    ],
  },
  status: {
    observedCandidateCount: 2,
  },
} satisfies ReviewItem;
```

## Regulated-Rule Example

A regulated-rule producer may also have current and proposed values, but the
review semantics are different. The proposed value may come from an official
publication and the current value may be a managed rule value. Product policy
may allow only "keep current" for a particular conflict until a specialist
resolves it. `producerPolicy.decisionMode` is now typed and *optionally*
enforceable: by default Survey still treats it as opaque and the producer
validates supported actions before applying a `ReviewDecision`, so the example
below works exactly as documented. A producer that wants Survey to enforce the
declared mode can opt in with `enforceProducerPolicy: true` on
`applyReviewSession` (or call `assertReviewDecisionModeAllows` directly).

> **TypeScript migration note:** `ProducerPolicy.decisionMode` is typed as the
> 3-value literal union `ReviewDecisionMode` (`"keep-current" |
> "current-proposed" | "free-select"`), not `string`. Object literals using one
> of the three literal values keep typechecking unchanged, but assigning a
> plain `string`-typed variable (e.g. read from configuration) to
> `decisionMode` now fails to compile. One-line fix: narrow it first, for
> example `decisionMode: dynamicMode as ReviewDecisionMode` once you have
> verified the value is one of the three allowed strings. See
> [Producer decision mode](./review-resource-contract.md#producer-decision-mode)
> for the full migration note.
>
> See also [Consuming `decisionEffects` safely](./upgrade-guide.md#consuming-decisioneffects-safely)
> in the upgrade guide for the related `defineProductVocabulary`
> vocabulary-object-specific gotcha this note does not cover.

The same `ReviewItem` contract works because the candidate shape carries typed
values, source posture, locators, evidence type, claim target hints, and
producer policy without Survey deciding the domain result.

```ts
import {
  reviewResourceApiVersion,
  type ReviewItem,
} from "@kontourai/survey";

const ruleConflictReviewItem = {
  apiVersion: reviewResourceApiVersion,
  kind: "ReviewItem",
  metadata: {
    name: "regulated-rule-conflict-standard-threshold",
    labels: {
      domain: "regulated-rule-source",
    },
  },
  spec: {
    target: "standardThreshold",
    candidateSetStatus: "conflict",
    selectedCandidateId: "regulated-rule-conflict-standard-threshold.current",
    rationale: "Extracted source value conflicts with the managed value.",
    producerPolicy: {
      decisionMode: "keep-current",
      policyNote: "Producer validates supported actions before applying a decision.",
      sourceAuthorityProjection: "only-for-selected-source-backed-value",
    },
    projection: {
      candidateSetId: "regulated-rule-conflict-standard-threshold.candidates",
    },
    candidates: [
      {
        id: "regulated-rule-conflict-standard-threshold.current",
        role: "current",
        value: 15000,
        confidence: 1,
        source: {
          sourceRef: "managed-rules://example/2026/standardThreshold",
          kind: "manual-entry",
          observedAt: "2026-06-03T00:00:00.000Z",
          locatorScheme: "structured-field",
        },
        locator: {
          scheme: "structured-field",
          locator: "managed-rules:path=standardThreshold",
          excerpt: "Current managed rule value.",
        },
        extraction: {
          extractionId: "regulated-rule-conflict-standard-threshold.current.extraction",
          target: "standardThreshold",
          confidence: 1,
          extractor: "example-rule-manager",
          extractedAt: "2026-06-03T00:00:00.000Z",
        },
        claimTarget: {
          claimId: "regulated-rule.example.2026.standard-threshold.current",
          subjectType: "regulated-rule-source",
          subjectId: "example:2026:standardThreshold",
          facet: "regulated.rules",
          claimType: "regulated.rule-source-value",
          fieldOrBehavior: "standardThreshold",
          impactLevel: "high",
          evidenceType: "human_attestation",
          evidenceMethod: "attestation",
          collectedBy: "example-rule-manager",
        },
      },
      {
        id: "regulated-rule-conflict-standard-threshold.proposed",
        role: "proposed",
        value: 16000,
        confidence: 0.95,
        source: {
          sourceRef: "https://example.test/regulatory-bulletins/2026-thresholds.pdf",
          kind: "uploaded-document",
          observedAt: "2026-06-03T00:30:00.000Z",
          locatorScheme: "pdf",
        },
        locator: {
          scheme: "pdf",
          locator: "pdf:page=12;section=Standard%20Threshold",
          excerpt: "Example Individual Standard Threshold $16,000",
        },
        extraction: {
          extractionId: "regulated-rule-conflict-standard-threshold.proposed.extraction",
          target: "standardThreshold",
          confidence: 0.95,
          extractor: "example-rule-source-parser",
          extractedAt: "2026-06-03T00:30:00.000Z",
        },
        claimTarget: {
          claimId: "regulated-rule.example.2026.standard-threshold.proposed",
          subjectType: "regulated-rule-source",
          subjectId: "example:2026:standardThreshold",
          facet: "regulated.rules",
          claimType: "regulated.rule-source-value",
          fieldOrBehavior: "standardThreshold",
          impactLevel: "high",
          evidenceType: "policy_rule",
          evidenceMethod: "extraction",
          collectedBy: "example-rule-source-parser",
        },
        producer: {
          sourceAuthority: {
            authorityClass: "official_publication",
            declaredBy: "Example regulatory source registry",
            scope: "standardThreshold rule value for example 2026",
          },
        },
      },
    ],
  },
  status: {
    observedCandidateCount: 2,
    selectedCandidateId: "regulated-rule-conflict-standard-threshold.current",
  },
} satisfies ReviewItem;
```

The same `ReviewItem` can be assembled with `currentProposedReviewItem`, which
owns the generic envelope, candidate ids, roles, and candidate-set wiring while
the producer keeps its domain value and claim vocabulary:

```ts
import { currentProposedReviewItem } from "@kontourai/survey";

const ruleConflictItem = currentProposedReviewItem({
  name: "regulated-rule-conflict-standard-threshold",
  target: "standardThreshold",
  candidateSetStatus: "conflict",
  selectedCandidateRole: "current",
  labels: { domain: "regulated-rule-source" },
  rationale: "Extracted source value conflicts with the managed value.",
  producerPolicy: {
    decisionMode: "keep-current",
    sourceAuthorityProjection: "only-for-selected-source-backed-value",
  },
  current: currentRuleCandidate, // domain value/claim shaping stays with the producer
  proposed: proposedRuleCandidate,
});
```

Because this item declares `decisionMode: "keep-current"`, a consumer can ask
Survey to enforce it at apply time. With `enforceProducerPolicy: true`, a
synthetic `accept-proposed` decision for this item is rejected as a
`decision-mode-violation` instead of being applied:

```ts
import { applyReviewSession } from "@kontourai/survey/review-workbench/server-review-session";

const applied = applyReviewSession({
  snapshot: reviewSessionSnapshot,
  sessionName,
  events: persistedEvents, // a synthetic accept-proposed decision, for illustration
  requiredResolvedItems: "any",
  enforceProducerPolicy: true,
});

if (!applied.ok) {
  // applied.issues includes { code: "decision-mode-violation", reviewItemName, ... }
}
```

## Web Component

`@kontourai/survey/review-workbench/element` exports a `<survey-review-workbench>` custom element.
It works like `<surface-trust-panel>`: data via the `.session` property or a `src` attribute
that fetches JSON, shadow DOM isolates styles, and `--k-*` tokens inherit through the shadow
boundary. The element is self-contained — a single module import is all that is needed; no
separate stylesheet import is required.

**Single-import usage**

```ts
import "@kontourai/survey/review-workbench/element";

// Property assignment — primary API
const el = document.querySelector("survey-review-workbench");
el.session = reviewQueueSession;         // ReviewQueueSessionState | ReviewWorkbenchState
el.presentationAdapter = myAdapter;      // ReviewPresentationAdapter | undefined
```

```html
<survey-review-workbench theme="survey" color-scheme="dark"></survey-review-workbench>
```

**src attribute**

Set a `src` attribute to fetch a JSON-serialised `ReviewQueueSessionState` from a URL.
The element fetches the URL, parses the JSON, and calls `this.session = parsed` — identical
to setting the property directly.

```html
<survey-review-workbench src="/api/review-sessions/my-session.json"
                          theme="survey" color-scheme="dark">
</survey-review-workbench>
```

Changing the `src` attribute at runtime re-fetches. If the fetch fails or returns a non-2xx
status, an inline error message is rendered inside the shadow root. While no session is loaded
(before the first assignment or before the fetch resolves) the element renders a neutral empty
state message.

**Attributes**

| Attribute | Values | Default |
|---|---|---|
| `theme` | `survey` `console` `flow` `surface` | `survey` |
| `color-scheme` | `dark` `light` | `dark` |
| `src` | URL string | — |

**Theming token contract**

CSS custom properties inherit through the shadow boundary. Set any `--k-*` token
on `survey-review-workbench` or an ancestor to override the shadow defaults.
The element declares default token values on `:host` so host-page rules always win.
See the "Theming" section below for the full token list and a worked example.

**Responsive layout**

At viewports ≤ 620 px (or when the embed container width is that narrow), each
field card's Current → Proposed diff stacks vertically instead of side by side,
and the decision row wraps. There is no separate mobile mode to opt into — the
same markup and CSS handle every width via `@media`/container queries.

## Theming

The review workbench (both `mountReviewWorkbench` into a plain element and the
`<survey-review-workbench>` custom element) is themed entirely through `--k-*`
CSS custom properties. A host app can re-skin the whole surface — backgrounds,
text, borders, the brand accent, and the accept/keep/reject signal colors —
by overriding tokens; no markup or class-name changes are needed.

**The full token set**

| Token | Role |
|---|---|
| `--k-bg` | Page/shell background |
| `--k-panel` | Card/panel background |
| `--k-panel-raised` (alias `--k-raised`) | Raised panel layer (the proposed-value box) |
| `--k-sunken` | Recessed well background (provenance box, audit details) |
| `--k-text` | Primary text |
| `--k-text-muted` (alias `--k-muted`) | Secondary text |
| `--k-text-faint` (alias `--k-faint`) | Tertiary / label text |
| `--k-line` | Subtle borders |
| `--k-line-strong` | Visible borders |
| `--k-brand` | Accent / brand colour (Apply button, "Needs review" chip, links) |
| `--k-brand-contrast` (alias `--k-brand-ink`) | Text color on a brand-colored background |
| `--k-brand-wash` | Brand tint wash (behind the "Needs review" chip) |
| `--k-positive` | Accept / verified indicator |
| `--k-positive-wash` | Tint wash behind the "Accepted" chip |
| `--k-caution` | Escalate / low-confidence / no-source indicator |
| `--k-caution-wash` | Tint wash behind the "No source" flag |
| `--k-negative` | Reject / flagged-wrong indicator |
| `--k-negative-wash` | Tint wash behind the "Kept — flagged wrong" chip |
| `--k-radius-md` (alias `--k-radius`) | Card/panel border radius |
| `--k-radius-sm` | Inner element radius (buttons, wells) |
| `--k-shadow` | Card drop shadow |
| `--k-font-ui` | UI typeface |
| `--k-font-mono` | Monospace typeface (confidence %, audit IDs) |

The `--k-muted`/`--k-faint`/`--k-raised`/`--k-brand-ink`/`--k-*-wash`/`--k-radius`
aliases are declared as `var()` references onto the base token they derive
from (e.g. `--k-muted: var(--k-text-muted)`), so overriding the base token a
host already knows re-skins the alias automatically — and a host can still
override an alias directly for finer-grained control without touching the
base token.

**Preset themes vs. a host's own brand**

Four built-in presets ship in `@kontourai/ui`'s `themes.css` and are selected
with the `theme` attribute/class: `survey`, `console`, `flow`, `surface`. Each
sets its own `--k-brand` (and `theme-console` swaps the full palette and
typeface). These are conveniences, not the only path to a themed workbench.

**The escape hatch — a host's own full palette, no preset required**

Pass `theme="custom"` on the custom element (or omit `theme`/any of the four
preset names when mounting the plain `.survey-workbench-embed` container) to
opt out of the presets entirely, then set `--k-*` tokens directly — either as
inline styles or in the host's own stylesheet. Because none of the preset
classes apply, there is nothing to override or fight:

```html
<style>
  /* A host's own brand palette — set on the element or any ancestor. */
  survey-review-workbench.acme-brand {
    --k-bg: #faf7f3;
    --k-panel: #ffffff;
    --k-panel-raised: #fffcf8;
    --k-sunken: #f3ede4;
    --k-text: #241a12;
    --k-text-muted: #6b5b4b;
    --k-text-faint: #9a8974;
    --k-line: #ebe2d6;
    --k-line-strong: #d8cbb8;
    --k-brand: #c2521e;
    --k-brand-contrast: #ffffff;
    --k-positive: #2f7d32;
    --k-caution: #a9660a;
    --k-negative: #c13a31;
  }
  @media (prefers-color-scheme: dark) {
    survey-review-workbench.acme-brand {
      --k-bg: #17120d;
      --k-panel: #211a13;
      --k-panel-raised: #281f16;
      --k-sunken: #120e09;
      --k-text: #f1e7da;
      --k-text-muted: #b6a48f;
      --k-text-faint: #7c6c58;
      --k-line: #2e2419;
      --k-line-strong: #40331f;
      --k-brand: #e8823f;
      --k-brand-contrast: #1c0f06;
    }
  }
</style>
<survey-review-workbench class="acme-brand" theme="custom" color-scheme="dark">
</survey-review-workbench>
```

The same layout, class names, and interactions render — only the tokens
change. This is the same technique the approved redesign mockup uses to prove
a Survey-default palette and a distinct host palette from one shared markup.

## Mount The Workbench

The workbench accepts a queue-shaped session. The producer owns how items are
loaded, assigned, filtered, and authorized.

```ts
import {
  createPersistentReviewSessionEventStore,
  mountReviewWorkbench,
} from "@kontourai/survey/review-workbench";
import "@kontourai/survey/review-workbench.css";

const session = {
  items: [registrationStatusReviewItem],
  activeItemName: registrationStatusReviewItem.metadata.name,
  notesByItemName: {},
  decisionsByItemName: {},
  actorId: "reviewer@example.test",
  reviewedAt: new Date().toISOString(),
};

mountReviewWorkbench(document.querySelector("#review")!, session, {
  eventStore: createPersistentReviewSessionEventStore({
    initialEvents,
    persist: ({ events, expectedEventCount }) =>
      saveReviewEvents({ events, expectedEventCount }),
    onStatusChange: (state) => {
      renderPersistenceStatus(state.status);
    },
  }),
});
```

`expectedEventCount` is an optimistic concurrency hint. The producer can reject
a save when another reviewer has already written events for the same review
queue. Survey queues saves and reports persistence status, but the producer
owns the database, conflict response, and retry UX.

## Export Results

Use `buildReviewWorkbenchResultsFromSession` when the producer wants a compact
view of completed review choices for display, audit export, or trusted
in-process code. Use `buildReviewWorkbenchSessionExport` when the producer also
wants the replayable session and event resources.

```ts
import {
  buildReviewWorkbenchResultsFromSession,
  buildReviewWorkbenchSessionExport,
  replayReviewSessionEvents,
} from "@kontourai/survey/review-workbench";

const replayedSession = replayReviewSessionEvents(session, persistedEvents);
const results = buildReviewWorkbenchResultsFromSession(replayedSession);
const exported = buildReviewWorkbenchSessionExport(replayedSession, persistedEvents);

for (const result of results) {
  renderReviewSummary({
    reviewItemName: result.reviewItemName,
    decision: result.decision,
    selectedCandidateId: result.selectedCandidateId,
    selectedValue: result.selectedValue,
    reviewDecision: result.reviewDecision,
    unselectedCandidates: result.unselectedCandidates,
  });
}
```

The producer still decides whether a selected candidate updates a record,
creates a rejected-candidate learning signal, triggers a recomputation, or only
records an audit event. For web mutation routes, use the server-side apply
pattern below instead of trusting browser-computed results.

## Apply Review Results

Survey can derive the selected candidate, review decision resource, and
replayable audit trail. The producer still owns write authority. A server-side
apply path should load the product's current record, rebuild or load the
pre-decision `ReviewItem`/`ReviewSession` snapshot that was presented for
review, replay persisted events against that snapshot, derive
`ReviewWorkbenchResult` values through Survey, validate those values against
the current product state, and only then apply product-specific policy.

A reviewer's inline edit to a proposed value is carried in the decision event
itself (`data.workbenchEditedValue`) and reconstructed by
`replayReviewSessionEvents`, so `snapshot + persisted events` is a complete
record: the derived `effectiveValue` reflects the edit without any separate
edit channel. Persist the events (which the workbench emits) and you have the
edit; you do not need to capture `editedValuesByItemName` out of band.

For server-side replay, prefer the snapshot-safe apply preparation helper:

```ts
import {
  deriveReviewSessionApplyResultForSnapshot,
} from "@kontourai/survey/review-workbench";

const applyResult = deriveReviewSessionApplyResultForSnapshot({
  snapshot: reviewSessionSnapshot,
  events: persistedEvents,
  requiredResolvedItems: "all",
});

if (!applyResult.ok) {
  throw new Error(applyResult.issues.map((issue) => issue.message).join(" "));
}

for (const result of applyResult.results) {
  assertProductRecordStillMatchesReviewTarget(result);
  applyProductPolicy({
    reviewItemName: result.reviewItemName,
    selectedCandidateId: result.selectedCandidateId,
    selectedValue: result.selectedValue,
    status: result.status,
  });
}
```

`applyReviewSession` is the recommended one-call entry point for this path. It
collapses the resolve-record → derive → normalize-errors → enforce-policy →
map-to-actions choreography into a single call that returns a discriminated
`{ ok }` result instead of throwing, and it never changes behavior unless you opt
in to `enforceProducerPolicy`. The manual `deriveServerReviewSessionApplyResult`
and `mapReviewWorkbenchResultsToApplyActions` pieces above remain available for
custom choreography:

```ts
import { applyReviewSession } from "@kontourai/survey/review-workbench/server-review-session";

const applied = applyReviewSession({
  snapshot: reviewSessionSnapshot,
  sessionName,
  events: persistedEvents,
  requiredResolvedItems: "all",
  mapActions: {
    requireUniqueTargets: true,
    map: ({ result, target }) =>
      result.decision === "accept-proposed"
        ? { kind: "apply-field", target }
        : { kind: "leave-current", target },
  },
});

if (!applied.ok) {
  // applied.issues carries normalized { code } values: "stale-session",
  // "invalid-events", "unresolved-review-item", "decision-mode-violation",
  // or "action-mapping-failed".
  throw new Error(applied.issues.map((issue) => issue.message).join(" "));
}

for (const { action } of applied.actions) {
  applyProductAction(action);
}
```

Use `requiredResolvedItems: "all"` for full approval flows and `"any"` for
partial apply flows where at least one reviewed item must be ready. Survey
returns replay and completion issues as data so product API routes can choose
their own HTTP status, audit logging, and reviewer-facing copy.

Do not accept browser-submitted `ReviewDecision` resources,
`ReviewWorkbenchSessionExport.results`, or standalone decision fields as write
authority for web mutations. Those payloads are useful for display,
debugging, local trusted scripts, or audit export, but a product server should
derive write results from trusted session state and persisted events. Events
alone are also insufficient when the server cannot reconstruct the reviewed
candidate values; store the reviewed session snapshot or rebuild it from
server-owned data.

Review actor and write time should come from authenticated server context for
mutations. The actor and timestamp in Survey resources describe the review
session, but the product owns authorization, tenancy, reviewer assignment,
write stamps, and conflict handling.

## Project To Surface

Review resources are not a second Surface projection path. When a producer is
ready to expose trust state, it should emit normal Survey observations or claim
records and then call `buildSurveyTrustBundle`.

When those records come directly from a successful `applyReviewSession`, prefer
`buildCanonicalReviewedTrustInput`. It derives the complete `SurveyInput` from
the server-owned items and applied results, and returns the stable
`projectionContextId` to pass to `buildSurveyTrustBundle`. This avoids a second
consumer-maintained mapping where status, edited values, or provenance could
drift from the canonical review. See
[Canonical reviewed TrustInput](review-resource-contract.md#canonical-reviewed-trustinput).

```ts
import {
  buildSurveyTrustBundle,
  reviewedCurrentProposedResolution,
  SurveyInputBuilder,
} from "@kontourai/survey";
import { buildTrustReport, validateTrustBundle } from "@kontourai/surface";

const surveyInput = new SurveyInputBuilder({
  source: "example-producer.review-session-1",
})
  .addClaimRecords(reviewedCurrentProposedResolution({
    id: "public-record.entity-123.registrationStatus.review-1",
    target: "registrationStatus",
    selectedCandidateRole: "proposed",
    reviewOutcome: {
      status: "verified",
      actor: "reviewer@example.test",
      reviewedAt: new Date().toISOString(),
      rationale: "Source excerpt supports the proposed value.",
    },
    currentObservation,
    proposedObservation,
  }))
  .build();

const report = buildTrustReport(validateTrustBundle(
  buildSurveyTrustBundle(surveyInput),
));
```

For source-authority claims, prefer
`sourceOfAuthorityObservationBuilder`. For corrected documents or other
multi-candidate cases, prefer `candidateReviewRecord` or the lower-level record
contract when current/proposed semantics do not fit.

To emit an empirically-calibrated conclusion probability on affirmed claims, pass
the opt-in `calibration` option (added in 1.10.0). It sets
`conclusionConfidence.value` from the affirmation rate of each extractor's proposals
— the produce side of the confidence loop. It is backward-compatible: omit it and
`value` stays unset, exactly as before.

```ts
// Recommended: pass a curve derived over a longer history than this batch.
const history = deriveCalibration({
  reviewOutcomes,   // prior review outcomes, candidate sets, and extractions
  candidateSets,    // from more than the current batch
  extractions,
});
buildSurveyTrustBundle(surveyInput, { calibration: { metrics: history, minSamples: 20 } });
```

Calibration is advisory only — it enriches `conclusionConfidence`, never a claim's
`status`. See [record-contracts.md](record-contracts.md#confidence-calibration) for
`deriveCalibration`, the advisory `suggestedThreshold` for auto-accept policies, and
the honest limits. A runnable end-to-end walkthrough — history → grounded threshold
→ produced value — is in
[`examples/calibrated-auto-accept.ts`](https://github.com/kontourai/survey/blob/main/examples/calibrated-auto-accept.ts).

## Boundary Checklist

Use this checklist before adding Survey to a producer:

- Product queue state stays product-owned.
- Product auth, tenancy, and reviewer assignment stay product-owned.
- Parser and source ranking policy stay product-owned.
- `ReviewItem` values stay typed; do not pre-stringify values for display.
- `sourceRef`, locator, excerpt, confidence, extractor, and timestamps are
  carried explicitly.
- Source-authority posture is source posture, not Surface `authorityTrace`.
- Verified claims include review actor and review time.
- Missing source context produces a warning or gap; do not invent evidence.
- Product apply code consumes selected candidates or `ReviewWorkbenchResult`
  instead of re-deriving review choices from UI state.
- Product write routes derive results server-side from pre-decision review snapshots plus
  events; they do not trust browser-computed `ReviewDecision` or
  `sessionExport.results` payloads.
- Product write routes stamp mutating actor and time from authenticated server
  context.
- Surface projection uses `buildSurveyTrustBundle`, not private review UI state.
