# Kontour Survey

Survey is the producer-side contract for turning producer observations into
Surface-ready `TrustInput`.

This repo is intentionally small right now. It is a proof package, not an
ingestion platform:

- producers own acquisition, parsing, ranking, review UX, and vertical policy;
- Survey owns source, extraction, candidate, and review record shapes;
- `buildSurveyTrustInput` projects those records into `@kontourai/surface`
  `TrustInput`;
- Surface owns Claim, Subject, Claim Type, Evidence, Status, Claim Dependency,
  TrustInput, trust reporting, and public reporting surfaces.

The first success criterion is that generic corrected-document and public-field
fixtures can pass through Survey and produce valid Surface reports without
Survey absorbing vertical policy.

## Quickstart

```ts
import { buildTrustReport, validateTrustInput } from "@kontourai/surface";
import { buildSurveyTrustInput, SurveyInputBuilder } from "@kontourai/survey";

const surveyInput = new SurveyInputBuilder({
  source: "example-producer:run-1",
})
  .addObservation({
    id: "listing-123.availability.current",
    rawSource: {
      kind: "web-page",
      sourceRef: "https://example.test/listings/123",
      observedAt: new Date().toISOString(),
      locatorScheme: "html",
    },
    extraction: {
      target: "availabilityStatus",
      value: "AVAILABLE",
      confidence: 0.92,
      locator: "html:field=availabilityStatus",
      excerpt: "Availability is open.",
      extractor: "example-crawler",
      extractedAt: new Date().toISOString(),
    },
    reviewOutcome: {
      status: "verified",
      actor: "example-operator",
      reviewedAt: new Date().toISOString(),
    },
    claim: {
      subjectType: "public-record.entity",
      subjectId: "listing-123",
      surface: "public-record.profile",
      claimType: "public-data.field",
      fieldOrBehavior: "availabilityStatus",
      impactLevel: "medium",
      collectedBy: "example-crawler",
    },
  })
  .build();

const trustInput = validateTrustInput(buildSurveyTrustInput(surveyInput));
const report = buildTrustReport(trustInput);
```

## Review Workbench Embed

Survey also exposes a framework-neutral review workbench for downstream
products that already produce `ReviewItem` queues.

```ts
import {
  mountReviewWorkbench,
  type ReviewPresentationAdapter,
} from "@kontourai/survey/review-workbench";
import "@kontourai/survey/review-workbench.css";

const presentationAdapter = {
  labelForTarget: (target) => target === "registrationStatus"
    ? "Registration status"
    : undefined,
  linkForReviewItem: (item) => ({ href: `/review/${item.metadata.name}` }),
} satisfies ReviewPresentationAdapter;

mountReviewWorkbench(element, reviewQueueSession, { presentationAdapter });
```

The default stylesheet is scoped to `.survey-workbench-embed` and bundles the
Console Kit tokens it needs, so importing it should not rewrite the host
application's `body` or `:root` styles. Hosts should mount into an element like:

```html
<div class="survey-workbench-embed theme-survey"></div>
```

The package also exposes `@kontourai/survey/review-workbench/standalone.css` for
the standalone demo page. Use that only when Survey owns the whole page.

For the full consumer path from `ReviewItem` construction through persisted
review events, exported results, and optional Surface projection, see
[`docs/consumer-integration-guide.md`](docs/consumer-integration-guide.md).
That guide also covers the server-side apply boundary: producers should derive
write results from pre-decision review snapshots plus persisted events, not from
browser-computed decisions or exported result payloads.
Use `persistReviewSessionEvents` when server code needs to save review events,
then pass the persisted event set to `deriveReviewSessionApplyResultForSnapshot`
before applying product policy. Survey derives selected review results and
structured replay/completion issues; the producer still owns current-record
validation and writes.
For browser-backed queues, server code can import
`@kontourai/survey/review-workbench/server-review-session` and use
`createServerReviewSessionRecord`, `hashReviewSessionSnapshot`,
`assertServerReviewSessionFreshness`, and `assertServerReviewSessionEvents` to
keep the review snapshot server-owned while accepting browser-submitted
`ReviewSessionEvent` resources. `deriveServerReviewSessionApplyResult` composes
those checks with Survey's apply-result derivation for server-side write paths.
For generic, test-covered consumer examples, see
[`examples/review-workbench/facility-credential-consumer.ts`](examples/review-workbench/facility-credential-consumer.ts)
for presentation and event persistence, and
[`examples/review-workbench/server-apply-consumer.ts`](examples/review-workbench/server-apply-consumer.ts)
for a compact server-side apply boundary.
For the current decision on why Survey is not adding a generic review adapter
builder yet, see
[`docs/consumer-adapter-abstraction-assessment.md`](docs/consumer-adapter-abstraction-assessment.md).

## Contributor checks

Install the repo-owned Git hooks once per clone:

```bash
npm run setup:repo-hooks
```

The setup command is idempotent. It sets this repo's local `core.hooksPath` to
`.githooks` and does not require global Git configuration.

Use the same checks directly when you want to validate hook drift or package
health before pushing:

```bash
npm run validate:repo-hooks
npm run verify
```

The committed pre-push hook runs both commands from the repo root.

## Producer validation path

Survey producers validate through public `@kontourai/survey` and
`@kontourai/surface` contracts:

1. Build Survey observations with source, extraction, candidate, review, and
   claim records.
2. Call `buildSurveyTrustInput` to project the Survey records into Surface
   `TrustInput`.
3. Call Surface `validateTrustInput` on the projected input.
4. Optionally call public Surface report APIs such as `buildTrustReport` to
   inspect claims, evidence, status, gaps, and metadata.

Keep producer operational state outside Survey. Queue status, reviewer form
state, retries, source caches, and product policy decisions belong in the
producer's own data model. Survey carries only the portable source,
extraction, candidate, review, and claim projection records needed by Surface.

## Raw sources

Use raw-source helpers when a producer wants Survey to shape source identity
before building observations. The helpers do not fetch, crawl, parse, or judge
the source; they only produce stable `RawSource` records with explicit source
references, observed times, locator schemes, checksums, and producer metadata.

```ts
import {
  apiRecordSource,
  fieldObservation,
  SurveyInputBuilder,
} from "@kontourai/survey";

const rawSource = apiRecordSource({
  sourceRef: "example-records://entity/entity-123",
  observedAt: new Date().toISOString(),
  checksum: "abc123",
  metadata: {
    provider: "example-records",
  },
});

const surveyInput = new SurveyInputBuilder({ source: "example-producer:run-1" })
  .addObservation(fieldObservation({
    id: "entity-123.status.current",
    field: "registrationStatus",
    value: "ACTIVE",
    rawSource,
    extraction: {
      confidence: 0.97,
      locator: "json:$.registrationStatus",
      extractor: "example-extractor",
      extractedAt: new Date().toISOString(),
    },
    claim: {
      subjectType: "public-record.entity",
      subjectId: "entity-123",
      surface: "example.profile",
      claimType: "public-data.field",
      status: "proposed",
      impactLevel: "medium",
      collectedBy: "example-extractor",
    },
  }))
  .build();
```

Survey exports `uploadedDocumentSource`, `apiRecordSource`, `webPageSource`,
`manualEntrySource`, and `policyStandardSource`. Producer-provided `id` values
are preserved; otherwise Survey derives a stable id from source kind and
`sourceRef`. Bare checksum values are normalized to `sha256:<value>`, while
already-prefixed checksum values are preserved. Producer metadata is copied
through to Surface evidence.

Use `policyStandardSource` when the observed material is the applied standard
itself. It records `inlineText`, `standardVersion`, and optional `paragraphRef`
on the `RawSource` and projects to Surface `policy_rule` evidence by default.
Survey only preserves the producer-applied standard text/version; it does not
decide whether that standard is correct for the producer's domain.

## Interpretation records

Use `addInterpretation` when a producer records how an actor read a
`policy-standard` paragraph for one claim. Interpretations are flat provenance
records with an `appliesTo` edge to a claim and an `anchorsTo` edge to a
policy-standard raw source; they are not nested claim derivations or rejection
reasons.

```ts
import {
  apiRecordSource,
  buildSurveyTrustInput,
  fieldObservation,
  policyStandardSource,
  SurveyInputBuilder,
} from "@kontourai/survey";

const observedAt = new Date().toISOString();
const standard = policyStandardSource({
  id: "source.example.policy-standard.rule-1",
  sourceRef: "policy-standard://example/rules/2026#rule-1",
  observedAt,
  inlineText: "A producer reading must cite the applied rule paragraph.",
  standardVersion: "2026.1",
  paragraphRef: "rule-1",
});

const surveyInput = new SurveyInputBuilder({ source: "example-producer:run-1" })
  .addRawSource(standard)
  .addObservation(fieldObservation({
    id: "observation.example.policy-application",
    field: "policyApplication.status",
    value: "DOCUMENTED",
    rawSource: apiRecordSource({
      id: "source.example.application-record",
      sourceRef: "example-records://application/application-1",
      observedAt,
      checksum: "application-1",
    }),
    extraction: {
      target: "policyApplication.status",
      locator: "json:$.policyApplication.status",
      extractor: "example-extractor",
      extractedAt: observedAt,
    },
    claim: {
      id: "claim.example.policy-application",
      subjectType: "example.application",
      subjectId: "application-1",
      surface: "example.review",
      claimType: "policy-application.status",
      impactLevel: "medium",
      collectedBy: "example-extractor",
    },
  }))
  .addInterpretation({
    id: "interpretation.example.rule-1",
    appliesToClaimId: "claim.example.policy-application",
    anchorsToSourceId: standard.id,
    ruleLocator: "text:paragraph=rule-1",
    reading: "The producer read rule 1 as applying to the claim.",
    actor: "producer-operator",
    recordedAt: observedAt,
  })
  .build();

const trustInput = buildSurveyTrustInput(surveyInput);
```

Projection emits a normal Surface verification event with
`method: "survey-interpretation"`, the existing `claimId`, and anchor
`evidenceIds`. Because current Surface verification events reject unsupported
keys, typed edge details are preserved on the projected claim at
`metadata.survey.interpretations[]`. The anchor evidence uses
`evidenceType: "policy_rule"`, `method: "anchoring"`, the interpretation
`ruleLocator` as `sourceLocator`, and the policy-standard text/version metadata.

## Review resources

Survey also exports producer-neutral `ReviewItem`, `ReviewCandidate`, and
`ReviewDecision` TypeScript resource shapes for review UI and adapter fixtures.
They use `apiVersion`, `kind`, `metadata`, `spec`, and `status` fields while
mapping back to the existing Survey record layer. See
[`docs/review-resource-contract.md`](docs/review-resource-contract.md) for
field ownership, mapping hints, and the `ReviewSession` non-goal.

## Field observations

Use `fieldObservation` when a producer wants to describe one scalar field value
without hand-assembling the repeated source, extraction, candidate, review, and
claim defaults. The helper returns a normal `SurveyObservationInput`, so it
works with `SurveyInputBuilder.addObservation` and the same Surface projection
path.

```ts
import {
  buildSurveyTrustInput,
  fieldObservation,
  SurveyInputBuilder,
} from "@kontourai/survey";

const surveyInput = new SurveyInputBuilder({
  source: "example-producer:run-1",
})
  .addObservation(fieldObservation({
    id: "entity-123.status.current",
    field: "registrationStatus",
    value: "ACTIVE",
    rawSource: {
      kind: "api-record",
      sourceRef: "example-records://entity/entity-123",
      observedAt: new Date().toISOString(),
      locatorScheme: "structured-field",
    },
    extraction: {
      confidence: 0.97,
      locator: "json:$.registrationStatus",
      extractor: "example-extractor",
      extractedAt: new Date().toISOString(),
    },
    reviewOutcome: {
      status: "verified",
      actor: "records-operator",
      reviewedAt: new Date().toISOString(),
    },
    claim: {
      subjectType: "public-record.entity",
      subjectId: "entity-123",
      surface: "example.profile",
      claimType: "public-data.field",
      status: "verified",
      impactLevel: "medium",
      collectedBy: "example-extractor",
    },
    metadata: {
      producerField: "registration_status",
    },
  }))
  .build();

const trustInput = buildSurveyTrustInput(surveyInput);
```

`fieldObservation` sets `extraction.target` and `claim.fieldOrBehavior` from
`field` when omitted, uses the scalar as both the extraction and claim value,
and adds neutral helper metadata at
`metadata.survey.field = { representation: "scalar" }`. Producer metadata is
preserved. Producers still own scalar semantics, validation, candidate ranking,
review policy, and whether a value should be verified, proposed, rejected, or
assumed.

## Source-of-authority observations

Use `sourceOfAuthorityObservationBuilder` when a producer treats the raw source
as authoritative for the extracted target: an official publication,
registration platform page, policy document, contract record, or
system-of-record response. The builder does not decide whether the source is
truly authoritative. It guides producers through the source, extraction,
source-authority posture, review outcome, and claim fields that make the
declared source posture auditable.

Verified or assumed source-of-authority observations require:

- source reference
- source locator
- source-authority class
- source-authority scope
- review actor
- reviewed time

Source-authority metadata projects through Surface Evidence metadata under
`sourceAuthority`. It does not project to Surface `authorityTrace`, which is
reserved for actor, credential, role, organization, policy, or system authority.

```ts
import {
  buildSurveyTrustInput,
  sourceOfAuthorityObservationBuilder,
  SurveyInputBuilder,
  uploadedDocumentSource,
} from "@kontourai/survey";

const observedAt = new Date().toISOString();
const rawSource = uploadedDocumentSource({
  sourceRef: "https://rules.example.test/thresholds.pdf",
  observedAt,
  checksum: "abc123",
  locatorScheme: "pdf",
});

const surveyInput = new SurveyInputBuilder({
  source: "rule-producer:run-1",
})
  .addObservation(sourceOfAuthorityObservationBuilder({
    id: "rule.threshold.primary.2026",
    field: "regulatedRule.threshold.primary.2026",
    value: 1200,
  })
    .withSourceAuthority({
      authorityClass: "official_publication",
      scope: {
        jurisdiction: "example",
        productArea: "regulated-rule",
        effectiveYear: 2026,
      },
      sourceVersion: "2026",
      declaredBy: "rule-producer",
    })
    .fromSource(rawSource)
    .withExtraction({
      confidence: 0.94,
      locator: "pdf:page=12;table=thresholds;row=primary",
      extractor: "rule-producer",
      extractedAt: observedAt,
    })
    .withReviewOutcome({
      status: "verified",
      actor: "rule-reviewer",
      reviewedAt: new Date().toISOString(),
    })
    .forClaim({
      subjectType: "regulated-rule",
      subjectId: "example:threshold:primary:2026",
      surface: "regulated.rules",
      claimType: "regulated.rule-value",
      status: "verified",
      impactLevel: "high",
      evidenceType: "policy_rule",
      evidenceMethod: "extraction",
      collectedBy: "rule-producer",
    })
    .build())
  .build();

const trustInput = buildSurveyTrustInput(surveyInput);
```

`sourceOfAuthorityObservation` remains available as the lower-level object
factory when a producer already has the full observation input assembled.

Contextual claims such as "this submission is compliant" or "this record is
eligible for a specific requester" are not source-of-authority observations.
They are Surface claims with Claim Dependencies on source-of-authority claims
and other producer facts. The producer owns that domain logic.

For the reusable producer workflow, including manual confirmation state,
source references, Survey review outcomes, and Surface report boundaries, see
[Source-Authority Review Pattern](docs/source-authority-review-pattern.md).

## Reviewed candidate resolutions

Use `reviewedCandidateResolution` when a producer has multiple candidate
observations for the same target and a review outcome selects one candidate.
The helper wraps `candidateReviewRecord`, attaches the review outcome to the
selected candidate, defaults the candidate set to `resolved`, defaults the
selected claim status from the review outcome, and defaults unselected
candidates to `superseded`. Producers can override selected or unselected claim
statuses when their domain workflow needs a different posture.

This is useful for corrected documents, source-of-truth choices, and review
queues where losing candidates should remain visible for transparency rather
than disappearing from the trust trail.

Candidates may include an optional `rejectionReason` when a producer wants to
record why a non-selected alternative was superseded or rejected. Survey
preserves that producer-provided rationale on the candidate and projects it to
Surface claim `metadata.survey.candidate.rejectionReason` for that candidate
while preserving producer-provided `metadata.survey` keys. Survey does not rank
candidates, choose winners, or define rejection policy.

## Reviewed current/proposed resolutions

Use `reviewedCurrentProposedResolution` when a producer has exactly two
candidate roles for the same target: the current value the producer would keep
absent a change, and a proposed value introduced by new source material,
extraction, or review work. The helper consumes full observations, selects
either the current or proposed candidate through `selectedCandidateRole`, and
wraps the result with `reviewedCandidateResolution`.

The helper may promote the selected candidate to a caller-supplied
`selectedClaimId`. The unselected observation keeps its caller-authored claim
id, so producers can keep losing candidates as candidate-specific history.
Survey does not decide producer policy: callers still own review status,
selected and unselected claim statuses, source details, claim vocabulary, and
domain metadata.

## Repeated observations

Use `repeatedObservation` when a producer wants to describe a repeated field or
entity list as one aggregate observation. The helper returns a normal
`SurveyObservationInput`, so it works with `SurveyInputBuilder.addObservation`
and the same Surface projection path.

```ts
import {
  buildSurveyTrustInput,
  repeatedObservation,
  SurveyInputBuilder,
} from "@kontourai/survey";

const aliases = [
  { name: "North Annex", sourceLabel: "record row 1" },
  { name: "East Annex", sourceLabel: "record row 2" },
];

const surveyInput = new SurveyInputBuilder({
  source: "example-producer:run-1",
})
  .addObservation(repeatedObservation({
    id: "entity-123.aliases.current",
    field: "knownAliases",
    value: aliases,
    rawSource: {
      kind: "api-record",
      sourceRef: "example-records://entity/entity-123",
      observedAt: new Date().toISOString(),
      locatorScheme: "structured-field",
    },
    extraction: {
      confidence: 0.88,
      locator: "json:$.aliases",
      extractor: "example-extractor",
      extractedAt: new Date().toISOString(),
    },
    reviewOutcome: {
      status: "verified",
      actor: "records-operator",
      reviewedAt: new Date().toISOString(),
    },
    claim: {
      subjectType: "public-record.entity",
      subjectId: "entity-123",
      surface: "example.profile",
      claimType: "public-data.repeated-field",
      status: "verified",
      impactLevel: "medium",
      collectedBy: "example-extractor",
    },
    metadata: {
      producerField: "aliases",
    },
  }))
  .build();

const trustInput = buildSurveyTrustInput(surveyInput);
```

`repeatedObservation` sets `extraction.target` and
`claim.fieldOrBehavior` from `field` when omitted, uses the array as both the
extraction and claim value, and adds neutral helper metadata at
`metadata.survey.repeated = { representation: "aggregate-array", itemCount }`.
Producer metadata is preserved. Producers still own item semantics,
validation, candidate ranking, review policy, and whether a value should be
verified, proposed, rejected, or assumed.

## Candidate review records

Use `candidateReviewRecord` when a producer has multiple candidate observations
for the same target and wants Survey to assemble the shared candidate set,
candidate links, and optional review outcome.

```ts
import {
  candidateReviewRecord,
  fieldObservation,
  SurveyInputBuilder,
} from "@kontourai/survey";

const observations = [
  fieldObservation({
    id: "entity-123.status.registry",
    field: "registrationStatus",
    value: "ACTIVE",
    rawSource: {
      kind: "api-record",
      sourceRef: "example-records://entity/entity-123",
      observedAt: new Date().toISOString(),
      locatorScheme: "structured-field",
    },
    extraction: {
      confidence: 0.97,
      locator: "json:$.registrationStatus",
      extractor: "example-extractor",
      extractedAt: new Date().toISOString(),
    },
    candidate: { id: "candidate.registry", confidence: 0.97 },
    claim: {
      id: "claim.entity-123.status.registry",
      subjectType: "public-record.entity",
      subjectId: "entity-123",
      surface: "example.profile",
      claimType: "public-data.field",
      status: "verified",
      impactLevel: "medium",
      collectedBy: "example-extractor",
    },
  }),
  fieldObservation({
    id: "entity-123.status.archive",
    field: "registrationStatus",
    value: "INACTIVE",
    rawSource: {
      kind: "web-page",
      sourceRef: "https://records.example.test/entity-123",
      observedAt: new Date().toISOString(),
      locatorScheme: "html",
    },
    extraction: {
      confidence: 0.71,
      locator: "css:#registration-status",
      extractor: "example-crawler",
      extractedAt: new Date().toISOString(),
    },
    candidate: { id: "candidate.archive", confidence: 0.71 },
    claim: {
      id: "claim.entity-123.status.archive",
      subjectType: "public-record.entity",
      subjectId: "entity-123",
      surface: "example.profile",
      claimType: "public-data.field",
      status: "superseded",
      impactLevel: "medium",
      collectedBy: "example-crawler",
    },
  }),
];

const surveyInput = new SurveyInputBuilder({ source: "example-producer:run-1" })
  .addClaimRecords(candidateReviewRecord({
    id: "candidate-set.entity-123.registration-status",
    target: "registrationStatus",
    selectedCandidateId: "candidate.registry",
    status: "resolved",
    rationale: "Registry source wins over archive source.",
    reviewOutcome: {
      status: "verified",
      actor: "records-operator",
      reviewedAt: new Date().toISOString(),
    },
    observations,
  }))
  .build();
```

`candidateReviewRecord` does not choose the winning candidate or status. The
producer still supplies candidate ids, selected candidate id, claim ids, review
status, rationale, and all domain policy. Survey only assembles the generic
record graph and tolerates repeated references to identical raw sources or the
shared candidate set while rejecting conflicting duplicate ids. Duplicate
conflict checks assume Survey records are JSON-shaped data, which is the same
shape expected by Surface validation and reports.

If an observation candidate includes `rejectionReason`, `candidateReviewRecord`
preserves it in the shared candidate set. Use this only for producer-authored
rationale about a candidate that the producer already treats as non-selected,
superseded, or rejected; it does not affect selected candidate behavior or
status projection.

A candidate set with status `"conflict"` represents a Survey-side Candidate
Conflict before review has resolved which candidate should win. When no review
outcome overrides it, `buildSurveyTrustInput` projects the claim to Surface
status `"disputed"` and records a `"candidate-conflict"` verification event.

## Review proofs

Use review proof helpers when a producer wants a Surface-compatible integrity
anchor for one reviewed Survey source -> extraction -> candidate -> review ->
claim path.

```ts
import {
  buildCanonicalReviewProofPayload,
  buildReviewProofAnchor,
  canonicalReviewProofJson,
  hashCanonicalReviewProofPayload,
} from "@kontourai/survey";

const proofInput = {
  rawSource,
  extraction,
  candidate,
  candidateSet,
  reviewOutcome,
  claim,
};

const payload = buildCanonicalReviewProofPayload(proofInput);
const canonicalJson = canonicalReviewProofJson(payload);
const hash = hashCanonicalReviewProofPayload(payload);
const anchor = buildReviewProofAnchor(proofInput);
```

`buildReviewProofAnchor` returns a hash-only Surface `IntegrityAnchor` for the
canonical payload. The lower-level payload, JSON, and hash helpers are exported
so producers can store or recompute the exact canonical proof material used for
the anchor. Producer metadata is not part of the canonical payload; any
non-portable context belongs outside the hash, such as anchor metadata.

The canonical payload is the portable review proof contract. It contains:

| Field | Purpose |
| --- | --- |
| `schemaVersion` / `proof.schema` / `proof.schemaVersion` | Stable Survey review proof schema identity. |
| `proof.packageName` / `proof.packageVersion` | Review proof contract identity. `proof.packageVersion` is the proof contract version, not the npm package release version. Package releases do not change canonical proof hashes unless this explicit proof contract version or another canonical field changes. |
| `proof.issuer` | Survey producer identity, derived from the claim collector. |
| `proof.producer` | Extraction producer identity, derived from the extractor id. |
| `proof.issuedAt` | Proof envelope time, derived from review time, then claim update time, then extraction time. |
| `proof.subject` | Claim identity: claim id, candidate set id, reviewed candidate id, subject, surface, claim type, and field/behavior. If the claim also names a candidate id, it must match the reviewed candidate id. |
| `proof.sourcePayload` / `rawSource.checksum` | Source payload identity, ref, and producer-supplied checksum when present. |
| `extraction` | Extracted target, value, locator, excerpt, extractor, confidence, and extraction time. |
| `candidate` / `candidateSet` | Candidate identity/value plus the ordered candidate set, selected candidate, status, and rationale. |
| `reviewOutcome` | Review decision/status, actor, review time, rationale, and evidence ids. |
| `claim` | Projected claim identity, status/value, impact, evidence method, derivation links, collector, actor, and event method. |

To recompute the anchor value, rebuild the same canonical payload from the
reviewed Survey records, call `canonicalReviewProofJson(payload)`, and compute
SHA-256 over that JSON. The result should equal
`claim.currentIntegrityAnchor.value`. The Surface anchor remains generic:
`kind: "hash"`, `algorithm: "sha256"`, `verificationStatus: "unverified"`, no
Survey-specific anchor metadata, and a source/time pointer for display. Claims
without a selected review outcome are not anchored by `{ reviewProofs: true }`.

When the Surface projection proof option is enabled, `buildSurveyTrustInput`
will attach the same kind of anchor to the projected reviewed claim:

```ts
const trustInput = buildSurveyTrustInput(surveyInput, { reviewProofs: true });
```

The proof provides hash-only tamper evidence for the Survey review/provenance
trail in the canonical payload. It does not authenticate an actor, sign the
payload, or prove the real-world truth of the claim. Non-goals include JWT/JWS
signing, key management, a transparency log, and any veracity guarantee.

JWT-adjacent words in the payload are process-envelope vocabulary, not a v0 JWT
implementation. `issuer` identifies the Survey producer for recomputation,
`subject` identifies the claim being reviewed, and `issuedAt` records the review
proof time. Audience restrictions, expiry, cryptographic signing, key discovery,
and legal non-repudiation are deferred concepts for a future signed envelope.

## Computed values

Computed values are normal `ClaimTarget` entries in `claims`. Producers should
link them to their inputs with Surface Claim Dependency fields:
`derivedFrom` for simple claim-id links, or `derivationEdges` when the link
needs method, role, support-strength, rationale, or metadata.

Survey passes those fields through to Surface while keeping the same
source -> extraction -> candidate -> review -> claim projection path. Surface
owns dependency semantics such as recompute pressure and status ceilings.

## Adversarial passes

Producers that run a second adversarial pass — whether an LLM judge, a rules
engine, or a second human reviewer — emit their output into Survey as a normal
producer pass with a distinct `extractor` id. Survey does not know or care that
a second pass ran; it sees two producers disagreeing on the same target, which
is exactly what `conflict` and escalation records are for.

Two patterns cover the adversary's output:

**Conflicting candidate.** The adversary disagrees with the first-pass extraction
value. Add the adversary's extraction as a second candidate to the same candidate
set using `candidateReviewRecord` with `status: "conflict"`. Survey projects the
conflict to a `disputed` claim in Surface.

```ts
import { candidateReviewRecord, fieldObservation, SurveyInputBuilder } from "@kontourai/survey";

const records = candidateReviewRecord({
  id: "candidate-set.entity-1.registration-status",
  target: "registrationStatus",
  status: "conflict",
  rationale: "First pass and adversary disagree; human review required.",
  observations: [
    fieldObservation({
      id: "observation.entity-1.status.first-pass",
      field: "registrationStatus",
      value: "ACTIVE",
      rawSource: {
        kind: "api-record",
        sourceRef: "records://entity-1/registry",
        observedAt: new Date().toISOString(),
        locatorScheme: "structured-field",
      },
      extraction: {
        confidence: 0.91,
        locator: "json:$.registrationStatus",
        extractor: "agent-v1",
        extractedAt: new Date().toISOString(),
      },
      candidate: { id: "candidate.first-pass", confidence: 0.91 },
      claim: {
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        impactLevel: "high",
        collectedBy: "agent-v1",
      },
    }),
    fieldObservation({
      id: "observation.entity-1.status.adversary",
      field: "registrationStatus",
      value: "INACTIVE",
      rawSource: {
        kind: "api-record",
        sourceRef: "records://entity-1/registry",
        observedAt: new Date().toISOString(),
        locatorScheme: "structured-field",
      },
      extraction: {
        confidence: 0.84,
        locator: "json:$.registrationStatus",
        extractor: "adversary-v1",
        extractedAt: new Date().toISOString(),
      },
      candidate: { id: "candidate.adversary", confidence: 0.84 },
      claim: {
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        impactLevel: "high",
        collectedBy: "adversary-v1",
      },
    }),
  ],
});
```

**Framing challenge.** The adversary identifies a target that was not addressed
at all — a missed standard, an unconsidered alternative, or a misframed question.
Use `addEscalation` to record the challenge. Attach it to the closest relevant
claim with `attachToClaimId`; Survey projects it as an additional `disputed`
verification event on that claim so the reviewer sees it prominently.

```ts
import { SurveyInputBuilder, fieldObservation } from "@kontourai/survey";

const builder = new SurveyInputBuilder({ source: "example-producer:run-2" });

// First-pass observation
builder.addObservation(fieldObservation({ /* ... */ }));

// Adversary raises a framing challenge
builder.addEscalation({
  id: "escalation.entity-1.fair-value.completeness",
  target: "fairValue",
  dimension: "completeness",
  reason: "Measurement standard Level 3 inputs were not documented; sensitivity range and unobservable input assumptions are missing.",
  raisedBy: "adversary-v1",
  raisedAt: new Date().toISOString(),
  attachToClaimId: "claim.entity-1.fair-value",
});
```

If a subsequent first-pass or human-review pass resolves the challenge, set
`resolvedBy` to the id of the observation that closes it. Survey will not project
a `disputed` event for resolved escalations.

Escalation dimensions follow the adversary's attack surface: `framing` (wrong
question framed), `completeness` (missing standards, alternatives, or evidence),
`conclusion` (reasoning would not survive challenge), and `citation` (cited
sources do not support the claims attached to them).

Framing challenges without an `attachToClaimId` are carried in `SurveyInput`
for producer tooling but are not projected to Surface. If the adversary cannot
identify a target claim to attach a framing challenge to, emit a candidate set
with `status: "escalated"` for the affected target — that projects to `disputed`
in Surface with a `candidate-escalation` event.

## Comfort zone flags

Use `withinComfortZone: false` on a `ReviewOutcome` when the reviewer is
recording a decision outside their domain expertise or is flagging that the
conclusion requires a different authority to confirm. The flag and optional
`comfortZoneNote` are carried forward as structured Survey metadata on the
projected Surface claim at `metadata.survey.comfortZone`. Verification event
`notes` carry the normal review or candidate-set rationale only.

```ts
reviewOutcome: {
  status: "assumed",
  actor: "records-operator",
  reviewedAt: new Date().toISOString(),
  rationale: "Assumed from registry source pending specialist review.",
  withinComfortZone: false,
  comfortZoneNote: "Renewal clause interpretation requires specialist counsel.",
},
```

## Learning projections

Use `buildSurveyLearningProjections(input)` when producer or review tooling needs
workflow/evaluation signals without changing Surface `TrustInput`.

```ts
import {
  buildSurveyLearningProjections,
  buildSurveyTrustInput,
} from "@kontourai/survey";

const learning = buildSurveyLearningProjections(surveyInput);
const trustInput = buildSurveyTrustInput(surveyInput);
```

Learning projections are product-neutral `learning.*` records. Survey emits
`learning.rejected-candidate` from structured candidate rejection data such as
non-empty `Candidate.rejectionReason` values or a candidate-specific
`ReviewOutcome.status === "rejected"` outcome with rationale. When both exist,
Survey emits one rejected-candidate projection enriched with candidate and
review outcome context.
Ordinary rejected candidates do not emit `learning.comfort-zone`.

Survey also emits `learning.comfort-zone` from structured
`ReviewOutcome.withinComfortZone === false` data and `learning.escalation` from
unresolved `EscalationRecord`s, including unattached records that producer
tooling can route but Surface cannot attach to a claim event.

These projections are producer/review workflow and evaluation signals. They are
not claims about truth or veracity, not Surface claim status, not evidence, and
not verification events. Calling `buildSurveyLearningProjections` does not alter
`buildSurveyTrustInput`, trust status derivation, or escalation event projection.

## Product Boundary

Survey does not crawl pages, parse PDFs, rank candidates, decide review policy,
or claim a value is true. Producers own acquisition, extraction, ranking, review
UX, materiality, and domain policy. Survey gives those producers a consistent
source -> extraction -> candidate -> review -> claim contract before the records
enter Surface.

## Commands

```sh
npm install
npm run verify
```
