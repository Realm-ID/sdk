# Changelog — `@realm-id/web` (browser core)

All notable changes to the browser core SDK. Published to npm from
`.github/workflows/publish-npm.yml`; the monorepo-level `../../../CHANGELOG.md`
records cross-cutting items affecting every SDK at once.

> **This file starts at `0.4.5` (created 2026-08-24).** The package had shipped
> nine versions with no changelog of any kind — not a gap in this file, the
> absence of the file — so its history lives only in
> `git log -- web/packages/core`. Nothing is backfilled here rather than
> reconstructed from commit subjects and presented as a record; the versions
> before `0.4.5` are read from git.
>
> A release can no longer skip this file: `scripts/changelog-hygiene.sh npm`
> refuses to publish a version with no `## <version>` heading below.

## 0.4.5 — `resolveTenant()` completes a tenant-picker gate without a second provider redirect (2026-07-05)

Provider-driven logins (`signIn` / `completeSignIn`) retain the exchanged
provider token across a `tenants_required` gate and expose
`realm.resolveTenant(tenantId)`, which re-submits the SAME token with the chosen
tenant instead of re-running the OIDC redirect. Fixes the Microsoft double
round-trip (IdP → picker → IdP → dashboard) on realm-root origins.

The retained token is single-use — cleared on session-issue and on
anon/logout. Additive and backward-compatible (peers pin `^0.4.0`). New error
code `no_pending_login`.
