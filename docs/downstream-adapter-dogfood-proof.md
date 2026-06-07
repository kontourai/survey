# Downstream Adapter Dogfood Proof

Issue #38 proves Survey can accept a real downstream-shaped current/proposed
review proposal at the package boundary without importing downstream code or
moving product policy into `src/`.

## Sanitized Provenance

The fixture in `fixtures/downstream-public-directory-proposal.ts` is a sanitized
copy of a mature public-directory admin review shape inspected in a local
downstream product. The original shape has proposal identity, record identity,
crawl run identity, proposal status, `rawExtraction`, `proposedChanges`,
per-field `old` and `new` values, confidence, excerpt, source URL, extraction
model, review timestamps, reviewer notes, priority, applied-field tracking, and
joined current record context.

All product names, private identifiers, source labels, and record values were
replaced with neutral public-directory examples. No live import, package
dependency, or runtime reference to the downstream product is used.

## Boundary Proof

`examples/review-workbench/downstream-public-directory-adapter.ts` maps the
sanitized proposal into a normal Survey `ReviewItem`:

- current and proposed candidates are represented with portable roles.
- each candidate carries source, locator, excerpt, confidence, extraction, claim
  target, and projection hints.
- producer policy is opaque metadata on the resource boundary.
- rejected proposal semantics remain downstream-owned: the selected candidate is
  current, while the proposed candidate can still receive a rejected
  `ReviewDecision`.
- pending and skipped proposal statuses stay neutral in the adapter output. They
  use the existing `needs-review` candidate set status and omit
  `selectedCandidateId`, selected-current projection semantics, and rejection
  policy. `needs-review` is the least misleading current Survey vocabulary for
  skipped input because no candidate has been accepted or rejected by Survey.

The adapter lives under `examples/`, not `src/`, because field policy, proposal
status interpretation, approval behavior, learning signals, and queue state are
owned by the producer.

## Workbench Proof

`tests/downstream-adapter.test.ts` renders the adapter output through the
existing review workbench helpers. The workbench does not need product-specific
branches: it reads the adapter output as a `ReviewItem`, shows the current and
proposed candidates, and emits local `ReviewDecision` payloads for accept
proposed, keep current, and reject proposed.

## Downstream Code That Could Be Simplified

With this boundary in place, a downstream product could remove or simplify:

- bespoke current/proposed candidate rendering logic that duplicates the Survey
  ReviewItem shape.
- local JSON payload inspection for source, extraction, claim, and projection
  hints.
- custom comparison glue for reviewed current value versus extracted proposed
  value.
- duplicated source evidence display for URL, locator, excerpt, confidence, and
  extractor.
- local Surface preview wiring where the product only needs portable review
  posture rather than full domain workflow state.

## Responsibilities Retained Downstream

Survey still does not own:

- field catalogs, edit controls, labels, or value validation.
- crawler extraction, parser behavior, source selection, or source ranking
  policy.
- approval, partial approval, rejection, and recrawl semantics.
- learning-signal rows, feedback tags, and model improvement loops.
- claim id conventions, record identity, tenancy, auth, persistence, and queue
  navigation.
- regulated-document or source-authority reconciliation rules.

## Secondary Hardening Note

A separate regulated rules repository was used only as an abstraction-hardening
lens. Its managed-source flows include source authority, value reconciliation,
conflict states, and manual confirmation paths that are not always
current/proposed UI decisions. That confirms the adapter example should remain
product-neutral and role-flexible: current/proposed works for this public
directory proof, but Survey should not assume every downstream review is a
two-candidate public-directory update.
