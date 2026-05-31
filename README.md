# Kontour Survey

Survey is the producer-side contract for turning raw observations into
Surface-ready trust records.

This repo is intentionally small right now. It is a proof package, not an
ingestion platform:

- producers own acquisition, parsing, ranking, review UX, and vertical policy;
- Survey owns source, extraction, candidate, and review record shapes;
- `buildSurveyTrustInput` projects those records into `@kontourai/surface`
  `TrustInput`;
- Surface owns trust reporting, derivation, console projections, and downstream
  transparency.

The first success criterion is that tax and public-directory fixtures can pass
through Survey and produce valid Surface reports without Survey absorbing
vertical policy.

## Commands

```sh
npm install
npm run verify
```
