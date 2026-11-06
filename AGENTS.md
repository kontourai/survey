# Survey Agent Guidance

Survey is the producer-side contract: source → extraction → candidate → review → claim, projected into Surface TrustInput. Survey never decides truth, crawls, ranks, or owns review policy — producers do.

## Source Of Truth

- Vocabulary: `CONTEXT.md`; deep record reference: [docs/record-contracts.md](docs/record-contracts.md).
- Library source in `src/` (CJS-style TS); Survey keeps zero AI runtime dependencies. Model-backed producers live in their owning product and inject normalized results through Survey's framework-neutral interfaces.
- `dist/` and `dist-pages/` are generated; the review-workbench demo assets sync via `npm run check:review-workbench-assets`.

## Pull More Context When Needed

- Consumer path, workbench, server apply boundary: [docs/consumer-integration-guide.md](docs/consumer-integration-guide.md).
- Adversarial passes, learning, the Flow bridge adapter: [docs/adversarial-and-learning.md](docs/adversarial-and-learning.md).
- Review resources and session events: [docs/review-resource-contract.md](docs/review-resource-contract.md).
- Releases (automated + manual fallback): [docs/RELEASING.md](docs/RELEASING.md).
- UI, brand, and product-copy rules: `DESIGN.md` in `@kontourai/ui` (https://github.com/kontourai/ui/blob/main/DESIGN.md; also shipped at `node_modules/@kontourai/ui/DESIGN.md` from 1.13.0). Style with the `--k-*` tokens instead of hard-coded colors, spacing, radii or font sizes, and don't resolve anything the doc marks OPEN.

## Match Checks To Change Type

- Library/types changes: `npm test` (build + Node tests against dist).
- Workbench UI/embed changes: `npm run check:review-workbench` and `npm run test:browser`.
- Docs changes: `npm run docs:check`. Docs are published with docs-kit: `corpus.json` lists the published docs and MCP topics, and `npm run docs:check` is the gate. When you change code a document `covers`, update that document.
- Decisions: one living record per subject in `docs/decisions/<slug>.md`, in the [Corpus decision-record format](https://github.com/kontourai/corpus/blob/main/docs/decisions.md). Numbered ADRs in `docs/adr/` are frozen history; never add one. After editing a record, run `npm run gen:decisions-index`. `npm run check:decisions` validates the records and the index, and refuses ADR files added since `$DECISIONS_BASE` (default `origin/main`; CI sets it to the pull request base).
- Anything before push: `npm run verify` (the pre-push hook runs repo-hook validation + verify; never bypass hooks).
- Releases use release-please with conventional commits; bump `.release-please-manifest.json` in any manual release PR.

## Useful Commands

- `npm run verify` · `npm test` · `npm run docs:check` · `npm run check:review-workbench` · `npm run validate:repo-hooks`

## Documentation freshness

The Corpus gate is strict for the source paths declared in `corpus.json`.
Review the selected canonical guides when those files change. Update inaccurate
claims in the same PR. When the prose remains accurate, record a new local
input/output byte review with a concrete explanation and limits in
`corpus-content.json`; do not add filler text or refresh hashes without review.
The shared [Corpus review contract](https://github.com/kontourai/corpus/blob/b127e35a818b532369843731b3c64792baade83e/docs/related-content.md#review-an-unchanged-covering-document)
owns that format. CI uses the reviewed shared pin; for local review checks use
that same Corpus revision with `check --base origin/main`.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `npx --no @kontourai/veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
