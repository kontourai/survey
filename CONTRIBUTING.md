# Contributing

This file is intentionally short.

The main docs in this repo are written for people installing and using Survey.
This file is the footnote for people developing the product itself.

## Development Rules

- Survey is the producer-side contract: source → extraction → candidate → review → claim, projected into Surface TrustInput — it never decides whether a real-world value is true
- keep Survey free of AI runtime and provider dependencies; model-backed producers belong to their owning product and inject normalized results through Survey's framework-neutral interfaces
- keep the tracked `.veritas/`-style dogfooding config current (when present), but do not commit generated artifacts
- never bypass pre-push hooks — use a clean worktree when local `node_modules` do not match a branch
- keep `CONTEXT.md` current with the domain vocabulary when the producer-side contract changes

## Setup

```bash
npm install
```

Node >= 20 is required.

## Verification

Before opening a PR:

```bash
npm run verify
```

This runs the content-boundary check, typecheck, Node tests, review-workbench asset check, review-workbench static check, and browser tests.

Individual checks by change type:

- library/types changes: `npm test`
- workbench UI or embed changes: `npm run check:review-workbench` and `npm run test:browser`
- browser-harness changes: `npm run test:browser:concurrent` (runs two isolated Playwright servers in parallel)
- docs or docs-site changes: `npm run docs:check`

Local browser runs derive a process-specific port and never reuse an existing
server. CI stays on deterministic port `4180`. Set `SURVEY_PLAYWRIGHT_PORT` to
an available port when a harness or debugging session needs an explicit value.

## PR Expectations

- one concern per PR; keep diffs reviewable
- update `docs/` when the public contract or workbench API changes
- use conventional commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`) — releases are automated with release-please; bump `.release-please-manifest.json` in any manual release PR
- see `docs/RELEASING.md` for release guidance

## Releases

Releases are automated with release-please: merges to main accumulate into a release PR, and merging it tags the version and dispatches the npm publish workflow.

## Repository

https://github.com/kontourai/survey

All projects are Apache-2.0.

## Integration tests

Every embeddable artifact (web component, MCP UI resource) must have:

(a) **Protocol/contract tests** that spawn the real process or build the real artifact
    and exercise the full protocol — e.g. `tests/review-mcp.test.ts` for the stdio MCP server.

(b) **A browser spec** in `tests/browser/` that renders the artifact in a real browser
    (Playwright) and exercises at least one real interaction. Required cases:
    - loads and renders with its own embedded styles (proves single-import contract)
    - data-driven attribute or property path (e.g. `src=` or `.session=`)
    - graceful error state on bad input (e.g. 404 `src=`)
    - empty/no-data state
    - **hostile input**: any artifact that interpolates data into HTML must include a test
      with `</script><script>` and `<img onerror=>` payloads in every interpolated field,
      asserting `window.__pwned` is undefined and no unexpected DOM elements appear.

`tests/browser/` runs in CI as part of `npm run verify` via `npm run test:browser`.
