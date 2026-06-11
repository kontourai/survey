# Releasing Survey

Releases are automated with release-please: merges to main accumulate into a release PR, and merging it tags the version and dispatches the npm publish workflow. Use conventional commit prefixes (feat:, fix:, docs:, chore:) so version inference works. The manual flow below remains valid for exceptional releases.

This document is the operator checklist for cutting a release of `@kontourai/survey`.

## Preconditions

- `npm run verify` passes.
- `npm pack --dry-run` shows only intended package files.
- `@kontourai/surface` dependency points at a published compatible version.
- package metadata in `package.json` is correct.
- `@kontourai/survey/review-workbench` resolves from `dist/src/review-workbench`
  and not from `dist/examples`.
- `npm pack --dry-run` includes the scoped
  `dist/src/review-workbench/review-workbench.css` asset.

## Release Flow

1. Update `package.json` version.
2. Merge the release commit to `main`.
3. Create and push a tag matching the package version, for example `v0.1.0`.
4. Let `.github/workflows/publish-npm.yml` publish the package.
5. Confirm the published tarball contents and README rendering on npm.

Local `npm pack` readiness does not authorize publication by itself. A human
with npm/GitHub release authority must approve the version bump, release commit,
tag, and trusted-publishing run before downstream products switch from local
proof dependencies to the published semver range.

## Trusted Publishing

The repo publishes through npm trusted publishing via GitHub Actions OIDC.
Configure npmjs.com to trust:

- organization or user: `kontourai`
- repository: `survey`
- workflow filename: `publish-npm.yml`
- allowed action: `npm publish`
