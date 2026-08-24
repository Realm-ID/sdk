# Changelog — `@realm-id/web-react` (React bindings)

All notable changes to the React bindings. Published to npm from
`.github/workflows/publish-npm.yml`; the monorepo-level `../../../CHANGELOG.md`
records cross-cutting items affecting every SDK at once.

> **This file starts at `0.4.0` (created 2026-08-24).** The package had shipped
> four versions with no changelog of any kind — not a gap in this file, the
> absence of the file — so its history lives only in
> `git log -- web/packages/react`. Nothing before `0.4.0` is backfilled here
> rather than reconstructed from commit subjects and presented as a record.
>
> A release can no longer skip this file: `scripts/changelog-hygiene.sh npm`
> refuses to publish a version with no `## <version>` heading below.

## 0.4.0 — peer-dep bump to `@realm-id/web@^0.4.0` (2026-05-15)

Released as part of the `web-v0.4.0` roll (pluggable storage adapters +
synchronous `autoRestore` in the core package). The React bindings themselves
carry no behaviour change in this version — the major-line bump exists so the
peer range tracks the core it binds to, alongside `web-bff-realmid@0.3.0`.
