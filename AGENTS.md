# Survey Agent Guidance

Survey is the producer-side contract: source → extraction → candidate → review → claim, projected into Surface TrustInput. Survey never decides truth, crawls, ranks, or owns review policy — producers do.

## Source Of Truth

- Vocabulary: `CONTEXT.md`; deep record reference: [docs/record-contracts.md](docs/record-contracts.md).
- Library source in `src/` (CJS-style TS); the Anthropic adapter stays behind the `/anthropic` subpath and is never re-exported from the index (core must keep zero AI deps).
- `dist/` and `site/` are generated; the review-workbench demo assets sync via `npm run check:review-workbench-assets`.

## Pull More Context When Needed

- Consumer path, workbench, server apply boundary: [docs/consumer-integration-guide.md](docs/consumer-integration-guide.md).
- Adversarial passes, learning, the Flow bridge adapter: [docs/adversarial-and-learning.md](docs/adversarial-and-learning.md).
- Review resources and session events: [docs/review-resource-contract.md](docs/review-resource-contract.md).
- Releases (automated + manual fallback): [docs/RELEASING.md](docs/RELEASING.md).

## Match Checks To Change Type

- Library/types changes: `npm test` (build + Node tests against dist).
- Workbench UI/embed changes: `npm run check:review-workbench` and `npm run test:browser`.
- Docs or docs-site changes: `npm run docs:check`.
- Anything before push: `npm run verify` (the pre-push hook runs repo-hook validation + verify; never bypass hooks).
- Releases use release-please with conventional commits; bump `.release-please-manifest.json` in any manual release PR.

## Useful Commands

- `npm run verify` · `npm test` · `npm run docs:check` · `npm run check:review-workbench` · `npm run validate:repo-hooks`

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
