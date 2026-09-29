---
status: current
subject: Choosing One Value of a Conflict
decided: 2026-09-28
evidence:
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/304"
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/317"
  - kind: issue
    ref: "https://github.com/kontourai/surface/issues/195"
  - kind: doc
    ref: src/review-workbench/review-queue-session.ts
  - kind: doc
    ref: src/review-workbench/queue-binding.ts
---
# Choosing One Value of a Conflict

## Context

An envelope import groups the proposals for one claim into one `ReviewItem`
with one `proposed` candidate per distinct value. Two or more values make the
set a `conflict`. Every review decision named a candidate role, not a
candidate, so on a conflict no surface could pick one value: accept was
refused, and the reviewer could only reject every value or record
could-not-confirm. A reviewer who knew which value the source supports (the
amendment supersedes the schedule) had no way to record it, and the claim could
never become `verified`.

Two things had to stay true. A choice must never read as if there had been no
conflict: the record has to say which value was chosen and that the others
were seen and not chosen. And the rivals a reviewer is shown have to be the
rivals the import produced: the built-in reload paths trusted a stored queue
without checking it against its import, so a deleted excluded-rival entry
vanished silently (#317).

## Decision

**A new decision kind, `select-proposed`, chooses one proposed candidate by
id.** It is not `accept-proposed` with an id: `accept-proposed` keeps its
meaning (accept the one proposed value) and is still refused on a conflict, and
every record of a choice carries the kind that says a rival existed. Existing
kinds keep their meaning and stored sessions load unchanged.

- The chosen id rides beside the decision: `ReviewWorkbenchState.selectedCandidateId`
  and `ReviewQueueSessionState.selectedCandidateIdsByItemName` (both optional).
  In a session event the event's `candidateId` is the authority; replay
  restores the choice from it.
- `candidateForDecision(item, "select-proposed", id)` and
  `conflictSelectionIssue` accept only an id that names exactly one `proposed`
  candidate on an item holding at least two. An unknown id, a non-proposed
  candidate, a missing id, or an item with one proposed value is refused on
  every path: the builders throw, validated replay reports
  `invalid-conflict-selection`, and the MCP decide tool returns `isError`.
- The `ReviewDecision` records `candidateId` (chosen) and
  `unselectedCandidateIds` (the proposed values passed over). The recorded
  prompt lists every value and states the choice: "Selected decision: Use this
  value: 52000 (not chosen: 48000)."
- `buildCanonicalReviewedTrustInput` selects the chosen candidate, gives each
  value not chosen a `rejectionReason` naming the chosen candidate (so it also
  yields a `learning.rejected-candidate`), and writes `workbenchDecision:
  "select-proposed"` and the unselected ids on the review outcome. It refuses a
  result that accepts one value of a conflict as `accept-proposed`, or that
  does not record the values it passed over.
- `buildSurveyTrustBundle` lists every value in `metadata.survey.candidates`,
  with `selected: true` on the chosen one, on any claim whose candidate set has
  more than one `proposed` candidate.
- Every decision surface shows every value and which one was chosen: the
  workbench card (a "Use this value" control per value, then Chosen / Not
  chosen marks and a "Chose 1 of N values" chip), the MCP item text, data and
  card (`decision: "select"` with `candidateId`), and the recorded prompt.

**Excluded rivals are shown, never chosen.** A proposal excluded at import
(its excerpt is not at its cited span) is not a candidate. Letting a reviewer
choose a value whose citation failed would verify a value nothing in the
source was shown to support.

**Reload paths check the stored queue against its import.** The session file
used by the MCP server and the console gains an optional `extractionImport`
(the import record). `attestReviewQueueExtraction` returns `attested`,
`diverges`, `unverified`, or `not-extraction`. A queue that diverges from its
stored import is refused (MCP tools error, the console returns 409 on read and
422 on write, the workbench shows only the refusal, the server apply boundary
throws `UnattestedExtractionQueueError`). A queue whose items carry the
extraction binding but has no import stored is presented with an "Unverified
queue" notice on every surface and an `unverified-extraction-queue` apply
warning. The workbench mount and `<survey-review-workbench>` accept the import
as `extractionImport`; the element falls back to its single-import
`extractionInspector`.

## Surface

Surface's reviewed-extraction profile (`projectReviewedExtractionEvidence`)
accepts only a review item with exactly one candidate, so a conflict item,
chosen or not, cannot project through it. Survey does not reshape the item to
fit: the chosen value projects through `buildSurveyTrustBundle`, where it is
honest (`metadata.survey.candidates`, the review outcome's metadata).
Expressing "chosen over a rival" in the reviewed-extraction evidence needs
Surface to accept a multi-candidate item with a decision that names one
candidate and records the others (kontourai/surface#195 covers
multi-candidate items; its framing is the two-candidate transition shape).

## Consequences

- `ReviewWorkbenchDecision` gains a member. Code that switches exhaustively on
  it, or builds a `Record<ReviewWorkbenchDecision, …>`, must handle
  `select-proposed`.
- The detection of extraction items reads the binding the import writes. A
  writer who strips it from every item also strips every other extraction fact
  from the queue; the stored import is what makes a reload path able to check.
  Record integrity itself stays the caller's storage obligation, as before.
