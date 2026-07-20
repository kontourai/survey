# Survey Documentation

Survey turns raw sources into Surface-ready trust evidence through a consistent
`source → extraction → candidate → review → claim` chain.

## I Want To...

| Goal | Where to go |
| --- | --- |
| Integrate Survey into my product | [consumer-integration-guide.md](consumer-integration-guide.md) |
| Upgrade an existing Survey integration | [upgrade-guide.md](upgrade-guide.md) |
| Understand every record shape in the chain | [record-contracts.md](record-contracts.md) |
| Import versioned extraction provenance for review | [extraction-envelope-import.md](extraction-envelope-import.md) |
| Model source-authoritative review decisions | [source-authority-review-pattern.md](source-authority-review-pattern.md) |
| Use adversarial review rounds and learning projections | [adversarial-and-learning.md](adversarial-and-learning.md) |
| Understand the review resource envelope (UI/adapter) | [review-resource-contract.md](review-resource-contract.md) |
| Try the browser-based review workbench demo | [review-workbench-prototype.md](review-workbench-prototype.md) |
| Drive review decisions from an MCP agent | [review-mcp.md](review-mcp.md) |
| Open the standalone browser review console | [review-console.md](review-console.md) |
| Cut a release | [RELEASING.md](RELEASING.md) |
| Review architecture decisions | [adr/](adr/) |

## All Pages

- [consumer-integration-guide.md](consumer-integration-guide.md) — end-to-end path for consumers integrating Survey output into Surface
- [upgrade-guide.md](upgrade-guide.md) — version-upgrade path, the adoption-scorecard pattern, and safely consuming `decisionEffects` values
- [record-contracts.md](record-contracts.md) — every record shape (source, extraction, candidate, review, claim) with schema and Surface projection rules
- [extraction-envelope-import.md](extraction-envelope-import.md) — structural portable-envelope import, durable provenance, and typed unresolved diagnostics
- [source-authority-review-pattern.md](source-authority-review-pattern.md) — producer pattern for source-context-backed candidate review and Surface evidence
- [adversarial-and-learning.md](adversarial-and-learning.md) — adversarial review rounds and learning projection mechanics
- [review-resource-contract.md](review-resource-contract.md) — producer-neutral review resource envelope for UI prototypes and adapter tests
- [review-workbench-prototype.md](review-workbench-prototype.md) — browser demo for inspecting a ReviewItem and generating a ReviewDecision payload
- [review-mcp.md](review-mcp.md) — MCP server for review-queue tools and interactive UI card
- [review-console.md](review-console.md) — standalone local review console (browser dashboard over the session file)
- [RELEASING.md](RELEASING.md) — release checklist and release-please workflow
- [adr/0001-reviewed-current-proposed-resolution.md](adr/0001-reviewed-current-proposed-resolution.md) — ADR: reviewed current/proposed resolution as a generic candidate-resolution pattern
- [adr/0003-inquiry-mapping-and-producer-proposals.md](adr/0003-inquiry-mapping-and-producer-proposals.md) — ADR: inquiry mapping and producer proposals (reconstructed)

## Assets

Static assets (diagrams, images) live in [`assets/`](assets/).
