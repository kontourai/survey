# Survey Review Console

`survey-review-console` is a standalone local dashboard for reviewing a session file in your browser. It is the survey equivalent of `surface console` and `flow console`.

## Start the console

```sh
npx --yes --package=@kontourai/survey@8.0.0 survey-review-console --session path/to/session.json
```

Options:

| Flag | Description |
| --- | --- |
| `--session <path>` | Path to the session JSON file (read and updated in-place). Required. |
| `--port <number>` | TCP port to listen on. Defaults to 4243. |

The server binds to `127.0.0.1` (loopback only). Open the printed URL in your browser.

## What it does

The console serves the full Survey Review Workbench UI wired to your session file. Every decision you make in the browser is persisted back to the session file atomically via `POST /api/events`, using the same validation contract the MCP server applies.

An SSE stream (`GET /api/stream`) watches the session file for changes. When the file is updated by any writer — the browser, an MCP agent, or an external process — all open console sessions receive a live reload so they stay in sync.

## MCP agent + console convergence

When the session file carries the extraction import record its items came
from (`extractionImport`, see [review-mcp.md](review-mcp.md#session-file-contract)),
the console checks the queue against it: a queue that does not match is not
served (`GET /api/session` returns 409 and the page shows why) and no events are
appended to it (422). Without a stored import, a queue whose items came from an
extraction import is shown with an "Unverified queue" notice.

The MCP server (`survey-review-mcp`) and the console share the same session file. You can run both simultaneously: the MCP agent records decisions, the console reflects them live in the browser. Both apply the same `deriveServerReviewSessionApplyResult` validation, so the event log is always consistent.

### Concurrent writers

Every write to the session file, from the console or the MCP server, takes one shared exclusive lock file next to the session (`<session>.lock`), re-reads the session inside the lock, and replaces the file through a uniquely named, fsynced temp file. Temp files a crashed writer left behind are removed on the next write. A lock is broken when its holder process has exited, when it is still empty a second after creation (the acquirer died before writing it), or when it is older than 30 seconds; breakers serialize on a second `<session>.lock.break` file so a live holder's lock is never removed. Holder liveness is checked by pid, which only means something on one host: when several hosts or containers share the session volume, only the 30-second age rule applies.

**The event log is append-only.** Neither writer rewrites stored events. `POST /api/events` appends the reviewer's new events (for example an accept, an undo and a keep-current on the same item) to the stored log. The MCP `survey_review_decide` tool appends the note and decision events for its item. Appended events are renumbered after the stored ones and renamed into the stored session, so the log stays one replayable session and a complete record of reviewer intent, reversals included.

Appending is a compare-and-swap. The body carries `events` (the events to append) and `baseRevision`, the `revision` returned by the `GET /api/session` the reviewer's view was built from (and by each successful save). If the stored log has changed since, the server answers `409` with the current `revision` and writes nothing. The browser then reloads the stored session, tells the reviewer once that their last change was not saved, and drops saves still queued from the refused view. A body without `baseRevision` gets `428`, and an empty `events` array gets `422`.

`POST /api/events` also refuses requests that a web page on another site could send through the browser: a `Content-Type` other than `application/json` (`415`), an `Origin` other than the console's own loopback origin (`403`), and, on every route, a `Host` that is not a loopback name (`403`, DNS rebinding).

```
┌───────────────┐                    ┌─────────────────┐
│  Browser UI   │ ──POST /api/events─▶│  session.json   │
└───────────────┘                    └────────┬────────┘
                                              │ fs.watch
┌───────────────┐                    ┌────────▼────────┐
│  MCP agent    │ ─────JSON-RPC──────▶  review-mcp.ts  │
└───────────────┘   (stdio)           └─────────────────┘
```

## Cross-reference

- [review-mcp.md](review-mcp.md) — MCP server for agent-driven review
- [review-workbench-prototype.md](review-workbench-prototype.md) — standalone browser demo (no server)

## Send a saved review to a workflow

The optional programmatic `@kontourai/survey/review-console` entrypoint accepts a
producer-owned application callback. It adds a **Send review to workflow**
control to the existing console. This is its sole submission action; the local
workbench Apply/export control is hidden when a producer owns application.
Submission stays disabled until every item has an explicit persisted decision
and no event save is pending or failed. A failed save reloads stored state, keeps
the error visible and requires reloading or successfully retrying the change.
The producer receipt summary remains visible as a success status after reload;
consumed sessions cannot be edited or submitted again. The standalone CLI continues to save review
records without applying domain decisions.

```ts
import { startReviewConsoleServer } from '@kontourai/survey/review-console';
import { bindReviewQueue } from '@kontourai/survey/review-workbench';

// Construct once from the actual producer queue, before review starts.
const binding = bindReviewQueue(snapshot, { sessionName });
await startReviewConsoleServer({
  sessionPath,
  producerApply: {
    binding,
    async apply({ record, events, results, revision }) {
      // Authenticate the operator and check current workflow state under
      // the owning producer's lock. Never trust browser-supplied identity.
      return applyCurrentWorkflowReview({ record, events, results, revision });
    },
  },
});
```

Survey checks the persisted event revision, resolves every queued item and
validates the queue against the producer's original binding. The browser sends
only its saved-event revision; it cannot supply replacement results or a queue
binding. A successful callback returns `{reference, summary}`. Survey retains
that reference and refuses repeated application or further event appends to the
consumed session. Opening a new review requires a producer-created session.

The producer must recheck its current signed request, workflow visit, source
and artifact bytes, deadlines, revision budgets and unconsumed decision identity
before domain effects. It must distinguish approval, decline, could-not-confirm
and requests for changes, rather than mapping every resolved item to approval.
Questionnaire confirmation is distinct from approval of produced artifacts.
Display only public rationale and actual evidence appropriate to that review.

The callback must apply idempotently using its own durable decision identity.
Survey's file lock serializes console submissions, but cannot transactionally
commit another product's store. If domain application succeeds and Survey's
receipt write subsequently fails, retry must return the existing producer
receipt without repeating effects. Survey's saved receipt is a presentation
record, not the producer's workflow authority.

Loopback access and a session actor string do not authenticate a human. Local
console interactions retain the producer's host-observed operator classification.
Human-authenticated review requires the consuming host's authentication and
policy. Survey does not turn a browser reference or simulated UI interaction
into a human approval claim.

## Server shutdown

The public `startReviewConsoleServer` handle's `close()` stops its file watcher,
ends its own active event-stream responses, and waits for its HTTP server to
close. A browser may remain open; the caller does not need to close the page or
abort its event stream first. Repeated calls share the same shutdown promise.
Other console instances remain available. Ordinary in-flight requests finish
through the HTTP server's existing close behavior; shutdown does not cancel a
producer's canonical application mid-write.

## Producer-owned review presentation

Pass optional `presentation: ReviewQueuePresentation` to
`startReviewConsoleServer` for a titled review with prominent multiline context
(for example, the reason for waiting and observed findings). The context and
labels render as escaped text, not HTML. `items` is keyed by canonical item name;
`candidateLabels` is keyed by canonical candidate ID.

```ts
const presentation = {
  title: 'Proposal review',
  context: 'Open finding: a required entity is missing.\nReview the proposal before continuing.',
  items: {
    document: { title: 'Proposal document', kind: 'acknowledgment' },
    decision: {
      title: 'Decision', kind: 'choice',
      candidateLabels: { approve: 'Approve', correct: 'Request changes', decline: 'Decline' },
    },
  },
};
```

An acknowledgment with a sole proposed candidate uses **Mark reviewed** and
hides Keep/Flag controls. A choice uses named candidate actions, **Choose an
action** copy and a visible reviewer note. **Could not confirm** remains
available and still requires a reason. Ordinary field-review presentation is
unchanged when hints are absent.

These hints are display-only. They do not change canonical items, stored source
bytes, decision events, candidate IDs, queue bindings or producer admission. An
acknowledgment records the same candidate acceptance event; selecting a named
action records the same `select-proposed` event for that candidate. The producer
still decides whether a recorded action can advance its workflow and provides
the completion summary and next step.
