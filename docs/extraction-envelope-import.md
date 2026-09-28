# Extraction Envelope Import

Survey structurally consumes version 1 of the upstream-owned
`traverse-extraction-result` envelope. Survey does not fork that wire contract
and does not require Traverse at runtime. `@kontourai/traverse` is a test-only
compatibility oracle: Survey's canonical fixture is validated by the published
upstream deserializer in CI.

`importExtractionEnvelope` accepts the serialized document plus Survey-owned
projection options. The options provide the import namespace, Raw Source kind,
and the `ClaimTargetHint` for each proposal because those review semantics do
not belong in the extraction wire format.

```ts
const imported = importExtractionEnvelope(serializedEnvelope, {
  importName: "directory-refresh-17",
  producerNamespace: "directory-producer",
  sourceKind: "api-record",
  claimTarget: (proposal) => ({
    subjectType: "directory-entry",
    subjectId: "17",
    facet: "directory.registration",
    claimType: "directory.field",
    fieldOrBehavior: proposal.fieldPath,
    impactLevel: "medium",
  }),
});

await producerStore.save(imported.record);
const persisted = exportExtractionEnvelopeImport(imported.record);
const restored = reimportExtractionEnvelope(persisted);
```

The `ExtractionEnvelopeImport` record preserves the validated envelope without
dropping source/snapshot references, prepared-artifact identity, exact locator
and occurrence resolution, value/type inference, provider/model/run identity,
usage and attempt context, outcome, warning classifications, provider failures,
task/example digests, PDF page/layout context, and OCR-derived posture. Existing Survey producers can continue creating
records directly; this adapter is additive.

## Grounding and identity

An absent or `available` prepared-artifact state is grounded. `unavailable`,
`storage-error`, `identity-mismatch`, and `invalid-artifact` states become typed
`artifact-unavailable` diagnostics. `digest-mismatch` becomes a typed diagnostic
with expected and actual digests. A `failure` outcome becomes an
`extraction-failed` diagnostic carrying its category and code (for example
`provider/no-usable-answer`), and a `partial` outcome with no proposals becomes an
`extraction-incomplete` diagnostic naming the partial reason, so neither reads as
a complete run that found nothing; the source inspector leads with the same
message and exposes it as `extractionDiagnostic`. A partial run with proposals
stays grounded and carries its reason on every candidate. Unresolved imports
produce no `ReviewItem`.

### Verifying excerpts at import

Pass the resolved prepared artifact as the `artifact` option to check the
envelope against the bytes at import instead of only in the source inspector:

```ts
const imported = importExtractionEnvelope(serializedEnvelope, {
  ...options,
  // actualDigest: the lowercase hex SHA-256 of the text, e.g. createHash("sha256").update(preparedText).digest("hex")
  artifact: { status: "available", text: preparedText, actualDigest },
});
```

The text must hash to `result.preparedArtifact.digest` and have its
`contentLength`. If it does not, or the artifact is reported `unavailable` or
`digest-mismatch`, the import is `unresolved` with a `digest-mismatch` or
`artifact-unavailable` diagnostic. When it verifies, each proposal's
`chars:start-end` slice must equal its excerpt. A proposal that fails this
produces no `ReviewItem` and an `excerpt-mismatch` diagnostic that names its
index and locator. The rest import unchanged and the import stays `grounded`,
unless every proposal failed, which makes it `unresolved`. The text itself is
not stored in the record.

An excluded proposal is unverifiable, not disproven. When it shared a claim
slot with proposals that did verify, the slot's item lists it in its producer
metadata as `excludedProposals`. Every decision surface shows it with its
value and span: the workbench card and audit rows, the MCP item and card, and
the recorded decision prompt. The prompt is rebuilt from the item when the
decision is built, so it records what the card states for that item, not
proof that a reviewer read it. Stored entries that cannot be shown, because
they are malformed or the item's extraction binding is broken, are never
dropped silently: the same surfaces say how many are not shown and why. The candidate set is judged on the candidates that
remain: a rival value whose excerpt failed does not keep the set in
`conflict`, because a conflict item offers only decisions that trust no
value, and an unverifiable citation would then be enough to block the value
that the source does support. The reviewer still sees the rival and can
decline with Could not confirm. The source inspector names every excluded
proposal, including ones whose slot has no other proposal and so no item, and
shows the `proposals-excluded` posture instead of the aligned one.

`status.provenance` is `"verified"` only when this check ran against text that
matched the digest. Without the option, or when the text did not verify, it is
`"unverified"`. Consumers that must not review unverified excerpts should
require `"verified"`. Records written before this field existed have no
`provenance`. Items from a verified import carry `excerptVerification:
"verified"` in their producer metadata, and the inspector and workbench show
whether a source's excerpts were checked. The field records what the import saw. It is not proof: a
record taken from untrusted storage cannot prove it without the text.

### One candidate set per claim

Proposals are grouped into one `ReviewItem` per **claim slot**: the claim the
proposal maps to through `claimTarget` (`subjectType`, `subjectId`, `facet`,
`claimType`, `fieldOrBehavior`, and `claimId` when one is set) plus the
proposal's `pathIndices`. The slot is the claim, not the upstream `fieldPath`
(two field paths mapped to one claim are one slot) and never the value.
Inside a slot there is one candidate per distinct canonical value, all with the
`proposed` role:

- one distinct value: one candidate, `candidateSetStatus: "needs-review"`.
  Further proposals of that value (the same fee quoted twice) are listed on the
  candidate's producer metadata as `sameValueProposals` with their proposal
  index, evidence id, locator, and excerpt.
- two or more distinct values: `candidateSetStatus: "conflict"`. The item projects
  one claim, so within one envelope two values for one claim can no longer be
  accepted as two verified claims.

Grouping is per envelope import. Two imports that propose different values for
the same subject and field (two runs, or one envelope imported under two import
names) are still separate items and can still both be verified: item identity
includes the import name and run id, and carrying one claim slot across runs is
the stable slot identity tracked in kontourai/fieldwork#52 and
kontourai/survey#295.

A multi-valued field stays one item per value when the producer says so: array
items carry distinct `pathIndices`, or `claimTarget` returns distinct claim ids
or subjects. `pathIndices` are the indices the model assigned in the chunk it
read, not a document-wide item identity. In a multi-chunk run, two chunks can
give the same index to different array items (grouped into one slot: a false
conflict, which fails closed to review) or different indices to the same item
(separate slots, so the same value can appear as two items). Proposals that share a slot must return identical claim targets;
otherwise the import is refused, because one claim cannot carry two impact
levels. The item's producer metadata lists every `proposalIndices` it stands for.

The review workbench, the server session, and the MCP review tool record a
decision against a candidate role, so none of them can choose one of several
`proposed` values yet. On a `conflict` item:

- accept is refused: `candidateForDecision` throws instead of settling the
  conflict by picking the first value, and the workbench and MCP card offer no
  accept control;
- rejecting all values (`reject-proposed`) and `could-not-confirm` are
  allowed, because they trust no value, and the round can complete. They
  select no candidate, and no record singles one out:
  - the `ReviewDecision` and its session events carry no `candidateId`;
  - the `CandidateSet` has no `selectedCandidateId`; after reject-all its status
    is `rejected` and every proposed candidate carries a `rejectionReason` (the
    reviewer's note, or a fixed sentence), so each gets its own
    `learning.rejected-candidate`; after could-not-confirm it stays `conflict`;
  - the `ReviewOutcome` and the claim carry no `candidateId`;
  - the Surface claim has `value: null` (Surface requires the key; no one value
    is the claim's), lists every value in `metadata.survey.candidates`, has one
    evidence record per candidate, and is `rejected` (reject-all) or
    `disputed` (could-not-confirm, the pre-review posture of a conflict). It
    can never be `verified`.

  The `ReviewWorkbenchResult` for such a decision has no `selectedCandidate*`,
  `selectedValue`, or `effective*` fields and lists every candidate in
  `unselectedCandidates`; `buildReviewResultPresentation` shows no selected
  value and names each candidate as rejected or unconfirmed; the apply-action
  mapping produces no action. With `reviewProofs: true`, the set-level claim
  gets no integrity anchor, because an anchor commits one reviewed candidate and
  this claim has none; it is never `verified` or `assumed`.

Both cards list every value and label the item as a conflict. Surface's
reviewed-extraction profile refuses items with more than one candidate.

### Identities

The `ReviewItem` name commits the producer/import namespace, source and
snapshot, prepared artifact, PDF layout, run, and the claim slot. Candidate,
extraction, evidence, and resolution identity includes producer/import
namespace, source and snapshot, prepared artifact, PDF layout, run, proposal index, and the
complete proposal semantics: field, value, confidence, extractor, type/inference,
path indices, excerpt, locator, and exact-occurrence record; a candidate that
stands for several same-value proposals also commits each of them. Same values at
different spans therefore remain distinct evidence. Evidence identity binds the complete
source provenance, including excerpt and occurrence selection, while excluding
field and value semantics; different fields grounded by one span visibly share
evidence. Each resolution call adds a fresh UUID-backed evidence/event identity.

## Validation and disclosure

The boundary validates the complete v1 shape and rejects unexpected properties,
malformed enums and outcome/state relationships, incoherent UTF-16 spans and
occurrence metadata, authorization-bearing references or credential-shaped
identities, non-ascending PDF page offsets, malformed or out-of-range PDF page
geometry/elements/table cells, non-finite or negative-zero numbers, sparse arrays,
accessors, symbols, cycles, and other non-lossless JSON object inputs.

Optional keys are named, not open-ended. Besides the original v1 keys the
importer accepts:

- `result.providerFailures[].code`: the upstream error code, a credential-free
  stable identity of at most 128 characters. It is informational; `kind` stays
  authoritative. It is kept in the imported envelope.
- `result.proposals[].producedBy`: `{ model, modelSource, requestDigest }`,
  where `modelSource` is `"provider-reported"` or `"configured"` and
  `requestDigest` is a `sha256:` digest. It is copied into the candidate's
  `survey.kontourai.io/extraction-envelope` producer metadata, and its `model`
  becomes the candidate's `extraction.model`, so a candidate names the model
  that served its own proposal. A proposal without `producedBy` keeps
  `result.model`, and the producer metadata's `model` stays `result.model`.
  Surface releases that bind the candidate model to `result.model` refuse a
  candidate whose proposal was served by a different model than the last
  chunk's; those that bind it to `producedBy.model` accept it.
- `result.proposals[].evidenceMatch`: `{ checkerVersion, schema,
  valueInExcerpt, tokenBoundary? }` with closed `schema` (`ok`,
  `type-mismatch`, `enum-mismatch`, `format-invalid`) and `valueInExcerpt`
  (`match`, `mismatch`, `not-evaluated`, `not-applicable`) values. It is copied
  into the same producer metadata as an annotation; it does not change the
  candidate-set status or routing.

- `result.coverage`: per-chunk read coverage, `{ chunk, start, end, status,
  reason? }`. `chunk` is a positive 1-based number; `start`/`end` are
  prepared-text UTF-16 offsets with `0 <= start < end <= contentLength`;
  `status` is `complete`, `unread`, or `output-truncated`; `reason`
  (`provider-failure`, `content-truncated`, `missing-tool-call`,
  `not-dispatched`) is present exactly on `unread` entries and covers exactly
  the unread span. Entries are ordered by `start` and may overlap, because
  chunks overlap. Coverage requires `result.preparedArtifact`.
- Partial reasons `provider-failure`, `content-truncated`, and
  `output-truncated` (a dispatched chunk was not fully read or answered), next
  to the early stops `cancelled`, `max-provider-calls`, `max-total-tokens`, and
  `max-chunks`. An envelope with one of the three loss reasons must carry a
  coverage entry that is not `complete` for a dispatched chunk (a
  `not-dispatched` range alone is an early stop, not that loss), and a `success` outcome must not carry
  one, so the outcome and the coverage cannot disagree.
- `result.proposals[].confidence` may be absent: it is the proposer's
  uncalibrated self-report. When present it must be a finite number in `0..1`
  (`null` is rejected). An absent confidence stays absent on the candidate and
  its extraction; Survey never substitutes a number.
  `toSurfaceReviewedExtractionImport` exports such a record only when the
  installed `@kontourai/surface` is 4.1.0 or later, and refuses it by name
  on older versions, which reject it.

Any other key, and any other partial reason, is still rejected.

### Partial runs downstream

Survey carries what the envelope says about unread text; it does not turn it
into a completeness verdict. Every candidate's
`survey.kontourai.io/extraction-envelope` producer metadata holds the run's
`outcome`, and on a partial run also `partial` and `coverage`, and the import
record keeps the whole envelope. Survey derives no state for a field without a
proposal: no proposal means no `ReviewItem` and no claim, so nothing Survey emits
reports a value as absent or a run as complete. A consumer that needs to know
whether a field could have been in unread text reads `coverage`.

The portable format excludes prepared text, raw provider responses, native
failures, and configuration by design. Candidate values and excerpts remain
intentional review data. Treat every retained field as potentially visible to a
review host: never put credentials, tokens, private configuration, unnecessary
personal data, or secret-bearing identifiers into an envelope.

## Source-linked inspection

The existing review workbench can attach a read-only inspector through the
custom element's `extractionInspector` property or the exported inspector model
helpers. Supply the complete `ExtractionEnvelopeImportResult` returned by
`importExtractionEnvelope` plus a separately resolved prepared artifact;
the resolver must provide its computed digest. Highlights appear only after the
digest, length, and exact excerpts align. Unavailable or mismatched material is
shown as a prominent non-grounded posture and cannot be reviewed as grounded.

The pane filters by field, provider, model, attempt, explicit/inferred type
origin, and alignment. Candidate/highlight navigation is bidirectional by
keyboard and announced with accessible labels. It activates the matching
existing `ReviewItem`; it does not store or apply a second decision.

When a validated PDF layout is present, each exact candidate span is resolved
to overlapping page elements and table cells. The candidate announces its page
and region context while the prepared-text highlight remains the authoritative
locator. OCR-derived candidates are labeled explicitly. Survey never infers PDF
geometry or treats OCR text as source truth.

Pass `{ imports: [...] }` to inspect a review set spanning multiple validated
imports. Provider, model, attempt, and optional producer-declared pass filters
then distinguish candidates across runs. A single entry remains accepted as a
convenience. Every record is revalidated through Survey's public import
validation boundary, and its proposals are checked against the authoritative
`ReviewItem.metadata.name` values before anything renders.

### Linking a decision back to the sentence it came from

A host that renders the queue and the inspector side by side usually wants each
fact on a review card to link to the highlighted span it was extracted from.
`ExtractionInspectorCandidate.highlightElementId` is the supported way to build
that link: it is the element id of the candidate's highlight anchor, published
on the model the host already holds.

```ts
// BuiltExtractionInspectorModel: highlightElementId is `string`, not optional.
const model = buildExtractionInspectorModel(entry);
mountExtractionInspector(inspectorHost, model);

const byItem = new Map(model.candidates.map((c) => [c.reviewItemName, c]));

const presentationAdapter: ReviewPresentationAdapter = {
  linkForSource: (sourceRef, { item, candidate }) => {
    if (candidate.role !== "proposed") return undefined;
    const inspected = byItem.get(item.metadata.name);
    return inspected ? { label: sourceRef, href: `#${inspected.highlightElementId}` } : undefined;
  },
};
```

The renderer reads the same field, so the id a host links to and the id in the
DOM cannot drift apart. Three guarantees hold: the value is a valid HTML/CSS
identifier usable verbatim; it is unique across every candidate in one model;
and it resolves for **every** candidate, in every posture, for as long as the
inspector is mounted.

That last one is deliberate, and it has three parts.
`mountExtractionInspector` pages the candidate list (`pageSize`, default 100)
and filters it, but highlight anchors are exempt from both — a 204-candidate
model mounts 204 anchors on page one, and typing in the filter box does not take
any of them away. Anchors are empty and inert, so this costs roughly one element
per off-page candidate: measured at 600 candidates against the default page
size, all 600 ids resolve while candidate rows and painted highlights stay at
100 each, with no mount-time cost over a 100-candidate model. Anchors are also rendered when the source is **not grounded**
(the prepared artifact is unavailable, its digest does not match, or an excerpt
does not match its span): there is no highlighted span to land on then, so the
anchor sits with the posture message explaining why, which is more use to a
reviewer than a link that goes nowhere. Only the candidate rows and the painted
`<mark>` highlights follow the page. A link that dies because a reviewer paged,
filtered, or opened a source that failed verification is the same broken promise
as an id that drifted.

Activating a highlight whose candidate row is off-page or filtered out navigates
the list to that candidate rather than silently failing to focus it.

### Which type carries the guarantee

`buildExtractionInspectorModel` returns a `BuiltExtractionInspectorModel`, whose
candidates are `BuiltExtractionInspectorCandidate` — `highlightElementId` is
`string` there, so a host that links never null-checks the thing it was told to
rely on.

On the wider `ExtractionInspectorCandidate` the field is optional, because that
type is also the shape a caller may assemble by hand and pass to
`mountExtractionInspector`, `exportExtractionInspector`, or
`filterExtractionInspectorCandidates`. Mount resolves an id for any candidate
that arrives without one, so a hand-authored model still renders; it simply has
no published id to link against. A built model is assignable everywhere the
wider one is accepted, so the split costs callers nothing.

Do **not** reconstruct these ids from `candidate.id`. The sanitizing step is
private, lossy, and not a contract; a consumer that mirrored it shipped a copy
of Survey's internals and a test to catch that copy drifting.

For the reverse direction — finding the candidate behind a DOM node — the link
target carries `data-highlight-candidate-id="<candidate.id>"`, and the painted
highlight carries `data-highlight-return-to`, a **space-separated list of the
`highlightElementId`s** the highlight covers. Both are public. They are separate
attributes so each resolves to exactly one element: the target is an inert
`<span>` that exists for every candidate in the model, and the highlight is the
`<mark>` painted for the candidates on the current page.

Select on `data-highlight-return-to` with `~=`, never `=`. Two candidates over
one span is ordinary in extraction, and the renderer paints them as a single
`<mark>` bound to both:

```js
// the highlight covering this candidate, shared span or not
inspectorHost.querySelector(`[data-highlight-return-to~="${candidate.highlightElementId}"]`);
```

Note which value that is. `highlightElementId` is unique by construction;
`candidate.id` is the candidate's own identity, and a model you assembled
yourself may repeat it. Every lookup that has to reach *one* candidate should key
on the binding, not on the id — a `[data-…="<candidate.id>"]` selector can return
a different candidate's highlight, which on this surface means confidently
pointing an auditor at the wrong span.

The highlight is also the control. Activating it — click, Enter, or Space —
returns focus to that candidate's row in the list, paging and clearing filters if
that is what it takes to bring the row back. The link target is deliberately not
a control: there is one per candidate, so as a focusable element it put a tab
stop in sequence for every candidate in the model (600 of them for a
600-candidate model, several stacked together where a source is not grounded),
while being invisible and, at its size, unaimable. The thing a reader can
actually see and hit is the highlight.

Following a host's `href="#<highlightElementId>"` to a candidate that is off the
current page or excluded by a filter pages the list to it and focuses its
highlight, rather than leaving the reader on an invisible marker.

`highlightElementId` is deliberately absent from `exportExtractionInspector`
output: it is a binding to a live inspector, not extraction evidence, and must
not move the export's digest.

`exportExtractionInspector` produces canonical, provider-independent read-only
JSON. Prepared text and excerpts are redacted by default because either can
contain confidential, personal, or regulated source material. Include them only
after an explicit access and disclosure decision. The export never includes
provider configuration, credentials, or raw provider responses.
Resolver failure details are not accepted as free text: unavailable artifacts
use a small typed code, and exports omit presentation messages entirely.
