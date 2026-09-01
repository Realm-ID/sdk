# Changelog — `@realm-id/web-bff-realmid` (BFF transport adapter)

All notable changes to the BFF transport adapter. Published to npm from
`.github/workflows/publish-npm.yml`; the monorepo-level `../../../CHANGELOG.md`
records cross-cutting items affecting every SDK at once.

> **This file starts at `0.3.6` (created 2026-08-24).** The package had shipped
> with no changelog of any kind — not a gap in this file, the absence of the
> file. Unusually for the web packages, four of its releases DO have written
> entries, but they live in the monorepo `../../../CHANGELOG.md` under
> `## web-bff-realmid/v0.3.3`–`v0.3.6`; they are left there rather than copied
> here, because two copies of one changelog is the mechanism that lost
> `web-admin` `0.8.13`–`0.8.17`. Everything else is in
> `git log -- web/packages/bff-realmid`.
>
> A release can no longer skip this file: `scripts/changelog-hygiene.sh npm`
> refuses to publish a version with no `## <version>` heading below.

## 0.5.0 — the BFF adapter carries the credential grant (ADR-103/104) (2026-09-01)

- Maps `credential_methods` off the discovery response into
  `ProvidersResponse.credentialMethods`, and **only when the server sent it**.
  Mapping absence to `[]` would tell a login page "credential login is off" when
  the truth is "the server did not say".
- Sends `identifier` and `presented` on the login request, verbatim — see
  `LoginRequest.identifier` in `@realm-id/web` 0.6.0 for why no layer here may
  reshape the handle.

## 0.4.0 — discovery maps `tenant_id` and `nickname` (2026-08-30)

Additive. The reference BFF's `GET /identity-providers` was already returning
both and the adapter was dropping them, so every console re-fetched the same
anonymous route by hand just to read `tenant_id` — the login page needs it to
carry the tenant into the subsequent `login`, and a realm-root origin
legitimately has none (absent means "the server did not say", never "no
tenant"). Now surfaced as `ProvidersResponse.tenantId` and
`IdentityProvider.nickname` (`@realm-id/web` `0.5.0`).

## 0.3.6 — revert: login sends `method` again (2026-07-05)

`0.3.5` migrated this package's `/login` body from `method` to `grant_type` and
broke login outright with `method and token are required`. **It targeted the
wrong hop:** this SDK talks to the **BFF**, whose `/login` contract is
`{method, token}` — the ADR-051-deprecated `method` field is on the
BFF → issuer hop (Go SDK `auth.go`), which is where that migration belongs. The
Microsoft bug `0.3.5` was chasing had already been fixed by issuer `v0.27.1`.

Full text for `0.3.4`–`0.3.6` is in the monorepo `../../../CHANGELOG.md`.
