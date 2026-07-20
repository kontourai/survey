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
and task/example digests. Existing Survey producers can continue creating
records directly; this adapter is additive.

## Grounding and identity

An absent or `available` prepared-artifact state is grounded. `unavailable`,
`storage-error`, `identity-mismatch`, and `invalid-artifact` states become typed
`artifact-unavailable` diagnostics. `digest-mismatch` becomes a typed diagnostic
with expected and actual digests. Unresolved imports produce no `ReviewItem`.

Candidate, extraction, and resolution identity includes producer/import
namespace, source and snapshot, prepared artifact, run, proposal index, and the
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
identities, non-ascending PDF page offsets, non-finite or negative-zero numbers, sparse arrays,
accessors, symbols, cycles, and other non-lossless JSON object inputs.

The portable format excludes prepared text, raw provider responses, native
failures, and configuration by design. Candidate values and excerpts remain
intentional review data. Treat every retained field as potentially visible to a
review host: never put credentials, tokens, private configuration, unnecessary
personal data, or secret-bearing identifiers into an envelope.
