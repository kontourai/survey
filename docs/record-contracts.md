# Record Contracts

Survey's job is a consistent `source -> extraction -> candidate -> review -> claim` chain. This reference covers every record shape in that chain — what each one means, what it requires, and how it projects into Surface. The [consumer integration guide](consumer-integration-guide.md) covers the end-to-end consumer path; this page is the contract-by-contract reference.

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
  buildSurveyTrustBundle,
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

const trustBundle = buildSurveyTrustBundle(surveyInput);
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
`ReviewDecision` TypeScript resource shapes for review UI and adapter examples.
They use `apiVersion`, `kind`, `metadata`, `spec`, and `status` fields while
mapping back to the existing Survey record layer. See
[`docs/review-resource-contract.md`](review-resource-contract.md) for
field ownership, mapping hints, and the `ReviewSession` non-goal.


## Field observations

Use `fieldObservation` when a producer wants to describe one scalar field value
without hand-assembling the repeated source, extraction, candidate, review, and
claim defaults. The helper returns a normal `SurveyObservationInput`, so it
works with `SurveyInputBuilder.addObservation` and the same Surface projection
path.

```ts
import {
  buildSurveyTrustBundle,
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

const trustBundle = buildSurveyTrustBundle(surveyInput);
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
  buildSurveyTrustBundle,
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

const trustBundle = buildSurveyTrustBundle(surveyInput);
```

`sourceOfAuthorityObservation` remains available as the lower-level object
factory when a producer already has the full observation input assembled.

Contextual claims such as "this submission is compliant" or "this record is
eligible for a specific requester" are not source-of-authority observations.
They are Surface claims with Claim Dependencies on source-of-authority claims
and other producer facts. The producer owns that domain logic.

For the reusable producer workflow, including manual confirmation state,
source references, Survey review outcomes, and Surface report boundaries, see
[Source-Authority Review Pattern](source-authority-review-pattern.md).


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
  buildSurveyTrustBundle,
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

const trustBundle = buildSurveyTrustBundle(surveyInput);
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
outcome overrides it, `buildSurveyTrustBundle` projects the claim to Surface
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

When the Surface projection proof option is enabled, `buildSurveyTrustBundle`
will attach the same kind of anchor to the projected reviewed claim:

```ts
const trustBundle = buildSurveyTrustBundle(surveyInput, { reviewProofs: true });
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


## Inquiry mappings

An **InquiryMapping** is the durable reviewed artifact that records "this
natural-language question maps to this canonical claim or derivation rule."
Mappings are memoized; answers are never cached.  Every answer recomputes from
the live TrustBundle state at resolution time (ADR 0003 §6).

A mapping proposal is a reviewable record with provenance.  The proposal goes
through Survey's existing candidate → review machinery; no mapping is accepted
silently (ADR 0003 §4).

```ts
import {
  applyAutoAcceptPolicy,
  applyMappingReview,
  lookupMapping,
  normalizeQuestion,
  proposalsToCandidateSet,
  referenceMappingProposer,
  resolveQuestion,
} from "@kontourai/survey";
import type { TrustBundle, DerivationRule } from "@kontourai/surface";

// 1. Normalise — deterministic, exact-text memoization (not semantic matching)
const normalized = normalizeQuestion("Is entity-1 ACTIVE?");
// → "is entity-1 active"

// 2. Propose — pluggable; use your own proposer in production
const proposals = referenceMappingProposer.propose(
  "is entity-1 active",
  { bundle, rules },
);

// 3. Project into Survey candidate/review machinery
const { candidateSet, candidates } = proposalsToCandidateSet(
  "is entity-1 active",
  proposals,
);
// candidateSet.status is "needs-review" when proposals agree,
// "conflict" when they disagree.

// 4a. Human review path
const reviewOutcome = {
  id: "review-1",
  candidateSetId: candidateSet.id,
  candidateId: candidates[0]!.id,
  status: "verified" as const,
  actor: "reviewer@example.test",
  reviewedAt: new Date().toISOString(),
};
const mapping = applyMappingReview(candidateSet, reviewOutcome);

// 4b. Auto-accept policy path (proposals at or above threshold → "assumed")
const autoMappings = applyAutoAcceptPolicy(proposals, { minConfidence: 0.85 });

// 5. Resolve — looks up mapping by exact normalized text; answer always live
const record = resolveQuestion(bundle, "is entity-1 active", {
  mappings: [mapping],
  rules,
  now: new Date(),
  askedBy: "consumer-actor",
});
// record.outcome: "matched" | "derived" | "unsupported"
// Rejected mappings are remembered but never resolve; lookupRejectedMapping
// checks whether a question was previously rejected.
```

Key contracts:

- `normalizeQuestion` is exact normalized-text memoization — two questions with
  different wording but the same meaning are NOT matched here; a MappingProposer
  handles that.
- Rejected mappings are remembered and prevent re-proposing without escalation.
  Call `lookupRejectedMapping` to distinguish "never seen" from "previously
  rejected."
- `resolveQuestion` never caches the answer; it always calls `resolveInquiry`
  on the live bundle.
- `proposalsToCandidateSet` uses `RawSourceKind: "inquiry-question"` and the
  normalized question as the CandidateSet target, so mapping candidates flow
  through the same workbench as all other Survey candidates.
- `buildMappingReviewItems` produces ReviewItem payloads for the existing
  workbench; no UI changes required.


## Agent-utterance producer profile

`surveyAgentUtterance` is Survey used as a producer pointed at agent-generated
text instead of structured sources.  Each statement the extractor finds in agent
prose is resolved against the TrustBundle via the Inquiry pipeline, and the
result is a per-statement badge.

This is the "spell-check for evidence" integration point.  Flow-agent hook
wiring (connecting this function to a live agent output pipeline) is out of scope
for this module and lives in the flow-agents repo.

```ts
import {
  surveyAgentUtterance,
  referenceUtteranceExtractor,
} from "@kontourai/survey";
import type { UtteranceClaimExtractor } from "@kontourai/survey";

// Use a domain-aware extractor in production; the reference extractor
// is for tests only (it sets subjectType: "unknown").
const report = await surveyAgentUtterance(
  "entity-1 registration-status is ACTIVE and coverage-score is 95",
  referenceUtteranceExtractor,
  {
    bundle,
    mappings,   // optional; enables mapping-based resolution
    rules,      // optional derivation rules
    now: new Date(),
    agentId: "agent-run-1234",
  },
);

// report.source.kind === "agent-utterance"
// report.source.locatorScheme === "text-span"
for (const stmt of report.statements) {
  console.log(stmt.badge, stmt.target, stmt.excerpt);
  // badge: "verified" | "assumed" | "stale" | "disputed" | "rejected" | "unsupported"
}
```

Key contracts:

- The `RawSource` for the utterance uses `kind: "agent-utterance"` and
  `locatorScheme: "text-span"`.  Each extracted statement carries a
  `text-span:<start>-<end>` locator on its Extraction record.
- The `UtteranceClaimExtractor` interface is pluggable.  Provide a
  domain-aware extractor that emits the correct `subjectType` for canonical
  key matching.  The reference extractor always emits `subjectType: "unknown"`
  and is only suitable for tests.
- Badges derive directly from the InquiryRecord outcome and answer status.
  `"unsupported"` means either the outcome is unsupported or the answer status
  is absent — the gap is honest and recordable rather than silently treated as
  passing.
- `surveyAgentUtterance` is `async` to support async extractors, but it works
  equally well with synchronous extractors.

---

## Schema Mapping

The schema-mapping producer profile is the **evidenced-ontology layer**: every cross-system field mapping shows its work via the standard Survey chain rather than unaudited config.  Each mapping proposal carries schema-doc excerpts, a confidence score, a rationale, and the name of the extractor that produced it.  Nothing is accepted until it flows through review.

### Core types

```ts
import type {
  MappingProposalRecord,
  ReviewedMapping,
  SchemaMappingExtractor,
  SchemaMappingOptions,
  SystemFieldRef,
} from "@kontourai/survey";
```

**`SystemFieldRef`** — a stable reference to one field within one system's schema:

| Field | Type | Description |
|-------|------|-------------|
| `system` | `string` | System identifier (e.g. `"crm"`, `"erp"`) |
| `entity` | `string` | Entity/table/resource name within that system |
| `field` | `string` | Field/column/attribute name |
| `locator?` | `string` | Structural locator within a schema document |

**`MappingProposalRecord`** — the "show your work" record for one proposed field link:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Stable identifier |
| `sourceField` | `SystemFieldRef` | The source field |
| `targetField` | `SystemFieldRef` | The target field |
| `relation` | `"equivalent" \| "subsumes" \| "converts"` | Semantic relation |
| `conversion?` | `{ factor?, offset?, note? }` | Numeric conversion (only for `"converts"`) |
| `evidence` | `Array<{ system, excerpt }>` | Schema-document excerpts from each system |
| `confidence` | `number` | Extractor confidence 0–1 |
| `rationale` | `string` | Human-readable rationale |
| `proposedBy` | `string` | Extractor name |
| `proposedAt` | `string` | ISO 8601 timestamp |

### SchemaMappingExtractor interface

```ts
export interface SchemaMappingExtractor {
  name: string;
  extract(context: {
    systems: Array<{ system: string; schemaText: string }>;
  }): MappingProposalRecord[] | Promise<MappingProposalRecord[]>;
}
```

The extractor is pluggable.  Implementations may be deterministic (like `referenceSchemaExtractor`), embedding-based, or LLM-backed — but they are always **proposers**: their output carries full provenance and goes through review before it counts.

A `referenceSchemaExtractor` is exported for tests; it is a **reference implementation only** (field-name exact-match, not suitable for production).

### surveySchemaMapping

```ts
import { surveySchemaMapping, referenceSchemaExtractor } from "@kontourai/survey";

const { surveyInput, proposals, candidateSets } = await surveySchemaMapping(
  {
    systems: [
      { system: "crm", schemaText: "Contact.email:string\nContact.phone:string" },
      { system: "erp", schemaText: "Customer.email:string\nCustomer.phone:string" },
    ],
  },
  referenceSchemaExtractor,
  { autoAcceptMinConfidence: 0.85 },  // optional comfort-zone threshold
);
```

The function runs the extractor and projects proposals into the standard Survey chain:

- One `RawSource` per system schema (`kind: "system-schema"`, `locatorScheme: "structured-field"`).
- One `Extraction` and one `Candidate` per proposal.
- One `CandidateSet` per field pair:
  - `status: "conflict"` when proposals for the same pair disagree on `relation`.
  - `status: "needs-review"` otherwise.
- One `ReviewOutcome` (`status: "assumed"`, `actor: "auto-accept-policy"`) per non-conflicting candidate set whose top confidence is at or above `autoAcceptMinConfidence`.  Conflicting sets are never auto-accepted.

### mappingReviewToSurface

```ts
import { mappingReviewToSurface } from "@kontourai/survey";
import type { ReviewedMapping } from "@kontourai/survey";

const bundle = mappingReviewToSurface(reviewedMappings, {
  source: "schema-mapping.reviewed",
  generatedAt: new Date().toISOString(),
});
```

For each accepted mapping (`status: "verified"` or `"assumed"`) the bundle contains **both**:

1. **A `Claim`**: `subjectType: "system-field"`, `fieldOrBehavior: "maps-to"`.  Disputing this claim caps the downstream answer through the weakest-link rule.
2. **An `IdentityLink`**: links the source and target system-field subjects by `subjectType: "system-field"` and `subjectId: "<system>::<entity>::<field>"`.  Sets `relation` and `conversion` from the proposal, and `mappingClaimId` pointing at the claim above.

Rejected mappings are omitted from the bundle.  Use `buildSurveyTrustBundle` on the original `SurveyInput` if you need an audit trail that includes rejections.

### Cross-system resolution and weakest-link capping

Once a reviewed mapping bundle is merged with domain data claims, `resolveInquiry` from `@kontourai/surface` can resolve a system-B field inquiry using system-A's claim:

```ts
import { resolveInquiry } from "@kontourai/surface";

// bundle contains: mapping claim + identity link + crm data claim
const record = resolveInquiry(bundle, {
  id: "inquiry-1",
  question: "What is the email for erp Customer?",
  target: {
    subjectType: "system-field",
    subjectId: "erp::Customer::email",
    fieldOrBehavior: "value",
  },
  askedBy: "consumer",
  askedAt: new Date().toISOString(),
});

// record.outcome === "matched"
// record.answer.value === "alice@example.com"  (from crm claim, traversed via link)
// record.answer.status — capped by the mapping claim's derived status
```

**Weakest-link rule**: if the mapping claim is disputed (or has any lower-trust event as its latest event), the resolved answer status is capped to `"disputed"` regardless of the source data claim's status.

### Key contracts

- `RawSource.kind` is `"system-schema"` for all schema sources.  `locatorScheme` is `"structured-field"`.
- `IdentityLink.subjects` use `subjectType: "system-field"` and `subjectId` in the form `"<system>::<entity>::<field>"`.
- `IdentityLink.mappingClaimId` must point at a claim present in the same bundle; `resolveInquiry` uses it to compute the weakest-link ceiling.
- The `SchemaMappingExtractor` interface is synchronous or async; `surveySchemaMapping` always awaits it.
- Auto-accept mirrors `applyAutoAcceptPolicy` in `inquiry-mapping`: non-conflicting proposals above the threshold are accepted as `"assumed"`, never as `"verified"`.  Conflicts require explicit human review.
- `referenceSchemaExtractor` is deterministic and test-only.  Its matching strategy (exact field-name, optional type-token match) is intentionally simple and transparent.


## Oversight-quality metrics

`deriveOversightMetrics` computes per-reviewer and aggregate indicators from a
stream of `ReviewDecision` resources.  `oversightMetricsToClaims` projects those
indicators as Surface-ready claims with `claimType: "oversight-quality"`, one
claim per metric, so Annex-pack rules can apply value predicates (e.g.
`overrideRate gte 0.02`, `decisionsPerHour lte 60`).

```ts
import {
  deriveOversightMetrics,
  mergeTrustBundleWithOversightMetrics,
  oversightMetricsToClaims,
} from "@kontourai/survey";

const metrics = deriveOversightMetrics(decisions, {
  now: new Date(),
  windowDays: 7,          // optional rolling window
  presentedCount: 120,    // optional denominator for samplingCoverage
});

// metrics.aggregate: decisionCount, decisionsPerHour, overrideRate,
//   typedRationaleRate, medianInterDecisionSeconds, samplingCoverage?
// metrics.byReviewer: one row per actorId

const subject = {
  subjectType: "review-session",
  subjectId: "session-xyz",
  surface: "review.oversight",
  actor: "oversight-collector",
  observedAt: new Date().toISOString(),
  collectedBy: "oversight-metrics",
};

const claimRecords = oversightMetricsToClaims(metrics, subject);
const bundle = mergeTrustBundleWithOversightMetrics(existingBundle, claimRecords);
```

### Override detection

A decision counts as an override when the reviewer chose a candidate that differs
from the item's pre-selected (proposed) candidate.  The workbench `ReviewDecision`
carries the selected `spec.candidateId` and the projection `spec.projection.candidateId`.
When those differ — or when `spec.status === "rejected"` — the decision is an override.
When neither signal is available the decision is treated as non-override to avoid false
positives.

### Honest limits

These metrics are **indicators, not proof of reviewer cognition**:

- **Pace statistics can be gamed.** A reviewer who clicks quickly with occasional
  typed rationale notes will produce metrics that look engaged.  Metrics complement
  identity signing and `authorizing` provenance; they do not replace either.
- **Override rate is a proxy.** Disagreeing with the proposed value is consistent with
  engagement, but a reviewer who always overrides is not necessarily more careful than
  one who almost always agrees.  Domain context — not a single ratio — determines what
  a healthy override rate looks like.
- **Typed rationale indicates effort, not correctness.** A reviewer can write a note
  without reading the source.
- **Sampling coverage depends on a caller-supplied denominator.** When `presentedCount`
  is not provided the metric is omitted rather than fabricated.
- **Status is `"proposed"` for all oversight claims.** Oversight-quality claims are
  derived computations, not externally verified facts.  Downstream consumers should
  treat them as decision-support signals, not authoritative verdicts.
