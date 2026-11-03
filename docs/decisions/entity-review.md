---
status: current
subject: Reviewed Entity Relationships
decided: 2026-11-02
evidence:
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/243"
  - kind: issue
    ref: "https://github.com/kontourai/surface/issues/204"
  - kind: issue
    ref: "https://github.com/kontourai/surface/issues/353"
  - kind: doc
    ref: docs/record-contracts.md
  - kind: doc
    ref: src/entity-review.ts
---
# Reviewed Entity Relationships

Survey binds producer-provided alternatives and source evidence to existing
review items, decisions and replayable events. It stores immutable, content
addressed outcomes and explicit supersession ancestry. A split is a reviewed
replacement of a prior mapping; abstention changes no earlier outcome. Bulk
planning is bounded and pure; transactional persistence and authorization stay
with the host. Confidence is descriptive and never an acceptance rule.

Surface owns identity admission and accumulation over time. Equivalent links
are emitted only as review-backed candidate mappings with claims, evidence and
review events, not as a declaration that a link is admitted at a knowledge cut.
Domain relations and splits do not become equivalent links. Survey preserves
conflicts and cannot infer missing authority or completeness from a supplied
history. Existing Surface admission gaps are tracked in surface#353 and #357.
