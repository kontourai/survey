---
status: current
subject: Proposed-Value Edit
decided: 2026-07-17
evidence:
  - kind: pr
    ref: "https://github.com/kontourai/survey/pull/148"
  - kind: pr
    ref: "https://github.com/kontourai/survey/pull/149"
  - kind: doc
    ref: docs/review-resource-contract.md
  - kind: doc
    ref: docs/consumer-integration-guide.md
---
# Proposed-Value Edit

How the **Review Workbench** offers, carries, and replays a reviewer's inline
edit to a proposed **Candidate** value. Two decisions ratified together in
`1.14.0`, both surfaced by the first real integration (OpenTherapist).

## Editing is a per-Review-Item producer choice (2026-07-17)

Before this decision the inline proposed-value editor always rendered until an
item had a decision; there was no way to turn it off for a queue where an
edited value is meaningless or must not be accepted (an approve/keep identity
decision, a value the producer will re-derive). Consumers hid the editor with
host CSS — detection, not prevention: the input was still in the DOM and still
editable.

**Decision**: `ReviewItemSpec.editable` (default `true`) controls whether the
inline editor renders for that item. `false` removes the editor entirely — the
decision is keep-current / use-proposed / reject only, and `effectiveValue` is
always the selected candidate's own value. This is enforcement (the affordance
is absent), not a cosmetic hide. `currentProposedReviewItem` accepts a matching
`editable?` input. Default-`true` keeps every existing item unchanged.

## An inline edit is carried in the event log, not browser state (2026-07-17)

The reviewer's edit (`editedValuesByItemName`) lived only in the workbench's
browser session state and never rode the **Review Session Event** log. A
server apply path that derives from pre-decision snapshot + persisted events —
the documented server-owned apply boundary — would replay the *unedited*
proposal and silently apply a value the reviewer never saw. The reviewer's
screen and the applied result disagreed, with no error: a divergence trap.

**Decision**: an accept-proposed decision event carries the edit on
`spec.data.workbenchEditedValue`, and `replayReviewSessionEvents` reconstructs
`editedValuesByItemName` from it. `snapshot + persisted events` is now a
complete record of reviewer intent; the derived `effectiveValue` reflects the
edit with **no separate edit channel**. Replay clears a stale edit when the
decision moves off accept-proposed or is cleared. Backward compatible: events
without the key replay exactly as before.

**Boundary preserved**: this does not move review authority into Survey. The
edit is producer-facing review input carried through the same replay/derive
machinery as every other decision; the producer still owns whether an edited
value updates a record, and re-validates it against current product state
before applying (see [consumer-integration-guide.md](../consumer-integration-guide.md)).
The original proposed value stays in the provenance trail (the candidate's own
value), so the edit never rewrites history.
