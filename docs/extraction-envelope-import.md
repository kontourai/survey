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
with expected and actual digests. Unresolved imports produce no `ReviewItem`.

Candidate, extraction, evidence, and resolution identity includes producer/import
namespace, source and snapshot, prepared artifact, PDF layout, run, proposal index, and the
complete proposal semantics: field, value, confidence, extractor, type/inference,
path indices, excerpt, locator, and exact-occurrence record. Same values at
different spans therefore remain distinct. Evidence identity binds the complete
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
