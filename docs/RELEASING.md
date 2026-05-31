# Releasing Survey

This document is the operator checklist for cutting a release of `@kontourai/survey`.

## Preconditions

- `npm run verify` passes.
- `npm pack --dry-run` shows only intended package files.
- `@kontourai/surface` dependency points at a published compatible version.
- package metadata in `package.json` is correct.

## Release Flow

1. Update `package.json` version.
2. Merge the release commit to `main`.
3. Create and push a tag matching the package version, for example `v0.1.0`.
4. Let `.github/workflows/publish-npm.yml` publish the package.
5. Confirm the published tarball contents and README rendering on npm.

## Trusted Publishing

The repo publishes through npm trusted publishing via GitHub Actions OIDC.
Configure npmjs.com to trust:

- organization or user: `kontourai`
- repository: `survey`
- workflow filename: `publish-npm.yml`
- allowed action: `npm publish`
