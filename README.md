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
  TrustInput, trust reporting, console projections, and downstream transparency.

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
and `manualEntrySource`. Producer-provided `id` values are preserved; otherwise
Survey derives a stable id from source kind and `sourceRef`. Bare checksum
values are normalized to `sha256:<value>`, while already-prefixed checksum
values are preserved. Producer metadata is copied through to Surface evidence.

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

Use `sourceOfAuthorityObservation` when a producer treats the raw source as
authoritative for the extracted target: an official publication, registration
platform page, policy document, contract record, or system-of-record response.
The helper does not decide whether the source is truly authoritative. It
enforces record discipline around the producer's declared source posture.

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
  sourceOfAuthorityObservation,
  SurveyInputBuilder,
  uploadedDocumentSource,
} from "@kontourai/survey";

const observedAt = new Date().toISOString();
const rawSource = uploadedDocumentSource({
  sourceRef: "https://rules.example.test/standard-deduction.pdf",
  observedAt,
  checksum: "abc123",
  locatorScheme: "pdf",
});

const surveyInput = new SurveyInputBuilder({
  source: "rule-producer:run-1",
})
  .addObservation(sourceOfAuthorityObservation({
    id: "rule.standard-deduction.mfj.2026",
    field: "federal.standardDeduction.mfj.2026",
    value: 30000,
    sourceAuthority: {
      authorityClass: "official_publication",
      scope: {
        jurisdiction: "federal",
        productArea: "regulated-rule",
        taxYear: 2026,
      },
      sourceVersion: "2026",
      declaredBy: "rule-producer",
    },
    rawSource,
    extraction: {
      confidence: 0.94,
      locator: "pdf:page=12;table=standard-deduction;row=mfj",
      extractor: "rule-producer",
      extractedAt: observedAt,
    },
    reviewOutcome: {
      status: "verified",
      actor: "rule-reviewer",
      reviewedAt: new Date().toISOString(),
    },
    claim: {
      subjectType: "regulated-rule",
      subjectId: "federal:standard-deduction:mfj:2026",
      surface: "regulated.rules",
      claimType: "regulated.rule-value",
      status: "verified",
      impactLevel: "high",
      evidenceType: "policy_rule",
      evidenceMethod: "extraction",
      collectedBy: "rule-producer",
    },
  }))
  .build();

const trustInput = buildSurveyTrustInput(surveyInput);
```

Contextual claims such as "this return position is compliant" or "this camp is
eligible for an 8-year-old in June" are not source-of-authority observations.
They are Surface claims with Claim Dependencies on source-of-authority claims
and other product facts. The vertical product owns that domain logic.

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

When the Surface projection proof option is enabled, `buildSurveyTrustInput`
will attach the same kind of anchor to the projected reviewed claim:

```ts
const trustInput = buildSurveyTrustInput(surveyInput, { reviewProofs: true });
```

The proof provides hash-only tamper evidence for the Survey review/provenance
trail in the canonical payload. It does not authenticate an actor, sign the
payload, or prove the real-world truth of the claim. Non-goals include JWT/JWS
signing, key management, a transparency log, and any veracity guarantee.

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
`comfortZoneNote` are carried forward to the Surface verification event `notes`
so the reviewer chain sees the signal without having to read into the rationale.

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
