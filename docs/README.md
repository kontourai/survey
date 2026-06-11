# Survey Documentation

Survey turns raw sources into Surface-ready trust evidence through a consistent
`source → extraction → candidate → review → claim` chain.

## I Want To...

| Goal | Where to go |
| --- | --- |
| Integrate Survey into my product | [consumer-integration-guide.md](consumer-integration-guide.md) |
| Understand every record shape in the chain | [record-contracts.md](record-contracts.md) |
| Model source-authoritative review decisions | [source-authority-review-pattern.md](source-authority-review-pattern.md) |
| Use adversarial review rounds and learning projections | [adversarial-and-learning.md](adversarial-and-learning.md) |
| Understand the review resource envelope (UI/adapter) | [review-resource-contract.md](review-resource-contract.md) |
| Try the browser-based review workbench demo | [review-workbench-prototype.md](review-workbench-prototype.md) |
| Drive review decisions from an MCP agent | [review-mcp.md](review-mcp.md) |
| Cut a release | [RELEASING.md](RELEASING.md) |
| Review architecture decisions | [adr/](adr/) |

## All Pages

- [consumer-integration-guide.md](consumer-integration-guide.md) — end-to-end path for consumers integrating Survey output into Surface
- [record-contracts.md](record-contracts.md) — every record shape (source, extraction, candidate, review, claim) with schema and Surface projection rules
- [source-authority-review-pattern.md](source-authority-review-pattern.md) — producer pattern for source-context-backed candidate review and Surface evidence
- [adversarial-and-learning.md](adversarial-and-learning.md) — adversarial review rounds and learning projection mechanics
- [review-resource-contract.md](review-resource-contract.md) — producer-neutral review resource envelope for UI prototypes and adapter tests
- [review-workbench-prototype.md](review-workbench-prototype.md) — browser demo for inspecting a ReviewItem and generating a ReviewDecision payload
- [review-mcp.md](review-mcp.md) — MCP server for review-queue tools and interactive UI card
- [RELEASING.md](RELEASING.md) — release checklist and release-please workflow
- [adr/0001-reviewed-current-proposed-resolution.md](adr/0001-reviewed-current-proposed-resolution.md) — ADR: reviewed current/proposed resolution as a generic candidate-resolution pattern

## Assets

Static assets (diagrams, images) live in [`assets/`](assets/).
