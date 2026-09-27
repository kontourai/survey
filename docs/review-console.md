# Survey Review Console

`survey-review-console` is a standalone local dashboard for reviewing a session file in your browser. It is the survey equivalent of `surface console` and `flow console`.

## Start the console

```sh
npx survey-review-console --session path/to/session.json
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

The MCP server (`survey-review-mcp`) and the console share the same session file. You can run both simultaneously: the MCP agent records decisions, the console reflects them live in the browser. Both apply the same `deriveServerReviewSessionApplyResult` validation, so the event log is always consistent.

### Concurrent writers

Every write to the session file, from the console or the MCP server, takes one shared exclusive lock file next to the session (`<session>.lock`), re-reads the session inside the lock, and replaces the file through a uniquely named temp file. A lock left behind by a process that has exited (or one older than 30 seconds) is broken automatically.

`POST /api/events` replaces the whole event log, so it is a compare-and-swap: the body carries `baseRevision`, the `revision` returned by the `GET /api/session` it was built from (and by each successful save). If the stored log has changed since, the server answers `409` with the current `revision` and writes nothing; the browser then reloads the stored session and tells the reviewer that their last change was not saved. A body without `baseRevision` gets `428`, and an empty `events` array never replaces a non-empty log (`422`).

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
