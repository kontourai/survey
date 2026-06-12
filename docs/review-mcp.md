# Survey Review MCP

`survey-review-mcp` is a minimal [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes a review-queue session for inspection and decision-making through an MCP client (Claude Desktop, Cursor, or any MCP-aware host).

The server is dependency-free — hand-rolled JSON-RPC 2.0 over stdio, no MCP SDK. It does not make any network requests. All state lives in a single session JSON file.

## Start the server

```sh
npx survey-review-mcp --session path/to/session.json
```

Options:

| Flag | Description |
| --- | --- |
| `--session <path>` | Path to the session JSON file (read and updated in-place). Defaults to the bundled `example-data/mcp-review-session.json` fixture. |
| `--no-ui` | Suppress the embedded UI resource from `survey_review_queue` and `survey_review_item` results. Text content is always returned. |

## Tool table

| Tool | Args | Returns |
| --- | --- | --- |
| `survey_review_queue` | _(none)_ | Text summary + JSON of all items with status, active item, queue progress, and session totals |
| `survey_review_item` | `itemName: string` | Full item detail: current vs proposed values, confidence, source refs, excerpts, and current decision |
| `survey_review_decide` | `itemName: string`, `decision: "accept" \| "hold" \| "reject"`, `note?: string` | Applies the decision through the real session APIs, persists atomically, returns updated item detail + remaining queue summary |

Decision mapping:

| MCP value | ReviewWorkbenchDecision | Effect |
| --- | --- | --- |
| `accept` | `accept-proposed` | Proposed value becomes the verified outcome |
| `hold` | `keep-current` | Current value remains the verified outcome |
| `reject` | `reject-proposed` | Proposed value is rejected; current value is unmodified |

### Domain failures

Domain errors (unknown item name, item already decided, invalid decision value) are returned as `{ isError: true, content: [{ type: "text", text: "..." }] }` — not as JSON-RPC protocol errors. The client can inspect `result.isError` and the error message in `result.content[0].text`.

## UI card behavior

`survey_review_queue` and `survey_review_item` include an embedded UI resource:

```json
{
  "type": "resource",
  "resource": {
    "uri": "ui://survey/review-card/<instance>",
    "mimeType": "text/html;profile=mcp-app",
    "text": "<!doctype html>...",
    "_meta": { "mcpui.dev/ui-preferred-frame-size": ["420px", "560px"] }
  }
}
```

The HTML card is compact and fully self-contained (no external network requests). It shows:

- Current vs proposed values side by side
- Confidence percentage and source reference for each candidate
- Excerpt from the source locator
- Queue progress (resolved / total)
- Current decision badge (if any)
- A reviewer note textarea
- Accept / Hold / Reject buttons

Buttons post back to the host using the MCP guest-to-host postMessage protocol:

```js
window.parent.postMessage({
  jsonrpc: "2.0",
  id: <n>,
  method: "tools/call",
  params: { name: "survey_review_decide", arguments: { itemName, decision, note } }
}, "*");
```

The card uses `--k-*` design tokens matching the Console Kit dark theme by default, with `prefers-color-scheme: light` support. No fonts or assets are fetched from the network.

Pass `--no-ui` to suppress the UI resource; the text content items are always returned.

## Session file contract

The session file is a JSON object with three keys:

```json
{
  "session": { ... },    // ReviewSession resource (metadata only)
  "snapshot": { ... },  // ReviewQueueSessionState at session creation
  "events": [ ... ]     // ReviewSessionEvent array (appended by decide)
}
```

The `snapshot` field is the baseline state. All decisions are recorded as append-only `ReviewSessionEvent` records in `events`. When a tool reads state it replays the events over the snapshot using `replayReviewSessionEvents`. When `survey_review_decide` applies a new decision it:

1. Replays events to derive the current live state.
2. Builds the updated session with the new decision.
3. Generates a fresh full event stream via `buildReviewSessionEvents`.
4. Validates the new events using `deriveServerReviewSessionApplyResult` (freshness + replay checks).
5. Writes the updated file atomically (temp file + rename).

The file is written atomically so a failed write leaves the previous state intact.

## No-network statement

The MCP server makes no outbound network requests. It reads and writes one local file. The embedded HTML card contains no external `<script>`, `<link>`, `<img>`, or `@import` references.
