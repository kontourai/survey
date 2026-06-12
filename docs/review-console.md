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
