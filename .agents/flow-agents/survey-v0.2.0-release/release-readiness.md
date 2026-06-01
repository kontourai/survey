# Survey v0.2.0 Release Readiness

release_scope: Version bump for `@kontourai/survey` from `0.1.5` to `0.2.0` after PR #5 merged the public API alignment with Surface Claim Dependency semantics.

evidence_reference: `npm run verify` passed on the release branch with typecheck, build, and 21 tests. `npm_config_cache=/private/tmp/kontour-survey-npm-cache npm pack --dry-run` passed and showed the expected package contents for `@kontourai/survey@0.2.0`.

risk_review: This release contains a public API removal from the merged implementation (`DerivedClaimTarget`, `derivedClaims`, and `addDerivedClaim`), so the version is bumped to `0.2.0` instead of a patch release. No dependency changes, migrations, runtime services, or security-sensitive behavior changes are included in this release bump.

operational_plan: Merge the version bump PR to `main`, then create and push tag `v0.2.0` from the merged `main` commit to trigger npm trusted publishing through `.github/workflows/publish-npm.yml`.

rollback_plan: If publishing fails before npm publication, delete or move the tag and fix the release branch. If `0.2.0` is published with bad contents, publish a corrective `0.2.1`; npm package unpublish should not be the normal rollback path.

observability_plan: Confirm the GitHub publish workflow succeeds, then inspect the npm package page and tarball contents for `@kontourai/survey@0.2.0`.

post_deploy_checks: After tag push, check GitHub Actions for `publish-npm.yml`, then verify `npm view @kontourai/survey@0.2.0 version` and package README rendering.

final_acceptance_docs: `docs/RELEASING.md` already documents the release flow. This artifact records release-specific evidence and next steps.

decision: RELEASE after the version bump PR is merged.
