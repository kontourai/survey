---
status: current
subject: Field States, Carry-Forward and Score-Blind Audit
decided: 2026-09-28
evidence:
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/294"
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/295"
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/296"
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/320"
  - kind: doc
    ref: src/field-states.ts
  - kind: doc
    ref: src/decision-carry-forward.ts
  - kind: doc
    ref: src/review-workbench/audit-sample.ts
---
# Field States, Carry-Forward and Score-Blind Audit

## Decision

**Field states are derived, never stored.** `deriveFieldStates` reads import
records, decisions, and optionally verifier records, carry-forward records and
supersessions, and returns a content state and a lifecycle state per claim
slot. A state appears only when the input that produces it is present.

- Content: `value`, `conflicting` (two or more distinct values),
  `unsupported` (every candidate has a contradicted or not-addressed verifier
  record for its current value and none supported; precedence over the other
  two), `not_covered` (no candidate, and the run was partial or failed).
- Lifecycle: `pending`, `accepted`, `rejected`, `could_not_confirm`,
  `superseded` (a supersession names the decision).
- Signals, not states: `incompleteRun`, `excludedProposals`, `unresolvedImport`.

`not_found`, `stale`, `held`, `stated_none` and `not_applicable` are not
shipped: no producer computes them. A field with no candidate in a complete run
has **no** content state, because chunk coverage does not show that one field's
proposal was not dropped. A value from a partial run stays `value` but carries
`incompleteRun`, so a run that lost content never reads as complete.

**Unit.** One import record is one source extraction; states are keyed by
(import, claim slot), where the slot is the importer's grouping identity
(subject, facet, claim type, field, claim id, path indices). A field with no
proposal appears only when the caller passes `expectedFields`. Merging slots
across imports of different sources is not done.

**Surface projection.** `buildCanonicalReviewedTrustInput({ fieldStates })`
derives the states from the imports and the results' own decisions and writes
them under claim metadata key `survey.kontourai.io/field-state`
(`{ schemaVersion: 1, content?, lifecycle?, decisionBasis?, signals? }`).
Claim status is unchanged.

**Carry-forward.** `splitRoundForCarryForward` takes the new round's items with
producer `slotId` and per-candidate version ids (Survey validates presence and
never invents them) and the prior round's decisions. An item carries forward
only when exactly one live prior decision names its slot, the version-id sets
are equal, and each candidate's value, locator, excerpt, source ref and source
checksum are unchanged. The last check means a decision never carries across
changed content even if a producer reuses a version id. By default only
`accepted` carries; `rejected` and `could_not_confirm` carry only under an
explicit `policy.carry`. The output is a content-addressed
`DecisionCarryForward` record naming the prior decision by name and digest.
`buildDecisionSupersession` records `candidate-changed` or `re-reviewed`.
The vocabulary is `carried-forward` versus `affirmed`, matching the round
receipts producers already keep. Field states expose it as `decisionBasis`.

**Score-blind audit.** A session's `presentation: { scoreBlind }` and
`sampling` sit in the snapshot, so the server record hash and queue binding
cover them and a reviewer cannot switch them. In a score-blind session the
workbench, the MCP item text, data and card, and the recorded decision prompt
show no confidence and no verifier result, before or after a decision.
Excerpt-verification notes and excluded proposals stay visible: they are about
the evidence, not a verdict on the value. Decisions copy both fields into
`ReviewDecision.spec` and the canonical projection copies them into
`ReviewOutcome.metadata`. `drawRandomAuditSample` uses a per-item SHA-256
draw, so the same seed gives the same sample in any input order.
`deriveCalibration({ auditSamplesOnly: true })` keeps only score-blind
random-audit outcomes. It is off by default.

**Provenance.** `status.provenance` is required on import records (breaking).

## Left open

- Field-slot and version identities from the extractor (kontourai/traverse#172);
  until then callers compute them.
- `not_found`: needs per-field chunk coverage and a dropped-proposal count.
- Carried-forward decisions are records, not `ReviewDecision`s, so they do not
  yet project to Surface claims. A carried accept that had an edit points at
  the prior decision for the edited value.
- The MCP server does not show field states. The workbench panel lists every
  field, including unread ones, when the host passes `fieldStates`.
- A score-blind browser page still holds the item JSON in memory. The blind
  mode controls what is rendered, not what a determined reviewer could inspect.
