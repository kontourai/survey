---
status: current
subject: Review Workbench
decided: 2026-07-17
evidence:
  - kind: pr
    ref: "https://github.com/kontourai/survey/pull/151"
  - kind: doc
    ref: docs/review-resource-contract.md
---
# Review Workbench

The framework-neutral embeddable review UI and its host-integration contract.
Subjects specific to inline editing live in
[proposed-value-edit](./proposed-value-edit.md); this record carries the embed's
theming contract.

## The embed is themed entirely by the host's --k-* tokens (2026-07-17)

The embed CSS build carried a `makeTokensInheritable` step — which rewrites a
`--k-x: <value>` token default to `--k-x: var(--k-x, <value>)` so a host's
ancestor or inline custom property propagates in — but it was never called.
Tokens shipped as bare values, so the intended host-override path was dormant:
a host re-branding the workbench had to out-specificity the embed's own token
selectors, a specificity war (and the built-in `theme-survey`/`theme-console`/…
presets are Kontour-branded, not a "bring your own brand" story).

**Decision**: the `--k-*` token **defaults** ship in overridable
`var(--k-*, <default>)` form. A host sets any `--k-*` token on an ancestor of
the embed (or inline, or the web-component host) and it wins without fighting
selector specificity; unset tokens keep their default, so a host declares only
what it re-brands. Values that already reference `var()` (the `*-soft`
`color-mix` tokens) are left alone to avoid self-referential cycles. Backward
compatible: a consumer that does not theme sees identical resolved output; one
that overrides via higher specificity still wins. The shadow-DOM
theme-piercing behavior is unchanged (covered by an existing browser test); the
new value is that the light-DOM embed is now equally host-overridable.

**Scope**: this is the token-default *packaging* contract, not a per-brand
preset. Survey ships no host-brand theme of its own — the host owns its palette
and type; Survey owns only that its token defaults are overridable. The
"Theme it as your own brand" recipe is in the [README](../../README.md).
