---
status: current
subject: Producer Profile
decided: 2026-07-03
evidence:
  - kind: adr
    ref: docs/adr/0003-inquiry-mapping-and-producer-proposals.md
  - kind: doc
    ref: docs/record-contracts.md
  - kind: pr
    ref: "<PR number for this slice, filled in at merge>"
---
# Producer Profile

This subject has provenance in frozen ADR history ([0003-inquiry-mapping-and-producer-proposals.md](../adr/0003-inquiry-mapping-and-producer-proposals.md)), which established the proposals-only rule this decision continues to honor (ADR 0003 §4: the Producer Profile core never decides a review outcome or claim status — every profile still routes its output through Survey's existing review -> claim machinery unchanged).

## Auto-accept policy unification (2026-07-03)

Before this decision, inquiry-mapping's `applyAutoAcceptPolicy` and schema-mapping's inline auto-accept block shared only three literal primitives from the core (`AUTO_ACCEPT_ACTOR`, `AUTO_ACCEPT_WITHIN_COMFORT_ZONE`, `meetsAutoAcceptThreshold`, all in `src/producer-profile.ts`) and had drifted on every other auto-accept mechanic:

- **Gate confidence**: inquiry-mapping gated per-proposal on the proposal's own confidence; schema-mapping gated per-group on `Math.max` of every proposal's confidence in the field-pair group, while its selection (`candidates[0]`) picked the FIRST proposal, not necessarily the max-confidence one — a real correctness gap: a low-confidence first proposal could ride a high-confidence sibling's number past the threshold (Producer Profile Slice 3, PR #105, documented and deferred this drift).
- **Rationale composition**: inquiry-mapping's rationale always appended the accepted proposal's own rationale text; schema-mapping's did not.
- **`reviewedAt` source**: inquiry-mapping stamped the accepted proposal's own `proposedAt`; schema-mapping stamped the batch-level `generatedAt`.

**Decision**: one `evaluateAutoAccept` function in `src/producer-profile.ts` (module-internal seam, not re-exported from `src/index.ts`) now owns all three mechanics for both profiles:

1. Gate on the accepted evidence's own confidence (never a group's), and never accept when a conflict is present.
2. Compose the rationale by citing that same confidence, appending the evidence's own rationale when present (decided with `!== undefined`, not truthiness, so an empty-string rationale is still appended).
3. Stamp `reviewedAt` from the evidence's own `proposedAt`, falling back to a caller-supplied `generatedAt`-style timestamp when a profile's evidence carries none of its own.

`applyAutoAcceptPolicy` (inquiry-mapping) and the inline auto-accept block inside `surveySchemaMapping` (schema-mapping) both delegate their policy decision to `evaluateAutoAccept`; each keeps its own distinct output record shape (`InquiryMapping` vs. inline `ReviewOutcome`) and public signature unchanged.

**Stays per-profile** (not drift, not unified): the `InquiryMapping` record vs. the inline `ReviewOutcome` record, their id templates, and schema-mapping's candidate-selection algorithm (`candidates[0]`, first-proposal-wins within a non-conflicting group) — this decision only unifies the auto-accept *policy* mechanics above, not selection or output record shape (different products, not drift).

Auto-accept still only ever yields `"assumed"` (never `"verified"`) with `withinComfortZone: true`; conflicting proposals are never auto-accepted (ADR 0003 §4 preserved).
