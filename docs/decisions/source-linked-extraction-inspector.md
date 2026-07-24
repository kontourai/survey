---
status: current
subject: Source-Linked Extraction Inspector
decided: 2026-07-20
evidence:
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/158"
  - kind: doc
    ref: docs/extraction-envelope-import.md
  - kind: doc
    ref: src/review-workbench/extraction-inspector.ts
---

# Source-Linked Extraction Inspector

## Context

Portable extraction results preserve exact UTF-16 spans and prepared-artifact identity but deliberately exclude prepared text. Reviewers need to inspect those candidates against the resolved source without creating a parallel decision record or weakening an unresolved artifact posture.

## Decision

Survey provides an optional read-only inspector pane for the existing review workbench. A host supplies one or more complete `ExtractionEnvelopeImportResult` values and separately resolved artifacts with resolver-computed digests. Survey revalidates every import and checks its authoritative ReviewItem binding before rendering. The pane only highlights source text when the import is grounded, the expected and actual digests match, content length matches, and each recorded excerpt matches its exact span.

Candidate activation selects the corresponding existing ReviewItem through its import name and proposal index. The inspector owns no decisions, mutations, provider calls, artifact resolution, or review policy. Repeated occurrences and multiple candidates sharing one span retain distinct candidate and accessible navigation identities.

For a validated PDF layout sidecar, the inspector resolves the existing exact
`chars:` span to overlapping page elements and table cells and presents that
context accessibly. It does not infer geometry or introduce another locator.
OCR-derived prepared text is labeled explicitly.

Filters cover field, provider, model, attempt, optional producer-declared pass, explicit/inferred origin, and alignment across the full review set. The self-contained export is canonical, read-only JSON with prepared text and excerpts redacted by default. Hosts must opt in separately to either disclosure; unrestricted resolver failure text is neither accepted nor exported.

## Consequences

- Artifact unavailability, digest mismatch, length mismatch, and excerpt mismatch remain prominent non-grounded states.
- The browser never receives provider credentials or configuration and never needs a provider SDK.
- Source text and excerpts are potentially sensitive review data; default exports omit them.
- Page/region context remains safe structured provenance in the default export; raw source bytes remain absent.
- Hosts remain responsible for resolving artifacts and enforcing access controls around source disclosure.
